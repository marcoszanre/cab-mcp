// ============================================
// Multi-Session Architecture Types
// Supports parallel sessions with multiple agents per session
// ============================================

// ──────────────────────────────────────────────
// Session State Machine
// ──────────────────────────────────────────────

export type SessionState =
  | 'initializing'    // Session created, agents being set up
  | 'connecting'      // At least one agent is connecting
  | 'connected'       // At least one agent is in the meeting
  | 'disconnecting'   // Leave requested, agents tearing down
  | 'disconnected'    // Clean exit, all agents left
  | 'error'           // All agents failed

export type AgentInstanceState =
  | 'initializing'    // ACS identity being generated
  | 'connecting'      // ACS call in progress
  | 'connected'       // In meeting, active
  | 'disconnecting'   // Leave requested
  | 'disconnected'    // Clean exit
  | 'error'           // Failed

// ──────────────────────────────────────────────
// Agent Instance — one agent connected to a meeting
// ──────────────────────────────────────────────

export interface AgentCaption {
  id: string
  speaker: string
  text: string
  timestamp: Date
  isFinal: boolean
}

export interface AgentParticipant {
  id: string
  displayName: string
  isMuted: boolean
  isSpeaking: boolean
}

/**
 * Per-agent runtime state within a session.
 * One agent instance = one ACS identity in the meeting.
 */
export interface AgentInstance {
  /** Unique ID for this agent instance (UUID) */
  agentInstanceId: string
  /** Reference to the agent configuration (provider config ID) */
  agentConfigId: string
  /** Display name used in the meeting */
  agentName: string
  /** Current connection state */
  state: AgentInstanceState
  /** Detailed connection status */
  connectionStatus: import('@/types').ConnectionStatus
  /** When this agent joined */
  startedAt: number
  /** When this agent left */
  endedAt?: number
  /** Error message if state is 'error' */
  errorMessage?: string

  // ── Call state ──
  isInCall: boolean
  isMuted: boolean
  muteState: import('@/types').MuteState
  welcomeMessageSent: boolean

  // ── Speech/TTS state ──
  speechState: import('@/types').SpeechState
  speechProgress: string

  // ── Participants & Captions ──
  participants: AgentParticipant[]
  captions: AgentCaption[]

  // ── Conversation state ──
  conversationId: string | null
  conversationMessages: import('@/types').ConversationMessage[]

  // ── Tab linkage ──
  /** Tab ID in the UI (if any) */
  tabId: string | null
}

// ──────────────────────────────────────────────
// Session — a meeting context with 1+ agents
// ──────────────────────────────────────────────

/**
 * A session represents a meeting context.
 * It can have one or more agent instances connected to it.
 * Each agent gets its own ACS identity, call, TTS, etc.
 */
export interface Session {
  /** Unique session ID (UUID) */
  sessionId: string
  /** Teams meeting URL */
  meetingUrl: string
  /** Overall session state (derived from agent states) */
  state: SessionState
  /** When the session was created */
  createdAt: number
  /** When the session ended (all agents left) */
  endedAt?: number
  /** Error message if state is 'error' */
  errorMessage?: string

  /** Agents connected to this session, keyed by agentInstanceId */
  agents: Record<string, AgentInstance>

  /** Optional human-readable title */
  title?: string
}

// ──────────────────────────────────────────────
// Session Configuration & Limits
// ──────────────────────────────────────────────

export interface SessionLimits {
  /** Maximum agents per session (default: 5) */
  maxAgentsPerSession: number
  /** Maximum captions kept per agent (default: 500) */
  maxCaptionsPerAgent: number
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  maxAgentsPerSession: 5,
  maxCaptionsPerAgent: 500,
}

// ──────────────────────────────────────────────
// Legacy compatibility — MeetingSession
// (kept for backward compat during migration)
// ──────────────────────────────────────────────

export interface MeetingSession {
  /** UUID v4, generated on join */
  sessionId: string
  /** Which agent config was used */
  agentConfigId: string
  /** Agent display name */
  agentName: string
  /** Teams meeting URL (sanitized — no tokens) */
  meetingUrl: string
  /** Current session state */
  state: SessionState
  /** Unix timestamp (ms) when session was created */
  startedAt: number
  /** Unix timestamp (ms) when session ended */
  endedAt?: number
  /** Optional error message if state is 'error' */
  errorMessage?: string
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Derive overall session state from agent instance states.
 * - If any agent is connected → session is connected
 * - If any agent is connecting → session is connecting
 * - If all are disconnected → session is disconnected
 * - If all are error → session is error
 */
export function deriveSessionState(agents: Record<string, AgentInstance>): SessionState {
  const states = Object.values(agents).map(a => a.state)

  if (states.length === 0) return 'initializing'
  if (states.some(s => s === 'connected')) return 'connected'
  if (states.some(s => s === 'connecting')) return 'connecting'
  if (states.some(s => s === 'disconnecting')) return 'disconnecting'
  if (states.some(s => s === 'initializing')) return 'initializing'
  if (states.every(s => s === 'error')) return 'error'
  return 'disconnected'
}

/**
 * Create a new AgentInstance with default values.
 */
export function createAgentInstance(params: {
  agentInstanceId: string
  agentConfigId: string
  agentName: string
  tabId?: string
}): AgentInstance {
  return {
    agentInstanceId: params.agentInstanceId,
    agentConfigId: params.agentConfigId,
    agentName: params.agentName,
    state: 'initializing',
    connectionStatus: 'disconnected',
    startedAt: Date.now(),
    isInCall: false,
    isMuted: false,
    muteState: 'unknown',
    welcomeMessageSent: false,
    speechState: 'idle',
    speechProgress: '',
    participants: [],
    captions: [],
    conversationId: null,
    conversationMessages: [],
    tabId: params.tabId ?? null,
  }
}

/**
 * Create a new empty Session.
 */
export function createNewSession(params: {
  meetingUrl: string
  title?: string
}): Session {
  return {
    sessionId: crypto.randomUUID(),
    meetingUrl: params.meetingUrl,
    state: 'initializing',
    createdAt: Date.now(),
    agents: {},
    title: params.title,
  }
}
