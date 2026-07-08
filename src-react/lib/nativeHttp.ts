// Native HTTP via the Rust core (no browser Origin header).
//
// The Tauri v2 plugin-http `fetch` runs a fetch-spec request that includes an
// `Origin: http://localhost:5173` header. Azure AD token endpoints reject that
// (AADSTS9002326: cross-origin token redemption is only allowed for SPA
// clients). Routing these calls through the Rust `http_proxy_request` command
// (reqwest) avoids the Origin header entirely — matching the old Tauri v1
// behavior — and keeps secret-bearing requests out of the renderer.

import { invoke } from '@tauri-apps/api/core'

export interface NativeHttpRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
}

export interface NativeHttpResponse {
  status: number
  ok: boolean
  body: string
}

/** Perform an HTTPS request from the Rust core (no Origin header). */
export function nativeHttpRequest(req: NativeHttpRequest): Promise<NativeHttpResponse> {
  return invoke<NativeHttpResponse>('http_proxy_request', { req })
}

/** Convenience: request and parse the JSON body (returns {} on parse failure). */
export async function nativeHttpJson(req: NativeHttpRequest): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await nativeHttpRequest(req)
  let data: unknown = {}
  try {
    data = res.body ? JSON.parse(res.body) : {}
  } catch {
    data = res.body
  }
  return { ok: res.ok, status: res.status, data }
}
