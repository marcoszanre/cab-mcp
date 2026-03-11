import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpCommand } from '@/types'
import { useMcpBridge } from '@/hooks/useMcpBridge'

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  invoke: vi.fn(),
  handleListAgents: vi.fn(),
  handleJoinMeeting: vi.fn(),
  handleLeaveMeeting: vi.fn(),
  handleListSessions: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}))

vi.mock('@tauri-apps/api/tauri', () => ({
  invoke: mocks.invoke,
}))

vi.mock('@/services/mcpHandlers', () => ({
  handleListAgents: mocks.handleListAgents,
  handleJoinMeeting: mocks.handleJoinMeeting,
  handleLeaveMeeting: mocks.handleLeaveMeeting,
  handleListSessions: mocks.handleListSessions,
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

function BridgeHarness() {
  useMcpBridge()
  return null
}

describe('useMcpBridge', () => {
  afterEach(() => {
    mocks.listen.mockReset()
    mocks.invoke.mockReset()
    mocks.handleListAgents.mockReset()
    mocks.handleJoinMeeting.mockReset()
    mocks.handleLeaveMeeting.mockReset()
    mocks.handleListSessions.mockReset()
    mocks.logInfo.mockReset()
    mocks.logWarn.mockReset()
    mocks.logError.mockReset()
  })

  it('cleans up listeners that resolve after unmount', async () => {
    let resolveListen: ((value: () => void) => void) | undefined
    const unlistenSpy = vi.fn()
    const unlisten = () => {
      unlistenSpy()
    }

    mocks.listen.mockReturnValueOnce(
      new Promise<() => void>((resolve) => {
        resolveListen = resolve
      })
    )

    const { unmount } = render(<BridgeHarness />)

    unmount()
    resolveListen?.(unlisten)

    await waitFor(() => {
      expect(unlistenSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('dispatches MCP commands and returns the handler result', async () => {
    const unlistenSpy = vi.fn()
    const unlisten = () => {
      unlistenSpy()
    }
    const result = { totalActive: 0, maxAllowed: 10, sessions: [] }
    let commandHandler:
      | ((event: { payload: McpCommand }) => Promise<void>)
      | undefined

    mocks.handleListSessions.mockReturnValue(result)
    mocks.invoke.mockResolvedValue(undefined)
    mocks.listen.mockImplementationOnce(async (_eventName, handler) => {
      commandHandler = handler as (event: { payload: McpCommand }) => Promise<void>
      return unlisten
    })

    const { unmount } = render(<BridgeHarness />)

    await waitFor(() => {
      expect(mocks.listen).toHaveBeenCalledTimes(1)
    })

    await commandHandler?.({
      payload: {
        requestId: 'req-1',
        tool: 'list_sessions',
        params: {},
      },
    })

    await waitFor(() => {
      expect(mocks.handleListSessions).toHaveBeenCalledTimes(1)
      expect(mocks.invoke).toHaveBeenCalledWith('mcp_respond', {
        requestId: 'req-1',
        result,
        errorCode: null,
        errorMessage: null,
      })
    })

    unmount()

    expect(unlistenSpy).toHaveBeenCalledTimes(1)
  })
})
