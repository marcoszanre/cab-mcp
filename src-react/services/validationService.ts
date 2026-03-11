/**
 * Validation Service
 * Provides validation methods for all service configurations
 * Tests connectivity and authentication before use in meetings
 */

import { fetch, ResponseType, Body } from '@tauri-apps/api/http'
import type OpenAI from 'openai'
import type { AppConfig, CopilotStudioConfig } from '@/types'
import { createFreshToken } from './tokenService'

export interface ValidationResult {
  isValid: boolean
  message: string
  details?: string
  testedAt: Date
}

/**
 * Normalize an Azure OpenAI endpoint to just the base domain URL.
 * Strips paths like /openai/deployments/xxx/chat/completions and query params.
 */
export function normalizeOpenAIEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return `${url.protocol}//${url.host}`
  } catch {
    return endpoint
  }
}

/**
 * Build the OpenAI SDK baseURL from an Azure endpoint and deployment name.
 */
export function buildOpenAIBaseURL(endpoint: string, deployment: string): string {
  const base = normalizeOpenAIEndpoint(endpoint)
  return `${base}/openai/deployments/${deployment}`
}

/** Default Azure OpenAI API version for SDK requests */
export const AZURE_OPENAI_API_VERSION = '2024-10-21'

type OpenAIModule = typeof import('openai')
type CopilotStudioModule = typeof import('@microsoft/agents-copilotstudio-client')

let openAiModulePromise: Promise<OpenAIModule> | null = null
let copilotStudioModulePromise: Promise<CopilotStudioModule> | null = null

function redactSensitiveText(
  message: string,
  sensitiveValues: Array<string | undefined>
): string {
  let sanitized = message.replace(/client_secret=([^&\s]+)/gi, 'client_secret=[REDACTED]')

  for (const sensitiveValue of sensitiveValues) {
    if (!sensitiveValue) {
      continue
    }

    sanitized = sanitized.split(sensitiveValue).join('[REDACTED]')
  }

  return sanitized
}

async function getOpenAIModule(): Promise<OpenAIModule> {
  openAiModulePromise ??= import('openai')
  return openAiModulePromise
}

async function getCopilotStudioModule(): Promise<CopilotStudioModule> {
  copilotStudioModulePromise ??= import('@microsoft/agents-copilotstudio-client')
  return copilotStudioModulePromise
}

export interface AzureOpenAIClientConfig {
  endpoint: string
  apiKey: string
  deployment: string
}

export function isDesktopRuntimeAvailable(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  const tauriWindow = window as Window & {
    __TAURI__?: unknown
    __TAURI_IPC__?: unknown
    __TAURI_INTERNALS__?: unknown
  }

  return Boolean(
    tauriWindow.__TAURI__ ||
    tauriWindow.__TAURI_INTERNALS__ ||
    typeof tauriWindow.__TAURI_IPC__ === 'function'
  )
}

export async function createAzureOpenAIClient(config: AzureOpenAIClientConfig): Promise<OpenAI> {
  if (!isDesktopRuntimeAvailable()) {
    throw new Error('Azure OpenAI is only enabled in the Tauri desktop runtime')
  }

  const { default: OpenAIClient } = await getOpenAIModule()

  return new OpenAIClient({
    baseURL: buildOpenAIBaseURL(config.endpoint, config.deployment),
    apiKey: config.apiKey,
    defaultQuery: { 'api-version': AZURE_OPENAI_API_VERSION },
    dangerouslyAllowBrowser: true,
  })
}

/**
 * Validate Azure Communication Services configuration
 * Tests by creating a CallClient and verifying token generation
 */
