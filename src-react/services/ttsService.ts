// Text-to-Speech Service
// Supports Azure Speech SDK with conversational text rewriting

import type OpenAI from 'openai'
import { type AcsCallService, getAcsCallService } from './acsService'
import type { SpeechState } from '@/types'
import { getVoiceForLanguage, extractLanguageFromVoice } from '@/lib/languageVoiceMap'
import {
  createAzureOpenAIClient,
  isDesktopRuntimeAvailable,
  type AzureOpenAIClientConfig,
} from '@/services/validationService'
import { AzureTtsProvider } from './tts-providers/azureTtsProvider'
import type { ITtsProvider, TtsSynthesisOptions } from '@/types/tts-provider'
import { StreamingAudioPlayer } from './streamingAudioPlayer'

interface TTSConfig {
  speechKey: string
  speechRegion: string
  voiceName?: string
  ttsStyle?: string
  styleDegree?: number
  speechRate?: number
  language?: string
  openaiEndpoint?: string
  openaiApiKey?: string
  openaiDeployment?: string
}

/** Result of preprocessing text for TTS, optionally with detected language */
export interface PreprocessResult {
  text: string
  detectedLanguage?: string
}

interface SpeakTextOptions {
  unmuteDuringPlayback?: boolean
  muteCallback?: () => Promise<void>
  unmuteCallback?: () => Promise<void>
  language?: string
  skipAIPreprocessing?: boolean
  preserveText?: boolean
}

// Global audio context for TTS injection (shared with ACS service)
declare global {
  interface Window {
    ttsAudioContext: AudioContext | null
    ttsGainNode: GainNode | null
    ttsDestination: MediaStreamAudioDestinationNode | null
  }
}

/**
 * TTS Preprocessor - Cleans text before TTS synthesis
 */
class TTSPreprocessor {
  private openai: OpenAI | null = null
  private openaiConfig: AzureOpenAIClientConfig | null = null
  private openaiClientPromise: Promise<OpenAI> | null = null
  private deploymentName: string = ''
  private isEnabled: boolean = false

  private async getOpenAIClient(): Promise<OpenAI | null> {
    if (!this.isEnabled || !this.openaiConfig) {
      return null
    }

    if (this.openai) {
      return this.openai
    }

    this.openaiClientPromise ??= createAzureOpenAIClient(this.openaiConfig)
      .then((client) => {
        this.openai = client
        return client
      })
      .catch((error) => {
        this.openaiClientPromise = null
        throw error
      })

    return this.openaiClientPromise
  }

  initialize(config: Pick<TTSConfig, 'openaiEndpoint' | 'openaiApiKey' | 'openaiDeployment'>): boolean {
    if (!config.openaiApiKey || !config.openaiEndpoint) {
      console.warn('OpenAI not configured, using basic text cleanup only')
      this.isEnabled = false
      this.openaiConfig = null
      this.openai = null
      this.openaiClientPromise = null
      return false
    }

    if (!isDesktopRuntimeAvailable()) {
      console.warn('TTS preprocessing requires the Tauri desktop runtime.')
      this.isEnabled = false
      this.openaiConfig = null
      this.openai = null
      this.openaiClientPromise = null
      return false
    }

    this.openaiConfig = {
      endpoint: config.openaiEndpoint,
      apiKey: config.openaiApiKey,
      deployment: config.openaiDeployment || '',
    }
    this.openai = null
    this.openaiClientPromise = null
    this.deploymentName = config.openaiDeployment || ''
    this.isEnabled = true
    console.log('TTS Preprocessor enabled with Azure OpenAI')
    return true
  }

