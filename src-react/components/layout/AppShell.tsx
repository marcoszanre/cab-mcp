import { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { ErrorBoundary } from '@/components/error/ErrorBoundary'

interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </main>
    </div>
  )
}
