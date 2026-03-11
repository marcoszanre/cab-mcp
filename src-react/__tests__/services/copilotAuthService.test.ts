import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CopilotAuthService } from '@/services/copilotAuthService'

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

type CopilotAuthServiceInternals = {
  isPolling: boolean
  accessToken: string | null
  refreshToken: string | null
  tokenExpiresAt: Date | null
  account: Record<string, unknown> | null
  saveCache: () => void
}

describe('CopilotAuthService', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    mocks.shellOpen.mockReset()
    mocks.httpFetch.mockReset()
    mocks.bodyText.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('cleans up legacy localStorage auth cache during initialization', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const cachedAuth = JSON.stringify({
      accessToken: 'cached-access-token',
      refreshToken: 'cached-refresh-token',
      tokenExpiresAt: expiresAt,
      account: { preferred_username: 'user@example.com' },
    })
    const service = new CopilotAuthService({
      clientId: 'client-id',
      tenantId: 'tenant-id',
      environmentId: 'environment-id',
      botId: 'bot-id',
      botName: 'CAB',
    })

    // No mock needed: auth service uses localStorage directly now
    localStorage.setItem('copilot_auth', cachedAuth)
    localStorage.setItem('copilot-studio-auth-cache', cachedAuth)

    await expect(service.initialize()).resolves.toBe(true)
    expect(localStorage.getItem('copilot_auth')).toBeNull()
    expect(localStorage.getItem('copilot-studio-auth-cache')).toBeNull()
  })

  it('signOut stops polling and clears browser auth caches', () => {
    const service = new CopilotAuthService({
      clientId: 'client-id',
      tenantId: 'tenant-id',
      environmentId: 'environment-id',
      botId: 'bot-id',
      botName: 'CAB',
    })
    const internals = service as unknown as CopilotAuthServiceInternals

    sessionStorage.setItem('copilot_auth', 'session-cache')
    sessionStorage.setItem('copilot-studio-auth-cache', 'session-cache')
    localStorage.setItem('copilot_auth', 'legacy-cache')
    localStorage.setItem('copilot-studio-auth-cache', 'legacy-cache')
    internals.isPolling = true

    service.signOut()

    expect(internals.isPolling).toBe(false)
    expect(sessionStorage.getItem('copilot_auth')).toBeNull()
    expect(sessionStorage.getItem('copilot-studio-auth-cache')).toBeNull()
    expect(localStorage.getItem('copilot_auth')).toBeNull()
    expect(localStorage.getItem('copilot-studio-auth-cache')).toBeNull()
    // Auth cache should be cleared from localStorage
    expect(localStorage.getItem('copilot-auth-cache')).toBeNull()
  })

  it('persists auth cache through localStorage', () => {
    const service = new CopilotAuthService({
      clientId: 'client-id',
      tenantId: 'tenant-id',
      environmentId: 'environment-id',
      botId: 'bot-id',
      botName: 'CAB',
    })
    const internals = service as unknown as CopilotAuthServiceInternals

    internals.accessToken = 'cached-access-token'
    internals.refreshToken = 'cached-refresh-token'
    internals.tokenExpiresAt = new Date(Date.now() + 60_000)
    internals.account = { preferred_username: 'user@example.com' }

    internals.saveCache()

    // Auth cache should be in localStorage under the new key
    const cached = localStorage.getItem('copilot-auth-cache')
    expect(cached).toBeTruthy()
    const parsed = JSON.parse(cached!)
    expect(parsed.accessToken).toBe('cached-access-token')
    // Legacy keys should not be used
    expect(sessionStorage.getItem('copilot_auth')).toBeNull()
    expect(sessionStorage.getItem('copilot-studio-auth-cache')).toBeNull()
    expect(localStorage.getItem('copilot_auth')).toBeNull()
    expect(localStorage.getItem('copilot-studio-auth-cache')).toBeNull()
  })
})
