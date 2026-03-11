import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CopilotStudioAgentProvider } from '@/services/copilotStudioAgentProvider'

const mocks = vi.hoisted(() => ({
  shellOpen: vi.fn(),
  httpFetch: vi.fn(),
  bodyText: vi.fn((value: string) => value),
}))

vi.mock('@tauri-apps/api', () => ({
  shell: {
    open: mocks.shellOpen,
  },
  http: {
    fetch: mocks.httpFetch,
    Body: {
      text: mocks.bodyText,
    },
  },
}))

vi.mock('@microsoft/agents-copilotstudio-client', () => ({
  ConnectionSettings: class ConnectionSettings {},
  CopilotStudioClient: class CopilotStudioClient {},
}))

type CopilotStudioAgentProviderInternals = {
  accessToken: string | null
  refreshToken: string | null
  tokenExpiresAt: Date | null
  account: Record<string, unknown> | null
  cacheAuth: () => Promise<void>
  loadCachedAuth: () => Promise<void>
}

describe('CopilotStudioAgentProvider auth cache', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('persists auth cache through localStorage', async () => {
    const provider = new CopilotStudioAgentProvider()
    const internals = provider as unknown as CopilotStudioAgentProviderInternals

    internals.accessToken = 'cached-access-token'
    internals.refreshToken = 'cached-refresh-token'
    internals.tokenExpiresAt = new Date(Date.now() + 10 * 60_000)
    internals.account = { preferred_username: 'user@example.com' }

    await internals.cacheAuth()

    const cached = localStorage.getItem('copilot-auth-cache')
    expect(cached).toBeTruthy()
    const parsed = JSON.parse(cached!)
    expect(parsed.accessToken).toBe('cached-access-token')
    // Legacy keys should not be used
    expect(sessionStorage.getItem('copilot-studio-auth-cache')).toBeNull()
  })

  it('loads and clears legacy browser auth cache', async () => {
    const provider = new CopilotStudioAgentProvider()
    const internals = provider as unknown as CopilotStudioAgentProviderInternals
    const cachedAuth = JSON.stringify({
      accessToken: 'cached-access-token',
      refreshToken: 'cached-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      account: { preferred_username: 'user@example.com' },
    })

    sessionStorage.setItem('copilot-studio-auth-cache', cachedAuth)
    localStorage.setItem('copilot-studio-auth-cache', cachedAuth)

    await internals.loadCachedAuth()

    expect(internals.accessToken).toBe('cached-access-token')
    expect(sessionStorage.getItem('copilot-studio-auth-cache')).toBeNull()
    expect(localStorage.getItem('copilot-studio-auth-cache')).toBeNull()
  })
})