  /**
   * Preprocess text for TTS - removes citations, URLs, etc.
   * Also detects the language of the text when OpenAI is available.
   */
  async preprocessForTTS(text: string): Promise<PreprocessResult> {
    // Always do basic cleanup first
    const cleaned = this.basicCleanup(text)

    if (!this.isEnabled) {
      return { text: cleaned }
    }

    try {
      const openai = await this.getOpenAIClient()
      if (!openai) {
        return { text: cleaned }
      }

      const completion = await openai.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: `You are a text-to-speech preprocessor. Transform the input text into natural spoken language.

REMOVE COMPLETELY:
- Citation markers like [1], [2], [doc1]
- ALL URLs
- Reference sections
- HTML tags, Markdown formatting

CONVERT TO NATURAL SPEECH:
- Dates: "Dec. 16" → "December 16th"
- Abbreviations: expand when appropriate
- Special characters: & → "and", % → "percent"

OUTPUT: Return a JSON object with two fields:
- "text": the clean, natural text ready for speech
- "language": the BCP-47 locale code of the text (e.g. "en-US", "it-IT", "fr-FR", "de-DE", "es-ES", "pt-BR", "ja-JP", "ko-KR", "zh-CN")

Return ONLY valid JSON, no markdown fences, no explanations.`
          },
          { role: 'user', content: text }
        ],
        model: this.deploymentName,
        max_completion_tokens: 1000
      })

      const raw = completion.choices[0]?.message?.content?.trim()
      if (raw && raw.length > 0) {
        try {
          const parsed = JSON.parse(raw) as { text?: string; language?: string }
          if (parsed.text && parsed.text.length > 0) {
            return {
              text: parsed.text,
              detectedLanguage: parsed.language || undefined,
            }
          }
        } catch {
          // LLM didn't return valid JSON — use the raw text as cleaned text
          if (raw.length > 0) {
            return { text: raw }
          }
        }
      }
    } catch (error) {
      console.error('AI preprocessing failed, using basic cleanup:', error)
    }

    return { text: cleaned }
  }

  /**
   * Basic text cleanup without AI
   */
  basicCleanup(text: string): string {
    let cleaned = text

    // Remove reference definitions: [1]: https://... "Title"
    cleaned = cleaned.replace(/\[\d+\]:\s*https?:\/\/[^\s]+\s*"[^"]*"/g, '')
    cleaned = cleaned.replace(/\[\d+\]:\s*https?:\/\/[^\s]+/g, '')

    // Remove inline citations
    cleaned = cleaned.replace(/\u200B?\[\d+\]\u200B?/g, '')
    cleaned = cleaned.replace(/\[\d+\]/g, '')
    cleaned = cleaned.replace(/\[doc\d+\]/gi, '')

    // Remove markdown formatting
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1')
    cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1')
    cleaned = cleaned.replace(/__([^_]+)__/g, '$1')
    cleaned = cleaned.replace(/_([^_]+)_/g, '$1')

    // Remove URLs
    cleaned = cleaned.replace(/https?:\/\/[^\s"]+/gi, '')
    cleaned = cleaned.replace(/www\.[^\s"]+/gi, '')

    // Remove markdown links [text](url)
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

    // Remove HTML tags
    cleaned = cleaned.replace(/<[^>]*>/g, '')

    // Expand common abbreviations
    const months: Record<string, string> = {
      'Jan.': 'January', 'Feb.': 'February', 'Mar.': 'March',
      'Apr.': 'April', 'Jun.': 'June', 'Jul.': 'July',
      'Aug.': 'August', 'Sep.': 'September', 'Oct.': 'October',
      'Nov.': 'November', 'Dec.': 'December'
    }
    for (const [abbr, full] of Object.entries(months)) {
      cleaned = cleaned.replace(new RegExp(`\\b${abbr}\\s*`, 'gi'), full + ' ')
    }

    // Clean up whitespace
    cleaned = cleaned.replace(/\s+/g, ' ')
    cleaned = cleaned.replace(/\s+([.,!?])/g, '$1')
    cleaned = cleaned.replace(/([.,!?])\s*([.,!?])+/g, '$1')
    cleaned = cleaned.trim()

    return cleaned
  }
}

/**
 * Speech Text Rewriter — Uses LLM to transform text for natural spoken delivery.
 * Adds contractions, discourse markers, conversational phrasing, and emphasis hints.
 */
class SpeechTextRewriter {
  private openai: OpenAI | null = null
  private openaiConfig: AzureOpenAIClientConfig | null = null
  private openaiClientPromise: Promise<OpenAI> | null = null
  private deploymentName: string = ''
  private isEnabled: boolean = false

  private async getOpenAIClient(): Promise<OpenAI | null> {
    if (!this.isEnabled || !this.openaiConfig) {
      return null
    }

    if (this.openai) {
      return this.openai
    }

    this.openaiClientPromise ??= createAzureOpenAIClient(this.openaiConfig)
      .then((client) => {
        this.openai = client
        return client
      })
      .catch((error) => {
        this.openaiClientPromise = null
        throw error
      })

    return this.openaiClientPromise
  }

  initialize(config: Pick<TTSConfig, 'openaiEndpoint' | 'openaiApiKey' | 'openaiDeployment'>): boolean {
    if (!config.openaiApiKey || !config.openaiEndpoint || !config.openaiDeployment) {
      this.isEnabled = false
      this.openaiConfig = null
      this.openai = null
      this.openaiClientPromise = null
      return false
    }

    if (!isDesktopRuntimeAvailable()) {
      console.warn('[TTS] Speech rewriting requires the Tauri desktop runtime.')
      this.isEnabled = false
      this.openaiConfig = null
      this.openai = null
      this.openaiClientPromise = null
      return false
    }

    this.openaiConfig = {
      endpoint: config.openaiEndpoint,
      apiKey: config.openaiApiKey,
      deployment: config.openaiDeployment,
    }
    this.openai = null
    this.openaiClientPromise = null
    this.deploymentName = config.openaiDeployment
    this.isEnabled = true
    console.log('[TTS] Speech text rewriter enabled')
    return true
  }

  /**
   * Rewrite text for natural spoken delivery.
   * Returns the rewritten text, or the original if rewriting fails or is disabled.
   */
  async rewriteForSpeech(text: string): Promise<string> {
    if (!this.isEnabled) {
      return text
    }

    // Skip very short text (greetings, acknowledgments)
    if (text.length < 30) {
      return text
    }

    try {
      const openai = await this.getOpenAIClient()
      if (!openai) {
        return text
      }

      const completion = await openai.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: `You are a speech delivery optimizer. Rewrite the input text so it sounds natural and friendly when spoken aloud by a TTS engine in a meeting.

RULES:
1. Use contractions: "I am" → "I'm", "do not" → "don't", "it is" → "it's", "they are" → "they're"
2. Add brief conversational openers when appropriate: "Sure!", "Great question!", "So,", "Alright,"
3. Break long sentences into shorter, spoken-friendly chunks
4. Replace formal transitions: "Additionally" → "Also", "Furthermore" → "And", "However" → "But"  
5. Make lists flow naturally: instead of "First... Second... Third..." use "So first... then... and finally..."
6. Add natural discourse markers between ideas: "Now,", "So here's the thing,", "And,"
7. Keep the same meaning and all key information — do NOT add or remove facts
8. Keep it concise — spoken text should be slightly shorter than written text
9. Do NOT add greetings or sign-offs unless the original has them

OUTPUT: Return ONLY the rewritten text. No explanations, no JSON, no markdown.`
          },
          { role: 'user', content: text }
        ],
        model: this.deploymentName,
        max_completion_tokens: 800
      })

      const result = completion.choices[0]?.message?.content?.trim()
      if (result && result.length > 10) {
        return result
      }
    } catch (error) {
      console.warn('[TTS] Speech rewriting failed, using original text:', error)
    }

    return text
  }
}

