// ============================================
// Agent 365 Token Service
// Mints an ACS Communication access token FOR THE PASSWORDLESS AGENT 365 AGENT USER,
// so the bridge can join a Teams meeting as a NAMED, licensed identity (not an
// anonymous guest) via ACS Teams-user interop — with NO interactive login.
//
// Flow (agent-user OAuth impersonation, `user_fic` on-behalf-of chain):
//   1) blueprint -> T1   (client_credentials, fmi_path=agentIdentity)
//   2) agentIdentity -> T2 (client_credentials, client_assertion=T1)
//   3) user_fic OBO -> delegated ACS Teams AAD token for the agent user
//   4) getTokenForTeamsUser -> ACS Calling access token
//
// Steps 1-3 hit the Entra token endpoint and MUST go through the Rust native
// HTTP proxy (no Origin header) — the same path validateAzureFoundryConfig uses.
// Step 4 uses CommunicationIdentityClient against the ACS resource.
//
// Docs: https://learn.microsoft.com/en-us/entra/agent-id/agent-user-oauth-flow
// ============================================

import type { Agent365Config } from '@/types'
import { nativeHttpRequest } from '@/lib/nativeHttp'
import { logger } from '@/lib/logger'

type CommunicationIdentityModule = typeof import('@azure/communication-identity')

const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
const TOKEN_EXCHANGE_SCOPE = 'api://AzureADTokenExchange/.default'
// Delegated ACS Teams scopes for the agent user (calls + chat).
const ACS_TEAMS_SCOPE =
  'https://auth.msft.communication.azure.com/Teams.ManageCalls ' +
  'https://auth.msft.communication.azure.com/Teams.ManageChats'

let communicationIdentityModulePromise: Promise<CommunicationIdentityModule> | null = null
async function getCommunicationIdentityModule(): Promise<CommunicationIdentityModule> {
  communicationIdentityModulePromise ??= import('@azure/communication-identity')
  return communicationIdentityModulePromise
}

export interface Agent365AcsToken {
  /** ACS Communication access token usable with createTeamsCallAgent. */
  token: string
  /** Token expiry. */
  expiresOn: Date
  /** The agent user's Microsoft Entra display name (as shown in the Teams roster). */
  displayName: string
}

/**
 * Best-effort decode of a single claim from a JWT payload (no signature check).
 * Used only to read the non-sensitive `name`/`preferred_username` claim so the
 * bridge knows the exact Entra display name the agent shows as in the roster.
 */
function decodeJwtClaim(jwt: string, claim: string): string | undefined {
  try {
    const payload = jwt.split('.')[1]
    if (!payload) return undefined
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    const json = JSON.parse(decodeURIComponent(escape(atob(padded)))) as Record<string, unknown>
    const value = json[claim]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/** POST a form-urlencoded body to the tenant token endpoint via the native proxy. */
async function tokenPost(
  tenantId: string,
  form: Record<string, string>,
  redact: string[],
): Promise<string> {
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`
  const res = await nativeHttpRequest({
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })

  let data: { access_token?: string; error?: string; error_description?: string } = {}
  try {
    data = res.body ? JSON.parse(res.body) : {}
  } catch {
    data = {}
  }

  if (!res.ok || !data.access_token) {
    const step = `${form.grant_type}/${form.scope ?? ''}`
    let detail = data.error_description || data.error || `HTTP ${res.status}`
    for (const secret of redact) {
      if (secret) detail = detail.split(secret).join('[REDACTED]')
    }
    throw new Error(`Agent 365 token step failed (${step}): ${detail}`)
  }

  return data.access_token
}

/**
 * Run the 3-step user_fic impersonation chain and return the delegated
 * ACS Teams AAD token minted for the passwordless agent user.
 */
async function getAgentUserAcsAadToken(cfg: Agent365Config): Promise<string> {
  const secret = cfg.clientSecret?.trim()
  if (!secret) {
    throw new Error(
      'Agent 365 blueprint client secret is empty. Set it (e.g. $env:CAB_AGENT365_CLIENT_SECRET) in cab-config.json.',
    )
  }
  const redact = [secret]

  // Step 1: blueprint -> T1 (federated identity path to the agent identity)
  const t1 = await tokenPost(
    cfg.tenantId,
    {
      client_id: cfg.blueprintAppId,
      client_secret: secret,
      scope: TOKEN_EXCHANGE_SCOPE,
      fmi_path: cfg.agentIdentityAppId,
      grant_type: 'client_credentials',
    },
    redact,
  )

  // Step 2: agent identity -> T2 (asserting with T1)
  const t2 = await tokenPost(
    cfg.tenantId,
    {
      client_id: cfg.agentIdentityAppId,
      scope: TOKEN_EXCHANGE_SCOPE,
      client_assertion_type: JWT_BEARER,
      client_assertion: t1,
      grant_type: 'client_credentials',
    },
    redact,
  )

  // Step 3: user_fic OBO -> delegated ACS Teams AAD token for the agent user
  return tokenPost(
    cfg.tenantId,
    {
      client_id: cfg.agentIdentityAppId,
      scope: ACS_TEAMS_SCOPE,
      client_assertion_type: JWT_BEARER,
      client_assertion: t1,
      user_federated_identity_credential: t2,
      username: cfg.agentUserUpn,
      grant_type: 'user_fic',
      requested_token_use: 'on_behalf_of',
    },
    redact,
  )
}

/**
 * Acquire an ACS Communication access token for the Agent 365 agent user.
 *
 * @param cfg          Agent 365 identity configuration (resolved — secret already substituted).
 * @param acsEndpoint  ACS resource endpoint.
 * @param acsAccessKey ACS resource access key.
 */
export async function getAgent365AcsToken(
  cfg: Agent365Config,
  acsEndpoint: string,
  acsAccessKey: string,
): Promise<Agent365AcsToken> {
  if (!acsEndpoint || !acsAccessKey) {
    throw new Error('ACS endpoint and access key are required for Agent 365 identity')
  }

  logger.info('Acquiring Agent 365 delegated ACS token (user_fic OBO)…', 'Agent365Token')
  const teamsUserAadToken = await getAgentUserAcsAadToken(cfg)

  // The roster / mention name comes from Microsoft Entra, NOT from any local
  // setting. Read it straight from the delegated token's `name` claim so caption
  // mention-detection keys on what other participants actually see.
  const entraDisplayName = decodeJwtClaim(teamsUserAadToken, 'name')

  const { CommunicationIdentityClient } = await getCommunicationIdentityModule()
  const client = new CommunicationIdentityClient(`endpoint=${acsEndpoint};accesskey=${acsAccessKey}`)

  const acs = await client.getTokenForTeamsUser({
    teamsUserAadToken,
    clientId: cfg.agentIdentityAppId,
    userObjectId: cfg.agentUserObjectId,
  })

  logger.info('Agent 365 ACS token acquired', 'Agent365Token')
  return {
    token: acs.token,
    expiresOn: acs.expiresOn,
    displayName: entraDisplayName || cfg.displayName?.trim() || cfg.agentUserUpn,
  }
}
