// ============================================
// Agent Behavior Types
// ============================================

/**
 * Sources that can trigger the agent
 */
export type TriggerSource = 'caption-mention' | 'chat-mention'

/**
 * Channels through which the agent can respond (reactive mode)
 */
export type ResponseChannel = 'chat' | 'speech'

/**
 * Channels for proactive responses — includes 'auto' which picks
 * speech or chat based on recent meeting activity.
 * Auto applies to Proactive mode only; Reactive channel is unaffected.
 */
export type ProactiveResponseChannel = ResponseChannel | 'auto'

/**
 * Turn-taking policy for spoken proactive responses.
 * 'interview-safe' keeps the agent's turn once it starts speaking and
 * evaluates overlapping human replies after playback completes.
 * 'interruptible' preserves legacy barge-in behavior.
 */
export type ProactiveTurnTakingMode = 'interview-safe' | 'interruptible'

export const DEFAULT_PROACTIVE_TURN_TAKING_MODE: ProactiveTurnTakingMode = 'interview-safe'
export const LEGACY_PROACTIVE_TURN_TAKING_MODE: ProactiveTurnTakingMode = 'interruptible'

/**
 * Channel for delivering the goodbye message when the agent auto-leaves.
 * 'both' speaks the message AND sends it to chat.
 */
export type GoodbyeChannel = ResponseChannel | 'both'

/**
 * Configuration for proactive (role-play) agent behavior.
 * When enabled, the agent monitors meeting silence and proactively
 * contributes based on its instructions.
 */
export interface ProactiveConfig {
  /** Whether proactive mode is enabled (default: false) */
  enabled: boolean
  /** System-level instructions defining the agent's proactive role, goals, and scenario */
  instructions: string
  /** Silence duration (ms) before the agent evaluates whether to act (default: 10000) */
  silenceThresholdMs: number
  /** Channel for proactive responses (default: 'speech'). 'auto' picks based on recent meeting activity. */
  responseChannel: ProactiveResponseChannel
  /** Turn-taking policy for spoken proactive responses (default: 'interview-safe'). */
  turnTakingMode: ProactiveTurnTakingMode
  /** When true, the agent can leave the meeting by including [LEAVE_MEETING] in its response (default: false) */
  autoLeaveOnCompletion: boolean
  /** Fallback goodbye message if the agent doesn't include farewell text before [LEAVE_MEETING] */
  goodbyeMessage: string
  /** Channel for delivering the goodbye message (default: 'both' = speak + chat) */
  goodbyeChannel: GoodbyeChannel
}

/** Default proactive configuration */
export function getDefaultProactiveConfig(): ProactiveConfig {
  return {
    enabled: false,
    instructions: '',
    silenceThresholdMs: 10000,
    responseChannel: 'speech',
    turnTakingMode: DEFAULT_PROACTIVE_TURN_TAKING_MODE,
    autoLeaveOnCompletion: false,
    goodbyeMessage: '',
    goodbyeChannel: 'both',
  }
}

// ── Meeting data types used by behavior processing ──

/**
 * A caption from a meeting (spoken text recognized by the meeting platform)
 */
export interface MeetingCaption {
  id: string
  speaker: string
  speakerId?: string
  text: string
  timestamp: Date
  isFinal: boolean
}
