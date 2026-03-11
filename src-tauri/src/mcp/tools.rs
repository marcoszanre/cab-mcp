// ============================================
// MCP Tool Definitions
// Implements core MCP tools using rmcp macros
// ============================================

use std::sync::Arc;

use rmcp::handler::server::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::*;
use rmcp::schemars;
use rmcp::schemars::JsonSchema;
use rmcp::{tool, tool_handler, tool_router, ServerHandler};
use serde::Deserialize;

use super::bridge::McpBridge;

// ---- Tool Parameter Types ----

#[derive(Deserialize, JsonSchema)]
pub struct JoinMeetingParams {
    /// Teams meeting URL to join
    pub meeting_url: String,
    /// ID of the agent configuration to use
    pub agent_config_id: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct LeaveMeetingParams {
    /// Session ID of the meeting to leave
    pub session_id: String,
}

// ---- MCP Server Handler ----

/// Community Agent Bridge MCP Server.
/// Each tool delegates to the React frontend via the IPC bridge.
#[derive(Clone)]
pub struct CabMcpServer {
    bridge: Arc<McpBridge>,
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl CabMcpServer {
    pub fn new(bridge: Arc<McpBridge>) -> Self {
        Self {
            bridge,
            tool_router: Self::tool_router(),
        }
    }

    /// List available agent configurations (no secrets exposed)
    #[tool(
        name = "list_agents",
        description = "List available agent configurations. Returns agent IDs, names, and types. Never includes secrets or credentials.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn list_agents(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        tracing::info!("MCP tool: list_agents");

        match self
            .bridge
            .request("list_agents", serde_json::Value::Null)
            .await
        {
            Ok(result) => {
                let text = serde_json::to_string_pretty(&result).unwrap_or_default();
                Ok(CallToolResult::success(vec![Content::text(text)]))
            }
            Err(e) => {
                tracing::error!("list_agents failed: {}", e);
                Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {}",
                    e
                ))]))
            }
        }
    }

    /// Join a Teams meeting with a specified agent
    #[tool(
        name = "join_meeting",
        description = "Join a Teams meeting with the specified agent configuration. Returns a session ID for tracking.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = true)
    )]
    async fn join_meeting(
        &self,
        params: Parameters<JoinMeetingParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        tracing::info!(
            "MCP tool: join_meeting (agent: {})",
            params.0.agent_config_id
        );

        // Basic URL validation
        if !params.0.meeting_url.contains("teams.microsoft.com")
            && !params.0.meeting_url.contains("teams.live.com")
        {
            return Ok(CallToolResult::error(vec![Content::text(
                "Error: Invalid meeting URL. Must be a Teams meeting URL.",
            )]));
        }

        let request_params = serde_json::json!({
            "meetingUrl": params.0.meeting_url,
            "agentConfigId": params.0.agent_config_id,
        });

        match self.bridge.request("join_meeting", request_params).await {
            Ok(result) => {
                let text = serde_json::to_string_pretty(&result).unwrap_or_default();
                Ok(CallToolResult::success(vec![Content::text(text)]))
            }
            Err(e) => {
                tracing::error!("join_meeting failed: {}", e);
                Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {}",
                    e
                ))]))
            }
        }
    }

    /// Leave the current meeting
    #[tool(
        name = "leave_meeting",
        description = "Leave the current Teams meeting and disconnect the agent cleanly.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    async fn leave_meeting(
        &self,
        params: Parameters<LeaveMeetingParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        tracing::info!("MCP tool: leave_meeting (session: {})", params.0.session_id);

        let request_params = serde_json::json!({
            "sessionId": params.0.session_id,
        });

        match self.bridge.request("leave_meeting", request_params).await {
            Ok(result) => {
                let text = serde_json::to_string_pretty(&result).unwrap_or_default();
                Ok(CallToolResult::success(vec![Content::text(text)]))
            }
            Err(e) => {
                tracing::error!("leave_meeting failed: {}", e);
                Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {}",
                    e
                ))]))
            }
        }
    }

    /// List all active sessions with their status
    #[tool(
        name = "list_sessions",
        description = "List all active meeting sessions with their status, agents, and uptime. Returns a summary of all concurrent sessions.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn list_sessions(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        tracing::info!("MCP tool: list_sessions");

        match self
            .bridge
            .request("list_sessions", serde_json::Value::Null)
            .await
        {
            Ok(result) => {
                let text = serde_json::to_string_pretty(&result).unwrap_or_default();
                Ok(CallToolResult::success(vec![Content::text(text)]))
            }
            Err(e) => {
                tracing::error!("list_sessions failed: {}", e);
                Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: {}",
                    e
                ))]))
            }
        }
    }

}

#[tool_handler]
impl ServerHandler for CabMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            instructions: Some(
                "Community Agent Bridge MCP Server. \
                 Use list_agents to see available agents, join_meeting to connect an agent to a Teams meeting, \
                 list_sessions to see all active sessions, and leave_meeting to disconnect."
                    .into(),
            ),
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "community-agent-bridge".into(),
                version: env!("CARGO_PKG_VERSION").into(),
                ..Default::default()
            },
            ..Default::default()
        }
    }
}
