// ============================================
// useSessionState — Per-session state selector hook
// Replaces direct callStore subscriptions for multi-session
// ============================================

import { useSessionStore } from '@/stores/sessionStore'
import { useConfigStore } from '@/stores/configStore'
import type { Session, AgentInstance } from '@/types/session'

/**
 * Subscribe to a specific session's state.
 * Returns undefined if the session doesn't exist.
 */
export function useSession(sessionId: string | null): Session | undefined {
  return useSessionStore((state) =>
    sessionId ? state.sessions[sessionId] : undefined
  )
}

/**
 * Subscribe to a specific agent instance's state within a session.
 * Returns undefined if the session or agent doesn't exist.
 */
export function useAgentInstance(
  sessionId: string | null,
  agentInstanceId: string | null
): AgentInstance | undefined {
  return useSessionStore((state) => {
    if (!sessionId || !agentInstanceId) return undefined
    return state.sessions[sessionId]?.agents[agentInstanceId]
  })
}

/**
 * Subscribe to the currently focused session.
 */
export function useFocusedSession(): Session | undefined {
  return useSessionStore((state) => {
    const id = state.focusedSessionId
    return id ? state.sessions[id] : undefined
  })
}

/**
 * Subscribe to the currently focused agent instance.
 */
export function useFocusedAgent(): AgentInstance | undefined {
  return useSessionStore((state) => {
    const { focusedSessionId, focusedAgentInstanceId } = state
    if (!focusedSessionId || !focusedAgentInstanceId) return undefined
    return state.sessions[focusedSessionId]?.agents[focusedAgentInstanceId]
  })
}

/**
 * Subscribe to the list of all active sessions.
 */
export function useActiveSessions(): Session[] {
  return useSessionStore((state) =>
    Object.values(state.sessions).filter(
      (s) => s.state !== 'disconnected' && s.state !== 'error' && !s.endedAt
    )
  )
}

/**
 * Subscribe to the count of active sessions.
 */
export function useActiveSessionCount(): number {
  return useSessionStore((state) =>
    Object.values(state.sessions).filter(
      (s) => s.state !== 'disconnected' && s.state !== 'error' && !s.endedAt
    ).length
  )
}

/**
 * Subscribe to all sessions (including ended ones).
 */
export function useAllSessions(): Session[] {
  return useSessionStore((state) => Object.values(state.sessions))
}

/**
 * Get a specific agent's connection status.
 */
export function useAgentConnectionStatus(
  sessionId: string | null,
  agentInstanceId: string | null
): string {
  return useSessionStore((state) => {
    if (!sessionId || !agentInstanceId) return 'disconnected'
    return state.sessions[sessionId]?.agents[agentInstanceId]?.connectionStatus ?? 'disconnected'
  })
}

/**
 * Check if we can create a new session (cap not reached).
 */
export function useCanCreateSession(): boolean {
  const maxSessions = useConfigStore((s) => s.mcpConfig.maxConcurrentSessions)
  return useSessionStore((state) => {
    const activeCount = Object.values(state.sessions).filter(
      (s) => s.state !== 'disconnected' && s.state !== 'error' && !s.endedAt
    ).length
    return activeCount < maxSessions
  })
}
