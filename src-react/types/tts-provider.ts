// ============================================
// TTS Provider Abstraction Types
// ============================================

/** Options passed to a TTS provider for synthesis */
export interface TtsSynthesisOptions {
  /** Text to synthesize */
  text: string
  /** Target language (BCP-47 locale, e.g., 'en-US') */
  language?: string
  /** Azure voice name (e.g., 'en-US-JennyNeural') */
  voiceName?: string
  /** Azure speaking style (e.g., 'chat', 'friendly') */
  ttsStyle?: string
  /** Style intensity (0.01–2.0, Azure mstts:express-as styledegree) */
  styleDegree?: number
  /** Speech rate (0.5–2.0) */
  speechRate?: number
}

/** Result from TTS synthesis */
export interface TtsSynthesisResult {
  /** Raw audio data (PCM or other format) */
  audioData: ArrayBuffer
  /** Sample rate of the audio */
  sampleRate: number
  /** Number of audio channels */
  channels: number
  /** Bits per sample */
  bitsPerSample: number
}

/** Result of streaming TTS synthesis — provides a ReadableStream of audio chunks */
export interface TtsSynthesisStreamResult {
  /** Stream of raw PCM audio chunks (may need resampling by consumer) */
  stream: ReadableStream<Uint8Array>
  /** Sample rate of the streamed audio (e.g., 24000 for OpenAI, 48000 for Azure) */
  sampleRate: number
  /** Number of audio channels */
  channels: number
  /** Bits per sample */
  bitsPerSample: number
}

/**
 * Interface for TTS provider implementations.
 */
export interface ITtsProvider {
  /** Display name of the provider */
  readonly name: string
  /** Whether the provider is initialized and ready */
  readonly isInitialized: boolean
  /** Initialize the provider with configuration */
  initialize(config: Record<string, unknown>): Promise<boolean>
  /** Synthesize text to audio */
  synthesize(options: TtsSynthesisOptions): Promise<TtsSynthesisResult>
  /** Optional streaming synthesis — returns audio as a stream of chunks instead of a complete buffer */
  synthesizeStream?(options: TtsSynthesisOptions): Promise<TtsSynthesisStreamResult>
  /** Dispose of provider resources */
  dispose(): void
}
