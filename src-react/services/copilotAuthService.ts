// Copilot Studio Authentication Service
// Uses Tauri HTTP API for CORS-free requests (desktop app, not browser!)
// Implements Device Code Flow for OAuth2 authentication

import { shell, http } from '@tauri-apps/api'
import type { DeviceCodeInfo, CopilotStudioConfig } from '@/types'
const COPILOT_AUTH_CACHE_KEY = 'copilot-auth-cache'

function storeCopilotAuthCache(serialized: string): void {
  localStorage.setItem(COPILOT_AUTH_CACHE_KEY, serialized)
}

function getCopilotAuthCache(): string | null {
  return localStorage.getItem(COPILOT_AUTH_CACHE_KEY)
}

function deleteCopilotAuthCache(): void {
  localStorage.removeItem(COPILOT_AUTH_CACHE_KEY)
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
    const response = await http.fetch<unknown>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: http.Body.text(bodyString)
    })
    return { ok: response.ok, data: response.data }
  } catch (error) {
    console.error('Tauri HTTP error:', error)
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
    console.log('Initializing Copilot Studio authentication (Device Code Flow)...')

    const legacyBrowserCache = getLegacyCopilotBrowserCache()
    const clearedLegacyCache = clearLegacyCopilotBrowserCache()
    if (clearedLegacyCache) {
      console.log('Cleaned up legacy plaintext auth tokens from browser storage')
    }
    
    // Check secure storage first, then one-time migration fallbacks.
    let cached: string | null = null
    try {
      cached = getCopilotAuthCache()
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
          console.log('Found valid cached token for:', this.account?.preferred_username)
          this.onAuthStatusChanged?.(true)
          return true
        } else if (this.refreshToken) {
          // Try to refresh
          console.log('Token expired, attempting refresh...')
          try {
            await this.refreshAccessToken()
            return true
          } catch {
            console.log('Token refresh failed, need new sign-in')
            this.clearCache()
          }
        }
      } catch (e) {
        console.error('Failed to parse cached auth:', e)
        this.clearCache()
      }
    }
    
    console.log('Copilot Studio auth initialized, ready for sign-in')
    return false
  }

  /**
   * Sign in using Device Code Flow
   * Opens system browser for user to authenticate
   */
  async signIn(): Promise<{ success: boolean; account: JwtPayload | null }> {
    console.log('Starting Device Code Flow sign-in...')
    
    // Step 1: Request device code
    const bodyString = `client_id=${this.config.clientId}&scope=${encodeURIComponent(this.scopes)}`
    const deviceCodeResponse = await tauriHttpPost(this.deviceCodeEndpoint, bodyString)

    if (!deviceCodeResponse.ok) {
      throw new Error(`Failed to get device code: ${JSON.stringify(deviceCodeResponse.data)}`)
    }

    const deviceCode = deviceCodeResponse.data as DeviceCodeResponse
    
    console.log('Device code received:', deviceCode.user_code)
    console.log('Verification URL:', deviceCode.verification_uri)
    
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
      console.log('Opened system browser for authentication')
    } catch (e) {
      console.log('Could not auto-open browser:', e)
    }

    // Step 2: Poll for token
    const tokenResponse = await this.pollForToken(deviceCode)
    
    // Step 3: Store tokens
    this.accessToken = tokenResponse.access_token
    this.refreshToken = tokenResponse.refresh_token || null
    this.tokenExpiresAt = new Date(Date.now() + (tokenResponse.expires_in * 1000))
    
    // Decode token to get account info
    this.account = this.parseJwt(this.accessToken)
    
    console.log('Sign-in successful:', this.account?.preferred_username || this.account?.name)
    
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
          console.log('Waiting for user to authenticate...')
          continue
        } else if (errorData.error === 'slow_down') {
          console.log('Slowing down polling...')
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
        console.error('Poll error:', error)
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
    console.log('Token refreshed successfully')
    
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
      console.log('Token expiring soon, refreshing...')
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
    console.log('Sign-in cancelled')
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
    console.log('Signed out successfully')
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
      console.error('Failed to parse JWT:', e)
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

    // Store auth cache in localStorage (transient session data).
    storeCopilotAuthCache(serialized)
  }

  private clearCache(): void {
    deleteCopilotAuthCache()

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
