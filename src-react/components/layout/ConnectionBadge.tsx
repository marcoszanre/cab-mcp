import { useActiveSessionCount } from '@/hooks/useSessionState'
import { Badge } from '@/components/ui/badge'

export function ConnectionBadge() {
  const activeSessionCount = useActiveSessionCount()

  if (activeSessionCount > 0) {
    return (
      <Badge variant="success" className="gap-1.5">
        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
        {activeSessionCount} active session{activeSessionCount !== 1 ? 's' : ''}
      </Badge>
    )
  }

  return (
    <Badge variant="secondary" className="gap-1.5">
      <span className="w-2 h-2 rounded-full bg-gray-400" />
      Idle
    </Badge>
  )
}
