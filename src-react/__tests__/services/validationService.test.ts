import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  bodyText: vi.fn((value: string) => value),
  createFreshToken: vi.fn(),
}))

vi.mock('@tauri-apps/api/http', () => ({
  fetch: mocks.fetch,
  ResponseType: { JSON: 'json' },
  Body: {
    text: mocks.bodyText,
  },
}))

vi.mock('@/services/tokenService', () => ({
  createFreshToken: mocks.createFreshToken,
}))

import { validateAzureFoundryConfig } from '@/services/validationService'

describe('validateAzureFoundryConfig', () => {
  afterEach(() => {
    mocks.fetch.mockReset()
    mocks.bodyText.mockClear()
    mocks.createFreshToken.mockReset()
    vi.restoreAllMocks()
  })

  it('redacts client secrets from Azure Foundry auth failures', async () => {
    const clientSecret = 'super-secret-value'
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    mocks.fetch.mockRejectedValue(
      new Error(`request failed: client_secret=${clientSecret}&tenant=test&secret=${clientSecret}`)
    )

    const result = await validateAzureFoundryConfig(
      'https://example.services.ai.azure.com/api/projects/demo',
      'demo-agent',
      '12345678-1234-1234-1234-123456789abc',
      '87654321-4321-4321-4321-cba987654321',
      clientSecret,
      'eastus'
    )

    expect(result.isValid).toBe(false)
    expect(result.details).toContain('client_secret=[REDACTED]')
    expect(result.details).not.toContain(clientSecret)
    expect(consoleErrorSpy.mock.calls.flat().join(' ')).not.toContain(clientSecret)
  })
})
