// ============================================
// Teams Agent Bridge - TypeScript Types
// ============================================

// Re-export agent provider types (replaces old providers/ directory)
export * from './agent-provider'

// Re-export behavior types
export * from './behavior'
import type { ProactiveConfig } from './behavior'

// Re-export session types
export * from './session'

// Re-export MCP types
export * from './mcp'

// Re-export TTS provider types
export * from './tts-provider'

export type ConnectionStatus = 
  | 'disconnected' 
  | 'connecting' 
  | 'connected' 
  | 'in-lobby'
  | 'error'

export type MuteState = 'muted' | 'unmuted' | 'unknown'

export type SpeechState = 'idle' | 'synthesizing' | 'speaking' | 'error'

// Log Entry
export interface LogEntry {
  id: string
  message: string
  type: 'info' | 'success' | 'error' | 'warning'
  timestamp: Date
}

// Configuration Types
export interface CopilotStudioConfig {
  appClientId?: string  // Legacy alias for clientId
  clientId: string
  tenantId: string
  environmentId: string
  agentIdentifier?: string  // Legacy alias for botId
  botId: string
  botName?: string
}

export interface SpeechConfig {
  key: string
  region: string
  endpoint?: string
}

// Hardcoded speech defaults (not user-configurable — per-agent voiceName overrides these)
export const DEFAULT_SPEECH_VOICE = 'en-US-JennyNeural'
export const DEFAULT_SPOKEN_LANGUAGE = 'en-US'

export interface OpenAIConfig {
  endpoint: string
  deployment: string
  apiKey: string
}

export interface AcsConfig {
  endpoint: string
  accessKey: string
}

export interface AppConfig {
  acs: AcsConfig
  agentName: string
  callUrl?: string
  copilotStudio: CopilotStudioConfig
  speech: SpeechConfig
  openai: OpenAIConfig
}

// ACS / Call Types
export interface Participant {
  id: string
  displayName: string
  isMuted: boolean
  isSpeaking: boolean
}

export interface Caption {
  id: string
  speaker: string
  text: string
  timestamp: Date
  isFinal: boolean
  spokenLanguage?: string
}

// Agent Types
export interface DeviceCodeInfo {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  message: string
}

export interface ConversationMessage {
  id: string
  role: 'user' | 'agent' | 'assistant'
  text?: string
  content?: string
  timestamp: Date
  suggestedActions?: string[]
}

export interface AgentSession {
  isActive: boolean
  speaker: string | null
  startedAt: Date | null
  inFollowUpWindow: boolean
}

// Call Analytics Types
export interface CallStats {
  duration: number
  participantCount: number
  captionCount: number
  questionCount: number
  responseCount: number
  avgResponseTime: number
}

export interface Question {
  id: string
  speaker: string
  text: string
  timestamp: Date
  responseTime: number | null
}

export interface TranscriptEntry {
  speaker: string
  text: string
  timestamp: Date
}

export interface CallAnalytics {
  stats: CallStats
  transcript: TranscriptEntry[]
  questions: Question[]
  participants: string[]
  aiSummary: string | null
  isGeneratingSummary: boolean
}

// Copilot Auth State
export interface CopilotAuthState {
  isAuthenticated: boolean
  isAuthenticating: boolean
  account: {
    username?: string
    name?: string
  } | null
  deviceCode: DeviceCodeInfo | null
  error: string | null
}

// Copilot Conversation State
export interface CopilotConversationState {
  isConnected: boolean
  isConnecting: boolean
  conversationId: string | null
  messages: ConversationMessage[]
  error: string | null
}

// ============================================
// Agent Provider System Types
// ============================================

export type AgentProviderType = 'copilot-studio' | 'azure-foundry' | 'azure-openai' | 'custom'

export type AgentProviderAuthType = 'microsoft-device-code' | 'api-key' | 'default-credential' | 'oauth' | 'service-principal' | 'none'

export type AgentProviderStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'authenticating'

