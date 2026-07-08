// ============================================
// Coding Agent Provider (GitHub Copilot CLI)
// Implements IAgentProvider by delegating to Rust Tauri commands backed by the
// official github-copilot-sdk. One provider instance == one persistent Copilot
// session for the whole meeting (tools/MCP context persists across turns).
// ============================================

import { invoke } from '@tauri-apps/api/core'

import type {
  IAgentProvider,
  AgentConnectionState,
  AgentMessage,
  AgentConversation,
  AgentResponse,
  AgentSuggestedAction,
  AgentProviderCallbacks,
  ProviderAuthState,
} from '@/types/agent-provider'
import { loggers } from '@/lib/logger'

const log = loggers.providers

interface CodingAgentSettings {
  provider?: string
  cwd?: string
  model?: string
  systemMessage?: string
  allowShell?: boolean
  bin?: string
  timeoutMs?: number
}

interface CodingAgentInitConfig {
  settings?: CodingAgentSettings
  name?: string
}

interface CheckResult {
  available: boolean
  version?: string
  path?: string
  error?: string
}

/**
 * CodingAgentProvider — bridges the GitHub Copilot CLI as a meeting agent.
 *
 * Responses are text (often markdown/code), so this provider is chat-first;
 * the orchestrator decides speech vs chat based on the agent's configuration.
 */
export class CodingAgentProvider implements IAgentProvider {
  readonly type = 'coding-agent'
  readonly category = 'agent' as const
  readonly providerType = 'copilot-cli'

  // Unique key for the persistent Rust session (stable for this provider's life)
  private readonly instanceId = `coding-agent-${crypto.randomUUID()}`

  private settings: CodingAgentSettings = {}
  private callbacks: AgentProviderCallbacks = {}
  private history: AgentMessage[] = []

  private _connectionState: AgentConnectionState = 'disconnected'
  private _conversation: AgentConversation | null = null
  private _authState: ProviderAuthState | null = null
  private _sessionStarted = false
  private _prewarmed = false
  /** Serializes sends to the single persistent session so turns never overlap. */
  private _sendChain: Promise<unknown> = Promise.resolve()

  /** Enqueue a session operation so it runs strictly after the previous one. */
  private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._sendChain.then(fn, fn)
    this._sendChain = run.then(() => undefined, () => undefined)
    return run
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

  setCallbacks(callbacks: AgentProviderCallbacks): void {
    this.callbacks = callbacks
  }

  private setConnectionState(state: AgentConnectionState): void {
    this._connectionState = state
    this.callbacks.onConnectionStateChanged?.(state)
  }

  async initialize(config: CodingAgentInitConfig): Promise<void> {
    this.settings = config?.settings ?? {}
    this.setConnectionState('disconnected')
    log.info('Coding agent provider initialized (Copilot CLI)')
  }

  async authenticate(): Promise<ProviderAuthState> {
    const result = await invoke<CheckResult>('coding_agent_check', {
      bin: this.settings.bin,
    })

    if (!result.available) {
      const message = result.error || 'GitHub Copilot CLI not available'
      this._authState = { isAuthenticated: false, isAuthenticating: false, error: message }
      this.callbacks.onAuthStateChanged?.(this._authState)
      throw new Error(message)
    }

    this._authState = {
      isAuthenticated: true,
      isAuthenticating: false,
      account: { displayName: `Copilot CLI ${result.version ?? ''}`.trim() },
    }
    this.callbacks.onAuthStateChanged?.(this._authState)
    log.info(`Copilot CLI available (${result.version ?? 'unknown version'})`)
    return this._authState
  }

  isAuthenticated(): boolean {
    return this._authState?.isAuthenticated ?? false
  }

  async startConversation(): Promise<AgentResponse> {
    this.setConnectionState('connecting')
    await invoke('coding_agent_start_session', {
      req: {
        instanceId: this.instanceId,
        model: this.settings.model,
        cwd: this.settings.cwd,
        systemMessage: this.settings.systemMessage,
        allowShell: this.settings.allowShell ?? false,
        bin: this.settings.bin,
      },
    })

    this._sessionStarted = true
    this._conversation = {
      id: this.instanceId,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      messages: [],
      isActive: true,
    }
    this.setConnectionState('connected')
    this.callbacks.onConversationStarted?.(this._conversation)
    log.info('Coding agent session started (persistent)')

    // Pre-warm in the background: the first turn is slow because the CLI loads
    // MCP servers (config discovery), authorizes OAuth, and warms the model.
    // Firing a tiny throwaway prompt now (not awaited, not routed to callbacks)
    // moves that cost to join time so the user's first real question is fast.
    this._prewarm()

    return { conversationId: this.instanceId, messages: [] }
  }

  /** Fire-and-forget warmup so MCP servers/model are ready before the first question. */
  private _prewarm(): void {
    if (this._prewarmed) return
    this._prewarmed = true
    this._enqueue(() =>
      invoke<string>('coding_agent_send', {
        req: {
          instanceId: this.instanceId,
          prompt: 'Warmup: load your tools and reply with exactly READY. Do not use any tool.',
          timeoutSecs: 90,
        },
      })
    )
      .then(() => log.debug('Coding agent pre-warm complete'))
      .catch((err) => log.debug('Coding agent pre-warm skipped', undefined, err))
  }

  async sendMessage(text: string): Promise<AgentResponse> {
    if (!this._sessionStarted) {
      await this.startConversation()
    }

    this.callbacks.onTyping?.()

    const userMessage: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    }
    this.history.push(userMessage)

    const timeoutSecs = this.settings.timeoutMs
      ? Math.round(this.settings.timeoutMs / 1000)
      : undefined

    const responseText = await this._enqueue(() =>
      invoke<string>('coding_agent_send', {
        req: {
          instanceId: this.instanceId,
          prompt: text,
          timeoutSecs,
        },
      })
    )

    const assistantMessage: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: responseText,
      timestamp: new Date(),
    }
    this.history.push(assistantMessage)

    if (this._conversation) {
      this._conversation.lastActivityAt = new Date()
      this._conversation.messages.push(userMessage, assistantMessage)
    }

    this.callbacks.onMessageReceived?.(assistantMessage)

    return { conversationId: this.instanceId, messages: [assistantMessage] }
  }

  async sendAction(action: AgentSuggestedAction): Promise<AgentResponse> {
    // Coding agent has no native quick-replies; treat the action value as input.
    return this.sendMessage(action.value)
  }

  async endConversation(): Promise<void> {
    if (this._sessionStarted) {
      await invoke('coding_agent_end_session', { instanceId: this.instanceId }).catch((err) => {
        log.warn('Failed to end coding agent session', undefined, err)
      })
      this._sessionStarted = false
    }
    if (this._conversation) {
      this._conversation.isActive = false
    }
    this.setConnectionState('disconnected')
    this.callbacks.onConversationEnded?.(this.instanceId)
  }

  getHistory(): AgentMessage[] {
    return [...this.history]
  }

  clearHistory(): void {
    this.history = []
  }

  async dispose(): Promise<void> {
    await this.endConversation()
    this.callbacks = {}
  }
}
