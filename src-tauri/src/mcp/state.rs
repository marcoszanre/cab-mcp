// ============================================
// MCP Shared State
// State managed by Tauri, shared between MCP server
// and Tauri commands
// ============================================

use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use super::bridge::McpBridge;

/// Wrapper stored in Tauri managed state via `.manage()`.
/// Interior mutability via `tokio::sync::Mutex`.
pub struct McpState {
    pub inner: tokio::sync::Mutex<McpStateInner>,
}

pub struct McpStateInner {
    /// Bridge for IPC communication with React (set when server starts)
    pub bridge: Option<Arc<McpBridge>>,
    /// Cancellation token for graceful server shutdown
    pub cancellation_token: Option<CancellationToken>,
    /// Whether the MCP HTTP server is currently running
    pub running: bool,
    /// Port the server is bound to
    pub port: u16,
    /// When the server was started
    pub started_at: Option<std::time::Instant>,
}

impl McpState {
    pub fn new() -> Self {
        Self {
            inner: tokio::sync::Mutex::new(McpStateInner {
                bridge: None,
                cancellation_token: None,
                running: false,
                port: 3100,
                started_at: None,
            }),
        }
    }
}
