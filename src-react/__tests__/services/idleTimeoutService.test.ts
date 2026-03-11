import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the preferences store before importing the service
const mockPreferencesState = {
  preferences: {
    idleTimeout: {
      enabled: true,
      timeoutMinutes: 5,
      warningBeforeLeaveMs: 60_000,
    },
  },
}

let subscribeCallback: ((state: typeof mockPreferencesState, prev: typeof mockPreferencesState) => void) | null = null

vi.mock('@/stores/preferencesStore', () => ({
  usePreferencesStore: {
    getState: () => mockPreferencesState,
    subscribe: (cb: (state: typeof mockPreferencesState, prev: typeof mockPreferencesState) => void) => {
      subscribeCallback = cb
      return () => { subscribeCallback = null }
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  loggers: {
    app: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}))

import { IdleTimeoutService } from '@/services/idleTimeoutService'

describe('IdleTimeoutService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    subscribeCallback = null
    // Reset defaults
    mockPreferencesState.preferences.idleTimeout = {
      enabled: true,
      timeoutMinutes: 5,
      warningBeforeLeaveMs: 60_000,
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createService() {
    const onWarning = vi.fn()
    const onLeave = vi.fn()
    const service = new IdleTimeoutService('test')
    service.onWarning = onWarning
    service.onLeave = onLeave
    service.start()
    return { service, onWarning, onLeave }
  }

  // ── Basic State Machine ──

  it('starts in monitoring state', () => {
    const { service } = createService()
    expect(service.state).toBe('monitoring')
    service.dispose()
  })

  it('does not start countdown when no participants have ever joined', () => {
    const { service, onLeave } = createService()
    // No participants ever joined — remote count stays 0
    // Even though count is 0, _hadParticipants is false so no countdown
    vi.advanceTimersByTime(10 * 60_000)
    expect(service.state).toBe('monitoring')
    expect(onLeave).not.toHaveBeenCalled()
    service.dispose()
  })

  it('starts countdown when all participants leave', () => {
    const { service } = createService()
    service.participantJoined()
    service.participantLeft()
    expect(service.state).toBe('alone')
    service.dispose()
  })

  it('sends warning before leaving', () => {
    const { service, onWarning, onLeave } = createService()

    service.participantJoined()
    service.participantLeft()

    // Advance to warning time (5 min - 1 min = 4 min)
    vi.advanceTimersByTime(4 * 60_000)
    expect(service.state).toBe('warning_sent')
    expect(onWarning).toHaveBeenCalledTimes(1)
    expect(onWarning.mock.calls[0][0]).toContain('No participants detected')
    expect(onLeave).not.toHaveBeenCalled()

    service.dispose()
  })

  it('leaves after full timeout', () => {
    const { service, onWarning, onLeave } = createService()

    service.participantJoined()
    service.participantLeft()

    // Advance to full timeout (5 min)
    vi.advanceTimersByTime(5 * 60_000)
    expect(service.state).toBe('leaving')
    expect(onWarning).toHaveBeenCalledTimes(1)
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(onLeave.mock.calls[0][0]).toContain('auto-leaving')

    service.dispose()
  })

  // ── Cancellation on Rejoin ──

  it('cancels countdown when participant joins during alone state', () => {
    const { service, onLeave } = createService()

    service.participantJoined()
    service.participantLeft()
    expect(service.state).toBe('alone')

    // Someone rejoins
    service.participantJoined()
    expect(service.state).toBe('monitoring')

    // Even after timeout, no leave should happen
    vi.advanceTimersByTime(10 * 60_000)
    expect(onLeave).not.toHaveBeenCalled()

    service.dispose()
  })

  it('cancels countdown when participant joins during warning_sent state', () => {
    const { service, onWarning, onLeave } = createService()

    service.participantJoined()
    service.participantLeft()

    // Advance past warning time
    vi.advanceTimersByTime(4.5 * 60_000)
    expect(service.state).toBe('warning_sent')
    expect(onWarning).toHaveBeenCalledTimes(1)

    // Someone rejoins
    service.participantJoined()
    expect(service.state).toBe('monitoring')

    // No leave should happen
    vi.advanceTimersByTime(10 * 60_000)
    expect(onLeave).not.toHaveBeenCalled()

    service.dispose()
  })

  // ── Disabled Config ──

  it('does not start countdown when idle timeout is disabled', () => {
    mockPreferencesState.preferences.idleTimeout.enabled = false

    const { service, onLeave } = createService()

    service.participantJoined()
    service.participantLeft()

    expect(service.state).toBe('monitoring')
    vi.advanceTimersByTime(10 * 60_000)
    expect(onLeave).not.toHaveBeenCalled()

    service.dispose()
  })

  // ── Config Changes Mid-Session ──

  it('cancels countdown when config is disabled mid-countdown', () => {
    const { service, onLeave } = createService()

    service.participantJoined()
    service.participantLeft()
    expect(service.state).toBe('alone')

    // Deep-copy prev state before mutating
    const prevIdleTimeout = { ...mockPreferencesState.preferences.idleTimeout }
    const prev = { preferences: { ...mockPreferencesState.preferences, idleTimeout: prevIdleTimeout } }

    // Simulate config change: disable idle timeout
    mockPreferencesState.preferences.idleTimeout = {
      ...mockPreferencesState.preferences.idleTimeout,
      enabled: false,
    }
    subscribeCallback?.(mockPreferencesState, prev)

    expect(service.state).toBe('monitoring')

    vi.advanceTimersByTime(10 * 60_000)
    expect(onLeave).not.toHaveBeenCalled()

    service.dispose()
  })

  it('restarts countdown when timeout value changes mid-countdown', () => {
    const { service, onLeave } = createService()

    service.participantJoined()
    service.participantLeft()
    expect(service.state).toBe('alone')

    // Advance 2 minutes
    vi.advanceTimersByTime(2 * 60_000)

    // Change timeout to 1 minute — restarts countdown with new value
    const prevIdleTimeout = { ...mockPreferencesState.preferences.idleTimeout }
    const prev = { preferences: { ...mockPreferencesState.preferences, idleTimeout: prevIdleTimeout } }
    mockPreferencesState.preferences.idleTimeout = {
      ...mockPreferencesState.preferences.idleTimeout,
      timeoutMinutes: 1,
    }
    subscribeCallback?.(mockPreferencesState, prev)

    // The countdown restarted with 1 minute, so after 1 more minute it should leave
    vi.advanceTimersByTime(60_000)
    expect(service.state).toBe('leaving')
    expect(onLeave).toHaveBeenCalledTimes(1)

    service.dispose()
  })

  // ── Multiple Participants ──

  it('only starts countdown when ALL participants leave', () => {
    const { service } = createService()

    service.participantJoined()
    service.participantJoined()
    service.participantJoined()
    expect(service.remoteParticipantCount).toBe(3)

    service.participantLeft()
    expect(service.state).toBe('monitoring')

    service.participantLeft()
    expect(service.state).toBe('monitoring')

    service.participantLeft()
    expect(service.state).toBe('alone')

    service.dispose()
  })

  // ── Short Timeout (no room for warning) ──

  it('skips warning when timeout is shorter than warning threshold', () => {
    mockPreferencesState.preferences.idleTimeout = {
      enabled: true,
      timeoutMinutes: 0.5, // 30 seconds — less than warningBeforeLeaveMs (60s)
      warningBeforeLeaveMs: 60_000,
    }

    const { service, onWarning, onLeave } = createService()

    service.participantJoined()
    service.participantLeft()

    vi.advanceTimersByTime(30_000)
    expect(onWarning).not.toHaveBeenCalled()
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(service.state).toBe('leaving')

    service.dispose()
  })

  // ── Dispose ──

  it('stops timers on dispose', () => {
    const { service, onLeave } = createService()

    service.participantJoined()
    service.participantLeft()
    expect(service.state).toBe('alone')

    service.dispose()

    vi.advanceTimersByTime(10 * 60_000)
    expect(onLeave).not.toHaveBeenCalled()
  })

  it('ignores participant events after dispose', () => {
    const { service } = createService()
    service.dispose()

    service.participantJoined()
    expect(service.remoteParticipantCount).toBe(0)

    service.participantLeft()
    expect(service.remoteParticipantCount).toBe(0)
  })

  // ── Repeated alone/rejoin cycles ──

  it('handles repeated alone and rejoin cycles', () => {
    const { service, onLeave } = createService()

    // Cycle 1: join → leave → rejoin
    service.participantJoined()
    service.participantLeft()
    expect(service.state).toBe('alone')
    vi.advanceTimersByTime(2 * 60_000)
    service.participantJoined()
    expect(service.state).toBe('monitoring')

    // Cycle 2: leave again → full timeout
    service.participantLeft()
    expect(service.state).toBe('alone')
    vi.advanceTimersByTime(5 * 60_000)
    expect(service.state).toBe('leaving')
    expect(onLeave).toHaveBeenCalledTimes(1)

    service.dispose()
  })
})
