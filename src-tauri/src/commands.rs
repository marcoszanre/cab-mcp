// ============================================
// Tauri Commands Module
// Exposed commands callable from the frontend
// ============================================

use tauri::command;

use crate::mcp::state::McpState;

/// Get application information
#[command]
pub fn get_app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "Teams Agent Bridge",
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Modular desktop application for joining meetings with AI agents",
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH
    })
}

/// Open an external URL in the default browser
#[command]
pub fn open_external_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

// ============================================
// Config File Commands
// Single JSON config file with ${ENV_VAR} substitution.
// ============================================

/// Load the config file with env-var references resolved.
#[command]
pub fn load_config_file(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    crate::config_file::load_config_file(&app_handle)
}

/// Load the raw (unresolved) config file for export.
#[command]
pub fn load_raw_config_file(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    crate::config_file::load_raw_config_file(&app_handle)
}

/// Save a config document to the config file (atomic write).
#[command]
pub fn save_config_file(app_handle: tauri::AppHandle, config: serde_json::Value) -> Result<(), String> {
    crate::config_file::save_config_file(&app_handle, &config)
}

/// Return the absolute path to the config file.
#[command]
pub fn get_config_file_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    crate::config_file::get_config_file_path(&app_handle)
}

/// Import a config document (validate + write).
#[command]
pub fn import_config_file(app_handle: tauri::AppHandle, config: serde_json::Value) -> Result<(), String> {
    crate::config_file::import_config_file(&app_handle, &config)
}

// ============================================
// MCP Server Commands
// ============================================

/// Start the MCP HTTP Streamable server
#[command]
pub async fn start_mcp_server(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, McpState>,
    port: u16,
    api_key: String,
) -> Result<(), String> {
    let mut inner = state.inner.lock().await;

    if inner.running {
        return Err("MCP server is already running".to_string());
    }

    tracing::info!("MCP: Starting server on port {} (API key auth)", port);

    // Create bridge for IPC with React
    let bridge = std::sync::Arc::new(crate::mcp::bridge::McpBridge::new(app_handle));

    // Start the server
    let ct = crate::mcp::server::start_server(bridge.clone(), port, api_key).await?;

    // Update state
    inner.bridge = Some(bridge);
    inner.cancellation_token = Some(ct);
    inner.running = true;
    inner.port = port;
    inner.started_at = Some(std::time::Instant::now());

    Ok(())
}

/// Stop the MCP HTTP Streamable server
#[command]
pub async fn stop_mcp_server(
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().await;

    if !inner.running {
        return Err("MCP server is not running".to_string());
    }

    if let Some(ct) = inner.cancellation_token.take() {
        ct.cancel();
    }

    inner.bridge = None;
    inner.running = false;
    inner.started_at = None;

    tracing::info!("MCP server shutdown requested");
    Ok(())
}

/// Get MCP server status
#[command]
pub async fn get_mcp_server_status(
    state: tauri::State<'_, McpState>,
) -> Result<serde_json::Value, String> {
    let inner = state.inner.lock().await;
    let uptime = inner
        .started_at
        .map(|t| t.elapsed().as_secs())
        .unwrap_or(0);

    Ok(serde_json::json!({
        "running": inner.running,
        "port": if inner.running { Some(inner.port) } else { None::<u16> },
        "uptimeSeconds": if inner.running { Some(uptime) } else { None::<u64> },
    }))
}

/// Respond to a pending MCP tool request from React
#[command]
pub async fn mcp_respond(
    state: tauri::State<'_, McpState>,
    request_id: String,
    result: Option<serde_json::Value>,
    error_code: Option<i32>,
    error_message: Option<String>,
) -> Result<(), String> {
    let inner = state.inner.lock().await;
    let bridge = inner
        .bridge
        .as_ref()
        .ok_or("MCP server is not running")?;

    let error = match (error_code, error_message) {
        (Some(code), Some(msg)) => Some((code, msg)),
        _ => None,
    };

    bridge.respond(&request_id, result, error).await
}


