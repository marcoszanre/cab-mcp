// ============================================
// Agent Service Container
// Per-agent-instance runtime holding all services
// ============================================

import { AcsCallService } from '@/services/acsService'
import { MeetingChatService } from '@/services/chatService'
import { TextToSpeechService } from '@/services/ttsService'
import { CallAnalyticsService } from '@/services/analyticsService'
import { CaptionAggregationService } from '@/services/captionAggregationService'
import { type IAudioBridge, createAudioBridge } from '@/services/audioBridge'
import { AgentMeetingOrchestrator } from '@/services/agentMeetingOrchestrator'
import { IdleTimeoutService } from '@/services/idleTimeoutService'
import { clearTokenCacheForIdentity } from '@/services/tokenService'
import { useSessionStore } from '@/stores/sessionStore'
import { loggers } from '@/lib/logger'

const log = loggers.app

/**
 * AgentServiceContainer bundles all per-agent services.
 *
 * Each agent instance (one ACS identity in one meeting) gets its own container.
 * The container owns the lifecycle of all services — create on join, dispose on leave.
 *
 * Services are created lazily (on first access) but the container itself
 * is created eagerly when an agent is added to a session.
 */
export class AgentServiceContainer {
  /** Unique ID matching the AgentInstance in sessionStore */
  public readonly agentInstanceId: string
  /** Session this container belongs to */
  public readonly sessionId: string
  /** Agent display name */
  public readonly agentName: string
  /** Agent config ID */
  public readonly agentConfigId: string

  // ── Services (created eagerly since they're always needed) ──
  private _acsService: AcsCallService
  private _chatService: MeetingChatService
  private _ttsService: TextToSpeechService
  private _analyticsService: CallAnalyticsService
  private _captionAggregation: CaptionAggregationService
  private _audioBridge: IAudioBridge
  private _orchestrator: AgentMeetingOrchestrator
  private _idleTimeout: IdleTimeoutService

  private _isDisposed = false

  // ACS credentials for this session (set after token generation)
  private _acsToken: string | null = null
  private _acsUserId: string | null = null

  // In-memory chat messages for this session (persists across tab switches)
  private _chatMessages: import('@/services/chatService').MeetingChatMessage[] = []
  private _chatConnected = false

  constructor(params: {
    agentInstanceId: string
    sessionId: string
    agentName: string
    agentConfigId: string
  }) {
    this.agentInstanceId = params.agentInstanceId
    this.sessionId = params.sessionId
    this.agentName = params.agentName
    this.agentConfigId = params.agentConfigId

    // Create isolated service instances
    this._audioBridge = createAudioBridge()
    this._acsService = new AcsCallService()
    this._chatService = new MeetingChatService()
    this._ttsService = new TextToSpeechService()
    this._analyticsService = new CallAnalyticsService()
    this._captionAggregation = new CaptionAggregationService()
    this._orchestrator = new AgentMeetingOrchestrator(this)
    this._idleTimeout = new IdleTimeoutService(
      this.agentInstanceId.slice(0, 8),
    )

    // Link TTS to this container's ACS instance for per-session audio isolation
    this._ttsService.setAcsService(this._acsService)

    // Wire AudioBridge speaking state → ACS video particle animation (per-agent isolation)
    this._audioBridge.onSpeakingChanged((speaking) => {
      this._acsService.setSpeaking(speaking)
    })

    // Wire orchestrator processing state → ACS video "processing" visualization
    this._orchestrator.on((event) => {
      if (event.type === 'processing-changed' && event.data) {
        if (event.data.isProcessing) {
          this._acsService.setVideoState('processing')
        }
        // Don't reset to idle here — the speaking state will take over,
        // or the speaking-finished callback will set it back to idle
      }
    })

    // ── Safety-net ACS state listeners ──
    // These survive cleanup() and ensure session store stays in sync
    // even if the call drops unexpectedly or dispose races occur.
    this._acsService.onCallDisconnected(() => {
      if (this._isDisposed) return
      const store = useSessionStore.getState()
      const session = store.getSession(this.sessionId)
      if (session && session.state !== 'disconnected') {
        log.info(`[Container:${this.agentInstanceId.slice(0, 8)}] ACS call disconnected — updating session state`)
        store.updateAgentConnectionStatus(this.sessionId, this.agentInstanceId, 'disconnected')
        store.updateAgentCallState(this.sessionId, this.agentInstanceId, { isInCall: false })
        // If all agents in this session are now disconnected, mark session as disconnected
        const updatedSession = store.getSession(this.sessionId)
        if (updatedSession) {
          const allDisconnected = Object.values(updatedSession.agents).every(
            a => a.connectionStatus === 'disconnected'
          )
          if (allDisconnected) {
            store.updateSessionState(this.sessionId, 'disconnected')
          }
        }
      }
    })

    this._acsService.onCallConnected(() => {
      if (this._isDisposed) return
      const store = useSessionStore.getState()
      const session = store.getSession(this.sessionId)
      if (session && session.state !== 'connected') {
        log.info(`[Container:${this.agentInstanceId.slice(0, 8)}] ACS call connected — updating session state`)
        store.updateSessionState(this.sessionId, 'connected')
      }
    })

    log.info(
      `[Container:${this.agentInstanceId.slice(0, 8)}] Created for agent "${this.agentName}" in session ${this.sessionId.slice(0, 8)}`
    )
  }

