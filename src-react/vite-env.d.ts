/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Azure Communication Services
  readonly VITE_ACS_ENDPOINT: string
  readonly VITE_ACS_ACCESS_KEY: string
  
  // Agent Configuration
  readonly VITE_AGENT_NAME: string
  readonly VITE_CALL_URL: string
  
  // Azure Speech Service
  readonly VITE_SPEECH_KEY: string
  readonly VITE_SPEECH_ENDPOINT: string
  readonly VITE_SPEECH_REGION: string
  
  // Microsoft Copilot Studio
  readonly VITE_COPILOT_APP_CLIENT_ID: string
  readonly VITE_COPILOT_TENANT_ID: string
  readonly VITE_COPILOT_ENVIRONMENT_ID: string
  readonly VITE_COPILOT_AGENT_IDENTIFIER: string
  
  // Azure OpenAI
  readonly VITE_OPENAI_ENDPOINT: string
  readonly VITE_OPENAI_DEPLOYMENT: string
  readonly VITE_OPENAI_API_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
