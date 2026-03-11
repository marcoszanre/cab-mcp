// ============================================
// useMeetingAgent - Unified hook for all agent types in meetings
// Provides a consistent interface for Copilot Studio and Azure Foundry
// ============================================

import { useCallback, useRef, useState, useEffect } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useAppStore } from '@/stores/appStore'
import { getCallAnalyticsService } from '@/services/analyticsService'
import type {
  IAgentProvider,
  AgentConnectionState
} from '@/types/agent-provider'

// Context for messages (used for enriching agent requests)
export interface MessageContext {
  captions?: { speaker: string; text: string }[]
  chatMessages?: { sender: string; text: string }[]
}

// Callback for when agent receives a message
export interface AgentMessageCallback {
  (message: { role: 'user' | 'assistant'; text: string; timestamp: Date }): void
}

// Callback for auth prompts (device code flow)
export interface AuthPromptCallback {
  (prompt: { userCode: string; verificationUri?: string; message?: string } | null): void
}

// Options for the hook
export interface UseMeetingAgentOptions {
  onMessageReceived?: AgentMessageCallback
  onAuthPrompt?: AuthPromptCallback
  mode?: 'meeting' | 'pre-meeting'
  emitTelemetry?: boolean
  syncAgentStore?: boolean
  emitAppLogs?: boolean
  requireAccessTokenForCopilot?: boolean
}

// Unified config that can represent any agent type
export interface MeetingAgentConfig {
  type: 'copilot-studio' | 'azure-foundry'
  // Copilot Studio (authenticated)
  clientId?: string
  tenantId?: string
  environmentId?: string
  botId?: string
  botName?: string
  // Azure Foundry
  projectEndpoint?: string
  agentName?: string
  clientSecret?: string
  region?: string
  displayName?: string
}

interface UseMeetingAgentReturn {
  // State
  isConnected: boolean
  isConnecting: boolean
  isTyping: boolean
  isProcessing: boolean
  connectionState: AgentConnectionState
  conversationId: string | null
  error: string | null
  authPrompt: { userCode: string; verificationUri?: string; message?: string } | null
  
  // Actions
  connect: (config: MeetingAgentConfig) => Promise<{ success: boolean; conversationId: string | null }>
  sendMessage: (text: string, speaker?: string, context?: MessageContext) => Promise<{ text: string } | null>
  disconnect: () => Promise<void>
  
  // Provider access (for advanced use)
  provider: IAgentProvider | null
}

/**
 * Unified hook for using any agent type in meetings
 * Abstracts away the differences between Copilot Studio and Azure Foundry
 */
