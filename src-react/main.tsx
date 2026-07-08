import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import {
  attachStartupErrorHandlers,
  recordStartupError,
  recordStartupPhase,
  renderStartupFallback,
} from '@/lib/startupDiagnostics'

async function bootstrap(): Promise<void> {
  attachStartupErrorHandlers()
  recordStartupPhase('bootstrap-started')

  const rootElement = document.getElementById('root')
  if (!rootElement) {
    throw new Error('Root element "#root" was not found')
  }

  try {
    recordStartupPhase('bootstrap-loading-modules')
    const [{ default: App }, { ErrorBoundary }] = await Promise.all([
      import('./App'),
      import('@/components/error'),
    ])

    recordStartupPhase('bootstrap-rendering-root')
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    )
  } catch (error) {
    recordStartupError('bootstrap', error)
    renderStartupFallback(rootElement, 'Community Agent Bridge could not start', error)
  }
}

void bootstrap().catch((error) => {
  recordStartupError('bootstrap-unhandled', error)

  const rootElement = document.getElementById('root')
  if (rootElement) {
    renderStartupFallback(rootElement, 'Community Agent Bridge could not start', error)
  }
})
