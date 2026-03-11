import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { 
  CopilotAuthState, 
  CopilotConversationState, 
  ConversationMessage,
  DeviceCodeInfo,
  AgentSession,
  Question
} from '@/types'

type AuthState = 'idle' | 'authenticating' | 'authenticated' | 'error'

interface AgentState {
  // Simplified auth state for hooks
  authState: AuthState
  deviceCode: DeviceCodeInfo | null
  accessToken: string | null
  tokenExpiresAt: Date | null
  displayName: string
  
  // Auth actions for hooks
  setAuthState: (state: AuthState) => void
  setDeviceCode: (deviceCode: DeviceCodeInfo | null) => void
  setAccessToken: (token: string, expiresAt: Date) => void
  setDisplayName: (name: string) => void
  
  // Conversation state for hooks
  conversationId: string | null
  messages: ConversationMessage[]
  isProcessing: boolean
  
  // Conversation actions for hooks
  setConversationId: (id: string | null) => void
  addMessage: (message: Omit<ConversationMessage, 'id'>) => void
  clearMessages: () => void
  setIsProcessing: (processing: boolean) => void
  
  // Legacy auth state (for backward compat)
  auth: CopilotAuthState
  setAuthenticating: (isAuthenticating: boolean) => void
  setAuthenticated: (account: CopilotAuthState['account']) => void
  setAuthError: (error: string | null) => void
  signOut: () => void
  
  // Legacy conversation state
  conversation: CopilotConversationState
  setConnecting: (isConnecting: boolean) => void
  setConnected: (conversationId: string) => void
  setConversationError: (error: string | null) => void
  endConversation: () => void
  
  // Session state (for mention detection)
  session: AgentSession
  startSession: (speaker: string) => void
  endSession: () => void
  setFollowUpWindow: (active: boolean) => void
  
  // Questions tracking
  questions: Question[]
  addQuestion: (speaker: string, text: string) => void
  updateQuestionResponseTime: (questionId: string, responseTime: number) => void
  
  // Agent responses
  responseCount: number
  incrementResponseCount: () => void
}

