import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import type { UserPreferences, IdleTimeoutConfig } from '@/types'
import { DEFAULT_IDLE_TIMEOUT_CONFIG } from '@/types'

export type ThemeMode = 'light' | 'dark' | 'system'

interface PreferencesState {
  preferences: UserPreferences
  
  // Actions
  setDefaultVoice: (voice: string) => void
  setLastMeetingUrl: (url: string) => void
  setTheme: (theme: ThemeMode) => void
  setUIPreference: <K extends keyof NonNullable<UserPreferences['ui']>>(
    key: K, 
    value: NonNullable<UserPreferences['ui']>[K]
  ) => void
  setIdleTimeout: (config: Partial<IdleTimeoutConfig>) => void
  updatePreferences: (updates: Partial<UserPreferences>) => void
  resetPreferences: () => void
}

const defaultPreferences: UserPreferences = {
  defaultVoice: 'en-US-JennyNeural',
  ui: {
    theme: 'light',
    logsExpanded: false,
    showAgentPanel: true
  },
  idleTimeout: { ...DEFAULT_IDLE_TIMEOUT_CONFIG },
}

// Apply theme to document
export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement
  const isDark = theme === 'dark' || 
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  
  if (isDark) {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

export const usePreferencesStore = create<PreferencesState>()(
  devtools(
    persist(
      (set) => ({
        preferences: defaultPreferences,

        setDefaultVoice:(defaultVoice) => set(
          (state) => ({
            preferences: { ...state.preferences, defaultVoice }
          }),
          false,
          'setDefaultVoice'
        ),

        setLastMeetingUrl: (lastMeetingUrl) => set(
          (state) => ({
            preferences: { ...state.preferences, lastMeetingUrl }
          }),
          false,
          'setLastMeetingUrl'
        ),

        setTheme: (theme) => {
          applyTheme(theme)
          set(
            (state) => ({
              preferences: {
                ...state.preferences,
                ui: { ...state.preferences.ui, theme }
              }
            }),
            false,
            'setTheme'
          )
        },

        setUIPreference: (key, value) => set(
          (state) => ({
            preferences: {
              ...state.preferences,
              ui: {
                ...state.preferences.ui,
                [key]: value
              }
            }
          }),
          false,
          'setUIPreference'
        ),

        setIdleTimeout: (config) => set(
          (state) => ({
            preferences: {
              ...state.preferences,
              idleTimeout: {
                ...(state.preferences.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_CONFIG),
                ...config
              }
            }
          }),
          false,
          'setIdleTimeout'
        ),

        updatePreferences: (updates) => set(
          (state) => ({
            preferences: { ...state.preferences, ...updates }
          }),
          false,
          'updatePreferences'
        ),

        resetPreferences: () => set(
          { preferences: defaultPreferences },
          false,
          'resetPreferences'
        )
      }),
      {
        name: 'preferences-store',
        partialize: (state) => ({
          preferences: state.preferences
        })
      }
    ),
    { name: 'preferences-store' }
  )
)
