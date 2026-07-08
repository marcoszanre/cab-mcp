// ============================================
// Coding Agent Module
// Bridges the GitHub Copilot CLI as an agent provider via the official
// `github-copilot-sdk` Rust SDK (JSON-RPC over the installed `copilot` binary).
//
// Design:
// - ONE persistent Client + Session per meeting agent instance (kept alive for
//   the whole meeting), so tool/MCP context and conversation persist.
// - Tools are ENABLED (that's the value: the user's MCP servers from
//   ~/.copilot/mcp-config.json — Work IQ, etc. — plus skills/plugins are loaded
//   via CLI config discovery), but a permission policy DENIES the `shell` tool
//   by default as an XPIA guardrail (meeting captions are untrusted input).
//   Toggle via allow_shell.
// - Process lifecycle is owned by the Rust core; the renderer only sees
//   start/send/end commands.
// ============================================

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tauri::command;
use tokio::sync::Mutex;

use github_copilot_sdk::handler::ApproveAllHandler;
use github_copilot_sdk::{Client, ClientOptions, MessageOptions, SessionConfig};

const DEFAULT_MODEL: &str = "gpt-5.4";
const DEFAULT_WAIT_SECS: u64 = 180;
const MIN_WAIT_SECS: u64 = 10;
const MAX_WAIT_SECS: u64 = 600;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

/// A live coding-agent session (owns the CLI runtime + conversation).
struct LiveSession {
    client: Client,
    session: github_copilot_sdk::session::Session,
}

/// Tauri-managed state: persistent sessions keyed by agent instance id.
#[derive(Default)]
pub struct CodingAgentState {
    sessions: Mutex<HashMap<String, Arc<LiveSession>>>,
}

impl CodingAgentState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionRequest {
    /// Stable key for this session (the meeting agent instance id).
    pub instance_id: String,
    /// Model to use (defaults to gpt-5.4).
    pub model: Option<String>,
    /// Working directory / repo context the agent operates in.
    pub cwd: Option<String>,
    /// Optional system message / persona for the meeting agent.
    pub system_message: Option<String>,
    /// Allow the autonomous `shell` tool. DEFAULT false (XPIA guardrail).
    pub allow_shell: Option<bool>,
    /// Override the copilot binary path (defaults to PATH resolution).
    pub bin: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub instance_id: String,
    pub prompt: String,
    pub timeout_secs: Option<u64>,
}

