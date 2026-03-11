// ============================================
// Agent Meeting Orchestrator
// The "brain" - handles all autonomous agent behavior during a meeting.
// Extracted from MeetingStage.tsx to enable headless (MCP-first) operation.
// ============================================

import type { AgentServiceContainer } from '@/services/agentServiceContainer'
import type { MeetingChatMessage } from '@/services/chatService'
import type { AggregatedCaption, MentionResult, PendingMention } from '@/services/captionAggregationService'
import { getIntentDetectionService } from '@/services/intentDetectionService'
import { extractMessageText } from '@/lib/utils'
import { buildDefaultWelcomeMessage } from '@/lib/welcomeMessage'
import { loggers } from '@/lib/logger'
import type { ResponseChannel, ProactiveConfig, ProactiveResponseChannel, GoodbyeChannel, ProactiveTurnTakingMode } from '@/types/behavior'
import type { IAgentProvider } from '@/types/agent-provider'
import type { WelcomeMessageConfig } from '@/types'
import type { MeetingAgentConfig } from '@/hooks/useMeetingAgent'

const log = loggers.app

/** Agent responds once per silence period, then waits for a human to speak */
const MAX_CONSECUTIVE_PROACTIVE_ACTIONS = 1

// ── Types ──

export type LogLevel = 'info' | 'success' | 'warning' | 'error'

export interface OrchestratorConversationMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: Date
}

export interface OrchestratorSession {
  isActive: boolean
  speaker: string | null
  startedAt: Date | null
}

export interface OrchestratorState {
  isRunning: boolean
  isAgentConnected: boolean
  isAgentConnecting: boolean
  isProcessing: boolean
  session: OrchestratorSession
  conversationMessages: OrchestratorConversationMessage[]
  conversationId: string | null
  error: string | null
}

export type OrchestratorEventType =
  | 'log'
  | 'conversation-message'
  | 'session-changed'
  | 'processing-changed'
  | 'agent-state-changed'
  | 'state-changed'
  | 'leave-requested'

export interface OrchestratorEvent {
  type: OrchestratorEventType
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
}

type OrchestratorListener = (event: OrchestratorEvent) => void
type SpeechResponseSource = 'reactive' | 'proactive'

// ── Helper ──

function isErrorResponse(text: string): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  const patterns = [
    'an error has occurred', 'error code:', 'error:', 'contentfiltered',
    'content filtered', 'conversation id:', 'failed to', 'exception:',
    'internal server error', 'rate limit', 'throttled', 'timeout',
    'service unavailable', 'bad request', 'unauthorized', 'forbidden', 'not found'
  ]
  return patterns.some(p => lower.includes(p))
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * AgentMeetingOrchestrator handles all autonomous agent behavior during a meeting:
 * - Caption mention detection & response
 * - Chat @mention detection & response
 * - Welcome message sending
 * - Response routing (chat/speech based on agent config)
 * - Conversation session lifecycle (start/timeout/end)
 *
 * This class has NO React dependencies. It operates on services from
 * the AgentServiceContainer and emits events for UI consumption.
 */
export class AgentMeetingOrchestrator {
  private _container: AgentServiceContainer
  private _agentProvider: IAgentProvider | null = null
  private _running = false
  private _disposed = false

  // ── Agent state ──
  private _isAgentConnected = false
  private _isAgentConnecting = false
  private _conversationId: string | null = null
  private _agentError: string | null = null

  // ── Config ──
  private _displayName = ''
  private _agentNameVariations: string[] = []
  private _ignoredSpeakers = new Set<string>()
  private _captionResponseAsChat = false
  private _openaiConfig: { endpoint: string; apiKey: string; deployment: string } | null = null
  private _speechConfig: { key: string; region: string; voiceName?: string; ttsStyle?: string; styleDegree?: number; speechRate?: number } | null = null

  // ── Session tracking ──
  private _session: OrchestratorSession = { isActive: false, speaker: null, startedAt: null }
  private _sessionTimeout: ReturnType<typeof setTimeout> | null = null
  private _sessionTimeoutMs = 120_000

  // ── Processing state ──
  private _isProcessing = false
  private _captionHistory: Array<{ speaker: string; text: string }> = []
  private _lastSentContextIndex = 0
  private _lastProcessedCaptionId: string | null = null
  private _lastProcessedChatMsgId: string | null = null
  private _welcomeMessageSent = false
  private _welcomeConfig: WelcomeMessageConfig | null = null

  // ── TTS interruption tracking ──
  private _currentSpeechResponse: string | null = null
  private _currentSpeechSource: SpeechResponseSource | null = null
  private _pendingHumanReplyDuringSpeech = false

  // ── One-off chat override ──
  private _lastAssistantResponse: string | null = null
  private _nextResponseChannelOverride: ResponseChannel | null = null

  // ── Proactive mode state ──
  private _proactiveConfig: ProactiveConfig | null = null
  private _lastCaptionTimestamp = 0
  private _silenceCheckInterval: ReturnType<typeof setInterval> | null = null
  private _consecutiveProactiveActions = 0
  private _proactiveEvaluating = false
  private _noActionCount = 0
  private _lastProactiveDiagLog = 0
  private _waitingForHumanResponse = false
  private _lastChatActivityTimestamp = 0
  private _recentCaptionTimestamps: number[] = []
  private _lastKnownLanguage: string | null = null

  // ── Conversation messages (in-memory, survives tab switches) ──
  private _conversationMessages: OrchestratorConversationMessage[] = []

  // ── Promise-based response notification (avoids polling delay) ──
  private _responseResolve: ((text: string | null) => void) | null = null

  // ── Event system ──
  private _listeners = new Set<OrchestratorListener>()

  constructor(container: AgentServiceContainer) {
    this._container = container
  }

  // ═══════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════

  /**
   * Start the orchestrator — initializes caption aggregation, intent detection,
   * and sets up all processing callbacks.
   */
  async start(params: {
    displayName: string
    captionResponseAsChat?: boolean
    agentConfig: MeetingAgentConfig
    openaiConfig?: { endpoint: string; apiKey: string; deployment: string }
    speechConfig?: { key: string; region: string; voiceName?: string; ttsStyle?: string; styleDegree?: number; speechRate?: number }
    proactiveConfig?: ProactiveConfig
    welcomeConfig?: WelcomeMessageConfig
  }): Promise<void> {
    if (this._running) return
    this._running = true
    this._displayName = params.displayName
    this._captionResponseAsChat = params.captionResponseAsChat ?? false
    this._openaiConfig = params.openaiConfig ?? null
    this._speechConfig = params.speechConfig ?? null
    this._agentNameVariations = this._buildNameVariations(params.displayName)
    this._proactiveConfig = params.proactiveConfig?.enabled ? params.proactiveConfig : null
    this._welcomeConfig = params.welcomeConfig ?? null

    const tag = this._tag()

    // 1. Initialize services on the container
    await this._initializeTts()
    this._initializeCaptionAggregation()
    this._initializeIntentDetection()

    // 2. Start analytics
    this._container.analyticsService.startCall()
    this._log('info', '📊 Call analytics started')

    // 3. Connect agent provider
    await this._connectAgent(params.agentConfig)

    // 4. Set up caption aggregation callbacks
    this._setupCaptionCallbacks()

    // 5. Start proactive mode if configured
    if (this._proactiveConfig) {
      this._startProactiveMode()
    }

    log.info(`${tag} Orchestrator started for "${params.displayName}"`)
    this._emit({ type: 'state-changed' })
  }

