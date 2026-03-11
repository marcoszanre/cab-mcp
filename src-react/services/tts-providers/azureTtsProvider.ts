// Azure Speech SDK TTS Provider
// Wraps Azure Cognitive Services Speech SDK for text-to-speech synthesis

import type { ITtsProvider, TtsSynthesisOptions, TtsSynthesisResult, TtsSynthesisStreamResult } from '@/types/tts-provider'
import { voiceSupportsStyles, isHDVoice } from '@/lib/languageVoiceMap'

type SpeechSdkModule = typeof import('microsoft-cognitiveservices-speech-sdk')
type SpeechSynthesizer = import('microsoft-cognitiveservices-speech-sdk').SpeechSynthesizer
type SpeechSynthesisResult = import('microsoft-cognitiveservices-speech-sdk').SpeechSynthesisResult

interface AzureProviderConfig {
  speechKey: string
  speechRegion: string
}

/**
 * Azure Speech SDK TTS provider.
 * Supports standard Neural voices and Dragon HD voices with full SSML control.
 */
export class AzureTtsProvider implements ITtsProvider {
  readonly name = 'Azure Speech'

  private _speechKey = ''
  private _speechRegion = ''
  private _isInitialized = false
  private _speechSdkPromise: Promise<SpeechSdkModule> | null = null
  private _persistentSynthesizer: SpeechSynthesizer | null = null
  private _synthesizerConfigHash = ''

  get isInitialized(): boolean {
    return this._isInitialized
  }

  async initialize(config: Record<string, unknown>): Promise<boolean> {
    const typedConfig = config as unknown as AzureProviderConfig
    if (!typedConfig.speechKey || !typedConfig.speechRegion) {
      console.warn('[AzureTTS] Missing speechKey or speechRegion')
      return false
    }
    this._speechKey = typedConfig.speechKey
    this._speechRegion = typedConfig.speechRegion
    this._isInitialized = true
    console.log('[AzureTTS] Provider initialized')
    return true
  }

  async synthesize(options: TtsSynthesisOptions): Promise<TtsSynthesisResult> {
    if (!this._isInitialized) {
      throw new Error('Azure TTS provider not initialized')
    }

    const voiceName = options.voiceName || 'en-US-JennyNeural'
    const ssml = this.buildSSML(options.text, {
      voiceName,
      language: options.language || 'en-US',
      speechRate: options.speechRate ?? 1.0,
      ttsStyle: options.ttsStyle,
      styleDegree: options.styleDegree,
    })

    const speechSdk = await this._getSpeechSdk()
    const synthesizer = await this._getOrCreateSynthesizer(voiceName)

    const result = await new Promise<SpeechSynthesisResult>((resolve, reject) => {
      synthesizer.speakSsmlAsync(
        ssml,
        (result) => {
          if (result.reason === speechSdk.ResultReason.SynthesizingAudioCompleted) {
            resolve(result)
          } else {
            this._closeSynthesizer()
            reject(new Error(result.errorDetails || 'Azure speech synthesis failed'))
          }
        },
        (error) => {
          this._closeSynthesizer()
          reject(error)
        }
      )
    })

    if (!result.audioData || result.audioData.byteLength === 0) {
      throw new Error('No audio data received from Azure')
    }

    return {
      audioData: result.audioData,
      sampleRate: 48000,
      channels: 1,
      bitsPerSample: 16,
    }
  }

  /**
   * Build enhanced SSML with dynamic prosody, context-aware pauses, and style control.
   *
   * Improvements over the basic SSML:
   * - Per-sentence prosody variation (questions get higher pitch, exclamations faster pace)
   * - Context-aware pauses (varying by punctuation type)
   * - styledegree parameter for expressiveness control
   * - Reduced SSML overrides for HD voices (they auto-detect emotion)
   * - Micro-pauses before emphasis and after discourse markers
   */
  buildSSML(
    text: string,
    opts: {
      voiceName: string
      language: string
      speechRate: number
      ttsStyle?: string
      styleDegree?: number
    }
  ): string {
    const { voiceName, language, speechRate, ttsStyle, styleDegree } = opts
    const hd = isHDVoice(voiceName)

    // For HD voices, use minimal SSML — they handle prosody/emotion automatically
    if (hd) {
      return this._buildHDVoiceSSML(text, voiceName, language, speechRate, ttsStyle, styleDegree)
    }

    // Standard voices get full SSML enhancement
    return this._buildStandardVoiceSSML(text, voiceName, language, speechRate, ttsStyle, styleDegree)
  }