/// Resolve the `copilot` binary: explicit override → COPILOT_CLI_PATH → PATH scan.
///
/// Note: when the app is launched via `npm`/`tauri dev`, `node_modules/.bin` is
/// prepended to PATH and may contain an unrelated `copilot.cmd` shim. We therefore
/// (1) skip any `node_modules` directories and (2) prefer the native `copilot.exe`
/// across ALL PATH dirs before falling back to `.cmd`/`.bat` shims.
fn resolve_copilot(bin: &Option<String>) -> Option<PathBuf> {
    if let Some(b) = bin.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(b));
    }
    if let Ok(p) = std::env::var("COPILOT_CLI_PATH") {
        if !p.trim().is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let path_var = std::env::var_os("PATH")?;
    let dirs: Vec<PathBuf> = std::env::split_paths(&path_var)
        .filter(|d| {
            !d.components().any(|c| {
                c.as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("node_modules")
            })
        })
        .collect();

    let exe_names: &[&str] = if cfg!(windows) {
        &["copilot.exe", "copilot.cmd", "copilot.bat"]
    } else {
        &["copilot"]
    };

    // Prefer the native executable across all dirs before any shim.
    for name in exe_names {
        for dir in &dirs {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Build ClientOptions pointing at the resolved CLI, with an optional cwd.
fn build_client_options(
    bin: &Option<String>,
    cwd: &Option<String>,
) -> Result<ClientOptions, String> {
    let path = resolve_copilot(bin).ok_or_else(|| {
        "GitHub Copilot CLI ('copilot') not found on PATH. Install it and sign in.".to_string()
    })?;

    let mut opts = ClientOptions::default();
    opts.program = github_copilot_sdk::CliProgram::Path(path);
    if let Some(dir) = cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        opts.working_directory = PathBuf::from(dir);
    }
    Ok(opts)
}

/// Check whether the Copilot CLI is available and return its version.
#[command]
pub async fn coding_agent_check(bin: Option<String>) -> Result<serde_json::Value, String> {
    let Some(path) = resolve_copilot(&bin) else {
        return Ok(json!({
            "available": false,
            "error": "'copilot' not found on PATH. Install GitHub Copilot CLI and sign in.",
        }));
    };

    let mut cmd = tokio::process::Command::new(&path);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.output().await {
        Ok(o) if o.status.success() => Ok(json!({
            "available": true,
            "version": String::from_utf8_lossy(&o.stdout).trim(),
            "path": path.to_string_lossy(),
        })),
        Ok(o) => Ok(json!({
            "available": false,
            "error": String::from_utf8_lossy(&o.stderr).trim(),
        })),
        Err(e) => Ok(json!({ "available": false, "error": format!("{e}") })),
    }
}

/// Start (or restart) a persistent coding-agent session for an instance.
#[command]
pub async fn coding_agent_start_session(
    state: tauri::State<'_, CodingAgentState>,
    req: StartSessionRequest,
) -> Result<(), String> {
    // Tear down any existing session for this instance first.
    coding_agent_end_session(state.clone(), req.instance_id.clone())
        .await
        .ok();

    let opts = build_client_options(&req.bin, &req.cwd)?;
    tracing::info!(
        "coding_agent: starting session '{}' (model={:?}, cwd={:?})",
        req.instance_id,
        req.model,
        req.cwd
    );
    let client = Client::start(opts).await.map_err(|e| {
        tracing::error!("coding_agent: Client::start failed: {e}");
        format!("Failed to start Copilot runtime: {e}")
    })?;

    let model = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string();

    // Permission policy: allow tools, but deny `shell` unless explicitly enabled.
    let allow_shell = req.allow_shell.unwrap_or(false);
    let mut config = SessionConfig::default();
    config.model = Some(model);
    if let Some(sys) = req
        .system_message
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let mut smc = github_copilot_sdk::types::SystemMessageConfig::default();
        smc.content = Some(sys.to_string());
        config.system_message = Some(smc);
    }

    // Load the user's full Copilot CLI configuration (all MCP servers from
    // ~/.copilot/mcp-config.json, skills, and plugins) into the session. Without
    // this, the SDK's server-mode CLI starts with only built-in tools and none
    // of the user's configured MCP servers (e.g. Work IQ) are available. This is
    // intentionally generic — whatever MCPs the user configures are picked up,
    // no per-server wiring in the bridge.
    config.enable_config_discovery = Some(true);
    // Reuse/persist MCP OAuth tokens across sessions so servers the user already
    // authorized interactively (e.g. Work IQ / Entra ID) don't require re-auth.
    config.mcp_oauth_token_storage = Some("persistent".to_string());

    let config = if allow_shell {
        config.with_permission_handler(Arc::new(ApproveAllHandler))
    } else {
        config.with_permission_handler(github_copilot_sdk::permission::approve_if(|data| {
            data.extra.get("tool").and_then(|v| v.as_str()) != Some("shell")
        }))
    };

    let session = client.create_session(config).await.map_err(|e| {
        tracing::error!("coding_agent: create_session failed: {e}");
        format!("Failed to create coding-agent session: {e}")
    })?;

    tracing::info!("coding_agent: session '{}' ready", req.instance_id);

    let live = Arc::new(LiveSession { client, session });
    state.sessions.lock().await.insert(req.instance_id, live);
    Ok(())
}

/// List the models available to the Copilot CLI (for dynamic UI discovery).
#[command]
pub async fn coding_agent_list_models(
    bin: Option<String>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let opts = build_client_options(&bin, &cwd)?;
    let client = Client::start(opts)
        .await
        .map_err(|e| format!("Failed to start Copilot runtime: {e}"))?;
    let result = client.list_models().await;
    client.stop().await.ok();
    let models = result.map_err(|e| format!("Failed to list models: {e}"))?;
    serde_json::to_value(models).map_err(|e| format!("Failed to serialize models: {e}"))
}

/// Send a prompt to a live coding-agent session and return its text response.
#[command]
pub async fn coding_agent_send(
    state: tauri::State<'_, CodingAgentState>,
    req: SendRequest,
) -> Result<String, String> {
    if req.prompt.trim().is_empty() {
        return Err("Prompt is empty".to_string());
    }

    let live = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&req.instance_id)
            .cloned()
            .ok_or_else(|| format!("No active coding-agent session for '{}'", req.instance_id))?
    };

    let wait = Duration::from_secs(
        req.timeout_secs
            .unwrap_or(DEFAULT_WAIT_SECS)
            .clamp(MIN_WAIT_SECS, MAX_WAIT_SECS),
    );

    live.session
        .send_and_wait(MessageOptions::new(req.prompt.as_str()).with_wait_timeout(wait))
        .await
        .map_err(|e| format!("Coding agent error: {e}"))?;

    let events = live
        .session
        .get_events()
        .await
        .map_err(|e| format!("Failed to read coding-agent response: {e}"))?;

    let mut text = events
        .iter()
        .rev()
        .find(|e| e.event_type == "assistant.message")
        .and_then(|e| {
            e.data
                .get("content")
                .or_else(|| e.data.get("text"))
                .and_then(|v| v.as_str())
        })
        .map(str::to_string)
        .ok_or_else(|| "Coding agent returned no message".to_string())?;

    if text.len() > MAX_OUTPUT_BYTES {
        let mut end = MAX_OUTPUT_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n…(truncated)");
    }
    Ok(text)
}

