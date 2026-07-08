// ============================================
// Session Manager — Multi-Session Orchestrator
// Creates, manages, and disposes sessions and their agent service containers
// ============================================

import { useSessionStore } from '@/stores/sessionStore'
import { useAgentProvidersStore } from '@/stores/agentProvidersStore'
import { useConfigStore } from '@/stores/configStore'
import { useAppStore } from '@/stores/appStore'
import { AgentServiceContainer } from '@/services/agentServiceContainer'
import { getOrCreateTokenForIdentity } from '@/services/tokenService'
import { getAgent365AcsToken } from '@/services/agent365TokenService'
import type { Session, AgentInstance } from '@/types/session'
import type { MeetingAgentConfig } from '@/hooks/useMeetingAgent'
import { DEFAULT_SPOKEN_LANGUAGE, DEFAULT_SPEECH_VOICE, isAgent365Configured, DEFAULT_AGENT_IDENTITY_MODE, type AgentIdentityMode } from '@/types'
import { loggers } from '@/lib/logger'

const log = loggers.app

export type JoinStep = 'token' | 'init' | 'joining' | 'lobby' | 'connected' | 'error'

/**
 * SessionManager is the top-level orchestrator for multi-session support.
 *
 * Responsibilities:
 * - Create sessions and add agents to them
 * - Hold live service containers (AgentServiceContainer) per agent instance
 * - Coordinate lifecycle: init → connect → disconnect → dispose
 * - Enforce session limits
 *
 * This is an app-level singleton (it manages all sessions).
 * It lives outside React — components access it via SessionManagerContext.
 */
export class SessionManager {
  /** Live service containers, keyed by agentInstanceId */
  private _containers = new Map<string, AgentServiceContainer>()
  private _pendingAgentRemovals = new Map<string, Promise<void>>()

  // ── Session Lifecycle ──

  /**
   * Create a new session and add an initial agent to it.
   * Returns the session and the first agent instance.
   */
  createSession(params: {
    meetingUrl: string
    agentConfigId: string
    agentName: string
    title?: string
    tabId?: string
  }): { session: Session; agent: AgentInstance; container: AgentServiceContainer } {
    const store = useSessionStore.getState()

    // Create session in store
    const session = store.createSession(params.meetingUrl, params.title)

    // Add the first agent
    const { agent, container } = this.addAgentToSession({
      sessionId: session.sessionId,
      agentConfigId: params.agentConfigId,
      agentName: params.agentName,
      tabId: params.tabId,
    })

    log.info(
      `[SessionMgr] Session ${session.sessionId.slice(0, 8)} created with agent ${agent.agentInstanceId.slice(0, 8)} (${params.agentName})`
    )

    return { session: store.getSession(session.sessionId)!, agent, container }
  }

  /**
   * Add another agent to an existing session (future: agent teams).
   */
  addAgentToSession(params: {
    sessionId: string
    agentConfigId: string
    agentName: string
    tabId?: string
  }): { agent: AgentInstance; container: AgentServiceContainer } {
    const store = useSessionStore.getState()

    // Add agent to store (this validates limits)
    const agent = store.addAgent(
      params.sessionId,
      params.agentConfigId,
      params.agentName,
      params.tabId
    )

    // Create service container
    const container = new AgentServiceContainer({
      agentInstanceId: agent.agentInstanceId,
      sessionId: params.sessionId,
      agentName: params.agentName,
      agentConfigId: params.agentConfigId,
    })

    this._containers.set(agent.agentInstanceId, container)

    log.info(
      `[SessionMgr] Agent ${agent.agentInstanceId.slice(0, 8)} added to session ${params.sessionId.slice(0, 8)}`
    )

    return { agent, container }
  }

  // ── Join Meeting ──

