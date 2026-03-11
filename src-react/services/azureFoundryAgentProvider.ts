// ============================================
// Azure Foundry Agent Provider
// Agent provider implementation for Azure AI Foundry
// Uses REST API with OAuth2 Service Principal authentication
// ============================================

import { http } from '@tauri-apps/api'

import type {
  AzureFoundryAgentConfig,
  IAgentProvider,
  AgentConnectionState,
  AgentMessage,
  AgentConversation,
  AgentResponse,
  AgentSuggestedAction,
  AgentProviderCallbacks,
  ProviderAuthState,
} from '@/types/agent-provider'

// OAuth2 token response
interface TokenResponse {
  access_token: string
  expires_in: number
  token_type: string
}

// Token cache entry
interface CachedToken {
  token: string
  expiresAt: number // Unix timestamp in milliseconds
}

// Foundry API types
interface FoundryAgent {
  id: string
  name: string
  versions?: {
    latest?: {
      name: string
    }
  }
}

interface FoundryConversation {
  id: string
  items?: FoundryConversationItem[]
}

interface FoundryConversationItem {
  type: string
  role: 'user' | 'assistant' | 'system'
  content: string
  id?: string
}

interface FoundryResponse {
  id: string
  output_text?: string
  output?: Array<{
    type: string
    content?:
      | string
      | Array<{
          type?: string
          text?: string
          value?: string
        }>
    text?: string
  }>
  status?: string
  error?: {
    message?: string
    code?: string
  }
}

/**
 * HTTP helper for Foundry API calls with OAuth2 bearer token
 */
