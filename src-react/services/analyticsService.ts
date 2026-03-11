// Call Analytics Service
// Collects call data and generates AI-powered summaries using Azure OpenAI

import type OpenAI from 'openai'
import type { Caption } from '@/types'
import {
  createAzureOpenAIClient,
  isDesktopRuntimeAvailable,
  type AzureOpenAIClientConfig,
} from '@/services/validationService'

interface CaptionEntry {
  speaker: string
  text: string
  timestamp: Date
  isFinal: boolean
}

interface QuestionEntry {
  speaker: string
  text: string
  timestamp: Date
  responseTime: number | null
}

interface ResponseEntry {
  text: string
  timestamp: Date
}

export interface CallStats {
  totalDuration: number
  totalCaptions: number
  totalQuestions: number
  totalResponses: number
  participantCount: number
  averageResponseTime: number
}

export interface TopQuestion {
  number: number
  speaker: string
  text: string
  responseTime: string
}

export interface CallAnalytics {
  stats: {
    duration: string
    durationSeconds: number
    participants: number
    participantList: string[]
    captions: number
    questions: number
    responses: number
    averageResponseTime: number
  }
  summary: string
  topQuestions: TopQuestion[]
  transcript: string
  callStart: Date | null
  callEnd: Date | null
}

interface AnalyticsConfig {
  openaiEndpoint?: string
  openaiApiKey?: string
  openaiDeployment?: string
}

/**
 * Call Analytics Service - Tracks call statistics and generates post-call summaries
 */
export class CallAnalyticsService {
  private callStartTime: Date | null = null
  private callEndTime: Date | null = null
  
  private captions: CaptionEntry[] = []
  private questions: QuestionEntry[] = []
  private agentResponses: ResponseEntry[] = []
  private participants = new Set<string>()
  
  private stats: CallStats = {
    totalDuration: 0,
    totalCaptions: 0,
    totalQuestions: 0,
    totalResponses: 0,
    participantCount: 0,
    averageResponseTime: 0
  }
  
  private openai: OpenAI | null = null
  private openaiConfig: AzureOpenAIClientConfig | null = null
  private openaiClientPromise: Promise<OpenAI> | null = null
  private deploymentName: string = ''
  private isAIEnabled: boolean = false

