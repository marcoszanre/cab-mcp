// ============================================
// Session Store — Multi-Session State Management
// Central Zustand store for all active sessions
// ============================================

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import {
  type Session,
  type AgentInstance,
  type AgentInstanceState,
  type SessionState,
  type SessionLimits,
  DEFAULT_SESSION_LIMITS,
  createNewSession,
  createAgentInstance,
  deriveSessionState,
} from '@/types/session'
import type { ConnectionStatus, SpeechState, Caption, Participant, ConversationMessage } from '@/types'
import { useConfigStore } from '@/stores/configStore'
import { loggers } from '@/lib/logger'

const log = loggers.app

// ──────────────────────────────────────────────
// Store Interface
// ──────────────────────────────────────────────

interface SessionStoreState {
  // ── Core state ──
  /** All active/recent sessions, keyed by sessionId */
  sessions: Record<string, Session>
  /** Currently focused session in the UI */
  focusedSessionId: string | null
  /** Currently focused agent instance in the UI */
  focusedAgentInstanceId: string | null
  /** Session limits configuration */
  limits: SessionLimits

  // ── Session lifecycle ──
  createSession: (meetingUrl: string, title?: string) => Session
  endSession: (sessionId: string) => void
  removeSession: (sessionId: string) => void
  updateSessionState: (sessionId: string, state: SessionState, errorMessage?: string) => void

  // ── Agent instance lifecycle ──
  addAgent: (sessionId: string, agentConfigId: string, agentName: string, tabId?: string) => AgentInstance
  removeAgent: (sessionId: string, agentInstanceId: string) => void
  updateAgentState: (sessionId: string, agentInstanceId: string, state: AgentInstanceState, errorMessage?: string) => void

  // ── Per-agent state updates ──
  updateAgentConnectionStatus: (sessionId: string, agentInstanceId: string, status: ConnectionStatus) => void
  updateAgentCallState: (sessionId: string, agentInstanceId: string, patch: Partial<Pick<AgentInstance, 'isInCall' | 'isMuted' | 'muteState' | 'welcomeMessageSent'>>) => void
  updateAgentSpeechState: (sessionId: string, agentInstanceId: string, speechState: SpeechState, speechProgress?: string) => void
  addAgentCaption: (sessionId: string, agentInstanceId: string, caption: Caption) => void
  clearAgentCaptions: (sessionId: string, agentInstanceId: string) => void
  addAgentParticipant: (sessionId: string, agentInstanceId: string, participant: Participant) => void
  removeAgentParticipant: (sessionId: string, agentInstanceId: string, participantId: string) => void
  updateAgentConversation: (sessionId: string, agentInstanceId: string, patch: Partial<Pick<AgentInstance, 'conversationId' | 'conversationMessages'>>) => void
  addAgentConversationMessage: (sessionId: string, agentInstanceId: string, message: ConversationMessage) => void
  setAgentTabId: (sessionId: string, agentInstanceId: string, tabId: string | null) => void

  // ── UI focus ──
  setFocusedSession: (sessionId: string | null) => void
  setFocusedAgent: (sessionId: string | null, agentInstanceId: string | null) => void

  // ── Queries (computed) ──
  getSession: (sessionId: string) => Session | undefined
  getAgent: (sessionId: string, agentInstanceId: string) => AgentInstance | undefined
  getActiveSessions: () => Session[]
  getActiveSessionCount: () => number
  getSessionByAgentInstanceId: (agentInstanceId: string) => { session: Session; agent: AgentInstance } | undefined
  getFocusedSession: () => Session | undefined
  getFocusedAgent: () => AgentInstance | undefined
  canCreateSession: () => boolean
}

// ──────────────────────────────────────────────
// Helper: immutable agent update
// ──────────────────────────────────────────────

