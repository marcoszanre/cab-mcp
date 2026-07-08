import { loggers } from '@/lib/logger'

const log = loggers.speech

interface StreamingAudioPlayerOptions {
  /** The AudioContext to use for decoding and playback */
  audioContext: AudioContext
  /** The GainNode to connect audio sources to (routes to call stream) */
  gainNode: GainNode
  /** Sample rate of the incoming audio stream (e.g., 24000 for OpenAI) */
  inputSampleRate: number
  /** Target sample rate for playback (default: 48000 for ACS) */
  outputSampleRate?: number
  /** Number of channels (default: 1 = mono) */
  channels?: number
  /** Bits per sample (default: 16) */
  bitsPerSample?: number
  /** Minimum bytes of audio to buffer before starting playback (default: 9600 = 100ms at 48kHz mono 16-bit) */
  minBufferBytes?: number
}

export class StreamingAudioPlayer {
  private _audioContext: AudioContext
  private _gainNode: GainNode
  private _inputSampleRate: number
  private _outputSampleRate: number
  private _channels: number
  private _bitsPerSample: number
  private _minBufferBytes: number

  // Playback state
  private _isPlaying = false
  private _nextStartTime = 0
  private _pendingBuffer = new Uint8Array(0)
  private _activeSources: AudioBufferSourceNode[] = []

  // Callbacks
  public onPlaybackStarted: (() => void) | null = null
  public onPlaybackFinished: (() => void) | null = null

  constructor(options: StreamingAudioPlayerOptions) {
    this._audioContext = options.audioContext
    this._gainNode = options.gainNode
    this._inputSampleRate = options.inputSampleRate
    this._outputSampleRate = options.outputSampleRate ?? 48000
    this._channels = options.channels ?? 1
    this._bitsPerSample = options.bitsPerSample ?? 16
    this._minBufferBytes = options.minBufferBytes ?? 9600 // 100ms at 48kHz mono 16-bit
  }

