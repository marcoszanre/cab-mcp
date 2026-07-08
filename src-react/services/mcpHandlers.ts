// ============================================
// MCP Tool Handlers (React side)
// Handles MCP tool requests received from Rust
// via Tauri events
//
// MULTI-SESSION: Uses SessionManager + sessionStore
// instead of singleton callStore/acsService.
// ============================================

import { useAgentProvidersStore } from '@/stores/agentProvidersStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { useConfigStore } from '@/stores/configStore'
import { getSessionManager } from '@/services/sessionManager'
import type { McpAgentInfo, McpSessionsSummary } from '@/types'
import { loggers } from '@/lib/logger'

const log = loggers.app

// ── Mutex for serializing concurrent join_meeting calls ──
let _joinMutex: Promise<void> = Promise.resolve()

/**
 * Handle list_agents tool — returns agent configs with secrets stripped
 */
export function handleListAgents(): McpAgentInfo[] {
  const providers = useAgentProvidersStore.getState().providers
  
  return providers.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
  }))
}

/**
 * Handle join_meeting tool — triggers meeting join flow
 * 
 * MULTI-SESSION: Creates a new session via SessionManager instead of
 * checking callStore.isInCall. Multiple sessions can run in parallel.
 */
export async function handleJoinMeeting(params: {
  meetingUrl: string
  agentConfigId: string
}): Promise<{ sessionId: string; status: string }> {
  // Serialize concurrent joins to avoid race conditions when multiple
  // MCP calls arrive at the same time (tab creation, navigation, etc.)
  const queuedJoin = _joinMutex
    .catch(() => undefined)
    .then(() => _doJoinMeeting(params))

  _joinMutex = queuedJoin.then(
    () => undefined,
    () => undefined
  )

  return queuedJoin
}

async function _doJoinMeeting(params: {
  meetingUrl: string
  agentConfigId: string
}): Promise<{ sessionId: string; status: string }> {
  const { meetingUrl, agentConfigId } = params
  const agentStore = useAgentProvidersStore.getState()
  const sessionStore = useSessionStore.getState()
  const navStore = useNavigationStore.getState()
  const configStore = useConfigStore.getState()
  const sessionManager = getSessionManager()

  // Validate inputs
  if (!meetingUrl || typeof meetingUrl !== 'string' || meetingUrl.trim().length === 0) {
    throw new Error('meetingUrl is required and must be a non-empty string')
  }
  
  try {
    new URL(meetingUrl)
  } catch {
    throw new Error(`Invalid meetingUrl format: ${meetingUrl}`)
  }

  // Validate agent exists
  const agent = agentStore.getProvider(agentConfigId)
  if (!agent) {
    throw new Error(`Agent configuration not found: ${agentConfigId}`)
  }

  // Check session cap (replaces the old isInCall guard)
  if (!sessionStore.canCreateSession()) {
    const limit = useConfigStore.getState().mcpConfig.maxConcurrentSessions
    throw new Error(
      `Maximum concurrent sessions (${limit}) reached. ` +
      `End an existing session before joining a new one.`
    )
  }

  // Derive the display name the same way the UI does
  let agentDisplayName = agent.name
  if (agent.type === 'copilot-studio') {
    agentDisplayName = (agent.settings as Record<string, unknown>).botName as string || agent.name
  } else if (agent.type === 'azure-foundry') {
    const s = agent.settings as Record<string, unknown>
    agentDisplayName = (s.displayName || s.agentName || agent.name) as string
  }

  const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const meetingTitle = `${agentDisplayName} • ${timeLabel}`

  // Create session with SessionManager (creates session + agent + service container)
  const { session, agent: agentInstance } = sessionManager.createSession({
    meetingUrl: meetingUrl.trim(),
    agentConfigId,
    agentName: agentDisplayName,
    title: meetingTitle,
  })

  // Navigate to the sessions page so the user sees the new session
  navStore.setCurrentPage('sessions')

  // Focus this session in the UI
  useSessionStore.getState().setFocusedAgent(session.sessionId, agentInstance.agentInstanceId)

  log.info(
    `MCP: Join meeting requested (session: ${session.sessionId}, agent: ${agentInstance.agentInstanceId}, name: ${agentDisplayName})`
  )

  // Kick off the headless join flow (ACS token → init → join → chat → welcome)
  // This runs async — the MCP response returns immediately with 'joining' status.
  sessionManager.joinMeeting({
    sessionId: session.sessionId,
    agentInstanceId: agentInstance.agentInstanceId,
    meetingUrl: meetingUrl.trim(),
    agentName: agentDisplayName,
    acsEndpoint: configStore.config.acs.endpoint,
    acsAccessKey: configStore.config.acs.accessKey,
    onLog: (msg, level) => log.info(`[Session ${session.sessionId.slice(0, 8)}] [${level}] ${msg}`),
  }).catch((err) => {
    const message = err instanceof Error ? err.message : 'Failed to join meeting'
    log.error(`MCP: Join failed for session ${session.sessionId}: ${message}`)
    const sStore = useSessionStore.getState()
    sStore.updateAgentConnectionStatus(session.sessionId, agentInstance.agentInstanceId, 'error')
    sStore.updateSessionState(session.sessionId, 'error', message)
  })

  return {
    sessionId: session.sessionId,
    status: 'joining',
  }
}



