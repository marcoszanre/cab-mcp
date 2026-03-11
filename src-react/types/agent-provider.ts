// ============================================
// Agent Provider Types
// Self-contained types for AI agent providers.
// Replaces the old types/providers/ directory.
// ============================================

/**
 * Provider authentication state
 */
export interface ProviderAuthState {
  isAuthenticated: boolean
  isAuthenticating: boolean
  error?: string
  expiresAt?: Date
  account?: {
    id?: string
    username?: string
    displayName?: string
  }
  tokens?: {
    accessToken?: string
    refreshToken?: string
  }
  /** Device code flow specific */
  deviceCode?: {
    userCode: string
    verificationUri: string
    expiresIn: number
    message: string
  }
}

/**
 * Agent connection state
 */
export type AgentConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'

/**
 * Conversation message role
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'function'

/**
 * Suggested action from agent
 */
export interface AgentSuggestedAction {
  type: 'button' | 'link' | 'imBack' | 'postBack'
  title: string
  value: string
  displayText?: string
}

/**
 * Agent message
 */
export interface AgentMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: Date
  /** Suggested actions/quick replies */
  suggestedActions?: AgentSuggestedAction[]
  /** Attachments (images, files, etc.) */
  attachments?: AgentAttachment[]
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Agent attachment
 */
export interface AgentAttachment {
  id: string
  contentType: string
  name?: string
  contentUrl?: string
  content?: unknown
  thumbnailUrl?: string
}

/**
 * Agent conversation
 */
export interface AgentConversation {
  id: string
  startedAt: Date
  lastActivityAt: Date
  messages: AgentMessage[]
  isActive: boolean
}

/**
 * Agent response
 */
export interface AgentResponse {
  conversationId: string | null
  messages: AgentMessage[]
  suggestedActions?: AgentSuggestedAction[]
  endOfConversation?: boolean
}

/**
 * Copilot Studio specific configuration
 */
export interface CopilotStudioAgentConfig {
  id: string
  name: string
  type: 'copilot-studio'
  category: 'agent'
  authType: 'device-code'
  createdAt: Date
  updatedAt?: Date
  settings: {
    clientId: string
    tenantId: string
    environmentId: string
    botId: string
    botName?: string
    [key: string]: unknown
  }
}

/**
 * Azure Foundry specific configuration
 */
export interface AzureFoundryAgentConfig {
  id: string
  name: string
  type: 'azure-foundry'
  category: 'agent'
  authType: 'api-key' | 'service-principal'
  createdAt: Date
  updatedAt?: Date
  settings: {
    projectEndpoint: string
    agentName: string
    apiKey?: string
    tenantId?: string
    clientId?: string
    clientSecret?: string
    region: string
    displayName?: string
    [key: string]: unknown
  }
}

/**
 * Agent provider event callbacks
 */
export interface AgentProviderCallbacks {
  onConnectionStateChanged?: (state: AgentConnectionState) => void
  onMessageReceived?: (message: AgentMessage) => void
  onConversationStarted?: (conversation: AgentConversation) => void
  onConversationEnded?: (conversationId: string) => void
  onTyping?: () => void
  onError?: (error: Error) => void
  onAuthStateChanged?: (state: ProviderAuthState) => void
}

/**
 * Agent provider interface
 * Implemented by CopilotStudioAgentProvider and AzureFoundryAgentProvider.
 */
export interface IAgentProvider {
  readonly type: string
  readonly category: 'agent'
  readonly providerType: string

  /** Current connection state */
  readonly connectionState: AgentConnectionState

  /** Current conversation */
  readonly conversation: AgentConversation | null

  /** Authentication state (if applicable) */
  readonly authState: ProviderAuthState | null

  /** Set callbacks for events */
  setCallbacks(callbacks: AgentProviderCallbacks): void

  /** Initialize the provider with configuration */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initialize(config: any): Promise<void>

  /** Authenticate with the agent service */
  authenticate(): Promise<ProviderAuthState>

  /** Check if currently authenticated */
  isAuthenticated(): boolean

  /** Start a new conversation */
  startConversation(): Promise<AgentResponse>

  /** Send a message to the agent */
  sendMessage(text: string): Promise<AgentResponse>

  /** Send a suggested action */
  sendAction(action: AgentSuggestedAction): Promise<AgentResponse>

  /** End the current conversation */
  endConversation(): Promise<void>

  /** Get conversation history */
  getHistory(): AgentMessage[]

  /** Clear conversation history */
  clearHistory(): void

  /** Clean up resources */
  dispose(): Promise<void>
}