function updateAgent(
  sessions: Record<string, Session>,
  sessionId: string,
  agentInstanceId: string,
  updater: (agent: AgentInstance) => AgentInstance
): Record<string, Session> {
  const session = sessions[sessionId]
  if (!session) return sessions
  const agent = session.agents[agentInstanceId]
  if (!agent) return sessions

  const updatedAgent = updater(agent)
  const updatedAgents = { ...session.agents, [agentInstanceId]: updatedAgent }
  const updatedSession: Session = {
    ...session,
    agents: updatedAgents,
    state: deriveSessionState(updatedAgents),
  }
  return { ...sessions, [sessionId]: updatedSession }
}

// ──────────────────────────────────────────────
// Store
// ──────────────────────────────────────────────

export const useSessionStore = create<SessionStoreState>()(
  devtools(
    (set, get) => ({
      // ── Initial state ──
      sessions: {},
      focusedSessionId: null,
      focusedAgentInstanceId: null,
      limits: DEFAULT_SESSION_LIMITS,

      // ── Session lifecycle ──

      createSession: (meetingUrl, title) => {
        const state = get()
        const activeCount = state.getActiveSessionCount()
        const maxSessions = useConfigStore.getState().mcpConfig.maxConcurrentSessions

        if (activeCount >= maxSessions) {
          throw new Error(
            `Maximum concurrent sessions (${maxSessions}) reached. ` +
            `End an existing session before creating a new one.`
          )
        }

        const session = createNewSession({ meetingUrl, title })
        log.info(`Session created: ${session.sessionId} for ${meetingUrl}`)

        set(
          (prev) => ({
            sessions: { ...prev.sessions, [session.sessionId]: session },
          }),
          false,
          'session/create'
        )

        return session
      },

      endSession: (sessionId) => {
        set(
          (prev) => {
            const session = prev.sessions[sessionId]
            if (!session) return prev

            // Mark all agents as disconnected
            const updatedAgents = { ...session.agents }
            for (const [id, agent] of Object.entries(updatedAgents)) {
              if (agent.state !== 'disconnected' && agent.state !== 'error') {
                updatedAgents[id] = {
                  ...agent,
                  state: 'disconnected',
                  isInCall: false,
                  connectionStatus: 'disconnected',
                  endedAt: Date.now(),
                }
              }
            }

            const updatedSession: Session = {
              ...session,
              agents: updatedAgents,
              state: 'disconnected',
              endedAt: Date.now(),
            }

            log.info(`Session ended: ${sessionId}`)

            return {
              sessions: { ...prev.sessions, [sessionId]: updatedSession },
              // Clear focus if this session was focused
              focusedSessionId: prev.focusedSessionId === sessionId ? null : prev.focusedSessionId,
              focusedAgentInstanceId: prev.focusedSessionId === sessionId ? null : prev.focusedAgentInstanceId,
            }
          },
          false,
          'session/end'
        )
      },

      removeSession: (sessionId) => {
        set(
          (prev) => {
            const { [sessionId]: _, ...remaining } = prev.sessions
            log.info(`Session removed: ${sessionId}`)
            return {
              sessions: remaining,
              focusedSessionId: prev.focusedSessionId === sessionId ? null : prev.focusedSessionId,
              focusedAgentInstanceId: prev.focusedSessionId === sessionId ? null : prev.focusedAgentInstanceId,
            }
          },
          false,
          'session/remove'
        )
      },

      updateSessionState: (sessionId, state, errorMessage) => {
        set(
          (prev) => {
            const session = prev.sessions[sessionId]
            if (!session) return prev

            return {
              sessions: {
                ...prev.sessions,
                [sessionId]: {
                  ...session,
                  state,
                  ...(errorMessage ? { errorMessage } : {}),
                  ...(state === 'disconnected' ? { endedAt: Date.now() } : {}),
                },
              },
            }
          },
          false,
          'session/updateState'
        )
      },

      // ── Agent instance lifecycle ──

      addAgent: (sessionId, agentConfigId, agentName, tabId) => {
        const state = get()
        const session = state.sessions[sessionId]

        if (!session) {
          throw new Error(`Session not found: ${sessionId}`)
        }

        const agentCount = Object.keys(session.agents).length
        if (agentCount >= state.limits.maxAgentsPerSession) {
          throw new Error(
            `Maximum agents per session (${state.limits.maxAgentsPerSession}) reached.`
          )
        }

        const agentInstanceId = crypto.randomUUID()
        const agent = createAgentInstance({
          agentInstanceId,
          agentConfigId,
          agentName,
          tabId,
        })

        log.info(`Agent added to session ${sessionId}: ${agentInstanceId} (${agentName})`)

        set(
          (prev) => {
            const s = prev.sessions[sessionId]
            if (!s) return prev

            const updatedAgents = { ...s.agents, [agentInstanceId]: agent }
            return {
              sessions: {
                ...prev.sessions,
                [sessionId]: {
                  ...s,
                  agents: updatedAgents,
                  state: deriveSessionState(updatedAgents),
                },
              },
            }
          },
          false,
          'session/addAgent'
        )

        return agent
      },

      removeAgent: (sessionId, agentInstanceId) => {
        set(
          (prev) => {
            const session = prev.sessions[sessionId]
            if (!session) return prev

            const { [agentInstanceId]: _, ...remainingAgents } = session.agents
            log.info(`Agent removed from session ${sessionId}: ${agentInstanceId}`)

            return {
              sessions: {
                ...prev.sessions,
                [sessionId]: {
                  ...session,
                  agents: remainingAgents,
                  state: deriveSessionState(remainingAgents),
                },
              },
              // Clear agent focus if this agent was focused
              focusedAgentInstanceId:
                prev.focusedAgentInstanceId === agentInstanceId ? null : prev.focusedAgentInstanceId,
            }
          },
          false,
          'session/removeAgent'
        )
      },

      updateAgentState: (sessionId, agentInstanceId, agentState, errorMessage) => {
        set(
          (prev) => ({
            sessions: updateAgent(prev.sessions, sessionId, agentInstanceId, (a) => ({
              ...a,
              state: agentState,
              ...(errorMessage ? { errorMessage } : {}),
              ...(agentState === 'disconnected' ? { endedAt: Date.now(), isInCall: false, connectionStatus: 'disconnected' as const } : {}),
            })),
          }),
          false,
          'session/updateAgentState'
        )
      },

      // ── Per-agent state updates ──

      updateAgentConnectionStatus: (sessionId, agentInstanceId, status) => {
        set(
          (prev) => ({
            sessions: updateAgent(prev.sessions, sessionId, agentInstanceId, (a) => ({
              ...a,
              connectionStatus: status,
            })),
          }),
          false,
          'session/updateAgentConnectionStatus'
        )
      },

      updateAgentCallState: (sessionId, agentInstanceId, patch) => {
        set(
          (prev) => ({
            sessions: updateAgent(prev.sessions, sessionId, agentInstanceId, (a) => ({
              ...a,
              ...patch,
            })),
          }),
          false,
          'session/updateAgentCallState'
        )
      },

      updateAgentSpeechState: (sessionId, agentInstanceId, speechState, speechProgress = '') => {
        set(
          (prev) => ({
            sessions: updateAgent(prev.sessions, sessionId, agentInstanceId, (a) => ({
              ...a,
              speechState,
              speechProgress,
            })),
          }),
          false,
          'session/updateAgentSpeechState'
        )
      },

      addAgentCaption: (sessionId, agentInstanceId, caption) => {
        const limits = get().limits
        set(
          (prev) => ({
            sessions: updateAgent(prev.sessions, sessionId, agentInstanceId, (a) => ({
              ...a,
              captions: [...a.captions, caption].slice(-limits.maxCaptionsPerAgent),
            })),
          }),
          false,
          'session/addAgentCaption'
        )
      },

      clearAgentCaptions: (sessionId, agentInstanceId) => {
        set(
          (prev) => ({
            sessions: updateAgent(prev.sessions, sessionId, agentInstanceId, (a) => ({
              ...a,
              captions: [],
            })),
          }),
          false,
          'session/clearAgentCaptions'
        )
      },

      addAgentParticipant: (sessionId, agentInstanceId, participant) => {
        set(
          (prev) => ({
            sessions: updateAgent(prev.sessions, sessionId, agentInstanceId, (a) => ({
              ...a,
              participants: [...a.participants, participant],
            })),
          }),
          false,
          'session/addAgentParticipant'
        )
      },

      removeAgentParticipant: (sessionId, agentInstanceId, participantId) => {
        set(
          (prev) => ({
            sessions: updateAgent(prev.sessions, sessionId, agentInstanceId, (a) => ({
              ...a,
              participants: a.participants.filter((p) => p.id !== participantId),
            })),
          }),
          false,
          'session/removeAgentParticipant'
        )
      },

      updateAgentConversation: (sessionId, agentInstanceId, patch) => {
        set(
          (prev) => ({
            sessions: updateAgent(prev.sessions, sessionId, agentInstanceId, (a) => ({
              ...a,
              ...patch,
            })),
          }),
          false,
          'session/updateAgentConversation'
        )
      },

      addAgentConversationMessage: (sessionId, agentInstanceId, message) => {
        set(
          (prev) => ({
            sessions: updateAgent(prev.sessions, sessionId, agentInstanceId, (a) => ({
              ...a,
              conversationMessages: [...a.conversationMessages, message],
            })),
          }),
          false,
          'session/addAgentConversationMessage'
        )
      },

      setAgentTabId: (sessionId, agentInstanceId, tabId) => {
        set(
          (prev) => ({
            sessions: updateAgent(prev.sessions, sessionId, agentInstanceId, (a) => ({
              ...a,
              tabId,
            })),
          }),
          false,
          'session/setAgentTabId'
        )
      },

      // ── UI focus ──

      setFocusedSession: (sessionId) => {
        set({ focusedSessionId: sessionId }, false, 'session/setFocusedSession')
      },

      setFocusedAgent: (sessionId, agentInstanceId) => {
        set(
          { focusedSessionId: sessionId, focusedAgentInstanceId: agentInstanceId },
          false,
          'session/setFocusedAgent'
        )
      },

      // ── Queries ──

      getSession: (sessionId) => {
        return get().sessions[sessionId]
      },

      getAgent: (sessionId, agentInstanceId) => {
        return get().sessions[sessionId]?.agents[agentInstanceId]
      },

      getActiveSessions: () => {
        return Object.values(get().sessions).filter(
          (s) => s.state !== 'disconnected' && s.state !== 'error' && !s.endedAt
        )
      },

      getActiveSessionCount: () => {
        return Object.values(get().sessions).filter(
          (s) => s.state !== 'disconnected' && s.state !== 'error' && !s.endedAt
        ).length
      },

      getSessionByAgentInstanceId: (agentInstanceId) => {
        for (const session of Object.values(get().sessions)) {
          const agent = session.agents[agentInstanceId]
          if (agent) return { session, agent }
        }
        return undefined
      },

      getFocusedSession: () => {
        const { focusedSessionId, sessions } = get()
        return focusedSessionId ? sessions[focusedSessionId] : undefined
      },

      getFocusedAgent: () => {
        const { focusedSessionId, focusedAgentInstanceId, sessions } = get()
        if (!focusedSessionId || !focusedAgentInstanceId) return undefined
        return sessions[focusedSessionId]?.agents[focusedAgentInstanceId]
      },

      canCreateSession: () => {
        const state = get()
        return state.getActiveSessionCount() < useConfigStore.getState().mcpConfig.maxConcurrentSessions
      },
    }),
    { name: 'session-store' }
  )
)

// ──────────────────────────────────────────────
// Selectors (for React component subscriptions)
// ──────────────────────────────────────────────

export const selectActiveSessions = (state: SessionStoreState) =>
  Object.values(state.sessions).filter(
    (s) => s.state !== 'disconnected' && s.state !== 'error' && !s.endedAt
  )