/**
 * Text-to-Speech Service
 */
export class TextToSpeechService {
  private audioContext: AudioContext | null = null
  private gainNode: GainNode | null = null
  private currentSource: AudioBufferSourceNode | null = null
  private preprocessor = new TTSPreprocessor()
  private rewriter = new SpeechTextRewriter()

  private speechKey: string = ''
  private speechRegion: string = ''
  private voiceName: string = 'en-US-JennyNeural'
  private _language: string = 'en-US'
  
  // Speech rate: 0.5 = 50% slower, 1.0 = normal, 1.5 = 50% faster, 2.0 = double speed
  private _speechRate: number = 1.0

  // Speaking style for mstts:express-as (e.g. 'chat', 'friendly', 'cheerful')
  private _speakingStyle: string = 'chat'

  // Style degree for mstts:express-as styledegree (0.01–2.0)
  private _styleDegree: number = 1.3

  // TTS provider
  private _azureProvider = new AzureTtsProvider()

  // Whether conversational rewriting is enabled
  private _rewriteEnabled: boolean = true

  private _isSpeaking: boolean = false
  private _speakingResolve: (() => void) | null = null
  private _state: SpeechState = 'idle'
  private _callModeActive: boolean = false

  // Thinking tone state — subtle audio cue played while agent is processing
  private _thinkingOscillator: OscillatorNode | null = null
  private _thinkingGain: GainNode | null = null

  // Optional per-session ACS service reference for reading TTS audio context.
  // When set, this.ttsAudioContext/ttsGainNode/ttsDestination use the ACS instance's
  // properties instead of window.* globals, enabling multi-session audio isolation.
  private _acsService: AcsCallService | null = null

  // Callbacks
  public onStateChanged: ((state: SpeechState, message?: string) => void) | null = null
  public onSpeakingFinished: (() => void) | null = null

  /**
   * Link this TTS service to a per-session AcsCallService instance.
   * Must be called after constructing the service (e.g. in AgentServiceContainer).
   */
  setAcsService(acsService: AcsCallService): void {
    this._acsService = acsService
  }

  // ── Audio context accessors (prefer per-instance, fallback to window globals) ──
  private get _ttsAudioContext(): AudioContext | null {
    return this._acsService?.ttsAudioContext ?? window.ttsAudioContext
  }
  private get _ttsGainNode(): GainNode | null {
    return this._acsService?.ttsGainNode ?? window.ttsGainNode
  }
  private get _ttsDestination(): MediaStreamAudioDestinationNode | null {
    return this._acsService?.ttsDestination ?? window.ttsDestination
  }
  private get _isInCall(): boolean {
    if (this._acsService) return this._acsService.isInCall()
    return getAcsCallService().isInCall()
  }

  /**
   * Get the current speech rate
   */
  get speechRate(): number {
    return this._speechRate
  }

