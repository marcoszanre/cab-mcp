// Teams Meeting Chat Service
// Manages chat functionality within Teams meetings using ACS Chat SDK

import type { ChatClient, ChatThreadClient } from '@azure/communication-chat'
import type { CommunicationIdentifierKind } from '@azure/communication-common'

type ChatSdkModule = typeof import('@azure/communication-chat')
type CommonSdkModule = typeof import('@azure/communication-common')
type EventfulChatClient = ChatClient & {
  off?: (event: string, handler: unknown) => void
}

export interface MeetingChatMessage {
  id: string
  content: string
  senderDisplayName: string
  senderId: string
  createdOn: Date
  isOwn: boolean
}

export interface ChatServiceCallbacks {
  onMessageReceived?: (message: MeetingChatMessage) => void
  onMessageSent?: (message: MeetingChatMessage) => void
  onError?: (error: string) => void
  onConnected?: () => void
  onDisconnected?: () => void
}

/**
 * Extract communication user ID from sender identifier
 */
function getSenderId(sender: CommunicationIdentifierKind | undefined): string {
  if (!sender) return ''
  if ('communicationUserId' in sender) {
    return sender.communicationUserId
  }
  if ('microsoftTeamsUserId' in sender) {
    return sender.microsoftTeamsUserId
  }
  if ('phoneNumber' in sender) {
    return sender.phoneNumber
  }
  return ''
}

/**
 * Teams Meeting Chat Service
 * Handles chat interop with Teams meetings
 */
export class MeetingChatService {
  private chatClient: ChatClient | null = null
  private chatThreadClient: ChatThreadClient | null = null
  private threadId: string | null = null
  private userId: string | null = null
  private displayName: string = 'AI Agent'
  private isConnected: boolean = false
  private callbacks: ChatServiceCallbacks = {}
  // Track the bound handler so we can remove it with .off()
  private _chatMessageHandler: ((event: unknown) => void) | null = null
  private _chatSdkPromise: Promise<ChatSdkModule> | null = null
  private _commonSdkPromise: Promise<CommonSdkModule> | null = null

  private async _getChatSdk(): Promise<ChatSdkModule> {
    this._chatSdkPromise ??= import('@azure/communication-chat')
    return this._chatSdkPromise
  }

  private async _getCommonSdk(): Promise<CommonSdkModule> {
    this._commonSdkPromise ??= import('@azure/communication-common')
    return this._commonSdkPromise
  }

  /**
   * Initialize the chat client with ACS credentials
   */
  async initialize(
    endpoint: string,
    token: string,
    userId: string,
    displayName: string
  ): Promise<boolean> {
    try {
      console.log('Initializing Meeting Chat Service...')
      
      this.userId = userId
      this.displayName = displayName

      const [{ ChatClient }, { AzureCommunicationTokenCredential }] = await Promise.all([
        this._getChatSdk(),
        this._getCommonSdk(),
      ])
      
      const tokenCredential = new AzureCommunicationTokenCredential(token)
      this.chatClient = new ChatClient(endpoint, tokenCredential)
      
      console.log('Chat client created successfully')
      return true
    } catch (error) {
      console.error('Failed to initialize chat client:', error)
      this.callbacks.onError?.(`Failed to initialize chat: ${error}`)
      return false
    }
  }

