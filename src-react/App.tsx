import { Suspense, lazy, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/tauri'
import { useNavigationStore } from '@/stores/navigationStore'
import { usePreferencesStore, applyTheme } from '@/stores/preferencesStore'
import { useConfigStore } from '@/stores/configStore'
import { useSessionStore } from '@/stores/sessionStore'
import { AppShell } from '@/components/layout/AppShell'
import { SessionsPage } from '@/components/pages/SessionsPage'
import { useMcpBridge } from '@/hooks/useMcpBridge'
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup'
import { useAgentProvidersStore } from '@/stores/agentProvidersStore'
import { loggers } from '@/lib/logger'
import { markStartupComplete, recordStartupPhase } from '@/lib/startupDiagnostics'

const log = loggers.app
const AgentsPage = lazy(async () => {
  const module = await import('@/components/pages/AgentsPage')
  return { default: module.AgentsPage }
})
const SettingsPage = lazy(async () => {
  const module = await import('@/components/pages/SettingsPage')
  return { default: module.SettingsPage }
})

function sanitizeMeetingUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.split('?')[0] || url
  }
}

async function getDevSessionManager() {
  const { getSessionManager } = await import('@/services/sessionManager')
  return getSessionManager()
}

function getDevSessionSummary() {
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
        agents: agents.map((agent) => ({
          agentInstanceId: agent.agentInstanceId,
          agentName: agent.agentName,
          agentConfigId: agent.agentConfigId,
          state: agent.state,
          connectionStatus: agent.connectionStatus,
          isInCall: agent.isInCall,
        })),
      }
    }),
  }
}

// ── DEV: Expose multi-session test helpers on window.cab ──
// Open F12 Console and use: cab.fake(), cab.fakeN(3), cab.status(), cab.endAll()
if (import.meta.env.DEV) {
  const cab = {
    sessionStore: useSessionStore,
    getSessionManager: getDevSessionManager,

    /** Create a fake session (no real ACS — just store + UI state) */
    fake: (agentName?: string, meetingUrl?: string) => {
      const url = meetingUrl || `https://teams.microsoft.com/l/meetup-join/fake-${Date.now()}`
      const name = agentName || `TestBot-${Math.random().toString(36).slice(2, 6)}`
      const store = useSessionStore.getState()
      const session = store.createSession(url, `Fake: ${name}`)
      const agent = store.addAgent(session.sessionId, 'fake-config', name)
      store.updateAgentState(session.sessionId, agent.agentInstanceId, 'connecting')
      setTimeout(() => {
        const s = useSessionStore.getState()
        if (s.sessions[session.sessionId]?.agents[agent.agentInstanceId]) {
          s.updateAgentState(session.sessionId, agent.agentInstanceId, 'connected')
          s.updateAgentConnectionStatus(session.sessionId, agent.agentInstanceId, 'connected')
          s.updateAgentCallState(session.sessionId, agent.agentInstanceId, { isInCall: true })
        }
      }, 1500)
      console.log(`✅ Fake session: ${session.sessionId.slice(0, 8)} / agent: ${agent.agentInstanceId.slice(0, 8)} (${name})`)
      return { sessionId: session.sessionId, agentInstanceId: agent.agentInstanceId }
    },

    /** Create N fake sessions at once */
    fakeN: (count: number) => {
      const results = []
      for (let i = 0; i < count; i++) {
        results.push(cab.fake(`Bot-${i + 1}`))
      }
      console.log(`✅ Created ${count} fake sessions`)
      return results
    },

    /** Show all session status (mimics MCP list_sessions) */
    status: () => {
      const result = getDevSessionSummary()
      console.log(`Active: ${result.totalActive}/${result.maxAllowed}`)
      console.table(result.sessions.map((s) => ({
        id: s.sessionId ? s.sessionId.slice(0, 8) : '',
        state: s.state,
        agent: s.agentName,
        connection: s.connectionStatus,
        uptime: `${s.uptimeSeconds}s`,
      })))
      return result
    },

    /** List sessions (alias) */
    list: () => getDevSessionSummary(),

    /** End a session by ID prefix (first few chars is enough) */
    end: async (sessionIdPrefix: string) => {
      const store = useSessionStore.getState()
      const match = Object.keys(store.sessions).find(id => id.startsWith(sessionIdPrefix))
      if (!match) { console.error(`❌ No session starting with "${sessionIdPrefix}"`); return }
      const sessionManager = await getDevSessionManager()
      await sessionManager.endSession(match)
      console.log(`✅ Session ${match.slice(0, 8)} ended`)
    },

    /** End all sessions */
    endAll: async () => {
      const sessionManager = await getDevSessionManager()
      await sessionManager.endAllSessions()
      // Also clear ended sessions from the store for a clean slate
      useSessionStore.setState({ sessions: {} })
      console.log('✅ All sessions ended and cleared')
    },

    /** Add a fake caption to the first agent of a session */
    caption: (sessionIdPrefix: string, text?: string) => {
      const store = useSessionStore.getState()
      const match = Object.keys(store.sessions).find(id => id.startsWith(sessionIdPrefix))
      if (!match) { console.error(`❌ No session starting with "${sessionIdPrefix}"`); return }
      const agents = Object.values(store.sessions[match].agents)
      if (agents.length === 0) { console.error('❌ No agents in session'); return }
      store.addAgentCaption(match, agents[0].agentInstanceId, {
        id: crypto.randomUUID(),
        speaker: 'Test Speaker',
        text: text || `Test caption at ${new Date().toLocaleTimeString()}`,
        timestamp: new Date(),
        isFinal: true,
      })
      console.log('✅ Caption added')
    },

    /** Add a second agent to an existing session (simulates a team) */
    addAgent: (sessionIdPrefix: string, agentName?: string) => {
      const store = useSessionStore.getState()
      const match = Object.keys(store.sessions).find(id => id.startsWith(sessionIdPrefix))
      if (!match) { console.error(`❌ No session starting with "${sessionIdPrefix}"`); return }
      const name = agentName || `TeamBot-${Math.random().toString(36).slice(2, 6)}`
      const agent = store.addAgent(match, 'fake-config-2', name)
      store.updateAgentState(match, agent.agentInstanceId, 'connected')
      store.updateAgentConnectionStatus(match, agent.agentInstanceId, 'connected')
      store.updateAgentCallState(match, agent.agentInstanceId, { isInCall: true })
      console.log(`✅ Agent ${agent.agentInstanceId.slice(0, 8)} (${name}) added to session ${match.slice(0, 8)}`)
      return agent
    },
  }
  ;(window as unknown as Record<string, unknown>).cab = cab
  log.info('🧪 DEV: Multi-session test helpers on window.cab — type cab in console')
}

