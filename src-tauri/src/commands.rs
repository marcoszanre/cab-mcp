// ============================================
// Tauri Commands Module
// Exposed commands callable from the frontend
// ============================================

use tauri::command;

use crate::mcp::state::McpState;

// ============================================
// Native HTTP proxy
// Performs outbound HTTPS requests from the Rust core (reqwest), which — unlike
// the webview/plugin-http fetch — sends NO `Origin` header. This is required for
// Azure AD token endpoints (AADSTS9002326: cross-origin token redemption is only
// allowed for SPA clients) and is also more secure (secret-bearing calls leave
// the renderer). Restricted to https + an allowlist of the hosts the app uses.
// ============================================

#[derive(serde::Deserialize)]
pub struct HttpProxyRequest {
    pub method: String,
    pub url: String,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub body: Option<String>,
}

#[derive(serde::Serialize)]
pub struct HttpProxyResponse {
    pub status: u16,
    pub ok: bool,
    pub body: String,
}

/// Host suffixes the proxy is allowed to reach (mirrors the Tauri HTTP allowlist).
fn proxy_host_allowed(host: &str) -> bool {
    const ALLOWED: &[&str] = &[
        "login.microsoftonline.com",
        ".communication.azure.com",
        ".services.ai.azure.com",
        ".cognitiveservices.azure.com",
        ".openai.azure.com",
        ".tts.speech.microsoft.com",
        ".stt.speech.microsoft.com",
        ".speech.microsoft.com",
        ".api.cognitive.microsoft.com",
    ];
    let host = host.to_ascii_lowercase();
    ALLOWED
        .iter()
        .any(|a| host == a.trim_start_matches('.') || host.ends_with(a))
}

/// Perform an outbound HTTPS request from the Rust core (no Origin header).
#[command]
pub async fn http_proxy_request(req: HttpProxyRequest) -> Result<HttpProxyResponse, String> {
    let url = reqwest::Url::parse(&req.url).map_err(|e| format!("Invalid URL: {e}"))?;
    if url.scheme() != "https" {
        return Err("Only https URLs are permitted".to_string());
    }
    match url.host_str() {
        Some(h) if proxy_host_allowed(h) => {}
        Some(h) => return Err(format!("Host not allowed: {h}")),
        None => return Err("URL has no host".to_string()),
    }

    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|e| format!("Invalid method: {e}"))?;
    let client = reqwest::Client::new();
    let mut rb = client.request(method, url);
    if let Some(headers) = req.headers {
        for (k, v) in headers {
            rb = rb.header(k, v);
        }
    }
    if let Some(body) = req.body {
        rb = rb.body(body);
    }
    let resp = rb.send().await.map_err(|e| format!("Request failed: {e}"))?;
    let status = resp.status().as_u16();
    let ok = resp.status().is_success();
    let body = resp.text().await.unwrap_or_default();
    Ok(HttpProxyResponse { status, ok, body })
}

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

/// Open an external URL in the default browser.
///
/// Only `https://` (and `mailto:`) URLs are permitted. This prevents the
/// renderer from asking the OS to launch arbitrary schemes such as `file://`,
/// `javascript:`, or custom app-protocol handlers, which could be abused as a
/// local code-execution / navigation primitive if the renderer is compromised.
#[command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let allowed = lower.starts_with("https://") || lower.starts_with("mailto:");
    if !allowed {
        return Err(format!(
            "Refusing to open URL with disallowed scheme (only https:// and mailto: are permitted): {}",
            trimmed
        ));
    }
    open::that(trimmed).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::open_external_url;

    #[test]
    fn rejects_non_https_schemes() {
        assert!(open_external_url("file:///etc/passwd".into()).is_err());
        assert!(open_external_url("javascript:alert(1)".into()).is_err());
        assert!(open_external_url("http://insecure.example.com".into()).is_err());
        assert!(open_external_url("custom-app://run".into()).is_err());
    }
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
pub fn save_config_file(
    app_handle: tauri::AppHandle,
    config: serde_json::Value,
) -> Result<(), String> {
    crate::config_file::save_config_file(&app_handle, &config)
}

/// Return the absolute path to the config file.
#[command]
pub fn get_config_file_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    crate::config_file::get_config_file_path(&app_handle)
}

/// Reveal the config file's folder in the OS file explorer.
#[command]
pub fn open_config_dir(app_handle: tauri::AppHandle) -> Result<(), String> {
    let path = crate::config_file::get_config_file_path(&app_handle)?;
    let dir = std::path::Path::new(&path)
        .parent()
        .ok_or_else(|| "Could not resolve config directory".to_string())?;
    // Ensure the directory exists before asking the OS to open it.
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    open::that(dir).map_err(|e| e.to_string())
}

/// Import a config document (validate + write).
#[command]
pub fn import_config_file(
    app_handle: tauri::AppHandle,
    config: serde_json::Value,
) -> Result<(), String> {
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
pub async fn stop_mcp_server(state: tauri::State<'_, McpState>) -> Result<(), String> {
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
    let uptime = inner.started_at.map(|t| t.elapsed().as_secs()).unwrap_or(0);

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
    let bridge = inner.bridge.as_ref().ok_or("MCP server is not running")?;

    let error = match (error_code, error_message) {
        (Some(code), Some(msg)) => Some((code, msg)),
        _ => None,
    };

    bridge.respond(&request_id, result, error).await
}
