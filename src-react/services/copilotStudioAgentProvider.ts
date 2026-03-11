// ============================================
// Copilot Studio Agent Provider
// Agent provider implementation for Microsoft Copilot Studio
// Uses Tauri HTTP API for device code flow (CORS-free)
// ============================================

import { shell, http } from '@tauri-apps/api'
import { ConnectionSettings, CopilotStudioClient } from '@microsoft/agents-copilotstudio-client'
const COPILOT_AUTH_CACHE_KEY = 'copilot-auth-cache'

function storeCopilotAuthCacheLocal(serialized: string): void {
  localStorage.setItem(COPILOT_AUTH_CACHE_KEY, serialized)
}

function getCopilotAuthCacheLocal(): string | null {
  return localStorage.getItem(COPILOT_AUTH_CACHE_KEY)
}

function deleteCopilotAuthCacheLocal(): void {
  localStorage.removeItem(COPILOT_AUTH_CACHE_KEY)
}

import type {
  CopilotStudioAgentConfig,
  IAgentProvider,
  AgentConnectionState,
  AgentMessage,
  AgentConversation,
  AgentResponse,
  AgentSuggestedAction,
  AgentProviderCallbacks,
  ProviderAuthState,
} from '@/types/agent-provider'

// Internal types from Copilot Studio SDK
interface CopilotActivity {
  type: string
  text?: string
  conversation?: { id: string }
  suggestedActions?: {
    actions: Array<{
      type: string
      title: string
      value: string
    }>
  }
}

// OAuth response types
interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
  message: string
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope: string
}

interface TokenErrorResponse {
  error: string
  error_description?: string
}

interface JwtPayload {
  preferred_username?: string
  upn?: string
  email?: string
  name?: string
  tid?: string
  exp?: number
  [key: string]: unknown
}

// Legacy browser cache key retained only for migration cleanup.
const AUTH_CACHE_KEY = 'copilot-studio-auth-cache'

function getLegacyAuthCache(): string | null {
  try {
    return sessionStorage.getItem(AUTH_CACHE_KEY) || localStorage.getItem(AUTH_CACHE_KEY)
  } catch {
    return null
  }
}

function clearLegacyAuthCache(): void {
  try {
    sessionStorage.removeItem(AUTH_CACHE_KEY)
  } catch {
    // ignore
  }

  try {
    localStorage.removeItem(AUTH_CACHE_KEY)
  } catch {
    // ignore
  }
}

/**
 * Tauri HTTP POST helper - bypasses CORS because we're a desktop app!
 */
async function tauriHttpPost(url: string, bodyString: string): Promise<{ ok: boolean; data: unknown }> {
  try {
    const response = await http.fetch<unknown>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: http.Body.text(bodyString)
    })
    return { ok: response.ok, data: response.data }
  } catch (error) {
    console.error('Tauri HTTP error:', error)
    throw error
  }
}

/**
 * Parse JWT token payload
 */
function parseJwt(token: string): JwtPayload | null {
  try {
    const base64Url = token.split('.')[1]
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    )
    return JSON.parse(jsonPayload)
  } catch {
    return null
  }
}

/**
 * Copilot Studio Agent Provider
 * Standalone implementation — no BaseProvider inheritance.
 */
export class CopilotStudioAgentProvider implements IAgentProvider {

  readonly type = 'copilot-studio'
  readonly category = 'agent' as const
  readonly providerType = 'copilot-studio'

  // Config & status (previously from BaseProvider)
  private _config: CopilotStudioAgentConfig | null = null
  private _status: string = 'uninitialized'
  private _error?: string

  private copilotClient: CopilotStudioClient | null = null
  private connectionSettings: ConnectionSettings | null = null
  private callbacks: AgentProviderCallbacks = {}

  private _connectionState: AgentConnectionState = 'disconnected'
  private _conversation: AgentConversation | null = null
  private _authState: ProviderAuthState | null = null

  // OAuth settings
  private authority: string = ''
  private tokenEndpoint: string = ''
  private deviceCodeEndpoint: string = ''
  private scopes = 'https://api.powerplatform.com/.default offline_access'

  // Token storage
  private accessToken: string | null = null
  private refreshToken: string | null = null
  private tokenExpiresAt: Date | null = null
  private account: JwtPayload | null = null

  // Polling state
  private isPolling = false