async function foundryRequest<T>(
  method: 'GET' | 'POST',
  url: string,
  bearerToken: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${bearerToken}`,
    'Content-Type': 'application/json'
  }

  const response = await http.fetch<T>(url, {
    method,
    headers,
    body: body ? http.Body.json(body) : undefined
  })

  if (!response.ok) {
    const errorText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
    throw new Error(`Foundry API error (${response.status}): ${errorText}`)
  }

  return response.data
}

/**
 * Azure Foundry Agent Provider
 * Standalone implementation — no BaseProvider inheritance.
 * Uses Azure AI Projects REST API for communication.
 */
export class AzureFoundryAgentProvider implements IAgentProvider {

  readonly type = 'azure-foundry'
  readonly category = 'agent' as const
  readonly providerType = 'azure-foundry'

  // Config & status (previously from BaseProvider)
  private _config: AzureFoundryAgentConfig | null = null
  private _status: string = 'uninitialized'
  private _error?: string

  private callbacks: AgentProviderCallbacks = {}

  private _connectionState: AgentConnectionState = 'disconnected'
  private _conversation: AgentConversation | null = null
  private _authState: ProviderAuthState | null = null

  // Foundry state
  private agent: FoundryAgent | null = null
  private conversationId: string | null = null

  // OAuth2 token cache
  private tokenCache: CachedToken | null = null

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Extract assistant text from various Foundry/OpenAI Responses payload shapes.
   */
  private extractResponseText(response: FoundryResponse): string {
    if (response.output_text && response.output_text.trim()) {
      return response.output_text.trim()
    }

    const textParts: string[] = []

    const collectStrings = (value: unknown): void => {
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed) {
          textParts.push(trimmed)
        }
        return
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          collectStrings(item)
        }
        return
      }

      if (!value || typeof value !== 'object') {
        return
      }

      const record = value as Record<string, unknown>

      const directKeys = ['text', 'value', 'content', 'output_text', 'message']
      for (const key of directKeys) {
        if (key in record) {
          collectStrings(record[key])
        }
      }
    }

    if (!Array.isArray(response.output)) {
      return textParts.join('\n\n').trim()
    }

    for (const outputItem of response.output) {
      if (typeof outputItem?.text === 'string' && outputItem.text.trim()) {
        textParts.push(outputItem.text.trim())
      }

      if (typeof outputItem?.content === 'string' && outputItem.content.trim()) {
        textParts.push(outputItem.content.trim())
      }

      if (Array.isArray(outputItem?.content)) {
        for (const contentItem of outputItem.content) {
          if (typeof contentItem?.text === 'string' && contentItem.text.trim()) {
            textParts.push(contentItem.text.trim())
          } else if (typeof contentItem?.value === 'string' && contentItem.value.trim()) {
            textParts.push(contentItem.value.trim())
          }
        }
      }

      collectStrings(outputItem)
    }

    return [...new Set(textParts)].join('\n\n').trim()
  }

  /**
   * Poll a response until completion when the initial POST returns in-progress payload.
   */
  private async waitForResponseCompletion(
    projectEndpoint: string,
    token: string,
    initialResponse: FoundryResponse,
    maxAttempts = 45,
    delayMs = 1000
  ): Promise<FoundryResponse> {
    let current = initialResponse

    const isFailureStatus = (status?: string) => {
      if (!status) return false
      const normalized = status.toLowerCase()
      return normalized === 'failed' || normalized === 'cancelled' || normalized === 'canceled' || normalized === 'error'
    }

    let extractedText = this.extractResponseText(current)
    if (extractedText || isFailureStatus(current.status)) {
      return current
    }

    const responseId = current.id
    if (!responseId) {
      return current
    }

    const responseUrl = `${projectEndpoint}/openai/responses/${encodeURIComponent(responseId)}?api-version=2025-11-15-preview`

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.wait(delayMs)

      current = await foundryRequest<FoundryResponse>('GET', responseUrl, token)
      extractedText = this.extractResponseText(current)

      if (extractedText || isFailureStatus(current.status)) {
        return current
      }
    }

    return current
  }

  get config(): AzureFoundryAgentConfig | null {
    return this._config
  }

  get status(): string {
    return this._status
  }

  get error(): string | undefined {
    return this._error
  }

  get connectionState(): AgentConnectionState {
    return this._connectionState
  }

  get conversation(): AgentConversation | null {
    return this._conversation
  }

  get authState(): ProviderAuthState | null {
    return this._authState
  }

  /**
   * Acquire OAuth2 access token using client credentials flow
   */
  private async acquireToken(): Promise<string> {
    if (!this._config) {
      throw new Error('Provider not initialized')
    }

    // Check cache first
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token
    }

    const { tenantId, clientId, clientSecret } = this._config.settings

    // Build token request
    const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId || '',
      client_secret: clientSecret || '',
      scope: 'https://ai.azure.com/.default'
    })

    const response = await http.fetch<TokenResponse>(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: http.Body.text(params.toString())
    })

    if (!response.ok) {
      const errorText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      throw new Error(`Failed to acquire token (${response.status}): ${errorText}`)
    }

    const tokenData = response.data

    // Cache token (expires_in is in seconds, subtract 5 minutes for safety)
    const expiresIn = (tokenData.expires_in - 300) * 1000 // Convert to ms, minus 5min buffer
    this.tokenCache = {
      token: tokenData.access_token,
      expiresAt: Date.now() + expiresIn
    }

    console.log('🔑 Acquired new OAuth2 token, expires in', Math.floor(expiresIn / 1000 / 60), 'minutes')
    return tokenData.access_token
  }

  /**
   * Clear the token cache
   */
  private clearTokenCache(): void {
    this.tokenCache = null
  }

  /**
   * Initialize the provider with configuration
   */
  async initialize(config: AzureFoundryAgentConfig): Promise<void> {
    this._status = 'initializing'

    try {
      this._config = config

      console.log('🤖 Initializing Azure Foundry Agent Provider...')

      const { projectEndpoint, agentName, tenantId, clientId, clientSecret } = config.settings

      if (!projectEndpoint || !agentName || !tenantId || !clientId || !clientSecret) {
        throw new Error('Azure Foundry configuration incomplete: projectEndpoint, agentName, tenantId, clientId, and clientSecret are required')
      }

      // For service principal auth, initially mark as not authenticated
      this._authState = {
        isAuthenticated: false,
        isAuthenticating: false
      }

      console.log('🤖 Azure Foundry Agent Provider initialized')
      this._status = 'ready'
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this._error = errorMessage
      this._status = 'error'
      throw error
    }
  }

  /**
   * Set callbacks for events
   */
  setCallbacks(callbacks: AgentProviderCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks }
  }

  /**
   * Authenticate - for service principal auth, acquire a token
   */
  async authenticate(): Promise<ProviderAuthState> {
    if (!this._config) {
      throw new Error('Provider not initialized')
    }

    this._status = 'authenticating'

    try {
      // Acquire OAuth2 token (this validates credentials)
      await this.acquireToken()

      // Verify access by retrieving the agent
      await this.retrieveAgent()

      this._authState = {
        isAuthenticated: true,
        isAuthenticating: false
      }

      this._status = 'ready'
      this.callbacks.onAuthStateChanged?.(this._authState)
      return this._authState

    } catch (error) {
      this.clearTokenCache()
      const errorMessage = error instanceof Error ? error.message : 'Failed to authenticate with Azure Foundry'
      this._authState = {
        isAuthenticated: false,
        isAuthenticating: false,
        error: errorMessage
      }
      this._status = 'error'
      this._error = errorMessage
      this.callbacks.onAuthStateChanged?.(this._authState)
      throw error
    }
  }

  /**
   * Retrieve the agent from Foundry
   */
  private async retrieveAgent(): Promise<FoundryAgent> {
    if (!this._config) {
      throw new Error('Provider not initialized')
    }

    const { projectEndpoint, agentName } = this._config.settings
    const token = await this.acquireToken()

    // Build agent URL - the endpoint should be like https://xxx.services.ai.azure.com/api/projects/xxx
    const agentUrl = `${projectEndpoint}/agents/${encodeURIComponent(agentName)}?api-version=2025-11-15-preview`

    this.agent = await foundryRequest<FoundryAgent>('GET', agentUrl, token)
    console.log('🤖 Retrieved Foundry agent:', this.agent.name, 'id:', this.agent.id)

    return this.agent
  }

  /**
   * Check if currently authenticated
   */
  isAuthenticated(): boolean {
    return this._authState?.isAuthenticated ?? false
  }

  /**
   * Start a new conversation
   * Note: We don't create the conversation here - we'll create it with the first message
   * This matches the Microsoft sample pattern
   */
  async startConversation(): Promise<AgentResponse> {
    if (!this._config) {
      throw new Error('Provider not initialized')
    }

    this.setConnectionState('connecting')

    try {
      // Make sure we have the agent
      if (!this.agent) {
        await this.retrieveAgent()
      }

      // Don't create conversation yet - will be created with first message
      // This matches the Microsoft sample: conversation is created with initial user message
      this.conversationId = null
      console.log('🤖 Foundry agent ready, conversation will be created with first message')

      // Create conversation record
      this._conversation = {
        id: '', // Will be set when conversation is created
        startedAt: new Date(),
        lastActivityAt: new Date(),
        messages: [],
        isActive: true
      }

      this.setConnectionState('connected')
      this._status = 'connected'
      this.callbacks.onConversationStarted?.(this._conversation)

      return {
        conversationId: '',
        messages: []
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to initialize agent'
      this.setConnectionState('error')
      this._error = message
      throw error
    }
  }

  /**
   * Send a message to the agent
   * Based on Microsoft sample pattern:
   * 1. Create conversation with initial user message (if needed)
   * 2. Generate response using agent reference
   */
  async sendMessage(text: string): Promise<AgentResponse> {
    if (!this._config) {
      throw new Error('Provider not initialized')
    }

    if (!this.agent) {
      throw new Error('Agent not retrieved. Call startConversation() first.')
    }

    const { projectEndpoint, agentName } = this._config.settings
    const token = await this.acquireToken()

    // Add user message to conversation
    const userMessage: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date()
    }

    if (this._conversation) {
      this._conversation.messages.push(userMessage)
      this._conversation.lastActivityAt = new Date()
    }

    try {
      this.callbacks.onTyping?.()

      // If no conversation exists, create one with the initial user message
      // Matches Microsoft sample: openAIClient.conversations.create({ items: [{ type: "message", role: "user", content: "..." }] })
      if (!this.conversationId) {
        console.log('🤖 Creating Foundry conversation with initial message...')
        const conversationsUrl = `${projectEndpoint}/openai/conversations?api-version=2025-11-15-preview`

        const conversation = await foundryRequest<FoundryConversation>(
          'POST',
          conversationsUrl,
          token,
          {
            items: [{
              type: 'message',
              role: 'user',
              content: text
            }]
          }
        )

        this.conversationId = conversation.id
        if (this._conversation) {
          this._conversation.id = this.conversationId
        }
        console.log('🤖 Created Foundry conversation:', this.conversationId)
      }

      // Generate response using the agent
      // Azure AI Foundry expects 'input' parameter with the user's message
      console.log('🤖 Generating response with agent:', agentName)
      const responsesUrl = `${projectEndpoint}/openai/responses?api-version=2025-11-15-preview`

      const initialResponse = await foundryRequest<FoundryResponse>(
        'POST',
        responsesUrl,
        token,
        {
          conversation: this.conversationId,
          input: text,
          agent: {
            name: agentName,
            type: 'agent_reference'
          }
        }
      )

      const response = await this.waitForResponseCompletion(projectEndpoint, token, initialResponse)

      // Extract response text from output
      // Azure AI Foundry may return immediate or delayed output structures
      console.log('🤖 Raw response:', JSON.stringify(response, null, 2))

      const responseText = this.extractResponseText(response)

      if (!responseText) {
        const status = response.status ? ` (status: ${response.status})` : ''
        const errorDetails = response.error?.message ? `: ${response.error.message}` : ''
        throw new Error(`No response text available from Foundry${status}${errorDetails}`)
      }

      const messages: AgentMessage[] = []

      if (responseText) {
        const assistantMessage: AgentMessage = {
          id: response.id || crypto.randomUUID(),
          role: 'assistant',
          content: responseText,
          timestamp: new Date()
        }
        messages.push(assistantMessage)

        if (this._conversation) {
          this._conversation.messages.push(assistantMessage)
        }

        this.callbacks.onMessageReceived?.(assistantMessage)
      }

      if (this._conversation) {
        this._conversation.lastActivityAt = new Date()
      }

      return {
        conversationId: this._conversation?.id || null,
        messages
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send message'
      this.callbacks.onError?.(new Error(message))
      throw error
    }
  }

  /**
   * Send a suggested action
   */
  async sendAction(action: AgentSuggestedAction): Promise<AgentResponse> {
    return this.sendMessage(action.value)
  }

  /**
   * End the current conversation
   */
  async endConversation(): Promise<void> {
    if (this._conversation) {
      this._conversation.isActive = false
      const conversationId = this._conversation.id
      this._conversation = null
      this.callbacks.onConversationEnded?.(conversationId)
    }

    this.conversationId = null
    this.setConnectionState('disconnected')
  }

  /**
   * Get conversation history
   */
  getHistory(): AgentMessage[] {
    return this._conversation?.messages || []
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    if (this._conversation) {
      this._conversation.messages = []
    }
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    try {
      await this.endConversation()
      this.agent = null
      this._authState = null
      this._status = 'disposed'
    } catch (error) {
      console.error('Error disposing AzureFoundryAgentProvider:', error)
    }
  }

  /**
   * Set connection state and notify callbacks
   */
  private setConnectionState(state: AgentConnectionState): void {
    if (this._connectionState !== state) {
      this._connectionState = state
      this.callbacks.onConnectionStateChanged?.(state)
    }
  }
}