  /**
   * Join a Teams meeting for a specific agent in a session.
   *
   * This is the headless join flow extracted from ConnectingStage.
   * It can be called from the UI (ConnectingStage delegates here) or
   * from MCP tools (fully headless, no UI needed).
   *
   * Steps:
   * 1. Wire ACS callbacks → sessionStore
   * 2. Generate ACS token (per-agent identity)
   * 3. Initialize container's ACS service
   * 4. Join the Teams meeting
   * 5. (async) Chat init + welcome message happen in onChatThreadReady callback
   */
  async joinMeeting(params: {
    sessionId: string
    agentInstanceId: string
    meetingUrl: string
    agentName: string
    acsEndpoint: string
    acsAccessKey: string
    onStep?: (step: JoinStep) => void
    onLog?: (message: string, level: 'info' | 'success' | 'warning' | 'error') => void
  }): Promise<void> {
    const { sessionId, agentInstanceId, meetingUrl, agentName, acsEndpoint, acsAccessKey } = params
    const onStep = params.onStep ?? (() => {})
    const onLog = params.onLog ?? ((msg, lvl) => log.info(`[SessionMgr] [${lvl}] ${msg}`))

    const container = this._containers.get(agentInstanceId)
    if (!container) {
      throw new Error(`Session container not found for agent ${agentInstanceId}`)
    }

    const ensureActiveContainer = (step: string): AgentServiceContainer => {
      const activeContainer = this._containers.get(agentInstanceId)
      if (!activeContainer || activeContainer !== container || activeContainer.isDisposed) {
        throw new Error(`Join aborted during ${step}: agent ${agentInstanceId.slice(0, 8)} is no longer active`)
      }
      return activeContainer
    }

    const isContainerActive = (): boolean =>
      this._containers.get(agentInstanceId) === container && !container.isDisposed

    const containerAcs = container.acsService
    const sStore = useSessionStore.getState

    // ── Orchestrator startup (captions/voice/welcome) ──
    // Decoupled from chat init so it runs for ANY identity, including the named
    // Agent 365 (Teams-user) identity which has no ACS chat user id. Idempotent.
    let orchestratorStarting = false
    // The agent user's Microsoft Entra display name (roster name), resolved from
    // the delegated token at the token step below. Used for mention-recognition.
    let agent365EntraName: string | undefined
    const startOrchestrator = async (trigger: string): Promise<void> => {
      if (!isContainerActive()) return
      const orchestrator = container.orchestrator
      if (orchestrator.state.isRunning || orchestratorStarting) return
      orchestratorStarting = true
      try {
        const agentConfig = this._buildMeetingAgentConfig(container.agentConfigId)
        const configState = useConfigStore.getState()
        const speechCfg = configState.config.speech
        const openaiCfg = configState.config.openai
        const provider = useAgentProvidersStore.getState().getProvider(container.agentConfigId)

        // Voice recognition (mention detection) must key on the name other
        // participants actually SEE in the roster. For the Agent 365 identity
        // that is the Entra display name (read from the delegated token), which
        // overrides the per-agent name.
        const a365 = configState.config.agent365
        const usingAgent365 = provider?.identityMode === 'agent365' && isAgent365Configured(a365)
        const recognitionName = usingAgent365
          ? (agent365EntraName || a365.displayName?.trim() || a365.agentUserUpn)
          : agentName
        if (usingAgent365 && recognitionName !== agentName) {
          onLog(`🪪 Using Agent 365 identity name "${recognitionName}" for recognition (overrides agent name "${agentName}")`, 'info')
        }

        ensureActiveContainer('orchestrator start')
        await orchestrator.start({
          displayName: recognitionName,
          captionResponseAsChat: provider?.captionResponseAsChat ?? false,
          agentConfig,
          speechConfig: speechCfg?.key && speechCfg?.region
            ? {
                key: speechCfg.key,
                region: speechCfg.region,
                voiceName: provider?.voiceName || DEFAULT_SPEECH_VOICE,
                ttsStyle: provider?.ttsStyle,
                styleDegree: provider?.styleDegree,
                speechRate: provider?.speechRate,
              }
            : undefined,
          openaiConfig: openaiCfg?.endpoint && openaiCfg?.apiKey && openaiCfg?.deployment
            ? { endpoint: openaiCfg.endpoint, apiKey: openaiCfg.apiKey, deployment: openaiCfg.deployment }
            : undefined,
          proactiveConfig: provider?.proactiveConfig,
          welcomeConfig: provider?.welcomeConfig,
          interactionAllowlist: configState.meetingBehavior.interactionAllowlist,
        })
        // Wire orchestrator log events → UI
        orchestrator.on((event) => {
          if (event.type === 'log' && event.data) {
            const { level, message } = event.data as { level: string; message: string }
            onLog(message, level as 'info' | 'success' | 'warning' | 'error')
            useAppStore.getState().addLog(message, level as 'info' | 'success' | 'warning' | 'error')
          }
          if (event.type === 'leave-requested') {
            onLog('🚪 Agent requested to leave — removing from meeting...', 'info')
            this.removeAgent(sessionId, agentInstanceId).catch((err) => {
              log.warn(`[SessionMgr] Auto-leave removeAgent failed: ${err}`)
            })
          }
        })

        // Register peer agents in the same meeting so agents ignore each
        // other's chat/captions and never loop (two-way, covers late joins).
        const peers = this.getSessionContainers(sessionId)
          .filter((c) => c.agentInstanceId !== agentInstanceId)
        if (peers.length > 0) {
          orchestrator.addIgnoredSpeakers(peers.map((c) => c.agentName))
          for (const peer of peers) {
            peer.orchestrator.addIgnoredSpeakers([recognitionName])
          }
          log.info(`[SessionMgr] Registered ${peers.length} peer agent(s) as ignored speakers for ${recognitionName}`)
        }

        onLog(`🧠 Orchestrator started — AI agent active (${trigger})`, 'success')
        sStore().addAgentConversationMessage(sessionId, agentInstanceId, {
          id: `sys-orchestrator-started-${Date.now()}`,
          role: 'assistant',
          text: `🧠 AI agent (${agentConfig.type}) connected — processing captions and chat`,
          timestamp: new Date(),
        })

        if (provider?.proactiveConfig?.enabled) {
          const pc = provider.proactiveConfig
          const turnTaking = pc.turnTakingMode ?? 'interruptible'
          const msg = `🎭 Proactive mode configured (threshold: ${pc.silenceThresholdMs / 1000}s, channel: ${pc.responseChannel}, turns: ${turnTaking})`
          onLog(msg, 'info')
          useAppStore.getState().addLog(msg, 'info')
        }
      } catch (orchErr) {
        const errMsg = orchErr instanceof Error ? orchErr.message : String(orchErr)
        onLog(`Orchestrator start error: ${errMsg}`, 'error')
        sStore().addAgentConversationMessage(sessionId, agentInstanceId, {
          id: `sys-orchestrator-error-${Date.now()}`,
          role: 'assistant',
          text: `❌ AI agent failed to start: ${errMsg}`,
          timestamp: new Date(),
        })
      } finally {
        orchestratorStarting = false
      }
    }

    // Send the welcome message once, after the orchestrator is running. Placed
    // here (not in startOrchestrator) so a chat-channel welcome is sent only
    // after chat connects; for the Agent 365 identity it falls back to voice.
    const sendWelcomeOnce = async (): Promise<void> => {
      const orchestrator = container.orchestrator
      if (!orchestrator.state.isRunning || orchestrator.welcomeMessageSent) return
      try {
        await orchestrator.sendWelcomeMessage()
        sStore().updateAgentCallState(sessionId, agentInstanceId, { welcomeMessageSent: true })
      } catch (err) {
        log.warn(`[SessionMgr] Welcome message failed: ${err}`)
      }
    }

    // ── Wire ACS callbacks → sessionStore ──

    containerAcs.onStateChanged = (state) => {
      if (!isContainerActive()) return
      onLog(`Call state: ${state}`, 'info')

      if (state === 'Connected') {
        sStore().updateAgentState(sessionId, agentInstanceId, 'connected')
        sStore().updateAgentConnectionStatus(sessionId, agentInstanceId, 'connected')
        sStore().updateAgentCallState(sessionId, agentInstanceId, { isInCall: true })
        // Log milestone to conversation messages (appears in terminal)
        sStore().addAgentConversationMessage(sessionId, agentInstanceId, {
          id: `sys-call-connected-${Date.now()}`,
          role: 'assistant',
          text: `✅ ${agentName} connected to Teams meeting`,
          timestamp: new Date(),
        })
        onStep('connected')
        // Start the AI orchestrator as soon as the call connects — independent
        // of meeting chat, so captions/voice work for the named Agent 365
        // identity (which has no ACS chat user id) as well as anonymous guests.
        void startOrchestrator('call-connected')
      } else if (state === 'Connecting' || state === 'Ringing') {
        sStore().updateAgentState(sessionId, agentInstanceId, 'connecting')
        sStore().updateAgentConnectionStatus(sessionId, agentInstanceId, 'connecting')
      } else if (state === 'InLobby') {
        sStore().updateAgentConnectionStatus(sessionId, agentInstanceId, 'in-lobby')
        sStore().addAgentConversationMessage(sessionId, agentInstanceId, {
          id: `sys-lobby-${Date.now()}`,
          role: 'assistant',
          text: `⏳ ${agentName} is waiting in the lobby...`,
          timestamp: new Date(),
        })
        onStep('lobby')
      } else if (state === 'Disconnected') {
        sStore().updateAgentState(sessionId, agentInstanceId, 'disconnected')
        sStore().updateAgentConnectionStatus(sessionId, agentInstanceId, 'disconnected')
        sStore().addAgentConversationMessage(sessionId, agentInstanceId, {
          id: `sys-disconnected-${Date.now()}`,
          role: 'assistant',
          text: `📴 ${agentName} disconnected from meeting`,
          timestamp: new Date(),
        })
      }
    }

    // ── Headless chat lifecycle (best-effort; additive to the orchestrator) ──
    containerAcs.onChatThreadReady = async (threadId: string) => {
      if (!isContainerActive()) return

      // Ensure the orchestrator is running (idempotent). It normally starts on
      // 'Connected'; this is a safety net for meetings where that fires late.
      await startOrchestrator('chat-thread-ready')

      const chatToken = container.acsToken
      const chatUserId = container.acsUserId
      if (!chatToken || !chatUserId || !acsEndpoint) {
        // Expected for the named Agent 365 (Teams-user) identity: it has no ACS
        // chat user id, so headless meeting-chat is skipped. Captions + voice
        // (via the orchestrator started above) remain fully active.
        onLog('Meeting chat not initialized (named Teams identity) — captions & voice active', 'info')
        await sendWelcomeOnce()
        return
      }

      try {
        ensureActiveContainer('chat initialization')
        const chatService = container.chatService
        const initOk = await chatService.initialize(acsEndpoint, chatToken, chatUserId, agentName)
        if (!initOk) {
          onLog('Headless chat init failed', 'warning')
          return
        }
        ensureActiveContainer('chat connect')
        const connectOk = await chatService.connectToThread(threadId)
        if (!connectOk) {
          onLog('Headless chat thread connect failed', 'warning')
          return
        }
        onLog('💬 Headless chat connected', 'success')
        container.setChatConnected(true)
        sStore().addAgentConversationMessage(sessionId, agentInstanceId, {
          id: `sys-chat-connected-${Date.now()}`,
          role: 'assistant',
          text: `💬 Chat thread connected — listening for messages`,
          timestamp: new Date(),
        })

        // Wire incoming messages to sessionStore AND container
        const sentMsgIds = new Set<string>()
        chatService.setCallbacks({
          onMessageReceived: (msg) => {
            container.addChatMessage(msg)
            // Feed into orchestrator for @mention detection
            container.orchestrator.processChatMessage(msg)
            sStore().addAgentConversationMessage(sessionId, agentInstanceId, {
              id: msg.id,
              role: 'user',
              text: `[Chat] ${msg.senderDisplayName}: ${msg.content}`,
              timestamp: msg.createdOn,
            })
          },
          onMessageSent: (msg) => {
            container.addChatMessage(msg)
            // Deduplicate: onMessageSent fires twice (sendMessage + ACS echo-back)
            if (!sentMsgIds.has(msg.id)) {
              sentMsgIds.add(msg.id)
              sStore().addAgentConversationMessage(sessionId, agentInstanceId, {
                id: `sent-${msg.id}`,
                role: 'assistant',
                text: msg.content,
                timestamp: msg.createdOn,
              })
            }
          },
          onDisconnected: () => {
            container.setChatConnected(false)
          },
        })
      } catch (err) {
        onLog(`Headless chat error: ${err}`, 'error')
      } finally {
        // Send the welcome once the orchestrator is up, regardless of whether
        // chat connected (voice welcome still applies).
        await sendWelcomeOnce()
      }
    }

    containerAcs.onMuteChanged = (muted) => {
      if (!isContainerActive()) return
      onLog(`Mute: ${muted ? 'muted' : 'unmuted'}`, 'info')
      sStore().updateAgentCallState(sessionId, agentInstanceId, { isMuted: muted })
    }

    containerAcs.onCaptionReceived = (caption) => {
      if (!isContainerActive()) return
      sStore().addAgentCaption(sessionId, agentInstanceId, caption)
      container.analyticsService.trackCaption(caption)
      // Feed into orchestrator (which feeds caption aggregation internally)
      container.orchestrator.processCaption({
        id: caption.id ?? `cap-${Date.now()}`,
        speaker: caption.speaker,
        text: caption.text,
        spokenLanguage: caption.spokenLanguage,
      })
    }

    containerAcs.onParticipantAdded = (participant) => {
      if (!isContainerActive()) return
      onLog(`Participant joined: ${participant.displayName}`, 'info')
      sStore().addAgentParticipant(sessionId, agentInstanceId, participant)
      container.idleTimeout.participantJoined()
    }

    containerAcs.onParticipantRemoved = (id) => {
      if (!isContainerActive()) return
      onLog(`Participant left: ${id}`, 'info')
      sStore().removeAgentParticipant(sessionId, agentInstanceId, id)
      container.idleTimeout.participantLeft()
    }

    containerAcs.onCallEnded = (reason) => {
      if (!isContainerActive()) return
      if (reason) {
        onLog(`Call ended: code ${reason.code}, subcode ${reason.subCode}`, 'info')
      } else {
        onLog('Call ended', 'info')
      }
      container.analyticsService.endCall()
      container.orchestrator.stop()
      sStore().updateAgentState(sessionId, agentInstanceId, 'disconnected')
      sStore().updateAgentConnectionStatus(sessionId, agentInstanceId, 'disconnected')
      sStore().updateAgentCallState(sessionId, agentInstanceId, { isInCall: false })
    }

    // ── Wire idle timeout (auto-leave when agent is alone) ──
    const idleTimeout = container.idleTimeout
    idleTimeout.onWarning = (message) => {
      if (!isContainerActive()) return
      if (container.isChatConnected) {
        container.chatService.sendMessage(message).catch((err) => {
          log.warn(`[SessionMgr] Idle warning chat send failed: ${err}`)
        })
      }
      sStore().addAgentConversationMessage(sessionId, agentInstanceId, {
        id: `sys-idle-warning-${Date.now()}`,
        role: 'assistant',
        text: message,
        timestamp: new Date(),
      })
    }
    idleTimeout.onLeave = (reason) => {
      if (!isContainerActive()) return
      onLog(`🚪 ${reason}`, 'info')
      sStore().addAgentConversationMessage(sessionId, agentInstanceId, {
        id: `sys-idle-leave-${Date.now()}`,
        role: 'assistant',
        text: `🚪 ${reason}`,
        timestamp: new Date(),
      })
      this.removeAgent(sessionId, agentInstanceId).catch((err) => {
        log.warn(`[SessionMgr] Idle timeout removeAgent failed: ${err}`)
      })
    }
    idleTimeout.start()

    // ── Step 1: Acquire ACS token for this agent's identity ──
    // The identity mode is read from the agent's provider config:
    //   'anonymous' (default) → per-instance anonymous ACS guest token
    //   'agent365'            → named Agent 365 agent-user Teams token (user_fic OBO)
    const provider = useAgentProvidersStore.getState().getProvider(container.agentConfigId)
    const requestedMode: AgentIdentityMode = provider?.identityMode ?? DEFAULT_AGENT_IDENTITY_MODE
    const agent365Cfg = useConfigStore.getState().config.agent365
    const useAgent365 = requestedMode === 'agent365' && isAgent365Configured(agent365Cfg)

    if (requestedMode === 'agent365' && !useAgent365) {
      onLog('Agent 365 identity requested but not configured — falling back to anonymous guest', 'warning')
    }

    onStep('token')
    let token: string
    let userId = ''
    if (useAgent365) {
      onLog('Acquiring Agent 365 named-identity ACS token (user_fic OBO)...', 'info')
      const acs = await getAgent365AcsToken(agent365Cfg, acsEndpoint, acsAccessKey)
      token = acs.token
      agent365EntraName = acs.displayName
      // Teams-user tokens have no ACS communicationUserId; headless chat is
      // skipped (guarded in onChatThreadReady) — captions + voice still work.
      onLog(`Agent 365 token acquired for "${acs.displayName}" (Entra display name)`, 'success')
    } else {
      onLog('Generating ACS token for session...', 'info')
      const result = await getOrCreateTokenForIdentity(acsEndpoint, acsAccessKey, agentInstanceId)
      token = result.token
      userId = result.userId
      onLog('Session token generated successfully', 'success')
    }
    ensureActiveContainer('token generation')
    container.setCredentials(token, userId)

    // ── Step 2: Initialize container's ACS service ──
    onStep('init')
    onLog(`Initializing session call client as "${agentName}"${useAgent365 ? ' (Agent 365 identity)' : ''}...`, 'info')
    ensureActiveContainer('ACS initialization')
    await containerAcs.initialize(token, agentName, useAgent365 ? 'agent365' : 'anonymous')
    ensureActiveContainer('ACS initialization completion')
    onLog('Session ACS client initialized', 'success')

    // ── Step 3: Join Teams meeting ──
    onStep('joining')
    onLog('Joining Teams meeting (session mode)...', 'info')
    // Set caption spoken language from config before joining
    const spokenLang = DEFAULT_SPOKEN_LANGUAGE
    if (spokenLang) {
      containerAcs.setSpokenLanguage(spokenLang.toLowerCase())
    }
    ensureActiveContainer('meeting join')
    await containerAcs.joinMeeting(meetingUrl)
    ensureActiveContainer('meeting join completion')
    sStore().updateAgentCallState(sessionId, agentInstanceId, { isInCall: true })
    sStore().updateSessionState(sessionId, 'connecting')
    onLog('✓ Call initiated (session mode), waiting to connect...', 'success')
  }

