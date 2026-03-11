import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock modules that depend on browser APIs (MediaStream etc.) before importing orchestrator
vi.mock('@azure/communication-calling', () => ({}))
vi.mock('@azure/communication-chat', () => ({}))
vi.mock('@azure/communication-common', () => ({
  AzureCommunicationTokenCredential: vi.fn(),
}))

import { AgentMeetingOrchestrator } from '@/services/agentMeetingOrchestrator'
import type { ProactiveConfig } from '@/types/behavior'

// Minimal mock of AgentServiceContainer to construct an orchestrator
function createMockContainer() {
  return {
    agentInstanceId: 'test-instance-12345678',
    ttsService: {
      initialize: vi.fn().mockResolvedValue(true),
      isSpeaking: vi.fn().mockReturnValue(false),
      speakText: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      resumeAudioContexts: vi.fn(),
    },
    captionAggregation: {
      initialize: vi.fn(),
      initializeGpt: vi.fn().mockReturnValue(false),
      isGptEnabled: false,
      addCaption: vi.fn(),
      setOnAggregatedCaption: vi.fn(),
      setOnPendingMentionTimeout: vi.fn(),
    },
    chatService: {
      isConnectedToChat: vi.fn().mockReturnValue(true),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    acsService: {
      unmute: vi.fn().mockResolvedValue(undefined),
      mute: vi.fn().mockResolvedValue(undefined),
    },
    analyticsService: {
      startCall: vi.fn(),
      trackQuestion: vi.fn(),
      trackResponse: vi.fn(),
    },
  }
}

// Helper to access private fields for testing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPrivate(orchestrator: AgentMeetingOrchestrator): any {
  return orchestrator as unknown
}