  get config(): CopilotStudioAgentConfig | null {
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
   * Initialize the provider with configuration
   */
  async initialize(config: CopilotStudioAgentConfig): Promise<void> {
    this._status = 'initializing'

    try {
      this._config = config

      console.log('🤖 Initializing Copilot Studio Agent Provider...')

      const { clientId, tenantId, environmentId, botId } = config.settings

      if (!clientId || !tenantId || !environmentId || !botId) {
        throw new Error('Copilot Studio configuration incomplete: clientId, tenantId, environmentId, and botId are required')
      }

      // Set up OAuth endpoints
      this.authority = `https://login.microsoftonline.com/${tenantId}`
      this.tokenEndpoint = `${this.authority}/oauth2/v2.0/token`
      this.deviceCodeEndpoint = `${this.authority}/oauth2/v2.0/devicecode`

      // Initialize Copilot Studio connection settings
      this.connectionSettings = new ConnectionSettings({
        appClientId: clientId,
        tenantId,
        environmentId,
        agentIdentifier: botId
      })

      // Check for cached authentication
      await this.loadCachedAuth()

      console.log('🤖 Copilot Studio Agent Provider initialized')
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
   * Authenticate with device code flow
   */
  async authenticate(): Promise<ProviderAuthState> {
    if (!this._config) {
      throw new Error('Provider not initialized')
    }

    this._status = 'authenticating'
    this._authState = {
      isAuthenticated: false,
      isAuthenticating: true
    }
    this.callbacks.onAuthStateChanged?.(this._authState)

    try {
      // Try to refresh existing token first
      if (this.refreshToken && this.isTokenExpiringSoon()) {
        try {
          await this.refreshAccessToken()
          return this._authState!
        } catch {
          console.log('🤖 Token refresh failed, starting device code flow')
        }
      }

      // Check if we have a valid token
      if (this.accessToken && !this.isTokenExpired()) {
        this._authState = {
          isAuthenticated: true,
          isAuthenticating: false,
          account: {
            username: this.account?.preferred_username || this.account?.email,
            displayName: this.account?.name
          },
          tokens: {
            accessToken: this.accessToken,
            refreshToken: this.refreshToken || undefined
          },
          expiresAt: this.tokenExpiresAt || undefined
        }
        this._status = 'ready'
        this.callbacks.onAuthStateChanged?.(this._authState)
        return this._authState
      }

      // Start device code flow
      return await this.authenticateWithDeviceCode()

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Authentication failed'
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
   * Authenticate using device code flow
   */
  private async authenticateWithDeviceCode(): Promise<ProviderAuthState> {
    const { clientId } = this._config!.settings

    // Request device code
    const deviceCodeBody = new URLSearchParams({
      client_id: clientId,
      scope: this.scopes
    }).toString()

    const deviceCodeResponse = await tauriHttpPost(this.deviceCodeEndpoint, deviceCodeBody)

    if (!deviceCodeResponse.ok) {
      const error = deviceCodeResponse.data as TokenErrorResponse
      throw new Error(`Device code request failed: ${error.error_description || error.error}`)
    }

    const deviceCode = deviceCodeResponse.data as DeviceCodeResponse

    // Update auth state with device code
    this._authState = {
      isAuthenticated: false,
      isAuthenticating: true,
      deviceCode: {
        userCode: deviceCode.user_code,
        verificationUri: deviceCode.verification_uri,
        expiresIn: deviceCode.expires_in,
        message: deviceCode.message
      }
    }
    this.callbacks.onAuthStateChanged?.(this._authState)

    // Open verification URL in browser
    try {
      await shell.open(deviceCode.verification_uri_complete || deviceCode.verification_uri)
    } catch (err) {
      console.warn('Could not open browser:', err)
    }

    // Poll for token
    return await this.pollForToken(deviceCode, clientId)
  }

  /**
   * Poll for token after device code is displayed
   */
  private async pollForToken(deviceCode: DeviceCodeResponse, clientId: string): Promise<ProviderAuthState> {
    this.isPolling = true
    const expiresAt = Date.now() + (deviceCode.expires_in * 1000)
    const interval = deviceCode.interval * 1000

    while (this.isPolling && Date.now() < expiresAt) {
      await new Promise(resolve => setTimeout(resolve, interval))

      if (!this.isPolling) break

      const tokenBody = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: deviceCode.device_code
      }).toString()

      const tokenResponse = await tauriHttpPost(this.tokenEndpoint, tokenBody)

      if (tokenResponse.ok) {
        const tokens = tokenResponse.data as TokenResponse
        await this.handleTokenResponse(tokens)
        this.isPolling = false
        return this._authState!
      }

      const error = tokenResponse.data as TokenErrorResponse

      if (error.error === 'authorization_pending') {
        continue
      } else if (error.error === 'slow_down') {
        await new Promise(resolve => setTimeout(resolve, interval))
        continue
      } else if (error.error === 'expired_token') {
        throw new Error('Device code expired. Please try again.')
      } else {
        throw new Error(error.error_description || error.error)
      }
    }

    if (!this.isPolling) {
      throw new Error('Authentication cancelled')
    }

    throw new Error('Device code expired')
  }

  /**
   * Handle token response
   */
  private async handleTokenResponse(tokens: TokenResponse): Promise<void> {
    this.accessToken = tokens.access_token
    this.refreshToken = tokens.refresh_token || this.refreshToken
    this.tokenExpiresAt = new Date(Date.now() + (tokens.expires_in * 1000))

    // Parse JWT to get account info
    this.account = parseJwt(tokens.access_token)

    // Cache the auth - await to ensure persistence before continuing
    await this.cacheAuth()

    this._authState = {
      isAuthenticated: true,
      isAuthenticating: false,
      account: {
        username: this.account?.preferred_username || this.account?.email,
        displayName: this.account?.name
      },
      tokens: {
        accessToken: this.accessToken,
        refreshToken: this.refreshToken || undefined
      },
      expiresAt: this.tokenExpiresAt
    }

    this._status = 'ready'
    this.callbacks.onAuthStateChanged?.(this._authState)
  }

  /**
   * Refresh access token
   */
  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken || !this._config) {
      throw new Error('No refresh token available')
    }

    const { clientId } = this._config.settings

    const refreshBody = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: this.refreshToken,
      scope: this.scopes
    }).toString()