  private async getOpenAIClient(): Promise<OpenAI | null> {
    if (!this.isAIEnabled || !this.openaiConfig) {
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
   * Initialize OpenAI client for AI-powered summaries
   */
  initialize(config: AnalyticsConfig): boolean {
    if (!config.openaiEndpoint || !config.openaiApiKey || !config.openaiDeployment) {
      console.warn('OpenAI not configured for call analytics. Basic summaries will be generated.')
      this.isAIEnabled = false
      this.openaiConfig = null
      this.openai = null
      this.openaiClientPromise = null
      return false
    }

    if (!isDesktopRuntimeAvailable()) {
      console.warn('OpenAI call analytics requires the Tauri desktop runtime.')
      this.isAIEnabled = false
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
    this.deploymentName = config.openaiDeployment
    this.isAIEnabled = true
    console.log('CallAnalyticsService AI enabled')
    return true
  }

  /**
   * Start tracking a new call
   * Only resets if not already tracking (to handle React StrictMode double-invocation)
   */
  startCall(): void {
    // Don't reset if we're already tracking a call
    if (this.callStartTime && !this.callEndTime) {
      console.log('Call analytics already started, not resetting')
      return
    }
    this.reset()
    this.callStartTime = new Date()
    console.log('Call analytics started at:', this.callStartTime.toISOString())
  }

  /**
   * End call tracking
   */
  endCall(): void {
    if (!this.callStartTime) {
      console.warn('Call analytics: endCall called but no call was started')
      return
    }
    if (this.callEndTime) {
      console.log('Call analytics already ended')
      return
    }
    this.callEndTime = new Date()
    this.calculateStats()
    console.log('Call analytics ended at:', this.callEndTime.toISOString())
    console.log('Final stats:', this.stats)
    console.log('Total captions tracked:', this.captions.length)
  }

  /**
   * Track a caption received during the call
   */
  trackCaption(caption: Caption): void {
    // Don't track if call hasn't started or has already ended
    if (!this.callStartTime || this.callEndTime) {
      return
    }
    
    const entry: CaptionEntry = {
      speaker: caption.speaker,
      text: caption.text,
      timestamp: caption.timestamp,
      isFinal: caption.isFinal
    }

    if (entry.isFinal && entry.text) {
      this.captions.push(entry)
      this.participants.add(entry.speaker)
      console.log(`Caption tracked (${this.captions.length} total): ${entry.speaker}: ${entry.text.substring(0, 50)}...`)
    }
  }

  /**
   * Track a question asked to the agent
   */
  trackQuestion(speaker: string, questionText: string, timestamp = new Date()): void {
    this.questions.push({
      speaker,
      text: questionText,
      timestamp,
      responseTime: null
    })
  }

  /**
   * Track an agent response
   */
  trackResponse(responseText: string, questionIndex: number | null = null, timestamp = new Date()): void {
    this.agentResponses.push({
      text: responseText,
      timestamp
    })

    // Calculate response time if we have a matching question
    if (questionIndex !== null && this.questions[questionIndex]) {
      const question = this.questions[questionIndex]
      question.responseTime = timestamp.getTime() - question.timestamp.getTime()
    } else if (this.questions.length > 0) {
      // Link to most recent unanswered question
      const lastQuestion = this.questions[this.questions.length - 1]
      if (lastQuestion.responseTime === null) {
        lastQuestion.responseTime = timestamp.getTime() - lastQuestion.timestamp.getTime()
      }
    }
  }

  /**
   * Calculate final statistics
   */
  private calculateStats(): void {
    // Duration
    if (this.callStartTime && this.callEndTime) {
      this.stats.totalDuration = Math.floor(
        (this.callEndTime.getTime() - this.callStartTime.getTime()) / 1000
      )
    }

    // Counts
    this.stats.totalCaptions = this.captions.length
    this.stats.totalQuestions = this.questions.length
    this.stats.totalResponses = this.agentResponses.length
    this.stats.participantCount = this.participants.size

    // Average response time
    const responseTimes = this.questions
      .filter(q => q.responseTime !== null)
      .map(q => q.responseTime!)

    if (responseTimes.length > 0) {
      this.stats.averageResponseTime = Math.floor(
        responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length / 1000
      )
    }
  }

  /**
   * Get formatted duration string (e.g., "1:29" for 89 seconds)
   */
  getFormattedDuration(): string {
    const seconds = this.stats.totalDuration
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    } else if (minutes > 0) {
      return `${minutes}:${secs.toString().padStart(2, '0')}`
    } else {
      return `0:${secs.toString().padStart(2, '0')}`
    }
  }

  /**
   * Get top questions
   */
  getTopQuestions(limit = 5): TopQuestion[] {
    return this.questions.slice(0, limit).map((q, idx) => ({
      number: idx + 1,
      speaker: q.speaker,
      text: q.text,
      responseTime: q.responseTime ? `${(q.responseTime / 1000).toFixed(1)}s` : 'N/A'
    }))
  }

  /**
   * Get raw captions data for display
   */
  getCaptions(): Array<{ speaker: string; text: string; timestamp: Date }> {
    return this.captions.map(c => ({
      speaker: c.speaker,
      text: c.text,
      timestamp: c.timestamp
    }))
  }

  /**
   * Generate a basic conversation transcript
   */
  getTranscript(): string {
    return this.captions
      .map(c => `[${c.timestamp.toLocaleTimeString()}] ${c.speaker}: ${c.text}`)
      .join('\n')
  }

  /**
   * Generate AI-powered conversation summary
   */
  async generateSummary(): Promise<string> {
    if (!this.isAIEnabled) {
      return this.generateBasicSummary()
    }

    try {
      const openai = await this.getOpenAIClient()
      if (!openai) {
        return this.generateBasicSummary()
      }

      console.log('Generating AI-powered call summary...')

      const conversationContext = this.buildConversationContext()

      const completion = await openai.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: `You are an expert meeting analyst. Generate a comprehensive, well-structured summary of the call/meeting.

YOUR TASK:
Create a detailed summary with the following sections:

1. **Executive Summary**: A comprehensive paragraph (4-6 sentences) summarizing the entire meeting, including purpose, main outcomes, and overall sentiment

2. **Key Topics Discussed**: Bullet list of the main subjects and themes covered during the meeting (minimum 3-5 topics if applicable)

3. **Questions Asked to Agent**: Detailed list of questions/requests made to the AI agent, with brief context and answers:
   - Format: "[Speaker] asked about [topic/question] → Agent responded with [brief answer summary]"
   - If no questions, state "No direct questions were asked to the agent"

4. **Pending Items**: Bullet list of any unresolved questions, topics that need follow-up, or items marked as "to be addressed later" (if any)

5. **Follow-up Actions**: Specific action items, tasks assigned, or next steps mentioned (if any):
   - Who needs to do what
   - Any mentioned deadlines or timelines

6. **Notable Moments**: Interesting insights, decisions made, or important clarifications provided

FORMATTING GUIDELINES:
- Use clear markdown headings (##) for each section
- Use bullet points for lists
- Keep it professional and informative
- If the conversation is short/test-like, still provide structured analysis of what was discussed
- Focus on substance over length - quality over quantity`
          },
          {
            role: 'user',
            content: `Please analyze and summarize this call comprehensively:

📊 CALL STATISTICS:
- Duration: ${this.getFormattedDuration()}
- Participants: ${this.stats.participantCount} (${Array.from(this.participants).join(', ')})
- Total conversational exchanges: ${this.stats.totalCaptions}
- Questions directed to agent: ${this.stats.totalQuestions}
- Agent responses delivered: ${this.stats.totalResponses}
- Average response time: ${this.stats.averageResponseTime > 0 ? `${this.stats.averageResponseTime}s` : 'N/A'}

💬 FULL CONVERSATION TRANSCRIPT:
${conversationContext}

❓ DETAILED QUESTIONS TO AGENT:
${this.questions.map((q, i) => `${i + 1}. [${q.speaker}] at ${q.timestamp.toLocaleTimeString()}: "${q.text}"`).join('\n') || 'No questions recorded'}

🤖 AGENT RESPONSES:
${this.agentResponses.map((r, i) => `${i + 1}. at ${r.timestamp.toLocaleTimeString()}: "${r.text}"`).join('\n\n') || 'No responses recorded'}

Please provide a comprehensive, structured analysis following the format specified in the system prompt.`
          }
        ],
        model: this.deploymentName,
        max_completion_tokens: 2500
      })