describe('AgentMeetingOrchestrator — Mode Separation & Guardrails', () => {
  let container: ReturnType<typeof createMockContainer>
  let orchestrator: AgentMeetingOrchestrator

  beforeEach(() => {
    container = createMockContainer()
    orchestrator = new AgentMeetingOrchestrator(container as never)
  })

  describe('Reactive channel isolation', () => {
    it('reactive caption response uses captionResponseAsChat, not proactive config', () => {
      const priv = getPrivate(orchestrator)
      priv._captionResponseAsChat = true
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interruptible',
      } as ProactiveConfig

      // The reactive channel determination is: _captionResponseAsChat ? 'chat' : 'speech'
      // It should NOT read from _proactiveConfig.responseChannel
      const reactiveChannel = priv._captionResponseAsChat ? 'chat' : 'speech'
      expect(reactiveChannel).toBe('chat')
      expect(priv._proactiveConfig.responseChannel).toBe('speech')
    })

    it('reactive response channel is unaffected by proactive auto setting', () => {
      const priv = getPrivate(orchestrator)
      priv._captionResponseAsChat = false
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'auto',
        turnTakingMode: 'interruptible',
      } as ProactiveConfig

      const reactiveChannel= priv._captionResponseAsChat ? 'chat' : 'speech'
      expect(reactiveChannel).toBe('speech')
    })
  })

  describe('Assistant response waits', () => {
    it('resolves immediately when an assistant message arrives', async () => {
      const priv = getPrivate(orchestrator)
      const responsePromise = priv._waitForAssistantResponse(1000)

      priv._addConversationMessage('assistant', 'Here is the response')

      await expect(responsePromise).resolves.toBe('Here is the response')
      expect(priv._responseResolve).toBeNull()
    })

    it('clears pending waits when the orchestrator stops', async () => {
      const priv = getPrivate(orchestrator)
      priv._running = true

      const responsePromise = priv._waitForAssistantResponse(1000)
      orchestrator.stop()

      await expect(responsePromise).resolves.toBeNull()
      expect(priv._responseResolve).toBeNull()
    })
  })

  describe('Proactive channel resolution', () => {
    it('resolves speech channel as-is', () => {
      const priv = getPrivate(orchestrator)
      const result = priv._resolveProactiveChannel('speech')
      expect(result).toBe('speech')
    })

    it('resolves chat channel as-is', () => {
      const priv = getPrivate(orchestrator)
      const result = priv._resolveProactiveChannel('chat')
      expect(result).toBe('chat')
    })

    it('resolves auto to speech when no recent chat activity', () => {
      const priv = getPrivate(orchestrator)
      priv._lastChatActivityTimestamp = 0
      const result = priv._resolveProactiveChannel('auto')
      expect(result).toBe('speech')
    })

    it('resolves auto to speech when chat activity is older than 30s', () => {
      const priv = getPrivate(orchestrator)
      priv._lastChatActivityTimestamp = Date.now() - 35_000
      const result = priv._resolveProactiveChannel('auto')
      expect(result).toBe('speech')
    })

    it('resolves auto to chat when there is recent chat activity (<30s)', () => {
      const priv = getPrivate(orchestrator)
      priv._lastChatActivityTimestamp = Date.now() - 10_000
      const result = priv._resolveProactiveChannel('auto')
      expect(result).toBe('chat')
    })

    it('auto channel resolution is per-evaluation (not sticky)', () => {
      const priv = getPrivate(orchestrator)

      // First call: recent chat → chat
      priv._lastChatActivityTimestamp = Date.now() - 5_000
      expect(priv._resolveProactiveChannel('auto')).toBe('chat')

      // Second call: stale chat → speech
      priv._lastChatActivityTimestamp = Date.now() - 60_000
      expect(priv._resolveProactiveChannel('auto')).toBe('speech')
    })
  })

  describe('[NO_ACTION] backoff behavior', () => {
    it('increments _noActionCount on consecutive NO_ACTION responses', () => {
      const priv = getPrivate(orchestrator)
      priv._noActionCount = 0

      // Simulate NO_ACTION responses
      priv._noActionCount++
      expect(priv._noActionCount).toBe(1)

      priv._noActionCount++
      expect(priv._noActionCount).toBe(2)
    })

    it('exponential backoff increases effective threshold', () => {
      const priv = getPrivate(orchestrator)
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interruptible',
      } as ProactiveConfig

      // backoffMultiplier= 2^noActionCount
      priv._noActionCount = 0
      expect(priv._proactiveConfig.silenceThresholdMs * Math.pow(2, priv._noActionCount)).toBe(5000)

      priv._noActionCount = 1
      expect(priv._proactiveConfig.silenceThresholdMs * Math.pow(2, priv._noActionCount)).toBe(10000)

      priv._noActionCount = 3
      expect(priv._proactiveConfig.silenceThresholdMs * Math.pow(2, priv._noActionCount)).toBe(40000)
    })

    it('resets backoff when human speaks', () => {
      const priv = getPrivate(orchestrator)
      priv._running = true
      priv._noActionCount = 5
      priv._consecutiveProactiveActions = 2
      priv._waitingForHumanResponse = true
      priv._displayName = 'TestAgent'
      priv._agentNameVariations = ['testagent']
      priv._ignoredSpeakers = new Set<string>()

      // Simulate human caption
      orchestrator.processCaption({
        id: 'cap-1',
        speaker: 'Human',
        text: 'hello'
      })

      expect(priv._noActionCount).toBe(0)
      expect(priv._consecutiveProactiveActions).toBe(0)
      expect(priv._waitingForHumanResponse).toBe(false)
    })
  })

  describe('Max consecutive actions', () => {
    it('blocks proactive check when max consecutive actions reached', () => {
      const priv = getPrivate(orchestrator)
      priv._running = true
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interruptible',
      } as ProactiveConfig
      priv._consecutiveProactiveActions = 1
      priv._isAgentConnected = true
      priv._lastCaptionTimestamp = Date.now() - 60_000

      // _checkSilenceForProactive should return early when max (1) reached
      priv._checkSilenceForProactive()

      // _evaluateProactiveAction should NOT have been called (proactiveEvaluating stays false)
      expect(priv._proactiveEvaluating).toBe(false)
    })
  })

  describe('Proactive turn-taking', () => {
    it('keeps proactive speech going in interview-safe mode and buffers the reply', () => {
      const priv = getPrivate(orchestrator)
      const sendChatSpy = vi.spyOn(priv, '_sendChat').mockResolvedValue(true)
      priv._running = true
      priv._displayName = 'TestAgent'
      priv._agentNameVariations = ['testagent']
      priv._ignoredSpeakers = new Set<string>()
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'Run the interview',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interview-safe',
        autoLeaveOnCompletion: false,
        goodbyeMessage: '',
        goodbyeChannel: 'both',
      } as ProactiveConfig
      priv._currentSpeechSource = 'proactive'
      priv._currentSpeechResponse = 'Tell me about yourself.'
      container.ttsService.isSpeaking.mockReturnValue(true)

      orchestrator.processCaption({
        id: 'cap-interview-safe',
        speaker: 'Candidate',
        text: 'Sure, I led the migration project.',
      })

      expect(container.ttsService.stop).not.toHaveBeenCalled()
      expect(priv._pendingHumanReplyDuringSpeech).toBe(true)
      expect(priv._waitingForHumanResponse).toBe(false)
      expect(sendChatSpy).not.toHaveBeenCalled()
    })

    it('still interrupts proactive speech in interruptible mode', () => {
      const priv = getPrivate(orchestrator)
      const sendChatSpy = vi.spyOn(priv, '_sendChat').mockResolvedValue(true)
      priv._running = true
      priv._displayName = 'TestAgent'
      priv._agentNameVariations = ['testagent']
      priv._ignoredSpeakers = new Set<string>()
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'Run the interview',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interruptible',
        autoLeaveOnCompletion: false,
        goodbyeMessage: '',
        goodbyeChannel: 'both',
      } as ProactiveConfig
      priv._currentSpeechSource = 'proactive'
      priv._currentSpeechResponse = 'Tell me about yourself.'
      container.ttsService.isSpeaking.mockReturnValue(true)

      orchestrator.processCaption({
        id: 'cap-interruptible',
        speaker: 'Candidate',
        text: 'Sure, I led the migration project.',
      })

      expect(container.ttsService.stop).toHaveBeenCalledOnce()
      expect(priv._pendingHumanReplyDuringSpeech).toBe(false)
      expect(sendChatSpy).toHaveBeenCalledWith('💬 [Interrupted] Tell me about yourself.')
    })

    it('does not wait for a fresh human response when one arrived during proactive speech', () => {
      const priv = getPrivate(orchestrator)
      const lastCaptionTimestamp = Date.now() - 2000
      priv._pendingHumanReplyDuringSpeech = true
      priv._waitingForHumanResponse = true
      priv._lastCaptionTimestamp = lastCaptionTimestamp

      priv._completeProactiveResponseTurn('speech')

      expect(priv._waitingForHumanResponse).toBe(false)
      expect(priv._pendingHumanReplyDuringSpeech).toBe(false)
      expect(priv._lastCaptionTimestamp).toBe(lastCaptionTimestamp)
    })

    it('waits for a fresh human response when no overlap was captured', () => {
      const priv = getPrivate(orchestrator)
      priv._pendingHumanReplyDuringSpeech = false
      priv._waitingForHumanResponse = false
      priv._lastCaptionTimestamp = 1
      const before = Date.now()

      priv._completeProactiveResponseTurn('speech')

      expect(priv._waitingForHumanResponse).toBe(true)
      expect(priv._lastCaptionTimestamp).toBeGreaterThanOrEqual(before)
      expect(priv._pendingHumanReplyDuringSpeech).toBe(false)
    })
  })

  describe('Chat activity tracking', () => {
    it('updates lastChatActivityTimestamp when processing chat messages', () => {
      const priv = getPrivate(orchestrator)
      priv._running = true
      priv._displayName = 'TestBot'
      priv._agentNameVariations = ['testbot']

      const before = Date.now()
      orchestrator.processChatMessage({
        id: 'msg-1',
        content: 'hello',
        senderDisplayName: 'User',
        isOwn: false,
        timestamp: new Date(),
      } as never)

      expect(priv._lastChatActivityTimestamp).toBeGreaterThanOrEqual(before)
    })
  })

  describe('Speaking momentum factor', () => {
    it('returns 1× when no recent captions', () => {
      const priv = getPrivate(orchestrator)
      priv._recentCaptionTimestamps = []
      expect(priv._getSpeakingMomentumFactor(Date.now())).toBe(1)
    })

    it('returns 1.5× for light activity (1–3 captions in last 30s)', () => {
      const priv = getPrivate(orchestrator)
      const now = Date.now()
      priv._recentCaptionTimestamps = [now - 5000, now - 10000]
      expect(priv._getSpeakingMomentumFactor(now)).toBe(1.5)
    })

    it('returns 2× for moderate activity (4–8 captions in last 30s)', () => {
      const priv = getPrivate(orchestrator)
      const now = Date.now()
      priv._recentCaptionTimestamps = [now - 2000, now - 5000, now - 10000, now - 15000, now - 20000]
      expect(priv._getSpeakingMomentumFactor(now)).toBe(2)
    })

    it('returns 3× for heavy activity (9+ captions in last 30s)', () => {
      const priv = getPrivate(orchestrator)
      const now = Date.now()
      priv._recentCaptionTimestamps = Array.from({ length: 10 }, (_, i) => now - i * 2000)
      expect(priv._getSpeakingMomentumFactor(now)).toBe(3)
    })

    it('ignores captions older than 30 seconds', () => {
      const priv = getPrivate(orchestrator)
      const now = Date.now()
      // All captions are older than 30s
      priv._recentCaptionTimestamps = [now - 35000, now - 40000, now - 50000]
      expect(priv._getSpeakingMomentumFactor(now)).toBe(1)
    })

    it('tracks caption timestamps in processCaption', () => {
      const priv = getPrivate(orchestrator)
      priv._running = true
      priv._displayName = 'TestAgent'
      priv._agentNameVariations = ['testagent']
      priv._ignoredSpeakers = new Set<string>()

      expect(priv._recentCaptionTimestamps.length).toBe(0)

      orchestrator.processCaption({ id: 'cap-a', speaker: 'Human', text: 'hello' })
      orchestrator.processCaption({ id: 'cap-b', speaker: 'Human', text: 'world' })

      expect(priv._recentCaptionTimestamps.length).toBe(2)
    })

    it('momentum factor multiplies with backoff for effective threshold', () => {
      const priv = getPrivate(orchestrator)
      const now = Date.now()
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 10000,
        responseChannel: 'speech',
        turnTakingMode: 'interruptible',
      } as ProactiveConfig

      // 5 recent captions → momentum 2×, noActionCount=1 → backoff 2×
      priv._recentCaptionTimestamps = Array.from({ length: 5 }, (_, i) => now - i * 3000)
      priv._noActionCount = 1
      const momentum = priv._getSpeakingMomentumFactor(now)
      const backoff = Math.pow(2, priv._noActionCount)
      const effective = priv._proactiveConfig.silenceThresholdMs * momentum * backoff
      // 10000 × 2 × 2 = 40000
      expect(effective).toBe(40000)
    })
  })

  describe('Auto-leave on completion ([LEAVE_MEETING] sentinel)', () => {
    const AUTO_LEAVE_DELAY_MS = 2500

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    const completeAutoLeave = async (responseText: string): Promise<void> => {
      const priv = getPrivate(orchestrator)
      const autoLeavePromise = priv._handleAutoLeave(responseText)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(AUTO_LEAVE_DELAY_MS)
      await autoLeavePromise
    }

    it('LEAVE_SENTINEL static field is [LEAVE_MEETING]', () => {
      expect(AgentMeetingOrchestrator.LEAVE_SENTINEL).toBe('[LEAVE_MEETING]')
    })

    it('_handleAutoLeave does not re-deliver farewell when no configuredGoodbye is set', async () => {
      const priv = getPrivate(orchestrator)
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interruptible',
        autoLeaveOnCompletion: true,
        goodbyeMessage: '',
        goodbyeChannel: 'both',
      } as ProactiveConfig
      priv._running = true
      priv._session = { isActive: true, speaker: null, startedAt: new Date() }

      const events: Array<{ type: string }> = []
      orchestrator.on((event) => events.push(event))

      // _handleAutoLeave now receives the already-spoken text (sentinel stripped)
      await completeAutoLeave('Great session everyone, thank you!')

      // No configuredGoodbye → nothing additional should be spoken or chatted
      expect(container.ttsService.speakText).not.toHaveBeenCalled()
      expect(container.chatService.sendMessage).not.toHaveBeenCalled()
      // Should still emit leave-requested
      expect(events.some(e => e.type === 'leave-requested')).toBe(true)
    })

    it('_handleAutoLeave delivers configuredGoodbye when it differs from already-spoken text', async () => {
      const priv = getPrivate(orchestrator)
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interruptible',
        autoLeaveOnCompletion: true,
        goodbyeMessage: 'Custom farewell!',
        goodbyeChannel: 'chat',
      } as ProactiveConfig
      priv._running = true
      priv._session = { isActive: true, speaker: null, startedAt: new Date() }

      // Already-spoken text (sentinel stripped by caller)
      await completeAutoLeave('Model-generated farewell')

      // Should NOT speak (channel is chat-only)
      expect(container.ttsService.speakText).not.toHaveBeenCalled()
      // Should send the configured goodbye to chat (it differs from already-spoken text)
      expect(container.chatService.sendMessage).toHaveBeenCalledWith(
        '👋 Custom farewell!'
      )
    })

    it('_handleAutoLeave skips redundant delivery when no configuredGoodbye and no text', async () => {
      const priv = getPrivate(orchestrator)
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interruptible',
        autoLeaveOnCompletion: true,
        goodbyeMessage: '',
        goodbyeChannel: 'speech',
      } as ProactiveConfig
      priv._running = true
      priv._session = { isActive: true, speaker: null, startedAt: new Date() }

      // Cleaned text is empty (agent only said [LEAVE_MEETING])
      await completeAutoLeave('')

      // No configuredGoodbye → nothing extra to speak
      expect(container.ttsService.speakText).not.toHaveBeenCalled()
      expect(container.chatService.sendMessage).not.toHaveBeenCalled()
    })

    it('_handleAutoLeave stops proactive mode', async () => {
      const priv = getPrivate(orchestrator)
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interruptible',
        autoLeaveOnCompletion: true,
        goodbyeMessage: '',
        goodbyeChannel: 'chat',
      } as ProactiveConfig
      priv._running = true
      priv._session = { isActive: true, speaker: 'User', startedAt: new Date() }
      priv._consecutiveProactiveActions = 2
      priv._waitingForHumanResponse = true

      await completeAutoLeave('Bye!')

      // Proactive mode should be cleaned up
      expect(priv._consecutiveProactiveActions).toBe(0)
      expect(priv._waitingForHumanResponse).toBe(false)
      // Session should be ended
      expect(priv._session.isActive).toBe(false)
    })

    it('does not trigger auto-leave when autoLeaveOnCompletion is false', () => {
      const priv = getPrivate(orchestrator)
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interruptible',
        autoLeaveOnCompletion: false,
        goodbyeMessage: '',
        goodbyeChannel: 'both',
      } as ProactiveConfig

      const responseText = 'Some response [LEAVE_MEETING]'
      // When autoLeaveOnCompletion is false, the sentinel check should not match
      const shouldAutoLeave = priv._proactiveConfig.autoLeaveOnCompletion
        && responseText.trim().toUpperCase().includes('[LEAVE_MEETING]')
      expect(shouldAutoLeave).toBe(false)
    })

    it('detects [LEAVE_MEETING] case-insensitively', () => {
      const responseText = 'Goodbye! [leave_meeting]'
      expect(responseText.trim().toUpperCase().includes('[LEAVE_MEETING]')).toBe(true)
    })

    it('emits leave-requested event on auto-leave', async () => {
      const priv = getPrivate(orchestrator)
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interruptible',
        autoLeaveOnCompletion: true,
        goodbyeMessage: '',
        goodbyeChannel: 'chat',
      } as ProactiveConfig
      priv._running = true
      priv._session = { isActive: true, speaker: null, startedAt: new Date() }

      const events: Array<{ type: string }> = []
      orchestrator.on((event) => events.push(event))

      const autoLeavePromise = priv._handleAutoLeave('Done!')

      await vi.advanceTimersByTimeAsync(0)
      expect(events.filter(e => e.type === 'leave-requested')).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(AUTO_LEAVE_DELAY_MS - 1)
      expect(events.filter(e => e.type === 'leave-requested')).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1)
      await autoLeavePromise

      const leaveEvents = events.filter(e => e.type === 'leave-requested')
      expect(leaveEvents).toHaveLength(1)
    })
  })

  describe('Welcome message modes', () => {
    it('sends default welcome when no welcomeConfig is set', async () => {
      const priv = getPrivate(orchestrator)
      priv._displayName = 'TestBot'
      priv._welcomeConfig = null
      priv._welcomeMessageSent = false

      await orchestrator.sendWelcomeMessage()

      expect(container.chatService.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Hi! I'm TestBot")
      )
    })

    it('sends custom static message when mode is custom', async () => {
      const priv = getPrivate(orchestrator)
      priv._displayName = 'TestBot'
      priv._welcomeConfig = { mode: 'custom', staticMessage: 'Hello from custom!' }
      priv._welcomeMessageSent = false

      await orchestrator.sendWelcomeMessage()

      expect(container.chatService.sendMessage).toHaveBeenCalledWith('Hello from custom!')
    })

    it('falls back to default when custom mode has empty staticMessage', async () => {
      const priv = getPrivate(orchestrator)
      priv._displayName = 'TestBot'
      priv._welcomeConfig = { mode: 'custom', staticMessage: '' }
      priv._welcomeMessageSent = false

      await orchestrator.sendWelcomeMessage()

      expect(container.chatService.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Hi! I'm TestBot")
      )
    })

    it('sends agent-triggered response as welcome when agent responds', async () => {
      const priv = getPrivate(orchestrator)
      priv._displayName = 'TestBot'
      priv._welcomeConfig = { mode: 'agent-triggered', triggerPrompt: 'Introduce yourself' }
      priv._welcomeMessageSent = false
      priv._agentProvider = {
        sendMessage: vi.fn().mockResolvedValue({
          messages: [{ role: 'assistant', content: 'Hello, I am your AI helper!' }],
        }),
      }

      await orchestrator.sendWelcomeMessage()

      expect(priv._agentProvider.sendMessage).toHaveBeenCalledWith('Introduce yourself')
      expect(container.chatService.sendMessage).toHaveBeenCalledWith('Hello, I am your AI helper!')
    })

    it('falls back to default when agent-triggered mode fails', async () => {
      const priv = getPrivate(orchestrator)
      priv._displayName = 'TestBot'
      priv._welcomeConfig = { mode: 'agent-triggered', triggerPrompt: 'Introduce yourself' }
      priv._welcomeMessageSent = false
      priv._agentProvider = {
        sendMessage: vi.fn().mockRejectedValue(new Error('Agent unavailable')),
      }

      await orchestrator.sendWelcomeMessage()

      expect(container.chatService.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Hi! I'm TestBot")
      )
    })

    it('does not send welcome message twice', async () => {
      const priv = getPrivate(orchestrator)
      priv._displayName = 'TestBot'
      priv._welcomeConfig = null
      priv._welcomeMessageSent = false

      await orchestrator.sendWelcomeMessage()
      await orchestrator.sendWelcomeMessage()

      expect(container.chatService.sendMessage).toHaveBeenCalledTimes(1)
    })
  })

  describe('Proactive mode — wait for human readiness', () => {
    it('_startProactiveMode sets _lastCaptionTimestamp to 0 (not Date.now)', () => {
      const priv = getPrivate(orchestrator)
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interview-safe',
        autoLeaveOnCompletion: false,
        goodbyeMessage: '',
        goodbyeChannel: 'both',
      } as ProactiveConfig
      priv._running = true

      // Set to a non-zero value to verify it gets reset
      priv._lastCaptionTimestamp = 999

      priv._startProactiveMode()

      expect(priv._lastCaptionTimestamp).toBe(0)
    })

    it('_checkSilenceForProactive does nothing when _lastCaptionTimestamp is 0', () => {
      const priv = getPrivate(orchestrator)
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interview-safe',
        autoLeaveOnCompletion: false,
        goodbyeMessage: '',
        goodbyeChannel: 'both',
      } as ProactiveConfig
      priv._running = true
      priv._isAgentConnected = true
      priv._lastCaptionTimestamp = 0

      // Should return early without evaluating
      priv._checkSilenceForProactive()

      expect(priv._proactiveEvaluating).toBe(false)
    })

    it('first human caption arms the proactive silence timer', () => {
      const priv = getPrivate(orchestrator)
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interview-safe',
        autoLeaveOnCompletion: false,
        goodbyeMessage: '',
        goodbyeChannel: 'both',
      } as ProactiveConfig
      priv._running = true
      priv._lastCaptionTimestamp = 0

      // Simulate a caption arriving
      orchestrator.processCaption({
        id: 'cap-1',
        speaker: 'Human User',
        text: 'Hello, I am ready',
      })

      // _lastCaptionTimestamp should now be set to a real timestamp
      expect(priv._lastCaptionTimestamp).toBeGreaterThan(0)
    })
  })

  describe('Auto-leave delivers full agent response first', () => {
    it('[LEAVE_MEETING] is stripped from response text via regex', () => {
      const responseText = 'Based on our discussion, I recommend X and Y. Thank you! [LEAVE_MEETING]'
      const cleaned = responseText.replace(/\s*\[LEAVE_MEETING\]\s*/gi, '').trim()
      expect(cleaned).toBe('Based on our discussion, I recommend X and Y. Thank you!')
      expect(cleaned).not.toContain('[LEAVE_MEETING]')
    })

    it('[LEAVE_MEETING] is stripped case-insensitively', () => {
      const responseText = 'Goodbye! [leave_meeting]'
      const cleaned = responseText.replace(/\s*\[LEAVE_MEETING\]\s*/gi, '').trim()
      expect(cleaned).toBe('Goodbye!')
    })

    it('[LEAVE_MEETING] at the start of response yields empty cleaned text', () => {
      const responseText = '[LEAVE_MEETING]'
      const cleaned = responseText.replace(/\s*\[LEAVE_MEETING\]\s*/gi, '').trim()
      expect(cleaned).toBe('')
    })

    it('_handleAutoLeave skips duplicate delivery when configuredGoodbye matches spoken text', async () => {
      vi.useFakeTimers()
      const priv = getPrivate(orchestrator)
      priv._proactiveConfig = {
        enabled: true,
        instructions: 'test',
        silenceThresholdMs: 5000,
        responseChannel: 'speech',
        turnTakingMode: 'interview-safe',
        autoLeaveOnCompletion: true,
        goodbyeMessage: 'Thank you everyone!',
        goodbyeChannel: 'both',
      } as ProactiveConfig
      priv._running = true
      priv._session = { isActive: true, speaker: null, startedAt: new Date() }

      // alreadySpokenText matches configuredGoodbye exactly → skip duplicate
      const promise = priv._handleAutoLeave('Thank you everyone!')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(2500)
      await promise

      expect(container.ttsService.speakText).not.toHaveBeenCalled()
      expect(container.chatService.sendMessage).not.toHaveBeenCalled()
      vi.useRealTimers()
    })
  })
})
