// ============================================
// Sessions Dashboard Page
// Shows active sessions with a terminal-style log view
// ============================================

import { useCallback, useState, useEffect, useRef, useMemo } from 'react'
import { useSessionStore, selectActiveSessions } from '@/stores/sessionStore'
import { useConfigStore } from '@/stores/configStore'
import { useAppStore } from '@/stores/appStore'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { Session } from '@/types/session'
import { 
  Radio, 
  XCircle,
  Activity,
  Layers,
  Terminal,
  BrainCircuit,
} from 'lucide-react'

// ── Helpers ──

function formatUptime(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  return `${hours}:${mins.toString().padStart(2, '0')}:00`
}

function formatTime(date: Date | number | string): string {
  const d = date instanceof Date ? date : new Date(date)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function getStateColor(state: string): string {
  switch (state) {
    case 'connected': return 'bg-green-400'
    case 'connecting': case 'initializing': return 'bg-yellow-400 animate-pulse'
    case 'disconnecting': return 'bg-orange-400'
    case 'error': return 'bg-red-400'
    default: return 'bg-gray-400'
  }
}

function getStateBadgeVariant(state: string): 'default' | 'success' | 'warning' | 'destructive' | 'secondary' {
  switch (state) {
    case 'connected': return 'success'
    case 'connecting': case 'initializing': return 'warning'
    case 'error': return 'destructive'
    default: return 'secondary'
  }
}

// ── HTML Mention Stripping ──

/**
 * Strip Teams HTML chat formatting and convert @mentions to readable text.
 * Teams sends chat messages with HTML like:
 *   <p><span itemtype="http://schema.skype.com/Mention" ...>Name</span>, what about France?</p>
 * This converts it to: "@Name, what about France?"
 */
function stripHtmlMentions(html: string): string {
  if (!html.includes('<')) return html // Fast path: no HTML

  // Replace mention spans with @Name
  let text = html.replace(
    /<span[^>]*itemtype="http:\/\/schema\.skype\.com\/Mention"[^>]*>([^<]*)<\/span>/gi,
    '@$1'
  )

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, '')

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

  // Collapse multiple spaces
  text = text.replace(/\s+/g, ' ').trim()

  return text
}

// ── Terminal Log Entry Types ──

interface TerminalEntry {
  id: string
  timestamp: Date
  type: 'caption' | 'agent' | 'system' | 'chat' | 'error'
  text: string
  meta?: string
}

function buildTerminalEntries(session: Session): TerminalEntry[] {
  const entries: TerminalEntry[] = []
  const agents = Object.values(session.agents)

  // System entry for session start
  entries.push({
    id: `sys-start-${session.sessionId}`,
    timestamp: new Date(session.createdAt),
    type: 'system',
    text: `Session started: ${session.title || 'Meeting'}`,
    meta: session.meetingUrl.replace(/^https?:\/\//, '').split('?')[0],
  })

  // Agent state entries
  for (const agent of agents) {
    if (agent.state === 'connected') {
      entries.push({
        id: `sys-connected-${agent.agentInstanceId}`,
        timestamp: new Date(agent.startedAt),
        type: 'system',
        text: `${agent.agentName} connected to meeting`,
      })
    }

    // Captions
    for (const caption of agent.captions) {
      entries.push({
        id: `cap-${caption.id}`,
        timestamp: caption.timestamp instanceof Date ? caption.timestamp : new Date(caption.timestamp),
        type: 'caption',
        text: caption.text,
        meta: caption.speaker,
      })
    }

    // Conversation messages (agent ↔ user)
    for (const msg of agent.conversationMessages) {
      const rawText = msg.text ?? msg.content ?? ''
      const cleaned = stripHtmlMentions(rawText)

      // Extract sender from "[Chat] SenderName: message" format
      const chatMatch = cleaned.match(/^\[Chat\]\s+(.+?):\s+(.*)$/s)
      const sender = chatMatch ? chatMatch[1] : undefined
      const messageText = chatMatch ? chatMatch[2] : cleaned

      entries.push({
        id: `msg-${msg.id}`,
        timestamp: msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp),
        type: msg.role === 'assistant' ? 'agent' : 'chat',
        text: messageText,
        meta: msg.role === 'assistant' ? agent.agentName : (sender || undefined),
      })
    }

    // Error
    if (agent.state === 'error' && agent.errorMessage) {
      entries.push({
        id: `err-${agent.agentInstanceId}`,
        timestamp: new Date(agent.endedAt || Date.now()),
        type: 'error',
        text: agent.errorMessage,
      })
    }
  }

  // Sort chronologically
  entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  return entries
}

// ── Terminal Log Line ──

