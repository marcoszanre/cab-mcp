// ============================================
// AudioBridge — Per-session audio injection context
// Replaces window.tts* globals for multi-session support
// ============================================

/**
 * AudioBridge encapsulates the audio context chain needed to inject
 * TTS audio into an ACS call. Each agent instance gets its own
 * AudioBridge, enabling parallel TTS without interference.
 *
 * Flow: TTS audio → GainNode → MediaStreamAudioDestinationNode → ACS LocalAudioStream
 */
export interface IAudioBridge {
  /** The AudioContext for this session's audio processing */
  readonly audioContext: AudioContext
  /** Gain node for volume control (0 = silent, 1 = full) */
  readonly gainNode: GainNode
  /** Destination node whose .stream feeds the ACS LocalAudioStream */
  readonly destination: MediaStreamAudioDestinationNode
  /** The MediaStream to pass to ACS LocalAudioStream */
  readonly stream: MediaStream
  /** Signal the video particle sphere that the agent is speaking */
  setAgentSpeaking: (speaking: boolean) => void
  /** Register a callback for speaking state changes (drives video particle animation) */
  onSpeakingChanged: (callback: (speaking: boolean) => void) => void
  /** Clean up all audio resources */
  dispose: () => void
  /** Whether this bridge has been disposed */
  readonly isDisposed: boolean
}

/**
 * Concrete AudioBridge implementation.
 * Creates an isolated audio processing chain per agent instance.
 */
export class AudioBridge implements IAudioBridge {
  public readonly audioContext: AudioContext
  public readonly gainNode: GainNode
  public readonly destination: MediaStreamAudioDestinationNode
  public readonly stream: MediaStream
  private _isDisposed = false
  private _onSpeakingChanged: ((speaking: boolean) => void) | null = null

  constructor() {
    this.audioContext = new AudioContext()
    this.destination = this.audioContext.createMediaStreamDestination()
    this.gainNode = this.audioContext.createGain()
    this.gainNode.gain.value = 0 // Start silent, TTS will raise gain when speaking
    this.gainNode.connect(this.destination)
    this.stream = this.destination.stream

    console.log(`[AudioBridge] Created (context state: ${this.audioContext.state})`)
  }

  get isDisposed(): boolean {
    return this._isDisposed
  }

  /**
   * Register a callback for speaking state changes (drives video particle animation).
   */
  onSpeakingChanged(callback: (speaking: boolean) => void): void {
    this._onSpeakingChanged = callback
  }

  setAgentSpeaking(speaking: boolean): void {
    this._onSpeakingChanged?.(speaking)
  }

  /**
   * Resume the audio context if it was suspended (browser autoplay policy).
   */
  async resume(): Promise<void> {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }
  }

  dispose(): void {
    if (this._isDisposed) return
    this._isDisposed = true

    try {
      this.gainNode.disconnect()
    } catch { /* already disconnected */ }

    try {
      this.audioContext.close()
    } catch { /* already closed */ }

    this._onSpeakingChanged = null
    console.log('[AudioBridge] Disposed')
  }
}

/**
 * Factory function to create a new AudioBridge.
 */
export function createAudioBridge(): AudioBridge {
  return new AudioBridge()
}
