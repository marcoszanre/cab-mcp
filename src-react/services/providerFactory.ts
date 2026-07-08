// ============================================
// Provider Factory
// Single source of truth for turning a MeetingAgentConfig into an
// IAgentProvider instance and its provider-specific config object.
//
// Previously duplicated in both agentMeetingOrchestrator.ts and
// useMeetingAgent.ts — consolidated here so a new agent type only needs to be
// wired in one place.
// ============================================

import type { IAgentProvider } from '@/types/agent-provider'
import type { MeetingAgentConfig } from '@/hooks/useMeetingAgent'

/** Instantiate the appropriate provider for the given agent config. */
export async function createProvider(config: MeetingAgentConfig): Promise<IAgentProvider> {
  switch (config.type) {
    case 'copilot-studio': {
      const { CopilotStudioAgentProvider } = await import('@/services/copilotStudioAgentProvider')
      return new CopilotStudioAgentProvider() as unknown as IAgentProvider
    }
    case 'azure-foundry': {
      const { AzureFoundryAgentProvider } = await import('@/services/azureFoundryAgentProvider')
      return new AzureFoundryAgentProvider() as unknown as IAgentProvider
    }
    case 'coding-agent': {
      const { CodingAgentProvider } = await import('@/services/codingAgentProvider')
      return new CodingAgentProvider() as unknown as IAgentProvider
    }
    default:
      throw new Error(`Unsupported agent type: ${(config as { type: string }).type}`)
  }
}

/**
 * Build the provider-specific config object. Uses `unknown` as the return type
 * because each provider config has a slightly different `authType`/`settings`
 * shape. `idPrefix` distinguishes call sites (e.g. orchestrator vs hook).
 */
export function buildProviderConfig(config: MeetingAgentConfig, idPrefix = 'meeting-agent'): unknown {
  const base = {
    id: `${idPrefix}-${Date.now()}`,
    name: config.botName || config.displayName || config.agentName || 'Meeting Agent',
    createdAt: new Date(),
    category: 'agent' as const,
  }

  switch (config.type) {
    case 'copilot-studio':
      return {
        ...base,
        type: 'copilot-studio',
        authType: 'microsoft-device-code',
        settings: {
          clientId: config.clientId || '',
          tenantId: config.tenantId || '',
          environmentId: config.environmentId || '',
          botId: config.botId || '',
          botName: config.botName,
        },
      }
    case 'azure-foundry':
      return {
        ...base,
        type: 'azure-foundry',
        authType: 'service-principal',
        settings: {
          projectEndpoint: config.projectEndpoint || '',
          agentName: config.agentName || '',
          tenantId: config.tenantId || '',
          clientId: config.clientId || '',
          clientSecret: config.clientSecret || '',
          region: config.region || '',
          displayName: config.displayName,
        },
      }
    case 'coding-agent':
      return {
        ...base,
        type: 'coding-agent',
        authType: 'local-process',
        settings: {
          provider: 'copilot-cli',
          cwd: config.cwd,
          model: config.model,
          systemMessage: config.systemMessage,
          allowShell: config.allowShell ?? false,
          bin: config.bin,
          timeoutMs: config.timeoutMs,
          displayName: config.displayName,
        },
      }
    default:
      throw new Error(`Unsupported agent type: ${(config as { type: string }).type}`)
  }
}