  /**
   * Stop the orchestrator — cleans up timers and callbacks.
   */
  stop(): void {
    if (!this._running) return
    this._running = false
    this._clearSessionTimeout()
    this._resolvePendingAssistantResponse(null)
    this._stopProactiveMode()

    // Disconnect agent
    if (this._agentProvider) {
      this._agentProvider.dispose().catch(err => {
        log.warn(`${this._tag()} Agent dispose error: ${err}`)
      })
      this._agentProvider = null
      this._isAgentConnected = false
      this._isAgentConnecting = false
    }

    log.info(`${this._tag()} Orchestrator stopped`)
    this._emit({ type: 'state-changed' })
  }

  /**
   * Process an incoming chat message. Called from the headless chat callback
   * in ConnectingStage or from MeetingStage's effect.
   */
  processChatMessage(msg: MeetingChatMessage): void {
    if (!this._running || this._disposed) return
    if (msg.id === this._lastProcessedChatMsgId || msg.isOwn) return
    this._lastProcessedChatMsgId = msg.id
    // Track chat activity for proactive auto channel resolution
    this._lastChatActivityTimestamp = Date.now()
    this._handleChatMention(msg)
  }

  /**
   * Process a new caption. Called from the headless caption callback.
   * Feeds into the container's CaptionAggregationService which
   * triggers mention detection callbacks.
   */
  processCaption(caption: { id: string; speaker: string; text: string; spokenLanguage?: string }): void {
    if (!this._running || this._disposed) return
    if (caption.id === this._lastProcessedCaptionId) return
    // Ignore own captions and captions from peer agents (avoids multi-agent loops)
    if (caption.speaker === this._displayName || this._ignoredSpeakers.has(caption.speaker)) {
      this._lastProcessedCaptionId = caption.id
      return
    }
    this._lastProcessedCaptionId = caption.id

    // Maintain full caption history for context
    this._captionHistory.push({ speaker: caption.speaker, text: caption.text })

    // Update timestamp for proactive silence detection
    const now = Date.now()
    const isFirstCaptionForProactive = this._proactiveConfig && this._lastCaptionTimestamp === 0
    this._lastCaptionTimestamp = now

    // Log when the first human caption arms the proactive silence timer
    if (isFirstCaptionForProactive) {
      this._log('info', `🎭 First human caption received from ${caption.speaker} — proactive silence timer now active`)
    }

    // Track caption arrival times for speaking-momentum detection
    this._recentCaptionTimestamps.push(now)
    // Prune entries older than 60 seconds
    const cutoff = now - 60_000
    this._recentCaptionTimestamps = this._recentCaptionTimestamps.filter(t => t >= cutoff)

    // Track dominant spoken language for TTS optimization
    if (caption.spokenLanguage) {
      this._lastKnownLanguage = caption.spokenLanguage
    }

    // Reset consecutive proactive actions and backoff when a human speaks
    this._consecutiveProactiveActions = 0
    this._noActionCount = 0
    this._waitingForHumanResponse = false

    // Interview-safe proactive mode keeps the floor once speech starts, but still
    // records overlapping captions so the agent can assess them after playback.
    if (this._container.ttsService.isSpeaking()) {
      if (this._shouldKeepSpeakingThroughHumanCaption()) {
        this._pendingHumanReplyDuringSpeech = true
        this._log('info', `Buffered ${caption.speaker} while proactive speech kept the floor`)
      } else {
        this._pendingHumanReplyDuringSpeech = false
        this._container.ttsService.stop()
        this._log('info', `Interrupted by ${caption.speaker}`)
        if (this._currentSpeechResponse) {
          const interrupted = this._currentSpeechResponse
          this._currentSpeechResponse = null
          this._currentSpeechSource = null
          this._sendChat(`💬 [Interrupted] ${interrupted}`).catch(() => {})
        }
      }
    }

    // Feed into aggregation (callbacks set in _setupCaptionCallbacks handle the rest)
    this._container.captionAggregation.addCaption({
      id: caption.id,
      speaker: caption.speaker,
      text: caption.text,
      timestamp: Date.now(),
      isFinal: true
    })
  }

  /**
   * Send a welcome message to the meeting chat.
   */
  async sendWelcomeMessage(): Promise<void> {
    if (this._welcomeMessageSent) return
    this._welcomeMessageSent = true

    const chatSvc = this._container.chatService
    if (!chatSvc || !chatSvc.isConnectedToChat()) {
      log.warn(`${this._tag()} Cannot send welcome — chat not connected`)
      return
    }

    const mode = this._welcomeConfig?.mode ?? 'default'

    try {
      let message: string

      if (mode === 'custom' && this._welcomeConfig?.staticMessage) {
        message = this._welcomeConfig.staticMessage
      } else if (mode === 'agent-triggered' && this._welcomeConfig?.triggerPrompt && this._agentProvider) {
        try {
          const response = await this._agentProvider.sendMessage(this._welcomeConfig.triggerPrompt)
          const agentText = response.messages
            ?.filter(m => m.role === 'assistant')
            .map(m => m.content)
            .join('\n')
          message = agentText || this._buildDefaultWelcome()
        } catch (agentErr) {
          this._log('warning', `Agent-triggered welcome failed, using default: ${agentErr}`)
          message = this._buildDefaultWelcome()
        }
      } else {
        message = this._buildDefaultWelcome()
      }

      await chatSvc.sendMessage(message)
      this._log('info', '📤 Welcome message sent to meeting chat')
    } catch (err) {
      this._log('error', `Failed to send welcome message: ${err}`)
    }
  }

  private _buildDefaultWelcome(): string {
    return buildDefaultWelcomeMessage(this._displayName)
  }

  /**
   * Operator sends a message to the meeting chat on behalf of the agent.
   */
  async sendOperatorChatMessage(text: string): Promise<boolean> {
    const disclaimer = `📝 *[Sent by operator on behalf of ${this._displayName}]*\n\n${text}`
    return this._sendChat(disclaimer)
  }