/// End and dispose a coding-agent session.
#[command]
pub async fn coding_agent_end_session(
    state: tauri::State<'_, CodingAgentState>,
    instance_id: String,
) -> Result<(), String> {
    let live = state.sessions.lock().await.remove(&instance_id);
    if let Some(live) = live {
        // Best-effort graceful shutdown.
        live.session.disconnect().await.ok();
        live.client.stop().await.ok();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real end-to-end smoke test against the installed & authenticated Copilot CLI.
    /// Ignored by default (network + auth + ~30-60s). Run with:
    ///   cargo test coding_agent_smoke -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn coding_agent_smoke() {
        let opts = build_client_options(&None, &None).expect("resolve copilot");
        let client = Client::start(opts).await.expect("start client");

        let mut config = SessionConfig::default();
        config.model = Some(DEFAULT_MODEL.to_string());
        // Mirror coding_agent_start_session: load user config (MCP servers etc.)
        // and persist MCP OAuth tokens; deny `shell` via approve_if.
        config.enable_config_discovery = Some(true);
        config.mcp_oauth_token_storage = Some("persistent".to_string());
        let config =
            config.with_permission_handler(github_copilot_sdk::permission::approve_if(|data| {
                data.extra.get("tool").and_then(|v| v.as_str()) != Some("shell")
            }));
        let session = client.create_session(config).await.expect("create session");

        session
            .send_and_wait(
                MessageOptions::new("Reply with exactly: hello from cab")
                    .with_wait_timeout(Duration::from_secs(120)),
            )
            .await
            .expect("send_and_wait");

        let events = session.get_events().await.expect("get_events");
        // Dump the tail so we can confirm the real event_type / data shape.
        for e in events.iter().rev().take(6) {
            println!("EVENT type={} data={}", e.event_type, e.data);
        }

        let text = events
            .iter()
            .rev()
            .find(|e| e.event_type == "assistant.message")
            .and_then(|e| {
                e.data
                    .get("content")
                    .or_else(|| e.data.get("text"))
                    .and_then(|v| v.as_str())
            })
            .map(str::to_string);

        println!("EXTRACTED RESPONSE: {text:?}");
        session.disconnect().await.ok();
        client.stop().await.ok();

        assert!(
            text.map(|t| !t.trim().is_empty()).unwrap_or(false),
            "expected non-empty response"
        );
    }
}
