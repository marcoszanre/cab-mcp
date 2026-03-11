import { cn } from '@/lib/utils'
import { useNavigationStore, type PageType } from '@/stores/navigationStore'
import { useActiveSessionCount } from '@/hooks/useSessionState'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'
import { 
  Bot, 
  Settings,
  PanelLeftClose,
  PanelLeft,
  Activity
} from 'lucide-react'

interface NavItem {
  id: PageType
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { id: 'sessions', label: 'Sessions', icon: Activity },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'settings', label: 'Settings', icon: Settings },
]

const pagePreloaders: Partial<Record<PageType, () => Promise<unknown>>> = {
  agents: () => import('@/components/pages/AgentsPage'),
  settings: () => import('@/components/pages/SettingsPage'),
}

const prefetchedPages = new Set<PageType>()

function prefetchPage(page: PageType) {
  const preload = pagePreloaders[page]
  if (!preload || prefetchedPages.has(page)) {
    return
  }

  prefetchedPages.add(page)
  void preload()
}

export function Sidebar() {
  const currentPage = useNavigationStore((state) => state.currentPage)
  const isSidebarCollapsed = useNavigationStore((state) => state.isSidebarCollapsed)
  const setCurrentPage = useNavigationStore((state) => state.setCurrentPage)
  const toggleSidebar = useNavigationStore((state) => state.toggleSidebar)
  const activeSessionCount = useActiveSessionCount()

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          'relative flex h-screen flex-col border-r border-border/40 bg-gradient-to-b from-primary/10 via-card to-card shadow-[4px_0_24px_rgba(0,0,0,0.06)] transition-all duration-300 ease-in-out sticky top-0 overflow-hidden',
          isSidebarCollapsed ? 'w-[68px]' : 'w-64'
        )}
      >
        {/* Logo Header */}
        <div
          className={cn(
            'flex h-16 items-center border-b border-border/40 backdrop-blur-sm',
            isSidebarCollapsed ? 'justify-center px-3' : 'px-4 gap-3'
          )}
        >
          <div className={cn(
            'flex items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-yellow-500 shadow-lg flex-shrink-0 transition-all duration-300 ring-2 ring-black/20 dark:ring-black/40',
            isSidebarCollapsed ? 'h-10 w-10' : 'h-10 w-10'
          )}>
            <span className="text-xs font-bold tracking-tight text-gray-900">CAB</span>
          </div>
          {!isSidebarCollapsed && (
            <div className="leading-tight min-w-0">
              <div className="text-base text-amber-500 dark:text-amber-400" style={{ fontFamily: "'Dancing Script', cursive", fontWeight: 600 }}>Community</div>
              <div className="text-[11px] font-bold text-foreground italic tracking-wider uppercase">Agent Bridge</div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className={cn(
          'flex-1 py-4 space-y-1.5 overflow-y-auto',
          isSidebarCollapsed ? 'px-2' : 'px-3'
        )}>
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = currentPage === item.id

            const buttonContent = (
              <Button
                variant="ghost"
                className={cn(
                  'relative w-full rounded-xl border border-transparent text-left transition-all duration-200',
                  isSidebarCollapsed 
                    ? 'h-11 w-11 p-0 justify-center mx-auto' 
                    : 'px-3 py-2.5 gap-3 justify-start',
                  isActive
                    ? 'bg-primary/15 text-primary shadow-sm border-primary/20 dark:bg-primary/20 dark:border-primary/30'
                    : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground dark:hover:bg-primary/15'
                )}
                onClick={() => setCurrentPage(item.id)}
                onMouseEnter={() => prefetchPage(item.id)}
                onFocus={() => prefetchPage(item.id)}
              >
                {isActive && !isSidebarCollapsed && (
                  <span className="absolute inset-y-2 left-1.5 w-0.5 rounded-full bg-primary" />
                )}
                {isActive && isSidebarCollapsed && (
                  <span className="absolute inset-y-2 left-1 w-0.5 rounded-full bg-primary" />
                )}
                <Icon className={cn(
                  'flex-shrink-0 transition-colors',
                  isSidebarCollapsed ? 'w-5 h-5' : 'w-5 h-5',
                  isActive && 'text-primary'
                )} />
                {!isSidebarCollapsed && (
                  <span className="truncate font-medium flex-1">{item.label}</span>
                )}
                {!isSidebarCollapsed && item.id === 'sessions' && activeSessionCount > 0 && (
                  <Badge variant="default" className="h-5 min-w-5 px-1.5 text-[10px] font-bold">
                    {activeSessionCount}
                  </Badge>
                )}
                {isSidebarCollapsed && item.id === 'sessions' && activeSessionCount > 0 && (
                  <span className="absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full bg-primary text-[9px] font-bold text-primary-foreground flex items-center justify-center">
                    {activeSessionCount}
                  </span>
                )}
              </Button>
            )

            if (isSidebarCollapsed) {
              return (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>
                    {buttonContent}
                  </TooltipTrigger>
                  <TooltipContent side="right" className="font-medium">
                    {item.label}
                  </TooltipContent>
                </Tooltip>
              )
            }

            return <div key={item.id}>{buttonContent}</div>
          })}
        </nav>

        {/* Footer with collapse button */}
        <div className={cn(
          'border-t border-border/40 py-3',
          isSidebarCollapsed ? 'px-2' : 'px-3'
        )}>
          {isSidebarCollapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-11 w-11 p-0 mx-auto flex justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-primary/10 dark:hover:bg-primary/15"
                  onClick={toggleSidebar}
                >
                  <PanelLeft className="w-5 h-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className="font-medium">
                Expand sidebar
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-3 rounded-xl border border-transparent text-muted-foreground hover:text-foreground hover:bg-primary/10 dark:hover:bg-primary/15"
              onClick={toggleSidebar}
            >
              <PanelLeftClose className="w-5 h-5" />
              <span className="text-sm font-medium">Collapse</span>
            </Button>
          )}
        </div>
      </aside>
    </TooltipProvider>
  )
}
