import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup'
import { useSessionStore } from '@/stores/sessionStore'
import { useConfigStore } from '@/stores/configStore'

const originalSessionState = useSessionStore.getState()
const originalConfigState = useConfigStore.getState()

describe('useSessionAutoCleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useSessionStore.setState({
      sessions: {},
      focusedSessionId: null,
      focusedAgentInstanceId: null,
    })
    useConfigStore.setState({
      mcpConfig: {
        ...useConfigStore.getState().mcpConfig,
        sessionRetentionMinutes: 1,
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    useSessionStore.setState({
      sessions: originalSessionState.sessions,
      focusedSessionId: originalSessionState.focusedSessionId,
      focusedAgentInstanceId: originalSessionState.focusedAgentInstanceId,
    })
    useConfigStore.setState({
      mcpConfig: originalConfigState.mcpConfig,
    })
    vi.restoreAllMocks()
  })

  it('does not start a cleanup interval when there are no ended sessions', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    renderHook(() => useSessionAutoCleanup())

    expect(setIntervalSpy).not.toHaveBeenCalled()
  })

  it('removes ended sessions after the configured retention period', () => {
    const endedAt = Date.now() - 2 * 60_000

    useSessionStore.setState({
      sessions: {
        'ended-session': {
          sessionId: 'ended-session',
          title: 'Ended Session',
          meetingUrl: 'https://teams.microsoft.com/l/meetup-join/test',
          createdAt: endedAt - 1_000,
          endedAt,
          state: 'disconnected',
          agents: {},
        },
      },
    })

    renderHook(() => useSessionAutoCleanup())

    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    expect(useSessionStore.getState().sessions['ended-session']).toBeUndefined()
  })
})