function App() {
  const currentPage = useNavigationStore((state) => state.currentPage)
  const theme = usePreferencesStore((state) => state.preferences.ui?.theme || 'light')
  
  // Initialize provider instances from config (single initialization point)
  // Provider registry removed — services are created on-demand by AgentServiceContainer

  // MCP bridge: listen for tool calls from Rust MCP server
  useMcpBridge()

  // Auto-remove ended sessions after configurable retention period
  useSessionAutoCleanup()

  // Load config + agents from the config file on mount
  useEffect(() => {
    void (async () => {
      await useConfigStore.getState().loadFromConfigFile()
      await useAgentProvidersStore.getState().loadFromConfigFile()
      // Sync meeting behavior (auto-leave) from config file → preferences store
      const { meetingBehavior } = useConfigStore.getState()
      if (meetingBehavior?.autoLeave) {
        usePreferencesStore.getState().setIdleTimeout(meetingBehavior.autoLeave)
      }
    })()
  }, [])

  // Auto-start MCP server if configured (waits for config file load)
  const mcpAutoStarted = useRef(false)
  const startupMarked = useRef(false)
  const mcpConfig = useConfigStore((s) => s.mcpConfig)
  const configFileLoaded = useConfigStore((s) => s.configFileLoaded)

  useEffect(() => {
    if (startupMarked.current) {
      return
    }

    startupMarked.current = true
    recordStartupPhase('app-mounted', {
      currentPage,
      theme,
    })
    markStartupComplete({
      currentPage,
      theme,
    })
  }, [currentPage, theme])

  useEffect(() => {
    if (configFileLoaded && mcpConfig.autoStart && !mcpAutoStarted.current && mcpConfig.apiKey) {
      mcpAutoStarted.current = true
      invoke('start_mcp_server', {
        port: mcpConfig.port,
        apiKey: mcpConfig.apiKey,
      })
        .then(() => log.info(`MCP server auto-started on port ${mcpConfig.port}`))
        .catch((err) => log.error('MCP auto-start failed:', undefined, err))
    }
  }, [configFileLoaded, mcpConfig.autoStart, mcpConfig.port, mcpConfig.apiKey])

  // Apply theme on mount and when it changes
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const renderContent = () => {
    if (currentPage === 'home' || currentPage === 'sessions') {
      return <SessionsPage />
    }
    if (currentPage === 'agents') {
      return <AgentsPage />
    }
    if (currentPage === 'settings') {
      return <SettingsPage />
    }
    return <SessionsPage />
  }

  return (
    <AppShell>
      <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading page...</div>}>
        {renderContent()}
      </Suspense>
    </AppShell>
  )
}

export default App
