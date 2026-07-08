import { logger } from '@/lib/logger'

type StartupStatus = 'starting' | 'mounted' | 'failed'

interface StartupDiagnosticEvent {
  at: string
  phase: string
  details?: Record<string, string>
}

interface StartupDiagnosticError {
  source: string
  message: string
  stack?: string
}

interface StartupDiagnosticState {
  status: StartupStatus
  phase: string
  updatedAt: string
  events: StartupDiagnosticEvent[]
  lastError?: StartupDiagnosticError
}

declare global {
  interface Window {
    __dumpLogsFormatted?: () => string
  }
}

const STARTUP_DIAGNOSTICS_STORAGE_KEY = 'cab.renderer.startup'
const STARTUP_DIAGNOSTICS_MAX_EVENTS = 20
const STARTUP_DIAGNOSTICS_MAX_FIELD_LENGTH = 300
const STARTUP_DIAGNOSTICS_MAX_LOG_LENGTH = 6000

let handlersRegistered = false

function createDefaultStartupState(): StartupDiagnosticState {
  return {
    status: 'starting',
    phase: 'not-started',
    updatedAt: new Date().toISOString(),
    events: [],
  }
}

function truncate(value: string, maxLength = STARTUP_DIAGNOSTICS_MAX_FIELD_LENGTH): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

function normalizeDetails(details?: Record<string, unknown>): Record<string, string> | undefined {
  if (!details) {
    return undefined
  }

  const normalizedEntries = Object.entries(details)
    .filter(([, value]) => value != null)
    .map(([key, value]) => {
      if (typeof value === 'string') {
        return [key, truncate(value)]
      }

      if (typeof value === 'number' || typeof value === 'boolean') {
        return [key, String(value)]
      }

      try {
        return [key, truncate(JSON.stringify(value))]
      } catch {
        return [key, '[unserializable]']
      }
    })

  return normalizedEntries.length > 0
    ? Object.fromEntries(normalizedEntries)
    : undefined
}

function normalizeError(error: unknown, source: string): StartupDiagnosticError {
  if (error instanceof Error) {
    return {
      source,
      message: truncate(error.message, 500),
      stack: error.stack ? truncate(error.stack, 2000) : undefined,
    }
  }

  if (error != null && typeof error === 'object') {
    try {
      return {
        source,
        message: truncate(JSON.stringify(error), 500),
      }
    } catch {
      return {
        source,
        message: '[unserializable object]',
      }
    }
  }

  return {
    source,
    message: truncate(String(error), 500),
  }
}

function getStartupDiagnosticsStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readStartupState(): StartupDiagnosticState {
  const storage = getStartupDiagnosticsStorage()
  if (!storage) {
    return createDefaultStartupState()
  }

  try {
    const stored = storage.getItem(STARTUP_DIAGNOSTICS_STORAGE_KEY)
    if (!stored) {
      return createDefaultStartupState()
    }

    const parsed = JSON.parse(stored) as Partial<StartupDiagnosticState>
    return {
      ...createDefaultStartupState(),
      ...parsed,
      events: Array.isArray(parsed.events) ? parsed.events : [],
    }
  } catch (error) {
    logger.warn('Failed to parse renderer startup diagnostics', 'StartupDiagnostics', error)
    return createDefaultStartupState()
  }
}

function writeStartupState(mutator: (state: StartupDiagnosticState) => StartupDiagnosticState): void {
  const storage = getStartupDiagnosticsStorage()
  if (!storage) {
    return
  }

  try {
    const nextState = mutator(readStartupState())
    storage.setItem(STARTUP_DIAGNOSTICS_STORAGE_KEY, JSON.stringify(nextState))
  } catch (error) {
    logger.warn('Failed to persist renderer startup diagnostics', 'StartupDiagnostics', error)
  }
}

