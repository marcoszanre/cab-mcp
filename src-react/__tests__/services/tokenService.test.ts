import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createUserMock,
  getTokenMock,
  clientCtorMock,
  MockCommunicationIdentityClient,
} = vi.hoisted(() => {
  const createUserMock = vi.fn()
  const getTokenMock = vi.fn()
  const clientCtorMock = vi.fn()

  class MockCommunicationIdentityClient {
    public createUser = createUserMock
    public getToken = getTokenMock

    constructor(connectionString: string) {
      clientCtorMock(connectionString)
    }
  }

  return {
    createUserMock,
    getTokenMock,
    clientCtorMock,
    MockCommunicationIdentityClient,
  }
})

vi.mock('@azure/communication-identity', () => ({
  CommunicationIdentityClient: MockCommunicationIdentityClient,
}))

import {
  clearAllTokenCaches,
  clearTokenCacheForIdentity,
  createFreshToken,
  getOrCreateTokenForIdentity,
} from '@/services/tokenService'

describe('tokenService', () => {
  beforeEach(() => {
    clearAllTokenCaches()
    createUserMock.mockReset()
    getTokenMock.mockReset()
    clientCtorMock.mockClear()
  })

  it('reuses cached tokens for the same identity key while they are fresh', async () => {
    createUserMock.mockResolvedValue({ communicationUserId: 'user-1' })
    getTokenMock.mockResolvedValue({
      token: 'token-1',
      expiresOn: new Date(Date.now() + 30 * 60 * 1000),
    })

    const first = await getOrCreateTokenForIdentity('https://example.communication.azure.com', 'key', 'agent-1')
    const second = await getOrCreateTokenForIdentity('https://example.communication.azure.com', 'key', 'agent-1')

    expect(first).toEqual({ token: 'token-1', userId: 'user-1' })
    expect(second).toEqual(first)
    expect(createUserMock).toHaveBeenCalledTimes(1)
    expect(getTokenMock).toHaveBeenCalledTimes(1)
  })

  it('keeps identities isolated across different cache keys', async () => {
    createUserMock
      .mockResolvedValueOnce({ communicationUserId: 'user-1' })
      .mockResolvedValueOnce({ communicationUserId: 'user-2' })
    getTokenMock
      .mockResolvedValueOnce({
        token: 'token-1',
        expiresOn: new Date(Date.now() + 30 * 60 * 1000),
      })
      .mockResolvedValueOnce({
        token: 'token-2',
        expiresOn: new Date(Date.now() + 30 * 60 * 1000),
      })

    const first = await getOrCreateTokenForIdentity('https://example.communication.azure.com', 'key', 'agent-1')
    const second = await getOrCreateTokenForIdentity('https://example.communication.azure.com', 'key', 'agent-2')

    expect(first).toEqual({ token: 'token-1', userId: 'user-1' })
    expect(second).toEqual({ token: 'token-2', userId: 'user-2' })
    expect(createUserMock).toHaveBeenCalledTimes(2)
  })

  it('clears a cached identity token when requested', async () => {
    createUserMock
      .mockResolvedValueOnce({ communicationUserId: 'user-1' })
      .mockResolvedValueOnce({ communicationUserId: 'user-1b' })
    getTokenMock
      .mockResolvedValueOnce({
        token: 'token-1',
        expiresOn: new Date(Date.now() + 30 * 60 * 1000),
      })
      .mockResolvedValueOnce({
        token: 'token-2',
        expiresOn: new Date(Date.now() + 30 * 60 * 1000),
      })

    await getOrCreateTokenForIdentity('https://example.communication.azure.com', 'key', 'agent-1')
    clearTokenCacheForIdentity('agent-1')
    const refreshed = await getOrCreateTokenForIdentity('https://example.communication.azure.com', 'key', 'agent-1')

    expect(refreshed).toEqual({ token: 'token-2', userId: 'user-1b' })
    expect(createUserMock).toHaveBeenCalledTimes(2)
  })

  it('always creates a fresh identity for validation requests', async () => {
    createUserMock
      .mockResolvedValueOnce({ communicationUserId: 'fresh-1' })
      .mockResolvedValueOnce({ communicationUserId: 'fresh-2' })
    getTokenMock
      .mockResolvedValueOnce({
        token: 'token-1',
        expiresOn: new Date(Date.now() + 30 * 60 * 1000),
      })
      .mockResolvedValueOnce({
        token: 'token-2',
        expiresOn: new Date(Date.now() + 30 * 60 * 1000),
      })

    const first = await createFreshToken('https://example.communication.azure.com', 'key')
    const second = await createFreshToken('https://example.communication.azure.com', 'key')

    expect(first).toEqual({ token: 'token-1', userId: 'fresh-1' })
    expect(second).toEqual({ token: 'token-2', userId: 'fresh-2' })
    expect(createUserMock).toHaveBeenCalledTimes(2)
  })
})
