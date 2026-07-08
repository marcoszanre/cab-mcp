// ============================================
// Secure Store (frontend)
// Thin async wrapper over the Rust `secure_store_*` commands, which persist
// secrets in the OS credential store (Windows Credential Manager / DPAPI).
//
// Long-lived OAuth access/refresh tokens must NOT live in WebView2 localStorage
// (plaintext, readable by any script in the app origin). Use this instead.
//
// When the desktop runtime is unavailable (e.g. running the Vite dev server in
// a plain browser, or if the OS credential store is inaccessible), we fall back
// to localStorage so development and degraded environments keep working. In the
// packaged desktop app the secure path is always used.
// ============================================

import { loggers } from '@/lib/logger'

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

let cachedInvoke: TauriInvoke | null = null
let triedInvoke = false

async function getInvoke(): Promise<TauriInvoke | null> {
  if (triedInvoke) return cachedInvoke
  triedInvoke = true
  try {
    // Detect the Tauri desktop runtime the same way the rest of the app does
    // (configFileService / validationService). Tauri v2 exposes
    // `__TAURI_INTERNALS__`; older/global builds expose `__TAURI__` or a
    // `__TAURI_IPC__` function. Checking only `__TAURI_IPC__` misfired on v2 and
    // silently fell back to localStorage, so OAuth tokens were not persisted in
    // the OS credential store (causing re-authentication after restarts).
    const w = window as unknown as {
      __TAURI__?: unknown
      __TAURI_IPC__?: unknown
      __TAURI_INTERNALS__?: unknown
    }
    const isTauri =
      typeof window !== 'undefined' &&
      Boolean(w.__TAURI__ || w.__TAURI_INTERNALS__ || typeof w.__TAURI_IPC__ === 'function')
    if (!isTauri) return null
    const mod = await import('@tauri-apps/api/core')
    cachedInvoke = mod.invoke as unknown as TauriInvoke
  } catch {
    cachedInvoke = null
  }
  return cachedInvoke
}

/** Store a secret value. Prefers the OS credential store; falls back to localStorage. */
export async function secureSet(key: string, value: string): Promise<void> {
  const invoke = await getInvoke()
  if (invoke) {
    try {
      await invoke('secure_store_set', { key, value })
      // Ensure no stale plaintext copy lingers in web storage.
      try { localStorage.removeItem(key) } catch { /* ignore */ }
      return
    } catch (e) {
      loggers.copilot.warn('secureSet: OS credential store failed, falling back to localStorage', e)
    }
  }
  try { localStorage.setItem(key, value) } catch { /* ignore */ }
}

/** Retrieve a secret value, or null if not present. */
export async function secureGet(key: string): Promise<string | null> {
  const invoke = await getInvoke()
  if (invoke) {
    try {
      const v = await invoke<string | null>('secure_store_get', { key })
      if (v != null) return v
      // One-time migration: pull any legacy plaintext value into the secure store.
      const legacy = safeLocalGet(key)
      if (legacy != null) {
        try {
          await invoke('secure_store_set', { key, value: legacy })
          localStorage.removeItem(key)
        } catch { /* ignore migration failure */ }
        return legacy
      }
      return null
    } catch (e) {
      loggers.copilot.warn('secureGet: OS credential store failed, falling back to localStorage', e)
    }
  }
  return safeLocalGet(key)
}

/** Delete a secret value from both the OS credential store and localStorage. */
export async function secureDelete(key: string): Promise<void> {
  const invoke = await getInvoke()
  if (invoke) {
    try {
      await invoke('secure_store_delete', { key })
    } catch (e) {
      loggers.copilot.warn('secureDelete: OS credential store failed', e)
    }
  }
  try { localStorage.removeItem(key) } catch { /* ignore */ }
}

function safeLocalGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
