// ============================================
// Config File Service
// Frontend bridge for the Rust-owned cab-config.json.
// Values with ${VAR_NAME} are resolved at load time.
// ============================================

import { invoke } from '@tauri-apps/api/tauri'
import { logger } from '@/lib/logger'

/**
 * Load the config file with all ${VAR} references resolved.
 * Returns `{}` if the file does not exist yet.
 */
export async function loadAppConfig(): Promise<Record<string, unknown>> {
  try {
    return await invoke<Record<string, unknown>>('load_config_file')
  } catch (error) {
    logger.warn('Failed to load config file', 'ConfigFileService', error)
    return {}
  }
}

/**
 * Load the raw (unresolved) config file for export.
 */
export async function loadRawAppConfig(): Promise<Record<string, unknown>> {
  try {
    return await invoke<Record<string, unknown>>('load_raw_config_file')
  } catch (error) {
    logger.warn('Failed to load raw config file', 'ConfigFileService', error)
    return {}
  }
}

/**
 * Save the raw config document to the config file.
 * Values should contain ${VAR} references where applicable.
 */
export async function saveAppConfig(config: Record<string, unknown>): Promise<boolean> {
  try {
    await invoke('save_config_file', { config })
    return true
  } catch (error) {
    logger.warn('Failed to save config file', 'ConfigFileService', error)
    return false
  }
}

/**
 * Get the absolute path to the config file.
 */
export async function getConfigFilePath(): Promise<string> {
  try {
    return await invoke<string>('get_config_file_path')
  } catch (error) {
    logger.warn('Failed to get config file path', 'ConfigFileService', error)
    return ''
  }
}

/**
 * Import a config document (validate + write).
 */
export async function importAppConfig(config: Record<string, unknown>): Promise<boolean> {
  try {
    await invoke('import_config_file', { config })
    return true
  } catch (error) {
    logger.warn('Failed to import config file', 'ConfigFileService', error)
    return false
  }
}

/**
 * Check if the config file service is available (running inside Tauri).
 */
export function isConfigFileServiceAvailable(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as Window & { __TAURI__?: unknown; __TAURI_IPC__?: unknown; __TAURI_INTERNALS__?: unknown }
  return Boolean(w.__TAURI__ || w.__TAURI_INTERNALS__ || typeof w.__TAURI_IPC__ === 'function')
}
