// Intent Detection Service
// Uses Azure OpenAI to intelligently detect if a message needs a response

import type OpenAI from 'openai'
import {
  createAzureOpenAIClient,
  isDesktopRuntimeAvailable,
  type AzureOpenAIClientConfig,
} from '@/services/validationService'

interface IntentConfig {
  openaiEndpoint: string
  openaiApiKey: string
  openaiDeployment: string
}

interface ConversationContext {
  agentName: string
  sessionActive: boolean
  sessionSpeaker: string | null
  recentCaptions: Array<{ speaker: string; text: string }>
}

interface IntentResult {
  shouldRespond: boolean
  isEndOfConversation: boolean
  reason: string
  confidence: number
}

export interface ChatOverrideResult {
  isOverride: boolean
  type: 'resend' | 'force-next' | null
  reason: string
  confidence: number
}

// Hardcoded fallback phrases for end-of-conversation detection
// NOTE: Keep this list strict - only explicit farewell phrases
// Short acknowledgments like "ok", "that's ok", "got it" should NOT end the conversation
const END_OF_CONVERSATION_PHRASES = [
  'thank you, bye',
  'thanks, bye',
  'thank you, goodbye',
  'thanks, goodbye',
  "that's all i need",
  "that's all i needed",
  'thats all i need',
  'thats all i needed',
  'bye',
  'goodbye',
  'good bye',
  'see you',
  'see you later',
  'talk later',
  'talk to you later',
  'nothing else',
  'no more questions',
  "i'm done",
  'im done',
  'take care',
  "that's all for now",
  'thats all for now'
]

/**
 * Intent Detection Service - Uses GPT to determine if agent should respond
 */
class IntentDetectionService {
  private openai: OpenAI | null = null
  private openaiConfig: AzureOpenAIClientConfig | null = null
  private openaiClientPromise: Promise<OpenAI> | null = null
  private deploymentName: string = ''
  private isEnabled: boolean = false

  private async getOpenAIClient(): Promise<OpenAI | null> {
    if (!this.isEnabled || !this.openaiConfig) {
      return null
    }

    if (this.openai) {
      return this.openai
    }

    this.openaiClientPromise ??= createAzureOpenAIClient(this.openaiConfig)
      .then((client) => {
        this.openai = client
        return client
      })
      .catch((error) => {
        this.openaiClientPromise = null
        throw error
      })

    return this.openaiClientPromise
  }

  /**
   * Initialize the service with OpenAI config
   */
  initialize(config: IntentConfig): boolean {
    if (!config.openaiApiKey || !config.openaiEndpoint) {
      console.warn('OpenAI not configured for intent detection')
      this.isEnabled = false
      this.openaiConfig = null
      this.openai = null
      this.openaiClientPromise = null
      return false
    }

    if (!isDesktopRuntimeAvailable()) {
      console.warn('Intent detection requires the Tauri desktop runtime.')
      this.isEnabled = false
      this.openaiConfig = null
      this.openai = null
      this.openaiClientPromise = null
      return false
    }

    this.openaiConfig = {
      endpoint: config.openaiEndpoint,
      apiKey: config.openaiApiKey,
      deployment: config.openaiDeployment || '',
    }
    this.openai = null
    this.openaiClientPromise = null
    this.deploymentName = config.openaiDeployment || ''
    this.isEnabled = true
    console.log('Intent Detection Service initialized')
    return true
  }

