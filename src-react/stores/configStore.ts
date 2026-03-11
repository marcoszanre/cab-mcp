import { create } from 'zustand'
import { devtools, persist, createJSONStorage } from 'zustand/middleware'
import type { AppConfig, McpConfig, MeetingBehaviorConfig } from '@/types'
import { DEFAULT_MEETING_BEHAVIOR_CONFIG } from '@/types'
import type { ValidationResult } from '@/services/validationService'
import { loadAppConfig, loadRawAppConfig, saveAppConfig } from '@/services/configFileService'
import { logger } from '@/lib/logger'
import { stripEmptyValues, pickPreservingRaw, buildEnvVarFieldMap } from '@/lib/configUtils'

const VALIDATION_STORAGE_KEY = 'teams-agent-bridge-validations'

/** Generate a random 32-character hex API key */
function generateApiKey(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface ValidationStatuses {
  acs: ValidationResult | null
  speech: ValidationResult | null
  openai: ValidationResult | null
}

// Only use env vars in development mode to avoid bundling secrets into production builds
const envConfig: AppConfig = import.meta.env.DEV ? {
  acs: {
    endpoint: import.meta.env.VITE_ACS_ENDPOINT || '',
    accessKey: import.meta.env.VITE_ACS_ACCESS_KEY || '',
  },
  agentName: import.meta.env.VITE_AGENT_NAME || '',
  callUrl: import.meta.env.VITE_CALL_URL || '',
  copilotStudio: {
    appClientId: import.meta.env.VITE_COPILOT_APP_CLIENT_ID || '',
    clientId: import.meta.env.VITE_COPILOT_APP_CLIENT_ID || '',
    tenantId: import.meta.env.VITE_COPILOT_TENANT_ID || '',
    environmentId: import.meta.env.VITE_COPILOT_ENVIRONMENT_ID || '',
    agentIdentifier: import.meta.env.VITE_COPILOT_AGENT_IDENTIFIER || '',
    botId: import.meta.env.VITE_COPILOT_AGENT_IDENTIFIER || '',
    botName: import.meta.env.VITE_AGENT_NAME || '',
  },
  speech: {
    key: import.meta.env.VITE_SPEECH_KEY || '',
    region: import.meta.env.VITE_SPEECH_REGION || '',
    endpoint: import.meta.env.VITE_SPEECH_ENDPOINT || '',
  },
  openai: {
    endpoint: import.meta.env.VITE_OPENAI_ENDPOINT || '',
    deployment: import.meta.env.VITE_OPENAI_DEPLOYMENT || '',
    apiKey: import.meta.env.VITE_OPENAI_API_KEY || '',
  },
} : {
  acs: {
    endpoint: '',
    accessKey: '',
  },
  agentName: '',
  callUrl: '',
  copilotStudio: {
    appClientId: '',
    clientId: '',
    tenantId: '',
    environmentId: '',
    agentIdentifier: '',
    botId: '',
    botName: '',
  },
  speech: {
    key: '',
    region: 'eastus',
    endpoint: '',
  },
  openai: {
    endpoint: '',
    deployment: '',
    apiKey: '',
  },
}

if (import.meta.env.DEV) {
  // eslint-disable-next-line no-console
  console.log('🔧 ENV Config loaded:', {
    agentName: envConfig.agentName,
    hasAccessKey: !!envConfig.acs.accessKey,
    hasSpeechKey: !!envConfig.speech.key,
    hasCopilotClientId: !!envConfig.copilotStudio.clientId,
  })
}

const defaultConfig: AppConfig = envConfig

const defaultMcpConfig: McpConfig = {
  port: 3100,
  autoStart: false,
  apiKey: '',
  maxConcurrentSessions: 10,
  sessionRetentionMinutes: 5,
}

const defaultValidationStatuses: ValidationStatuses = {
  acs: null,
  speech: null,
  openai: null,
}

function rehydrateValidation(v: ValidationResult | null | undefined): ValidationResult | null {
  if (!v) return null
  return { ...v, testedAt: new Date(v.testedAt) }
}

let _isLoadingConfigFile = false

// Internal snapshot for env-var preservation (not persisted, not in store state)
let _resolvedConfigSnapshot: Record<string, unknown> = {}

interface ConfigState {
  config: AppConfig
  mcpConfig: McpConfig
  meetingBehavior: MeetingBehaviorConfig
  validationStatuses: ValidationStatuses
  configFileLoaded: boolean
  /** Dot-path map of fields that contain ${ENV_VAR} references in the raw config */
  envVarFields: Map<string, string>
  setConfig: (config: Partial<AppConfig>) => void
  setAcsConfig: (config: Partial<AppConfig['acs']>) => void
  setCopilotStudioConfig: (config: Partial<AppConfig['copilotStudio']>) => void
  setSpeechConfig: (config: Partial<AppConfig['speech']>) => void
  setOpenAIConfig: (config: Partial<AppConfig['openai']>) => void
  setMcpConfig: (config: Partial<McpConfig>) => void
  setMeetingBehavior: (config: Partial<MeetingBehaviorConfig>) => void
  loadFromConfigFile: () => Promise<void>
  saveToConfigFile: () => Promise<boolean>
  resetConfig: () => void
  isConfigValid: () => boolean
  isCopilotConfigValid: () => boolean
  setValidationStatus: (service: keyof ValidationStatuses, status: ValidationResult | null) => void
  clearValidationStatus: (service: keyof ValidationStatuses) => void
  clearAllValidationStatuses: () => void
}

export const useConfigStore = create<ConfigState>()(
  devtools(
    persist(
      (set, get) => ({
        config: defaultConfig,
        mcpConfig: defaultMcpConfig,
        meetingBehavior: { ...DEFAULT_MEETING_BEHAVIOR_CONFIG },
        validationStatuses: defaultValidationStatuses,
        configFileLoaded: false,
        envVarFields: new Map(),

        setConfig: (updates) =>
          set(
            (state) => ({
              config: { ...state.config, ...updates },
            }),
            false,
            'setConfig'
          ),

        setAcsConfig: (updates) =>
          set(
            (state) => ({
              config: {
                ...state.config,
                acs: { ...state.config.acs, ...updates },
              },
            }),
            false,
            'setAcsConfig'
          ),

        setCopilotStudioConfig: (updates) =>
          set(
            (state) => ({
              config: {
                ...state.config,
                copilotStudio: { ...state.config.copilotStudio, ...updates },
              },
            }),
            false,
            'setCopilotStudioConfig'
          ),

        setSpeechConfig: (updates) =>
          set(
            (state) => ({
              config: {
                ...state.config,
                speech: { ...state.config.speech, ...updates },
              },
            }),
            false,
            'setSpeechConfig'
          ),

        setOpenAIConfig: (updates) =>
          set(
            (state) => ({
              config: {
                ...state.config,
                openai: { ...state.config.openai, ...updates },
              },
            }),
            false,
            'setOpenAIConfig'
          ),

        setMcpConfig: (updates) =>
          set(
            (state) => ({
              mcpConfig: { ...state.mcpConfig, ...updates },
            }),
            false,
            'setMcpConfig'
          ),

        setMeetingBehavior: (updates) =>
          set(
            (state) => ({
              meetingBehavior: { ...state.meetingBehavior, ...updates },
            }),
            false,
            'setMeetingBehavior'
          ),

        loadFromConfigFile: async () => {
          if (_isLoadingConfigFile) return
          _isLoadingConfigFile = true

          try {
            const [data, rawData] = await Promise.all([
              loadAppConfig(),
              loadRawAppConfig(),
            ])

            // Cache resolved snapshot for env-var preservation during saves
            _resolvedConfigSnapshot = data

            const fileConfig = data.config as Record<string, unknown> | undefined
            const fileMcpConfig = data.mcpConfig as Partial<McpConfig> | undefined
            const fileMeetingBehavior = data.meetingBehavior as Partial<MeetingBehaviorConfig> | undefined

            const current = get()

            // Migrate legacy flat ACS fields → nested acs section
            const fileAcs = fileConfig?.acs as Partial<AppConfig['acs']> | undefined
            const legacyEndpoint = fileConfig?.endpoint as string | undefined
            const legacyAccessKey = fileConfig?.accessKey as string | undefined
            const mergedAcs = {
              endpoint: fileAcs?.endpoint ?? legacyEndpoint ?? current.config.acs.endpoint,
              accessKey: fileAcs?.accessKey ?? legacyAccessKey ?? current.config.acs.accessKey,
            }

            const mergedConfig: AppConfig = {
              ...current.config,
              ...(fileConfig && {
                acs: mergedAcs,
                agentName: (fileConfig.agentName as string) ?? current.config.agentName,
                callUrl: (fileConfig.callUrl as string) ?? current.config.callUrl,
                copilotStudio: {
                  ...current.config.copilotStudio,
                  ...(fileConfig.copilotStudio as Partial<AppConfig['copilotStudio']>),
                },
                speech: {
                  ...current.config.speech,
                  ...(fileConfig.speech as Partial<AppConfig['speech']>),
                },
                openai: {
                  ...current.config.openai,
                  ...(fileConfig.openai as Partial<AppConfig['openai']>),
                },
              }),
            }

            let mergedMcpConfig: McpConfig = {
              ...current.mcpConfig,
              ...fileMcpConfig,
            }

            // Auto-generate MCP API key if missing
            if (!mergedMcpConfig.apiKey?.trim()) {
              mergedMcpConfig = { ...mergedMcpConfig, apiKey: generateApiKey() }
              // Persist the generated key back to the config file
              try {
                const raw = await loadRawAppConfig()
                const rawMcp = (raw.mcpConfig ?? {}) as Record<string, unknown>
                raw.mcpConfig = { ...rawMcp, apiKey: mergedMcpConfig.apiKey }
                await saveAppConfig(raw)
              } catch (err) {
                logger.warn('Failed to persist generated MCP API key', 'ConfigStore', err)
              }
            }

            // Build env-var field map for UI indicators
            const rawConfig = (rawData.config ?? {}) as Record<string, unknown>
            const envVarFields = buildEnvVarFieldMap(rawConfig, 'config')

            // Merge meeting behavior from config file
            const mergedMeetingBehavior: MeetingBehaviorConfig = {
              ...current.meetingBehavior,
              ...(fileMeetingBehavior && {
                autoLeave: {
                  ...current.meetingBehavior.autoLeave,
                  ...fileMeetingBehavior.autoLeave,
                },
              }),
            }

            set(
              { config: mergedConfig, mcpConfig: mergedMcpConfig, meetingBehavior: mergedMeetingBehavior, configFileLoaded: true, envVarFields },
              false,
              'loadFromConfigFile'
            )
            logger.info('Config loaded from config file', 'ConfigStore')
          } catch (error) {
            logger.warn('Failed to load from config file', 'ConfigStore', error)
            set({ configFileLoaded: true }, false, 'loadFromConfigFile:error')
          } finally {
            _isLoadingConfigFile = false
          }
        },

        saveToConfigFile: async () => {
          try {
            // Read raw file to get current on-disk state
            const raw = await loadRawAppConfig()
            const { config, mcpConfig, meetingBehavior } = get()

            const rawConfig = (raw.config ?? {}) as Record<string, unknown>
            const rawMcp = (raw.mcpConfig ?? {}) as Record<string, unknown>

            // Use resolved snapshot to detect which fields the user has actually changed.
            // Fields unchanged since load keep their raw ${ENV_VAR} references.
            const resolvedConfig = (_resolvedConfigSnapshot.config ?? {}) as Record<string, unknown>

            const currentConfigObj: Record<string, unknown> = {
              acs: config.acs as unknown as Record<string, unknown>,
              agentName: config.agentName,
              callUrl: config.callUrl,
              copilotStudio: config.copilotStudio as unknown as Record<string, unknown>,
              speech: config.speech as unknown as Record<string, unknown>,
              openai: config.openai as unknown as Record<string, unknown>,
            }

            const mergedConfig = stripEmptyValues(
              pickPreservingRaw(currentConfigObj, rawConfig, resolvedConfig),
            )

            const mergedMcpConfig = stripEmptyValues({
              ...rawMcp,
              port: mcpConfig.port,
              autoStart: mcpConfig.autoStart,
              apiKey: mcpConfig.apiKey,
              maxConcurrentSessions: mcpConfig.maxConcurrentSessions,
              sessionRetentionMinutes: mcpConfig.sessionRetentionMinutes,
            })

            // Build ordered document: config, meetingBehavior, mcpConfig, agents, env, ...rest
            const ordered: Record<string, unknown> = {}
            if (mergedConfig || raw.config) ordered.config = mergedConfig
            ordered.meetingBehavior = meetingBehavior
            if (mergedMcpConfig || raw.mcpConfig) ordered.mcpConfig = mergedMcpConfig
            if (raw.agents) ordered.agents = raw.agents
            if (raw.env) ordered.env = raw.env
            for (const [k, v] of Object.entries(raw)) {
              if (!['config', 'meetingBehavior', 'mcpConfig', 'agents', 'env'].includes(k)) ordered[k] = v
            }

            const ok = await saveAppConfig(ordered)
            if (!ok) {
              logger.warn('saveToConfigFile returned false', 'ConfigStore')
            }
            return ok
          } catch (error) {
            logger.warn('Failed to save to config file', 'ConfigStore', error)
            return false
          }
        },

        resetConfig: () =>
          set(
            (state) => ({
              config: defaultConfig,
              meetingBehavior: { ...DEFAULT_MEETING_BEHAVIOR_CONFIG },
              mcpConfig: {
                ...defaultMcpConfig,
                apiKey: state.mcpConfig.apiKey,
              },
            }),
            false,
            'resetConfig'
          ),

        isConfigValid: () => {
          const { config } = get()
          return Boolean(
            config.acs.endpoint?.trim() &&
            config.acs.accessKey?.trim()
          )
        },

        isCopilotConfigValid: () => {
          const { config } = get()
          const cs = config.copilotStudio
          return Boolean(
            (cs.clientId?.trim() || cs.appClientId?.trim()) &&
            cs.tenantId?.trim() &&
            cs.environmentId?.trim() &&
            (cs.botId?.trim() || cs.agentIdentifier?.trim())
          )
        },

        setValidationStatus: (service, status) =>
          set(
            (state) => ({
              validationStatuses: {
                ...state.validationStatuses,
                [service]: status,
              },
            }),
            false,
            'setValidationStatus'
          ),

        clearValidationStatus: (service) =>
          set(
            (state) => ({
              validationStatuses: {
                ...state.validationStatuses,
                [service]: null,
              },
            }),
            false,
            'clearValidationStatus'
          ),

        clearAllValidationStatuses: () =>
          set(
            { validationStatuses: defaultValidationStatuses },
            false,
            'clearAllValidationStatuses'
          ),
      }),
      {
        name: VALIDATION_STORAGE_KEY,
        storage: createJSONStorage(() => localStorage),
        partialize: (state) => ({
          validationStatuses: state.validationStatuses,
        }),
        merge: (persistedState, currentState) => {
          const persisted = persistedState as {
            validationStatuses?: ValidationStatuses
          } | undefined

          return {
            ...currentState,
            validationStatuses: persisted?.validationStatuses ? {
              acs: rehydrateValidation(persisted.validationStatuses.acs),
              speech: rehydrateValidation(persisted.validationStatuses.speech),
              openai: rehydrateValidation(persisted.validationStatuses.openai),
            } : defaultValidationStatuses,
          }
        },
      }
    ),
    { name: 'config-store' }
  )
)
