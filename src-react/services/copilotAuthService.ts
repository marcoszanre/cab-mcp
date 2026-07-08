// Copilot Studio Authentication Service
// Uses Tauri HTTP API for CORS-free requests (desktop app, not browser!)
// Implements Device Code Flow for OAuth2 authentication

import type { DeviceCodeInfo, CopilotStudioConfig } from '@/types'
import { loggers } from '@/lib/logger'
import { secureGet, secureSet, secureDelete } from '@/lib/secureStore'
import * as shell from "@tauri-apps/plugin-shell"
import { nativeHttpJson } from '@/lib/nativeHttp'
const COPILOT_AUTH_CACHE_KEY = 'copilot-auth-cache'

async function storeCopilotAuthCache(serialized: string): Promise<void> {
  await secureSet(COPILOT_AUTH_CACHE_KEY, serialized)
}

async function getCopilotAuthCache(): Promise<string | null> {
  return secureGet(COPILOT_AUTH_CACHE_KEY)
}

async function deleteCopilotAuthCache(): Promise<void> {
  await secureDelete(COPILOT_AUTH_CACHE_KEY)
}

// Response types from Azure AD
interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
  message: string
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope: string
}

interface TokenErrorResponse {
  error: string
  error_description?: string
}

interface JwtPayload {
  preferred_username?: string
  upn?: string
  email?: string
  name?: string
  tid?: string
  [key: string]: unknown
}

interface CachedAuth {
  accessToken: string
  refreshToken: string | null
  tokenExpiresAt: string
  account: JwtPayload | null
}

function getLegacyCopilotBrowserCache(): string | null {
  try {
    return (
      sessionStorage.getItem('copilot-studio-auth-cache') ||
      localStorage.getItem('copilot-studio-auth-cache') ||
      sessionStorage.getItem('copilot_auth') ||
      localStorage.getItem('copilot_auth')
    )
  } catch {
    return null
  }
}

function clearLegacyCopilotBrowserCache(): boolean {
  let removed = false

  try {
    removed =
      sessionStorage.getItem('copilot_auth') !== null ||
      sessionStorage.getItem('copilot-studio-auth-cache') !== null ||
      removed
    sessionStorage.removeItem('copilot_auth')
    sessionStorage.removeItem('copilot-studio-auth-cache')
  } catch {
    // ignore session storage cleanup issues
  }

  try {
    removed =
      localStorage.getItem('copilot_auth') !== null ||
      localStorage.getItem('copilot-studio-auth-cache') !== null ||
      removed
    localStorage.removeItem('copilot_auth')
    localStorage.removeItem('copilot-studio-auth-cache')
  } catch {
    // ignore local storage cleanup issues
  }

  return removed
}

/**
 * Tauri HTTP POST helper - bypasses CORS because we're a desktop app!
 */
async function tauriHttpPost(url: string, bodyString: string): Promise<{ ok: boolean; data: unknown }> {
  try {
    const { ok, data } = await nativeHttpJson({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: bodyString
    })
    return { ok, data }
  } catch (error) {
    loggers.copilot.error('Tauri HTTP error:', error)
    throw error
  }
}

/**
 * CopilotAuthService - Device Code Flow authentication for Copilot Studio
 * Designed for Tauri desktop apps
 */
export class CopilotAuthService {
  private config: CopilotStudioConfig
  private accessToken: string | null = null
  private refreshToken: string | null = null
  private tokenExpiresAt: Date | null = null
  private account: JwtPayload | null = null
  
  // OAuth endpoints
  private authority: string
  private tokenEndpoint: string
  private deviceCodeEndpoint: string
  private scopes = 'https://api.powerplatform.com/.default offline_access'
  
  // Polling state
  private isPolling = false
  
  // Token refresh lock to prevent concurrent refreshes from invalidating each other
  private refreshInProgress: Promise<string> | null = null
  
  // Callbacks for UI updates
  public onDeviceCodeReceived: ((code: DeviceCodeInfo) => void) | null = null
  public onAuthStatusChanged: ((authenticated: boolean) => void) | null = null

  constructor(config: CopilotStudioConfig) {
    this.config = config
    this.authority = `https://login.microsoftonline.com/${config.tenantId}`
    this.tokenEndpoint = `${this.authority}/oauth2/v2.0/token`
    this.deviceCodeEndpoint = `${this.authority}/oauth2/v2.0/devicecode`
  }

