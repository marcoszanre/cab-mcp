// Caption Aggregation Service
// Handles buffering, aggregation, fuzzy name matching, and GPT-powered detection for improved agent detection

import type OpenAI from 'openai'
import {
  createAzureOpenAIClient,
  isDesktopRuntimeAvailable,
  type AzureOpenAIClientConfig,
} from '@/services/validationService'

interface CaptionEntry {
  id: string
  speaker: string
  text: string
  timestamp: number
  isFinal: boolean
  spokenLanguage?: string
}

interface AggregatedCaption {
  speaker: string
  text: string
  captionIds: string[]
  startTime: number
  endTime: number
  correctedText?: string // GPT-corrected version of the text
  spokenLanguage?: string
}

interface MentionResult {
  isMentioned: boolean
  matchedVariation: string | null
  confidence: number
  fuzzyMatch: boolean
  gptEnhanced?: boolean // Whether GPT was used to enhance detection
  indirectReference?: boolean // Whether it was an indirect reference like "the AI"
}

interface PendingMention {
  speaker: string
  captionText: string
  timestamp: number
  matchedVariation: string
}

interface GptConfig {
  openaiEndpoint: string
  openaiApiKey: string
  openaiDeployment: string
}

interface GptCorrectionResult {
  correctedText: string
  nameDetected: boolean
  detectedAs: string | null
  isIndirectReference: boolean
  confidence: number
  reasoning: string
}

/**
 * Caption Aggregation Service
 * Combines consecutive captions from the same speaker and handles fuzzy name matching
 * Now with GPT-powered enhancement for ambiguous cases
 */
export class CaptionAggregationService {
  // Configuration
  private aggregationWindowMs: number = 1500 // 1.5s to aggregate captions (lower = faster response)
  private pendingMentionTimeoutMs: number = 2000 // 2s to wait for follow-up after name-only mention
  private fuzzyMatchThreshold: number = 0.75 // Minimum similarity for fuzzy match
  private gptAmbiguousThreshold: number = 0.85 // Below this, use GPT for validation
  private gptMinConfidenceThreshold: number = 0.50 // Below this, don't even try GPT
  
  // State
  private captionBuffer: CaptionEntry[] = []
  private pendingMention: PendingMention | null = null
  private pendingMentionTimer: NodeJS.Timeout | null = null
  private agentNameVariations: string[] = []
  private phoneticVariations: Map<string, string[]> = new Map()
  private agentName: string = ''
  
  // GPT integration
  private openai: OpenAI | null = null
  private openaiConfig: AzureOpenAIClientConfig | null = null
  private openaiClientPromise: Promise<OpenAI> | null = null
  private deploymentName: string = ''
  private gptEnabled: boolean = false
  
  // Callbacks
  private onAggregatedCaption: ((caption: AggregatedCaption, mention: MentionResult) => void) | null = null
  private onPendingMentionTimeout: ((pending: PendingMention) => void) | null = null