function TerminalLine({ entry }: { entry: TerminalEntry }) {
  const colors: Record<string, string> = {
    caption: 'text-slate-400',
    agent: 'text-emerald-400',
    system: 'text-amber-400',
    chat: 'text-blue-400',
    error: 'text-red-400',
  }
  const prefixes: Record<string, string> = {
    caption: '🎤',
    agent: '🤖',
    system: '⚡',
    chat: '💬',
    error: '❌',
  }

  return (
    <div className="flex gap-2 py-0.5 font-mono text-xs leading-relaxed group hover:bg-white/5">
      <span className="text-slate-600 shrink-0 select-none w-[72px]">
        {formatTime(entry.timestamp)}
      </span>
      <span className="shrink-0 w-4 text-center select-none">{prefixes[entry.type]}</span>
      <span className={cn('shrink-0 select-none', colors[entry.type])}>
        {entry.meta ? `[${entry.meta}]` : `[${entry.type}]`}
      </span>
      <span className="text-slate-300 break-words min-w-0">{entry.text}</span>
    </div>
  )
}

// ── Terminal Log View ──

function SessionTerminal({ session }: { session: Session }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const entries = useMemo(() => buildTerminalEntries(session), [session])
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [entries.length, autoScroll])

  const agents = Object.values(session.agents)
  const primaryAgent = agents[0]

  return (
    <div className="flex flex-col h-full">
      {/* Terminal header bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-700 rounded-t-lg shrink-0">
        <div className="flex items-center gap-3">
          <Terminal className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-medium text-slate-200 truncate max-w-[300px]">
            {session.title || 'Meeting Session'}
          </span>
          <Badge variant={getStateBadgeVariant(session.state)} className="gap-1 text-[10px]">
            <span className={cn('w-1.5 h-1.5 rounded-full', getStateColor(session.state))} />
            {session.state}
          </Badge>
        </div>
        <div className="flex items-center gap-4 text-[11px] text-slate-500">
          <span className="flex items-center gap-1"><BrainCircuit className="w-3 h-3" />{primaryAgent?.agentName ?? '—'}</span>
        </div>
      </div>

      {/* Agent status pills */}
      {agents.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-slate-900/80 border-b border-slate-800 shrink-0">
          {agents.map(agent => (
            <div key={agent.agentInstanceId} className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-800 text-[11px]">
              <span className={cn('w-1.5 h-1.5 rounded-full', getStateColor(agent.state))} />
              <span className="text-slate-300 font-medium">{agent.agentName}</span>
              <span className="text-slate-600">{agent.connectionStatus}</span>
            </div>
          ))}
        </div>
      )}

      {/* Terminal body */}
      <div className="flex-1 bg-slate-950 overflow-y-auto px-4 py-2 min-h-0 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent"
        onScroll={(e) => {
          const el = e.currentTarget
          const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          setAutoScroll(isAtBottom)
        }}
      >
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-600 text-sm">
            <div className="text-center space-y-2">
              <Terminal className="w-8 h-8 mx-auto opacity-50" />
              <p>Waiting for events...</p>
              <p className="text-xs text-slate-700">Captions, agent responses, and system events will appear here.</p>
            </div>
          </div>
        ) : (
          <>
            {entries.map(entry => (
              <TerminalLine key={entry.id} entry={entry} />
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Terminal footer */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-slate-900 border-t border-slate-700 rounded-b-lg shrink-0 text-[10px] text-slate-600">
        <span>{entries.length} events</span>
        <span>{session.sessionId.slice(0, 8)}</span>
      </div>
    </div>
  )
}

// ── Session Card (compact) ──

function SessionCard({ session, isSelected, onClick, onEnd, onDismiss }: {
  session: Session
  isSelected: boolean
  onClick: () => void
  onEnd: (sessionId: string) => void
  onDismiss: (sessionId: string) => void
}) {
  const agents = Object.values(session.agents)
  const primaryAgent = agents[0]
  const isActive = session.state === 'connected' || session.state === 'connecting' || session.state === 'initializing'

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all border',
        isSelected
          ? 'bg-primary/10 border-primary/30 shadow-sm'
          : 'border-transparent hover:bg-muted/50',
        !isActive && 'opacity-50',
      )}
      onClick={onClick}
    >
      <span className={cn('w-2 h-2 rounded-full shrink-0', getStateColor(session.state))} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{primaryAgent?.agentName ?? 'Session'}</span>
          <span className="text-[10px] text-muted-foreground">{formatUptime(session.createdAt)}</span>
        </div>
        <p className="text-[11px] text-muted-foreground truncate">
          {session.title || session.meetingUrl.replace(/^https?:\/\//, '').split('?')[0]}
        </p>
      </div>
      {isActive ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-destructive hover:text-destructive shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            onEnd(session.sessionId)
          }}
        >
          <XCircle className="w-3.5 h-3.5" />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            onDismiss(session.sessionId)
          }}
        >
          <XCircle className="w-3.5 h-3.5" />
        </Button>
      )}
    </div>
  )
}

