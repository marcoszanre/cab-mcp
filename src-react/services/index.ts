// Services Index

export { getCopilotAuthService, initCopilotAuth, CopilotAuthService } from './copilotAuthService'
export { getAcsCallService, AcsCallService } from './acsService'
export { getTextToSpeechService, TextToSpeechService } from './ttsService'
export { 
  getCallAnalyticsService, 
  CallAnalyticsService, 
  type CallAnalytics, 
  type CallStats,
  type TopQuestion 
} from './analyticsService'
export {
  getIntentDetectionService,
  type IntentConfig,
  type ConversationContext,
  type IntentResult,
  type ChatOverrideResult
} from './intentDetectionService'
export {
  getCaptionAggregationService,
  type CaptionEntry,
  type AggregatedCaption,
  type MentionResult,
  type PendingMention,
  type GptConfig
} from './captionAggregationService'

export {
  getMeetingChatService,
  MeetingChatService,
  type MeetingChatMessage,
  type ChatServiceCallbacks
} from './chatService'

export {
  validateAcsConfig,
  validateSpeechConfig,
  validateOpenAIConfig,
  validateCopilotStudioConfig,
  validateAzureFoundryConfig,
  validateAllServices,
  type ValidationResult
} from './validationService'

// Config file service
export {
  loadAppConfig,
  loadRawAppConfig,
  saveAppConfig,
  getConfigFilePath,
  importAppConfig,
  isConfigFileServiceAvailable,
} from './configFileService'

// MCP handlers
export {
  handleListAgents,
  handleJoinMeeting,
  handleLeaveMeeting,
  handleListSessions,
} from './mcpHandlers'

// Multi-session infrastructure
export { AudioBridge, createAudioBridge, type IAudioBridge } from './audioBridge'
export { AgentServiceContainer } from './agentServiceContainer'
export { SessionManager, getSessionManager, resetSessionManager, type JoinStep } from './sessionManager'
export {
  AgentMeetingOrchestrator,
  type OrchestratorState,
  type OrchestratorEvent,
  type OrchestratorEventType,
  type OrchestratorConversationMessage,
  type OrchestratorSession,
  type LogLevel,
} from './agentMeetingOrchestrator'