export async function validateAcsConfig(
  endpoint: string,
  accessKey: string
): Promise<ValidationResult> {
  const testedAt = new Date()
  
  try {
    if (!endpoint || !accessKey) {
      return {
        isValid: false,
        message: 'Missing required configuration',
        details: 'Both endpoint and access key are required',
        testedAt
      }
    }

    // Validate endpoint format
    if (!endpoint.startsWith('https://') || !endpoint.includes('.communication.azure.com')) {
      return {
        isValid: false,
        message: 'Invalid endpoint format',
        details: 'Endpoint should be in format: https://your-resource.communication.azure.com',
        testedAt
      }
    }

    // Generate a fresh test token to verify credentials work.
    // Validation should not populate runtime caches shared with actual meeting joins.
    const { token, userId } = await createFreshToken(endpoint, accessKey)
    
    if (!token || !userId) {
      return {
        isValid: false,
        message: 'Token generation failed',
        details: 'Unable to generate ACS token with provided credentials',
        testedAt
      }
    }

    // Token generation succeeded - credentials are valid
    // No need to create CallClient/CallAgent which is slow and unnecessary for validation
    return {
      isValid: true,
      message: 'Connection successful',
      details: `ACS credentials validated successfully (User: ${userId.substring(0, 20)}...)`,
      testedAt
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return {
      isValid: false,
      message: 'Validation failed',
      details: errorMessage,
      testedAt
    }
  }
}

/**
 * Validate Azure Speech Service configuration
 * Tests by creating a speech config and checking authorization
 */
export async function validateSpeechConfig(
  speechKey: string,
  speechRegion: string
): Promise<ValidationResult> {
  const testedAt = new Date()

  if (!speechKey || !speechRegion) {
    return {
      isValid: false,
      message: 'Missing required configuration',
      details: 'Both speech key and region are required',
      testedAt
    }
  }

  const url = `https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/voices/list`

  try {
    const response = await fetch<unknown[]>(url, {
      method: 'GET',
      headers: {
        'Ocp-Apim-Subscription-Key': speechKey,
      },
      timeout: 15,
      responseType: ResponseType.JSON,
    })

    if (response.ok && Array.isArray(response.data)) {
      return {
        isValid: true,
        message: 'Connection successful',
        details: `Validated against ${speechRegion} (${response.data.length} voices available)`,
        testedAt,
      }
    }

    if (response.status === 401 || response.status === 403) {
      return {
        isValid: false,
        message: 'Authentication failed - check Speech Key and Region',
        details: `Service responded with ${response.status}. Verify the key matches the selected region (${speechRegion}).`,
        testedAt,
      }
    }

    return {
      isValid: false,
      message: `Validation failed (HTTP ${response.status})`,
      details: `Service responded with status ${response.status}. Verify the Speech resource region and that the key matches that region.`,
      testedAt,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const isTimeout = errorMessage.toLowerCase().includes('timeout') || errorMessage.toLowerCase().includes('aborted')

    return {
      isValid: false,
      message: isTimeout ? 'Connection timeout - Please verify your Speech Key and Region' : 'Validation failed',
      details: isTimeout
        ? 'The Speech service did not respond in time. Check network connectivity, VPN/Proxy, and that the region is correct.'
        : `Error: ${errorMessage}`,
      testedAt,
    }
  }
}

/**
 * Validate Azure OpenAI configuration
 * Tests by making a simple chat completion request
 */
export async function validateOpenAIConfig(
  endpoint: string,
  apiKey: string,
  deployment: string
): Promise<ValidationResult> {
  const testedAt = new Date()
  
  try {
    if (!endpoint || !apiKey || !deployment) {
      return {
        isValid: false,
        message: 'Missing required configuration',
        details: 'Endpoint, API key, and deployment name are all required',
        testedAt
      }
    }

    // Validate endpoint format - accept both Azure OpenAI and Azure AI Foundry domains
    const normalized = normalizeOpenAIEndpoint(endpoint)
    const isAzureOpenAI = normalized.includes('.openai.azure.com')
    const isAzureFoundry = normalized.includes('.cognitiveservices.azure.com')
    
    if (!normalized.startsWith('https://') || (!isAzureOpenAI && !isAzureFoundry)) {
      return {
        isValid: false,
        message: 'Invalid endpoint format',
        details: 'Endpoint should be in format: https://your-resource.openai.azure.com or https://your-resource.cognitiveservices.azure.com',
        testedAt
      }
    }

    const openai = await createAzureOpenAIClient({ endpoint, apiKey, deployment })

    // Make a minimal test request
    const completion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: 'Test' }],
      model: deployment,
      max_completion_tokens: 5
    })

    if (!completion.choices || completion.choices.length === 0) {
      return {
        isValid: false,
        message: 'No response received',
        details: 'OpenAI API responded but returned no completions',
        testedAt
      }
    }

    return {
      isValid: true,
      message: 'Connection successful',
      details: `OpenAI deployment "${deployment}" validated successfully`,
      testedAt
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return {
      isValid: false,
      message: 'Validation failed',
      details: errorMessage,
      testedAt
    }
  }
}

/**
 * Validate Copilot Studio with Microsoft Auth configuration
 * Tests by attempting to create a client with the provided credentials
 * Note: This requires user authentication via device code flow
 */
