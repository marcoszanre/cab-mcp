// ACS Call Service
// Manages Azure Communication Services calls with Teams meetings

import type { CallAgent, Call, CallClient } from '@azure/communication-calling'
import type { Caption, Participant } from '@/types'
import { renderRingsFrame } from '@/lib/videoRenderer'

type CallingSdkModule = typeof import('@azure/communication-calling')
type CommonSdkModule = typeof import('@azure/communication-common')

// Types
type CallState = 'None' | 'Connecting' | 'Ringing' | 'Connected' | 'LocalHold' | 'RemoteHold' | 'InLobby' | 'Disconnecting' | 'Disconnected'

interface CallEndReason {
  code: number
  subCode: number
}

interface CaptionData {
  speaker?: { displayName?: string }
  captionText?: string
  spokenText?: string
  resultType?: string
  spokenLanguage?: string
}

type CallEventHandler = (...args: unknown[]) => void
type EventfulCall = Call & {
  off?: (event: string, listener: CallEventHandler) => void
}

const ACS_RUNTIME_ASSET_URL = `${import.meta.env.BASE_URL}assets/acs-calling-runtime.js`
const ACS_RUNTIME_SCRIPT_SELECTOR = 'script[data-cab-acs-runtime="true"]'

async function loadBundledCallingSdk(): Promise<CallingSdkModule> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('ACS calling runtime can only load in a browser environment')
  }

  if (window.cabAcsCallingRuntime) {
    return window.cabAcsCallingRuntime
  }

  window.cabAcsCallingRuntimePromise ??= new Promise<CallingSdkModule>((resolve, reject) => {
    const resolveRuntime = () => {
      const runtime = window.cabAcsCallingRuntime
      if (runtime) {
        resolve(runtime)
        return
      }

      window.cabAcsCallingRuntimePromise = null
      reject(new Error('ACS runtime loaded without exposing the calling SDK global'))
    }

    const rejectRuntime = () => {
      window.cabAcsCallingRuntimePromise = null
      reject(new Error('Failed to load the ACS calling runtime asset'))
    }

    const existingScript = document.querySelector<HTMLScriptElement>(ACS_RUNTIME_SCRIPT_SELECTOR)
    if (existingScript) {
      if (window.cabAcsCallingRuntime) {
        resolveRuntime()
        return
      }

      existingScript.addEventListener('load', resolveRuntime, { once: true })
      existingScript.addEventListener('error', rejectRuntime, { once: true })
      return
    }

    const script = document.createElement('script')
    script.async = true
    script.dataset.cabAcsRuntime = 'true'
    script.src = ACS_RUNTIME_ASSET_URL
    script.addEventListener('load', resolveRuntime, { once: true })
    script.addEventListener('error', rejectRuntime, { once: true })
    document.head.appendChild(script)
  })

  return window.cabAcsCallingRuntimePromise
}

const loadCallingSdk = import.meta.env.PROD
  ? loadBundledCallingSdk
  : () => import('@azure/communication-calling')

// Global audio context for TTS injection
declare global {
  interface Window {
    ttsAudioContext: AudioContext | null
    ttsGainNode: GainNode | null
    ttsDestination: MediaStreamAudioDestinationNode | null
    agentVideoPreviewCanvas?: HTMLCanvasElement
    agentVideoPreviewStream?: MediaStream
    cabAcsCallingRuntime?: CallingSdkModule
    cabAcsCallingRuntimePromise?: Promise<CallingSdkModule> | null
  }
}

/**
 * ACS Call Service - Manages Teams meeting connections
 */
export class AcsCallService {
  private callClient: CallClient | null = null
  private callAgent: CallAgent | null = null
  private currentCall: Call | null = null
  private _teamsCaptions: unknown = null
  private callStateCheckInterval: ReturnType<typeof setInterval> | null = null
  private lastKnownState: CallState = 'None'
  private _spokenLanguage: string = 'en-us'
  
