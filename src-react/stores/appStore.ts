import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { LogEntry } from '@/types'

interface AppState {
  // Logs
  logs: LogEntry[]
  addLog: (message: string, type: LogEntry['type']) => void
  clearLogs: () => void
}

export const useAppStore = create<AppState>()(
  devtools(
    (set) => ({
      // Initial state
      logs: [],

      // Actions
      addLog: (message, type) =>
        set(
          (state) => ({
            logs: [
              ...state.logs,
              {
                id: crypto.randomUUID(),
                message,
                type,
                timestamp: new Date(),
              },
            ].slice(-100), // Keep last 100 logs
          }),
          false,
          'addLog'
        ),
      
      clearLogs: () => set({ logs: [] }, false, 'clearLogs'),
    }),
    { name: 'app-store' }
  )
)