  /**
   * Set speech rate (0.5 = slow, 1.0 = normal, 1.5 = fast, 2.0 = very fast)
   */
  set speechRate(rate: number) {
    this._speechRate = Math.max(0.5, Math.min(2.0, rate))
    console.log(`Speech rate set to ${this._speechRate}`)
  }

  /**
   * Get the current speaking style
   */
  get speakingStyle(): string {
    return this._speakingStyle
  }

  /**
   * Set speaking style for mstts:express-as (e.g. 'chat', 'friendly', 'cheerful')
   */
  set speakingStyle(style: string) {
    this._speakingStyle = style
    console.log(`Speaking style set to ${this._speakingStyle}`)
  }

  /**
   * Get the current TTS language
   */
  get language(): string {
    return this._language
  }

  /**
   * Switch TTS voice and language to match a BCP-47 locale (e.g. 'it-IT').
   * Automatically selects the best Azure Neural voice for the language.
   * Returns true if a matching voice was found and set.
   */
  setVoiceForLanguage(lang: string): boolean {
    const match = getVoiceForLanguage(lang)
    if (!match) {
      console.warn(`[TTS] No voice found for language "${lang}", keeping current voice`)
      return false
    }
    this.voiceName = match.voiceName
    this._language = match.locale
    console.log(`[TTS] Voice switched to ${match.voiceName} for language ${match.locale}`)
    return true
  }

  /**
   * Initialize the TTS service
   */
  async initialize(config: TTSConfig): Promise<boolean> {
    try {
      console.log('Initializing TTS service...')

      this.speechKey = config.speechKey
      this.speechRegion = config.speechRegion
      this.voiceName = config.voiceName || 'en-US-JennyNeural'
      this._language = config.language || extractLanguageFromVoice(this.voiceName)
      this._speakingStyle = config.ttsStyle || 'chat'
      this._styleDegree = config.styleDegree ?? 1.3
      this._speechRate = Math.max(0.5, Math.min(2.0, config.speechRate ?? 1.0))

      // Azure Speech key is required
      if (!this.speechKey) {
        console.warn('Speech service key not configured. TTS will not work.')
        return false
      }

      // Create local audio context (for fallback/testing)
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.audioContext = new AudioContextClass()

      this.gainNode = this.audioContext.createGain()
      this.gainNode.gain.value = 1.0

      // Initialize preprocessor
      this.preprocessor.initialize({
        openaiEndpoint: config.openaiEndpoint,
        openaiApiKey: config.openaiApiKey,
        openaiDeployment: config.openaiDeployment
      })

      // Initialize conversational rewriter (uses same OpenAI config)
      this.rewriter.initialize({
        openaiEndpoint: config.openaiEndpoint,
        openaiApiKey: config.openaiApiKey,
        openaiDeployment: config.openaiDeployment
      })

      // Initialize Azure TTS provider
      if (this.speechKey) {
        await this._azureProvider.initialize({
          speechKey: this.speechKey,
          speechRegion: this.speechRegion,
        })
      }

      console.log('TTS service initialized successfully')
      return true
    } catch (error) {
      console.error('Failed to initialize TTS service:', error)
      return false
    }
  }

  /**
   * Build SSML — delegates to Azure provider for enhanced generation.
   * Kept as a public method for voice preview and testing.
   */
  buildSSML(text: string): string {
    return this._azureProvider.buildSSML(text, {
      voiceName: this.voiceName,
      language: this._language,
      speechRate: this._speechRate,
      ttsStyle: this._speakingStyle,
      styleDegree: this._styleDegree,
    })
  }

  /**
   * Get the active TTS provider
   */
  private _getActiveProvider(): ITtsProvider {
    return this._azureProvider
  }

  /**
   * Synthesize text to speech using the active provider
   */
  private async synthesizeSpeech(text: string): Promise<ArrayBuffer> {
    const provider = this._getActiveProvider()
    if (!provider.isInitialized) {
      throw new Error('TTS provider not initialized')
    }

    console.log(`[TTS] Synthesizing with ${provider.name} (rate: ${this._speechRate})...`)
    this.setState('synthesizing', 'Synthesizing speech...')

    const options: TtsSynthesisOptions = {
      text,
      language: this._language,
      voiceName: this.voiceName,
      ttsStyle: this._speakingStyle,
      styleDegree: this._styleDegree,
      speechRate: this._speechRate,
    }

    const result = await provider.synthesize(options)

    if (!result.audioData || result.audioData.byteLength === 0) {
      throw new Error('No audio data received')
    }

    console.log(`[TTS] Synthesized ${result.audioData.byteLength} bytes via ${provider.name}`)
    return result.audioData
  }

  /**
   * Pre-warm the TTS synthesizer so the first speak call has no init delay.
   * Call this when the agent joins a meeting.
   */
  warmUp(): void {
    if (this._azureProvider.isInitialized) {
      this._azureProvider.warmUp(this.voiceName)
    }
  }