  /**
   * Check if the agent should respond to a message
   */
  async shouldRespondTo(
    text: string,
    speaker: string,
    context: ConversationContext
  ): Promise<IntentResult> {
    // If OpenAI not configured, fall back to basic detection
    if (!this.isEnabled) {
      return this.fallbackDetection(text, speaker, context)
    }

    try {
      const openai = await this.getOpenAIClient()
      if (!openai) {
        return this.fallbackDetection(text, speaker, context)
      }

      const recentContext = context.recentCaptions
        .slice(-5)
        .map(c => `${c.speaker}: ${c.text}`)
        .join('\n')

      const systemPrompt = `You are an intent detection system for a voice AI agent named "${context.agentName}".

Your task: Analyze the latest message and determine TWO things:
1. Should the agent respond to this message?
2. Is this an end-of-conversation message (user saying goodbye, thank you, or indicating they're done)?

RESPOND = YES when:
- The agent's name is mentioned (${context.agentName}, or first name variations)
- It's a question (direct or indirect, even without question mark)
- It's a request for information, help, or action (e.g., "tell me", "explain", "summarize", "show me")
- It's a command or instruction (e.g., "summarize the project", "list the items")
- It's a follow-up to an ongoing conversation with the agent
- Someone asks for clarification or more details
- It's addressed to the agent even without explicit name mention (during active session)
- The session is active and the message contains ANY substantive content that could warrant a response

RESPOND = NO when:
- It's casual conversation between other participants not involving the agent
- It's clearly directed at someone else
- It's just background chatter or off-topic discussion
- It's ONLY a thank you/goodbye without any new question (set isEndOfConversation=true instead)

END OF CONVERSATION = YES when (ONLY from the session speaker during an active session):
- User explicitly says goodbye: "bye", "goodbye", "see you later", "talk later", "take care"
- User says thank you as a closing statement: "thank you, that's all", "thanks, I'm done"
- User clearly indicates they're finished: "that's all I needed", "nothing else", "no more questions"

END OF CONVERSATION = NO when:
- Session is not active
- Speaker is not the session speaker
- User says thanks but then asks another question ("thanks, but can you also...")
- User gives a brief acknowledgment: "ok", "okay", "that's ok", "alright", "got it", "interesting", "I see"
- User acknowledges but continues the conversation
- It's a mid-conversation acknowledgment that doesn't explicitly end the interaction
- The message is just a short acknowledgment without explicit farewell words

CRITICAL: Short acknowledgments like "OK", "That's OK", "Got it", "Interesting", "I see", "Alright" are NOT end-of-conversation signals. They are mid-conversation responses. Only explicit farewells or "I'm done" statements should end the conversation.

Current session state:
- Session active: ${context.sessionActive}
- Session speaker: ${context.sessionSpeaker || 'none'}
- Current message speaker: ${speaker}

IMPORTANT: isEndOfConversation should ONLY be true if session is active AND speaker matches session speaker AND message contains explicit farewell/completion language.

Output ONLY valid JSON: {"shouldRespond": true/false, "isEndOfConversation": true/false, "reason": "brief explanation", "confidence": 0.0-1.0}`

      const userPrompt = `Recent conversation:
${recentContext || '(no recent context)'}

Latest message from ${speaker}:
"${text}"

Analyze this message.`

      let completion
      const baseRequest = {
        messages: [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: userPrompt }
        ],
        model: this.deploymentName
      }

      try {
        completion = await openai.chat.completions.create({
          ...baseRequest,
          max_completion_tokens: 150
        })
      } catch (firstError) {
        const firstMessage = firstError instanceof Error ? firstError.message.toLowerCase() : String(firstError).toLowerCase()
        const unsupportedMaxCompletionTokens = firstMessage.includes('max_completion_tokens') && firstMessage.includes('unsupported')

        if (!unsupportedMaxCompletionTokens) {
          throw firstError
        }

        completion = await openai.chat.completions.create({
          ...baseRequest,
          max_tokens: 150
        })
      }

      const responseText = completion.choices[0]?.message?.content?.trim() || ''

      try {
        const result = JSON.parse(responseText) as IntentResult
        // Ensure isEndOfConversation defaults to false if not present
        result.isEndOfConversation = result.isEndOfConversation ?? false
        console.log('🧠 Intent detection:', result)
        return result
      } catch {
        // If JSON parsing fails, try to extract the decisions
        const shouldRespond = responseText.toLowerCase().includes('"shouldrespond": true') ||
                             responseText.toLowerCase().includes('"shouldrespond":true')
        const isEndOfConversation = responseText.toLowerCase().includes('"isendofconversation": true') ||
                                    responseText.toLowerCase().includes('"isendofconversation":true')
        return {
          shouldRespond,
          isEndOfConversation,
          reason: 'Parsed from non-JSON response',
          confidence: 0.5
        }
      }
    } catch (error) {
      console.error('Intent detection error:', error)
      // Fall back to basic detection on error
      return this.fallbackDetection(text, speaker, context)
    }
  }

  /**
   * Fallback detection when OpenAI is not available
   */
  private fallbackDetection(
    text: string,
    speaker: string,
    context: ConversationContext
  ): IntentResult {
    const lowerText = text.toLowerCase().trim()
    const agentNameLower = context.agentName.toLowerCase()
    const firstName = agentNameLower.split(' ')[0]

    // Check for agent name mention
    const nameMentioned = lowerText.includes(agentNameLower) || 
                          lowerText.includes(firstName)

    // Check for question patterns
    const hasQuestionMark = text.includes('?')
    const questionWords = ['what', 'who', 'where', 'when', 'why', 'how', 'which', 'can', 'could', 'would', 'should', 'is', 'are', 'do', 'does']
    const startsWithQuestion = questionWords.some(w => lowerText.startsWith(w + ' '))
    
    // Check for request/command patterns (imperative sentences)
    const requestPhrases = [
      'tell me', 'tell us', 'explain', 'describe', 'show me', 'show us',
      'help me', 'help us', 'find', 'search', 'give me', 'give us',
      'i want', 'i need', 'i would like', "i'd like",
      'let me know', 'get me', 'provide', 'share',
      'look up', 'check', 'verify', 'confirm',
      'summarize', 'please summarize', 'now summarize',
      'please tell', 'please show', 'please explain', 'please help',
      'now tell', 'now show', 'now explain', 'now please'
    ]
    const isRequest = requestPhrases.some(phrase => lowerText.includes(phrase))
    
    // Check for imperative verbs at the start (commands)
    const imperativeVerbs = [
      'tell', 'show', 'explain', 'describe', 'find', 'get', 'give', 'help',
      'list', 'provide', 'share', 'check', 'look', 'search', 'summarize',
      'create', 'write', 'generate', 'calculate', 'compare', 'analyze'
    ]
    
    // Strip common prefixes and acknowledgments before checking for imperative verbs
    // Handles: "Now please summarize...", "Ok tell me...", "Please explain..."
    // Also handles: "Interesting. Now please summarize...", "Got it, now tell me..."
    const prefixes = ['now ', 'now, ', 'ok ', 'ok, ', 'okay ', 'okay, ', 'please ', 'alright ', 'alright, ', 'so ', 'so, ', 'well ', 'well, ']
    
    // First, try to find imperative after common sentence starters/acknowledgments
    // Split on sentence boundaries and check each part
    const sentences = lowerText.split(/[.!]\s*/).filter(s => s.trim().length > 0)
    let textForImperativeCheck = lowerText
    
    // Check if any sentence (especially later ones) starts with a command
    for (const sentence of sentences) {
      let trimmed = sentence.trim()
      // Strip prefixes from each sentence
      for (const prefix of prefixes) {
        if (trimmed.startsWith(prefix)) {
          trimmed = trimmed.slice(prefix.length)
          // Allow chained prefixes like "now please"
          for (const prefix2 of prefixes) {
            if (trimmed.startsWith(prefix2)) {
              trimmed = trimmed.slice(prefix2.length)
              break
            }
          }
          break
        }
      }
      // If this sentence starts with an imperative, use it
      if (imperativeVerbs.some(v => trimmed.startsWith(v + ' '))) {
        textForImperativeCheck = trimmed
        break
      }
    }
    
    const startsWithImperative = imperativeVerbs.some(v => textForImperativeCheck.startsWith(v + ' '))

    // Session-based response (same speaker in active session)
    const isSessionSpeaker = context.sessionActive && speaker === context.sessionSpeaker
    
    // Combined request detection (phrases or imperative verbs)
    const isRequestOrCommand = isRequest || startsWithImperative

    // Check for end-of-conversation (only valid if session speaker)
    let isEndOfConversation = false
    if (isSessionSpeaker) {
      // Check if it's a goodbye phrase WITHOUT a follow-up question
      const hasGoodbyePhrase = END_OF_CONVERSATION_PHRASES.some(phrase => lowerText.includes(phrase))
      // If they say thanks but also ask something, it's not end of conversation
      const hasFollowUp = hasQuestionMark || startsWithQuestion || isRequestOrCommand
      isEndOfConversation = hasGoodbyePhrase && !hasFollowUp
    }

    // If it's end of conversation, don't respond (the caller will handle the goodbye)
    const shouldRespond = !isEndOfConversation && (
      nameMentioned || 
      ((hasQuestionMark || startsWithQuestion || isRequestOrCommand) && 
       (nameMentioned || isSessionSpeaker))
    )

    return {
      shouldRespond,
      isEndOfConversation,
      reason: isEndOfConversation ? 'End of conversation detected' :
              nameMentioned ? 'Name mentioned' : 
              isSessionSpeaker ? 'Active session speaker' :
              hasQuestionMark ? 'Question detected' :
              startsWithQuestion ? 'Question word detected' :
              startsWithImperative ? 'Command detected' :
              isRequest ? 'Request detected' : 'No trigger detected',
      confidence: nameMentioned ? 0.9 : isSessionSpeaker ? 0.8 : 0.6
    }
  }

  // ── Chat override detection ──

  /**
   * Detect if the user is requesting a one-off response channel override to chat.
   * Two types: "resend" (re-send last response via chat) or "force-next" (route next response to chat).
   */
  async detectChatOverride(
    text: string,
    context: ConversationContext
  ): Promise<ChatOverrideResult> {
    const noOverride: ChatOverrideResult = { isOverride: false, type: null, reason: 'No override detected', confidence: 0 }

    if (!this.isEnabled) {
      return this.fallbackChatOverrideDetection(text)
    }

    try {
      const openai = await this.getOpenAIClient()
      if (!openai) {
        return this.fallbackChatOverrideDetection(text)
      }

      const recentContext = context.recentCaptions
        .slice(-5)
        .map(c => `${c.speaker}: ${c.text}`)
        .join('\n')

      const systemPrompt = `You are a command detection system for a voice AI agent named "${context.agentName}".
Analyze the user's message and determine if they are requesting a one-off response channel override to send a response via chat instead of speech.

Two types of override:
1. RESEND: The user wants the LAST response re-sent via chat. They are NOT asking a new question — they want the previous answer delivered to the chat.
   Examples: "send that to the chat", "type that out", "put that in writing", "can you resend that in the chat", "send it again over chat", "repeat that in chat", "write that down in chat"

2. FORCE_NEXT: The user is asking a NEW question AND wants the answer sent via chat instead of speech. The message contains both a question/request AND a chat delivery instruction.
   Examples: "what's the status? put it in the chat", "answer this one in the chat: what are the action items?", "tell me the summary and send it over chat", "reply over chat, what were the decisions?"

NOT an override:
- Normal questions without chat delivery instructions
- Requests about chat functionality unrelated to response delivery
- General conversation

Output ONLY valid JSON: {"isOverride": true/false, "type": "resend"|"force-next"|null, "reason": "brief explanation", "confidence": 0.0-1.0}`

      const userPrompt = `Recent conversation:
${recentContext || '(no recent context)'}

Latest message:
"${text}"

Is this a chat override command?`

      const baseRequest = {
        messages: [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: userPrompt }
        ],
        model: this.deploymentName
      }

      let completion
      try {
        completion = await openai.chat.completions.create({
          ...baseRequest,
          max_completion_tokens: 100
        })
      } catch (firstError) {
        const firstMessage = firstError instanceof Error ? firstError.message.toLowerCase() : String(firstError).toLowerCase()
        if (firstMessage.includes('max_completion_tokens') && firstMessage.includes('unsupported')) {
          completion = await openai.chat.completions.create({
            ...baseRequest,
            max_tokens: 100
          })
        } else {
          throw firstError
        }
      }

      const responseText = completion.choices[0]?.message?.content?.trim() || ''

      try {
        const result = JSON.parse(responseText) as ChatOverrideResult
        console.log('📋 Chat override detection:', result)
        return result
      } catch {
        // Try to extract from non-JSON response
        const isOverride = responseText.toLowerCase().includes('"isoverride": true') ||
                           responseText.toLowerCase().includes('"isoverride":true')
        if (!isOverride) return noOverride

        const isResend = responseText.toLowerCase().includes('"resend"')
        return {
          isOverride: true,
          type: isResend ? 'resend' : 'force-next',
          reason: 'Parsed from non-JSON response',
          confidence: 0.5
        }
      }
    } catch (error) {
      console.error('Chat override detection error:', error)
      return this.fallbackChatOverrideDetection(text)
    }
  }

  /**
   * Keyword-based fallback for chat override detection when GPT is unavailable.
   */
  private fallbackChatOverrideDetection(text: string): ChatOverrideResult {
    const lower = text.toLowerCase().trim()
    const noOverride: ChatOverrideResult = { isOverride: false, type: null, reason: 'No override detected', confidence: 0 }

    // Chat delivery indicators
    const chatDeliveryPhrases = [
      'in the chat', 'in chat', 'over chat', 'via chat', 'to the chat',
      'to chat', 'on chat', 'through chat', 'into the chat', 'into chat',
      'in writing', 'in text'
    ]
    const hasChatInstruction = chatDeliveryPhrases.some(p => lower.includes(p))
    if (!hasChatInstruction) return noOverride

    // Resend indicators — user wants the LAST response re-sent
    const resendPhrases = [
      'resend', 'send again', 'send it again', 'repeat', 'type that',
      'put that', 'send that', 'write that', 'post that',
      'send the last', 'resend the last', 'repeat the last',
      'send your last', 'send your answer', 'send your response',
      'last answer', 'last response', 'previous answer', 'previous response',
      'what you said', 'what you just said'
    ]
    const isResend = resendPhrases.some(p => lower.includes(p))

    if (isResend) {
      return { isOverride: true, type: 'resend', reason: 'Resend phrase + chat delivery detected', confidence: 0.85 }
    }

    // Force-next: has a chat instruction + looks like a question or command
    const questionWords = ['what', 'who', 'where', 'when', 'why', 'how', 'which', 'can', 'could', 'would', 'should']
    const hasQuestion = text.includes('?') || questionWords.some(w => lower.startsWith(w + ' '))
    const commandPhrases = ['tell me', 'explain', 'describe', 'summarize', 'list', 'show me', 'give me']
    const hasCommand = commandPhrases.some(p => lower.includes(p))
    const answerPhrases = ['answer', 'reply', 'respond']
    const hasAnswerInstruction = answerPhrases.some(p => lower.includes(p))

    if (hasQuestion || hasCommand || hasAnswerInstruction) {
      return { isOverride: true, type: 'force-next', reason: 'Question/command + chat delivery detected', confidence: 0.8 }
    }

    return noOverride
  }

  /**
   * Check if service is enabled
   */
  get enabled(): boolean {
    return this.isEnabled
  }
}

// Singleton instance
let instance: IntentDetectionService | null = null

export function getIntentDetectionService(): IntentDetectionService {
  if (!instance) {
    instance = new IntentDetectionService()
  }
  return instance
}

export type { IntentConfig, ConversationContext, IntentResult }