  // Callbacks
  public onStateChanged: ((state: CallState) => void) | null = null
  public onMuteChanged: ((muted: boolean) => void) | null = null
  public onCaptionReceived: ((caption: Caption) => void) | null = null
  public onParticipantAdded: ((participant: Participant) => void) | null = null
  public onParticipantRemoved: ((id: string) => void) | null = null
  public onCallEnded: ((reason: CallEndReason | null) => void) | null = null
  public onVideoStreamCreated: ((stream: MediaStream) => void) | null = null
  public onChatThreadReady: ((threadId: string) => void) | null = null
  
  // Safety-net callbacks — NOT cleared by cleanup() so they survive the
  // normal teardown sequence and act as a reliable signal for containers.
  private _onCallDisconnected?: () => void
  private _onCallConnected?: () => void

  // Join mutex to prevent double-join race conditions
  private _joinInProgress: Promise<void> | null = null
  
  // Video animation interval ID for cleanup
  private _videoIntervalId: ReturnType<typeof setInterval> | null = null
  private _chatThreadReadyTimer: ReturnType<typeof setTimeout> | null = null
  private _pendingJoinWaitReject: ((error: Error) => void) | null = null
  
  // Track initialization state
  private _isInitialized = false
  private _lastDisplayName: string | null = null
  private _callingSdkPromise: Promise<CallingSdkModule> | null = null
  private _commonSdkPromise: Promise<CommonSdkModule> | null = null

  // Per-instance TTS audio context (replaces window.* globals for multi-session isolation)
  private _ttsAudioContext: AudioContext | null = null
  private _ttsGainNode: GainNode | null = null
  private _ttsDestination: MediaStreamAudioDestinationNode | null = null

  // Per-instance speaking callback for the video ring animation
  private _speakingCallback: ((speaking: boolean) => void) | null = null

  // 3-state video system: idle → processing → speaking
  private _videoState: 'idle' | 'processing' | 'speaking' = 'idle'
  private _videoStateIntensity: number = 0
  private _processingIntensity: number = 0

  /**
   * Register a per-instance callback to drive the video ring animation.
   * Called by AgentServiceContainer to wire AudioBridge → video canvas.
   */
  onSpeakingChanged(callback: (speaking: boolean) => void): void {
    this._speakingCallback = callback
  }

  /**
   * Register a safety-net callback that fires when the ACS call reaches 'Disconnected'.
   * Unlike the public `onCallEnded` callback, this is NOT cleared by cleanup()
   * so it reliably fires even during teardown.
   */
  onCallDisconnected(callback: () => void): void {
    this._onCallDisconnected = callback
  }

  /**
   * Register a safety-net callback that fires when the ACS call reaches 'Connected'.
   * Unlike the public `onStateChanged` callback, this is NOT cleared by cleanup().
   */
  onCallConnected(callback: () => void): void {
    this._onCallConnected = callback
  }

  /**
   * Set the video state for the ring visualization.
   * Supports 3 states: idle, processing (thinking), speaking.
   */
  setVideoState(state: 'idle' | 'processing' | 'speaking'): void {
    this._videoState = state
  }

  /**
   * Signal that the agent is speaking (drives the ring animation).
   * Also updates video state for backward compatibility.
   */
  setSpeaking(speaking: boolean): void {
    this._videoState = speaking ? 'speaking' : 'idle'
    this._speakingCallback?.(speaking)
  }

  /** TTS AudioContext for this ACS instance (call-injected audio) */
  get ttsAudioContext(): AudioContext | null { return this._ttsAudioContext }
  /** TTS GainNode for this ACS instance */
  get ttsGainNode(): GainNode | null { return this._ttsGainNode }
  /** TTS MediaStreamDestination for this ACS instance */
  get ttsDestination(): MediaStreamAudioDestinationNode | null { return this._ttsDestination }
  
  // Check if initialized
  get isInitializedForAgent(): string | null {
    return this._isInitialized ? this._lastDisplayName : null
  }