  /**
   * Connect to the meeting chat thread with retry and participant registration.
   * Call this after the call is connected and you have the threadId.
   */
  async connectToThread(threadId: string): Promise<boolean> {
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ok = await this._connectToThreadOnce(threadId)
      if (ok) {
        // Attempt to register as a participant (safety net for Teams interop)
        await this._tryRegisterAsParticipant()
        // Verify the connection is healthy by sending a test typing notification
        const healthy = await this._verifyConnection()
        if (healthy) return true
        console.warn(`[Chat] Connection health check failed on attempt ${attempt}/${maxAttempts}`)
        // Disconnect and retry
        await this.disconnect()
      }
      if (attempt < maxAttempts) {
        const delay = 2000 * Math.pow(2, attempt - 1) // 2s, 4s
        console.log(`[Chat] Retrying chat connection in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})...`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
    console.error('[Chat] All connection attempts failed')
    return false
  }

  /**
   * Single attempt to connect to the chat thread.
   */
  private async _connectToThreadOnce(threadId: string): Promise<boolean> {
    if (!this.chatClient) {
      console.error('Chat client not initialized')
      return false
    }

    try {
      console.log(`Connecting to chat thread: ${threadId}`)
      
      this.threadId = threadId
      this.chatThreadClient = this.chatClient.getChatThreadClient(threadId)
      
      // Start real-time notifications
      await this.chatClient.startRealtimeNotifications()
      
      // Remove previous handler if any to prevent stacking
      if (this._chatMessageHandler && this.chatClient) {
        ;(this.chatClient as EventfulChatClient).off?.('chatMessageReceived', this._chatMessageHandler)
      }
      
      // Subscribe to new messages
      this._chatMessageHandler = (event: unknown) => {
        const e = event as { threadId: string; id: string; message?: string; senderDisplayName?: string; sender: CommunicationIdentifierKind | undefined; createdOn: string }
        // Check if the message is for our thread
        if (e.threadId !== this.threadId) {
          return
        }

        const senderId = getSenderId(e.sender)
        const isOwn = senderId === this.userId
        
        const message: MeetingChatMessage = {
          id: e.id,
          content: e.message || '',
          senderDisplayName: e.senderDisplayName || 'Unknown',
          senderId,
          createdOn: new Date(e.createdOn),
          isOwn
        }

        console.log('Chat message received:', message)
        
        if (isOwn) {
          this.callbacks.onMessageSent?.(message)
        } else {
          this.callbacks.onMessageReceived?.(message)
        }
      }
      this.chatClient.on('chatMessageReceived', this._chatMessageHandler as Parameters<ChatClient['on']>[1])

      this.isConnected = true
      this.callbacks.onConnected?.()
      console.log('Connected to meeting chat thread')
      
      return true
    } catch (error) {
      console.error('Failed to connect to chat thread:', error)
      this.callbacks.onError?.(`Failed to connect to chat: ${error}`)
      return false
    }
  }

  /**
   * Try to explicitly add the ACS user as a chat participant.
   * For Teams meeting interop, the call SDK should handle this automatically,
   * but explicit registration acts as a safety net to prevent "temporarily joined" state.
   */
  private async _tryRegisterAsParticipant(): Promise<void> {
    if (!this.chatThreadClient || !this.userId) return
    try {
      await this.chatThreadClient.addParticipants({
        participants: [
          {
            id: { communicationUserId: this.userId },
            displayName: this.displayName,
          },
        ],
      })
      console.log('[Chat] Successfully registered as chat participant')
    } catch (error) {
      // Expected to fail in some Teams policies — log and continue
      console.log('[Chat] Participant self-registration skipped (may already be added):', (error as Error)?.message || error)
    }
  }

  /**
   * Verify the chat connection is healthy by listing a single message.
   */
  private async _verifyConnection(): Promise<boolean> {
    if (!this.chatThreadClient) return false
    try {
      const pages = this.chatThreadClient.listMessages({ maxPageSize: 1 })
      await pages.next()
      console.log('[Chat] Connection verified — message list succeeded')
      return true
    } catch (error) {
      console.warn('[Chat] Connection verification failed:', error)
      return false
    }
  }

  /**
   * Send a message to the meeting chat
   */
  async sendMessage(content: string): Promise<string | null> {
    if (!this.chatThreadClient) {
      console.error('Not connected to chat thread')
      return null
    }

    try {
      const sendMessageRequest = { content }
      const sendMessageOptions = { senderDisplayName: this.displayName }
      
      const result = await this.chatThreadClient.sendMessage(
        sendMessageRequest,
        sendMessageOptions
      )
      
      console.log(`Message sent with id: ${result.id}`)
      
      // Notify that we sent a message so it appears in the local chat UI
      const sentMessage: MeetingChatMessage = {
        id: result.id,
        content,
        senderDisplayName: this.displayName,
        senderId: this.userId || '',
        createdOn: new Date(),
        isOwn: true
      }
      this.callbacks.onMessageSent?.(sentMessage)
      
      return result.id
    } catch (error) {
      console.error('Failed to send message:', error)
      this.callbacks.onError?.(`Failed to send message: ${error}`)
      return null
    }
  }

  /**
   * Get chat history (messages sent before joining)
   * Note: ACS users can only see messages sent after they joined
   */
  async getMessages(maxMessages: number = 50): Promise<MeetingChatMessage[]> {
    if (!this.chatThreadClient) {
      console.error('Not connected to chat thread')
      return []
    }

    try {
      const messages: MeetingChatMessage[] = []
      const messagesIterator = this.chatThreadClient.listMessages({ maxPageSize: maxMessages })
      
      for await (const page of messagesIterator.byPage()) {
        for (const chatMessage of page) {
          // Only include text messages (not system messages)
          if (chatMessage.type === 'text' && chatMessage.content?.message) {
            const senderId = getSenderId(chatMessage.sender as CommunicationIdentifierKind | undefined)
            const isOwn = senderId === this.userId
            
            messages.push({
              id: chatMessage.id,
              content: chatMessage.content.message,
              senderDisplayName: chatMessage.senderDisplayName || 'Unknown',
              senderId,
              createdOn: chatMessage.createdOn,
              isOwn
            })
          }
        }
      }
      
      // Return in chronological order
      return messages.reverse()
    } catch (error) {
      console.error('Failed to get messages:', error)
      return []
    }
  }

  /**
   * Set callbacks for chat events
   */
  setCallbacks(callbacks: ChatServiceCallbacks): void {
    this.callbacks = callbacks
  }

  /**
   * Check if connected to chat
   */
  isConnectedToChat(): boolean {
    return this.isConnected && this.chatThreadClient !== null
  }

  /**
   * Get the current thread ID
   */
  getThreadId(): string | null {
    return this.threadId
  }

  /**
   * Disconnect from chat
   */
  async disconnect(): Promise<void> {
    try {
      if (this.chatClient) {
        // Remove specific event handler to prevent stacking
        if (this._chatMessageHandler) {
          ;(this.chatClient as EventfulChatClient).off?.('chatMessageReceived', this._chatMessageHandler)
          this._chatMessageHandler = null
        }
        await this.chatClient.stopRealtimeNotifications()
      }
    } catch (error) {
      console.error('Error stopping notifications:', error)
    }

    this.isConnected = false
    this.chatThreadClient = null
    this.threadId = null
    this.callbacks.onDisconnected?.()
    console.log('Disconnected from meeting chat')
  }

  /**
   * Dispose of the service
   */
  async dispose(): Promise<void> {
    await this.disconnect()
    this.chatClient = null
    this.userId = null
    this.callbacks = {}
  }
}

// Singleton instance
let instance: MeetingChatService | null = null

export function getMeetingChatService(): MeetingChatService {
  if (!instance) {
    instance = new MeetingChatService()
  }
  return instance
}
