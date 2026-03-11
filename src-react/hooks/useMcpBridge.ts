// ============================================
// MCP Bridge Hook
// Listens for MCP tool requests from Rust and
// dispatches them to handlers, returning results
// ============================================

import { useEffect, useRef } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/tauri'
import type { McpCommand } from '@/types'
import { loggers } from '@/lib/logger'

const log = loggers.app
type McpHandlersModule = typeof import('@/services/mcpHandlers')

let mcpHandlersPromise: Promise<McpHandlersModule> | null = null

async function getMcpHandlers(): Promise<McpHandlersModule> {
  mcpHandlersPromise ??= import('@/services/mcpHandlers')
  return mcpHandlersPromise
}

/**
 * Dispatches an MCP command to the appropriate handler.
 * Returns the result or throws an error.
 */
async function dispatch(command: McpCommand): Promise<unknown> {
  const handlers = await getMcpHandlers()

  switch (command.tool) {
    case 'list_agents':
      return handlers.handleListAgents()

    case 'join_meeting':
      return handlers.handleJoinMeeting(command.params as {
        meetingUrl: string
        agentConfigId: string
      })

    case 'leave_meeting':
      return handlers.handleLeaveMeeting(command.params as {
        sessionId: string
      })

    case 'list_sessions':
      return handlers.handleListSessions()

    default:
      throw new Error(`Unknown MCP tool: ${command.tool}`)
  }
}

/**
 * Hook that bridges MCP tool calls from Rust to React handlers.
 *
 * Listens on the `mcp:command` Tauri event, dispatches to the
 * appropriate handler, and sends the result/error back to Rust
 * via `invoke('mcp_respond', ...)`.
 *
 * Must be mounted once at the app level (e.g. in App.tsx).
 */
export function useMcpBridge(): void {
  // Track in-flight request IDs to prevent duplicate processing
  const inflightRequests = useRef(new Set<string>())

  useEffect(() => {
    let mounted = true
    let unlisten: UnlistenFn | undefined

    const setup = async () => {
      const nextUnlisten = await listen<McpCommand>('mcp:command', async (event) => {
        const command = event.payload
        const { requestId, tool } = command

        // Deduplicate: skip if this requestId is already being processed
        if (inflightRequests.current.has(requestId)) {
          log.warn(`MCP bridge: duplicate requestId "${requestId}" ignored`)
          return
        }
        inflightRequests.current.add(requestId)

        log.info(`MCP bridge: received tool call "${tool}" (${requestId})`)

        try {
          const result = await dispatch(command)

          if (!mounted) {
            // Component unmounted during processing — send error response so Rust doesn't hang
            try {
              await invoke('mcp_respond', {
                requestId,
                result: null,
                errorCode: -32001,
                errorMessage: 'MCP bridge unmounted during tool execution',
              })
            } catch { /* best effort */ }
            return
          }

          await invoke('mcp_respond', {
            requestId,
            result: result ?? null,
            errorCode: null,
            errorMessage: null,
          })

          log.info(`MCP bridge: tool "${tool}" completed (${requestId})`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.error(`MCP bridge: tool "${tool}" failed — ${message}`)

          try {
            await invoke('mcp_respond', {
              requestId,
              result: null,
              errorCode: -32000,
              errorMessage: message,
            })
          } catch (invokeErr) {
            log.error(
              `MCP bridge: failed to send error response — ${invokeErr}`,
            )
          }
        } finally {
          inflightRequests.current.delete(requestId)
        }
      })

      if (!mounted) {
        nextUnlisten()
        return
      }

      unlisten = nextUnlisten

      log.info('MCP bridge: listening for tool calls')
    }

    setup().catch((err) => {
      if (!mounted) {
        return
      }

      log.error(`MCP bridge: failed to set up listener — ${err}`)
    })

    return () => {
      mounted = false
      unlisten?.()
      log.info('MCP bridge: listener removed')
    }
  }, [])
}