  // ── Internal Helpers ──

  /**
   * Build a MeetingAgentConfig from a stored provider config ID.
   * Used when the orchestrator needs to connect to the AI backend.
   */
  private _buildMeetingAgentConfig(agentConfigId: string): MeetingAgentConfig {
    const provider = useAgentProvidersStore.getState().getProvider(agentConfigId)
    if (!provider) {
      throw new Error(`Agent provider config not found: ${agentConfigId}`)
    }

    switch (provider.type) {
      case 'copilot-studio':
        return {
          type: 'copilot-studio',
          clientId: provider.settings.clientId,
          tenantId: provider.settings.tenantId,
          environmentId: provider.settings.environmentId,
          botId: provider.settings.botId,
          botName: provider.settings.botName,
        }
      case 'azure-foundry':
        return {
          type: 'azure-foundry',
          projectEndpoint: provider.settings.projectEndpoint,
          agentName: provider.settings.agentName,
          tenantId: provider.settings.tenantId,
          clientId: provider.settings.clientId,
          clientSecret: provider.settings.clientSecret,
          region: provider.settings.region,
          displayName: provider.settings.displayName,
        }
      case 'coding-agent':
        return {
          type: 'coding-agent',
          cwd: provider.settings.cwd,
          model: provider.settings.model,
          systemMessage: provider.settings.systemMessage,
          allowShell: provider.settings.allowShell,
          bin: provider.settings.bin,
          timeoutMs: provider.settings.timeoutMs,
          displayName: provider.settings.displayName,
        }
      default:
        throw new Error(`Unsupported agent type: ${provider.type}`)
    }
  }

