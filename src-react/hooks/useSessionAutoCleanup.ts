import { useEffect } from 'react'
import { useSessionStore } from '@/stores/sessionStore'
import { useConfigStore } from '@/stores/configStore'
import { loggers } from '@/lib/logger'

const log = loggers.app
const POLL_INTERVAL_MS = 10_000

/**
 * Global hook that auto-removes ended sessions after the configured retention period.
 * Mount once at the App level so cleanup runs regardless of which page is active.
 */
export function useSessionAutoCleanup() {
  const retentionMinutes = useConfigStore((s) => s.mcpConfig.sessionRetentionMinutes)
  const hasEndedSessions = useSessionStore((s) =>
    Object.values(s.sessions).some(
      (session) =>
        (session.state === 'disconnected' || session.state === 'error') &&
        Boolean(session.endedAt)
    )
  )

  useEffect(() => {
    if (!hasEndedSessions) {
      return
    }

    const retentionMs = (retentionMinutes ?? 5) * 60_000

    const interval = setInterval(() => {
      const { sessions, removeSession } = useSessionStore.getState()
      const now = Date.now()

      for (const session of Object.values(sessions)) {
        if (
          (session.state === 'disconnected' || session.state === 'error') &&
          session.endedAt &&
          now - session.endedAt > retentionMs
        ) {
          log.info(`Auto-cleanup: removing ended session ${session.sessionId.slice(0, 8)} (retention: ${retentionMinutes}m)`)
          removeSession(session.sessionId)
        }
      }
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [hasEndedSessions, retentionMinutes])
}
