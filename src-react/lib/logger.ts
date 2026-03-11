// ============================================
// Logger Utility
// Centralized logging with environment-aware output
// Ring buffer for production debugging
// ============================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  context?: string
  data?: unknown[]
}

interface LoggerConfig {
  /** Minimum log level to output */
  minLevel: LogLevel
  /** Prefix for all log messages */
  prefix?: string
  /** Whether to include timestamps */
  timestamps?: boolean
  /** Ring buffer size for retained logs (even below minLevel) */
  ringBufferSize?: number
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const LOG_COLORS: Record<LogLevel, string> = {
  debug: '#9CA3AF', // gray
  info: '#3B82F6',  // blue
  warn: '#F59E0B',  // amber
  error: '#EF4444', // red
}

const LOG_ICONS: Record<LogLevel, string> = {
  debug: '🔍',
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
}

class Logger {
  private config: LoggerConfig
  private isDev: boolean
  /** Ring buffer retains recent logs for post-mortem debugging even in production */
  private ringBuffer: LogEntry[] = []
  private ringBufferSize: number

  constructor(config: Partial<LoggerConfig> = {}) {
    this.isDev = import.meta.env.DEV
    this.ringBufferSize = config.ringBufferSize ?? 500
    this.config = {
      minLevel: this.isDev ? 'debug' : 'warn',
      timestamps: this.isDev,
      ...config,
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.minLevel]
  }

  /**
   * Whether this entry should be retained in the ring buffer
   * (info and above, regardless of minLevel)
   */
  private shouldRetain(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS['info']
  }

  private formatMessage(_level: LogLevel, message: string, context?: string): string[] {
    const parts: string[] = []
    
    if (this.config.timestamps) {
      parts.push(`[${new Date().toISOString().split('T')[1].slice(0, -1)}]`)
    }
    
    if (this.config.prefix) {
      parts.push(`[${this.config.prefix}]`)
    }
    
    if (context) {
      parts.push(`[${context}]`)
    }
    
    parts.push(message)
    
    return [parts.join(' ')]
  }

  private log(level: LogLevel, message: string, context?: string, ...args: unknown[]): void {
    // Always retain in ring buffer for post-mortem analysis (info level and above)
    if (this.shouldRetain(level)) {
      this.ringBuffer.push({
        timestamp: new Date().toISOString(),
        level,
        message,
        context,
        data: args.length > 0 ? args : undefined
      })
      // Trim ring buffer to size
      if (this.ringBuffer.length > this.ringBufferSize) {
        this.ringBuffer = this.ringBuffer.slice(-this.ringBufferSize)
      }
    }

    if (!this.shouldLog(level)) return

    const formattedMessage = this.formatMessage(level, message, context)
    const icon = LOG_ICONS[level]
    const color = LOG_COLORS[level]

    if (this.isDev) {
      const style = `color: ${color}; font-weight: bold;`
      // eslint-disable-next-line no-console
      console[level === 'debug' ? 'log' : level](
        `%c${icon} ${formattedMessage[0]}`,
        style,
        ...args
      )
    } else {
      // In production, only warn and error, no styling
      if (level === 'warn') {
        console.warn(formattedMessage[0], ...args)
      } else if (level === 'error') {
        console.error(formattedMessage[0], ...args)
      }
    }
  }

  debug(message: string, context?: string, ...args: unknown[]): void {
    this.log('debug', message, context, ...args)
  }

  info(message: string, context?: string, ...args: unknown[]): void {
    this.log('info', message, context, ...args)
  }

  warn(message: string, context?: string, ...args: unknown[]): void {
    this.log('warn', message, context, ...args)
  }

  error(message: string, context?: string, ...args: unknown[]): void {
    this.log('error', message, context, ...args)
  }

  /** Create a child logger with a specific context */
  child(context: string): ContextLogger {
    return new ContextLogger(this, context)
  }

  /** Set the minimum log level */
  setLevel(level: LogLevel): void {
    this.config.minLevel = level
  }

  /**
   * Dump the ring buffer contents for post-mortem debugging.
   * Useful for crash reporting or manual inspection via DevTools console.
   */
  dumpLogs(): LogEntry[] {
    return [...this.ringBuffer]
  }

  /**
   * Get formatted ring buffer as a string (for copy/paste or file export)
   */
  dumpLogsFormatted(): string {
    return this.ringBuffer
      .map(e => `[${e.timestamp}] [${e.level.toUpperCase()}]${e.context ? ` [${e.context}]` : ''} ${e.message}${e.data ? ' ' + JSON.stringify(e.data) : ''}`)
      .join('\n')
  }

  /**
   * Clear the ring buffer
   */
  clearRingBuffer(): void {
    this.ringBuffer = []
  }
}

class ContextLogger {
  constructor(
    private parent: Logger,
    private context: string
  ) {}

  debug(message: string, ...args: unknown[]): void {
    this.parent.debug(message, this.context, ...args)
  }

  info(message: string, ...args: unknown[]): void {
    this.parent.info(message, this.context, ...args)
  }

  warn(message: string, ...args: unknown[]): void {
    this.parent.warn(message, this.context, ...args)
  }

  error(message: string, ...args: unknown[]): void {
    this.parent.error(message, this.context, ...args)
  }
}

// Global logger instance
export const logger = new Logger({ prefix: 'CAB' })

// Expose dumpLogs globally for debugging from DevTools console
// Usage: window.__dumpLogs() or window.__dumpLogsFormatted()
const _win = window as unknown as { __dumpLogs?: () => LogEntry[]; __dumpLogsFormatted?: () => string }
_win.__dumpLogs = logger.dumpLogs.bind(logger)
_win.__dumpLogsFormatted = logger.dumpLogsFormatted.bind(logger)

// Pre-configured loggers for different modules
export const loggers = {
  app: logger.child('App'),
  acs: logger.child('ACS'),
  copilot: logger.child('Copilot'),
  speech: logger.child('Speech'),
  providers: logger.child('Providers'),
  store: logger.child('Store'),
  behavior: logger.child('Behavior'),
}

export type { LogLevel, LoggerConfig }
export { Logger, ContextLogger }
