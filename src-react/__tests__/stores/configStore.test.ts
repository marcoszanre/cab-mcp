import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadAppConfig: vi.fn(),
  loadRawAppConfig: vi.fn(),
  saveAppConfig: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('@/services/configFileService', () => ({
  loadAppConfig: mocks.loadAppConfig,
  loadRawAppConfig: mocks.loadRawAppConfig,
  saveAppConfig: mocks.saveAppConfig,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
    debug: vi.fn(),
  },
}))

import { useConfigStore } from '@/stores/configStore'

const originalState = useConfigStore.getState()

describe('configStore config file persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    useConfigStore.setState({
      config: originalState.config,
      mcpConfig: originalState.mcpConfig,
      validationStatuses: originalState.validationStatuses,
      configFileLoaded: false,
    })

    mocks.loadAppConfig.mockReset()
    mocks.loadRawAppConfig.mockReset()
    mocks.saveAppConfig.mockReset()
    mocks.logInfo.mockReset()
    mocks.logWarn.mockReset()
    mocks.logError.mockReset()
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('loads config and mcpConfig from config file', async () => {
    const fileData = {
      config: {
        acs: {
          endpoint: 'https://acs.example.com',
          accessKey: 'test-key',
        },
        speech: { key: 'speech-key', region: 'westus' },
        openai: { endpoint: 'https://openai.example.com', apiKey: 'openai-key', deployment: 'gpt-4' },
      },
      mcpConfig: {
        port: 4000,
        apiKey: 'mcp-key',
      },
    }
    mocks.loadAppConfig.mockResolvedValue(fileData)
    mocks.loadRawAppConfig.mockResolvedValue(fileData)

    await useConfigStore.getState().loadFromConfigFile()

    const state = useConfigStore.getState()
    expect(state.configFileLoaded).toBe(true)
    expect(state.config.acs.endpoint).toBe('https://acs.example.com')
    expect(state.config.acs.accessKey).toBe('test-key')
    expect(state.config.speech.key).toBe('speech-key')
    expect(state.config.openai.apiKey).toBe('openai-key')
    expect(state.mcpConfig.port).toBe(4000)
    expect(state.mcpConfig.apiKey).toBe('mcp-key')
  })

  it('auto-generates MCP API key when missing', async () => {
    const fileData = {
      config: { acs: { endpoint: 'https://acs.example.com' } },
      mcpConfig: { apiKey: '' },
    }
    mocks.loadAppConfig.mockResolvedValue(fileData)
    mocks.loadRawAppConfig.mockResolvedValue(fileData)
    mocks.saveAppConfig.mockResolvedValue(true)

    await useConfigStore.getState().loadFromConfigFile()

    const state = useConfigStore.getState()
    expect(state.mcpConfig.apiKey).toBeTruthy()
    expect(state.mcpConfig.apiKey.length).toBe(32)
    expect(mocks.saveAppConfig).toHaveBeenCalled()
  })

  it('saves config back to config file preserving raw structure', async () => {
    // Simulate: file has ${MY_ENDPOINT} that resolved to 'https://resolved.example.com'
    mocks.loadAppConfig.mockResolvedValue({
      config: { acs: { endpoint: 'https://resolved.example.com' } },
      mcpConfig: { port: 3100 },
    })
    mocks.loadRawAppConfig.mockResolvedValue({
      env: { MY_SECRET: 'raw-value' },
      config: { acs: { endpoint: '${MY_ENDPOINT}' } },
      mcpConfig: { port: 3100 },
      agents: [{ id: 'agent-1' }],
    })
    mocks.saveAppConfig.mockResolvedValue(true)

    // Load first to populate resolved snapshot
    await useConfigStore.getState().loadFromConfigFile()

    // Now change some fields but NOT the endpoint
    useConfigStore.setState({
      config: {
        ...useConfigStore.getState().config,
        acs: {
          ...useConfigStore.getState().config.acs,
          accessKey: 'my-key',
        },
      },
      mcpConfig: {
        ...useConfigStore.getState().mcpConfig,
        port: 5000,
        apiKey: 'mcp-key',
      },
    })

    const result = await useConfigStore.getState().saveToConfigFile()

    expect(result).toBe(true)
    expect(mocks.saveAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { MY_SECRET: 'raw-value' },
        agents: [{ id: 'agent-1' }],
        config: expect.objectContaining({
          acs: expect.objectContaining({
            endpoint: '${MY_ENDPOINT}',
            accessKey: 'my-key',
          }),
        }),
        mcpConfig: expect.objectContaining({
          port: 5000,
          apiKey: 'mcp-key',
        }),
      })
    )
  })

  it('marks configFileLoaded even if loading fails', async () => {
    mocks.loadAppConfig.mockRejectedValue(new Error('file not found'))

    await useConfigStore.getState().loadFromConfigFile()

    expect(useConfigStore.getState().configFileLoaded).toBe(true)
  })

  it('preserves ${ENV_VAR} references for unchanged fields on save', async () => {
    // Raw config has env var references, resolved has actual values
    mocks.loadAppConfig.mockResolvedValue({
      config: {
        acs: {
          endpoint: 'https://acs.example.com',
          accessKey: 'resolved-secret',
        },
        speech: { key: 'resolved-speech-key', region: 'eastus' },
        openai: { endpoint: 'https://openai.example.com', apiKey: 'resolved-openai-key', deployment: 'gpt-4' },
      },
      mcpConfig: { apiKey: 'existing-key' },
    })
    mocks.loadRawAppConfig.mockResolvedValue({
      config: {
        acs: {
          endpoint: '${ACS_ENDPOINT}',
          accessKey: '${ACS_KEY}',
        },
        speech: { key: '${SPEECH_KEY}', region: 'eastus' },
        openai: { endpoint: '${OPENAI_ENDPOINT}', apiKey: '${OPENAI_KEY}', deployment: 'gpt-4' },
      },
      mcpConfig: { apiKey: 'existing-key' },
    })
    mocks.saveAppConfig.mockResolvedValue(true)

    await useConfigStore.getState().loadFromConfigFile()

    // Save without changing anything — all env var refs should be preserved
    await useConfigStore.getState().saveToConfigFile()

    const savedConfig = mocks.saveAppConfig.mock.calls[0][0].config
    expect(savedConfig.acs.endpoint).toBe('${ACS_ENDPOINT}')
    expect(savedConfig.acs.accessKey).toBe('${ACS_KEY}')
    expect(savedConfig.speech.key).toBe('${SPEECH_KEY}')
    expect(savedConfig.openai.apiKey).toBe('${OPENAI_KEY}')
    expect(savedConfig.openai.endpoint).toBe('${OPENAI_ENDPOINT}')
  })

  it('overwrites ${ENV_VAR} reference when user changes the field', async () => {
    mocks.loadAppConfig.mockResolvedValue({
      config: {
        acs: {
          endpoint: 'https://acs.example.com',
          accessKey: 'resolved-secret',
        },
        speech: { key: 'resolved-speech-key', region: 'eastus' },
      },
      mcpConfig: { apiKey: 'existing-key' },
    })
    mocks.loadRawAppConfig.mockResolvedValue({
      config: {
        acs: {
          endpoint: '${ACS_ENDPOINT}',
          accessKey: '${ACS_KEY}',
        },
        speech: { key: '${SPEECH_KEY}', region: 'eastus' },
      },
      mcpConfig: { apiKey: 'existing-key' },
    })
    mocks.saveAppConfig.mockResolvedValue(true)

    await useConfigStore.getState().loadFromConfigFile()

    // User changes speech key but not access key
    useConfigStore.setState({
      config: {
        ...useConfigStore.getState().config,
        speech: {
          ...useConfigStore.getState().config.speech,
          key: 'user-typed-new-key',
        },
      },
    })

    await useConfigStore.getState().saveToConfigFile()

    const savedConfig = mocks.saveAppConfig.mock.calls[0][0].config
    expect(savedConfig.acs.accessKey).toBe('${ACS_KEY}')
    expect(savedConfig.speech.key).toBe('user-typed-new-key')
    expect(savedConfig.acs.endpoint).toBe('${ACS_ENDPOINT}')
  })

  it('populates envVarFields map for fields with ${ENV_VAR} references', async () => {
    mocks.loadAppConfig.mockResolvedValue({
      config: {
        acs: {
          endpoint: 'https://acs.example.com',
          accessKey: 'resolved-key',
        },
        speech: { key: 'resolved-speech-key', region: 'eastus' },
      },
      mcpConfig: { apiKey: 'existing-key' },
    })
    mocks.loadRawAppConfig.mockResolvedValue({
      config: {
        acs: {
          endpoint: '${ACS_ENDPOINT}',
          accessKey: '${ACS_KEY}',
        },
        speech: { key: '${SPEECH_KEY}', region: 'eastus' },
      },
      mcpConfig: { apiKey: 'existing-key' },
    })

    await useConfigStore.getState().loadFromConfigFile()

    const envVarFields = useConfigStore.getState().envVarFields
    expect(envVarFields.get('config.acs.endpoint')).toBe('${ACS_ENDPOINT}')
    expect(envVarFields.get('config.acs.accessKey')).toBe('${ACS_KEY}')
    expect(envVarFields.get('config.speech.key')).toBe('${SPEECH_KEY}')
    expect(envVarFields.has('config.speech.region')).toBe(false)
  })

  it('populates envVarFields map for $env:VAR (PowerShell) references', async () => {
    mocks.loadAppConfig.mockResolvedValue({
      config: {
        acs: {
          endpoint: 'https://acs.example.com',
          accessKey: 'resolved-key',
        },
        openai: { endpoint: 'https://openai.example.com', apiKey: 'resolved-openai-key', deployment: 'gpt-4' },
      },
      mcpConfig: { apiKey: 'existing-key' },
    })
    mocks.loadRawAppConfig.mockResolvedValue({
      config: {
        acs: {
          endpoint: '$env:ACS_ENDPOINT',
          accessKey: '$env:ACS_KEY',
        },
        openai: { endpoint: '${OPENAI_ENDPOINT}', apiKey: '$env:OPENAI_KEY', deployment: 'gpt-4' },
      },
      mcpConfig: { apiKey: 'existing-key' },
    })

    await useConfigStore.getState().loadFromConfigFile()

    const envVarFields = useConfigStore.getState().envVarFields
    expect(envVarFields.get('config.acs.endpoint')).toBe('$env:ACS_ENDPOINT')
    expect(envVarFields.get('config.acs.accessKey')).toBe('$env:ACS_KEY')
    expect(envVarFields.get('config.openai.apiKey')).toBe('$env:OPENAI_KEY')
    expect(envVarFields.get('config.openai.endpoint')).toBe('${OPENAI_ENDPOINT}')
    expect(envVarFields.has('config.openai.deployment')).toBe(false)
  })

  it('preserves $env:VAR references for unchanged fields on save', async () => {
    mocks.loadAppConfig.mockResolvedValue({
      config: {
        acs: {
          endpoint: 'https://acs.example.com',
          accessKey: 'resolved-secret',
        },
        openai: { endpoint: 'https://openai.example.com', apiKey: 'resolved-openai-key', deployment: 'gpt-4' },
      },
      mcpConfig: { apiKey: 'existing-key' },
    })
    mocks.loadRawAppConfig.mockResolvedValue({
      config: {
        acs: {
          endpoint: '$env:ACS_ENDPOINT',
          accessKey: '$env:ACS_KEY',
        },
        openai: { endpoint: '$env:OPENAI_ENDPOINT', apiKey: '$env:OPENAI_KEY', deployment: 'gpt-4' },
      },
      mcpConfig: { apiKey: 'existing-key' },
    })
    mocks.saveAppConfig.mockResolvedValue(true)

    await useConfigStore.getState().loadFromConfigFile()

    // Save without changing anything — all env var refs should be preserved
    await useConfigStore.getState().saveToConfigFile()

    const savedConfig = mocks.saveAppConfig.mock.calls[0][0].config
    expect(savedConfig.acs.endpoint).toBe('$env:ACS_ENDPOINT')
    expect(savedConfig.acs.accessKey).toBe('$env:ACS_KEY')
    expect(savedConfig.openai.apiKey).toBe('$env:OPENAI_KEY')
    expect(savedConfig.openai.endpoint).toBe('$env:OPENAI_ENDPOINT')
  })
})