  /**
   * Eagerly resume audio contexts so the first playback has no suspend→resume delay.
   * Safe to call multiple times.
   */
  async resumeAudioContexts(): Promise<void> {
    try {
      if (this._ttsAudioContext?.state === 'suspended') {
        await this._ttsAudioContext.resume()
        console.log('[TTS] TTS audio context pre-resumed')
      }
      if (this.audioContext?.state === 'suspended') {
        await this.audioContext.resume()
        console.log('[TTS] Local audio context pre-resumed')
      }
    } catch (err) {
      console.warn('[TTS] Audio context pre-resume failed:', err)
    }
  }

  /**
   * Set call mode — when active, the local AudioContext is silenced to prevent
   * TTS audio from leaking to system speakers. Only the call injection path
   * (this._ttsAudioContext) should produce audio during a call.
   */
  setCallMode(active: boolean): void {
    this._callModeActive = active
    if (this.gainNode) {
      this.gainNode.gain.value = active ? 0 : 1.0
    }
    console.log(`[TTS] Call mode ${active ? 'ENABLED' : 'DISABLED'} — local speaker ${active ? 'silenced' : 'active'}`)
  }

  /**
   * Play audio buffer through the TTS stream (injected into call)
   */
  private async playAudioBuffer(audioBuffer: AudioBuffer): Promise<void> {
    const context = this._ttsAudioContext || this.audioContext
    if (!context) {
      throw new Error('No audio context available')
    }

    this._isSpeaking = true
    this.setState('speaking', 'Speaking...')
    
    // Trigger visual feedback for the ring animation (per-instance)
    this._acsService?.setSpeaking(true)

    // Use TTS audio stream if available (for call injection)
    if (this._ttsAudioContext && this._ttsGainNode && this._ttsDestination) {
      console.log('[TTS] Injecting audio into call stream via ttsAudioContext (state:', this._ttsAudioContext.state, ')')

      if (this._ttsAudioContext.state === 'suspended') {
        await this._ttsAudioContext.resume()
      }

      const source = this._ttsAudioContext.createBufferSource()
      source.buffer = audioBuffer

      // Set gain for playback
      this._ttsGainNode.gain.value = 1.0
      source.connect(this._ttsGainNode)

      this.currentSource = source

      // Await full audio playback before resolving
      await new Promise<void>((resolve) => {
        source.onended = () => {
          this._ttsGainNode!.gain.value = 0
          this._isSpeaking = false
          this._speakingResolve?.()
          this._speakingResolve = null
          this.setState('idle', 'Speech completed')
          this._acsService?.setSpeaking(false)
          this.onSpeakingFinished?.()
          resolve()
        }
        source.start(0)
        console.log('[TTS] Audio injection started — audio routed to meeting only')
      })
    } else {
      // Guard: if we are in an active call, do NOT fall back to system speakers.
      // The call audio context may have been prematurely cleaned up — log and bail.
      const inCall = this._isInCall
      if (inCall || this._callModeActive) {
        console.error('[TTS] In active call but call audio context is missing (ttsAudioContext:', this._ttsAudioContext,
          ', ttsGainNode:', this._ttsGainNode, ', ttsDestination:', this._ttsDestination,
          '). Refusing to play through system speakers to prevent audio leak.')
        this._isSpeaking = false
        this._speakingResolve?.()
        this._speakingResolve = null
        this.setState('error', 'Call audio context unavailable')
        this._acsService?.setSpeaking(false)
        return
      }

      // Fallback to system speakers (only allowed outside of a call, e.g. voice preview)
      console.log('[TTS] No active call — playing through system speakers (preview/testing mode)')

      if (!this.audioContext || !this.gainNode) {
        throw new Error('Local audio context not available')
      }

      const source = this.audioContext.createBufferSource()
      source.buffer = audioBuffer
      source.connect(this.gainNode)
      this.gainNode.connect(this.audioContext.destination)

      this.currentSource = source

      // Await full audio playback before resolving
      await new Promise<void>((resolve) => {
        source.onended = () => {
          this._isSpeaking = false
          this._speakingResolve?.()
          this._speakingResolve = null
          this.setState('idle', 'Speech completed')
          this._acsService?.setSpeaking(false)
          this.onSpeakingFinished?.()
          resolve()
        }
        source.start(0)
      })
    }
  }

