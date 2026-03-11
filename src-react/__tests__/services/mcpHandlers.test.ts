import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAgentProvidersState: vi.fn(),
  getSessionStoreState: vi.fn(),
  getNavigationStoreState: vi.fn(),
  getConfigStoreState: vi.fn(),
  getSessionManager: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('@/stores/agentProvidersStore', () => ({
  useAgentProvidersStore: {
    getState: mocks.getAgentProvidersState,
  },
}))

vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: {
    getState: mocks.getSessionStoreState,
  },
}))

vi.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: mocks.getNavigationStoreState,
  },
}))

vi.mock('@/stores/configStore', () => ({
  useConfigStore: {
    getState: mocks.getConfigStoreState,
  },
}))

vi.mock('@/services/sessionManager', () => ({
  getSessionManager: mocks.getSessionManager,
}))

vi.mock('@/lib/logger', () => ({
  loggers: {
    app: {
      info: mocks.logInfo,
      warn: mocks.logWarn,
      error: mocks.logError,
    },
  },
}))

function withTimeout<T>(promise: Promise<T>, timeoutMs = 100): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for promise')), timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

describe('mcpHandlers handleJoinMeeting', () => {
  beforeEach(() => {
    vi.resetModules()

    mocks.getAgentProvidersState.mockReset()
    mocks.getSessionStoreState.mockReset()
    mocks.getNavigationStoreState.mockReset()
    mocks.getConfigStoreState.mockReset()
    mocks.getSessionManager.mockReset()
    mocks.logInfo.mockReset()
    mocks.logWarn.mockReset()
    mocks.logError.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('continues processing queued joins after a prior join fails', async () => {
    const setCurrentPage = vi.fn()
    const setFocusedAgent = vi.fn()
    const createSession = vi.fn().mockReturnValue({
      session: { sessionId: 'session-1' },
      agent: { agentInstanceId: 'agent-instance-1' },
    })
    const joinMeeting = vi.fn().mockResolvedValue(undefined)

    mocks.getAgentProvidersState.mockReturnValue({
      getProvider: vi
        .fn()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({
          id: 'agent-2',
          name: 'Bridge Bot',
          type: 'custom',
          settings: {},
        }),
      providers: [],
    })
    mocks.getSessionStoreState.mockReturnValue({
      canCreateSession: () => true,
      setFocusedAgent,
      updateAgentConnectionStatus: vi.fn(),
      updateSessionState: vi.fn(),
    })
    mocks.getNavigationStoreState.mockReturnValue({
      setCurrentPage,
    })
    mocks.getConfigStoreState.mockReturnValue({
      config: {
        acs: {
          endpoint: 'https://example.communication.azure.com',
          accessKey: 'test-key',
        },
      },
      mcpConfig: {
        maxConcurrentSessions: 10,
      },
    })
    mocks.getSessionManager.mockReturnValue({
      createSession,
      joinMeeting,
    })

    const { handleJoinMeeting } = await import('@/services/mcpHandlers')

    await expect(
      handleJoinMeeting({
        meetingUrl: 'https://teams.microsoft.com/l/meetup-join/first',
        agentConfigId: 'missing-agent',
      })
    ).rejects.toThrow('Agent configuration not found: missing-agent')

    await expect(
      withTimeout(
        handleJoinMeeting({
          meetingUrl: 'https://teams.microsoft.com/l/meetup-join/second',
          agentConfigId: 'agent-2',
        })
      )
    ).resolves.toEqual({
      sessionId: 'session-1',
      status: 'joining',
    })

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(joinMeeting).toHaveBeenCalledTimes(1)
    expect(setCurrentPage).toHaveBeenCalledWith('sessions')
    expect(setFocusedAgent).toHaveBeenCalledWith('session-1', 'agent-instance-1')
  })

  it('continues leave flow when farewell chat send fails', async () => {
    vi.useFakeTimers()

    const updateSessionState = vi.fn()
    const sendMessage = vi.fn().mockRejectedValue(new Error('chat unavailable'))
    const endSession = vi.fn().mockResolvedValue(undefined)

    mocks.getSessionStoreState.mockReturnValue({
      getSession: vi.fn().mockReturnValue({
        sessionId: 'session-1',
        state: 'connected',
        endedAt: null,
        agents: {
          'agent-1': {
            agentInstanceId: 'agent-1',
            agentName: 'Bridge Bot',
          },
        },
      }),
      updateSessionState,
    })
    mocks.getSessionManager.mockReturnValue({
      getContainer: vi.fn().mockReturnValue({
        chatService: {
          sendMessage,
        },
      }),
      endSession,
    })

    const { handleLeaveMeeting } = await import('@/services/mcpHandlers')

    const leavePromise = handleLeaveMeeting({ sessionId: 'session-1' })
    await vi.advanceTimersByTimeAsync(1_500)

    await expect(leavePromise).resolves.toEqual({ success: true, status: 'disconnected' })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(updateSessionState).toHaveBeenCalledWith('session-1', 'disconnecting')
    expect(endSession).toHaveBeenCalledWith('session-1')
    expect(mocks.logWarn).toHaveBeenCalled()
  })

  it('lists sessions with sanitized URLs', async () => {
    mocks.getSessionStoreState.mockReturnValue({
      getActiveSessions: vi.fn().mockReturnValue([
        {
          sessionId: 'session-1',
          state: 'connected',
          meetingUrl: 'https://teams.microsoft.com/l/meetup-join/test?tenant=abc&token=secret',
          createdAt: Date.now() - 5_000,
          agents: {
            'agent-1': {
              agentInstanceId: 'agent-1',
              agentName: 'Bridge Bot',
              agentConfigId: 'provider-1',
              state: 'connected',
              connectionStatus: 'connected',
              isInCall: true,
            },
          },
        },
      ]),
    })
    mocks.getConfigStoreState.mockReturnValue({
      mcpConfig: {
        maxConcurrentSessions: 10,
      },
    })

    const { handleListSessions } = await import('@/services/mcpHandlers')

    const result = handleListSessions()

    expect(result.totalActive).toBe(1)
    expect(result.maxAllowed).toBe(10)
    expect(result.sessions[0].meetingUrl).toBe('https://teams.microsoft.com/l/meetup-join/test')
    expect(result.sessions[0].agentName).toBe('Bridge Bot')
    expect(result.sessions[0].agents).toHaveLength(1)
  })
})