  /**
   * Initialize - check for cached tokens
   * Checks both cache keys for compatibility with CopilotStudioAgentProvider
   */
  async initialize(): Promise<boolean> {
    loggers.copilot.debug('Initializing Copilot Studio authentication (Device Code Flow)...')

    const legacyBrowserCache = getLegacyCopilotBrowserCache()
    const clearedLegacyCache = clearLegacyCopilotBrowserCache()
    if (clearedLegacyCache) {
      loggers.copilot.debug('Cleaned up legacy plaintext auth tokens from browser storage')
    }
    
    // Check secure storage first, then one-time migration fallbacks.
    let cached: string | null = null
    try {
      cached = await getCopilotAuthCache()
    } catch {
      // fallback handled below
    }

    if (!cached) {
      cached = legacyBrowserCache
    }
    
    if (cached) {
      try {
        const authData: CachedAuth = JSON.parse(cached)
        this.accessToken = authData.accessToken
        this.refreshToken = authData.refreshToken
        this.tokenExpiresAt = new Date(authData.tokenExpiresAt)
        this.account = authData.account
        
        // Check if token is still valid
        if (this.tokenExpiresAt > new Date()) {
          loggers.copilot.debug('Found valid cached token for:', this.account?.preferred_username)
          this.onAuthStatusChanged?.(true)
          return true
        } else if (this.refreshToken) {
          // Try to refresh
          loggers.copilot.debug('Token expired, attempting refresh...')
          try {
            await this.refreshAccessToken()
            return true
          } catch {
            loggers.copilot.debug('Token refresh failed, need new sign-in')
            this.clearCache()
          }
        }
      } catch (e) {
        loggers.copilot.error('Failed to parse cached auth:', e)
        this.clearCache()
      }
    }
    
    loggers.copilot.debug('Copilot Studio auth initialized, ready for sign-in')
    return false
  }

  /**
   * Sign in using Device Code Flow
   * Opens system browser for user to authenticate
   */
  async signIn(): Promise<{ success: boolean; account: JwtPayload | null }> {
    loggers.copilot.debug('Starting Device Code Flow sign-in...')
    
    // Step 1: Request device code
    const bodyString = `client_id=${this.config.clientId}&scope=${encodeURIComponent(this.scopes)}`
    const deviceCodeResponse = await tauriHttpPost(this.deviceCodeEndpoint, bodyString)

    if (!deviceCodeResponse.ok) {
      throw new Error(`Failed to get device code: ${JSON.stringify(deviceCodeResponse.data)}`)
    }

    const deviceCode = deviceCodeResponse.data as DeviceCodeResponse
    
    loggers.copilot.debug('Device code received:', deviceCode.user_code)
    loggers.copilot.debug('Verification URL:', deviceCode.verification_uri)
    
    // Notify UI to show the code
    this.onDeviceCodeReceived?.({
      userCode: deviceCode.user_code,
      verificationUri: deviceCode.verification_uri,
      verificationUriComplete: deviceCode.verification_uri_complete,
      expiresIn: deviceCode.expires_in,
      message: deviceCode.message
    })

    // Open system browser (Tauri shell API)
    try {
      await shell.open(deviceCode.verification_uri_complete || deviceCode.verification_uri)
      loggers.copilot.debug('Opened system browser for authentication')
    } catch (e) {
      loggers.copilot.debug('Could not auto-open browser:', e)
    }

    // Step 2: Poll for token
    const tokenResponse = await this.pollForToken(deviceCode)
    
    // Step 3: Store tokens
    this.accessToken = tokenResponse.access_token
    this.refreshToken = tokenResponse.refresh_token || null
    this.tokenExpiresAt = new Date(Date.now() + (tokenResponse.expires_in * 1000))
    
    // Decode token to get account info
    this.account = this.parseJwt(this.accessToken)
    
    loggers.copilot.debug('Sign-in successful:', this.account?.preferred_username || this.account?.name)
    
    // Cache tokens
    this.saveCache()
    this.onAuthStatusChanged?.(true)
    
    return {
      success: true,
      account: this.account
    }
  }

  /**
   * Poll for token while user authenticates in browser
   */
  private async pollForToken(deviceCode: DeviceCodeResponse): Promise<TokenResponse> {
    this.isPolling = true
    const interval = (deviceCode.interval || 5) * 1000 // Convert to ms
    const expiresAt = Date.now() + (deviceCode.expires_in * 1000)

    while (this.isPolling && Date.now() < expiresAt) {
      await this.sleep(interval)
      
      if (!this.isPolling) {
        throw new Error('Sign-in cancelled')
      }
      
      try {
        const bodyString = `grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id=${this.config.clientId}&device_code=${deviceCode.device_code}`
        const response = await tauriHttpPost(this.tokenEndpoint, bodyString)

        if (response.ok) {
          this.isPolling = false
          return response.data as TokenResponse
        }

        const errorData = response.data as TokenErrorResponse

        if (errorData.error === 'authorization_pending') {
          loggers.copilot.debug('Waiting for user to authenticate...')
          continue
        } else if (errorData.error === 'slow_down') {
          loggers.copilot.debug('Slowing down polling...')
          await this.sleep(5000)
          continue
        } else if (errorData.error === 'expired_token') {
          throw new Error('Device code expired. Please try again.')
        } else if (errorData.error === 'access_denied') {
          throw new Error('User denied access.')
        } else {
          throw new Error(errorData.error_description || errorData.error || 'Token acquisition failed')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('expired') || message.includes('denied') || message.includes('cancelled')) {
          throw error
        }
        loggers.copilot.error('Poll error:', error)
      }
    }

    throw new Error('Device code flow timed out')
  }

