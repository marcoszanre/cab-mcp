import '@testing-library/jest-dom'

// Mock import.meta.env for tests
Object.defineProperty(import.meta, 'env', {
  value: {
    DEV: true,
    PROD: false,
    MODE: 'test',
    BASE_URL: '/',
    VITE_ACS_ENDPOINT: '',
    VITE_ACS_ACCESS_KEY: '',
    VITE_AGENT_NAME: 'Test Agent',
    VITE_COPILOT_APP_CLIENT_ID: '',
    VITE_COPILOT_TENANT_ID: '',
    VITE_COPILOT_ENVIRONMENT_ID: '',
    VITE_COPILOT_AGENT_IDENTIFIER: '',
    VITE_SPEECH_KEY: '',
    VITE_SPEECH_REGION: 'eastus',
    VITE_OPENAI_ENDPOINT: '',
    VITE_OPENAI_DEPLOYMENT: '',
    VITE_OPENAI_API_KEY: '',
  },
})
