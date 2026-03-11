// ============================================
// Idle Timeout Service
// Auto-leaves meeting when agent is alone for too long
// ============================================

import { usePreferencesStore } from '@/stores/preferencesStore'
import { DEFAULT_IDLE_TIMEOUT_CONFIG } from '@/types'
import type { IdleTimeoutConfig } from '@/types'
import { loggers } from '@/lib/logger'

const log = loggers.app

/**
 * State machine for idle timeout:
 *
 *   monitoring  →  alone  →  warning_sent  →  leaving
 *       ↑            |            |
 *       └────────────┴────────────┘  (participant rejoins → back to monitoring)
 */
export type IdleTimeoutState = 'monitoring' | 'alone' | 'warning_sent' | 'leaving'

export class IdleTimeoutService {
  private _state: IdleTimeoutState = 'monitoring'
  private _remoteParticipantCount = 0
  private _hadParticipants = false
  private _disposed = false
  private _started = false

  private _aloneTimer: ReturnType<typeof setTimeout> | null = null
  private _warningTimer: ReturnType<typeof setTimeout> | null = null

  /** Called when a warning should be sent (e.g. chat message). Set by SessionManager. */
  public onWarning: ((message: string) => void) | null = null
  /** Called when the agent should leave the meeting. Set by SessionManager. */
  public onLeave: ((reason: string) => void) | null = null

  private _unsubscribe: (() => void) | null = null
  private _label: string

  constructor(label: string) {
    this._label = label
  }

  // ── Public API ──

  get state(): IdleTimeoutState {
    return this._state
  }

  get remoteParticipantCount(): number {
    return this._remoteParticipantCount
  }

  /**
   * Start monitoring. Subscribes to preferences store for config changes.
   */
  start(): void {
    if (this._disposed || this._started) return
    this._started = true

    // Subscribe to preference changes so we react to config updates mid-session
    this._unsubscribe = usePreferencesStore.subscribe(
      (state, prevState) => {
        const newConfig = state.preferences.idleTimeout
        const oldConfig = prevState.preferences.idleTimeout
        if (newConfig !== oldConfig) {
          this._onConfigChanged(newConfig)
        }
      },
    )

    this._log('info', 'Idle timeout monitoring started')
  }

  /**
   * Called when a remote participant joins the meeting.
   */
  participantJoined(): void {
    if (this._disposed) return
    this._remoteParticipantCount++
    this._hadParticipants = true

    if (this._state !== 'monitoring') {
      this._log('info', `Participant joined (count: ${this._remoteParticipantCount}) — cancelling idle timeout`)
      this._cancelTimers()
      this._state = 'monitoring'
    }
  }

  /**
   * Called when a remote participant leaves the meeting.
   */
  participantLeft(): void {
    if (this._disposed) return
    this._remoteParticipantCount = Math.max(0, this._remoteParticipantCount - 1)

    if (this._remoteParticipantCount === 0 && this._hadParticipants && this._state === 'monitoring') {
      this._startAloneCountdown()
    }
  }

  /**
   * Clean up timers and subscriptions.
   */
  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._cancelTimers()
    this._unsubscribe?.()
    this._unsubscribe = null
    this._log('info', 'Idle timeout service disposed')
  }

  // ── Private ──

  private _getConfig(): IdleTimeoutConfig {
    return usePreferencesStore.getState().preferences.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_CONFIG
  }

  private _startAloneCountdown(): void {
    const config = this._getConfig()
    if (!config.enabled) {
      this._log('info', 'Agent is alone but idle timeout is disabled — staying')
      return
    }

    this._cancelTimers()
    this._state = 'alone'

    const totalMs = config.timeoutMinutes * 60_000
    const warningMs = totalMs - config.warningBeforeLeaveMs

    this._log('info', `Agent is alone — will auto-leave in ${config.timeoutMinutes} min`)

    // Schedule warning if there's enough time before leaving
    if (warningMs > 0) {
      this._warningTimer = setTimeout(() => {
        if (this._disposed || this._state !== 'alone') return
        this._state = 'warning_sent'

        const remainingSec = Math.round(config.warningBeforeLeaveMs / 1000)
        const warningMsg = `⏳ No participants detected. I'll leave the meeting in ${remainingSec} seconds unless someone joins.`
        this._log('info', `Sending idle warning (${remainingSec}s until leave)`)
        this.onWarning?.(warningMsg)
      }, warningMs)
    }

    // Schedule the actual leave
    this._aloneTimer = setTimeout(() => {
      if (this._disposed) return
      // Only leave if still alone (not cancelled by a rejoin)
      if (this._state === 'alone' || this._state === 'warning_sent') {
        this._state = 'leaving'
        const reason = `No participants for ${config.timeoutMinutes} minute(s) — auto-leaving`
        this._log('info', reason)
        this.onLeave?.(reason)
      }
    }, totalMs)
  }

  private _cancelTimers(): void {
    if (this._aloneTimer) {
      clearTimeout(this._aloneTimer)
      this._aloneTimer = null
    }
    if (this._warningTimer) {
      clearTimeout(this._warningTimer)
      this._warningTimer = null
    }
  }

  private _onConfigChanged(config: IdleTimeoutConfig | undefined): void {
    if (this._disposed) return
    const cfg = config ?? DEFAULT_IDLE_TIMEOUT_CONFIG

    // If we're in an alone countdown and config was disabled, cancel
    if (!cfg.enabled && (this._state === 'alone' || this._state === 'warning_sent')) {
      this._log('info', 'Idle timeout disabled mid-countdown — cancelling')
      this._cancelTimers()
      this._state = 'monitoring'
      return
    }

    // If config changed while in alone state, restart countdown with new values
    if (cfg.enabled && this._state === 'alone') {
      this._log('info', 'Idle timeout config changed — restarting countdown')
      this._startAloneCountdown()
    }
  }

  private _log(level: 'info' | 'warn' | 'error', message: string): void {
    log[level](`[IdleTimeout:${this._label}] ${message}`)
  }
}