  /**
   * Speak text with preprocessing, conversational rewriting, and call integration.
   * Pipeline: Raw text → Clean → Rewrite for speech → Synthesize → Play
   */
  async speakText(text: string, options?: SpeakTextOptions): Promise<string> {
    try {
      // Fast-path for short responses (greetings, acknowledgments)
      const isShortText = text.length < 50
      if (isShortText && !options?.preserveText) {
        options = { ...options, skipAIPreprocessing: true }
      }

      // Step 1+2: Run preprocessing and conversational rewrite in parallel
      console.log('[TTS] Original text:', text.substring(0, 100) + '...')
      const basicCleaned = options?.preserveText ? text : this.preprocessor.basicCleanup(text)

      let preprocessResult: PreprocessResult
      let rewrittenText: string

      if (options?.preserveText) {
        preprocessResult = { text, detectedLanguage: options.language }
        rewrittenText = text
      } else {
        [preprocessResult, rewrittenText] = await Promise.all([
          options?.skipAIPreprocessing
            ? Promise.resolve({ text: basicCleaned } as PreprocessResult)
            : this.preprocessor.preprocessForTTS(text),
          this._rewriteEnabled && basicCleaned.length >= 30
            ? this.rewriter.rewriteForSpeech(basicCleaned)
            : Promise.resolve(basicCleaned),
        ])
      }

      console.log('[TTS] Cleaned text:', preprocessResult.text.substring(0, 100) + '...')
      const spokenText = rewrittenText
      if (rewrittenText !== basicCleaned) {
        console.log('[TTS] Rewritten for speech:', spokenText.substring(0, 100) + '...')
      }

      // Step 3: Determine target language and switch voice if needed
      const targetLang = options?.language || preprocessResult.detectedLanguage
      if (targetLang && targetLang !== this._language) {
        this.setVoiceForLanguage(targetLang)
      }

      // Set up re-mute callback (before synthesis so it's ready when playback ends)
      const muteCallback = options?.muteCallback
      if (options?.unmuteDuringPlayback && muteCallback) {
        this.onSpeakingFinished = async () => {
          try {
            await muteCallback()
          } catch (error) {
            console.warn('Failed to re-mute:', error)
          }
        }
      }

      // Step 4: Synthesize + resume audio + unmute in parallel
      const [audioData] = await Promise.all([
        this.synthesizeSpeech(spokenText),
        this.resumeAudioContexts(),
        (options?.unmuteDuringPlayback && options.unmuteCallback)
          ? options.unmuteCallback()
          : Promise.resolve(),
      ])

      // Stop thinking tone before TTS playback begins
      this.stopThinkingTone()
      this.setState('speaking', 'Sending to meeting...')

      const contextToUse = this._ttsAudioContext || this.audioContext
      if (!contextToUse) {
        throw new Error('No audio context available')
      }

      try {
        const audioBuffer = await contextToUse.decodeAudioData(audioData.slice(0))
        await this.playAudioBuffer(audioBuffer)
      } catch {
        // Try with WAV header fallback
        console.log('Trying WAV header fallback...')
        const wavBuffer = this.createWavBuffer(audioData)
        const audioBuffer = await contextToUse.decodeAudioData(wavBuffer)
        await this.playAudioBuffer(audioBuffer)
      }

      return spokenText
    } catch (error) {
      console.error('Error in speakText:', error)
      this.setState('error', error instanceof Error ? error.message : 'Unknown error')
      throw error
    }
  }

