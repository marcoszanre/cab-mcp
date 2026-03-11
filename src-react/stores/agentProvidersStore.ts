import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import type { 
  AgentProviderConfig, 
  CopilotStudioProviderConfig,
  AgentProviderInstance,
  AgentProviderStatus
} from '@/types'
import { loadAppConfig, loadRawAppConfig, saveAppConfig } from '@/services/configFileService'
import { logger } from '@/lib/logger'
import { stripEmptyValues } from '@/lib/configUtils'

export interface AgentValidationStatus {
  isValid: boolean | null  // null = not tested yet
  message?: string
  details?: string
  sample?: string
  lastTestedAt?: Date
}

interface AgentProvidersState {
  // Saved provider configurations
  providers: AgentProviderConfig[]
  
  // Validation statuses for each provider
  validationStatuses: Record<string, AgentValidationStatus>
  
  // Runtime instances (per meeting, keyed by tabId)
  instances: Record<string, Record<string, AgentProviderInstance>>
  
  // Actions - Provider Configuration
  addProvider: (config: AgentProviderConfig) => Promise<void>
  updateProvider: (id: string, updates: Partial<AgentProviderConfig>) => Promise<void>
  removeProvider: (id: string) => void
  
  // Actions - Config File
  loadFromConfigFile: () => Promise<void>
  
  // Actions - Provider Instances (per meeting)
  initializeInstance: (tabId: string, providerId: string) => void
  setInstanceStatus: (tabId: string, providerId: string, status: AgentProviderStatus, error?: string) => void
  setInstanceAuth: (tabId: string, providerId: string, auth: Partial<AgentProviderInstance['auth']>) => void
  setInstanceConversation: (tabId: string, providerId: string, conversation: AgentProviderInstance['conversation']) => void
  clearInstances: (tabId: string) => void
  
  // Actions - Validation
  setProviderValidationStatus: (id: string, status: AgentValidationStatus) => void
  clearProviderValidationStatus: (id: string) => void
  getProviderValidationStatus: (id: string) => AgentValidationStatus | undefined
  
  // Getters
  getProvider: (id: string) => AgentProviderConfig | undefined
  getInstance: (tabId: string, providerId: string) => AgentProviderInstance | undefined
  getInstancesForMeeting: (tabId: string) => Record<string, AgentProviderInstance>
}

// Create default Copilot Studio provider from env config
// Only use env vars in development mode to avoid bundling secrets into production builds
const createDefaultCopilotProvider = (): CopilotStudioProviderConfig | null => {
  // In production, don't auto-create providers from env vars
  if (!import.meta.env.DEV) {
    return null
  }
  
  const clientId = import.meta.env.VITE_COPILOT_APP_CLIENT_ID
  const tenantId = import.meta.env.VITE_COPILOT_TENANT_ID
  const environmentId = import.meta.env.VITE_COPILOT_ENVIRONMENT_ID
  const botId = import.meta.env.VITE_COPILOT_AGENT_IDENTIFIER
  
  if (!clientId || !tenantId || !environmentId || !botId) {
    return null
  }
  
  return {
    id: 'default-copilot-studio',
    name: 'Copilot Studio (Default)',
    type: 'copilot-studio',
    authType: 'microsoft-device-code',
    createdAt: new Date(),
    preprocessing: {
      enabled: true,
      ttsOptimization: true
    },
    postprocessing: {
      enabled: true,
      formatLinks: true
    },
    settings: {
      clientId,
      tenantId,
      environmentId,
      botId,
      botName: import.meta.env.VITE_AGENT_NAME || 'AI Agent'
    }
  }
}

const defaultProvider = createDefaultCopilotProvider()
const initialProviders: AgentProviderConfig[] = defaultProvider ? [defaultProvider] : []

/** Infer authType from agent type when loading from config file */
function inferAuthType(agent: Record<string, unknown>): Record<string, unknown> {
  if (agent.authType) return agent
  switch (agent.type) {
    case 'copilot-studio': return { ...agent, authType: 'microsoft-device-code' }
    case 'azure-foundry': return { ...agent, authType: 'service-principal' }
    case 'azure-openai': return { ...agent, authType: 'api-key' }
    default: return agent
  }
}

