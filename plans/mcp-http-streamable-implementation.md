# MCP HTTP Streamable Implementation Plan

> **Goal:** Expose CAB as an MCP server via HTTP Streamable transport, enabling remote clients to list agents, join/leave meetings, and check session status.

**Created:** January 21, 2026  
**Status:** Planning  
**Security Model:** API Key + HTTPS (via reverse proxy)

---

## Table of Contents

1. [Overview](#overview)
2. [Security Considerations](#security-considerations)
3. [Phase 1: Session Management Foundation](#phase-1-session-management-foundation)
4. [Phase 2: Rust MCP Server Core](#phase-2-rust-mcp-server-core)
5. [Phase 3: Authentication Layer](#phase-3-authentication-layer)
6. [Phase 4: MCP Tools Implementation](#phase-4-mcp-tools-implementation)
7. [Phase 5: Tauri ↔ React Bridge](#phase-5-tauri--react-bridge)
8. [Phase 6: Configuration UI](#phase-6-configuration-ui)
9. [Phase 7: Testing & Validation](#phase-7-testing--validation)
10. [Phase 8: Deployment Hardening](#phase-8-deployment-hardening)
11. [Rollback Plan](#rollback-plan)

---

## Overview

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Cloud VM                                      │
├──────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                Community Agent Bridge                       │  │
│  │                                                             │  │
│  │  ┌─────────────┐     IPC      ┌─────────────────────────┐  │  │
│  │  │  React UI   │◄────────────►│    Tauri Backend        │  │  │
│  │  │  (WebView)  │              │       (Rust)            │  │  │
│  │  │             │              │                         │  │  │
│  │  │  - Stores   │   Events     │  ┌───────────────────┐  │  │  │
│  │  │  - Services │◄────────────►│  │   MCP Server      │  │  │  │
│  │  │  - Hooks    │              │  │   HTTP Streamable │  │  │  │
│  │  └─────────────┘              │  │   :3100 (local)   │  │  │  │
│  │                               │  └─────────┬─────────┘  │  │  │
│  │                               └────────────┼────────────┘  │  │
│  └────────────────────────────────────────────┼───────────────┘  │
│                                               │                   │
│  ┌────────────────────────────────────────────┼───────────────┐  │
│  │  Reverse Proxy (nginx/caddy)               │               │  │
│  │  • HTTPS termination (TLS 1.3)             │               │  │
│  │  • IP allowlist                            │               │  │
│  │  • Rate limiting (10 req/min)              │               │  │
│  │  • Request logging                         │               │  │
│  └────────────────────────────────────────────┼───────────────┘  │
└───────────────────────────────────────────────┼───────────────────┘
                                                │
                                                ▼ HTTPS :443
                                        Remote MCP Clients
```

### MCP Tools (v1 Scope)

| Tool | Method | Description |
|------|--------|-------------|
| `list_agents` | Read | Returns available agent configurations (no secrets) |
| `join_meeting` | Action | Joins meeting with specified agent, returns session ID |
| `get_status` | Read | Returns session state, meeting info, uptime |
| `leave_meeting` | Action | Cleanly disconnects from meeting |

### Out of Scope (v1)

- Multi-agent concurrent sessions (future)
- Agent CRUD via MCP (use UI for now)
- Caption streaming via MCP
- TTS control via MCP
- Chat message sending via MCP

---

## Security Considerations

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Unauthorized access | API key + IP allowlist |
| Token leakage | Stored in system credential manager, never logged |
| Man-in-the-middle | HTTPS only (enforced by reverse proxy) |
| Replay attacks | Session IDs are single-use per meeting |
| DoS | Rate limiting at proxy level |
| Secret exposure | `list_agents` never returns credentials |

### Security Principles

1. **Bind to localhost only** - MCP server listens on `127.0.0.1:3100`, not `0.0.0.0`
2. **Reverse proxy required** - All external traffic goes through nginx/caddy
3. **No secrets in logs** - API tokens, credentials never written to disk
4. **Minimal permissions** - MCP can only call predefined tools
5. **Audit trail** - All MCP requests logged with timestamp, tool, session ID
6. **Token rotation** - UI allows regenerating API token

---

## Phase 1: Session Management Foundation

**Goal:** Add session tracking to meeting lifecycle

### Step 1.1: Define Session Types

**File:** `src-react/types/session.ts`

```typescript
export interface MeetingSession {
  sessionId: string           // UUID v4, generated on join
  agentConfigId: string       // Which agent config was used
  agentName: string           // Display name
  meetingUrl: string          // Teams meeting URL (sanitized)
  state: SessionState
  startedAt: number           // Unix timestamp
  endedAt?: number            // Set on leave/disconnect
}

export type SessionState = 
  | 'initializing'    // Join requested
  | 'connecting'      // ACS connecting
  | 'connected'       // In meeting, active
  | 'disconnecting'   // Leave requested
  | 'disconnected'    // Clean exit
  | 'error'           // Failed state
```

### Step 1.2: Add Session to Call Store

**File:** `src-react/stores/callStore.ts`

- Add `currentSession: MeetingSession | null` to store state
- Add `createSession(agentConfigId, meetingUrl)` action
- Add `updateSessionState(state)` action
- Add `endSession()` action
- Generate UUID using `crypto.randomUUID()`

### Step 1.3: Integrate Session with Meeting Flow

**File:** `src-react/hooks/useAcsCall.ts` (or relevant hook)

- Call `createSession()` when join initiated
- Update session state as ACS connection progresses
- Call `endSession()` on disconnect

### Step 1.4: Verification

- [ ] Join meeting via UI → session ID visible in dev tools
- [ ] Leave meeting → session state transitions correctly
- [ ] Error during join → session state is 'error'

---

## Phase 2: Rust MCP Server Core

**Goal:** HTTP server skeleton with JSON-RPC 2.0 handling

### Step 2.1: Add Dependencies to Cargo.toml

**File:** `src-tauri/Cargo.toml`

```toml
[dependencies]
# Existing deps...
axum = "0.7"
tokio = { version = "1", features = ["full"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }
tower = "0.4"
tower-http = { version = "0.5", features = ["cors", "trace"] }
tracing = "0.1"
tracing-subscriber = "0.3"
```

### Step 2.2: Create MCP Module Structure

**Directory:** `src-tauri/src/mcp/`

```
src-tauri/src/mcp/
├── mod.rs              # Module exports
├── server.rs           # HTTP server setup (axum)
├── protocol.rs         # JSON-RPC 2.0 types
├── handlers.rs         # Request handlers
├── auth.rs             # API key validation
└── state.rs            # Shared state with main app
```

### Step 2.3: Implement JSON-RPC 2.0 Protocol Types

**File:** `src-tauri/src/mcp/protocol.rs`

- `JsonRpcRequest` struct (jsonrpc, method, params, id)
- `JsonRpcResponse` struct (jsonrpc, result/error, id)
- `JsonRpcError` struct (code, message, data)
- MCP-specific types: `InitializeRequest`, `ToolCallRequest`, etc.

### Step 2.4: Create Basic HTTP Server

**File:** `src-tauri/src/mcp/server.rs`

- Single route: `POST /mcp`
- Bind to `127.0.0.1:3100`
- CORS disabled (reverse proxy handles it)
- Request logging middleware
- Graceful shutdown handler

### Step 2.5: Add Server Lifecycle Commands

**File:** `src-tauri/src/commands.rs`

- `start_mcp_server(port: u16)` - Spawns server on tokio runtime
- `stop_mcp_server()` - Signals shutdown
- `get_mcp_server_status()` - Returns running/stopped, port, uptime

### Step 2.6: Integrate with Tauri App

**File:** `src-tauri/src/main.rs`

- Add MCP state to Tauri managed state
- Register new commands
- Optionally auto-start server based on config

### Step 2.7: Verification

- [ ] `cargo build` succeeds
- [ ] Server starts via Tauri command
- [ ] `curl -X POST http://localhost:3100/mcp` returns JSON-RPC error (no auth)
- [ ] Server stops gracefully

---

## Phase 3: Authentication Layer

**Goal:** Secure API key generation, storage, and validation

### Step 3.1: API Key Generation

**File:** `src-tauri/src/mcp/auth.rs`

- Generate 256-bit random token on first run
- Format: `cab_` prefix + 43 base64url chars (e.g., `cab_xK9mN2pQ...`)
- Use `ring` or `getrandom` crate for CSPRNG

### Step 3.2: Secure Storage

**File:** `src-tauri/src/commands.rs` (extend existing credential commands)

- Store API key in system credential manager (same as existing secrets)
- Service name: `cab_mcp_api_key`
- Commands: `get_mcp_api_key()`, `regenerate_mcp_api_key()`

### Step 3.3: Auth Middleware

**File:** `src-tauri/src/mcp/auth.rs`

- Axum middleware/extractor for `Authorization: Bearer <token>`
- Constant-time comparison to prevent timing attacks
- Return 401 with generic message on failure (no hints)

### Step 3.4: Rate Limiting (Basic)

**File:** `src-tauri/src/mcp/auth.rs`

- In-memory rate limiter (10 requests per minute per session)
- Return 429 on exceed
- Reset on server restart (stateless)

### Step 3.5: Verification

- [ ] First run generates API key
- [ ] Key persists across app restarts
- [ ] Request without token → 401
- [ ] Request with wrong token → 401
- [ ] Request with correct token → 200 (or proper JSON-RPC response)
- [ ] Rapid requests → 429 after limit

---

## Phase 4: MCP Tools Implementation

**Goal:** Implement the four core tools

### Step 4.1: Define Tool Schemas

**File:** `src-tauri/src/mcp/tools.rs`

```rust
// Tool definitions for MCP initialize response
pub fn get_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "list_agents",
            description: "List available agent configurations",
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDefinition {
            name: "join_meeting",
            description: "Join a Teams meeting with specified agent",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "meetingUrl": { "type": "string", "description": "Teams meeting URL" },
                    "agentConfigId": { "type": "string", "description": "Agent config UUID" }
                },
                "required": ["meetingUrl", "agentConfigId"]
            }),
        },
        // ... get_status, leave_meeting
    ]
}
```

### Step 4.2: Implement `list_agents` Tool

**File:** `src-tauri/src/mcp/handlers.rs`

- Emit Tauri event to React: `mcp:list_agents`
- React responds with agent list (via invoke callback)
- Filter response: only id, name, type, provider, isDefault
- **NEVER include:** clientSecret, apiKey, tokenEndpoint, etc.

### Step 4.3: Implement `join_meeting` Tool

**File:** `src-tauri/src/mcp/handlers.rs`

- Validate `agentConfigId` exists (via React)
- Validate `meetingUrl` format (basic URL validation)
- Emit Tauri event: `mcp:join_meeting { agentConfigId, meetingUrl }`
- React initiates join flow (existing logic)
- Return `{ sessionId, status: "initializing" }`
- Store pending session in Rust state for status queries

### Step 4.4: Implement `get_status` Tool

**File:** `src-tauri/src/mcp/handlers.rs`

- Input: `{ sessionId }`
- Query React for current session state
- Return: `{ state, agentName, meetingUrl (sanitized), uptime, startedAt }`
- Return error if sessionId not found

### Step 4.5: Implement `leave_meeting` Tool

**File:** `src-tauri/src/mcp/handlers.rs`

- Input: `{ sessionId }`
- Validate sessionId matches current session
- Emit Tauri event: `mcp:leave_meeting { sessionId }`
- React initiates leave flow
- Return `{ success: true }` after disconnect confirmed

### Step 4.6: Verification

- [ ] `initialize` returns tool list
- [ ] `list_agents` returns agents without secrets
- [ ] `join_meeting` with valid agent → session starts
- [ ] `join_meeting` with invalid agent → error
- [ ] `get_status` returns correct state
- [ ] `leave_meeting` disconnects cleanly

---

## Phase 5: Tauri ↔ React Bridge

**Goal:** Connect Rust MCP handlers to React services

### Step 5.1: Create MCP Event Types

**File:** `src-react/types/mcp.ts`

```typescript
export interface McpCommand {
  requestId: string
  tool: 'list_agents' | 'join_meeting' | 'get_status' | 'leave_meeting'
  params: Record<string, unknown>
}

export interface McpResponse {
  requestId: string
  result?: unknown
  error?: { code: number; message: string }
}
```

### Step 5.2: Create MCP Bridge Hook

**File:** `src-react/hooks/useMcpBridge.ts`

- Listen for `mcp:command` events from Rust
- Route to appropriate handler based on tool name
- Call existing services/stores
- Invoke `mcp_respond` command with result

### Step 5.3: Implement Tool Handlers in React

**File:** `src-react/services/mcpHandlers.ts`

- `handleListAgents()` - Read from agentStore, filter sensitive fields
- `handleJoinMeeting()` - Call existing join flow
- `handleGetStatus()` - Read from callStore session
- `handleLeaveMeeting()` - Call existing leave flow

### Step 5.4: Mount Bridge in App

**File:** `src-react/App.tsx`

- Add `useMcpBridge()` hook at app root
- Ensure it initializes after stores are ready

### Step 5.5: Verification

- [ ] MCP `list_agents` → React responds → Rust receives
- [ ] MCP `join_meeting` → React joins → UI updates
- [ ] MCP `get_status` → Reflects current UI state
- [ ] MCP `leave_meeting` → React leaves → UI updates

---

## Phase 6: Configuration UI

**Goal:** Settings panel for MCP server management

### Step 6.1: Add MCP Config to Store

**File:** `src-react/stores/configStore.ts`

```typescript
interface McpConfig {
  enabled: boolean
  port: number           // Default: 3100
  autoStart: boolean     // Start with app
}
```

### Step 6.2: Create MCP Settings Section

**File:** `src-react/components/pages/SettingsPage.tsx`

- Toggle: Enable MCP Server
- Port input (validated 1024-65535)
- Auto-start toggle
- API Key display (masked, copy button)
- Regenerate API Key button (with confirmation)
- Server status indicator (running/stopped)
- Start/Stop button

### Step 6.3: Display Connected Clients (Optional)

- Show count of active MCP sessions
- Last request timestamp

### Step 6.4: Verification

- [ ] Toggle enables/disables server
- [ ] Port change requires restart
- [ ] API key displayed masked
- [ ] Copy button works
- [ ] Regenerate creates new key
- [ ] Status reflects actual server state

---

## Phase 7: Testing & Validation

**Goal:** Ensure security and functionality

### Step 7.1: Unit Tests (Rust)

**File:** `src-tauri/src/mcp/tests.rs`

- JSON-RPC parsing
- Auth validation
- Rate limiting
- Tool schema validation

### Step 7.2: Integration Tests

**File:** `src-react/__tests__/mcp/`

- Bridge event flow
- Tool handler responses
- Session lifecycle

### Step 7.3: Security Testing

Manual checklist:

- [ ] No secrets in `list_agents` response
- [ ] Invalid token returns 401 (no info leak)
- [ ] Rate limiting works
- [ ] Server only accessible on localhost
- [ ] API key not in logs
- [ ] Session IDs are unpredictable (UUID v4)

### Step 7.4: MCP Compliance Testing

Using MCP Inspector or similar:

- [ ] `initialize` handshake works
- [ ] `tools/list` returns correct schemas
- [ ] `tools/call` executes tools
- [ ] Error responses are valid JSON-RPC

---

## Phase 8: Deployment Hardening

**Goal:** Production-ready for cloud VM

### Step 8.1: Reverse Proxy Configuration

**Example:** nginx config

```nginx
server {
    listen 443 ssl http2;
    server_name cab.yourdomain.com;
    
    ssl_certificate /etc/letsencrypt/live/cab.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cab.yourdomain.com/privkey.pem;
    ssl_protocols TLSv1.3;
    
    # IP allowlist
    allow 203.0.113.0/24;  # Your allowed IPs
    deny all;
    
    # Rate limiting
    limit_req_zone $binary_remote_addr zone=mcp:10m rate=10r/m;
    
    location /mcp {
        limit_req zone=mcp burst=5 nodelay;
        
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeouts for long-polling/streaming
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

### Step 8.2: Firewall Rules

- Block port 3100 from external access
- Only allow 443 from allowed IPs
- Enable logging for denied requests

### Step 8.3: Monitoring

- Log all MCP requests to file (rotation enabled)
- Alert on auth failures (potential attack)
- Monitor session count (unexpected spikes)

### Step 8.4: Documentation

- Deployment guide for cloud VM
- API key rotation procedure
- Troubleshooting common issues

---

## Rollback Plan

If issues arise at any phase:

### Phase 1 Rollback
- Remove session fields from stores
- No external impact

### Phase 2-3 Rollback
- Comment out MCP server initialization in main.rs
- Remove Cargo dependencies
- App functions normally without MCP

### Phase 4-5 Rollback
- Disable MCP in config
- Server won't start
- All existing functionality preserved

### Phase 6 Rollback
- Hide MCP settings section
- Keep backend intact for later

### Emergency Rollback
- Set `mcp.enabled = false` in config
- Restart app
- MCP completely disabled, app works normally

---

## Implementation Checklist

| Phase | Step | Status | Notes |
|-------|------|--------|-------|
| 1 | 1.1 Session types | ⬜ | |
| 1 | 1.2 Call store updates | ⬜ | |
| 1 | 1.3 Hook integration | ⬜ | |
| 1 | 1.4 Verification | ⬜ | |
| 2 | 2.1 Cargo deps | ⬜ | |
| 2 | 2.2 Module structure | ⬜ | |
| 2 | 2.3 Protocol types | ⬜ | |
| 2 | 2.4 HTTP server | ⬜ | |
| 2 | 2.5 Lifecycle commands | ⬜ | |
| 2 | 2.6 Tauri integration | ⬜ | |
| 2 | 2.7 Verification | ⬜ | |
| 3 | 3.1 Key generation | ⬜ | |
| 3 | 3.2 Secure storage | ⬜ | |
| 3 | 3.3 Auth middleware | ⬜ | |
| 3 | 3.4 Rate limiting | ⬜ | |
| 3 | 3.5 Verification | ⬜ | |
| 4 | 4.1 Tool schemas | ⬜ | |
| 4 | 4.2 list_agents | ⬜ | |
| 4 | 4.3 join_meeting | ⬜ | |
| 4 | 4.4 get_status | ⬜ | |
| 4 | 4.5 leave_meeting | ⬜ | |
| 4 | 4.6 Verification | ⬜ | |
| 5 | 5.1 Event types | ⬜ | |
| 5 | 5.2 Bridge hook | ⬜ | |
| 5 | 5.3 Tool handlers | ⬜ | |
| 5 | 5.4 App mount | ⬜ | |
| 5 | 5.5 Verification | ⬜ | |
| 6 | 6.1 Config store | ⬜ | |
| 6 | 6.2 Settings UI | ⬜ | |
| 6 | 6.3 Client display | ⬜ | |
| 6 | 6.4 Verification | ⬜ | |
| 7 | 7.1 Unit tests | ⬜ | |
| 7 | 7.2 Integration tests | ⬜ | |
| 7 | 7.3 Security testing | ⬜ | |
| 7 | 7.4 MCP compliance | ⬜ | |
| 8 | 8.1 Reverse proxy | ⬜ | |
| 8 | 8.2 Firewall | ⬜ | |
| 8 | 8.3 Monitoring | ⬜ | |
| 8 | 8.4 Documentation | ⬜ | |

---

## References

- [MCP HTTP Streamable Specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http)
- [Tauri IPC Documentation](https://tauri.app/develop/calling-rust/)
- [Axum Web Framework](https://docs.rs/axum/latest/axum/)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
