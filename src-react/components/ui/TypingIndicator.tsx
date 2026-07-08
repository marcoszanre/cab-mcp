import { cn } from '@/lib/utils'

interface TypingIndicatorProps {
  text?: string
  className?: string
}

/**
 * Lightweight CSS-only bouncing-dots typing indicator.
 * Uses GPU-composited transform + opacity — virtually zero CPU.
 */
export function TypingIndicator({ text, className }: TypingIndicatorProps) {
  return (
    <div className={cn('flex items-center gap-2 p-2 mr-auto', className)}>
      <div className="flex items-center gap-[3px]" aria-label="Agent is typing">
        <span
          className="typing-dot h-[5px] w-[5px] rounded-full bg-muted-foreground/60"
          style={{ animationDelay: '0ms' }}
        />
        <span
          className="typing-dot h-[5px] w-[5px] rounded-full bg-muted-foreground/60"
          style={{ animationDelay: '160ms' }}
        />
        <span
          className="typing-dot h-[5px] w-[5px] rounded-full bg-muted-foreground/60"
          style={{ animationDelay: '320ms' }}
        />
      </div>
      {text && (
        <p className="text-xs text-muted-foreground">{text}</p>
      )}
    </div>
  )
}
