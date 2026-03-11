# Community Agent Bridge (CAB)

<p align="center">
  <img src="images/logo_new.png" alt="Community Agent Bridge" width="120" />
</p>

> **MCP-First AI Agent Bridge for Microsoft Teams Meetings**

A desktop application that enables AI agents to join and participate in Microsoft Teams meetings. Built with Tauri (Rust + React), it exposes an MCP (Model Context Protocol) server over HTTP Streamable transport with API key authentication, allowing remote MCP clients to orchestrate agent participation programmatically.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Azure Resource Setup](#azure-resource-setup)
  - [Azure Communication Services](#1-azure-communication-services-acs)
  - [Azure Speech Service](#2-azure-speech-service)
  - [Azure OpenAI](#3-azure-openai)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Agent Types](#agent-types)
  - [Copilot Studio](#copilot-studio)
  - [Azure AI Foundry](#azure-ai-foundry)
  - [Azure OpenAI Agent (Coming Soon)](#azure-openai-agent-coming-soon)
- [Agent Behavior & Interaction Modes](#agent-behavior--interaction-modes)
  - [Reactive Mode (Caption & Chat Mentions)](#reactive-mode-caption--chat-mentions)
  - [Proactive Mode (Role-Play)](#proactive-mode-role-play)
  - [Welcome Messages](#welcome-messages)
  - [Idle Timeout (Auto-Leave)](#idle-timeout-auto-leave)
  - [Response Channels](#response-channels)
  - [Text-to-Speech Customization](#text-to-speech-customization)
- [MCP Tools](#mcp-tools)
- [MCP Authentication (API Key)](#mcp-authentication-api-key)
- [Development](#development)
- [Building & Distribution](#building--distribution)
- [Security](#security)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Overview

Community Agent Bridge (CAB) is an **MCP server** that programmatically bridges AI agents into Microsoft Teams meetings. Remote MCP clients (such as VS Code Copilot, custom orchestrators, or other AI agents) connect to CAB over HTTP Streamable transport to:

1. **List** available agent configurations
2. **Join** a Teams meeting with a specified agent
3. **Monitor** active sessions and their status
4. **Leave** meetings cleanly

When an agent joins a meeting, it automatically detects questions from closed captions, sends them to the configured AI agent (Copilot Studio or Azure AI Foundry), and speaks the response back via Text-to-Speech.

**Use Cases:**
- AI assistants joining Teams calls on demand via MCP
- Orchestrating multiple agents across concurrent meetings
- Programmatic meeting control from AI workflows
- Knowledge base assistants for internal meetings

---

## Features

### Agent Interaction
- **Reactive mode** — Agent listens for mentions in live captions or Teams chat and responds automatically
- **Proactive mode (Role-Play)** — Agent monitors meeting silence and contributes proactively based on configurable role instructions
- **Multi-agent per meeting** — Multiple agents can join the same meeting, each with independent behavior and configuration
- **Multi-session management** — Run concurrent agents across multiple Teams meetings simultaneously (up to 50)

### AI Agent Providers
- **Copilot Studio** — OAuth2 Device Code Flow authentication
- **Azure AI Foundry** — Service Principal or API Key authentication
- **Azure OpenAI** *(Coming Soon)* — Direct model access with custom system prompts

### Voice & Speech
- **Azure Speech** — 26+ multilingual Neural voices with speaking styles (chat, friendly, cheerful, empathetic, calm, neutral)
- **Streaming TTS** — Real-time audio streaming for low-latency voice responses
- **Adjustable speech rate** — 0.5×–2.0×

### Chat Integration
- **Teams chat responses** — Send responses directly to the meeting chat
- **Configurable response channels** — Choose speech, chat, or both per agent

### Automation
- **Welcome messages** — Greet the meeting on join: static message, or agent-generated welcome from a prompt
- **Idle timeout** — Auto-leave when agent is alone in the meeting (configurable timer + warning message)

### MCP Server
- **HTTP Streamable transport** — Standard MCP protocol over HTTP
- **API key authentication** — Auto-generated 32-character hex key, stored in config file
- **Rate limiting** — Built-in sliding-window rate limiter (60 requests/minute)
- **Auto-start** — Optionally start MCP server automatically with the app
- **Session retention** — Auto-cleanup of ended sessions (configurable 1–60 minutes)

### Configuration & Storage
- **Single config file** — All settings, agents, and secrets in one human-editable `cab-config.json`
- **`${ENV_VAR}` substitution** — Reference environment variables in any config value; resolved at load time
- **Export/import** — Back up, share, or migrate configuration between machines
- **Localhost-only binding** — MCP server binds to `127.0.0.1`, never `0.0.0.0`
- **No secrets in MCP responses** — `list_agents` tool never exposes credentials

### Meeting Intelligence
- **Caption aggregation** — Groups live captions into meaningful segments
- **Participant tracking** — Monitors participants, speaking state, and mute status
- **Meeting analytics** — Call duration, participant count, questions detected, response metrics
- **TTS text preprocessing** — AI-powered cleanup of citations, URLs, and markdown before speech synthesis

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                   Community Agent Bridge                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────┐    IPC Events    ┌────────────────────────────┐ │
│  │  React UI   │◄────────────────►│     Tauri Backend (Rust)   │ │
│  │  (WebView)  │                  │                            │ │
│  │             │                  │  ┌──────────────────────┐  │ │
│  │  • Stores   │                  │  │   MCP Server         │  │ │
│  │  • Services │                  │  │   HTTP Streamable    │  │ │
│  │  • Hooks    │                  │  │   + API Key Auth     │  │ │
│  └─────────────┘                  │  │   :3100 (localhost)  │  │ │
│                                   │  └──────────┬───────────┘  │ │
│                                   └─────────────┼──────────────┘ │
└─────────────────────────────────────────────────┼────────────────┘
                                                  │
                                                  ▼
                                          Remote MCP Clients
                                      (VS Code, Orchestrators, etc.)
```

### Key Components

- **MCP Server** (`src-tauri/src/mcp/`) — Rust-based HTTP Streamable MCP server using `rmcp` + `axum`. Handles tool routing and API key authentication.
- **MCP Bridge** (`src-tauri/src/mcp/bridge.rs`) — IPC bridge between Rust tool handlers and the React frontend via Tauri events.
- **Agent Providers** — `CopilotStudioAgentProvider` (OAuth2 Device Code Flow) and `AzureFoundryAgentProvider` (Service Principal / API Key auth).
- **Session Manager** (`src-react/services/sessionManager.ts`) — Manages multiple concurrent meeting sessions, each with its own agent instance and service container.
- **Agent Meeting Orchestrator** (`src-react/services/agentMeetingOrchestrator.ts`) — Per-agent brain: caption monitoring, intent detection, agent communication, and TTS response delivery.

### Project Structure

```
teams_agent_bridge/
├── src-react/                    # React + TypeScript frontend
│   ├── components/              # UI components (pages, layout, ui primitives)
│   ├── hooks/                   # Custom React hooks (useMcpBridge, useSessionManager)
│   ├── services/                # Service layer (ACS, TTS, agents, orchestrator)
│   ├── stores/                  # Zustand state management (persisted + secure)
│   └── types/                   # TypeScript type definitions
├── src-tauri/                   # Tauri backend (Rust)
│   ├── src/main.rs             # Rust entry point
│   ├── src/commands.rs         # Tauri IPC commands (credentials, MCP lifecycle)
│   ├── src/mcp/               # MCP server module
│   │   ├── server.rs          # HTTP Streamable server lifecycle
│   │   ├── tools.rs           # MCP tool definitions (list_agents, join, leave, etc.)
│   │   ├── auth.rs            # API key validation middleware + rate limiting
│   │   ├── bridge.rs          # Rust ↔ React IPC bridge
│   │   └── state.rs           # Shared MCP server state
│   └── tauri.conf.json         # Tauri configuration
├── index.html                   # Application entry
└── package.json                 # Node dependencies
```

---

## Prerequisites

Before building, ensure you have:

1. **Node.js** (v18 or later) — [Download](https://nodejs.org/)
2. **Rust** (latest stable) — [Install via rustup](https://rustup.rs/)
3. **Visual Studio Build Tools** (Windows only)
   - Install from [Visual Studio](https://visualstudio.microsoft.com/downloads/)
   - Select "Desktop development with C++"

### Azure Resources Required

| Resource | Purpose |
|----------|---------|
| Azure Communication Services | Joining Teams meetings as an ACS identity |
| Azure Speech Service | Text-to-Speech voice synthesis (Azure Neural voices) |
| Azure OpenAI | Intent detection & TTS text preprocessing |
| Copilot Studio / Azure AI Foundry | The AI agent that answers questions |

---

## Azure Resource Setup

### 1. Azure Communication Services (ACS)

ACS provides the identity and calling infrastructure to join Teams meetings.

**Create the resource:**

1. Go to the [Azure Portal](https://portal.azure.com/) → **Create a resource** → search **Communication Services**
2. Select **Create** and fill in:
   - **Subscription** and **Resource Group**
   - **Resource Name** (e.g., `cab-acs`)
   - **Data location** (choose your region)
3. Click **Review + Create** → **Create**

**Retrieve credentials:**

1. Open your ACS resource → **Settings** → **Keys**
2. Copy the following values to enter in the CAB Settings UI:

| CAB Settings Field | Where to Find |
|-------------------|---------------|
| **Endpoint** | The **Endpoint** URL (e.g., `https://cab-acs.unitedstates.communication.azure.com/`) |
| **Access Key** | **Key 1** or **Key 2** (either works) |

> **Note:** ACS requires [Teams interoperability](https://learn.microsoft.com/en-us/azure/communication-services/concepts/teams-interop) to be enabled. Ensure your Azure tenant allows ACS to join Teams meetings.

### 2. Azure Speech Service

The Speech Service provides Neural Text-to-Speech for agent voice responses.

**Create the resource:**

1. Go to the [Azure Portal](https://portal.azure.com/) → **Create a resource** → search **Speech**
2. Select **Speech** (under Azure AI services) → **Create**
3. Fill in:
   - **Subscription** and **Resource Group**
   - **Region** (e.g., `East US`) — note this, you'll need it
   - **Name** (e.g., `cab-speech`)
   - **Pricing tier** — Free (F0) for testing, Standard (S0) for production
4. Click **Review + Create** → **Create**

**Retrieve credentials:**

1. Open your Speech resource → **Resource Management** → **Keys and Endpoint**
2. Copy the following values:

| CAB Settings Field | Where to Find |
|-------------------|---------------|
| **Key** | **Key 1** or **Key 2** |
| **Region** | The **Location/Region** (e.g., `eastus`) |

### 3. Azure OpenAI

Azure OpenAI is used for TTS text preprocessing (removing citations, URLs, and formatting for natural speech) and intent detection.

**Create the resource:**

1. Go to the [Azure Portal](https://portal.azure.com/) → **Create a resource** → search **Azure OpenAI**
2. Select **Create** and fill in:
   - **Subscription** and **Resource Group**
   - **Region** (e.g., `East US`)
   - **Name** (e.g., `cab-openai`)
   - **Pricing tier** — Standard (S0)
3. Click **Review + Create** → **Create**

**Deploy a model:**

1. Open your Azure OpenAI resource → **Go to Azure AI Foundry portal**
2. Navigate to **Deployments** → **Create new deployment**
3. Select a model (e.g., `gpt-4o-mini` or `gpt-4o`) and give it a deployment name
4. Note the **deployment name** — you'll enter this in CAB

**Retrieve credentials:**

1. Back in the Azure Portal, open your OpenAI resource → **Resource Management** → **Keys and Endpoint**
2. Copy the following values:

| CAB Settings Field | Where to Find |
|-------------------|---------------|
| **Endpoint** | The **Endpoint** URL (e.g., `https://cab-openai.openai.azure.com/`) |
| **API Key** | **Key 1** or **Key 2** |
| **Deployment** | The deployment name you chose (e.g., `gpt-4o-mini`) |

---

## Quick Start

### 1. Clone and Install

```powershell
git clone https://github.com/marcoszanre/teams-agent-bridge.git
cd teams-agent-bridge
npm install
```

### 2. Run in Development Mode

```powershell
npm run tauri:dev
```

### 3. Configure via the UI

1. **Settings** → Configure Azure services (ACS, Speech, OpenAI)
2. **Agents** → Add your AI agent configuration (Copilot Studio or Azure AI Foundry)
3. **Start MCP Server** → The server starts on the configured port (default `3100`) with an auto-generated API key

### 4. Connect an MCP Client

Point your MCP client to `http://127.0.0.1:3100/mcp`. Authenticate using the API key from Settings → MCP Server, sent as `Authorization: Bearer <api-key>` or `X-API-Key: <api-key>` header.

---

## Configuration

All configuration is stored in a single **`cab-config.json`** file that you can edit from the Settings UI or with any text editor. A reference template is available at [`cab-config.sample.json`](cab-config.sample.json).

The file supports **`${ENV_VAR}` references** so you can keep secrets out of the file and pull them from environment variables instead.

### Config File Location

| OS | Path |
|----|------|
| Windows | `%APPDATA%\com.communityagentbridge.app\cab-config.json` |
| macOS | `~/Library/Application Support/com.communityagentbridge.app/cab-config.json` |

The path is also shown in the Settings UI.

### Config File Structure

```jsonc
{
  "config": {
    "speech": {
      "region": "eastus2",
      "key": "$env:CAB_SPEECH_KEY"              // ← env var reference
    },
    "acs": {
      "endpoint": "https://your-acs.communication.azure.com/",
      "accessKey": "$env:CAB_ACS_KEY"
    },
    "openai": {
      "endpoint": "https://your-openai.openai.azure.com",
      "apiKey": "$env:CAB_OPENAI_KEY",
      "deployment": "gpt-4o"
    }
  },
  "meetingBehavior": {
    "autoLeave": {
      "enabled": true,
      "timeoutMinutes": 5,
      "warningBeforeLeaveMs": 60000
    }
  },
  "mcpConfig": {
    "apiKey": "auto-generated-hex-key",
    "port": 3100,
    "autoStart": true,
    "maxConcurrentSessions": 10,
    "sessionRetentionMinutes": 5
  },
  "agents": [
    {
      "id": "...",
      "name": "My Agent",
      "type": "copilot-studio",                // auth type inferred from type
      "settings": { ... }
    }
  ]
}
```

> **See [`cab-config.sample.json`](cab-config.sample.json) for a complete example with all fields.**

### Using Environment Variables (`${ENV_VAR}`)

Any string value in the config file can reference an environment variable using `${VAR_NAME}` or `$env:VAR_NAME` (PowerShell) syntax:

```json
"accessKey": "$env:CAB_ACS_KEY"
```

**Resolution order** (highest priority first):
1. **Process environment** — variables already set in the shell or OS
2. **`env` block** — fallback values defined in the config file itself (never overrides process env)
3. **Empty string** — if the variable is not found anywhere

This means you can:
- **Hardcode values** directly: `"accessKey": "my-actual-key"`
- **Reference env vars**: `"accessKey": "${ACS_ACCESS_KEY}"`
- **Provide fallbacks** in the `env` block for machines that don't have the env vars set

### The `env` Block

The optional `env` block provides inline fallback values that are used only when the referenced variable is missing from the process environment:

```json
{
  "env": {
    "OPENAI_API_KEY": "sk-fallback-key",
    "SPEECH_KEY": "fallback-speech-key"
  }
}
```

These values **never override** existing process environment variables.

### Export & Import

- **Export**: Settings → Export config to save a copy of `cab-config.json`
- **Import**: Settings → Import config to load a config file from another machine
- **Manual editing**: Open the file in any text editor — changes are loaded on next app launch

### Azure Services

| Service | Config Fields | Purpose |
|---------|--------------|---------|
| Azure Communication Services | `acs.endpoint`, `acs.accessKey` | Joining Teams meetings |
| Azure Speech Service | `speech.key`, `speech.region` | Text-to-Speech voice synthesis |
| Azure OpenAI | `openai.endpoint`, `openai.apiKey`, `openai.deployment` | Intent detection & TTS preprocessing |

### MCP Server

| Setting | Default | Description |
|---------|---------|-------------|
| `port` | `3100` | HTTP Streamable server port (1024–65535) |
| `maxConcurrentSessions` | `10` | Maximum parallel meeting sessions (1–50) |
| `sessionRetentionMinutes` | `5` | Auto-cleanup period for ended sessions (1–60 min) |
| `autoStart` | `false` | Start MCP server automatically with the app |
| `apiKey` | Auto-generated | 32-character hex key for MCP client authentication |

---

## Agent Types

### Copilot Studio

Connect to agents built in [Microsoft Copilot Studio](https://copilotstudio.microsoft.com/).

**Authentication:** OAuth2 Device Code Flow — the user authenticates interactively via a browser code prompt. The auth type is inferred automatically from the agent type.

| Field | Description |
|-------|-------------|
| `clientId` | Application/Client ID of the Copilot Studio app registration |
| `tenantId` | Azure AD tenant ID |
| `environmentId` | Copilot Studio environment ID (from the Power Platform admin center) |
| `botId` | Bot/Agent identifier (from Copilot Studio agent settings) |

**Setup:**
1. Create or select an agent in [Copilot Studio](https://copilotstudio.microsoft.com/)
2. Publish the agent
3. Note the environment ID and bot ID from the agent's settings
4. In CAB → **Agents** → **Add Agent** → select **Copilot Studio**
5. Fill in the configuration fields
6. On first use, you'll be prompted with a device code to authenticate in your browser

### Azure AI Foundry

Connect to agents deployed in [Azure AI Foundry](https://ai.azure.com/).

**Authentication:** Service Principal (client credentials). The auth type is inferred automatically — no need to specify it in the config.

| Field | Description |
|-------|-------------|
| `projectEndpoint` | AI Foundry project endpoint URL |
| `agentName` | Agent name/ID within the Foundry project |
| `region` | Azure region |
| `tenantId` | Azure AD tenant ID |
| `clientId` | Service principal application ID |
| `clientSecret` | Service principal secret |

**Setup:**
1. Create an agent in [Azure AI Foundry](https://ai.azure.com/)
2. Deploy it and note the project endpoint and agent name
3. Create a service principal for authentication
4. In CAB → **Agents** → **Add Agent** → select **Azure AI Foundry**
5. Fill in the configuration fields

### Azure OpenAI Agent (Coming Soon)

> **Status:** Type definitions are in place, but the provider implementation and UI are not yet available.

Use an Azure OpenAI model directly as a conversational agent with a custom system prompt.

**Authentication:** API Key.

| Field | Description |
|-------|-------------|
| `endpoint` | Azure OpenAI service endpoint URL |
| `deployment` | Model deployment name (e.g., `gpt-4o`) |
| `apiKey` | Azure OpenAI API key |
| `systemPrompt` | Custom system instructions defining the agent's persona and behavior |

**Setup:**
1. Deploy a chat model in Azure OpenAI (see [Azure OpenAI setup](#3-azure-openai))
2. In CAB → **Agents** → **Add Agent** → select **Azure OpenAI** *(once available)*
3. Enter the endpoint, deployment name, and API key
4. Write a system prompt to define how the agent should behave in meetings

---

## Agent Behavior & Interaction Modes

Each agent's behavior is configurable through the Agents UI. Agents can operate in reactive mode, proactive mode, or both.

### Reactive Mode (Caption & Chat Mentions)

In reactive mode, the agent listens for its name in meeting captions or chat messages and responds when mentioned.

**Trigger sources:**
- **Caption mention** — Agent is mentioned in live closed captions (e.g., someone says "Hey AgentName, what is...")
- **Chat mention** — Agent is mentioned in the Teams meeting chat

When triggered, the agent sends the detected question to the configured AI provider and delivers the response through the configured response channel.

**Caption detection** uses fuzzy name matching with configurable thresholds. When confidence is ambiguous, GPT-powered validation can confirm whether the agent was actually addressed.

### Proactive Mode (Role-Play)

In proactive mode, the agent monitors meeting activity and contributes autonomously based on role instructions — without being explicitly mentioned.

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `false` | Toggle proactive behavior on/off |
| `instructions` | — | System-level role and behavior instructions (e.g., "You are a meeting facilitator...") |
| `silenceThresholdMs` | `10000` | Silence duration (ms) before the agent evaluates whether to contribute |
| `responseChannel` | `speech` | How proactive responses are delivered: `speech`, `chat`, or `auto` |
| `turnTakingMode` | `interview-safe` | Spoken turn policy: `interview-safe` keeps the floor once the agent starts speaking; `interruptible` preserves barge-in behavior |
| `autoLeaveOnCompletion` | `false` | When enabled, the agent can leave the meeting by including `[LEAVE_MEETING]` in its response |
| `goodbyeMessage` | — | Fallback farewell text if the agent doesn't include one before `[LEAVE_MEETING]` |
| `goodbyeChannel` | `both` | Delivery channel for the goodbye message: `speech`, `chat`, or `both` |

**Auto response channel (`auto`):** When `responseChannel` is set to `auto`, the agent picks the channel based on recent meeting activity — if someone used the chat in the last 30 seconds, it responds via chat; otherwise, it responds via speech.

**Turn-taking modes:** `interview-safe` is the recommended default for interviews, mock interviews, coaching, and role-play. In that mode, once the agent starts a spoken proactive turn it does not cut itself off when a human caption arrives; instead it buffers the overlapping caption and uses it as the human's reply after speech completes. `interruptible` keeps the legacy behavior where any human caption can stop the spoken response immediately.

**Auto-leave on completion:** When `autoLeaveOnCompletion` is enabled, the agent can gracefully exit the meeting by including `[LEAVE_MEETING]` at the end of its response. Any text before the tag is used as the farewell message. If no farewell text is provided, the configured `goodbyeMessage` is used (or a default: "Goodbye everyone — thanks for the session!"). The goodbye is delivered via the configured `goodbyeChannel`.

**Intelligent silence detection:** The agent doesn't simply fire after a fixed timer. It uses several adaptive mechanisms:
- **Speaking momentum** — If the meeting was recently active (many captions in the last 30 seconds), the silence threshold is multiplied (up to 3×) to avoid interrupting mid-thought
- **Turn protection** — In `interview-safe` mode, proactive TTS keeps the floor once it starts speaking, while overlapping human captions are buffered and considered the next reply instead of forcing the speaker to repeat themselves
- **Exponential backoff** — Each time the agent evaluates silence and decides not to act (`[NO_ACTION]`), the effective threshold doubles, preventing excessive polling during quiet periods
- **Waiting-for-human** — After a proactive response, the agent pauses until a human speaks before evaluating again (hardcoded max 1 consecutive proactive action)
- **`[NO_ACTION]` sentinel** — The AI can respond with `[NO_ACTION]` to explicitly decline contributing, which is handled silently (no message sent)

**Prompt builder (CraftPromptPanel):** The UI includes a guided prompt generator for proactive instructions. Specify a goal, scenario, tone (Professional, Friendly, Technical, Casual, Empathetic), and constraints — the panel generates structured instructions including `[NO_ACTION]` guidance.

### Welcome Messages

Each agent can be configured to send a welcome message when it joins a meeting.

| Mode | Description |
|------|-------------|
| **Default** | No custom welcome — agent joins silently or with a standard greeting |
| **Custom** | A static message you define is sent to the meeting chat on join |
| **Agent-triggered** | A prompt is sent to the AI agent on join, and the agent's response is used as the welcome message |

Configure welcome messages in the **Agents** page under each agent's settings.

### Idle Timeout (Auto-Leave)

Agents can automatically leave a meeting when no other participants are present, avoiding zombie sessions. This is configured in `meetingBehavior.autoLeave` in the config file and also editable from **Settings** → **Meeting Behavior**.

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Toggle idle auto-leave on/off |
| `timeoutMinutes` | `5` | Minutes of being alone before auto-leaving (1–60) |
| `warningBeforeLeaveMs` | `60000` | How long before the timeout to send a warning message (in ms) |

**How it works:**
1. When all other participants leave, the countdown begins
2. A warning message is posted to chat (e.g., "⏳ No participants detected. I'll leave in 60 seconds unless someone joins.")
3. If no one joins before the timeout, the agent disconnects
4. If a participant joins at any point during the countdown, the timer resets

Configure idle timeout in **Settings** → **Meeting Behavior**, or edit `meetingBehavior.autoLeave` in `cab-config.json` directly.

### Response Channels

Each agent can be configured to respond via:

| Channel | Description |
|---------|-------------|
| **Speech** | Agent speaks the response via TTS (Text-to-Speech) into the meeting audio |
| **Chat** | Agent posts the response as a message in the Teams meeting chat |

For reactive (caption-triggered) responses, the `captionResponseAsChat` flag can override the default speech response to use chat instead. Proactive mode has its own `responseChannel` setting which additionally supports `auto` (see above).

### Text-to-Speech Customization

CAB uses **Azure Speech** for Text-to-Speech, configurable per-agent:

| Setting | Options | Default |
|---------|---------|---------|
| **Voice** | 26+ Azure Neural voices across multiple languages | `en-US-JennyNeural` |
| **Speaking style** | `chat`, `friendly`, `cheerful`, `empathetic`, `calm`, `neutral` | `chat` |
| **Style degree** | `0.01` (subtle) to `2.0` (intense) | `1.3` |
| **Speech rate** | `0.5` (slow) to `2.0` (fast) | `1.0` |

**Supported languages include:** English, French, German, Spanish, Portuguese, Italian, Chinese, Japanese, Korean, Dutch, Polish, Russian, Hindi, Arabic, Turkish, Swedish, and more.

#### Text Preprocessing

AI-powered text preprocessing (using Azure OpenAI):
- **Citation & URL removal** — Strips references, links, and markdown formatting
- **Speech optimization** — Rewrites text for natural spoken delivery (contractions, conversational openers)
- **Language detection** — Automatically detects the response language for proper voice selection

---

## MCP Tools

CAB exposes the following tools via the MCP protocol:

| Tool | Type | Description |
|------|------|-------------|
| `list_agents` | Read | List available agent configurations (IDs, names, types — no secrets) |
| `join_meeting` | Action | Join a Teams meeting with a specified agent config, returns a session ID |
| `list_sessions` | Read | List all active meeting sessions with status, agents, and uptime |
| `leave_meeting` | Action | Cleanly disconnect an agent from a meeting |

### Example: Connecting from an MCP Client

The server listens on `http://127.0.0.1:<port>/mcp` using HTTP Streamable transport. Clients must include the API key in the request header as `Authorization: Bearer <api-key>` or `X-API-Key: <api-key>`.

---

## MCP Authentication (API Key)

CAB secures the MCP server with **API key authentication**:

1. A **32-character hex API key** is automatically generated on first launch and stored in the config file
2. All requests to `/mcp` must include the API key via one of:
   - `Authorization: Bearer <api-key>` header
   - `X-API-Key: <api-key>` header
3. Requests without a valid API key receive a `401 Unauthorized` response
4. Built-in rate limiting (60 requests/minute) provides additional protection

### Viewing & Managing the API Key

1. Open CAB → **Settings** → **MCP Server** section
2. The API key is shown (masked by default) — click the eye icon to reveal
3. Use the **copy** button to copy the key to your clipboard
4. Use the **regenerate** button to create a new key (disconnects existing clients)

### Connecting from Copilot Studio

When configuring a custom connector in Copilot Studio for CAB:

1. Set authentication type to **API Key**
2. **Parameter label**: `API Key`
3. **Parameter name**: `X-API-Key`
4. **Parameter location**: Header
5. When creating the connection, paste the API key from CAB Settings

---

## Development

### Available Scripts

```powershell
npm run tauri:dev       # Full Tauri dev mode (Rust + React with hot reload)
npm run dev             # Vite dev server only (no Rust backend)
npm run tauri:build     # Production build
npm run build           # Frontend only: tsc && vite build
npm run typecheck       # TypeScript type checking (tsc --noEmit)
npm run lint            # ESLint on src-react/
npm run lint:fix        # ESLint with auto-fix
npm run format          # Prettier format src-react/
npm run format:check    # Prettier check only
npm run test            # Vitest (watch mode by default)
```

### Dev Helpers

In development mode, `window.cab` exposes test helpers in the browser console:

```js
cab.fake('BotName', 'https://teams.microsoft.com/...')  // Create a fake session
cab.fakeN(3)                                             // Create N fake sessions
cab.status()                                             // Show session status table
cab.list()                                               // List sessions (JSON)
cab.end('sessionIdPrefix')                               // End a session
cab.endAll()                                             // End all sessions
cab.caption('sessionIdPrefix', 'Test text')              // Inject test caption
cab.addAgent('sessionIdPrefix', 'BotName2')              // Add agent to session
```

Use `window.__dumpLogs()` to dump the logger ring buffer for debugging.

### Tech Stack

- **Frontend**: React 18, TypeScript, Tailwind CSS, shadcn/ui
- **State Management**: Zustand (config persisted to `cab-config.json`, UI state to localStorage)
- **Backend**: Tauri (Rust)
- **MCP Server**: `rmcp` + `axum` (HTTP Streamable transport)
- **Auth**: API key authentication + rate limiting
- **Testing**: Vitest, Testing Library
- **Build**: Vite

---

## Building & Distribution

### Build Production Executable

```powershell
npm run tauri:build
```

Output locations:
- **Executable**: `src-tauri/target/release/teams-agent-bridge.exe`
- **MSI Installer**: `src-tauri/target/release/bundle/msi/`
- **NSIS Installer**: `src-tauri/target/release/bundle/nsis/`

### Build Size Optimization

The `Cargo.toml` is configured for minimal binary size:
- LTO (Link Time Optimization) enabled
- Symbol stripping
- Size optimization (`opt-level = "s"`)

### Distribution Options

| Platform | Formats |
|----------|---------|
| Windows | `.msi` installer, `.exe` NSIS installer |
| macOS | `.dmg`, `.app` bundle |
| Linux | `.deb`, `.AppImage`, `.rpm` |

---

## Security

### Credential Storage

All secrets live in `cab-config.json` in the app data directory. The file is readable by the local OS user — the same threat model as SSH config, browser cookies, or `.env` files.

**To keep secrets out of the file**, use `${ENV_VAR}` references and manage the actual values through your OS environment:

```json
"accessKey": "$env:CAB_ACS_KEY",
"apiKey": "$env:CAB_OPENAI_KEY",
"clientSecret": "$env:CAB_FOUNDRY_CLIENT_SECRET"
```

This way the config file can be safely committed, shared, or exported without exposing credentials.

### MCP Server Security

- **Localhost only** — The MCP server binds to `127.0.0.1`, never `0.0.0.0`
- **API key required** — Auto-generated API key must be provided on every request
- **Rate limiting** — Built-in sliding-window rate limiter (60 requests/minute)
- **No secrets in MCP responses** — `list_agents` never returns credentials or API keys
- **Reverse proxy recommended** — For remote access, use nginx/caddy with HTTPS termination and IP allowlisting

### Best Practices

1. Use `${ENV_VAR}` references for sensitive values (API keys, access keys, client secrets)
2. Keep the MCP API key secret — treat it like a password
3. Use a reverse proxy with TLS for remote MCP access
4. Rotate credentials regularly (use the Regenerate button in Settings)
5. Never commit `.env` files or `cab-config.json` files that contain hardcoded secrets

---

## Contributing

We welcome contributions! Here's how to get started:

1. **Fork** the repository
2. **Clone** your fork locally
3. **Create a branch**: `git checkout -b feature/my-feature`
4. **Make your changes** and test thoroughly
5. **Commit** with [Conventional Commits](https://www.conventionalcommits.org/): `git commit -m "feat: add new feature"`
6. **Push** and **open a Pull Request** against `main`

### Guidelines

- Follow the existing code style (ESLint + Prettier configured)
- Write TypeScript with proper types (avoid `any`)
- Use `loggers.xxx` from `@/lib/logger` — never bare `console.log`
- Add tests for new features
- Keep commits atomic and well-described

---

## Troubleshooting

### Build Errors

| Issue | Solution |
|-------|----------|
| Rust not found | Run `rustup update` and restart terminal |
| Windows build fails | Install Visual Studio Build Tools with C++ |
| Node modules issues | Delete `node_modules` and run `npm install` |

### MCP Server Issues

| Issue | Solution |
|-------|----------|
| Port already in use | Change the MCP port in Settings or stop the conflicting process |
| 401 Unauthorized | Verify the API key matches — copy it from Settings → MCP Server |
| Client can't connect | Ensure the server is running and the correct port/API key are used |

### Agent Issues

| Issue | Solution |
|-------|----------|
| Agent not responding | Verify agent is published and credentials are correct in the Agents page |
| Device code expired | Re-authenticate — the device code has a short TTL |
| TTS not working | Verify Speech Service key and region in Settings |
| Captions not detected | Ensure live captions are enabled in the Teams meeting |

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- [rmcp](https://github.com/anthropics/rmcp) — Rust MCP SDK
- Microsoft Azure Communication Services
- Microsoft Copilot Studio
- Azure AI Foundry
- Tauri Framework

---

**Made with ❤️ by the Community**