  private async _getCallingSdk(): Promise<CallingSdkModule> {
    this._callingSdkPromise ??= loadCallingSdk()
    return this._callingSdkPromise
  }

  private async _getCommonSdk(): Promise<CommonSdkModule> {
    this._commonSdkPromise ??= import('@azure/communication-common')
    return this._commonSdkPromise
  }

  /**
   * Initialize the ACS client with credentials
   */
  async initialize(token: string, displayName: string): Promise<void> {
    console.log('Initializing ACS CallClient...')
    
    // Guard against hung initialization by adding a timeout
    const initWithTimeout = async <T>(promise: Promise<T>, ms: number, step: string): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${step} timed out after ${ms}ms`)), ms))
      ])
    }

    try {
      const [{ CallClient }, { AzureCommunicationTokenCredential }] = await Promise.all([
        this._getCallingSdk(),
        this._getCommonSdk(),
      ])

      this.callClient = new CallClient()
      const tokenCredential = new AzureCommunicationTokenCredential(token)
      
      console.log('Creating CallAgent...')
      this.callAgent = await initWithTimeout(
        this.callClient.createCallAgent(tokenCredential, { displayName }),
        20000,
        'CallAgent creation'
      )
      
      this._isInitialized = true
      this._lastDisplayName = displayName
      
      console.log(`CallAgent created for: ${displayName}`)
      
      // Set up call agent event handlers
      this.callAgent.on('callsUpdated', (e) => {
        console.log(`Calls updated: ${e.added.length} added, ${e.removed.length} removed`)
      })

      this.callAgent.on('incomingCall', async (e) => {
        console.log('Incoming call received!')
        const incomingCall = e.incomingCall
        // Auto-accept for agent mode
        this.currentCall = await incomingCall.accept()
        await this.setupCallHandlers()
      })
    } catch (error) {
      this._isInitialized = false
      this._lastDisplayName = null
      this.callAgent = null
      this.callClient = null
      const message = error instanceof Error ? error.message : 'Unknown error during ACS initialization'
      console.error('ACS initialize failed:', message)
      throw new Error(`ACS initialize failed: ${message}`)
    }
  }

  /**
   * Join a Teams meeting
   */
  async joinMeeting(meetingUrl: string): Promise<void> {
    if (!this.callAgent) {
      throw new Error('Call agent not initialized')
    }
    
    // Prevent duplicate join attempts with mutex
    if (this.currentCall) {
      console.log('Already in a call or joining, ignoring duplicate join request')
      return
    }
    if (this._joinInProgress) {
      console.log('Join already in progress (mutex), waiting for it to complete')
      await this._joinInProgress
      return
    }

    // Wrap the join in a mutex promise
    let resolveMutex: () => void
    this._joinInProgress = new Promise<void>((resolve) => { resolveMutex = resolve })

    try {
      await this._doJoinMeeting(meetingUrl)
    } finally {
      this._joinInProgress = null
      resolveMutex!()
    }
  }

  private async _doJoinMeeting(meetingUrl: string): Promise<void> {
    console.log(`Joining Teams meeting: ${meetingUrl}`)

    const callingSdk = await this._getCallingSdk()
    
    // Create TTS audio stream for speech injection
    const audioMediaStream = this.createTtsAudioStream()
    const videoMediaStream = this.createVideoStream()
    
    // Resume audio context if needed
    if (this._ttsAudioContext?.state === 'suspended') {
      console.log('Resuming TTS audio context...')
      await this._ttsAudioContext.resume()
    }
    
    const localAudioStream = new callingSdk.LocalAudioStream(audioMediaStream)
    const localVideoStream = new callingSdk.LocalVideoStream(videoMediaStream)
    
    console.log('Audio and video streams created')
    
    const callOptions = {
      audioOptions: {
        muted: true,
        localAudioStreams: [localAudioStream]
      },
      videoOptions: {
        localVideoStreams: [localVideoStream]
      }
    }
    
    // Join the meeting with a timeout to prevent hanging forever
    const JOIN_TIMEOUT_MS = 30000
    
    if (meetingUrl.includes('teams.microsoft.com')) {
      this.currentCall = this.callAgent!.join({ meetingLink: meetingUrl }, callOptions)
    } else {
      this.currentCall = this.callAgent!.startCall(
        [{ communicationUserId: meetingUrl }],
        callOptions
      )
    }
    
    console.log('Call object created, setting up handlers...')
    await this.setupCallHandlers()
    
    // Wait for the call to leave 'None' state or timeout
    await new Promise<void>((resolve, reject) => {
      const call = this.currentCall as EventfulCall | null
      if (!call) {
        reject(new Error('Call was cleaned up before join could complete'))
        return
      }

      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        this._pendingJoinWaitReject = null
        call.off?.('stateChanged', checkState)
        reject(new Error(`Join timed out after ${JOIN_TIMEOUT_MS / 1000}s — call never progressed from initial state`))
      }, JOIN_TIMEOUT_MS)

      const checkState = () => {
        const state = call.state as CallState | undefined
        if (!state || state === 'None') return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this._pendingJoinWaitReject = null
        call.off?.('stateChanged', checkState)
        resolve()
      }

      this._pendingJoinWaitReject = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this._pendingJoinWaitReject = null
        call.off?.('stateChanged', checkState)
        reject(error)
      }

      // Check immediately in case state already changed
      checkState()
      // Also listen for state changes
      call.on('stateChanged', checkState)
    })
  }

  /**
   * Create TTS audio stream for speech injection into call
   */
  private createTtsAudioStream(): MediaStream {
    const context = new AudioContext()
    const dest = context.createMediaStreamDestination()
    
    const gainNode = context.createGain()
    gainNode.gain.value = 0 // Start silent
    gainNode.connect(dest)
    
    // Store on instance for per-session isolation (TTS service reads via accessor)
    this._ttsAudioContext = context
    this._ttsGainNode = gainNode
    this._ttsDestination = dest

    // Also set window globals for backward compat with legacy single-session path
    window.ttsAudioContext = context
    window.ttsGainNode = gainNode
    window.ttsDestination = dest
    
    console.log('TTS Audio stream created with context:', context.state)
    return dest.stream
  }

  /**
   * Create animated video stream - Perplexity-style particle sphere visualization.
   * Pre-renders 3 state snapshots (idle, processing, speaking) and uses cheap
   * drawImage() crossfading instead of per-frame particle rendering.
   */
  private createVideoStream(): MediaStream {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    canvas.width = 1280
    canvas.height = 720

    const W = 1280
    const H = 720
    const startTime = performance.now()

    // Lightweight crossfade animation loop using concentric-rings renderer
    this._videoIntervalId = setInterval(() => {
      // Smooth transitions toward target state
      const targetSpeaking = this._videoState === 'speaking' ? 1 : 0
      const targetProcessing = this._videoState === 'processing' ? 1 : 0
      this._videoStateIntensity += (targetSpeaking - this._videoStateIntensity) * 0.08
      this._processingIntensity += (targetProcessing - this._processingIntensity) * 0.08

      renderRingsFrame({
        ctx, w: W, h: H,
        time: (performance.now() - startTime) / 1000,
        processingIntensity: this._processingIntensity,
        speakingIntensity: this._videoStateIntensity,
      })
    }, 1000 / 30)

    const stream = canvas.captureStream(30)
    window.agentVideoPreviewCanvas = canvas
    window.agentVideoPreviewStream = stream
    this.onVideoStreamCreated?.(stream)

    return stream
  }

  /**
   * Set up event handlers for the current call
   */
  private async setupCallHandlers(): Promise<void> {
    if (!this.currentCall) return
    
    // Mute state changes
    this.currentCall.on('isMutedChanged', () => {
      const muted = this.currentCall?.isMuted
      if (muted === undefined) return // Call was cleaned up concurrently
      console.log('Mute state changed:', muted)
      this.onMuteChanged?.(muted)
    })
    
    // Call state changes
    this.currentCall.on('stateChanged', async () => {
      const call = this.currentCall
      if (!call) return // Call was cleaned up concurrently
      const state = call.state as CallState
      console.log('Call state changed:', state)
      this.lastKnownState = state
      this.onStateChanged?.(state)
      
      if (state === 'Connected') {
        console.log('Call connected, setting up captions...')
        this._onCallConnected?.()
        // Mute all incoming audio — we only process closed captions, not audio.
        // This prevents echo when the bridge runs on the same machine as the meeting.
        try {
          await call.muteIncomingAudio()
          console.log('Incoming audio muted — processing captions only')
        } catch (err) {
          console.warn('Failed to mute incoming audio:', err)
        }
        await this.setupCaptions()
        // Start state monitoring as backup
        this.startStateMonitoring()
        // Delay chat thread notification to give Teams time to associate the
        // ACS user with the meeting chat thread. Without this delay, the agent
        // appears as "temporarily joined" and typing indicators may fail.
        if (this._chatThreadReadyTimer) {
          clearTimeout(this._chatThreadReadyTimer)
        }
        this._chatThreadReadyTimer = setTimeout(() => {
          this._chatThreadReadyTimer = null
          if (this.currentCall?.state === 'Connected') {
            this.notifyChatThreadReady()
          }
        }, 3000)
      } else if (state === 'Disconnected' || state === 'Disconnecting') {
        const reason = call.callEndReason as CallEndReason | undefined
        console.log('Call disconnected/disconnecting:', state, reason)
        
        // Log specific end reasons for debugging
        if (reason) {
          // Common reason codes:
          // 0 = Normal hangup
          // 487 = Call canceled
          // 603 = Declined
          // 410/480 = Meeting ended for everyone (varies by scenario)
          console.log(`Call end reason: code=${reason.code}, subCode=${reason.subCode}`)
        }
        
        if (state === 'Disconnected') {
          this._onCallDisconnected?.()
          this.onCallEnded?.(reason || null)
          this.cleanup()
        }
      }
    })
    
    // Remote participants
    this.currentCall.on('remoteParticipantsUpdated', (e) => {
      console.log(`Participants: +${e.added.length} -${e.removed.length}`)
      e.added.forEach((participant) => {
        this.onParticipantAdded?.({
          id: (participant as unknown as { identifier: { communicationUserId: string } }).identifier?.communicationUserId || crypto.randomUUID(),
          displayName: participant.displayName || 'Unknown',
          isMuted: participant.isMuted,
          isSpeaking: (participant as unknown as { isSpeaking: boolean }).isSpeaking || false
        })
      })
      e.removed.forEach((participant) => {
        this.onParticipantRemoved?.((participant as unknown as { identifier: { communicationUserId: string } }).identifier?.communicationUserId || '')
      })
    })
  }

  /**
   * Start monitoring call state as a backup to catch missed disconnection events
   */
  private startStateMonitoring(): void {
    // Clear any existing interval
    if (this.callStateCheckInterval) {
      clearInterval(this.callStateCheckInterval)
    }
    
    // Check call state every 2 seconds as backup
    this.callStateCheckInterval = setInterval(() => {
      const call = this.currentCall
      if (!call) {
        console.log('[StateMonitor] No current call, stopping monitor')
        this.stopStateMonitoring()
        return
      }
      
      const currentState = call.state as CallState
      
      // If we detect a state change that wasn't caught by the event
      if (currentState !== this.lastKnownState) {
        console.log(`[StateMonitor] State changed: ${this.lastKnownState} -> ${currentState}`)
        this.lastKnownState = currentState
        this.onStateChanged?.(currentState)
        
        if (currentState === 'Disconnected') {
          const reason = call.callEndReason as CallEndReason | undefined
          console.log('[StateMonitor] Call disconnected, triggering cleanup', reason)
          this.onCallEnded?.(reason || null)
          this.cleanup()
        }
      }
    }, 2000)
  }

  /**
   * Stop state monitoring
   */
  private stopStateMonitoring(): void {
    if (this.callStateCheckInterval) {
      clearInterval(this.callStateCheckInterval)
      this.callStateCheckInterval = null
    }
  }

  /**
   * Notify when chat thread is ready (for Teams meeting chat interop)
   */
  private notifyChatThreadReady(): void {
    const threadId = this.getThreadId()
    if (threadId && this.onChatThreadReady) {
      console.log('Chat thread ready:', threadId.substring(0, 30) + '...')
      this.onChatThreadReady(threadId)
    } else if (!threadId) {
      console.log('No chat thread ID available (not a Teams meeting?)')
    }
  }

  /**
   * Get the chat thread ID for the current Teams meeting
   * This is available after joining a Teams meeting
   */
  getThreadId(): string | null {
    if (!this.currentCall) {
      return null
    }
    // The threadId is available from call.info for Teams meetings
    const callInfo = this.currentCall.info as { threadId?: string } | undefined
    return callInfo?.threadId || null
  }

  /**
   * Set the spoken language for captions.
   * Must be called before joining the call (used at caption start time).
   */
  setSpokenLanguage(lang: string): void {
    this._spokenLanguage = lang.toLowerCase()
  }

  /**
   * Set up closed captions
   */
  private async setupCaptions(): Promise<void> {
    if (!this.currentCall) return
    
    try {
      console.log('Setting up closed captions...')

      const callingSdk = await this._getCallingSdk()
      
      const captionsFeature = this.currentCall.feature(callingSdk.Features.Captions)
      const captions = captionsFeature.captions as unknown as {
        kind: string
        isCaptionsFeatureActive: boolean
        startCaptions: (options: { spokenLanguage: string }) => Promise<void>
        on: (event: string, callback: (data: CaptionData) => void) => void
      }
      
      if (captions.kind === 'TeamsCaptions') {
        this._teamsCaptions = captions
        console.log('TeamsCaptions feature available')
        
        // Subscribe to caption events
        captions.on('CaptionsReceived', (data: CaptionData) => {
          if (data.resultType === 'Final' && (data.captionText || data.spokenText)) {
            const caption: Caption = {
              id: crypto.randomUUID(),
              speaker: data.speaker?.displayName || 'Unknown',
              text: data.captionText || data.spokenText || '',
              timestamp: new Date(),
              isFinal: true,
              spokenLanguage: data.spokenLanguage || this._spokenLanguage,
            }
            this.onCaptionReceived?.(caption)
          }
        })
        
        // Start captions
        if (!captions.isCaptionsFeatureActive) {
          await captions.startCaptions({ spokenLanguage: this._spokenLanguage })
          console.log(`Captions started with spoken language: ${this._spokenLanguage}`)
        } else {
          console.log('Captions already active')
        }
      }
    } catch (error) {
      console.error('Failed to setup captions:', error)
    }
  }

  /**
   * Toggle mute state
   */
  async toggleMute(): Promise<boolean> {
    if (!this.currentCall) {
      throw new Error('No active call')
    }
    
    const currentMute = this.currentCall.isMuted
    
    if (currentMute) {
      await this.currentCall.unmute()
    } else {
      await this.currentCall.mute()
    }
    
    return !currentMute
  }

  /**
   * Unmute outgoing audio (used by TTS before speaking)
   */
  async unmute(): Promise<void> {
    if (this.currentCall) {
      await this.currentCall.unmute()
    }
  }

  /**
   * Mute outgoing audio (used by TTS after speaking)
   */
  async mute(): Promise<void> {
    if (this.currentCall) {
      await this.currentCall.mute()
    }
  }

  /**
   * Leave the current call
   */
  async leaveCall(): Promise<void> {
    if (this.currentCall) {
      await this.currentCall.hangUp()
      console.log('Call ended by user')
    }
  }

  /**
   * Get current mute state
   */
  isMuted(): boolean {
    return this.currentCall?.isMuted ?? false
  }

  /**
   * Get current call state
   */
  getState(): CallState {
    return (this.currentCall?.state as CallState) ?? 'None'
  }

  /**
   * Check if captions are active
   */
  areCaptionsActive(): boolean {
    return this._teamsCaptions !== null
  }

  /**
   * Check if in a call
   */
  isInCall(): boolean {
    return this.currentCall !== null && this.currentCall.state === 'Connected'
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    // Stop state monitoring
    this.stopStateMonitoring()
    const pendingJoinWaitReject = this._pendingJoinWaitReject
    this._pendingJoinWaitReject = null
    if (pendingJoinWaitReject) {
      pendingJoinWaitReject(new Error('Join aborted during ACS cleanup'))
    }
    if (this._chatThreadReadyTimer) {
      clearTimeout(this._chatThreadReadyTimer)
      this._chatThreadReadyTimer = null
    }
    
    this.currentCall = null
    this._teamsCaptions = null
    this.lastKnownState = 'None'
    this._joinInProgress = null
    this._videoState = 'idle'
    this._videoStateIntensity = 0
    this._processingIntensity = 0
    this._speakingCallback = null
    
    // Clear video animation interval to prevent CPU/memory leak
    if (this._videoIntervalId) {
      clearInterval(this._videoIntervalId)
      this._videoIntervalId = null
    }
    
    // Clean up per-instance audio context
    const ttsAudioContext = this._ttsAudioContext
    if (ttsAudioContext) {
      try { ttsAudioContext.close() } catch { /* already closed */ }
    }
    this._ttsAudioContext = null
    this._ttsGainNode = null
    this._ttsDestination = null

    // Also clean window globals if they point to this instance's context
    if (window.ttsAudioContext === null || window.ttsAudioContext === ttsAudioContext) {
      window.ttsAudioContext = null
      window.ttsGainNode = null
      window.ttsDestination = null
    }
    
    // Null out callbacks to prevent stale closures from firing after cleanup
    this.onStateChanged = null
    this.onMuteChanged = null
    this.onCaptionReceived = null
    this.onParticipantAdded = null
    this.onParticipantRemoved = null
    this.onCallEnded = null
    this.onVideoStreamCreated = null
    this.onChatThreadReady = null
  }

  /**
   * Dispose of the service
   */
  async dispose(): Promise<void> {
    this.stopStateMonitoring()
    if (this.currentCall) {
      await this.currentCall.hangUp()
    }
    if (this.callAgent) {
      await this.callAgent.dispose()
    }
    this.cleanup()
    this.callClient = null
    this.callAgent = null
  }

  /**
   * Reset the ACS service for switching agents. Now properly async to ensure cleanup completes.
   */
  async reset(): Promise<void> {
    console.log('🔄 ACS Service reset called')
    this.stopStateMonitoring()
    
    // Hang up any current call first
    if (this.currentCall) {
      try {
        await this.currentCall.hangUp()
        console.log('🔄 Current call hung up')
      } catch (err) {
        console.warn('ACS hangUp during reset failed', err)
      }
      this.currentCall = null
    }
    
    // Dispose call agent
    if (this.callAgent) {
      try {
        await this.callAgent.dispose()
        console.log('🔄 Call agent disposed')
      } catch (err) {
        console.warn('ACS callAgent dispose during reset failed', err)
      }
      this.callAgent = null
    }
    
    this.cleanup()
    this.callClient = null
    this._isInitialized = false
    this._lastDisplayName = null
    console.log('🔄 ACS Service reset complete')
  }
}

// Singleton instance
let instance: AcsCallService | null = null

/**
 * @deprecated Use AgentServiceContainer's acsService instead for multi-session support.
 * This singleton is preserved for backward-compatible UI paths that haven't been migrated yet.
 */
export function getAcsCallService(): AcsCallService {
  if (!instance) {
    instance = new AcsCallService()
  }
  return instance
}