  /**
   * Speak text using streaming synthesis for lower time-to-first-byte.
   * Falls back to buffered speakText() if the active provider doesn't support streaming.
   * Pipeline: Raw text → Clean → Rewrite → Stream synthesis → StreamingAudioPlayer
   */
  async speakTextStreaming(text: string, options?: SpeakTextOptions): Promise<string> {
    const provider = this._getActiveProvider()

    // Fall back to buffered speakText if provider doesn't support streaming
    if (!provider.synthesizeStream) {
      return this.speakText(text, options)
    }

    try {
      // Fast-path for short responses (greetings, acknowledgments)
      const isShortText = text.length < 50
      if (isShortText && !options?.preserveText) {
        options = { ...options, skipAIPreprocessing: true }
      }

      // Step 1+2: Run preprocessing and conversational rewrite in parallel
      console.log('[TTS] [Streaming] Original text:', text.substring(0, 100) + '...')
      const basicCleaned = options?.preserveText ? text : this.preprocessor.basicCleanup(text)

      let preprocessResult: PreprocessResult
      let rewrittenText: string

      if (options?.preserveText) {
        preprocessResult = { text, detectedLanguage: options.language }
        rewrittenText = text
      } else {
        [preprocessResult, rewrittenText] = await Promise.all([
          options?.skipAIPreprocessing
            ? Promise.resolve({ text: basicCleaned } as PreprocessResult)
            : this.preprocessor.preprocessForTTS(text),
          this._rewriteEnabled && basicCleaned.length >= 30
            ? this.rewriter.rewriteForSpeech(basicCleaned)
            : Promise.resolve(basicCleaned),
        ])
      }

      console.log('[TTS] [Streaming] Cleaned text:', preprocessResult.text.substring(0, 100) + '...')
      const spokenText = rewrittenText
      if (rewrittenText !== basicCleaned) {
        console.log('[TTS] [Streaming] Rewritten for speech:', spokenText.substring(0, 100) + '...')
      }

      // Step 3: Determine target language and switch voice if needed
      const targetLang = options?.language || preprocessResult.detectedLanguage
      if (targetLang && targetLang !== this._language) {
        this.setVoiceForLanguage(targetLang)
      }

      // Step 4: Resume audio contexts
      await this.resumeAudioContexts()

      // Step 5: Unmute before stream starts
      if (options?.unmuteDuringPlayback && options.unmuteCallback) {
        await options.unmuteCallback()
      }

      // Step 6: Build synthesis options (same as synthesizeSpeech)
      const synthOptions: TtsSynthesisOptions = {
        text: spokenText,
        language: this._language,
        voiceName: this.voiceName,
        ttsStyle: this._speakingStyle,
        styleDegree: this._styleDegree,
        speechRate: this._speechRate,
      }

      console.log(`[TTS] [Streaming] Starting stream synthesis with ${provider.name}...`)
      this.setState('synthesizing', 'Starting streaming synthesis...')

      const streamResult = await provider.synthesizeStream(synthOptions)

      // Step 7: Get audio context and gain node for playback
      const context = this._ttsAudioContext || this.audioContext
      const gainNode = this._ttsGainNode
      if (!context || !gainNode) {
        throw new Error('No audio context available for streaming playback')
      }

      // Stop thinking tone before first audio byte
      this.stopThinkingTone()

      this._isSpeaking = true
      this.setState('speaking', 'Streaming speech...')
      this._acsService?.setSpeaking(true)

      // Step 8: Create streaming player and wire callbacks
      const player = new StreamingAudioPlayer({
        audioContext: context,
        gainNode,
        inputSampleRate: streamResult.sampleRate,
        outputSampleRate: 48000,
        channels: streamResult.channels,
        bitsPerSample: streamResult.bitsPerSample,
      })

      player.onPlaybackStarted = () => {
        console.log('[TTS] [Streaming] Playback started — first audio chunk playing')
      }

      player.onPlaybackFinished = () => {
        console.log('[TTS] [Streaming] Playback finished')
        this.onSpeakingFinished?.()
      }

      // Step 9: Play the stream (blocks until complete)
      await player.playStream(streamResult.stream)

      // Step 10: Cleanup
      this._isSpeaking = false
      this._speakingResolve?.()
      this._speakingResolve = null
      this.setState('idle', 'Speech completed')
      this._acsService?.setSpeaking(false)

      // Re-mute after playback
      if (options?.unmuteDuringPlayback && options.muteCallback) {
        try {
          await options.muteCallback()
        } catch (muteErr) {
          console.warn('[TTS] [Streaming] Failed to re-mute:', muteErr)
        }
      }

      return spokenText
    } catch (error) {
      this._isSpeaking = false
      this._speakingResolve?.()
      this._speakingResolve = null
      this.setState('error', error instanceof Error ? error.message : 'Streaming error')
      this._acsService?.setSpeaking(false)
      console.error('[TTS] [Streaming] Error:', error)
      throw error
    }
  }

  /**
   * Stop current playback
   */
  stop(): void {
    if (this.currentSource) {
      this.currentSource.stop(0)
      this.currentSource = null
    }
    if (this._ttsGainNode) {
      this._ttsGainNode.gain.value = 0
    }
    this._isSpeaking = false
    this._speakingResolve?.()
    this._speakingResolve = null
    this.setState('idle')
    this._acsService?.setSpeaking(false)
  }

  /**
   * Check if speaking
   */
  isSpeaking(): boolean {
    return this._isSpeaking
  }