/** Save the current providers array back to the config file */
async function saveAgentsToConfigFile(providers: AgentProviderConfig[]): Promise<void> {
  try {
    const raw = await loadRawAppConfig()
    raw.agents = providers.map((p) => {
      // Strip authType — it's inferred from type on load
      const { authType: _authType, ...rest } = p
      if (rest.settings && typeof rest.settings === 'object') {
        return { ...rest, settings: stripEmptyValues(rest.settings) as typeof rest.settings }
      }
      return rest
    })
    await saveAppConfig(raw)
  } catch (error) {
    logger.warn('Failed to save agents to config file', 'AgentProvidersStore', error)
  }
}

export const useAgentProvidersStore = create<AgentProvidersState>()(
  devtools(
    persist(
      (set, get) => ({
        providers: initialProviders,
        validationStatuses: {},
        instances: {},

        addProvider: async (config) => {
          set(
            (state) => ({
              providers: [...state.providers, config]
            }),
            false,
            'addProvider'
          )
          await saveAgentsToConfigFile(get().providers)
        },

        updateProvider: async (id, updates) => {
          set(
            (state) => ({
              providers: state.providers.map(p => 
                p.id === id ? { ...p, ...updates } as AgentProviderConfig : p
              )
            }),
            false,
            'updateProvider'
          )
          await saveAgentsToConfigFile(get().providers)
        },

        removeProvider: (id) => {
          set(
            (state) => ({
              providers: state.providers.filter(p => p.id !== id)
            }),
            false,
            'removeProvider'
          )
          void saveAgentsToConfigFile(get().providers)
        },
        
        loadFromConfigFile: async () => {
          try {
            const data = await loadAppConfig()
            const fileAgents = data.agents as Record<string, unknown>[] | undefined
            if (fileAgents && Array.isArray(fileAgents) && fileAgents.length > 0) {
              // Infer authType for agents that don't have it (new format)
              const agents = fileAgents.map(inferAuthType) as unknown as AgentProviderConfig[]
              set({ providers: agents }, false, 'loadFromConfigFile')
              logger.info(`Loaded ${agents.length} agent(s) from config file`, 'AgentProvidersStore')
            }
          } catch (error) {
            logger.warn('Failed to load agents from config file', 'AgentProvidersStore', error)
          }
        },

        // Initialize a provider instance for a meeting
        initializeInstance: (tabId, providerId) => {
          const provider = get().getProvider(providerId)
          if (!provider) return

          set(
            (state) => ({
              instances: {
                ...state.instances,
                [tabId]: {
                  ...state.instances[tabId],
                  [providerId]: {
                    config: provider,
                    status: 'idle',
                    auth: provider.authType === 'microsoft-device-code' ? {
                      isAuthenticated: false
                    } : undefined
                  }
                }
              }
            }),
            false,
            'initializeInstance'
          )
        },

        // Set instance status
        setInstanceStatus: (tabId, providerId, status, error) => set(
          (state) => {
            const instance = state.instances[tabId]?.[providerId]
            if (!instance) return state

            return {
              instances: {
                ...state.instances,
                [tabId]: {
                  ...state.instances[tabId],
                  [providerId]: {
                    ...instance,
                    status,
                    error
                  }
                }
              }
            }
          },
          false,
          'setInstanceStatus'
        ),

        // Set instance auth state
        setInstanceAuth: (tabId, providerId, auth) => set(
          (state) => {
            const instance = state.instances[tabId]?.[providerId]
            if (!instance) return state

            return {
              instances: {
                ...state.instances,
                [tabId]: {
                  ...state.instances[tabId],
                  [providerId]: {
                    ...instance,
                    auth: { 
                      isAuthenticated: instance.auth?.isAuthenticated ?? false,
                      ...instance.auth, 
                      ...auth 
                    }
                  }
                }
              }
            }
          },
          false,
          'setInstanceAuth'
        ),

        // Set instance conversation
        setInstanceConversation: (tabId, providerId, conversation) => set(
          (state) => {
            const instance = state.instances[tabId]?.[providerId]
            if (!instance) return state

            return {
              instances: {
                ...state.instances,
                [tabId]: {
                  ...state.instances[tabId],
                  [providerId]: {
                    ...instance,
                    conversation
                  }
                }
              }
            }
          },
          false,
          'setInstanceConversation'
        ),

        // Clear all instances for a meeting
        clearInstances: (tabId) => set(
          (state) => {
            const { [tabId]: _removed, ...rest } = state.instances
            return { instances: rest }
          },
          false,
          'clearInstances'
        ),

        // Set validation status for a provider
        setProviderValidationStatus: (id, status) => set(
          (state) => ({
            validationStatuses: {
              ...state.validationStatuses,
              [id]: status
            }
          }),
          false,
          'setProviderValidationStatus'
        ),

        // Clear validation status for a provider
        clearProviderValidationStatus: (id) => set(
          (state) => {
            const { [id]: _removed, ...rest } = state.validationStatuses
            return { validationStatuses: rest }
          },
          false,
          'clearProviderValidationStatus'
        ),

        // Get validation status for a provider
        getProviderValidationStatus: (id) => get().validationStatuses[id],

        // Get a provider by ID
        getProvider: (id) => get().providers.find(p => p.id === id),

        // Get an instance
        getInstance: (tabId, providerId) => get().instances[tabId]?.[providerId],

        // Get all instances for a meeting
        getInstancesForMeeting: (tabId) => get().instances[tabId] || {}
      }),
      {
        name: 'agent-providers-store',
        version: 5,
        partialize: (state) => ({
          providers: state.providers,
        }),
        // Migrate persisted state across versions
        migrate: (persisted, version) => {
          // v1 → v2: ProactiveConfig.responseChannel now accepts 'auto'.
          // Existing 'speech'/'chat' values remain valid — no transformation needed.
          // The 'auto' value is only set by explicit user action.
          if (version < 2) {
            // Ensure proactiveConfig exists with defaults where missing
            const state = persisted as { providers?: Array<Record<string, unknown>> }
            if (state.providers) {
              for (const p of state.providers) {
                if (p.proactiveConfig === undefined) {
                  // Leave undefined — optional field, handled at runtime
                }
              }
            }
          }
          // v2 → v3: ProactiveConfig gains autoLeaveOnCompletion, goodbyeMessage, goodbyeChannel
          if (version < 3) {
            const state = persisted as { providers?: Array<Record<string, unknown>> }
            if (state.providers) {
              for (const p of state.providers) {
                const pc = p.proactiveConfig as Record<string, unknown> | undefined
                if (pc) {
                  if (pc.autoLeaveOnCompletion === undefined) pc.autoLeaveOnCompletion = false
                  if (pc.goodbyeMessage === undefined) pc.goodbyeMessage = ''
                  if (pc.goodbyeChannel === undefined) pc.goodbyeChannel = 'both'
                }
              }
            }
          }
          // v3 → v4: BaseAgentProviderConfig gains optional welcomeConfig
          if (version < 4) {
            const state = persisted as { providers?: Array<Record<string, unknown>> }
            if (state.providers) {
              for (const p of state.providers) {
                if (p.welcomeConfig === undefined) p.welcomeConfig = undefined
              }
            }
          }
          // v4 → v5: ProactiveConfig gains turnTakingMode.
          // Preserve legacy runtime behavior for existing saved agents by
          // explicitly migrating them to the old interruptible mode.
          if (version < 5) {
            const state = persisted as { providers?: Array<Record<string, unknown>> }
            if (state.providers) {
              for (const p of state.providers) {
                const pc = p.proactiveConfig as Record<string, unknown> | undefined
                if (pc && pc.turnTakingMode === undefined) {
                  pc.turnTakingMode = 'interruptible'
                }
              }
            }
          }
          return persisted as AgentProvidersState
        }
      }
    ),
    { name: 'agent-providers-store' }
  )
)