export const useAgentStore = create<AgentState>()(
  devtools(
    (set) => ({
      // New simplified state for hooks
      authState: 'idle' as AuthState,
      deviceCode: null,
      accessToken: null,
      tokenExpiresAt: null,
      // Only use env var in development mode
      displayName: import.meta.env.DEV ? (import.meta.env.VITE_AGENT_NAME || 'John Doe') : 'John Doe',
      conversationId: null,
      messages: [],
      isProcessing: false,
      
      // New actions for hooks
      setAuthState: (authState) => set({ authState }, false, 'setAuthState'),
      
      setDeviceCode: (deviceCode) => set(
        (state) => ({
          deviceCode,
          auth: { ...state.auth, deviceCode }
        }),
        false,
        'setDeviceCode'
      ),
      
      setAccessToken: (accessToken, tokenExpiresAt) => set(
        (state) => ({
          accessToken,
          tokenExpiresAt,
          authState: 'authenticated' as AuthState,
          auth: {
            ...state.auth,
            isAuthenticated: true,
            isAuthenticating: false,
          }
        }),
        false,
        'setAccessToken'
      ),
      
      setDisplayName: (displayName) => set({ displayName }, false, 'setDisplayName'),
      
      setConversationId: (conversationId) => set(
        (state) => ({
          conversationId,
          conversation: {
            ...state.conversation,
            isConnected: conversationId !== null,
            conversationId
          }
        }),
        false,
        'setConversationId'
      ),
      
      addMessage: (message) => set(
        (state) => ({
          messages: [
            ...state.messages,
            { ...message, id: crypto.randomUUID() }
          ],
          conversation: {
            ...state.conversation,
            messages: [
              ...state.conversation.messages,
              { ...message, id: crypto.randomUUID(), timestamp: message.timestamp }
            ]
          }
        }),
        false,
        'addMessage'
      ),
      
      clearMessages: () => set(
        (state) => ({
          messages: [],
          conversation: { ...state.conversation, messages: [] }
        }),
        false,
        'clearMessages'
      ),
      
      setIsProcessing: (isProcessing) => set({ isProcessing }, false, 'setIsProcessing'),
      
      // Initial legacy auth state
      auth: {
        isAuthenticated: false,
        isAuthenticating: false,
        account: null,
        deviceCode: null,
        error: null,
      },
      
      // Initial conversation state
      conversation: {
        isConnected: false,
        isConnecting: false,
        conversationId: null,
        messages: [],
        error: null,
      },
      
      // Initial session state
      session: {
        isActive: false,
        speaker: null,
        startedAt: null,
        inFollowUpWindow: false,
      },
      
      // Initial questions
      questions: [],
      responseCount: 0,

      // Auth actions
      setAuthenticating: (isAuthenticating) =>
        set(
          (state) => ({
            auth: { ...state.auth, isAuthenticating, error: null },
          }),
          false,
          'setAuthenticating'
        ),
      
      setAuthenticated: (account) =>
        set(
          (state) => ({
            auth: {
              ...state.auth,
              isAuthenticated: true,
              isAuthenticating: false,
              account,
              deviceCode: null,
            },
          }),
          false,
          'setAuthenticated'
        ),
      
      setAuthError: (error) =>
        set(
          (state) => ({
            auth: { ...state.auth, error, isAuthenticating: false },
          }),
          false,
          'setAuthError'
        ),
      
      signOut: () =>
        set(
          {
            auth: {
              isAuthenticated: false,
              isAuthenticating: false,
              account: null,
              deviceCode: null,
              error: null,
            },
            conversation: {
              isConnected: false,
              isConnecting: false,
              conversationId: null,
              messages: [],
              error: null,
            },
          },
          false,
          'signOut'
        ),

      // Conversation actions
      setConnecting: (isConnecting) =>
        set(
          (state) => ({
            conversation: { ...state.conversation, isConnecting, error: null },
          }),
          false,
          'setConnecting'
        ),
      
      setConnected: (conversationId) =>
        set(
          (state) => ({
            conversation: {
              ...state.conversation,
              isConnected: true,
              isConnecting: false,
              conversationId,
            },
          }),
          false,
          'setConnected'
        ),
      
      setConversationError: (error) =>
        set(
          (state) => ({
            conversation: { ...state.conversation, error, isConnecting: false },
          }),
          false,
          'setConversationError'
        ),
      
      endConversation: () =>
        set(
          (state) => ({
            conversation: {
              ...state.conversation,
              isConnected: false,
              conversationId: null,
            },
            session: {
              isActive: false,
              speaker: null,
              startedAt: null,
              inFollowUpWindow: false,
            },
          }),
          false,
          'endConversation'
        ),

      // Session actions
      startSession: (speaker) =>
        set(
          {
            session: {
              isActive: true,
              speaker,
              startedAt: new Date(),
              inFollowUpWindow: false,
            },
          },
          false,
          'startSession'
        ),
      
      endSession: () =>
        set(
          {
            session: {
              isActive: false,
              speaker: null,
              startedAt: null,
              inFollowUpWindow: false,
            },
          },
          false,
          'endSession'
        ),
      
      setFollowUpWindow: (active) =>
        set(
          (state) => ({
            session: { ...state.session, inFollowUpWindow: active },
          }),
          false,
          'setFollowUpWindow'
        ),

      // Questions tracking
      addQuestion: (speaker, text) =>
        set(
          (state) => ({
            questions: [
              ...state.questions,
              {
                id: crypto.randomUUID(),
                speaker,
                text,
                timestamp: new Date(),
                responseTime: null,
              },
            ],
          }),
          false,
          'addQuestion'
        ),
      
      updateQuestionResponseTime: (questionId, responseTime) =>
        set(
          (state) => ({
            questions: state.questions.map((q) =>
              q.id === questionId ? { ...q, responseTime } : q
            ),
          }),
          false,
          'updateQuestionResponseTime'
        ),
      
      incrementResponseCount: () =>
        set(
          (state) => ({ responseCount: state.responseCount + 1 }),
          false,
          'incrementResponseCount'
        ),
    }),
    { name: 'agent-store' }
  )
)