  /**
   * Returns a promise that resolves when any in-progress speech finishes.
   * Resolves immediately if not currently speaking.
   * Has a safety timeout to prevent indefinite waiting.
   */
  async waitForCompletion(timeoutMs: number = 15000): Promise<void> {
    if (!this._isSpeaking) return

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        resolve()
      }, timeoutMs)

      const originalResolve = this._speakingResolve
      this._speakingResolve = () => {
        clearTimeout(timeout)
        originalResolve?.()
        resolve()
      }
    })
  }

  /**
   * Get current state
   */
  getState(): SpeechState {
    return this._state
  }

  /**
   * Set volume (0.0 to 1.0)
   */
  setVolume(volume: number): void {
    const safeVolume = Math.max(0, Math.min(1, volume))
    if (this.gainNode) {
      this.gainNode.gain.value = safeVolume
    }
  }

  private setState(state: SpeechState, message?: string): void {
    this._state = state
    this.onStateChanged?.(state, message)
  }

  /**
   * Create WAV buffer from PCM data (fallback for decoding)
   */
  private createWavBuffer(
    pcmData: ArrayBuffer,
    sampleRate = 48000,
    channels = 1,
    bitsPerSample = 16
  ): ArrayBuffer {
    const length = pcmData.byteLength
    const arrayBuffer = new ArrayBuffer(44 + length)
    const view = new DataView(arrayBuffer)

    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i))
      }
    }

    // RIFF header
    writeString(0, 'RIFF')
    view.setUint32(4, 36 + length, true)
    writeString(8, 'WAVE')

    // fmt chunk
    writeString(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true) // PCM format
    view.setUint16(22, channels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * channels * bitsPerSample / 8, true)
    view.setUint16(32, channels * bitsPerSample / 8, true)
    view.setUint16(34, bitsPerSample, true)

    // data chunk
    writeString(36, 'data')
    view.setUint32(40, length, true)

    // Copy PCM data
    const uint8Array = new Uint8Array(arrayBuffer, 44)
    uint8Array.set(new Uint8Array(pcmData))

    return arrayBuffer
  }

  // ── Thinking tone — subtle audio cue while agent processes ──

  /**
   * Play a subtle "thinking" tone through the call audio stream.
   * Uses a gentle sine wave that fades in/out to signal the agent is processing.
   * Call stopThinkingTone() before TTS playback starts.
   */
  playThinkingTone(): void {
    const context = this._ttsAudioContext || this.audioContext
    const gainNode = this._ttsGainNode
    if (!context || !gainNode) return

    // Don't stack multiple thinking tones
    if (this._thinkingOscillator) return

    try {
      // Create a subtle dual-tone that sounds like a gentle "thinking" chime
      this._thinkingGain = context.createGain()
      this._thinkingGain.gain.value = 0
      this._thinkingGain.connect(gainNode)

      const osc = context.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = 440 // A4 — pleasant, non-intrusive
      osc.connect(this._thinkingGain)
      osc.start()

      // Gentle fade-in to low volume (subtle, not startling)
      const now = context.currentTime
      this._thinkingGain.gain.setValueAtTime(0, now)
      this._thinkingGain.gain.linearRampToValueAtTime(0.08, now + 0.3)
      // Fade back down after a brief tone (creates a "ping" effect)
      this._thinkingGain.gain.linearRampToValueAtTime(0.02, now + 0.8)

      this._thinkingOscillator = osc
      // Ensure gain is routed to call stream
      gainNode.gain.value = 1.0
      console.log('[TTS] Thinking tone started')
    } catch (err) {
      console.warn('[TTS] Failed to start thinking tone:', err)
      this._thinkingOscillator = null
      this._thinkingGain = null
    }
  }

  /**
   * Stop the thinking tone. Call before TTS playback begins.
   */
  stopThinkingTone(): void {
    if (this._thinkingOscillator) {
      try {
        // Quick fade-out to avoid click
        if (this._thinkingGain) {
          const context = this._ttsAudioContext || this.audioContext
          if (context) {
            const now = context.currentTime
            this._thinkingGain.gain.setValueAtTime(this._thinkingGain.gain.value, now)
            this._thinkingGain.gain.linearRampToValueAtTime(0, now + 0.1)
          }
        }
        this._thinkingOscillator.stop(
          (this._ttsAudioContext || this.audioContext)
            ? (this._ttsAudioContext || this.audioContext)!.currentTime + 0.15
            : 0
        )
      } catch {
        // Ignore — oscillator may have already stopped
      }
      this._thinkingOscillator = null
      this._thinkingGain = null
      console.log('[TTS] Thinking tone stopped')
    }
  }

  /**
   * Dispose of the service
   */
  dispose(): void {
    this.stop()
    this.stopThinkingTone()
    this._azureProvider.dispose()
    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }
    this.gainNode = null
  }

  // ── Public accessors for provider configuration ──

  /** Get the style degree */
  get styleDegree(): number {
    return this._styleDegree
  }

  /** Set style degree (0.01–2.0) */
  set styleDegree(degree: number) {
    this._styleDegree = Math.max(0.01, Math.min(2.0, degree))
  }

  /** Enable/disable conversational text rewriting */
  set rewriteEnabled(enabled: boolean) {
    this._rewriteEnabled = enabled
    console.log(`[TTS] Conversational rewriting ${enabled ? 'enabled' : 'disabled'}`)
  }

  get rewriteEnabled(): boolean {
    return this._rewriteEnabled
  }

  /** Whether the active TTS provider supports streaming synthesis */
  get supportsStreaming(): boolean {
    const provider = this._getActiveProvider()
    return typeof provider.synthesizeStream === 'function'
  }
}

// Singleton instance
let instance: TextToSpeechService | null = null

/**
 * @deprecated Use AgentServiceContainer's ttsService instead for multi-session support.
 */
export function getTextToSpeechService(): TextToSpeechService {
  if (!instance) {
    instance = new TextToSpeechService()
  }
  return instance
}