// Popular Azure Speech voices for agent TTS
export const AZURE_VOICES = [
  // HD voices (Dragon HD — most natural)
  { value: 'en-US-Ava:DragonHDLatestNeural', label: '✨ Ava HD (Female, Natural)', locale: 'en-US' },
  { value: 'en-US-Andrew:DragonHDLatestNeural', label: '✨ Andrew HD (Male, Natural)', locale: 'en-US' },
  { value: 'en-US-Brian:DragonHDLatestNeural', label: '✨ Brian HD (Male, Natural)', locale: 'en-US' },
  { value: 'en-US-Emma:DragonHDLatestNeural', label: '✨ Emma HD (Female, Natural)', locale: 'en-US' },
  // Standard Neural voices
  { value: 'en-US-JennyNeural', label: 'Jenny (Female, Conversational)', locale: 'en-US' },
  { value: 'en-US-AriaNeural', label: 'Aria (Female, Expressive)', locale: 'en-US' },
  { value: 'en-US-GuyNeural', label: 'Guy (Male, Conversational)', locale: 'en-US' },
  { value: 'en-US-DavisNeural', label: 'Davis (Male, Expressive)', locale: 'en-US' },
  { value: 'it-IT-ElsaNeural', label: 'Elsa (Italian, Female)', locale: 'it-IT' },
  { value: 'it-IT-DiegoNeural', label: 'Diego (Italian, Male)', locale: 'it-IT' },
  { value: 'fr-FR-DeniseNeural', label: 'Denise (French, Female)', locale: 'fr-FR' },
  { value: 'fr-FR-HenriNeural', label: 'Henri (French, Male)', locale: 'fr-FR' },
  { value: 'de-DE-KatjaNeural', label: 'Katja (German, Female)', locale: 'de-DE' },
  { value: 'de-DE-ConradNeural', label: 'Conrad (German, Male)', locale: 'de-DE' },
  { value: 'es-ES-ElviraNeural', label: 'Elvira (Spanish, Female)', locale: 'es-ES' },
  { value: 'es-ES-AlvaroNeural', label: 'Alvaro (Spanish, Male)', locale: 'es-ES' },
  { value: 'pt-BR-FranciscaNeural', label: 'Francisca (Portuguese BR, Female)', locale: 'pt-BR' },
  { value: 'pt-BR-AntonioNeural', label: 'Antonio (Portuguese BR, Male)', locale: 'pt-BR' },
  { value: 'ja-JP-NanamiNeural', label: 'Nanami (Japanese, Female)', locale: 'ja-JP' },
  { value: 'ja-JP-KeitaNeural', label: 'Keita (Japanese, Male)', locale: 'ja-JP' },
  { value: 'zh-CN-XiaoxiaoNeural', label: 'Xiaoxiao (Chinese, Female)', locale: 'zh-CN' },
  { value: 'zh-CN-YunxiNeural', label: 'Yunxi (Chinese, Male)', locale: 'zh-CN' },
  { value: 'ko-KR-SunHiNeural', label: 'SunHi (Korean, Female)', locale: 'ko-KR' },
  { value: 'nl-NL-ColetteNeural', label: 'Colette (Dutch, Female)', locale: 'nl-NL' },
  { value: 'pl-PL-AgnieszkaNeural', label: 'Agnieszka (Polish, Female)', locale: 'pl-PL' },
  { value: 'ru-RU-SvetlanaNeural', label: 'Svetlana (Russian, Female)', locale: 'ru-RU' },
  { value: 'hi-IN-SwaraNeural', label: 'Swara (Hindi, Female)', locale: 'hi-IN' },
  { value: 'ar-SA-ZariyahNeural', label: 'Zariyah (Arabic, Female)', locale: 'ar-SA' },
  { value: 'tr-TR-EmelNeural', label: 'Emel (Turkish, Female)', locale: 'tr-TR' },
  { value: 'sv-SE-SofieNeural', label: 'Sofie (Swedish, Female)', locale: 'sv-SE' },
] as const

// Available speaking styles for Azure Neural TTS (mstts:express-as)
export const AZURE_VOICE_STYLES = [
  { value: 'chat', label: 'Chat (Conversational)' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'cheerful', label: 'Cheerful' },
  { value: 'empathetic', label: 'Empathetic' },
  { value: 'calm', label: 'Calm' },
  { value: 'neutral', label: 'Neutral (No style)' },
] as const

// Welcome message configuration
export type WelcomeMessageMode = 'default' | 'custom' | 'agent-triggered'

export interface WelcomeMessageConfig {
  mode: WelcomeMessageMode
  /** Custom static message (used when mode is 'custom') */
  staticMessage?: string
  /** Prompt sent to the agent on join; agent's response becomes the welcome (used when mode is 'agent-triggered') */
  triggerPrompt?: string
}