  /**
   * Send a message to the agent provider and get a response.
   * Used by MCP tools for headless agent interaction.
   */
  async sendToAgent(text: string, _speaker?: string): Promise<string | null> {
    if (!this._agentProvider || !this._isAgentConnected) return null

    try {
      const response = await this._agentProvider.sendMessage(text)
      let responseText: string | null = null
      if (response.messages) {
        for (const msg of response.messages) {
          if (msg.role === 'assistant' && msg.content) {
            responseText = msg.content
          }
        }
      }

      // If no immediate response, poll conversation messages
      if (!responseText) {
        responseText = await this._waitForAssistantResponse(15000)
      }

      return responseText
    } catch (err) {
      // Try once to recover conversation
      try {
        await this._agentProvider.startConversation()
        const response = await this._agentProvider.sendMessage(text)
        if (response.messages) {
          for (const msg of response.messages) {
            if (msg.role === 'assistant' && msg.content) return msg.content
          }
        }
      } catch {
        // ignore retry failure
      }
      this._log('error', `Failed to send to agent: ${err}`)
      return null
    }
  }

  // ── State accessors ──

  get state(): OrchestratorState {
    return {
      isRunning: this._running,
      isAgentConnected: this._isAgentConnected,
      isAgentConnecting: this._isAgentConnecting,
      isProcessing: this._isProcessing,
      session: { ...this._session },
      conversationMessages: [...this._conversationMessages],
      conversationId: this._conversationId,
      error: this._agentError
    }
  }

  get isRunning(): boolean { return this._running }
  get isAgentConnected(): boolean { return this._isAgentConnected }
  get displayName(): string { return this._displayName }
  get welcomeMessageSent(): boolean { return this._welcomeMessageSent }
  set welcomeMessageSent(v: boolean) { this._welcomeMessageSent = v }

  /**
   * Register speaker names to ignore in captions (peer agents in the same meeting).
   * Prevents multi-agent conversation loops where agents respond to each other.
   */
  addIgnoredSpeakers(names: string[]): void {
    for (const name of names) {
      if (name && name !== this._displayName) {
        this._ignoredSpeakers.add(name)
      }
    }
  }

  // ── Event subscription ──

  on(listener: OrchestratorListener): () => void {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  // ── Cleanup ──

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this.stop()
    this._listeners.clear()
  }

  // ═══════════════════════════════════════════════
  // Private implementation
  // ═══════════════════════════════════════════════

  private _tag(): string {
    return `[Orchestrator:${this._container.agentInstanceId.slice(0, 8)}]`
  }

  // ── Agent provider lifecycle ──