      const summary = completion.choices[0]?.message?.content?.trim()

      if (summary) {
        console.log('AI summary generated successfully')
        return summary
      } else {
        console.warn('AI returned empty summary, using basic summary')
        return this.generateBasicSummary()
      }
    } catch (error) {
      console.error('Error generating AI summary:', error)
      return this.generateBasicSummary()
    }
  }

  /**
   * Build conversation context for AI
   */
  private buildConversationContext(): string {
    // Limit to last 50 captions to avoid token limits
    const recentCaptions = this.captions.slice(-50)
    return recentCaptions.map(c => `${c.speaker}: ${c.text}`).join('\n')
  }

  /**
   * Generate basic summary without AI
   */
  private generateBasicSummary(): string {
    const parts: string[] = []

    // Overview section
    parts.push('## 📋 Meeting Overview\n\n')

    if (this.stats.totalCaptions === 0) {
      parts.push('*No conversation data was captured during this call.*\n\n')
      return parts.join('')
    }
    
    parts.push(`This meeting lasted **${this.getFormattedDuration()}** with **${this.stats.participantCount}** participant(s). `)
    parts.push(`There were **${this.stats.totalCaptions}** conversational exchanges, `)
    parts.push(`**${this.stats.totalQuestions}** questions asked to the agent, `)
    parts.push(`and **${this.stats.totalResponses}** responses provided.\n\n`)
    
    if (this.stats.averageResponseTime > 0) {
      parts.push(`*Average agent response time: ${this.stats.averageResponseTime}s*\n\n`)
    }

    // Participants
    if (this.participants.size > 0) {
      parts.push('### 👥 Participants\n\n')
      const participantList = Array.from(this.participants)
      parts.push(participantList.map(p => `• ${p}`).join('  \n'))
      parts.push('\n\n')
    }

    // Questions & Answers section
    if (this.stats.totalQuestions > 0) {
      parts.push(`### ❓ Questions Asked\n\n`)
      this.questions.slice(0, 10).forEach((q, i) => {
        const responseTime = q.responseTime ? ` *(${(q.responseTime / 1000).toFixed(1)}s response)*` : ''
        parts.push(`${i + 1}. **${q.speaker}**: "${q.text}"${responseTime}\n`)
      })
      if (this.questions.length > 10) {
        parts.push(`\n*...and ${this.questions.length - 10} more questions*\n`)
      }
      parts.push('\n')
    }

    // Agent Responses section
    if (this.stats.totalResponses > 0) {
      parts.push('### 🤖 Agent Activity\n\n')
      parts.push(`The AI agent provided **${this.stats.totalResponses}** response(s) during this call.\n\n`)
      
      // Show sample responses
      const sampleResponses = this.agentResponses.slice(0, 3)
      if (sampleResponses.length > 0) {
        parts.push('**Sample Responses:**\n\n')
        sampleResponses.forEach((r, i) => {
          const preview = r.text.length > 150 ? r.text.substring(0, 150) + '...' : r.text
          parts.push(`> ${i + 1}. "${preview}"\n\n`)
        })
      }
    }

    // Footer
    parts.push('---\n\n')
    parts.push('*Summary generated automatically. For a more detailed AI-powered summary, ensure OpenAI is configured.*\n')

    return parts.join('')
  }

  /**
   * Get full analytics data for display
   */
  async getAnalytics(): Promise<CallAnalytics> {
    const summary = await this.generateSummary()

    return {
      stats: {
        duration: this.getFormattedDuration(),
        durationSeconds: this.stats.totalDuration,
        participants: this.stats.participantCount,
        participantList: Array.from(this.participants),
        captions: this.stats.totalCaptions,
        questions: this.stats.totalQuestions,
        responses: this.stats.totalResponses,
        averageResponseTime: this.stats.averageResponseTime
      },
      summary,
      topQuestions: this.getTopQuestions(),
      transcript: this.getTranscript(),
      callStart: this.callStartTime,
      callEnd: this.callEndTime
    }
  }

  /**
   * Get current stats (without async summary)
   */
  getStats(): CallStats {
    return { ...this.stats }
  }

  /**
   * Reset all tracking data
   */
  reset(): void {
    this.callStartTime = null
    this.callEndTime = null
    this.captions = []
    this.questions = []
    this.agentResponses = []
    this.participants.clear()
    this.openai = null
    this.openaiClientPromise = null
    this.stats = {
      totalDuration: 0,
      totalCaptions: 0,
      totalQuestions: 0,
      totalResponses: 0,
      participantCount: 0,
      averageResponseTime: 0
    }
    console.log('Call analytics reset')
  }
}

// Singleton instance
let instance: CallAnalyticsService | null = null

export function getCallAnalyticsService(): CallAnalyticsService {
  if (!instance) {
    instance = new CallAnalyticsService()
  }
  return instance
}
