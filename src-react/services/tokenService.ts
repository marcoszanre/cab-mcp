// Token generation service for ACS
// Uses CommunicationIdentityClient to generate user tokens from access key

type CommunicationIdentityModule = typeof import('@azure/communication-identity')

interface TokenCache {
  token: string
  userId: string
  expiresAt: Date
}

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

// ── Per-identity token cache (multi-session and multi-agent support) ──
const identityTokenCache = new Map<string, TokenCache>()
const identityInflightRequests = new Map<string, Promise<{ token: string; userId: string }>>()
let communicationIdentityModulePromise: Promise<CommunicationIdentityModule> | null = null

async function getCommunicationIdentityModule(): Promise<CommunicationIdentityModule> {
  communicationIdentityModulePromise ??= import('@azure/communication-identity')
  return communicationIdentityModulePromise
}

async function createIdentityClient(endpoint: string, accessKey: string) {
  const { CommunicationIdentityClient } = await getCommunicationIdentityModule()
  const connectionString = `endpoint=${endpoint};accesskey=${accessKey}`
  return new CommunicationIdentityClient(connectionString)
}

function isTokenFresh(entry: TokenCache | undefined): boolean {
  return Boolean(entry && entry.expiresAt > new Date(Date.now() + TOKEN_REFRESH_BUFFER_MS))
}

/**
 * Create a brand-new ACS identity + token without using any cache.
 * Used for validation or other one-off checks where isolation is preferred over reuse.
 */
export async function createFreshToken(endpoint: string, accessKey: string): Promise<{ token: string; userId: string }> {
  if (!endpoint || !accessKey) {
    throw new Error('ACS endpoint and access key are required')
  }

  try {
    const identityClient = await createIdentityClient(endpoint, accessKey)
    const user = await identityClient.createUser()
    const tokenResponse = await identityClient.getToken(user, ['voip', 'chat'])

    console.log(`ACS fresh token created (userId: ${user.communicationUserId.slice(0, 16)}...)`)

    return {
      token: tokenResponse.token,
      userId: user.communicationUserId,
    }
  } catch (error) {
    console.error('Error generating fresh ACS token:', error)
    throw new Error(`Failed to generate fresh token: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Generate or retrieve a cached ACS token scoped to a specific identity key.
 * The identity key should uniquely represent the runtime owner of the ACS identity
 * (for example, an agent instance ID rather than a shared session ID).
 */
export async function getOrCreateTokenForIdentity(
  endpoint: string,
  accessKey: string,
  identityKey: string
): Promise<{ token: string; userId: string }> {
  const cached = identityTokenCache.get(identityKey)
  if (cached && isTokenFresh(cached)) {
    return { token: cached.token, userId: cached.userId }
  }

  // If another call for this identity is in-flight, await it.
  const inflight = identityInflightRequests.get(identityKey)
  if (inflight) return inflight

  if (!endpoint || !accessKey) {
    throw new Error('ACS endpoint and access key are required')
  }

  const request = (async () => {
    try {
      const identityClient = await createIdentityClient(endpoint, accessKey)

      let userId: string
      if (cached?.userId) {
        userId = cached.userId
        const tokenResponse = await identityClient.getToken(
          { communicationUserId: userId },
          ['voip', 'chat']
        )
        identityTokenCache.set(identityKey, {
          token: tokenResponse.token,
          userId,
          expiresAt: tokenResponse.expiresOn,
        })
      } else {
        const user = await identityClient.createUser()
        const tokenResponse = await identityClient.getToken(user, ['voip', 'chat'])
        userId = user.communicationUserId
        identityTokenCache.set(identityKey, {
          token: tokenResponse.token,
          userId,
          expiresAt: tokenResponse.expiresOn,
        })
      }

      const entry = identityTokenCache.get(identityKey)!
      console.log(`ACS token ready for identity ${identityKey.slice(0, 8)} (scopes: voip, chat)`)
      return { token: entry.token, userId: entry.userId }
    } catch (error) {
      console.error(`Error generating ACS token for identity ${identityKey.slice(0, 8)}:`, error)
      throw new Error(`Failed to generate token: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      identityInflightRequests.delete(identityKey)
    }
  })()

  identityInflightRequests.set(identityKey, request)
  return request
}

/**
 * Backward-compatible alias. The third parameter is treated as an identity cache key.
 */
export async function getOrCreateTokenForSession(
  endpoint: string,
  accessKey: string,
  sessionId: string
): Promise<{ token: string; userId: string }> {
  return getOrCreateTokenForIdentity(endpoint, accessKey, sessionId)
}

/**
 * Backward-compatible alias kept for existing call sites.
 */
export async function getOrCreateToken(endpoint: string, accessKey: string): Promise<{ token: string; userId: string }> {
  return createFreshToken(endpoint, accessKey)
}

/**
 * Clear cached token for a specific identity key.
 */
export function clearTokenCacheForIdentity(identityKey: string): void {
  identityTokenCache.delete(identityKey)
  identityInflightRequests.delete(identityKey)
  console.log(`ACS token cache cleared for identity ${identityKey.slice(0, 8)}`)
}

/**
 * Backward-compatible alias kept for existing call sites.
 */
export function clearTokenCacheForSession(sessionId: string): void {
  clearTokenCacheForIdentity(sessionId)
}

/**
 * Clear all session token caches
 */
export function clearAllTokenCaches(): void {
  identityTokenCache.clear()
  identityInflightRequests.clear()
  console.log('All ACS token caches cleared')
}