    const response = await tauriHttpPost(this.tokenEndpoint, refreshBody)

    if (!response.ok) {
      const error = response.data as TokenErrorResponse
      this.clearAuth()
      throw new Error(`Token refresh failed: ${error.error_description || error.error}`)
    }

    const tokens = response.data as TokenResponse
    await this.handleTokenResponse(tokens)
  }

  /**
   * Check if token is expired
   */
  private isTokenExpired(): boolean {
    if (!this.tokenExpiresAt) return true
    return this.tokenExpiresAt.getTime() < Date.now()
  }

  /**
   * Check if token is expiring soon (within 5 minutes)
   */
  private isTokenExpiringSoon(): boolean {
    if (!this.tokenExpiresAt) return true
    return this.tokenExpiresAt.getTime() < Date.now() + (5 * 60 * 1000)
  }

  /**
   * Cache authentication
   */
  private async cacheAuth(): Promise<void> {
    const cache = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      tokenExpiresAt: this.tokenExpiresAt?.toISOString(),
      account: this.account
    }
    const serialized = JSON.stringify(cache)
    storeCopilotAuthCacheLocal(serialized)
  }

  /**
   * Load cached authentication
   */
  private async loadCachedAuth(): Promise<void> {
    try {
      const cached =
        getCopilotAuthCacheLocal() ||
        getLegacyAuthCache()

      clearLegacyAuthCache()

      if (!cached) return

      const cache = JSON.parse(cached)
      this.accessToken = cache.accessToken
      this.refreshToken = cache.refreshToken
      this.tokenExpiresAt = cache.tokenExpiresAt ? new Date(cache.tokenExpiresAt) : null
      this.account = cache.account

      // If we have a refresh token and token is expiring, refresh it
      if (this.refreshToken && this.isTokenExpiringSoon()) {
        await this.refreshAccessToken()
      } else if (this.accessToken && !this.isTokenExpired()) {
        this._authState = {
          isAuthenticated: true,
          isAuthenticating: false,
          account: {
            username: this.account?.preferred_username || this.account?.email,
            displayName: this.account?.name
          },
          tokens: {
            accessToken: this.accessToken,
            refreshToken: this.refreshToken || undefined
          },
          expiresAt: this.tokenExpiresAt || undefined
        }
      }
    } catch {
      this.clearAuth()
    }
  }

  /**
   * Clear authentication
   */
  private clearAuth(): void {
    this.accessToken = null
    this.refreshToken = null
    this.tokenExpiresAt = null
    this.account = null

    void deleteCopilotAuthCacheLocal()

    try {
      clearLegacyAuthCache()
    } catch {
      // ignore
    }
  }

  /**
   * Check if currently authenticated
   */
  isAuthenticated(): boolean {
    return this._authState?.isAuthenticated ?? false
  }

  /**
   * Start a new conversation
   */
  async startConversation(): Promise<AgentResponse> {
    // Guard: prevent starting multiple conversations
    if (this._connectionState === 'connecting') {
      console.log('🤖 Conversation start already in progress, skipping duplicate')
      return {
        conversationId: this._conversation?.id || null,
        messages: []
      }
    }

    // Guard: if already connected with an active conversation, return existing
    if (this._connectionState === 'connected' && this._conversation?.isActive) {
      console.log('🤖 Already have active conversation, returning existing')
      return {
        conversationId: this._conversation.id,
        messages: this._conversation.messages
      }
    }

    if (!this.isAuthenticated() || !this.accessToken) {
      throw new Error('Not authenticated. Call authenticate() first.')
    }

    this.setConnectionState('connecting')

    try {
      // Refresh token if needed
      if (this.isTokenExpiringSoon() && this.refreshToken) {
        await this.refreshAccessToken()
      }

      // Create Copilot client with current token
      this.copilotClient = new CopilotStudioClient(this.connectionSettings!, this.accessToken)

      // Start conversation
      const activities = await this.copilotClient.startConversationAsync(true) as CopilotActivity[]

      // Process response
      const messages: AgentMessage[] = []
      let conversationId: string | null = null
      let suggestedActions: AgentSuggestedAction[] | undefined

      for (const activity of activities) {
        if (activity.type === 'message' && activity.text) {
          const message: AgentMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: activity.text,
            timestamp: new Date(),
            suggestedActions: activity.suggestedActions?.actions.map(a => ({
              type: 'button',
              title: a.title,
              value: a.value
            }))
          }
          messages.push(message)
          this.callbacks.onMessageReceived?.(message)

          conversationId = activity.conversation?.id || null
          suggestedActions = message.suggestedActions
        }
      }

      // Create conversation
      this._conversation = {
        id: conversationId || crypto.randomUUID(),
        startedAt: new Date(),
        lastActivityAt: new Date(),
        messages,
        isActive: true
      }

      this.setConnectionState('connected')
      this._status = 'connected'
      this.callbacks.onConversationStarted?.(this._conversation)

      return {
        conversationId,
        messages,
        suggestedActions
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start conversation'
      this.setConnectionState('error')
      this._error = message
      throw error
    }
  }

  /**
   * Send a message to the agent
   */
  async sendMessage(text: string): Promise<AgentResponse> {
    if (!this.copilotClient) {
      throw new Error('No active conversation. Call startConversation() first.')
    }

    // Refresh token if needed
    if (this.isTokenExpiringSoon() && this.refreshToken) {
      await this.refreshAccessToken()
      // Recreate client with new token
      this.copilotClient = new CopilotStudioClient(this.connectionSettings!, this.accessToken!)
    }

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

      const activities = await this.copilotClient.askQuestionAsync(
        text,
        this._conversation?.id || undefined
      ) as CopilotActivity[]

      const messages: AgentMessage[] = []
      let suggestedActions: AgentSuggestedAction[] | undefined
      let endOfConversation = false

      for (const activity of activities) {
        if (activity.type === 'message' && activity.text) {
          const message: AgentMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: activity.text,
            timestamp: new Date(),
            suggestedActions: activity.suggestedActions?.actions.map(a => ({
              type: 'button',
              title: a.title,
              value: a.value
            }))
          }
          messages.push(message)

          if (this._conversation) {
            this._conversation.messages.push(message)
          }

          this.callbacks.onMessageReceived?.(message)
          suggestedActions = message.suggestedActions
        } else if (activity.type === 'endOfConversation') {
          endOfConversation = true
          if (this._conversation) {
            this._conversation.isActive = false
          }
        }
      }

      if (this._conversation) {
        this._conversation.lastActivityAt = new Date()
      }

      return {
        conversationId: this._conversation?.id || null,
        messages,
        suggestedActions,
        endOfConversation
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

    this.copilotClient = null
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
   * Sign out and clear cached authentication
   */
  async signOut(): Promise<void> {
    console.log('🔓 Signing out from Copilot Studio...')

    // Clear tokens
    this.accessToken = null
    this.refreshToken = null
    this.tokenExpiresAt = null
    this.account = null

    // Clear cached auth from localStorage
    this.clearAuth()

    // Update auth state
    this._authState = {
      isAuthenticated: false,
      isAuthenticating: false,
      account: undefined
    }

    // End any active conversation
    await this.endConversation()

    // Notify callbacks
    this.callbacks.onAuthStateChanged?.(this._authState)

    console.log('✅ Signed out successfully')
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    try {
      this.isPolling = false
      await this.endConversation()
      this.connectionSettings = null
      this._authState = null
      this._status = 'disposed'
    } catch (error) {
      console.error('Error disposing CopilotStudioAgentProvider:', error)
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