  private async _connectAgent(config: MeetingAgentConfig): Promise<void> {
    if (this._isAgentConnecting || this._isAgentConnected) return
    this._isAgentConnecting = true
    this._emit({ type: 'agent-state-changed' })

    try {
      const provider = await this._createProvider(config)
      this._agentProvider = provider

      // Set up callbacks
      provider.setCallbacks({
        onConnectionStateChanged: (state) => {
          this._isAgentConnected = state === 'connected'
          this._isAgentConnecting = state === 'connecting'
          this._emit({ type: 'agent-state-changed' })
        },
        onMessageReceived: (message) => {
          if (message.role === 'assistant' && message.content) {
            this._addConversationMessage('assistant', message.content)
          }
        },
        onConversationStarted: (conversation) => {
          this._conversationId = conversation.id
          this._log('info', `📡 Conversation started: ${conversation.id.substring(0, 20)}...`)
        },
        onConversationEnded: () => {
          this._conversationId = null
          this._isAgentConnected = false
          this._emit({ type: 'agent-state-changed' })
        },
        onError: (err) => {
          this._agentError = err.message
          this._log('error', `❌ Agent error: ${err.message}`)
        },
        onTyping: () => {
          // Could emit typing event for UI
        },
        onAuthStateChanged: () => {
          // Auth is handled during connect, not dynamically
        }
      })

      // Initialize
      const providerConfig = this._buildProviderConfig(config)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await provider.initialize(providerConfig as any)

      // Authenticate
      await provider.authenticate()

      // Start conversation
      const response = await provider.startConversation()
      this._conversationId = response.conversationId

      this._isAgentConnected = true
      this._isAgentConnecting = false
      this._agentError = null
      this._log('success', `✅ Connected to ${config.type} agent`)
      this._emit({ type: 'agent-state-changed' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this._agentError = msg
      this._isAgentConnecting = false
      this._log('error', `❌ Agent connection failed: ${msg}`)
      this._emit({ type: 'agent-state-changed' })
    }
  }

  private async _createProvider(config: MeetingAgentConfig): Promise<IAgentProvider> {
    switch (config.type) {
      case 'copilot-studio': {
        const { CopilotStudioAgentProvider } = await import('@/services/copilotStudioAgentProvider')
        return new CopilotStudioAgentProvider() as unknown as IAgentProvider
      }
      case 'azure-foundry': {
        const { AzureFoundryAgentProvider } = await import('@/services/azureFoundryAgentProvider')
        return new AzureFoundryAgentProvider() as unknown as IAgentProvider
      }
      default:
        throw new Error(`Unsupported agent type: ${config.type}`)
    }
  }

  private _buildProviderConfig(config: MeetingAgentConfig): unknown {
    const base = {
      id: `orchestrator-agent-${Date.now()}`,
      name: config.botName || config.displayName || config.agentName || 'Meeting Agent',
      createdAt: new Date(),
      category: 'agent' as const
    }

    switch (config.type) {
      case 'copilot-studio':
        return {
          ...base,
          type: 'copilot-studio',
          authType: 'microsoft-device-code',
          settings: {
            clientId: config.clientId || '',
            tenantId: config.tenantId || '',
            environmentId: config.environmentId || '',
            botId: config.botId || '',
            botName: config.botName
          }
        }
      case 'azure-foundry':
        return {
          ...base,
          type: 'azure-foundry',
          authType: 'service-principal',
          settings: {
            projectEndpoint: config.projectEndpoint || '',
            agentName: config.agentName || '',
            tenantId: config.tenantId || '',
            clientId: config.clientId || '',
            clientSecret: config.clientSecret || '',
            region: config.region || '',
            displayName: config.displayName
          }
        }
      default:
        throw new Error(`Unsupported agent type: ${config.type}`)
    }
  }

  // ── TTS initialization ──

  private async _initializeTts(): Promise<void> {
    if (!this._speechConfig?.key || !this._speechConfig?.region) {
      this._log('warning', 'Speech service not configured — TTS disabled')
      return
    }
    try {
      const success = await this._container.ttsService.initialize({
        speechKey: this._speechConfig.key,
        speechRegion: this._speechConfig.region,
        voiceName: this._speechConfig.voiceName,
        ttsStyle: this._speechConfig.ttsStyle,
        styleDegree: this._speechConfig.styleDegree,
        speechRate: this._speechConfig.speechRate,
        openaiEndpoint: this._openaiConfig?.endpoint,
        openaiApiKey: this._openaiConfig?.apiKey,
        openaiDeployment: this._openaiConfig?.deployment,
      })
      if (success) {
        this._log('success', 'TTS service ready')
        // Pre-warm the synthesizer so first speak has no init delay
        this._container.ttsService.warmUp()
      } else {
        this._log('error', 'TTS initialization failed')
      }
    } catch (err) {
      this._log('error', `TTS init error: ${err}`)
    }
  }

  // ── Caption aggregation initialization ──

  private _initializeCaptionAggregation(): void {
    const captionSvc = this._container.captionAggregation
    captionSvc.initialize(this._displayName, this._agentNameVariations)

    if (this._openaiConfig?.apiKey && this._openaiConfig?.endpoint) {
      const gptOk = captionSvc.initializeGpt({
        openaiEndpoint: this._openaiConfig.endpoint,
        openaiApiKey: this._openaiConfig.apiKey,
        openaiDeployment: this._openaiConfig.deployment || ''
      })
      if (gptOk) {
        this._log('success', '🤖 GPT Caption Enhancement enabled')
      }
    }

    this._log('info', `📝 Caption aggregation initialized for "${this._displayName}"`)
  }

  // ── Intent detection initialization ──

  private _initializeIntentDetection(): void {
    if (!this._openaiConfig?.apiKey || !this._openaiConfig?.endpoint) {
      this._log('warning', 'OpenAI not configured — using basic intent detection')
      return
    }
    const intentSvc = getIntentDetectionService()
    intentSvc.initialize({
      openaiEndpoint: this._openaiConfig.endpoint,
      openaiApiKey: this._openaiConfig.apiKey,
      openaiDeployment: this._openaiConfig.deployment || ''
    })
    if (intentSvc.enabled) {
      this._log('success', '🧠 AI Intent Detection enabled')
    }
  }

  // ── Caption mention callbacks ──

  private _setupCaptionCallbacks(): void {
    const captionSvc = this._container.captionAggregation

    captionSvc.setOnAggregatedCaption(async (aggregated, localMention) => {
      let mention = localMention

      // GPT-enhanced mention detection for ambiguous cases
      if (captionSvc.isGptEnabled) {
        const recentCtx = this._captionHistory.slice(-5).map(c => `${c.speaker}: ${c.text}`)
        if (!localMention.isMentioned || (localMention.isMentioned && localMention.confidence < 0.85)) {
          mention = await captionSvc.detectMentionHybrid(aggregated.text, recentCtx)
        }
      }

      // Only respond when the agent's name is explicitly mentioned in captions.
      // No session tracking or autonomous intent detection — MCP tools handle those.
      if (mention.isMentioned) {
        await this._processAggregatedCaption(aggregated, mention)
      }
    })

    captionSvc.setOnPendingMentionTimeout(async (pending: PendingMention) => {
      this._log('warning', '⏰ Pending mention timeout - processing anyway')
      await this._processAggregatedCaption(
        { speaker: pending.speaker, text: pending.captionText, captionIds: [], startTime: pending.timestamp, endTime: Date.now() },
        { isMentioned: true, matchedVariation: pending.matchedVariation, confidence: 1.0, fuzzyMatch: false }
      )
    })
  }

  // ── Core processing: aggregated caption ──

  private async _processAggregatedCaption(aggregated: AggregatedCaption, mention: MentionResult): Promise<void> {
    if (this._isProcessing) {
      this._log('info', `⏳ Already processing, skipping: "${aggregated.text.substring(0, 30)}..."`)
      return
    }

    if (!this._isAgentConnected) {
      if (mention.isMentioned) {
        this._log('warning', `Agent mentioned by ${aggregated.speaker} but not connected`)
      }
      return
    }

    // Processing lock
    this._isProcessing = true
    this._emit({ type: 'processing-changed', data: { isProcessing: true } })

    try {
      // ── Check for one-off chat override ──
      const overrideResult = await this._detectChatOverride(aggregated.text)

      if (overrideResult.isOverride && overrideResult.type === 'resend') {
        if (this._lastAssistantResponse) {
          await this._sendChat(`🤖 [Resent] ${this._lastAssistantResponse}`)
          this._log('info', '📋 Resent last response to chat (one-off override)')
        } else {
          await this._sendChat('🤖 No previous response to resend.')
          this._log('warning', '📋 Chat override (resend) requested but no previous response available')
        }
        return
      }

      if (overrideResult.isOverride && overrideResult.type === 'force-next') {
        this._nextResponseChannelOverride = 'chat'
        this._log('info', '📋 Next response will be sent to chat (one-off override)')
      }

      this._addConversationMessage('user', `[Caption] ${aggregated.speaker}: ${aggregated.text}`)
      this._container.analyticsService.trackQuestion(aggregated.speaker, aggregated.text)
      this._log('info', `Processing mention: "${aggregated.text.substring(0, 60)}..."`)

      // Play thinking tone while waiting for agent response (speech channel only)
      const intendedChannel: ResponseChannel = this._nextResponseChannelOverride
        ?? (this._captionResponseAsChat ? 'chat' : 'speech')
      if (intendedChannel === 'speech') {
        this._container.ttsService.playThinkingTone()
      }

      const context = this._buildMeetingContext()
      const enrichedText = context ? `${context}[Question from ${aggregated.speaker}]\n${aggregated.text}` : aggregated.text

      const responseText = await this._sendToAgentAndWait(enrichedText, aggregated.speaker)

      if (responseText) {
        this._commitContextSent()
        this._container.analyticsService.trackResponse(responseText)

        const channel: ResponseChannel = this._nextResponseChannelOverride
          ?? (this._captionResponseAsChat ? 'chat' : 'speech')
        this._nextResponseChannelOverride = null
        // Thinking tone is stopped inside speakText() before TTS playback
        await this._sendResponse(responseText, channel, aggregated.spokenLanguage)
      } else {
        this._container.ttsService.stopThinkingTone()
        this._nextResponseChannelOverride = null
        this._log('warning', 'No response yet from agent for caption mention')
      }
    } catch (err) {
      this._container.ttsService.stopThinkingTone()
      this._nextResponseChannelOverride = null
      this._log('error', `Failed to get agent response: ${err}`)
    } finally {
      this._isProcessing = false
      this._emit({ type: 'processing-changed', data: { isProcessing: false } })
    }
  }

  // ── Core processing: chat @mention ──

  private _handleChatMention(msg: MeetingChatMessage): void {
    const mentionResult = this._detectChatMention(msg.content)

    // Allow session speaker to continue without @mention
    const isSessionContinuation = this._session.isActive
      && this._session.speaker === msg.senderDisplayName
      && !mentionResult.isMentioned

    if (!mentionResult.isMentioned && !isSessionContinuation) return

    if (isSessionContinuation) {
      this._log('info', `💬 Continuing chat session with ${msg.senderDisplayName}`)
    } else {
      this._log('info', `💬 Agent @mentioned in chat by ${msg.senderDisplayName}`)
    }

    // Process async
    this._processChatMentionAsync(msg)
  }

  private async _processChatMentionAsync(
    msg: MeetingChatMessage
  ): Promise<void> {
    if (!this._isAgentConnected) return
    if (this._isProcessing) {
      this._log('info', `⏳ Already processing, skipping chat mention from ${msg.senderDisplayName}`)
      return
    }

    try {
      const plainText = extractMessageText(msg.content)

      // Intent detection
      let intentResult = { shouldRespond: true, isEndOfConversation: false, reason: '' }
      try {
        const intentSvc = getIntentDetectionService()
        intentResult = await intentSvc.shouldRespondTo(plainText, msg.senderDisplayName, {
          agentName: this._displayName,
          sessionActive: this._session.isActive,
          sessionSpeaker: this._session.speaker,
          recentCaptions: this._captionHistory
        })
      } catch {
        // default to responding
      }

      // End of conversation
      if (this._session.isActive && intentResult.isEndOfConversation) {
        this._log('info', `👋 End of conversation from ${msg.senderDisplayName} (chat) — ${intentResult.reason}`)
        this._addConversationMessage('user', `[Chat] ${msg.senderDisplayName}: ${plainText}`)
        const closing = "You're welcome! Let me know if you need anything else."
        this._addConversationMessage('assistant', closing)
        await this._sendChat(`🤖 ${closing}`)
        this._endSession()
        return
      }

      if (!this._session.isActive) {
        this._startSession(msg.senderDisplayName)
      }
      this._resetSessionTimeout()

      this._addConversationMessage('user', `[Chat] ${msg.senderDisplayName}: ${plainText}`)

      this._isProcessing = true
      this._emit({ type: 'processing-changed', data: { isProcessing: true } })

      // Strip mention from prompt
      const promptText = this._normalizeMentionPrompt(plainText)
      const context = this._buildMeetingContext()
      const enrichedText = context ? `${context}[Question from ${msg.senderDisplayName}]\n${promptText}` : promptText

      const responseText = await this._sendToAgentAndWait(enrichedText, msg.senderDisplayName)

      if (responseText) {
        this._commitContextSent()
        this._log('success', `Agent response to chat: "${responseText.substring(0, 50)}..."`)
        await this._sendResponse(responseText, 'chat')
      } else {
        this._log('warning', 'No response yet from agent for chat mention')
      }
    } catch (err) {
      this._log('error', `Failed to process chat mention: ${err}`)
    } finally {
      this._isProcessing = false
      this._emit({ type: 'processing-changed', data: { isProcessing: false } })
    }
  }

  // ── Chat override detection ──

  private async _detectChatOverride(text: string): Promise<import('@/services/intentDetectionService').ChatOverrideResult> {
    const noOverride = { isOverride: false, type: null as null, reason: 'No override detected', confidence: 0 }
    try {
      const intentSvc = getIntentDetectionService()
      return await intentSvc.detectChatOverride(text, {
        agentName: this._displayName,
        sessionActive: this._session.isActive,
        sessionSpeaker: this._session.speaker,
        recentCaptions: this._captionHistory.slice(-5)
      })
    } catch (err) {
      this._log('warning', `Chat override detection failed: ${err}`)
      return noOverride
    }
  }

  // ── Response delivery ──

  private async _sendResponse(
    responseText: string,
    channel: ResponseChannel,
    spokenLanguage?: string,
    streaming?: boolean,
    source: SpeechResponseSource = 'reactive',
  ): Promise<void> {
    const isError = isErrorResponse(responseText)

    if (channel === 'speech' && !isError) {
      this._currentSpeechResponse = responseText
      this._currentSpeechSource = source
      this._pendingHumanReplyDuringSpeech = false
      try {
        if (streaming && this._container.ttsService.supportsStreaming) {
          await this._speakStreaming(responseText, { spokenLanguage })
        } else {
          await this._speak(responseText, { spokenLanguage })
        }
      } finally {
        this._currentSpeechResponse = null
        this._currentSpeechSource = null
      }
      this._log('info', streaming ? '🔊 Response streamed via TTS' : '🔊 Response spoken via TTS')
    } else if (isError) {
      this._log('warning', '⚠️ Error response — displaying only, not speaking')
    }

    if (channel === 'chat') {
      await this._sendChat(`🤖 ${responseText}`)
      this._log('info', '📤 Response sent to meeting chat')
    }

    // Track last response for one-off chat resend override
    if (!isError) {
      this._lastAssistantResponse = responseText
    }
  }

  // ── Meeting context builder ──

  /**
   * Build an incremental context preamble from meeting activity since the last
   * message sent to the agent. Only includes unseen captions, since the agent
   * maintains full conversation history via the persistent conversation session.
   * Does NOT advance the sent index — call _commitContextSent() after successful send.
   */
  private _buildMeetingContext(): string {
    const lines: string[] = []

    // Only include captions the agent hasn't seen yet
    const unseenCaptions = this._captionHistory.slice(this._lastSentContextIndex)
    for (const c of unseenCaptions) {
      lines.push(`${c.speaker}: ${c.text}`)
    }

    if (lines.length === 0) return ''

    return `[Meeting context — new activity since last interaction]\n${lines.join('\n')}\n\n`
  }

  /** Mark all current captions as sent to the agent. Call after successful agent send. */
  private _commitContextSent(): void {
    this._lastSentContextIndex = this._captionHistory.length
  }

  // ── Send to agent and wait for response ──

  private async _sendToAgentAndWait(text: string, _speaker?: string): Promise<string | null> {
    if (!this._agentProvider || !this._isAgentConnected) return null

    const countBefore = this._conversationMessages.filter(m => m.role === 'assistant' && m.text.trim()).length

    try {
      let response
      try {
        response = await this._agentProvider.sendMessage(text)
      } catch (primaryErr) {
        const message = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        if (/No active conversation|startConversation|conversation/i.test(message)) {
          this._log('warning', '🔄 Send failed — restarting conversation and retrying')
          await this._agentProvider.startConversation()
          response = await this._agentProvider.sendMessage(text)
        } else {
          throw primaryErr
        }
      }

      // Check immediate response
      if (response.messages) {
        for (const msg of response.messages) {
          if (msg.role === 'assistant' && msg.content) {
            // Also add to conversation via callback (deduplicated)
            return msg.content
          }
        }
      }

      // Poll for callback-delivered response
      return await this._waitForAssistantResponse(15000, countBefore)
    } catch (err) {
      this._log('error', `Agent send failed: ${err}`)
      return null
    }
  }

  private async _waitForAssistantResponse(timeoutMs: number, countBefore?: number): Promise<string | null> {
    if (this._disposed) return null
    const baseline = countBefore ?? this._conversationMessages.filter(m => m.role === 'assistant' && m.text.trim()).length

    this._resolvePendingAssistantResponse(null)

    // Fast path: use promise-based notification from onMessageReceived callback
    return new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        this._resolvePendingAssistantResponse(null)
      }, timeoutMs)

      // Check if response already arrived (race condition guard)
      const assistants = this._conversationMessages.filter(m => m.role === 'assistant' && m.text.trim())
      if (assistants.length > baseline) {
        clearTimeout(timeout)
        resolve(assistants[assistants.length - 1].text.trim())
        return
      }

      // Set up notification: resolved instantly when onMessageReceived fires
      this._responseResolve = (text: string | null) => {
        clearTimeout(timeout)
        this._responseResolve = null
        resolve(text)
      }
    })
  }

  // ── Chat helpers ──

  private async _sendChat(text: string): Promise<boolean> {
    const svc = this._container.chatService
    if (!svc || !svc.isConnectedToChat()) return false
    try {
      await svc.sendMessage(text)
      return true
    } catch (err) {
      this._log('error', `Chat send failed: ${err}`)
      return false
    }
  }

  private _detectChatMention(text: string): { isMentioned: boolean; matchedVariation: string | null } {
    // Check <span> Teams HTML mention format
    const mentionRegex = /<span[^>]*itemtype="http:\/\/schema\.skype\.com\/Mention"[^>]*>([^<]+)<\/span>/gi
    let match
    while ((match = mentionRegex.exec(text)) !== null) {
      const mentionedName = match[1].toLowerCase().trim()
      for (const v of this._agentNameVariations) {
        if (mentionedName.includes(v) || v.includes(mentionedName)) {
          return { isMentioned: true, matchedVariation: v }
        }
      }
    }

    // Fallback: @name text
    for (const v of this._agentNameVariations) {
      if (text.toLowerCase().includes(`@${v}`)) {
        return { isMentioned: true, matchedVariation: v }
      }
    }

    return { isMentioned: false, matchedVariation: null }
  }

  private _normalizeMentionPrompt(text: string): string {
    let normalized = text
    for (const v of this._agentNameVariations) {
      const regex = new RegExp(`@?${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi')
      normalized = normalized.replace(regex, '').trim()
    }
    return normalized || text
  }

  // ── TTS helper ──

  private async _speak(
    text: string,
    options?: { spokenLanguage?: string; preserveText?: boolean },
  ): Promise<void> {
    try {
      const acs = this._container.acsService
      // Skip expensive OpenAI preprocessing when language is already known from captions
      const langHint = options?.spokenLanguage || this._lastKnownLanguage || undefined
      await this._container.ttsService.speakText(text, {
        unmuteDuringPlayback: true,
        language: langHint,
        skipAIPreprocessing: !!langHint,
        preserveText: options?.preserveText,
        unmuteCallback: async () => {
          try { await acs.unmute() } catch (e) { console.warn('Unmute failed:', e) }
        },
        muteCallback: async () => {
          try { await acs.mute() } catch (e) { console.warn('Re-mute failed:', e) }
        },
      })
    } catch (err) {
      this._log('error', `TTS speak failed: ${err}`)
    }
  }

  private async _speakStreaming(
    text: string,
    options?: { spokenLanguage?: string; preserveText?: boolean },
  ): Promise<void> {
    try {
      const acs = this._container.acsService
      const langHint = options?.spokenLanguage || this._lastKnownLanguage || undefined
      await this._container.ttsService.speakTextStreaming(text, {
        unmuteDuringPlayback: true,
        language: langHint,
        skipAIPreprocessing: !!langHint,
        preserveText: options?.preserveText,
        unmuteCallback: async () => {
          try { await acs.unmute() } catch (e) { console.warn('Unmute failed:', e) }
        },
        muteCallback: async () => {
          try { await acs.mute() } catch (e) { console.warn('Re-mute failed:', e) }
        },
      })
    } catch (err) {
      this._log('error', `TTS streaming speak failed: ${err}`)
    }
  }

  // ── Session lifecycle ──

  private _startSession(speaker: string): void {
    this._session = { isActive: true, speaker, startedAt: new Date() }
    this._log('info', `🟢 Session started with ${speaker}`)
    this._emit({ type: 'session-changed', data: this._session })
  }

  private _endSession(): void {
    this._session = { isActive: false, speaker: null, startedAt: null }
    this._clearSessionTimeout()
    this._emit({ type: 'session-changed', data: this._session })
  }

  private _resetSessionTimeout(): void {
    this._clearSessionTimeout()
    this._sessionTimeout = setTimeout(() => {
      this._log('info', 'Session timed out')
      this._endSession()
    }, this._sessionTimeoutMs)
  }

  private _clearSessionTimeout(): void {
    if (this._sessionTimeout) {
      clearTimeout(this._sessionTimeout)
      this._sessionTimeout = null
    }
  }

  private _getProactiveTurnTakingMode(): ProactiveTurnTakingMode {
    return this._proactiveConfig?.turnTakingMode ?? 'interruptible'
  }

  private _shouldKeepSpeakingThroughHumanCaption(): boolean {
    return this._currentSpeechSource === 'proactive'
      && this._getProactiveTurnTakingMode() === 'interview-safe'
  }

  private _completeProactiveResponseTurn(finalChannel: ResponseChannel): void {
    const humanAlreadyReplied = this._pendingHumanReplyDuringSpeech
    this._pendingHumanReplyDuringSpeech = false

    if (humanAlreadyReplied) {
      this._waitingForHumanResponse = false
      this._log('success', `🎭 Proactive response delivered via ${finalChannel} — human already replied during speech`)
      return
    }

    this._waitingForHumanResponse = true
    this._lastCaptionTimestamp = Date.now()
    this._log('success', `🎭 Proactive response delivered via ${finalChannel} — waiting for human response`)
  }

  // ── Proactive mode (role-play) ──

  private _startProactiveMode(): void {
    if (!this._proactiveConfig) return
    // Do NOT seed _lastCaptionTimestamp with Date.now() — leave it at 0.
    // The _checkSilenceForProactive() guard (=== 0) will prevent evaluation
    // until a human actually speaks, so the agent waits for readiness.
    this._lastCaptionTimestamp = 0
    this._consecutiveProactiveActions = 0
    this._pendingHumanReplyDuringSpeech = false

    // Pre-warm audio pipeline so first proactive speak has no init delay
    this._container.ttsService.resumeAudioContexts()

    // Check for silence every 500ms to reduce detection jitter
    this._silenceCheckInterval = setInterval(() => {
      this._checkSilenceForProactive()
    }, 500)

    this._log('info', `🎭 Proactive mode enabled (silence threshold: ${this._proactiveConfig.silenceThresholdMs}ms, turn-taking: ${this._getProactiveTurnTakingMode()})`)
  }

  private _stopProactiveMode(): void {
    if (this._silenceCheckInterval) {
      clearInterval(this._silenceCheckInterval)
      this._silenceCheckInterval = null
    }
    this._proactiveEvaluating = false
    this._consecutiveProactiveActions = 0
    this._waitingForHumanResponse = false
    this._pendingHumanReplyDuringSpeech = false
    this._recentCaptionTimestamps = []
  }

  private _checkSilenceForProactive(): void {
    if (!this._proactiveConfig || !this._running) return

    // Throttled diagnostic logging (every 30s) when proactive mode is active but blocked
    const now = Date.now()
    const shouldDiagLog = now - this._lastProactiveDiagLog >= 30_000

    // After a proactive action, wait for a human to speak before evaluating again
    if (this._waitingForHumanResponse) {
      if (shouldDiagLog) {
        this._lastProactiveDiagLog = now
        this._log('info', '🎭 Proactive paused: waiting for human to respond')
      }
      return
    }

    if (!this._isAgentConnected) {
      if (shouldDiagLog) {
        this._lastProactiveDiagLog = now
        this._log('warning', '🎭 Proactive check blocked: agent not connected')
      }
      return
    }
    if (this._isProcessing) {
      if (shouldDiagLog) {
        this._lastProactiveDiagLog = now
        this._log('info', '🎭 Proactive check blocked: currently processing a request')
      }
      return
    }
    if (this._proactiveEvaluating) return // Expected transient state, no need to log
    if (this._container.ttsService.isSpeaking()) {
      if (shouldDiagLog) {
        this._lastProactiveDiagLog = now
        this._log('info', '🎭 Proactive check blocked: TTS currently speaking')
      }
      return
    }

    // Don't act if max consecutive proactive actions reached
    if (this._consecutiveProactiveActions >= MAX_CONSECUTIVE_PROACTIVE_ACTIONS) {
      if (shouldDiagLog) {
        this._lastProactiveDiagLog = now
        this._log('info', `🎭 Proactive check blocked: max consecutive actions reached (${this._consecutiveProactiveActions}/${MAX_CONSECUTIVE_PROACTIVE_ACTIONS})`)
      }
      return
    }

    // Only trigger after enough silence and at least one caption has been received
    if (this._lastCaptionTimestamp === 0) return
    const silenceDuration = now - this._lastCaptionTimestamp

    // Speaking-momentum boost: if someone was actively speaking recently,
    // wait longer before interjecting to avoid interrupting mid-thought.
    const momentumFactor = this._getSpeakingMomentumFactor(now)

    // Exponential backoff after consecutive [NO_ACTION] results
    const backoffMultiplier = Math.pow(2, this._noActionCount)
    const effectiveThreshold = this._proactiveConfig.silenceThresholdMs * momentumFactor * backoffMultiplier
    if (silenceDuration < effectiveThreshold) {
      if (shouldDiagLog) {
        this._lastProactiveDiagLog = now
        this._log('info', `🎭 Proactive waiting: silence ${Math.round(silenceDuration / 1000)}s / ${Math.round(effectiveThreshold / 1000)}s threshold (momentum: x${momentumFactor}, backoff: x${backoffMultiplier})`)
      }
      return
    }

    // Trigger proactive evaluation
    this._log('info', `🎭 Silence threshold reached (${Math.round(silenceDuration / 1000)}s, momentum: x${momentumFactor}) — triggering proactive evaluation`)
    this._evaluateProactiveAction()
  }

  /**
   * Calculate a speaking-momentum factor based on recent caption density.
   * When someone has been actively speaking, we wait proportionally longer
   * before triggering proactive evaluation to avoid interrupting mid-thought.
   */
  private _getSpeakingMomentumFactor(now: number): number {
    const MOMENTUM_WINDOW_MS = 30_000
    const cutoff = now - MOMENTUM_WINDOW_MS
    const recentCount = this._recentCaptionTimestamps.filter(t => t >= cutoff).length

    if (recentCount >= 9) return 3    // Heavy activity — almost certainly still talking
    if (recentCount >= 4) return 2    // Moderate activity — likely mid-thought
    if (recentCount >= 1) return 1.5  // Light activity — brief pause, wait a bit longer
    return 1                          // No recent activity — use configured threshold as-is
  }

  /**
   * Resolve the proactive response channel. When set to 'auto', picks 'chat' if
   * there has been recent chat activity (within 30s), otherwise defaults to 'speech'.
   * This only applies to proactive mode — reactive channel selection is independent.
   */
  private _resolveProactiveChannel(channel: ProactiveResponseChannel): ResponseChannel {
    if (channel !== 'auto') return channel
    const AUTO_CHAT_RECENCY_MS = 30_000
    const hasRecentChat = this._lastChatActivityTimestamp > 0
      && (Date.now() - this._lastChatActivityTimestamp) < AUTO_CHAT_RECENCY_MS
    return hasRecentChat ? 'chat' : 'speech'
  }

  private async _evaluateProactiveAction(): Promise<void> {
    if (!this._proactiveConfig || !this._agentProvider || !this._isAgentConnected) return
    if (this._proactiveEvaluating) return
    this._proactiveEvaluating = true

    // Signal processing state so the video shows "thinking" animation
    this._isProcessing = true
    this._emit({ type: 'processing-changed', data: { isProcessing: true } })

    try {
      // Build incremental context (only new captions since last interaction)
      const context = this._buildMeetingContext()

      // Describe speaking recency so the agent can judge if it's truly a lull
      const now = Date.now()
      const silenceSec = Math.round((now - this._lastCaptionTimestamp) / 1000)
      const recentCount = this._recentCaptionTimestamps.filter(t => t >= now - 30_000).length
      const activityDesc = recentCount >= 9 ? 'very active (someone was speaking heavily)'
        : recentCount >= 4 ? 'moderately active'
        : recentCount >= 1 ? 'lightly active'
        : 'quiet'

      const proactivePrompt = [
        `Your proactive instructions for this meeting: ${this._proactiveConfig.instructions}`,
        context ? `Meeting activity since your last message:\n${context}` : 'No new meeting activity since your last message.',
        this._getProactiveTurnTakingMode() === 'interview-safe'
          ? 'Turn-taking mode: interview-safe. Once you start a spoken proactive turn, keep the floor until the response is complete. If someone starts answering while you are finishing, treat those overlapping captions as the person\'s real reply and continue from them without expecting repetition.'
          : 'Turn-taking mode: interruptible. If someone starts speaking while you are answering, your spoken turn may be cut short.',
        `There has been a ${silenceSec}-second pause. The conversation was ${activityDesc} in the last 30 seconds (${recentCount} caption segments).`,
        'IMPORTANT: If the conversation was recently active, the speaker may just be pausing to think — do NOT interrupt. Only contribute when there is a genuine lull. If you have nothing to add right now, respond with exactly: [NO_ACTION]',
        ...(this._proactiveConfig.autoLeaveOnCompletion ? [
          'When your role is complete or the scenario has concluded, include your farewell message followed by [LEAVE_MEETING] to gracefully exit. Example: "Thank you everyone, great session! [LEAVE_MEETING]"'
        ] : []),
      ].join('\n')

      this._log('info', '🎭 Evaluating proactive action...')

      // Play subtle thinking tone while the agent processes (stops before TTS)
      const channel = this._resolveProactiveChannel(this._proactiveConfig.responseChannel)
      if (channel === 'speech') {
        this._container.ttsService.playThinkingTone()
      }

      const responseText = await this._sendToAgentAndWait(proactivePrompt)

      // Distinguish between: null (API error/timeout), [NO_ACTION] text, and real response
      if (responseText === null) {
        this._container.ttsService.stopThinkingTone()
        // API error or timeout — do NOT increment backoff, just reset timer and retry at same threshold
        this._log('warning', '🎭 Proactive evaluation got no response (API error or timeout) — will retry')
        this._lastCaptionTimestamp = Date.now()
        return
      }

      if (responseText.trim().toUpperCase().includes('[NO_ACTION]')) {
        this._container.ttsService.stopThinkingTone()
        this._noActionCount++
        this._log('info', `🎭 No proactive action needed (backoff: ${this._noActionCount})`)
        // Reset silence timer; backoff multiplier will increase effective threshold
        this._lastCaptionTimestamp = Date.now()
        return
      }

      // Check for [LEAVE_MEETING] sentinel — agent wants to end and leave.
      // The agent's full response (rationale, closing thoughts, farewell) is
      // delivered first via the normal TTS path so nothing gets skipped.
      const wantsToLeave = this._proactiveConfig.autoLeaveOnCompletion
        && responseText.trim().toUpperCase().includes('[LEAVE_MEETING]')

      // Strip sentinel so it is never spoken or sent to chat
      const cleanedResponse = wantsToLeave
        ? responseText.replace(/\s*\[LEAVE_MEETING\]\s*/gi, '').trim()
        : responseText

      // Successful action — commit context, reset backoff
      this._commitContextSent()
      this._noActionCount = 0
      this._consecutiveProactiveActions++
      this._addConversationMessage('assistant', responseText)
      this._container.analyticsService.trackResponse(responseText)

      const finalChannel = this._nextResponseChannelOverride ?? channel
      this._nextResponseChannelOverride = null
      // Thinking tone is stopped inside speakText() before TTS playback
      await this._sendResponse(cleanedResponse, finalChannel, undefined, true, 'proactive')
      this._completeProactiveResponseTurn(finalChannel)

      // After the full response has been delivered, execute the leave sequence
      if (wantsToLeave) {
        await this._handleAutoLeave(cleanedResponse)
      }
    } catch (err) {
      this._container.ttsService.stopThinkingTone()
      this._log('error', `🎭 Proactive evaluation failed: ${err}`)
    } finally {
      this._isProcessing = false
      this._emit({ type: 'processing-changed', data: { isProcessing: false } })
      this._proactiveEvaluating = false
    }
  }

  // ── Auto-leave handling ──

  /** Sentinel pattern used by the agent to request meeting exit */
  static readonly LEAVE_SENTINEL = '[LEAVE_MEETING]'

  private static readonly _autoLeaveDelayMs = 2500

  /**
   * Handle the agent's request to leave the meeting.
   * Called AFTER the agent's full response has already been delivered via
   * _sendResponse(). Only delivers a separate goodbye when a configuredGoodbye
   * is set (i.e. the operator wants a specific farewell that differs from
   * whatever the agent said). Then waits briefly and emits leave-requested.
   */
  private async _handleAutoLeave(alreadySpokenText: string): Promise<void> {
    if (!this._proactiveConfig) return

    const configuredGoodbye = this._proactiveConfig.goodbyeMessage.trim()
    const channel: GoodbyeChannel = this._proactiveConfig.goodbyeChannel ?? 'both'

    this._log('info', `👋 Agent requested to leave — executing leave sequence (channel: ${channel})`)

    // Only deliver a separate goodbye if the operator configured one AND it
    // differs from what the agent already said (avoids repeating the same text).
    if (configuredGoodbye && configuredGoodbye !== alreadySpokenText) {
      this._log('info', `📢 Delivering configured goodbye message`)
      if (channel === 'both' || channel === 'speech') {
        await this._speak(configuredGoodbye, { preserveText: true })
        this._log('info', '🔊 Goodbye spoken via TTS')
      }
      if (channel === 'both' || channel === 'chat') {
        await this._sendChat(`👋 ${configuredGoodbye}`)
        this._log('info', '📤 Goodbye sent to meeting chat')
      }
    }

    this._stopProactiveMode()
    this._log('info', `⏳ Waiting ${AgentMeetingOrchestrator._autoLeaveDelayMs}ms before leaving meeting`)
    await new Promise(resolve => setTimeout(resolve, AgentMeetingOrchestrator._autoLeaveDelayMs))

    // End the session and emit leave event after the farewell has landed
    this._endSession()
    this._log('success', '🚪 Auto-leave triggered — emitting leave-requested')
    this._emit({ type: 'leave-requested' })
  }

  // ── Conversation messages ──

  private _addConversationMessage(role: 'user' | 'assistant', text: string): void {
    // Deduplicate (same role + text within 2 seconds)
    const now = Date.now()
    const dupe = this._conversationMessages.find(
      m => m.role === role && m.text === text && now - m.timestamp.getTime() < 2000
    )
    if (dupe) return

    const message: OrchestratorConversationMessage = {
      id: generateId(),
      role,
      text,
      timestamp: new Date()
    }
    this._conversationMessages.push(message)
    this._emit({ type: 'conversation-message', data: message })

    // Notify _waitForAssistantResponse immediately if waiting for an assistant response
    if (role === 'assistant' && this._responseResolve) {
      this._responseResolve(text)
    }
  }

  private _resolvePendingAssistantResponse(text: string | null): void {
    const resolve = this._responseResolve
    if (!resolve) return
    this._responseResolve = null
    resolve(text)
  }

  // ── Name variation builder ──

  private _buildNameVariations(name: string): string[] {
    const lower = name.toLowerCase()
    const variations = [lower]
    const parts = lower.split(' ')
    for (const part of parts) {
      if (part.length > 2 && !variations.includes(part)) {
        variations.push(part)
      }
    }
    if (parts.length >= 2) {
      variations.push(`${parts[0]} ${parts[parts.length - 1][0]}`)
    }
    return variations
  }

  // ── Logging ──

  private _log(level: LogLevel, message: string): void {
    const tag = this._tag()
    if (level === 'error') {
      log.error(`${tag} ${message}`)
    } else {
      log.info(`${tag} ${message}`)
    }
    this._emit({ type: 'log', data: { level, message } })
  }

  // ── Event emitter ──

  private _emit(event: OrchestratorEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('Orchestrator listener error:', err)
      }
    }
  }
}
