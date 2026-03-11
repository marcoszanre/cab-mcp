import { useEffect, useState, type ReactNode } from 'react'
import { Minus, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'

type DesktopWindow = {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  isMaximized: () => Promise<boolean>
  close: () => Promise<void>
}

interface ControlButtonProps {
  children: ReactNode
  label: string
  intent?: 'default' | 'danger'
  onClick: () => void
}

function ControlButton({ children, label, intent = 'default', onClick }: ControlButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-xl text-sm transition-colors',
        intent === 'danger'
          ? 'hover:bg-destructive/15 hover:text-destructive'
          : 'hover:bg-slate-100/80 dark:hover:bg-slate-800/80'
      )}
    >
      {children}
    </button>
  )
}

export function WindowControls() {
  const [appWindow, setAppWindow] = useState<DesktopWindow | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    let mounted = true

    import('@tauri-apps/api/window')
      .then(({ appWindow }) => {
        if (!mounted) return
        setAppWindow(appWindow)
        appWindow.isMaximized().then((max) => {
          if (mounted) setIsMaximized(max)
        }).catch(() => {})
      })
      .catch(() => {
        // Not running in the desktop shell, so hide window chrome.
      })

    return () => {
      mounted = false
    }
  }, [])

  if (!appWindow) {
    return null
  }

  const handleMinimize = async () => {
    try {
      await appWindow.minimize()
    } catch (err) {
      console.error('[WindowControls] Failed to minimize window', err)
    }
  }

  const handleToggleMaximize = async () => {
    try {
      await appWindow.toggleMaximize()
      const maximized = await appWindow.isMaximized()
      setIsMaximized(maximized)
    } catch (err) {
      console.error('[WindowControls] Failed to toggle maximize', err)
    }
  }

  const handleClose = async () => {
    try {
      await appWindow.close()
    } catch (err) {
      console.error('[WindowControls] Failed to close window', err)
    }
  }

  return (
    <div className="flex items-center gap-1 rounded-full border border-slate-200/90 bg-white/95 px-2 py-1 shadow-[0_12px_30px_rgba(0,0,0,0.08)] backdrop-blur-md dark:border-slate-800/80 dark:bg-slate-900/95">
      <ControlButton onClick={handleMinimize} label="Minimize">
        <Minus className="h-3.5 w-3.5" />
      </ControlButton>
      <ControlButton onClick={handleToggleMaximize} label={isMaximized ? 'Restore' : 'Maximize'}>
        <Square className="h-3.5 w-3.5" />
      </ControlButton>
      <ControlButton onClick={handleClose} label="Close" intent="danger">
        <X className="h-3.5 w-3.5" />
      </ControlButton>
    </div>
  )
}