  // ── Service accessors ──

  get acsService(): AcsCallService {
    this._assertNotDisposed()
    return this._acsService
  }

  get chatService(): MeetingChatService {
    this._assertNotDisposed()
    return this._chatService
  }

  get ttsService(): TextToSpeechService {
    this._assertNotDisposed()
    return this._ttsService
  }

  get analyticsService(): CallAnalyticsService {
    this._assertNotDisposed()
    return this._analyticsService
  }

  get captionAggregation(): CaptionAggregationService {
    this._assertNotDisposed()
    return this._captionAggregation
  }

  get audioBridge(): IAudioBridge {
    this._assertNotDisposed()
    return this._audioBridge
  }

  get orchestrator(): AgentMeetingOrchestrator {
    this._assertNotDisposed()
    return this._orchestrator
  }

  get idleTimeout(): IdleTimeoutService {
    this._assertNotDisposed()
    return this._idleTimeout
  }

  get isDisposed(): boolean {
    return this._isDisposed
  }

  /** Store the ACS token + userId generated for this session */
  setCredentials(token: string, userId: string): void {
    this._acsToken = token
    this._acsUserId = userId
  }

  get acsToken(): string | null { return this._acsToken }
  get acsUserId(): string | null { return this._acsUserId }

  /** In-memory chat messages — survives tab switches */
  get chatMessages(): import('@/services/chatService').MeetingChatMessage[] { return this._chatMessages }
  get isChatConnected(): boolean { return this._chatConnected }

  addChatMessage(msg: import('@/services/chatService').MeetingChatMessage): void {
    this._chatMessages.push(msg)
  }
  setChatConnected(connected: boolean): void {
    this._chatConnected = connected
  }

  // ── Lifecycle ──

  /**
   * Dispose all services in this container.
   * Called when the agent leaves the meeting or the session ends.
   * Order matters: hang up call first, then tear down services.
   */
  async dispose(): Promise<void> {
    if (this._isDisposed) return
    this._isDisposed = true

    const id = this.agentInstanceId.slice(0, 8)
    log.info(`[Container:${id}] Disposing...`)

    // 0. Stop orchestrator first
    try {
      this._orchestrator.dispose()
    } catch (err) {
      log.warn(`[Container:${id}] Orchestrator dispose error: ${err}`)
    }

    // 0b. Stop idle timeout monitoring
    try {
      this._idleTimeout.dispose()
    } catch (err) {
      log.warn(`[Container:${id}] IdleTimeout dispose error: ${err}`)
    }

    // 0c. Wait for in-progress TTS to finish (graceful leave)
    try {
      if (this._ttsService.isSpeaking()) {
        log.info(`[Container:${id}] Waiting for TTS to finish before leaving...`)
        await this._ttsService.waitForCompletion(15000)
        log.info(`[Container:${id}] TTS finished, proceeding with leave`)
      }
    } catch (err) {
      log.warn(`[Container:${id}] TTS wait error: ${err}`)
    }

    // 1. Leave the call if still active
    try {
      if (this._acsService.isInCall()) {
        await this._acsService.leaveCall()
      }
    } catch (err) {
      log.warn(`[Container:${id}] ACS leaveCall error during dispose: ${err}`)
    }

    // 2. Disconnect chat
    try {
      await this._chatService.dispose()
    } catch (err) {
      log.warn(`[Container:${id}] Chat dispose error: ${err}`)
    }

    // 3. Stop TTS
    try {
      this._ttsService.dispose()
    } catch (err) {
      log.warn(`[Container:${id}] TTS dispose error: ${err}`)
    }

    // 4. Dispose analytics (no async cleanup needed)
    // analyticsService has no dispose() — it's pure data, GC handles it

    // 5. Dispose caption aggregation
    try {
      this._captionAggregation.dispose()
    } catch (err) {
      log.warn(`[Container:${id}] CaptionAggregation dispose error: ${err}`)
    }

    // 6. Dispose ACS service (disposes CallAgent)
    try {
      await this._acsService.dispose()
    } catch (err) {
      log.warn(`[Container:${id}] ACS dispose error: ${err}`)
    }

    // 7. Dispose audio bridge last (after ACS is done with the stream)
    try {
      this._audioBridge.dispose()
    } catch (err) {
      log.warn(`[Container:${id}] AudioBridge dispose error: ${err}`)
    }

    clearTokenCacheForIdentity(this.agentInstanceId)
    this._acsToken = null
    this._acsUserId = null
    this._chatMessages = []

    log.info(`[Container:${id}] Disposed successfully`)
  }

  // ── Private helpers ──

  private _assertNotDisposed(): void {
    if (this._isDisposed) {
      log.warn(
        `[Container:${this.agentInstanceId.slice(0, 8)}] Accessed after disposal — returning stale reference`
      )
    }
  }
}