  /**
   * Play audio from a ReadableStream. Reads chunks, buffers until minimum threshold,
   * then starts playback with chained AudioBufferSourceNodes.
   * Returns a promise that resolves when the entire stream has finished playing.
   */
  async playStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    this._isPlaying = true
    this._nextStartTime = this._audioContext.currentTime
    this._pendingBuffer = new Uint8Array(0)
    let firstChunkPlayed = false

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) break
        if (!value || value.byteLength === 0) continue

        this._appendToPendingBuffer(value)

        // Play chunks when we have enough data
        while (this._pendingBuffer.byteLength >= this._minBufferBytes) {
          const chunk = this._pendingBuffer.slice(0, this._minBufferBytes)
          this._pendingBuffer = this._pendingBuffer.slice(this._minBufferBytes)

          const resampled = this._resampleIfNeeded(chunk)
          this._scheduleChunk(resampled)

          if (!firstChunkPlayed) {
            firstChunkPlayed = true
            this.onPlaybackStarted?.()
          }
        }
      }

      // Play any remaining audio in the pending buffer
      if (this._pendingBuffer.byteLength > 0) {
        const frameSize = this._channels * (this._bitsPerSample / 8)
        const alignedLength =
          Math.floor(this._pendingBuffer.byteLength / frameSize) * frameSize
        if (alignedLength > 0) {
          const chunk = this._pendingBuffer.slice(0, alignedLength)
          const resampled = this._resampleIfNeeded(chunk)
          this._scheduleChunk(resampled)

          if (!firstChunkPlayed) {
            firstChunkPlayed = true
            this.onPlaybackStarted?.()
          }
        }
        this._pendingBuffer = new Uint8Array(0)
      }

      // Wait for all scheduled audio to finish playing
      await this._waitForPlaybackEnd()
    } catch (err) {
      log.error(`StreamingAudioPlayer error: ${err}`)
      throw err
    } finally {
      reader.releaseLock()
      this._cleanup()
      this._isPlaying = false
      this.onPlaybackFinished?.()
    }
  }

  /**
   * Stop playback and clean up all scheduled audio sources.
   */
  stop(): void {
    for (const source of this._activeSources) {
      try {
        source.stop()
        source.disconnect()
      } catch {
        /* already stopped */
      }
    }
    this._activeSources = []
    this._pendingBuffer = new Uint8Array(0)
    this._isPlaying = false
  }

  get isPlaying(): boolean {
    return this._isPlaying
  }

  // ── Private methods ──

  private _appendToPendingBuffer(chunk: Uint8Array): void {
    const combined = new Uint8Array(
      this._pendingBuffer.byteLength + chunk.byteLength
    )
    combined.set(this._pendingBuffer, 0)
    combined.set(chunk, this._pendingBuffer.byteLength)
    this._pendingBuffer = combined
  }

  /**
   * Resample PCM data from input sample rate to output sample rate if they differ.
   * Uses sample duplication for integer ratios (e.g., 24kHz → 48kHz),
   * nearest-neighbor for non-integer ratios.
   */
  private _resampleIfNeeded(chunk: Uint8Array): Uint8Array {
    if (this._inputSampleRate === this._outputSampleRate) return chunk

    const ratio = this._outputSampleRate / this._inputSampleRate
    const inputSamples = new Int16Array(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength / 2
    )

    if (ratio !== Math.floor(ratio)) {
      // Non-integer ratio — nearest-neighbor resampling
      const outputLength = Math.floor(inputSamples.length * ratio)
      const output = new Int16Array(outputLength)
      for (let i = 0; i < outputLength; i++) {
        output[i] = inputSamples[Math.floor(i / ratio)]
      }
      return new Uint8Array(output.buffer)
    }

    // Integer ratio — simple sample duplication (e.g., 24kHz → 48kHz = 2x)
    const intRatio = Math.floor(ratio)
    const output = new Int16Array(inputSamples.length * intRatio)
    for (let i = 0; i < inputSamples.length; i++) {
      for (let j = 0; j < intRatio; j++) {
        output[i * intRatio + j] = inputSamples[i]
      }
    }
    return new Uint8Array(output.buffer)
  }

  /**
   * Schedule a chunk of PCM audio for playback using an AudioBufferSourceNode.
   * Chains to play immediately after the previous chunk for gapless playback.
   */
  private _scheduleChunk(pcmData: Uint8Array): void {
    const samples = new Int16Array(
      pcmData.buffer,
      pcmData.byteOffset,
      pcmData.byteLength / 2
    )
    const numSamples = samples.length / this._channels

    const audioBuffer = this._audioContext.createBuffer(
      this._channels,
      numSamples,
      this._outputSampleRate
    )

    // Convert Int16 PCM to Float32 for Web Audio API
    const channelData = audioBuffer.getChannelData(0)
    for (let i = 0; i < numSamples; i++) {
      channelData[i] = samples[i * this._channels] / 32768
    }

    const source = this._audioContext.createBufferSource()
    source.buffer = audioBuffer
    this._gainNode.gain.value = 1.0
    source.connect(this._gainNode)

    // Chain playback: start at the end of the previous chunk
    const startTime = Math.max(
      this._nextStartTime,
      this._audioContext.currentTime
    )
    source.start(startTime)
    this._nextStartTime = startTime + audioBuffer.duration

    this._activeSources.push(source)
    source.onended = () => {
      source.disconnect()
      const idx = this._activeSources.indexOf(source)
      if (idx >= 0) this._activeSources.splice(idx, 1)
    }
  }

  private async _waitForPlaybackEnd(): Promise<void> {
    const waitTime = this._nextStartTime - this._audioContext.currentTime
    if (waitTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitTime * 1000 + 50))
    }
  }

  private _cleanup(): void {
    this._activeSources = []
    this._pendingBuffer = new Uint8Array(0)
  }
}