// ── Empty State ──

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
        <Layers className="w-8 h-8 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-medium">No Active Sessions</h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        Sessions will appear here when agents join meetings.
        Use MCP tools (<code className="text-xs bg-muted px-1 py-0.5 rounded">join_meeting</code>) to start a session.
      </p>
    </div>
  )
}

// ── App Logs Terminal ──

function AppLogsTerminal() {
  const logs = useAppStore((s) => s.logs)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  const typeColors: Record<string, string> = {
    info: 'text-slate-400',
    success: 'text-emerald-400',
    warning: 'text-amber-400',
    error: 'text-red-400',
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 bg-slate-900 border-b border-slate-700 rounded-t-lg shrink-0">
        <Terminal className="w-4 h-4 text-slate-500" />
        <span className="text-sm font-medium text-slate-400">MCP Bridge Logs</span>
      </div>
      <div className="flex-1 bg-slate-950 overflow-y-auto px-4 py-2 min-h-0 scrollbar-thin scrollbar-thumb-slate-700">
        {logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-600 text-sm">
            No logs yet
          </div>
        ) : (
          <>
            {logs.map(log => (
              <div key={log.id} className="flex gap-2 py-0.5 font-mono text-xs leading-relaxed">
                <span className="text-slate-600 shrink-0 w-[72px]">{formatTime(log.timestamp)}</span>
                <span className={cn('shrink-0 w-[52px]', typeColors[log.type])}>[{log.type}]</span>
                <span className="text-slate-300 break-words min-w-0">{log.message}</span>
              </div>
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>
      <div className="px-4 py-1 bg-slate-900 border-t border-slate-700 rounded-b-lg shrink-0 text-[10px] text-slate-600">
        {logs.length} entries
      </div>
    </div>
  )
}

// ── Main Page ──

export function SessionsPage() {
  const activeSessions = useSessionStore(selectActiveSessions)
  const allSessions = useSessionStore((s) => Object.values(s.sessions))
  const removeSession = useSessionStore((s) => s.removeSession)
  const maxConcurrentSessions = useConfigStore((s) => s.mcpConfig.maxConcurrentSessions)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)

  // Auto-select first active session if none selected
  useEffect(() => {
    if (!selectedSessionId || !allSessions.find(s => s.sessionId === selectedSessionId)) {
      if (activeSessions.length > 0) {
        setSelectedSessionId(activeSessions[0].sessionId)
      }
    }
  }, [activeSessions, selectedSessionId, allSessions])

  const handleEnd = useCallback(async (sessionId: string) => {
    const { getSessionManager } = await import('@/services/sessionManager')
    const sessionManager = getSessionManager()
    await sessionManager.endSession(sessionId)
  }, [])

  const handleDismiss = useCallback((sessionId: string) => {
    removeSession(sessionId)
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null)
    }
  }, [removeSession, selectedSessionId])

  const selectedSession = allSessions.find(s => s.sessionId === selectedSessionId)

  // Include recently ended sessions in the sidebar list
  const sortedSessions = useMemo(() => {
    return [...allSessions].sort((a, b) => {
      // Active sessions first
      const aActive = ['connected', 'connecting', 'initializing'].includes(a.state) ? 0 : 1
      const bActive = ['connected', 'connecting', 'initializing'].includes(b.state) ? 0 : 1
      if (aActive !== bActive) return aActive - bActive
      return b.createdAt - a.createdAt
    })
  }, [allSessions])

  // No sessions at all
  if (allSessions.length === 0) {
    return (
      <div className="h-full p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <Activity className="w-6 h-6 text-primary" />
              Sessions
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {activeSessions.length} active / {maxConcurrentSessions} max
            </p>
          </div>
          <Badge variant="secondary" className="gap-1.5">
            <Radio className="w-3 h-3" />
            {activeSessions.length} live
          </Badge>
        </div>
        <EmptyState />
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Session list sidebar */}
      <div className="w-72 shrink-0 border-r border-border/40 flex flex-col h-full">
        <div className="px-4 py-3 border-b border-border/40 shrink-0">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            Sessions
            <Badge variant="secondary" className="text-[10px] ml-auto">
              {activeSessions.length}/{maxConcurrentSessions}
            </Badge>
          </h2>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-0.5">
            {sortedSessions.map(session => (
              <SessionCard
                key={session.sessionId}
                session={session}
                isSelected={session.sessionId === selectedSessionId}
                onClick={() => setSelectedSessionId(session.sessionId)}
                onEnd={handleEnd}
                onDismiss={handleDismiss}
              />
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Main content: Terminal log view */}
      <div className="flex-1 flex flex-col min-w-0 p-4 gap-4 overflow-hidden">
        {selectedSession ? (
          <div className="flex-1 min-h-0 rounded-lg overflow-hidden border border-slate-700">
            <SessionTerminal session={selectedSession} />
          </div>
        ) : (
          <div className="flex-1 min-h-0 rounded-lg overflow-hidden border border-slate-700">
            <AppLogsTerminal />
          </div>
        )}
      </div>
    </div>
  )
}