export async function validateCopilotStudioConfig(
  config: CopilotStudioConfig,
  accessToken?: string
): Promise<ValidationResult> {
  const testedAt = new Date()
  
  try {
    const { clientId, tenantId, environmentId, botId } = config
    
    if (!clientId || !tenantId || !environmentId || !botId) {
      return {
        isValid: false,
        message: 'Missing required configuration',
        details: 'Client ID, Tenant ID, Environment ID, and Bot ID are all required',
        testedAt
      }
    }

    if (!accessToken) {
      return {
        isValid: false,
        message: 'Authentication required',
        details: 'Please authenticate first to validate this configuration',
        testedAt
      }
    }

    const { ConnectionSettings, CopilotStudioClient } = await getCopilotStudioModule()

    const settings = new ConnectionSettings({
      appClientId: clientId,
      tenantId: tenantId,
      environmentId: environmentId,
      agentIdentifier: botId
    })

    const client = new CopilotStudioClient(settings, accessToken)
    
    // Try to start a conversation
    const activities = await client.startConversationAsync(true)
    
    if (!activities) {
      return {
        isValid: false,
        message: 'No response from agent',
        details: 'Agent did not respond to conversation start',
        testedAt
      }
    }

    return {
      isValid: true,
      message: 'Connection successful',
      details: 'Copilot Studio agent validated successfully',
      testedAt
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return {
      isValid: false,
      message: 'Validation failed',
      details: errorMessage,
      testedAt
    }
  }
}

/**
 * Validate Azure Foundry configuration
 * NOTE: Azure AI Foundry requires Azure AD OAuth2 authentication (DefaultAzureCredential)
 * API keys are NOT supported. This validation only checks that fields are provided.
 * Full authentication requires Azure AD integration which is not available in Tauri apps.
 */
export async function validateAzureFoundryConfig(
  projectEndpoint: string,
  agentName: string,
  tenantId: string,
  clientId: string,
  clientSecret: string,
  region: string
): Promise<ValidationResult> {
  const testedAt = new Date()
  
  try {
    if (!projectEndpoint || !agentName || !tenantId || !clientId || !clientSecret || !region) {
      return {
        isValid: false,
        message: 'Missing required configuration',
        details: 'Project endpoint, agent name, tenant ID, client ID, client secret, and region are all required',
        testedAt
      }
    }

    // Validate endpoint format
    if (!projectEndpoint.startsWith('https://')) {
      return {
        isValid: false,
        message: 'Invalid endpoint format',
        details: 'Project endpoint must start with https://',
        testedAt
      }
    }

    // Validate GUID formats
    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!guidRegex.test(tenantId)) {
      return {
        isValid: false,
        message: 'Invalid tenant ID format',
        details: 'Tenant ID must be a valid GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)',
        testedAt
      }
    }
    if (!guidRegex.test(clientId)) {
      return {
        isValid: false,
        message: 'Invalid client ID format',
        details: 'Client ID must be a valid GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)',
        testedAt
      }
    }

    console.log('🧪 Validating Azure Foundry config:', { projectEndpoint, agentName, region, tenantId: tenantId.substring(0, 8) + '...' })

    // Test OAuth2 token acquisition with the service principal credentials
    // This validates that the tenant ID, client ID, and client secret are correct
    try {
      const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://ai.azure.com/.default'
      })

      const response = await fetch<{ access_token: string; expires_in: number; token_type: string }>(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: Body.text(params.toString()),
        responseType: ResponseType.JSON,
      })

      if (!response.ok) {
        return {
          isValid: false,
          message: 'Authentication failed',
          details: `HTTP ${response.status}: Failed to acquire OAuth2 token. Verify tenant ID, client ID, and client secret are correct.`,
          testedAt
        }
      }

      const tokenData = response.data
      if (!tokenData.access_token) {
        return {
          isValid: false,
          message: 'Invalid token response',
          details: 'OAuth2 token endpoint did not return an access token',
          testedAt
        }
      }

      console.log('✅ Successfully acquired OAuth2 token')

      return {
        isValid: true,
        message: 'Connection successful',
        details: `Service principal authenticated successfully. Agent ID: ${agentName}, Region: ${region}. Token expires in ${Math.floor(tokenData.expires_in / 60)} minutes.`,
        testedAt
      }
    } catch (authError) {
      const errorMessage = authError instanceof Error ? authError.message : String(authError)
      const sanitizedErrorMessage = redactSensitiveText(errorMessage, [clientSecret])
      console.error('❌ OAuth2 authentication error:', sanitizedErrorMessage)
      return {
        isValid: false,
        message: 'Authentication failed',
        details: `Failed to acquire OAuth2 token: ${sanitizedErrorMessage}. Check tenant ID, client ID, and client secret.`,
        testedAt
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const sanitizedErrorMessage = redactSensitiveText(errorMessage, [clientSecret])
    console.error('❌ Azure Foundry validation error:', sanitizedErrorMessage)
    return {
      isValid: false,
      message: 'Validation failed',
      details: `Unexpected error: ${sanitizedErrorMessage}`,
      testedAt
    }
  }
}

/**
 * Validate all service configurations at once
 */
export async function validateAllServices(
  config: AppConfig
): Promise<Record<string, ValidationResult>> {
  const results: Record<string, ValidationResult> = {}

  // Validate ACS
  const acsResult = await validateAcsConfig(config.acs.endpoint, config.acs.accessKey)
  results.acs = acsResult

  // Validate Speech
  const speechResult = await validateSpeechConfig(
    config.speech.key,
    config.speech.region
  )
  results.speech = speechResult

  // Validate OpenAI
  const openaiResult = await validateOpenAIConfig(
    config.openai.endpoint,
    config.openai.apiKey,
    config.openai.deployment
  )
  results.openai = openaiResult

  return results
}