/**
 * Handle leave_meeting tool — triggers meeting leave flow
 *
 * MULTI-SESSION: Uses SessionManager to end the specific session,
 * disposing all agent service containers properly.
 */
export async function handleLeaveMeeting(params: {
  sessionId: string
}): Promise<{ success: boolean; status: string }> {
  const sessionStore = useSessionStore.getState()
  const sessionManager = getSessionManager()
  const session = sessionStore.getSession(params.sessionId)

  if (!session) {
    throw new Error(`Session not found: ${params.sessionId}`)
  }

  if (session.state === 'disconnected' || session.endedAt) {
    throw new Error(`Session ${params.sessionId} is already ended`)
  }

  log.info(`MCP: Leave meeting requested (session: ${params.sessionId})`)

  // Send farewell message via chat before disconnecting
  try {
    for (const agent of Object.values(session.agents)) {
      const container = sessionManager.getContainer(agent.agentInstanceId)
      if (container) {
        const agentName = agent.agentName || 'Agent'
        await container.chatService.sendMessage(`👋 ${agentName} is leaving the meeting. Goodbye!`)
      }
    }
  } catch (err) {
    log.warn(`MCP: Failed to send farewell message: ${err}`)
  }

  // Small delay so participants see the farewell message
  await new Promise(resolve => setTimeout(resolve, 1500))

  // Signal "disconnecting" so the UI transitions immediately (orange badge).
  // Do NOT set 'disconnected' here — endSession() handles the full dispose
  // sequence including TTS waitForCompletion(), then sets final state.
  sessionStore.updateSessionState(params.sessionId, 'disconnecting')

  // Dispose containers gracefully (waits for TTS to finish, then hangs up)
  await sessionManager.endSession(params.sessionId)

  return { success: true, status: 'disconnected' }
}

/**
 * Remove tokens/query params from meeting URL for safe display
 */
function sanitizeMeetingUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.split('?')[0] || url
  }
}

/**
 * Handle list_sessions tool — returns all active sessions
 */
export function handleListSessions(): McpSessionsSummary {
  const sessionStore = useSessionStore.getState()
  const activeSessions = sessionStore.getActiveSessions()

  return {
    totalActive: activeSessions.length,
    maxAllowed: useConfigStore.getState().mcpConfig.maxConcurrentSessions,
    sessions: activeSessions.map((session) => {
      const agents = Object.values(session.agents)
      const primaryAgent = agents[0]
      const uptimeSeconds = Math.floor((Date.now() - session.createdAt) / 1000)

      return {
        sessionId: session.sessionId,
        state: session.state,
        agentName: primaryAgent?.agentName ?? null,
        meetingUrl: sanitizeMeetingUrl(session.meetingUrl),
        connectionStatus: primaryAgent?.connectionStatus ?? 'disconnected',
        uptimeSeconds,
        startedAt: session.createdAt,
        agents: agents.map((a) => ({
          agentInstanceId: a.agentInstanceId,
          agentName: a.agentName,
          agentConfigId: a.agentConfigId,
          state: a.state,
          connectionStatus: a.connectionStatus,
          isInCall: a.isInCall,
        })),
      }
    }),
  }
}