  /**
   * Remove a single agent from a session.
   * Disposes its service container and updates the store.
   */
  async removeAgent(sessionId: string, agentInstanceId: string): Promise<void> {
    const existingRemoval = this._pendingAgentRemovals.get(agentInstanceId)
    if (existingRemoval) {
      await existingRemoval
      return
    }

    const removal = this._removeAgentInternal(sessionId, agentInstanceId)
      .finally(() => {
        this._pendingAgentRemovals.delete(agentInstanceId)
      })

    this._pendingAgentRemovals.set(agentInstanceId, removal)
    await removal
  }

  /**
   * End a session — disposes all agent containers and updates the store.
   */
  async endSession(sessionId: string): Promise<void> {
    const store = useSessionStore.getState()
    const session = store.getSession(sessionId)
    if (!session) {
      log.warn(`[SessionMgr] endSession: session not found: ${sessionId}`)
      return
    }

    const agentIds = Object.keys(session.agents)
    if (agentIds.length === 0) {
      store.endSession(sessionId)
      return
    }

    if (session.state !== 'disconnecting' && session.state !== 'disconnected') {
      store.updateSessionState(sessionId, 'disconnecting')
    }

    await Promise.allSettled(agentIds.map((agentInstanceId) => this.removeAgent(sessionId, agentInstanceId)))

    const remainingSession = store.getSession(sessionId)
    if (remainingSession && Object.keys(remainingSession.agents).length === 0 && remainingSession.state !== 'disconnected') {
      store.endSession(sessionId)
    }

    log.info(`[SessionMgr] Session ${sessionId.slice(0, 8)} ended (${agentIds.length} agents disposed)`)
  }