// Base configuration for all agent providers
export interface BaseAgentProviderConfig {
  id: string
  name: string
  type: AgentProviderType
  authType: AgentProviderAuthType
  createdAt: Date
  // Voice configuration for TTS
  voiceName?: string
  // Speaking style for TTS (mstts:express-as)
  ttsStyle?: string
  // Style intensity for Azure mstts:express-as styledegree (0.01–2.0, default 1.3)
  styleDegree?: number
  // Speech rate for TTS (0.5 = slow, 1.0 = normal, 2.0 = fast)
  speechRate?: number
  // When true, caption mentions respond via chat instead of speech
  captionResponseAsChat?: boolean
  // Welcome message configuration
  welcomeConfig?: WelcomeMessageConfig
  // Proactive (role-play) mode configuration
  proactiveConfig?: ProactiveConfig
  // Pre/Post processing options
  preprocessing?: {
    enabled: boolean
    ttsOptimization?: boolean
    customRules?: string[]
  }
  postprocessing?: {
    enabled: boolean
    formatLinks?: boolean
    customRules?: string[]
  }
}

// Copilot Studio specific configuration (authenticated)
export interface CopilotStudioProviderConfig extends BaseAgentProviderConfig {
  type: 'copilot-studio'
  authType: 'microsoft-device-code'
  settings: {
    clientId: string
    tenantId: string
    environmentId: string
    botId: string
    botName?: string
  }
}

// Azure Foundry configuration
export interface AzureFoundryProviderConfig extends BaseAgentProviderConfig {
  type: 'azure-foundry'
  authType: 'api-key' | 'service-principal'
  settings: {
    /** AI Project endpoint URL */
    projectEndpoint: string
    /** Agent ID from Foundry */
    agentName: string
    /** API key for authentication (when authType is 'api-key') */
    apiKey?: string
    /** Azure AD Tenant ID (when authType is 'service-principal') */
    tenantId?: string
    /** Service Principal Client ID (when authType is 'service-principal') */
    clientId?: string
    /** Service Principal Client Secret (when authType is 'service-principal') */
    clientSecret?: string
    /** Azure region */
    region: string
    /** Optional display name */
    displayName?: string
  }
}

// Azure OpenAI configuration (for future use)
export interface AzureOpenAIProviderConfig extends BaseAgentProviderConfig {
  type: 'azure-openai'
  authType: 'api-key'
  settings: {
    endpoint: string
    deployment: string
    apiKey: string
    systemPrompt?: string
  }
}

// Union type for all provider configs
export type AgentProviderConfig = CopilotStudioProviderConfig | AzureFoundryProviderConfig | AzureOpenAIProviderConfig

// Runtime state for a provider instance
export interface AgentProviderInstance {
  config: AgentProviderConfig
  status: AgentProviderStatus
  error?: string
  // Auth state (for providers that need it)
  auth?: {
    isAuthenticated: boolean
    deviceCode?: DeviceCodeInfo
    accessToken?: string
    tokenExpiresAt?: Date
    account?: {
      username?: string
      name?: string
    }
  }
  // Conversation state
  conversation?: {
    id: string | null
    isConnected: boolean
  }
}

// ============================================
// Idle Timeout Types
// ============================================

export interface IdleTimeoutConfig {
  /** Whether idle timeout auto-leave is enabled (default: true) */
  enabled: boolean
  /** Minutes of being alone before auto-leaving (default: 5, min: 1, max: 60) */
  timeoutMinutes: number
  /** Milliseconds before timeout to send a warning message (default: 60000 = 1 min) */
  warningBeforeLeaveMs: number
}

export const DEFAULT_IDLE_TIMEOUT_CONFIG: IdleTimeoutConfig = {
  enabled: true,
  timeoutMinutes: 5,
  warningBeforeLeaveMs: 60_000,
}

// ============================================
// Meeting Behavior Types (persisted to config file)
// ============================================

export interface MeetingBehaviorConfig {
  autoLeave: IdleTimeoutConfig
}

export const DEFAULT_MEETING_BEHAVIOR_CONFIG: MeetingBehaviorConfig = {
  autoLeave: { ...DEFAULT_IDLE_TIMEOUT_CONFIG },
}

// ============================================
// User Preferences Types
// ============================================

export interface UserPreferences {
  // TTS voice preference
  defaultVoice?: string
  // Last used meeting URL (persists across restarts)
  lastMeetingUrl?: string
  // UI preferences
  ui?: {
    theme?: 'light' | 'dark' | 'system'
    logsExpanded?: boolean
    showAgentPanel?: boolean
  }
  // Idle timeout: auto-leave when agent is alone in meeting
  idleTimeout?: IdleTimeoutConfig
}

// ============================================
// Meeting-specific Agent State
// ============================================

export interface MeetingAgentState {
  // Display name for this meeting (can override default)
  agentName: string
  // Active provider for this meeting
  activeProviderId: string | null
  // Provider instances for this meeting
  providers: Record<string, AgentProviderInstance>
}