  private async getOpenAIClient(): Promise<OpenAI | null> {
    if (!this.gptEnabled || !this.openaiConfig) {
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
   * Initialize the service with agent name
   */
  initialize(agentName: string, variations?: string[]): void {
    this.agentName = agentName
    this.agentNameVariations = variations || this.generateNameVariations(agentName)
    this.generatePhoneticVariations()
    
    console.log('📝 Caption Aggregation Service initialized')
    console.log('   Agent name:', this.agentName)
    console.log('   Agent variations:', this.agentNameVariations)
    console.log('   Aggregation window:', this.aggregationWindowMs, 'ms')
    console.log('   Pending mention timeout:', this.pendingMentionTimeoutMs, 'ms')
    console.log('   GPT enabled:', this.gptEnabled)
  }

  /**
   * Initialize GPT integration for enhanced detection
   */
  initializeGpt(config: GptConfig): boolean {
    if (!config.openaiApiKey || !config.openaiEndpoint) {
      console.warn('OpenAI not configured for caption enhancement')
      this.gptEnabled = false
      this.openaiConfig = null
      this.openai = null
      this.openaiClientPromise = null
      return false
    }

    if (!isDesktopRuntimeAvailable()) {
      console.warn('OpenAI caption enhancement requires the Tauri desktop runtime.')
      this.gptEnabled = false
      this.openaiConfig = null
      this.openai = null
      this.openaiClientPromise = null
      return false
    }

    this.openaiConfig = {
      endpoint: config.openaiEndpoint,
      apiKey: config.openaiApiKey,
      deployment: config.openaiDeployment,
    }
    this.openai = null
    this.openaiClientPromise = null
    this.deploymentName = config.openaiDeployment || ''
    this.gptEnabled = true
    console.log('🤖 GPT Caption Enhancement initialized')
    console.log('   Deployment:', this.deploymentName)
    console.log('   Ambiguous threshold:', this.gptAmbiguousThreshold)
    return true
  }

  /**
   * Check if GPT enhancement is enabled
   */
  get isGptEnabled(): boolean {
    return this.gptEnabled
  }

  /**
   * Set callback for when aggregated caption is ready
   */
  setOnAggregatedCaption(callback: (caption: AggregatedCaption, mention: MentionResult) => void): void {
    this.onAggregatedCaption = callback
  }

  /**
   * Set callback for when pending mention times out (name mentioned, waiting for question)
   */
  setOnPendingMentionTimeout(callback: (pending: PendingMention) => void): void {
    this.onPendingMentionTimeout = callback
  }

  /**
   * Generate name variations from full name
   */
  private generateNameVariations(fullName: string): string[] {
    const variations: string[] = []
    const name = fullName.toLowerCase().trim()
    
    if (!name) return variations
    
    // Full name
    variations.push(name)
    
    // Individual parts
    const parts = name.split(' ').filter(p => p.length > 2)
    parts.forEach(part => {
      if (!variations.includes(part)) {
        variations.push(part)
      }
    })
    
    // First name + last initial
    if (parts.length >= 2) {
      const combo = `${parts[0]} ${parts[parts.length - 1][0]}`
      if (!variations.includes(combo)) {
        variations.push(combo)
      }
    }
    
    return variations
  }

  /**
   * Generate phonetic variations for common speech-to-text errors
   */
  private generatePhoneticVariations(): void {
    this.phoneticVariations.clear()
    
    // Common phonetic substitutions
    const phoneticRules: Array<[RegExp, string]> = [
      [/ph/g, 'f'],
      [/ck/g, 'k'],
      [/ee/g, 'i'],
      [/ea/g, 'e'],
      [/oo/g, 'u'],
      [/ou/g, 'ow'],
      [/ie/g, 'y'],
      [/ey/g, 'ee'],
      [/y$/g, 'ie'],
      [/v/g, 'b'],
      [/th/g, 'd'],
      [/s$/g, 'z'],
    ]
    
    for (const variation of this.agentNameVariations) {
      const phoneticVersions: string[] = [variation]
      
      // Generate phonetic alternatives
      for (const [pattern, replacement] of phoneticRules) {
        const phonetic = variation.replace(pattern, replacement)
        if (phonetic !== variation && !phoneticVersions.includes(phonetic)) {
          phoneticVersions.push(phonetic)
        }
      }
      
      // Common name mishearings (add specific ones for common names)
      const commonMishearings = this.getCommonMishearings(variation)
      commonMishearings.forEach(m => {
        if (!phoneticVersions.includes(m)) {
          phoneticVersions.push(m)
        }
      })
      
      this.phoneticVariations.set(variation, phoneticVersions)
    }
    
    console.log('   Phonetic variations generated:', Object.fromEntries(this.phoneticVariations))
  }

  /**
   * Get common mishearings for specific names
   */
  private getCommonMishearings(name: string): string[] {
    const mishearings: Record<string, string[]> = {
      'steve': ['steev', 'steven', 'steph', 'step', 'sleeve', 'steep'],
      'john': ['jon', 'joan', 'jean', 'jan'],
      'mike': ['mic', 'mick', 'myke', 'bike'],
      'alex': ['alec', 'alexis', 'elec'],
      'sam': ['san', 'psalm', 'sham'],
      'max': ['macs', 'macs', 'match'],
      'dan': ['den', 'then', 'tan'],
      'tom': ['thom', 'tim', 'tum'],
      'bob': ['bop', 'pop', 'rob'],
      'jim': ['gym', 'gem', 'tim'],
      'joe': ['jo', 'joey', 'show'],
      'ben': ['been', 'bin', 'pen'],
      'ray': ['rey', 'rae', 'way'],
      'lee': ['li', 'lea', 'leigh'],
      'amy': ['aimee', 'aim', 'emmy'],
      'anna': ['ana', 'anya', 'hannah'],
      'kate': ['cate', 'kay', 'kait'],
      'lisa': ['leesa', 'liza', 'elisa'],
      'sara': ['sarah', 'sera', 'zara'],
      'emma': ['ema', 'emmer', 'ima'],
      'copilot': ['co-pilot', 'co pilot', 'cope pilot', 'copy lot'],
      'assistant': ['assist ant', 'assistance', 'a system'],
      'ai': ['a i', 'hey', 'ay', 'eye'],
      'agent': ['a gent', 'aged', 'urgent'],
    }
    
    return mishearings[name] || []
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const m = str1.length
    const n = str2.length
    
    // Create matrix
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0))
    
    // Initialize base cases
    for (let i = 0; i <= m; i++) dp[i][0] = i
    for (let j = 0; j <= n; j++) dp[0][j] = j
    
    // Fill matrix
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1]
        } else {
          dp[i][j] = 1 + Math.min(
            dp[i - 1][j],     // deletion
            dp[i][j - 1],     // insertion
            dp[i - 1][j - 1]  // substitution
          )
        }
      }
    }
    
    return dp[m][n]
  }

  /**
   * Calculate similarity ratio between two strings (0-1)
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const maxLen = Math.max(str1.length, str2.length)
    if (maxLen === 0) return 1
    
    const distance = this.levenshteinDistance(str1, str2)
    return 1 - (distance / maxLen)
  }

  /**
   * Detect if agent is mentioned using exact and fuzzy matching
   */
  detectMention(text: string): MentionResult {
    const lowerText = text.toLowerCase()
    const words = lowerText.split(/\s+/)
    
    // First, try exact matching
    for (const variation of this.agentNameVariations) {
      if (lowerText.includes(variation)) {
        return {
          isMentioned: true,
          matchedVariation: variation,
          confidence: 1.0,
          fuzzyMatch: false
        }
      }
    }
    
    // Try phonetic variations (exact match on phonetic)
    for (const [original, phonetics] of this.phoneticVariations) {
      for (const phonetic of phonetics) {
        if (lowerText.includes(phonetic)) {
          return {
            isMentioned: true,
            matchedVariation: original,
            confidence: 0.9,
            fuzzyMatch: true
          }
        }
      }
    }
    
    // Try fuzzy matching on individual words
    for (const word of words) {
      if (word.length < 3) continue // Skip very short words
      
      for (const variation of this.agentNameVariations) {
        const similarity = this.calculateSimilarity(word, variation)
        
        if (similarity >= this.fuzzyMatchThreshold) {
          return {
            isMentioned: true,
            matchedVariation: variation,
            confidence: similarity,
            fuzzyMatch: true
          }
        }
      }
    }
    
    return {
      isMentioned: false,
      matchedVariation: null,
      confidence: 0,
      fuzzyMatch: false
    }
  }

  /**
   * GPT-enhanced detection for ambiguous cases and indirect references
   * Only called when local detection has medium confidence (50-85%)
   */
  async detectMentionWithGpt(
    text: string, 
    localResult: MentionResult,
    recentContext?: string[]
  ): Promise<MentionResult> {
    // If GPT not enabled or local result is very confident, return local result
    if (!this.gptEnabled) {
      return localResult
    }

    // If local result is high confidence (>85%), no need for GPT
    if (localResult.isMentioned && localResult.confidence >= this.gptAmbiguousThreshold) {
      console.log('🎯 High confidence local match, skipping GPT')
      return localResult
    }

    // If local result is very low confidence (<50%) and no mention, check for indirect references
    const shouldCheckIndirect = !localResult.isMentioned || localResult.confidence < this.gptMinConfidenceThreshold
    
    try {
      const openai = await this.getOpenAIClient()
      if (!openai) {
        return localResult
      }

      const result = await this.gptAnalyzeCaption(text, recentContext, shouldCheckIndirect, openai)
      
      if (result.nameDetected) {
        console.log('🤖 GPT detected agent reference:', result)
        return {
          isMentioned: true,
          matchedVariation: result.detectedAs || this.agentName,
          confidence: result.confidence,
          fuzzyMatch: true,
          gptEnhanced: true,
          indirectReference: result.isIndirectReference
        }
      }
      
      // GPT didn't find a mention - return local result (might still be valid fuzzy match)
      return localResult
      
    } catch (error) {
      console.error('GPT caption analysis failed, using local result:', error)
      return localResult
    }
  }

  /**
   * Use GPT to correct speech-to-text errors in caption
   */
  async correctCaptionText(text: string): Promise<string> {
    if (!this.gptEnabled) {
      return text
    }

    try {
      const openai = await this.getOpenAIClient()
      if (!openai) {
        return text
      }

      const systemPrompt = `You are a speech-to-text correction system. Your task is to fix common speech recognition errors in the text.

The AI agent's name is "${this.agentName}".

Common errors to fix:
- Misheard names (e.g., "Steev" → "Steve", "Jon" → "John")
- Homophones (e.g., "their" vs "there", "your" vs "you're")
- Run-together words (e.g., "whattime" → "what time")
- Missing spaces after punctuation

Rules:
- ONLY fix obvious speech-to-text errors
- Keep the original meaning intact
- If the name sounds like "${this.agentName}", correct it to "${this.agentName}"
- Return ONLY the corrected text, nothing else`

      const completion = await openai.chat.completions.create({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        model: this.deploymentName,
        max_completion_tokens: 200
      })

      const corrected = completion.choices[0]?.message?.content?.trim() || text
      
      if (corrected !== text) {
        console.log('📝 GPT corrected caption:', { original: text, corrected })
      }
      
      return corrected
      
    } catch (error) {
      console.error('GPT caption correction failed:', error)
      return text
    }
  }

  /**
   * Internal GPT analysis for detecting agent mentions and indirect references
   */
  private async gptAnalyzeCaption(
    text: string, 
    recentContext?: string[],
    checkIndirect: boolean = true,
    openaiClient?: OpenAI
  ): Promise<GptCorrectionResult> {
    const openai = openaiClient ?? await this.getOpenAIClient()
    if (!openai) {
      throw new Error('OpenAI not initialized')
    }

    const contextStr = recentContext?.length 
      ? `\nRecent conversation:\n${recentContext.slice(-3).join('\n')}\n`
      : ''

    const systemPrompt = `You are an agent mention detection system. The AI agent's name is "${this.agentName}" (variations: ${this.agentNameVariations.join(', ')}).

Your task: Determine if the speaker is trying to address or mention the AI agent.

DETECT AS MENTIONED when:
1. The agent's name is used (even if misspelled/misheard: "Steev" for "Steve", etc.)
2. ${checkIndirect ? `Indirect references like "the AI", "the assistant", "the bot", "you" (when clearly addressing the agent), "hey assistant", etc.` : 'Direct name mentions only'}
3. Wake words like "hey [name]", "ok [name]", "excuse me [name]"

DO NOT DETECT when:
- Talking about AI/assistants in general, not THIS specific agent
- The name is mentioned but clearly talking TO someone else
- Just casual conversation not involving the agent

${contextStr}

Output ONLY valid JSON:
{
  "correctedText": "text with any name corrections applied",
  "nameDetected": true/false,
  "detectedAs": "the matched name or reference" or null,
  "isIndirectReference": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}`

    const completion = await openai.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze this caption: "${text}"` }
      ],
      model: this.deploymentName,
      max_completion_tokens: 200
    })

    const responseText = completion.choices[0]?.message?.content?.trim() || ''
    
    try {
      return JSON.parse(responseText) as GptCorrectionResult
    } catch {
      // Try to extract from malformed response
      const detected = responseText.toLowerCase().includes('"namedetected": true') ||
                      responseText.toLowerCase().includes('"namedetected":true')
      return {
        correctedText: text,
        nameDetected: detected,
        detectedAs: detected ? this.agentName : null,
        isIndirectReference: false,
        confidence: detected ? 0.6 : 0,
        reasoning: 'Parsed from malformed JSON'
      }
    }
  }

  /**
   * Enhanced detection combining local fuzzy matching with GPT validation
   * Use this for the best accuracy with cost optimization
   */
  async detectMentionHybrid(
    text: string,
    recentContext?: string[]
  ): Promise<MentionResult> {
    // Step 1: Local detection (fast, free)
    const localResult = this.detectMention(text)
    
    // Step 2: If high confidence match, return immediately
    if (localResult.isMentioned && localResult.confidence >= this.gptAmbiguousThreshold) {
      return localResult
    }
    
    // Step 3: If medium confidence OR no match, use GPT for validation/indirect detection
    if (this.gptEnabled) {
      // Medium confidence: validate with GPT
      if (localResult.isMentioned && localResult.confidence >= this.gptMinConfidenceThreshold) {
        console.log('🔍 Medium confidence match, validating with GPT...')
        return this.detectMentionWithGpt(text, localResult, recentContext)
      }
      
      // No local match: check for indirect references with GPT
      console.log('🔍 No local match, checking for indirect references with GPT...')
      return this.detectMentionWithGpt(text, localResult, recentContext)
    }
    
    return localResult
  }

  /**
   * Check if text contains a question or request
   */
  containsQuestionOrRequest(text: string): boolean {
    const lowerText = text.toLowerCase().trim()
    
    // Check for question mark
    if (text.includes('?')) return true
    
    // Question words at start
    const questionStarters = [
      'what', 'when', 'where', 'who', 'whom', 'whose', 'why', 'which', 'how',
      'can', 'could', 'would', 'should', 'will', 'is', 'are', 'do', 'does', 'did',
      'have', 'has', 'may', 'might', 'shall'
    ]
    
    for (const starter of questionStarters) {
      if (lowerText.startsWith(starter + ' ')) return true
    }
    
    // Request phrases anywhere
    const requestPhrases = [
      'tell me', 'explain', 'describe', 'show me', 'help', 'find', 
      'search', 'give me', 'i want', 'i need', 'let me know',
      'can you', 'could you', 'would you', 'please'
    ]
    
    for (const phrase of requestPhrases) {
      if (lowerText.includes(phrase)) return true
    }
    
    return false
  }

  /**
   * Add a caption to the buffer for aggregation
   */
  addCaption(caption: CaptionEntry): void {
    const now = Date.now()
    
    // Clean old captions from buffer
    this.captionBuffer = this.captionBuffer.filter(
      c => (now - c.timestamp) < this.aggregationWindowMs
    )
    
    // Add new caption
    this.captionBuffer.push(caption)
    
    // Check if we should process the aggregated captions
    this.processBuffer(caption.speaker)
  }

  /**
   * Process the caption buffer for a speaker
   */
  private processBuffer(currentSpeaker: string): void {
    const now = Date.now()
    
    // Get all captions from the current speaker within the window
    const speakerCaptions = this.captionBuffer.filter(
      c => c.speaker === currentSpeaker && (now - c.timestamp) < this.aggregationWindowMs
    )
    
    if (speakerCaptions.length === 0) return
    
    // Sort by timestamp
    speakerCaptions.sort((a, b) => a.timestamp - b.timestamp)
    
    // Aggregate text
    const aggregatedText = speakerCaptions.map(c => c.text).join(' ')
    
    // Check for mention in aggregated text
    const mention = this.detectMention(aggregatedText)
    
    // Create aggregated caption — use the most recent caption's language
    const lastLang = speakerCaptions[speakerCaptions.length - 1].spokenLanguage
    const aggregated: AggregatedCaption = {
      speaker: currentSpeaker,
      text: aggregatedText,
      captionIds: speakerCaptions.map(c => c.id),
      startTime: speakerCaptions[0].timestamp,
      endTime: speakerCaptions[speakerCaptions.length - 1].timestamp,
      spokenLanguage: lastLang,
    }
    
    // Handle pending mention logic
    if (mention.isMentioned) {
      const hasQuestion = this.containsQuestionOrRequest(aggregatedText)
      
      if (hasQuestion) {
        // Clear any pending mention - we have a complete query
        this.clearPendingMention()
        
        // Emit the aggregated caption with mention
        if (this.onAggregatedCaption) {
          this.onAggregatedCaption(aggregated, mention)
        }
      } else {
        // Name mentioned but no question yet - set pending
        this.setPendingMention({
          speaker: currentSpeaker,
          captionText: aggregatedText,
          timestamp: now,
          matchedVariation: mention.matchedVariation || ''
        })
      }
    } else if (this.pendingMention && this.pendingMention.speaker === currentSpeaker) {
      // We have a pending mention from this speaker - check if this is the follow-up question
      const hasQuestion = this.containsQuestionOrRequest(aggregatedText)
      
      if (hasQuestion) {
        // Combine pending mention text with current text
        const combinedText = `${this.pendingMention.captionText} ${aggregatedText}`
        const combinedMention = this.detectMention(combinedText)
        
        const combinedAggregated: AggregatedCaption = {
          ...aggregated,
          text: combinedText
        }
        
        this.clearPendingMention()
        
        if (this.onAggregatedCaption) {
          this.onAggregatedCaption(combinedAggregated, combinedMention)
        }
      }
    } else {
      // No mention and no pending - just emit for potential session handling
      if (this.onAggregatedCaption) {
        this.onAggregatedCaption(aggregated, mention)
      }
    }
  }

  /**
   * Set a pending mention (name detected, waiting for question)
   */
  private setPendingMention(pending: PendingMention): void {
    this.clearPendingMention()
    
    this.pendingMention = pending
    console.log('⏳ Pending mention set, waiting for follow-up question:', pending.captionText)
    
    // Set timeout for pending mention
    this.pendingMentionTimer = setTimeout(() => {
      if (this.pendingMention) {
        console.log('⏰ Pending mention timeout - processing anyway')
        
        if (this.onPendingMentionTimeout) {
          this.onPendingMentionTimeout(this.pendingMention)
        }
        
        this.pendingMention = null
      }
    }, this.pendingMentionTimeoutMs)
  }

  /**
   * Clear pending mention and timer
   */
  private clearPendingMention(): void {
    if (this.pendingMentionTimer) {
      clearTimeout(this.pendingMentionTimer)
      this.pendingMentionTimer = null
    }
    this.pendingMention = null
  }

  /**
   * Force flush the buffer (e.g., when speaker changes or on timeout)
   */
  flushBuffer(): void {
    if (this.captionBuffer.length === 0) return
    
    // Group by speaker and process each
    const bySpeaker = new Map<string, CaptionEntry[]>()
    for (const caption of this.captionBuffer) {
      const existing = bySpeaker.get(caption.speaker) || []
      existing.push(caption)
      bySpeaker.set(caption.speaker, existing)
    }
    
    for (const [speaker] of bySpeaker) {
      this.processBuffer(speaker)
    }
    
    this.captionBuffer = []
  }

  /**
   * Get current pending mention status
   */
  getPendingMention(): PendingMention | null {
    return this.pendingMention
  }

  /**
   * Check if there's a pending mention
   */
  hasPendingMention(): boolean {
    return this.pendingMention !== null
  }

  /**
   * Update configuration
   */
  setConfig(config: {
    aggregationWindowMs?: number
    pendingMentionTimeoutMs?: number
    fuzzyMatchThreshold?: number
    gptAmbiguousThreshold?: number
    gptMinConfidenceThreshold?: number
  }): void {
    if (config.aggregationWindowMs !== undefined) {
      this.aggregationWindowMs = config.aggregationWindowMs
    }
    if (config.pendingMentionTimeoutMs !== undefined) {
      this.pendingMentionTimeoutMs = config.pendingMentionTimeoutMs
    }
    if (config.fuzzyMatchThreshold !== undefined) {
      this.fuzzyMatchThreshold = config.fuzzyMatchThreshold
    }
    if (config.gptAmbiguousThreshold !== undefined) {
      this.gptAmbiguousThreshold = config.gptAmbiguousThreshold
    }
    if (config.gptMinConfidenceThreshold !== undefined) {
      this.gptMinConfidenceThreshold = config.gptMinConfidenceThreshold
    }
  }

  /**
   * Clean up
   */
  dispose(): void {
    this.clearPendingMention()
    this.captionBuffer = []
    this.openai = null
    this.openaiConfig = null
    this.openaiClientPromise = null
    this.gptEnabled = false
  }
}

// Singleton instance
let instance: CaptionAggregationService | null = null

export function getCaptionAggregationService(): CaptionAggregationService {
  if (!instance) {
    instance = new CaptionAggregationService()
  }
  return instance
}

export type { 
  CaptionEntry, 
  AggregatedCaption, 
  MentionResult, 
  PendingMention,
  GptConfig
}
