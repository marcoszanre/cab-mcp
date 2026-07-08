# Copilot Instructions — Community Agent Bridge (CAB)

## Build, Test, and Lint

```powershell
npm run tauri:dev        # Full Tauri dev mode (Rust + React with hot reload)
npm run dev              # Vite dev server only (no Rust backend)
npm run tauri:build      # Production build (outputs to src-tauri/target/release/)
npm run build            # Frontend only: tsc && vite build
npm run typecheck        # TypeScript type checking (tsc --noEmit)
npm run lint             # ESLint on src-react/
npm run lint:fix         # ESLint with auto-fix
npm run format           # Prettier format src-react/
npm run format:check     # Prettier check only
npm run test             # Vitest (watch mode by default)
npx vitest run src-react/__tests__/stores/agentStore.test.ts  # Single test file
npx vitest run -t "test name"                                 # Single test by name
```

The Rust backend must be built separately with `cargo build` from `src-tauri/`. The full app requires both Rust toolchain and Node.js.

## Architecture

This is a **Tauri desktop app** (Rust backend + React frontend) that joins Microsoft Teams meetings as an AI agent. It listens for mentions in closed captions, sends questions to an AI agent (Copilot Studio or Azure AI Foundry), and speaks responses via TTS.

### Multi-Session Hierarchy

```
SessionManager (singleton, outside React)
  └── Session (one per Teams meeting URL)
        └── AgentInstance (one ACS identity per agent in a meeting)
              └── AgentServiceContainer (owns all per-agent services)
                    ├── AcsCallService
                    ├── MeetingChatService
                    ├── TextToSpeechService
                    ├── CallAnalyticsService
                    ├── CaptionAggregationService
                    ├── AudioBridge
                    └── AgentMeetingOrchestrator ("the brain")
```

- **SessionManager** (`src-react/services/sessionManager.ts`) — app-level singleton managing all sessions. Accessed in React via `SessionManagerContext`.
- **AgentServiceContainer** (`src-react/services/agentServiceContainer.ts`) — per-agent service bundle. Created on join, disposed on leave.
- **AgentMeetingOrchestrator** (`src-react/services/agentMeetingOrchestrator.ts`) — handles autonomous agent behavior: caption monitoring, intent detection, agent communication, and response delivery.

### Agent Provider System

Agent providers implement `IAgentProvider` (`src-react/types/agent-provider.ts`):
- `CopilotStudioAgentProvider` — uses OAuth2 Device Code Flow
- `AzureFoundryAgentProvider` — uses Service Principal or API key auth

### Agent Behavior Patterns

Configurable via `AgentBehaviorPattern` (`src-react/types/behavior.ts`):
- **Trigger sources**: `caption-mention` | `chat-mention`
- **Response channels**: `chat` | `speech` | `both`
- **Behavior modes**: `immediate` | `controlled` (needs approval) | `queued` (raise hand)

### State Management

Zustand stores in `src-react/stores/`, with non-sensitive UI state persisted to localStorage and all configuration (including secrets) stored in `cab-config.json` via `configFileService.ts`. The config file supports `${ENV_VAR}` substitution resolved at load time by Rust.

Key stores: `configStore` (Azure service configs), `agentStore` / `agentProvidersStore` (agent configs), `sessionStore` (multi-session state), `agentBehaviorStore` (trigger/response patterns), `preferencesStore` (UI prefs), `navigationStore` (page routing).

### Rust Backend (src-tauri/)

- `src/main.rs` — Tauri entry point
- `src/commands.rs` — Tauri IPC commands
- `src/mcp/` — Built-in MCP server (Streamable HTTP via `rmcp` + `axum`) that exposes tools for programmatic meeting control (join, leave, get status, list sessions)

### Frontend Structure

- `src-react/components/pages/` — top-level pages: Sessions, Agents, Settings
- `src-react/components/ui/` — shadcn/ui primitives
- `src-react/components/layout/` — AppShell, Sidebar, WindowControls
- `src-react/hooks/` — React hooks (`useMeetingAgent`, `useMcpBridge`, `useSessionManager`)
- `src-react/services/` — service classes, singletons via `getXxxService()` factory pattern
- `src-react/lib/logger.ts` — centralized logger with ring buffer for production debugging

## Key Conventions

- **Path alias**: `@/` maps to `src-react/` (configured in `vite.config.ts`, `tsconfig.json`, and `vitest.config.ts`)
- **Imports**: Use `@/` alias for all cross-module imports within `src-react/`
- **Service singletons**: Services use `getXxxService()` factory functions (e.g., `getSessionManager()`, `getAcsCallService()`)
- **Logging**: Use `loggers.xxx` from `@/lib/logger` (e.g., `loggers.app`, `loggers.acs`, `loggers.speech`). Never use bare `console.log`; ESLint warns on `console` except `warn`/`error`.
- **Secure fields**: Secrets (API keys, access keys, client secrets) are stored in `cab-config.json` and can use `${ENV_VAR}` references. The config file lives in the app data directory, never in localStorage.
- **Environment variables**: Prefixed with `VITE_` (exposed to frontend). Only loaded from `.env` in dev mode; production uses the Settings UI.
- **UI components**: shadcn/ui + Radix primitives with Tailwind CSS. Use `cn()` from `@/lib/utils` for class merging.
- **TypeScript**: Strict mode enabled. Avoid `any` (ESLint warns). Unused vars prefixed with `_` are allowed.
- **Tests**: Vitest + Testing Library + jsdom. Tests go in `src-react/__tests__/` mirroring the source structure. Test setup mocks `import.meta.env`.
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- **Dev helpers**: In dev mode, `window.cab` exposes session test helpers (fake sessions, captions, status). `window.__dumpLogs()` dumps the logger ring buffer.