  /**
   * Refresh the access token
   */
  private async refreshAccessToken(): Promise<string> {
    if (!this.refreshToken) {
      throw new Error('No refresh token available')
    }

    const bodyString = `grant_type=refresh_token&client_id=${this.config.clientId}&refresh_token=${this.refreshToken}&scope=${encodeURIComponent(this.scopes)}`
    const response = await tauriHttpPost(this.tokenEndpoint, bodyString)

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${JSON.stringify(response.data)}`)
    }

    const data = response.data as TokenResponse
    
    this.accessToken = data.access_token
    this.refreshToken = data.refresh_token || this.refreshToken
    this.tokenExpiresAt = new Date(Date.now() + (data.expires_in * 1000))
    
    this.saveCache()
    loggers.copilot.debug('Token refreshed successfully')
    
    return this.accessToken
  }

  /**
   * Get current valid token (refresh if needed)
   */
  async getToken(): Promise<string> {
    if (!this.accessToken) {
      throw new Error('Not authenticated. Please sign in first.')
    }

    // Check if token is about to expire (within 5 minutes)
    const now = new Date()
    const expiryBuffer = 5 * 60 * 1000
    
    if (this.tokenExpiresAt && (this.tokenExpiresAt.getTime() - now.getTime()) < expiryBuffer) {
      loggers.copilot.debug('Token expiring soon, refreshing...')
      // Use lock to prevent concurrent refresh attempts from invalidating each other's tokens
      if (this.refreshInProgress) {
        return this.refreshInProgress
      }
      this.refreshInProgress = this.refreshAccessToken().finally(() => {
        this.refreshInProgress = null
      })
      return this.refreshInProgress
    }

    return this.accessToken
  }

  /**
   * Cancel ongoing device code flow
   */
  cancelSignIn(): void {
    this.isPolling = false
    loggers.copilot.debug('Sign-in cancelled')
  }

  /**
   * Sign out
   */
  signOut(): void {
    this.isPolling = false
    this.account = null
    this.accessToken = null
    this.refreshToken = null
    this.tokenExpiresAt = null
    this.clearCache()
    this.onAuthStatusChanged?.(false)
    loggers.copilot.debug('Signed out successfully')
  }

  /**
   * Check if currently authenticated
   */
  isAuthenticated(): boolean {
    return this.accessToken !== null && this.tokenExpiresAt !== null && this.tokenExpiresAt > new Date()
  }

  /**
   * Get current account info
   */
  getAccountInfo(): { username: string; name: string; tenantId: string } | null {
    if (!this.account) return null
    
    return {
      username: this.account.preferred_username || this.account.upn || this.account.email || '',
      name: this.account.name || '',
      tenantId: this.account.tid || ''
    }
  }

  // Helper methods
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private parseJwt(token: string): JwtPayload | null {
    try {
      const base64Url = token.split('.')[1]
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      )
      return JSON.parse(jsonPayload)
    } catch (e) {
      loggers.copilot.error('Failed to parse JWT:', e)
      return null
    }
  }

  private saveCache(): void {
    const authData: CachedAuth = {
      accessToken: this.accessToken!,
      refreshToken: this.refreshToken,
      tokenExpiresAt: this.tokenExpiresAt!.toISOString(),
      account: this.account
    }
    const serialized = JSON.stringify(authData)

    // Persist to OS-protected credential storage (DPAPI on Windows), not
    // plaintext web storage. Fire-and-forget: a failed cache write only means
    // the user re-authenticates next launch.
    void storeCopilotAuthCache(serialized)
  }

  private clearCache(): void {
    void deleteCopilotAuthCache()

    clearLegacyCopilotBrowserCache()
  }
}

// Singleton instance
let instance: CopilotAuthService | null = null

/**
 * Initialize the Copilot Auth service
 */
export function initCopilotAuth(config: CopilotStudioConfig): CopilotAuthService {
  // Reuse existing singleton if config matches to prevent discarding in-flight operations
  if (instance) {
    return instance
  }
  instance = new CopilotAuthService(config)
  return instance
}

/**
 * Get the Copilot Auth service instance
 */
export function getCopilotAuthService(): CopilotAuthService {
  if (!instance) {
    throw new Error('CopilotAuthService not initialized. Call initCopilotAuth first.')
  }
  return instance
}
