// ============================================
// MCP HTTP Server Lifecycle
// Start / stop the Streamable HTTP server
// ============================================

use axum::middleware;
use axum::Router;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use super::auth::{auth_middleware, AuthState};
use super::bridge::McpBridge;
use super::tools::CabMcpServer;

/// Start the MCP HTTP Streamable server on the given port.
/// All requests to /mcp require the provided API key.
pub async fn start_server(
    bridge: Arc<McpBridge>,
    port: u16,
    api_key: String,
) -> Result<CancellationToken, String> {
    let ct = CancellationToken::new();

    // Create the MCP Streamable HTTP service
    let bridge_clone = bridge.clone();
    let mcp_service = StreamableHttpService::new(
        move || Ok(CabMcpServer::new(bridge_clone.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig {
            stateful_mode: true,
            cancellation_token: ct.child_token(),
            ..Default::default()
        },
    );

    // Auth state with API key
    let auth_state = AuthState::new(api_key);

    // MCP routes behind API key auth
    let mcp_router = Router::new()
        .nest_service("/mcp", mcp_service)
        .layer(middleware::from_fn_with_state(auth_state, auth_middleware));

    let router = mcp_router;

    tracing::info!("MCP server listening on http://127.0.0.1:{}/mcp (API key auth enabled)", port);

    // Bind to localhost with retry (handles TIME_WAIT from previous instance)
    let bind_addr = format!("127.0.0.1:{}", port);
    let listener = bind_with_retry(&bind_addr, 3).await?;

    // Spawn the server task with panic guard
    let shutdown_token = ct.child_token();
    let handle = tokio::spawn(async move {
        let shutdown = shutdown_token.cancelled_owned();
        if let Err(e) = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await
        {
            tracing::error!("MCP server error: {}", e);
        }
        tracing::info!("MCP server stopped");
    });

    // Monitor the server task for panics (fire-and-forget)
    tokio::spawn(async move {
        if let Err(e) = handle.await {
            if e.is_panic() {
                tracing::error!("MCP server task PANICKED: {}", e);
            } else {
                tracing::warn!("MCP server task cancelled: {}", e);
            }
        }
    });

    Ok(ct)
}

/// Bind to a TCP address with retry and exponential backoff.
/// Handles the TIME_WAIT race when the previous instance's socket hasn't fully released.
async fn bind_with_retry(
    addr: &str,
    max_attempts: u32,
) -> Result<tokio::net::TcpListener, String> {
    let delays = [500u64, 1000, 2000];

    for attempt in 1..=max_attempts {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                if attempt > 1 {
                    tracing::info!("Port {} bound on attempt {}", addr, attempt);
                }
                return Ok(listener);
            }
            Err(e) if attempt < max_attempts => {
                let delay = delays.get((attempt - 1) as usize).copied().unwrap_or(2000);
                tracing::warn!(
                    "Failed to bind to {} (attempt {}/{}): {}. Retrying in {}ms...",
                    addr, attempt, max_attempts, e, delay
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
            Err(e) => {
                return Err(format!(
                    "Failed to bind to {} after {} attempts: {}",
                    addr, max_attempts, e
                ));
            }
        }
    }
    unreachable!()
}
