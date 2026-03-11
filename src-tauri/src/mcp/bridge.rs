// ============================================
// MCP Bridge
// Handles IPC between Rust MCP tool handlers and
// the React frontend via Tauri events
// ============================================

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{oneshot, Mutex};

/// Payload emitted to React via Tauri events
#[derive(Clone, Serialize)]
pub struct McpCommandPayload {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub tool: String,
    pub params: serde_json::Value,
}

/// Bridge between MCP tool handlers and the React frontend.
/// Tool handlers call `request()` which emits a Tauri event and waits
/// for React to respond via the `mcp_respond` Tauri command.
pub struct McpBridge {
    app_handle: tauri::AppHandle,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<BridgeResponse>>>>,
}

/// Response from the React frontend
pub struct BridgeResponse {
    pub result: Option<serde_json::Value>,
    pub error: Option<BridgeError>,
}

pub struct BridgeError {
    pub code: i32,
    pub message: String,
}

impl McpBridge {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self {
            app_handle,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Send a tool request to React and wait for the response.
    /// Times out after 30 seconds.
    pub async fn request(
        &self,
        tool: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let started_at = std::time::Instant::now();
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();

        // Store the oneshot sender so mcp_respond can complete it
        let pending_count = {
            let mut pending = self.pending.lock().await;
            pending.insert(request_id.clone(), tx);
            pending.len()
        };

        tracing::info!(
            request_id = %request_id,
            tool = tool,
            pending_requests = pending_count,
            "MCP bridge request started"
        );

        // Emit event to React frontend
        let payload = McpCommandPayload {
            request_id: request_id.clone(),
            tool: tool.to_string(),
            params,
        };

        self.app_handle
            .emit_all("mcp:command", payload)
            .map_err(|e| {
                let error = format!("Failed to emit MCP event: {}", e);
                tracing::error!(
                    request_id = %request_id,
                    tool = tool,
                    error = %error,
                    "MCP bridge emit failed"
                );
                error
            })?;

        // Wait for response with timeout
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(response)) => {
                if let Some(err) = response.error {
                    tracing::warn!(
                        request_id = %request_id,
                        tool = tool,
                        code = err.code,
                        message = %err.message,
                        duration_ms = started_at.elapsed().as_millis(),
                        "MCP bridge request failed"
                    );
                    Err(format!("[{}] {}", err.code, err.message))
                } else {
                    tracing::info!(
                        request_id = %request_id,
                        tool = tool,
                        duration_ms = started_at.elapsed().as_millis(),
                        "MCP bridge request completed"
                    );
                    Ok(response.result.unwrap_or(serde_json::Value::Null))
                }
            }
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&request_id);
                tracing::error!(
                    request_id = %request_id,
                    tool = tool,
                    duration_ms = started_at.elapsed().as_millis(),
                    "MCP bridge channel closed unexpectedly"
                );
                Err("Bridge channel closed unexpectedly".to_string())
            }
            Err(_) => {
                let pending_count = {
                    let mut pending = self.pending.lock().await;
                    pending.remove(&request_id);
                    pending.len()
                };
                tracing::error!(
                    request_id = %request_id,
                    tool = tool,
                    duration_ms = started_at.elapsed().as_millis(),
                    pending_requests = pending_count,
                    "MCP bridge request timed out"
                );
                Err("Request timed out (30s)".to_string())
            }
        }
    }

    /// Called by the `mcp_respond` Tauri command when React sends a response.
    pub async fn respond(
        &self,
        request_id: &str,
        result: Option<serde_json::Value>,
        error: Option<(i32, String)>,
    ) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| {
                tracing::warn!(request_id = request_id, "MCP bridge response arrived without a pending request");
                format!("No pending request with id: {}", request_id)
            })?;

        let response = BridgeResponse {
            result,
            error: error.map(|(code, message)| BridgeError { code, message }),
        };

        sender
            .send(response)
            .map_err(|_| {
                tracing::warn!(request_id = request_id, "MCP bridge response receiver dropped before delivery");
                "Failed to send bridge response (receiver dropped)".to_string()
            })
    }
}

// Need to use emit_all from tauri::Manager
use tauri::Manager;
