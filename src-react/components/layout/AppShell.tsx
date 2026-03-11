import { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { ErrorBoundary } from '@/components/error/ErrorBoundary'

interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-gradient-to-br from-slate-50 via-white to-slate-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      <Sidebar />
      <div className="relative flex flex-1 min-w-0 px-5 py-4 overflow-hidden">
        <div className="flex flex-col flex-1 overflow-hidden rounded-3xl border border-border/60 bg-card/90 shadow-[0_18px_70px_rgba(0,0,0,0.12)] backdrop-blur-xl">
          <main className="flex-1 min-h-0 overflow-hidden px-4 pb-4">
            <ErrorBoundary>
              {children}
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </div>
  )
}