  /**
   * End all active sessions. Called on app shutdown.
   */
  async endAllSessions(): Promise<void> {
    const store = useSessionStore.getState()
    const activeSessions = store.getActiveSessions()

    log.info(`[SessionMgr] Ending all sessions (${activeSessions.length} active)`)

    await Promise.allSettled(
      activeSessions.map((s) => this.endSession(s.sessionId))
    )
  }

  // ── Container Access ──

  /**
   * Get the service container for an agent instance.
   */
  getContainer(agentInstanceId: string): AgentServiceContainer | undefined {
    return this._containers.get(agentInstanceId)
  }

  /**
   * Get all containers for a session.
   */
  getSessionContainers(sessionId: string): AgentServiceContainer[] {
    const store = useSessionStore.getState()
    const session = store.getSession(sessionId)
    if (!session) return []

    return Object.keys(session.agents)
      .map((id) => this._containers.get(id))
      .filter((c): c is AgentServiceContainer => c !== undefined)
  }

  /**
   * Check if a container exists for an agent instance.
   */
  hasContainer(agentInstanceId: string): boolean {
    return this._containers.has(agentInstanceId)
  }

  // ── Queries ──

  /**
   * Get the count of active service containers.
   */
  get activeContainerCount(): number {
    return this._containers.size
  }