  /**
   * Minimal SSML for HD voices — they auto-detect emotion and context.
   * Only apply rate adjustment and speaking style, let the voice handle the rest.
   */
  private _buildHDVoiceSSML(
    text: string,
    voiceName: string,
    language: string,
    speechRate: number,
    ttsStyle?: string,
    styleDegree?: number
  ): string {
    let escapedText = this._escapeXml(text)

    // HD voices still benefit from paragraph breaks
    escapedText = escapedText.replace(/\n\s*\n/g, '<break time="600ms"/>')

    // Only apply rate if it deviates from normal
    const ratePercent = Math.round((speechRate - 1.0) * 100)
    const needsRate = Math.abs(ratePercent) > 5
    let content = escapedText
    if (needsRate) {
      const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`
      content = `<prosody rate="${rateStr}">${escapedText}</prosody>`
    }

    // HD voices support styles with styledegree
    const useStyle = ttsStyle && ttsStyle !== 'neutral' && voiceSupportsStyles(voiceName)
    if (useStyle) {
      const degree = styleDegree ?? 1.0
      content = `<mstts:express-as style="${ttsStyle}" styledegree="${degree.toFixed(2)}">${content}</mstts:express-as>`
    }

    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${language}">
  <voice name="${voiceName}">
    ${content}
  </voice>
</speak>`
  }

  /**
   * Full enhanced SSML for standard Neural voices.
   * Includes per-sentence prosody variation, context-aware pauses, and emphasis.
   */
  private _buildStandardVoiceSSML(
    text: string,
    voiceName: string,
    language: string,
    speechRate: number,
    ttsStyle?: string,
    styleDegree?: number
  ): string {
    // Split into sentences for per-sentence prosody
    const sentences = this._splitSentences(text)
    const totalSentences = sentences.length

    // Build per-sentence SSML
    const sentenceSSML = sentences.map((sentence, index) => {
      const trimmed = sentence.trim()
      if (!trimmed) return ''

      let escapedSentence = this._escapeXml(trimmed)

      // Context-aware pauses within the sentence
      escapedSentence = this._insertContextualPauses(escapedSentence)

      // Determine sentence-level prosody adjustments
      const { rateAdj, pitchAdj } = this._getSentenceProsody(trimmed, index, totalSentences)

      // Calculate final rate and pitch
      const baseRatePercent = Math.round((speechRate - 1.0) * 100)
      const finalRate = baseRatePercent + rateAdj
      const rateStr = finalRate >= 0 ? `+${finalRate}%` : `${finalRate}%`
      const pitchStr = pitchAdj >= 0 ? `+${pitchAdj}%` : `${pitchAdj}%`

      let sentenceContent = `<prosody rate="${rateStr}" pitch="${pitchStr}">${escapedSentence}</prosody>`

      // Add inter-sentence pause based on sentence ending
      if (index < totalSentences - 1) {
        const pause = this._getInterSentencePause(trimmed)
        sentenceContent += `<break time="${pause}ms"/>`
      }

      return sentenceContent
    }).filter(Boolean).join('\n    ')

    // Wrap in speaking style with styledegree
    const useStyle = ttsStyle && ttsStyle !== 'neutral' && voiceSupportsStyles(voiceName)
    const degree = styleDegree ?? 1.3 // Default slightly more expressive than neutral (1.0)
    const styledContent = useStyle
      ? `<mstts:express-as style="${ttsStyle}" styledegree="${degree.toFixed(2)}">${sentenceSSML}</mstts:express-as>`
      : sentenceSSML

    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${language}">
  <voice name="${voiceName}">
    ${styledContent}
  </voice>
</speak>`
  }

  /** Split text into sentences, preserving the ending punctuation */
  private _splitSentences(text: string): string[] {
    // Split on sentence boundaries while keeping the delimiter
    const raw = text.split(/(?<=[.!?])\s+/)
    // Also split on paragraph breaks
    const result: string[] = []
    for (const chunk of raw) {
      if (chunk.includes('\n\n')) {
        result.push(...chunk.split(/\n\s*\n/).filter(Boolean))
      } else {
        result.push(chunk)
      }
    }
    return result.filter(s => s.trim().length > 0)
  }

  /**
   * Get per-sentence prosody adjustments based on content and position.
   * Returns small rate and pitch adjustments (in percentage points).
   */
  private _getSentenceProsody(
    sentence: string,
    index: number,
    total: number
  ): { rateAdj: number; pitchAdj: number } {
    let rateAdj = 0
    let pitchAdj = 2 // Baseline slight pitch lift for warmth

    // First sentence: slightly slower, warmer (easing in)
    if (index === 0 && total > 1) {
      rateAdj = -3
      pitchAdj = 3
    }

    // Last sentence: slight slowdown for natural deceleration
    if (index === total - 1 && total > 1) {
      rateAdj = -2
      pitchAdj = 1
    }

    // Questions: higher pitch, slightly slower
    if (sentence.trimEnd().endsWith('?')) {
      pitchAdj += 4
      rateAdj -= 2
    }

    // Exclamations: slightly faster, more energy
    if (sentence.trimEnd().endsWith('!')) {
      rateAdj += 2
      pitchAdj += 2
    }

    // Parenthetical/aside (starts with "By the way", "Also", "Actually")
    const asidePattern = /^(By the way|Also|Actually|Incidentally|Oh|Well|So|Now|Alright)/i
    if (asidePattern.test(sentence.trim())) {
      pitchAdj += 1
    }

    // Add tiny random variation for naturalness (±1%)
    rateAdj += Math.round(Math.random() * 2) - 1
    pitchAdj += Math.round(Math.random() * 2) - 1

    return { rateAdj, pitchAdj }
  }

  /** Insert context-aware pauses within a sentence */
  private _insertContextualPauses(escapedText: string): string {
    let result = escapedText

    // Paragraph breaks → long pause
    result = result.replace(/\n\s*\n/g, '<break time="600ms"/>')

    // Em-dash — pause on each side
    result = result.replace(/\s*—\s*/g, '<break time="200ms"/>—<break time="200ms"/>')
    result = result.replace(/\s*--\s*/g, '<break time="200ms"/>—<break time="200ms"/>')

    // Colon/semicolon → medium pause
    result = result.replace(/([;:])\s+/g, '$1<break time="250ms"/>')

    // Comma → short breath pause
    result = result.replace(/,\s+/g, ',<break time="150ms"/>')

    // After discourse markers at sentence start
    result = result.replace(
      /^(Well|So|Now|Alright|OK|Okay|Right|Sure|Actually|Basically|Honestly),/i,
      '$1,<break time="200ms"/>'
    )

    // Ellipsis → thoughtful pause
    result = result.replace(/\.{3}/g, '<break time="400ms"/>')

    return result
  }

  /** Get inter-sentence pause duration based on how the sentence ends */
  private _getInterSentencePause(sentence: string): number {
    const trimmed = sentence.trimEnd()
    if (trimmed.endsWith('?')) return 350  // Let the question land
    if (trimmed.endsWith('!')) return 300  // Brief beat after exclamation
    if (trimmed.endsWith('...')) return 450 // Trailing thought
    return 280 // Standard sentence break
  }

  /** Escape XML special characters */
  private _escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  private async _getSpeechSdk(): Promise<SpeechSdkModule> {
    this._speechSdkPromise ??= import('microsoft-cognitiveservices-speech-sdk')
    return this._speechSdkPromise
  }

  /** Get or create a persistent synthesizer */
  private async _getOrCreateSynthesizer(voiceName: string): Promise<SpeechSynthesizer> {
    const configHash = `${this._speechKey}|${this._speechRegion}|${voiceName}`
    if (this._persistentSynthesizer && this._synthesizerConfigHash === configHash) {
      return this._persistentSynthesizer
    }

    this._closeSynthesizer()

    const speechSdk = await this._getSpeechSdk()
    const speechConfig = speechSdk.SpeechConfig.fromSubscription(this._speechKey, this._speechRegion)
    speechConfig.speechSynthesisVoiceName = voiceName
    speechConfig.speechSynthesisOutputFormat = speechSdk.SpeechSynthesisOutputFormat.Raw48Khz16BitMonoPcm

    const audioStream = speechSdk.AudioOutputStream.createPullStream()
    const audioConfig = speechSdk.AudioConfig.fromStreamOutput(audioStream)
    this._persistentSynthesizer = new speechSdk.SpeechSynthesizer(speechConfig, audioConfig)
    this._synthesizerConfigHash = configHash

    console.log('[AzureTTS] Created persistent synthesizer for', voiceName)
    return this._persistentSynthesizer
  }

  /** Close the persistent synthesizer */
  private _closeSynthesizer(): void {
    if (this._persistentSynthesizer) {
      try { this._persistentSynthesizer.close() } catch { /* ignore */ }
      this._persistentSynthesizer = null
      this._synthesizerConfigHash = ''
    }
  }

  async synthesizeStream(options: TtsSynthesisOptions): Promise<TtsSynthesisStreamResult> {
    if (!this._isInitialized) {
      throw new Error('Azure TTS provider not initialized')
    }

    const voiceName = options.voiceName || 'en-US-JennyNeural'
    const ssml = this.buildSSML(options.text, {
      voiceName,
      language: options.language || 'en-US',
      speechRate: options.speechRate ?? 1.0,
      ttsStyle: options.ttsStyle,
      styleDegree: options.styleDegree,
    })

    const speechSdk = await this._getSpeechSdk()
    const synthesizer = await this._getOrCreateSynthesizer(voiceName)

    // Create a ReadableStream that enqueues audio chunks from the synthesizing event
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
      cancel() {
        // Clean up event handler if stream is cancelled by consumer
        synthesizer.synthesizing = undefined as unknown as typeof synthesizer.synthesizing
      },
    })

    // Subscribe to the synthesizing event for incremental audio chunks
    synthesizer.synthesizing = (_sender, event) => {
      if (event.result?.audioData && event.result.audioData.byteLength > 0) {
        try {
          streamController?.enqueue(new Uint8Array(event.result.audioData))
        } catch {
          // Stream may have been closed
        }
      }
    }

    // Start synthesis (async) — closes the stream on completion or error
    synthesizer.speakSsmlAsync(
      ssml,
      (result) => {
        synthesizer.synthesizing = undefined as unknown as typeof synthesizer.synthesizing
        if (result.reason === speechSdk.ResultReason.SynthesizingAudioCompleted) {
          try { streamController?.close() } catch { /* stream already closed */ }
        } else {
          try {
            streamController?.error(new Error(result.errorDetails || 'Synthesis failed'))
          } catch { /* ignore */ }
          this._closeSynthesizer()
        }
      },
      (error: string) => {
        synthesizer.synthesizing = undefined as unknown as typeof synthesizer.synthesizing
        try {
          streamController?.error(new Error(error))
        } catch { /* ignore */ }
        this._closeSynthesizer()
      },
    )

    return {
      stream,
      sampleRate: 48000,
      channels: 1,
      bitsPerSample: 16,
    }
  }

  /** Pre-warm the synthesizer to avoid first-call latency */
  warmUp(voiceName: string): void {
    if (!this._isInitialized) return
    void this._getOrCreateSynthesizer(voiceName)
      .then(() => {
        console.log('[AzureTTS] Synthesizer pre-warmed for', voiceName)
      })
      .catch((err) => {
        console.warn('[AzureTTS] Warm-up failed:', err)
      })
  }

  dispose(): void {
    this._closeSynthesizer()
    this._isInitialized = false
  }
}