function appendStartupEvent(
  state: StartupDiagnosticState,
  phase: string,
  details?: Record<string, string>
): StartupDiagnosticState {
  const event: StartupDiagnosticEvent = {
    at: new Date().toISOString(),
    phase,
    details,
  }

  return {
    ...state,
    phase,
    updatedAt: event.at,
    events: [...state.events, event].slice(-STARTUP_DIAGNOSTICS_MAX_EVENTS),
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getEnvironmentSummary(): Record<string, unknown> {
  if (typeof window === 'undefined') {
    return {
      mode: import.meta.env.MODE,
      baseUrl: import.meta.env.BASE_URL,
      prod: import.meta.env.PROD,
    }
  }

  return {
    mode: import.meta.env.MODE,
    baseUrl: import.meta.env.BASE_URL,
    prod: import.meta.env.PROD,
    protocol: window.location.protocol,
    host: window.location.host,
  }
}

export function recordStartupPhase(phase: string, details?: Record<string, unknown>): void {
  const normalizedDetails = normalizeDetails(details)

  logger.info(`Renderer startup phase: ${phase}`, 'StartupDiagnostics', normalizedDetails)
  writeStartupState((state) => appendStartupEvent(state, phase, normalizedDetails))
}

export function recordStartupError(source: string, error: unknown): void {
  const normalized = normalizeError(error, source)

  logger.error(
    `Renderer startup error in ${source}: ${normalized.message}`,
    'StartupDiagnostics',
    normalized.stack
  )

  writeStartupState((state) => {
    const nextState = appendStartupEvent(state, `${source}:error`, {
      message: normalized.message,
    })

    return {
      ...nextState,
      status: 'failed',
      lastError: normalized,
    }
  })
}

export function markStartupComplete(details?: Record<string, unknown>): void {
  const normalizedDetails = normalizeDetails(details)

  logger.info('Renderer startup complete', 'StartupDiagnostics', normalizedDetails)
  writeStartupState((state) => {
    const nextState = appendStartupEvent(state, 'renderer-mounted', normalizedDetails)
    return {
      ...nextState,
      status: 'mounted',
      lastError: undefined,
    }
  })
}

export function attachStartupErrorHandlers(): void {
  if (typeof window === 'undefined' || handlersRegistered) {
    return
  }

  handlersRegistered = true

  window.addEventListener('error', (event) => {
    recordStartupError('window.error', event.error ?? event.message)
  })

  window.addEventListener('unhandledrejection', (event) => {
    recordStartupError('window.unhandledrejection', event.reason)
  })

  recordStartupPhase('bootstrap-handlers-attached', getEnvironmentSummary())
}

export function getStartupDiagnosticsText(): string {
  const state = readStartupState()
  const lines = [
    'Community Agent Bridge renderer diagnostics',
    `Status: ${state.status}`,
    `Current phase: ${state.phase}`,
    `Updated at: ${state.updatedAt}`,
  ]

  if (state.lastError) {
    lines.push(
      '',
      `Last error source: ${state.lastError.source}`,
      `Last error message: ${state.lastError.message}`
    )

    if (state.lastError.stack) {
      lines.push('Last error stack:', state.lastError.stack)
    }
  }

  if (state.events.length > 0) {
    lines.push('', 'Startup events:')
    for (const event of state.events) {
      const details = event.details
        ? ` (${Object.entries(event.details).map(([key, value]) => `${key}=${value}`).join(', ')})`
        : ''
      lines.push(`- ${event.at} ${event.phase}${details}`)
    }
  }

  const loggerDump = typeof window !== 'undefined'
    ? window.__dumpLogsFormatted?.()
    : undefined

  if (loggerDump) {
    lines.push(
      '',
      'Recent renderer logs:',
      truncate(loggerDump, STARTUP_DIAGNOSTICS_MAX_LOG_LENGTH)
    )
  }

  return lines.join('\n')
}

export function renderStartupFallback(root: HTMLElement, title: string, error?: unknown): void {
  const diagnosticsText = getStartupDiagnosticsText()
  const errorSummary = error
    ? `<p style="margin:0 0 12px;color:#b91c1c;font-size:14px;">${escapeHtml(
        normalizeError(error, 'bootstrap').message
      )}</p>`
    : ''

  root.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f8fafc;color:#0f172a;font-family:Segoe UI, Arial, sans-serif;">
      <div style="width:100%;max-width:840px;border:1px solid #cbd5e1;border-radius:16px;background:#ffffff;box-shadow:0 20px 60px rgba(15, 23, 42, 0.12);padding:24px;">
        <h1 style="margin:0 0 8px;font-size:24px;">${escapeHtml(title)}</h1>
        <p style="margin:0 0 16px;color:#475569;line-height:1.5;">
          The packaged renderer failed before the normal UI could load. Use the diagnostics below to identify whether startup failed during hydration, asset loading, or another initialization step.
        </p>
        ${errorSummary}
        <pre style="margin:0;max-height:60vh;overflow:auto;padding:16px;border-radius:12px;background:#0f172a;color:#e2e8f0;font-size:12px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(diagnosticsText)}</pre>
      </div>
    </div>
  `
}