export function useMeetingAgent(options?: UseMeetingAgentOptions): UseMeetingAgentReturn {
  const analyticsService = getCallAnalyticsService()
  const mode = options?.mode ?? 'meeting'
  const emitTelemetry = options?.emitTelemetry ?? mode === 'meeting'
  const syncAgentStore = options?.syncAgentStore ?? mode === 'meeting'
  const emitAppLogs = options?.emitAppLogs ?? mode === 'meeting'
  const requireAccessTokenForCopilot = options?.requireAccessTokenForCopilot ?? mode === 'meeting'
  
  // Store the options callback in a ref so it's always up to date
  const onMessageReceivedRef = useRef(options?.onMessageReceived)
  useEffect(() => {
    onMessageReceivedRef.current = options?.onMessageReceived
  }, [options?.onMessageReceived])
  
  const onAuthPromptRef = useRef(options?.onAuthPrompt)
  useEffect(() => {
    onAuthPromptRef.current = options?.onAuthPrompt
  }, [options?.onAuthPrompt])
  
  // Provider instance
  const providerRef = useRef<IAgentProvider | null>(null)
  const configRef = useRef<MeetingAgentConfig | null>(null)
  // Ref-based connection guard to prevent race conditions (React state is async)
  const isConnectingRef = useRef(false)
  
  // State
  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [connectionState, setConnectionState] = useState<AgentConnectionState>('disconnected')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [authPrompt, setAuthPrompt] = useState<{ userCode: string; verificationUri?: string; message?: string } | null>(null)
  
  // Agent store for UI state
  const {
    addMessage,
    clearMessages,
    setConversationId: setStoreConversationId,
    setIsProcessing: setStoreIsProcessing,
    accessToken // For authenticated Copilot Studio
  } = useAgentStore()
  
  const { addLog } = useAppStore()

  const log = useCallback((message: string, level: Parameters<typeof addLog>[1]) => {
    if (emitAppLogs) {
      addLog(message, level)
    }
  }, [addLog, emitAppLogs])

  /**
   * Create the appropriate provider based on config type
   */
  const createProvider = useCallback(async (config: MeetingAgentConfig): Promise<IAgentProvider> => {
    switch (config.type) {
      case 'copilot-studio': {
        const { CopilotStudioAgentProvider } = await import('@/services/copilotStudioAgentProvider')
        const provider = new CopilotStudioAgentProvider()
        return provider as unknown as IAgentProvider
      }
      case 'azure-foundry': {
        const { AzureFoundryAgentProvider } = await import('@/services/azureFoundryAgentProvider')
        const provider = new AzureFoundryAgentProvider()
        return provider as unknown as IAgentProvider
      }
      default:
        throw new Error(`Unsupported agent type: ${config.type}`)
    }
  }, [])

  /**
   * Build provider-specific config - uses 'unknown' to avoid strict type checking
   * since provider configs have slightly different auth types
   */
  const buildProviderConfig = useCallback((config: MeetingAgentConfig): unknown => {
    const baseConfig = {
      id: `meeting-agent-${Date.now()}`,
      name: config.botName || config.displayName || config.agentName || 'Meeting Agent',
      createdAt: new Date(),
      category: 'agent' as const
    }

    switch (config.type) {
      case 'copilot-studio':
        return {
          ...baseConfig,
          type: 'copilot-studio',
          authType: 'microsoft-device-code',
          settings: {
            clientId: config.clientId || '',
            tenantId: config.tenantId || '',
            environmentId: config.environmentId || '',
            botId: config.botId || '',
            botName: config.botName
          }
        }

      case 'azure-foundry':
        return {
          ...baseConfig,
          type: 'azure-foundry',
          authType: 'service-principal',
          settings: {
            projectEndpoint: config.projectEndpoint || '',
            agentName: config.agentName || '',
            tenantId: config.tenantId || '',
            clientId: config.clientId || '',
            clientSecret: config.clientSecret || '',
            region: config.region || '',
            displayName: config.displayName
          }
        }

      default:
        throw new Error(`Unsupported agent type: ${config.type}`)
    }
  }, [])

  /**
   * Connect to an agent
   */
  const connect = useCallback(async (config: MeetingAgentConfig): Promise<{ success: boolean; conversationId: string | null }> => {
    // Guard: prevent multiple simultaneous connection attempts using ref (sync, no race)
    if (isConnectingRef.current) {
      log('⏳ Connection already in progress, skipping duplicate request', 'info')
      return { success: false, conversationId: null }
    }
    
    // Guard: if already connected with a conversation, skip
    if (isConnected && conversationId) {
      log('✓ Already connected to agent', 'info')
      return { success: true, conversationId }
    }

    // Cleanup existing provider
    if (providerRef.current) {
      try {
        await providerRef.current.dispose()
      } catch (e) {
        console.warn('Error disposing previous provider:', e)
      }
      providerRef.current = null
    }

    isConnectingRef.current = true
    setIsConnecting(true)
    setError(null)
    configRef.current = config

    try {
      log(`🤖 Connecting to ${config.type} agent...`, 'info')

      // Create provider
      const provider = await createProvider(config)
      providerRef.current = provider

      // Set up callbacks
      provider.setCallbacks({
        onConnectionStateChanged: (state) => {
          setConnectionState(state)
          setIsConnected(state === 'connected')
          if (state === 'error') {
            setError('Connection lost')
          }
        },
        onAuthStateChanged: (authState: unknown) => {
          const state = authState as { isAuthenticated?: boolean; deviceCode?: { userCode: string; verificationUri?: string; message?: string } }
          if (state.deviceCode) {
            const prompt = {
              userCode: state.deviceCode.userCode,
              verificationUri: state.deviceCode.verificationUri,
              message: state.deviceCode.message,
            }
            setAuthPrompt(prompt)
            onAuthPromptRef.current?.(prompt)
          }
          if (state.isAuthenticated) {
            setAuthPrompt(null)
            onAuthPromptRef.current?.(null)
          }
        },
        onMessageReceived: (message) => {
          setIsTyping(false)
          const msgPayload = {
            role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
            text: message.content,
            timestamp: message.timestamp
          }
          // Use custom callback if provided, otherwise use default store addMessage
          if (onMessageReceivedRef.current) {
            onMessageReceivedRef.current(msgPayload)
          } else if (syncAgentStore) {
            addMessage(msgPayload)
          }
        },
        onConversationStarted: (conversation) => {
          setConversationId(conversation.id)
          if (syncAgentStore) {
            setStoreConversationId(conversation.id)
          }
          log(`📡 Conversation started: ${conversation.id.substring(0, 20)}...`, 'info')
        },
        onConversationEnded: () => {
          setConversationId(null)
          if (syncAgentStore) {
            setStoreConversationId(null)
          }
          setIsConnected(false)
          setIsTyping(false)
        },
        onError: (err) => {
          setIsTyping(false)
          setError(err.message)
          log(`❌ Agent error: ${err.message}`, 'error')
        },
        onTyping: () => {
          setIsTyping(true)
        }
      })

      // Initialize provider
      const providerConfig = buildProviderConfig(config)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await provider.initialize(providerConfig as any)

      // For authenticated Copilot Studio, we need to authenticate first
      if (config.type === 'copilot-studio') {
        if (requireAccessTokenForCopilot && !accessToken) {
          throw new Error('No access token available. Please sign in first.')
        }
        // The provider will use the token from the auth service
        await provider.authenticate()
      } else if (config.type === 'azure-foundry') {
        // Foundry uses service principal auth
        await provider.authenticate()
      }
      // Anonymous doesn't need auth

      // Start conversation
      const response = await provider.startConversation()

      // NOTE: Welcome messages are already added via the onMessageReceived callback
      // when the provider emits them. We only log here for visibility.
      if (response.messages && response.messages.length > 0) {
        for (const msg of response.messages) {
          if (msg.role === 'assistant' && msg.content) {
            log(`Welcome: "${msg.content.substring(0, 50)}..."`, 'success')
          }
        }
      }

      setIsConnected(true)
      setIsConnecting(false)
      isConnectingRef.current = false
      setConnectionState('connected')
      log(`✅ Connected to ${config.type} agent`, 'success')

      return { success: true, conversationId: response.conversationId }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to connect'
      setError(errorMessage)
      setIsConnecting(false)
      isConnectingRef.current = false
      setConnectionState('error')
      log(`❌ Connection failed: ${errorMessage}`, 'error')
      return { success: false, conversationId: null }
    }
  }, [
    createProvider,
    buildProviderConfig,
    log,
    addMessage,
    setStoreConversationId,
    accessToken,
    requireAccessTokenForCopilot,
    isConnecting,
    isConnected,
    conversationId,
    syncAgentStore
  ])

  /**
   * Send a message to the agent
   */
  const sendMessage = useCallback(async (
    text: string,
    speaker?: string,
    _context?: MessageContext
  ): Promise<{ text: string } | null> => {
    const provider = providerRef.current
    
    if (!provider) {
      log('Agent provider not initialized', 'error')
      return null
    }

    if (!isConnected) {
      const providerState = provider.connectionState
      log(`⚠️ Sending while local state is disconnected (provider state: ${providerState})`, 'warning')

      if (providerState === 'connected') {
        setIsConnected(true)
        setConnectionState('connected')
      }
    }

    setIsProcessing(true)
    setIsTyping(false)
    if (syncAgentStore) {
      setStoreIsProcessing(true)
    }

    const traceId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    console.log(`[TRACE][useMeetingAgent][${traceId}] sendMessage enter`, {
      providerType: provider.type,
      localConnected: isConnected,
      providerState: provider.connectionState,
      speaker,
      textPreview: text.slice(0, 120)
    })

    try {
      // Note: Caller is responsible for adding user message to UI before calling sendMessage
      // This prevents duplicate messages when called from MeetingStage

      // Track for analytics
      if (emitTelemetry && speaker) {
        try {
          analyticsService.trackQuestion(speaker, text)
        } catch (telemetryError) {
          console.warn('Question telemetry failed:', telemetryError)
        }
      }

      log(`📤 Sending: "${text.substring(0, 50)}..."`, 'info')

      // Send to agent (with one recovery attempt for dropped/expired conversation state)
      let response
      try {
        console.log(`[TRACE][useMeetingAgent][${traceId}] provider.sendMessage attempt-1`)
        response = await provider.sendMessage(text)
      } catch (primarySendError) {
        const message = primarySendError instanceof Error ? primarySendError.message : String(primarySendError)
        const needsConversationRecovery = /No active conversation|startConversation|conversation/i.test(message)

        console.warn(`[TRACE][useMeetingAgent][${traceId}] provider.sendMessage attempt-1 failed`, { message })

        if (!needsConversationRecovery) {
          throw primarySendError
        }

        log('🔄 Send failed due to conversation state, restarting conversation and retrying once', 'warning')
        await provider.startConversation()
        console.log(`[TRACE][useMeetingAgent][${traceId}] provider.sendMessage attempt-2 after startConversation`)
        response = await provider.sendMessage(text)
      }

      console.log(`[TRACE][useMeetingAgent][${traceId}] provider.sendMessage resolved`, {
        messagesCount: response.messages?.length ?? 0,
        hasSuggestedActions: Boolean(response.suggestedActions?.length),
        endOfConversation: Boolean(response.endOfConversation)
      })

      // Process response
      let responseText: string | null = null
      
      if (response.messages && response.messages.length > 0) {
        for (const msg of response.messages) {
          if (msg.role === 'assistant' && msg.content) {
            responseText = msg.content
            const assistantPayload = {
              role: 'assistant' as const,
              text: msg.content,
              timestamp: msg.timestamp || new Date()
            }

            // Fallback: ensure assistant messages reach UI even when provider callback misses them
            if (onMessageReceivedRef.current) {
              onMessageReceivedRef.current(assistantPayload)
            } else if (syncAgentStore) {
              addMessage(assistantPayload)
            }

            // Message already added via callback, but ensure it's tracked
            if (emitTelemetry) {
              try {
                analyticsService.trackResponse(msg.content)
              } catch (telemetryError) {
                console.warn('Response telemetry failed:', telemetryError)
              }
            }
            log(`📥 Response: "${msg.content.substring(0, 50)}..."`, 'success')
          }
        }
      }

      if (!responseText) {
        log('ℹ️ No immediate response payload; waiting for provider callback message', 'info')
      }

      setIsProcessing(false)
      setIsTyping(false)
      if (syncAgentStore) {
        setStoreIsProcessing(false)
      }

      return responseText ? { text: responseText } : null

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to send message'
      console.error(`[TRACE][useMeetingAgent][${traceId}] sendMessage failed`, { errorMessage })
      log(`❌ Send failed: ${errorMessage}`, 'error')
      setIsProcessing(false)
      setIsTyping(false)
      if (syncAgentStore) {
        setStoreIsProcessing(false)
      }
      return null
    }
  }, [isConnected, log, addMessage, setStoreIsProcessing, syncAgentStore, emitTelemetry, analyticsService])

  /**
   * Disconnect from the agent
   */
  const disconnect = useCallback(async () => {
    const provider = providerRef.current
    
    if (provider) {
      try {
        await provider.endConversation()
        await provider.dispose()
      } catch (e) {
        console.warn('Error disconnecting:', e)
      }
      providerRef.current = null
    }

    if (syncAgentStore) {
      clearMessages()
    }
    setConversationId(null)
    if (syncAgentStore) {
      setStoreConversationId(null)
    }
    setIsConnected(false)
    setIsTyping(false)
    setConnectionState('disconnected')
    setError(null)
    setAuthPrompt(null)
    configRef.current = null
    
    log('Disconnected from agent', 'info')
  }, [clearMessages, setStoreConversationId, log, syncAgentStore])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (providerRef.current) {
        providerRef.current.endConversation().catch(() => {})
        providerRef.current.dispose().catch(console.error)
        providerRef.current = null
      }
      // Reset store state so UI doesn't show stale agent session
      if (syncAgentStore) {
        clearMessages()
        setStoreConversationId(null)
      }
    }
  }, [clearMessages, setStoreConversationId, syncAgentStore])

  return {
    isConnected,
    isConnecting,
    isTyping,
    isProcessing,
    connectionState,
    conversationId,
    error,
    authPrompt,
    connect,
    sendMessage,
    disconnect,
    provider: providerRef.current
  }
}
