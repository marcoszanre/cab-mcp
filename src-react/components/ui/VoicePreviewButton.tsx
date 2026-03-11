import { Volume2, Square, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useVoicePreview } from '@/hooks/useVoicePreview'
import { cn } from '@/lib/utils'

interface VoicePreviewButtonProps {
  voiceName: string
  ttsStyle?: string
  speechRate?: number
  className?: string
  /** Compact mode renders a smaller icon-only button (default: false) */
  compact?: boolean
}

export function VoicePreviewButton({
  voiceName,
  ttsStyle,
  speechRate,
  className,
  compact = false,
}: VoicePreviewButtonProps) {
  const { isPreviewing, previewError, handlePreview, stopPreview } = useVoicePreview({
    voiceName,
    ttsStyle,
    speechRate,
  })

  if (isPreviewing) {
    return (
      <span className={cn('inline-flex flex-col items-start', className)}>
        <Button
          type="button"
          variant="outline"
          size={compact ? 'icon' : 'sm'}
          onClick={stopPreview}
          className={cn(
            'text-red-600 hover:text-red-700 hover:bg-red-50 shrink-0',
            compact && 'h-7 w-7'
          )}
          title="Stop preview"
        >
          <Square className={cn(compact ? 'w-3 h-3' : 'w-3 h-3 mr-1.5')} />
          {!compact && 'Stop'}
        </Button>
        {previewError && (
          <span className="text-[10px] text-amber-600 mt-0.5">{previewError}</span>
        )}
      </span>
    )
  }

  return (
    <span className={cn('inline-flex flex-col items-start', className)}>
      <Button
        type="button"
        variant="outline"
        size={compact ? 'icon' : 'sm'}
        onClick={handlePreview}
        className={cn('shrink-0', compact && 'h-7 w-7')}
        title="Preview voice"
      >
        {isPreviewing ? (
          <Loader2 className={cn(compact ? 'w-3 h-3 animate-spin' : 'w-3 h-3 mr-1.5 animate-spin')} />
        ) : (
          <Volume2 className={cn(compact ? 'w-3 h-3' : 'w-3 h-3 mr-1.5')} />
        )}
        {!compact && 'Preview'}
      </Button>
      {previewError && (
        <span className="text-[10px] text-amber-600 mt-0.5">{previewError}</span>
      )}
    </span>
  )
}