  /**
   * List all active container IDs.
   */
  get activeContainerIds(): string[] {
    return [...this._containers.keys()]
  }

  private async _removeAgentInternal(sessionId: string, agentInstanceId: string): Promise<void> {
    const container = this._containers.get(agentInstanceId)
    if (container && !container.isDisposed) {
      await container.dispose()
    }
    this._containers.delete(agentInstanceId)

    const store = useSessionStore.getState()
    const session = store.getSession(sessionId)
    if (!session) {
      return
    }

    if (session.agents[agentInstanceId]) {
      store.removeAgent(sessionId, agentInstanceId)
    }

    const updatedSession = store.getSession(sessionId)
    if (updatedSession && Object.keys(updatedSession.agents).length === 0) {
      store.endSession(sessionId)
      log.info(`[SessionMgr] Session ${sessionId.slice(0, 8)} ended (last agent removed)`)
    }

    log.info(`[SessionMgr] Agent ${agentInstanceId.slice(0, 8)} removed from session ${sessionId.slice(0, 8)}`)
  }
}

// ── Singleton (app-level) ──

let _instance: SessionManager | null = null

export function getSessionManager(): SessionManager {
  if (!_instance) {
    _instance = new SessionManager()
  }
  return _instance
}

/**
 * Reset the session manager (for testing).
 */
export async function resetSessionManager(): Promise<void> {
  if (_instance) {
    await _instance.endAllSessions()
    _instance = null
  }
}
