// ============================================
// Session Manager React Context
// Provides SessionManager to the component tree
// ============================================

import { createContext, useContext } from 'react'
import { SessionManager, getSessionManager } from '@/services/sessionManager'

/**
 * React context for the SessionManager singleton.
 * Initialized in App.tsx, consumed by hooks and components.
 */
export const SessionManagerContext = createContext<SessionManager>(getSessionManager())

/**
 * Hook to access the SessionManager from any component.
 *
 * Usage:
 *   const sessionManager = useSessionManager()
 *   const container = sessionManager.getContainer(agentInstanceId)
 */
export function useSessionManager(): SessionManager {
  return useContext(SessionManagerContext)
}
