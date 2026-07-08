import { useState, useCallback } from 'react'
import { useConfigStore } from '@/stores/configStore'
import { extractLanguageFromVoice, voiceSupportsStyles } from '@/lib/languageVoiceMap'

// Singleton state shared across all hook instances to prevent overlapping audio
let currentAudioSource: AudioBufferSourceNode | null = null
let currentAudioContext: AudioContext | null = null
let currentSynthesizer: import('microsoft-cognitiveservices-speech-sdk').SpeechSynthesizer | null = null
let currentSetIsPreviewing: ((value: boolean) => void) | null = null

/** Wrap raw PCM data in a WAV header for AudioContext.decodeAudioData fallback */
function createWavBuffer(pcmData: ArrayBuffer, sampleRate = 48000): ArrayBuffer {
  const length = pcmData.byteLength
  const buf = new ArrayBuffer(44 + length)
  const view = new DataView(buf)
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + length, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, length, true)
  new Uint8Array(buf, 44).set(new Uint8Array(pcmData))
  return buf
}

interface UseVoicePreviewOptions {
  voiceName: string
  ttsStyle?: string
  speechRate?: number
}

export function useVoicePreview({ voiceName, ttsStyle = 'chat', speechRate: _speechRate }: UseVoicePreviewOptions) {
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const { config } = useConfigStore()

  const stopPreview = useCallback(() => {
    if (currentAudioSource) {
      try {
        currentAudioSource.stop()
      } catch (e) {
        console.warn('Error stopping audio source:', e)
      }
      currentAudioSource = null
    }

    if (currentSynthesizer) {
      try {
        currentSynthesizer.close()
      } catch (e) {
        console.warn('Error closing synthesizer:', e)
      }
      currentSynthesizer = null
    }

    if (currentSetIsPreviewing) {
      currentSetIsPreviewing(false)
      currentSetIsPreviewing = null
    }
    setIsPreviewing(false)
  }, [])

  const handlePreview = useCallback(async () => {
    if (!config.speech?.key || !config.speech?.region) {
      setPreviewError('Azure Speech not configured. Configure in Settings first.')
      return
    }

    stopPreview()

    setIsPreviewing(true)
    setPreviewError(null)
    currentSetIsPreviewing = setIsPreviewing

    // Create/resume AudioContext during user gesture to satisfy autoplay policy
    try {
      if (!currentAudioContext || currentAudioContext.state === 'closed') {
        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        currentAudioContext = new AudioContextClass()
      }
      if (currentAudioContext.state === 'suspended') {
        await currentAudioContext.resume()
      }
    } catch (err) {
      console.warn('[VoicePreview] Failed to create AudioContext:', err)
      setPreviewError('Failed to initialize audio playback.')
      setIsPreviewing(false)
      currentSetIsPreviewing = null
      return
    }

    try {
      const SpeechSDK = await import('microsoft-cognitiveservices-speech-sdk')

      const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(
        config.speech.key,
        config.speech.region
      )
      speechConfig.speechSynthesisVoiceName = voiceName
      speechConfig.speechSynthesisOutputFormat = SpeechSDK.SpeechSynthesisOutputFormat.Raw48Khz16BitMonoPcm

      const audioStream = SpeechSDK.AudioOutputStream.createPullStream()
      const audioConfig = SpeechSDK.AudioConfig.fromStreamOutput(audioStream)
      const synthesizer = new SpeechSDK.SpeechSynthesizer(speechConfig, audioConfig)
      currentSynthesizer = synthesizer

      const previewText = "Hello! I'm your AI agent assistant for Teams meetings. This is how my voice will sound during the meeting."

      const voiceLocale = extractLanguageFromVoice(voiceName)
      const escapedText = previewText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const prosodyContent = `<prosody rate="+0%" pitch="+2%">${escapedText}</prosody>`
      const useStyle = ttsStyle && ttsStyle !== 'neutral' && voiceSupportsStyles(voiceName)
      const styledContent = useStyle
        ? `<mstts:express-as style="${ttsStyle}">${prosodyContent}</mstts:express-as>`
        : prosodyContent
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${voiceLocale}">
  <voice name="${voiceName}">
    ${styledContent}
  </voice>
</speak>`

      synthesizer.speakSsmlAsync(
        ssml,
        async (result) => {
          if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted && result.audioData) {
            try {
              const ctx = currentAudioContext
              if (!ctx || ctx.state === 'closed') {
                console.warn('[VoicePreview] AudioContext was closed before playback')
                setIsPreviewing(false)
                currentSetIsPreviewing = null
                return
              }

              let audioBuffer: AudioBuffer
              try {
                audioBuffer = await ctx.decodeAudioData(result.audioData.slice(0))
              } catch {
                console.warn('[VoicePreview] Direct decode failed, trying WAV header fallback')
                const wavBuffer = createWavBuffer(result.audioData, 48000)
                audioBuffer = await ctx.decodeAudioData(wavBuffer)
              }

              const source = ctx.createBufferSource()
              source.buffer = audioBuffer
              source.connect(ctx.destination)
              currentAudioSource = source

              source.onended = () => {
                if (currentAudioSource === source) {
                  currentAudioSource = null
                  if (currentSetIsPreviewing === setIsPreviewing) {
                    setIsPreviewing(false)
                    currentSetIsPreviewing = null
                  }
                }
              }

              source.start(0)
            } catch (playErr) {
              console.warn('[VoicePreview] Playback error:', playErr)
              setPreviewError('Failed to play audio preview.')
              setIsPreviewing(false)
              currentSetIsPreviewing = null
            }
          } else if (result.reason === SpeechSDK.ResultReason.Canceled) {
            const cancellation = SpeechSDK.CancellationDetails.fromResult(result)
            if (cancellation.reason !== SpeechSDK.CancellationReason.Error ||
                !cancellation.errorDetails?.includes('disposed')) {
              console.warn('[VoicePreview] Synthesis canceled:', cancellation.reason, cancellation.errorDetails)
            }
            setIsPreviewing(false)
            currentSetIsPreviewing = null
          } else {
            setPreviewError('Preview failed. Please check your Azure Speech configuration.')
            setIsPreviewing(false)
            currentSetIsPreviewing = null
          }

          if (currentSynthesizer === synthesizer) {
            currentSynthesizer = null
          }
          synthesizer.close()
        },
        (error) => {
          console.warn('[VoicePreview] Synthesis error:', error)
          setPreviewError(`Preview error: ${error}`)
          setIsPreviewing(false)
          if (currentSynthesizer === synthesizer) {
            currentSynthesizer = null
          }
          currentSetIsPreviewing = null
          synthesizer.close()
        }
      )
    } catch (err) {
      console.warn('[VoicePreview] Failed to load Azure Speech SDK:', err)
      setPreviewError('Failed to load Azure Speech SDK.')
      setIsPreviewing(false)
      currentSynthesizer = null
      currentSetIsPreviewing = null
    }
  }, [config.speech?.key, config.speech?.region, voiceName, ttsStyle, stopPreview])

  return { isPreviewing, previewError, handlePreview, stopPreview }
}
