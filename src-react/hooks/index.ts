// ============================================
// Hooks Index
// ============================================

// Unified meeting agent hook (recommended for all agent types)
export { useMeetingAgent, type MeetingAgentConfig, type MessageContext } from './useMeetingAgent'

// MCP bridge hook
export { useMcpBridge } from './useMcpBridge'

// Multi-session hooks
export { useSessionManager } from './useSessionManager'
export { useActiveSessionCount } from './useSessionState'

// Session auto-cleanup
export { useSessionAutoCleanup } from './useSessionAutoCleanup'
