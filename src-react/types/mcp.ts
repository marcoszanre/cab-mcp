// ============================================
// MCP Bridge Types
// Communication types between Rust MCP server and React
// ============================================

/**
 * Command sent from Rust MCP server to React via Tauri events
 */
export interface McpCommand {
  /** Unique request ID for correlating responses */
  requestId: string
  /** MCP tool being invoked */
  tool:
    | 'list_agents'
    | 'join_meeting'
    | 'leave_meeting'
    | 'list_sessions'
  /** Tool parameters */
  params: Record<string, unknown>
}

/**
 * Response sent from React back to Rust via Tauri invoke
 */
export interface McpResponse {
  /** Correlates with the original McpCommand.requestId */
  requestId: string
  /** Successful result (if any) */
  result?: unknown
  /** Error details (if failed) */
  error?: { code: number; message: string }
}

/**
 * Safe agent info returned by list_agents (no secrets)
 */
export interface McpAgentInfo {
  id: string
  name: string
  type: string
}

/**
 * Session status returned by get_status
 */
export interface McpSessionStatus {
  sessionId: string | null
  state: string
  agentName: string | null
  meetingUrl: string | null
  connectionStatus: string
  uptimeSeconds: number
  startedAt: number | null
  /** Agent instances in this session (multi-session) */
  agents?: McpAgentInstanceStatus[]
}

/**
 * Per-agent instance status within a session
 */
export interface McpAgentInstanceStatus {
  agentInstanceId: string
  agentName: string
  agentConfigId: string
  state: string
  connectionStatus: string
  isInCall: boolean
}

/**
 * Summary of all active sessions (returned by list_sessions / get_status without sessionId)
 */
export interface McpSessionsSummary {
  totalActive: number
  maxAllowed: number
  sessions: McpSessionStatus[]
}

/**
 * MCP server configuration
 */
export interface McpConfig {
  /** Port number (1024-65535), default 3100 */
  port: number
  /** Whether to auto-start the server with the app */
  autoStart: boolean
  /** API key for MCP authentication (auto-generated, stored in protected local storage) */
  apiKey: string
  /** Maximum concurrent sessions (1-50), default 10 */
  maxConcurrentSessions: number
  /** Auto-cleanup ended sessions after N minutes (1-60), default 5 */
  sessionRetentionMinutes: number
}

/**
 * MCP server runtime status (from Rust)
 */
export interface McpServerStatus {
  running: boolean
  port: number | null
  uptimeSeconds: number | null
}
