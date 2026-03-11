import { useCallback, useEffect, useState, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/tauri'
import { useConfigStore } from '@/stores/configStore'
import { usePreferencesStore, type ThemeMode } from '@/stores/preferencesStore'
import { DEFAULT_IDLE_TIMEOUT_CONFIG } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { 
  Settings, 
  
  Key,
  Server,
  Volume2,
  Check,
  Sun,
  Moon,
  Monitor,
  Loader2,
  CheckCircle2,
  PlayCircle,
  XCircle,
  
  Eye,
  EyeOff,
  Copy,
  RefreshCw,
  Timer,
  ShieldCheck,
} from 'lucide-react'
import type { McpServerStatus } from '@/types'
import {
  validateAcsConfig,
  validateSpeechConfig,
  validateOpenAIConfig,
  normalizeOpenAIEndpoint,
} from '@/services/validationService'

/** Maps form field names to their dot-paths in the raw config */
const FIELD_TO_CONFIG_PATH: Record<string, string> = {
  acsEndpoint: 'config.acs.endpoint',
  acsAccessKey: 'config.acs.accessKey',
  speechKey: 'config.speech.key',
  speechRegion: 'config.speech.region',
  openaiEndpoint: 'config.openai.endpoint',
  openaiApiKey: 'config.openai.apiKey',
  openaiDeployment: 'config.openai.deployment',
}

function EnvVarBadge({ rawRef }: { rawRef: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-400"
      title={`Backed by environment variable: ${rawRef}`}
    >
      <ShieldCheck className="w-3 h-3" />
      <span className="font-mono">{rawRef}</span>
    </span>
  )
}

interface SettingsFormData {
  acsEndpoint: string
  acsAccessKey: string
  speechKey: string
  speechRegion: string
  openaiEndpoint: string
  openaiApiKey: string
  openaiDeployment: string
}

export function SettingsPage() {
  const {
    config,
    mcpConfig,
    validationStatuses,
    configFileLoaded,
    envVarFields,
    setAcsConfig,
    setSpeechConfig,
    setOpenAIConfig,
    setMcpConfig,
    setValidationStatus,
    clearValidationStatus,
  } = useConfigStore()
  const { preferences, setTheme, setIdleTimeout: setIdleTimeoutPref } = usePreferencesStore()
  const { setMeetingBehavior } = useConfigStore()

  /** Returns the raw ${ENV_VAR} reference for a form field, or undefined if not env-backed */
  const getEnvVarRef = useMemo(() => {
    return (field: string): string | undefined => envVarFields.get(FIELD_TO_CONFIG_PATH[field])
  }, [envVarFields])

  // Derive validation state from store
  const acsValidation = validationStatuses.acs
  const speechValidation = validationStatuses.speech
  const openaiValidation = validationStatuses.openai
  const [formData, setFormData] = useState<SettingsFormData>({
    acsEndpoint: config.acs.endpoint || '',
    acsAccessKey: config.acs.accessKey || '',
    speechKey: config.speech.key || '',
    speechRegion: config.speech.region || 'eastus',
    openaiEndpoint: config.openai.endpoint || '',
    openaiApiKey: config.openai.apiKey || '',
    openaiDeployment: config.openai.deployment || '',
  })

  
  // Validation loading states
  const [acsValidating, setAcsValidating] = useState(false)
  const [speechValidating, setSpeechValidating] = useState(false)
  const [openaiValidating, setOpenaiValidating] = useState(false)

  // MCP server state
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus>({ running: false, port: null, uptimeSeconds: null })
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpPortInput, setMcpPortInput] = useState(String(mcpConfig.port))
  const [mcpMaxSessionsInput, setMcpMaxSessionsInput] = useState(String(mcpConfig.maxConcurrentSessions))
  const [mcpRetentionInput, setMcpRetentionInput] = useState(String(mcpConfig.sessionRetentionMinutes))
  const [showApiKey, setShowApiKey] = useState(false)
  const [apiKeyCopied, setApiKeyCopied] = useState(false)



  useEffect(() => {
    setFormData({
      acsEndpoint: config.acs.endpoint || '',
      acsAccessKey: config.acs.accessKey || '',
      speechKey: config.speech.key || '',
      speechRegion: config.speech.region || 'eastus',
      openaiEndpoint: config.openai.endpoint || '',
      openaiApiKey: config.openai.apiKey || '',
      openaiDeployment: config.openai.deployment || '',
    })
  }, [config])

  const saveConfigToFile = useCallback(() => {
    return useConfigStore.getState().saveToConfigFile()
  }, [])

  /** Update idle timeout in both preferences (runtime) and config file */
  const setIdleTimeout = useCallback((config: Partial<import('@/types').IdleTimeoutConfig>) => {
    setIdleTimeoutPref(config)
    const current = usePreferencesStore.getState().preferences.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_CONFIG
    setMeetingBehavior({ autoLeave: { ...current, ...config } })
    void saveConfigToFile()
  }, [setIdleTimeoutPref, setMeetingBehavior, saveConfigToFile])

  const updateFormField= (field: keyof SettingsFormData, value: string) => {
    setFormData(prev => {
      const next = { ...prev, [field]: value }
      const trimmed = value.trim()

      switch (field) {
        case 'acsEndpoint':
          setAcsConfig({ endpoint: trimmed })
          break
        case 'speechRegion':
          setSpeechConfig({ region: trimmed })
          break
        case 'openaiEndpoint':
          setOpenAIConfig({ endpoint: normalizeOpenAIEndpoint(trimmed) })
          break
        case 'openaiDeployment':
          setOpenAIConfig({ deployment: trimmed })
          break
        case 'acsAccessKey':
          setAcsConfig({ accessKey: trimmed })
          break
        case 'speechKey':
          setSpeechConfig({ key: trimmed })
          break
        case 'openaiApiKey':
          setOpenAIConfig({ apiKey: trimmed })
          break
      }

      void saveConfigToFile()
      return next
    })
  }

  const isAcsConfigured = formData.acsEndpoint && formData.acsAccessKey
  const isSpeechConfigured = formData.speechKey
  const isOpenAIConfigured = formData.openaiEndpoint && formData.openaiApiKey

  // Validation handlers
  const handleValidateAcs = async () => {
    setAcsValidating(true)
    await saveConfigToFile()
    const result = await validateAcsConfig(formData.acsEndpoint, formData.acsAccessKey)
    setValidationStatus('acs', result)
    setAcsValidating(false)
  }

  const handleValidateSpeech = async () => {
    setSpeechValidating(true)
    await saveConfigToFile()
    const result = await validateSpeechConfig(formData.speechKey, formData.speechRegion)
    setValidationStatus('speech', result)
    setSpeechValidating(false)
  }

  const handleValidateOpenAI = async () => {
    setOpenaiValidating(true)
    await saveConfigToFile()
    const result = await validateOpenAIConfig(
      formData.openaiEndpoint, 
      formData.openaiApiKey, 
      formData.openaiDeployment
    )
    setValidationStatus('openai', result)
    setOpenaiValidating(false)
  }

  // Clear validation when form changes
  useEffect(() => {
    clearValidationStatus('acs')
  }, [formData.acsEndpoint, formData.acsAccessKey])

  useEffect(() => {
    clearValidationStatus('speech')
  }, [formData.speechKey, formData.speechRegion])

  useEffect(() => {
    clearValidationStatus('openai')
  }, [formData.openaiEndpoint, formData.openaiApiKey, formData.openaiDeployment])

  // Poll MCP server status
  useEffect(() => {
    const poll = async () => {
      try {
        const status = await invoke<McpServerStatus>('get_mcp_server_status')
        setMcpStatus(status)
      } catch { /* not available */ }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleMcpToggle = async () => {
    setMcpLoading(true)
    try {
      if (mcpStatus.running) {
        await invoke('stop_mcp_server')
        setMcpStatus({ running: false, port: null, uptimeSeconds: null })
      } else {
        const port = parseInt(mcpPortInput, 10)
        if (port < 1024 || port > 65535) return
        setMcpConfig({ port })
        void saveConfigToFile()
        await invoke('start_mcp_server', {
          port,
          apiKey: mcpConfig.apiKey,
        })
        setMcpStatus({ running: true, port, uptimeSeconds: 0 })
      }
    } catch (err) {
      console.error('MCP toggle error:', err)
    }
    setMcpLoading(false)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Page Header */}
      <div className="flex items-center justify-between px-8 py-5 border-b bg-background/80 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10">
            <Settings className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Settings</h1>
            <p className="text-xs text-muted-foreground">Configure theme and platform services. Secret fields support <code className="text-[10px] bg-muted px-1 rounded">${"${ENV_VAR}"}</code> references in <code className="text-[10px] bg-muted px-1 rounded">cab-config.json</code>.</p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-6xl px-8 py-6 space-y-6">
          {!configFileLoaded && (
            <Card>
              <CardContent className="py-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading configuration...
                </div>
              </CardContent>
            </Card>
          )}

          {/* Appearance */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sun className="w-4 h-4" />
                Appearance
              </CardTitle>
              <CardDescription className="text-xs">
                Choose your preferred color theme
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-3">
                <ThemeOption
                  icon={<Sun className="w-4 h-4" />}
                  label="Light"
                  value="light"
                  current={preferences.ui?.theme || 'light'}
                  onSelect={setTheme}
                />
                <ThemeOption
                  icon={<Moon className="w-4 h-4" />}
                  label="Dark"
                  value="dark"
                  current={preferences.ui?.theme || 'light'}
                  onSelect={setTheme}
                />
                <ThemeOption
                  icon={<Monitor className="w-4 h-4" />}
                  label="System"
                  value="system"
                  current={preferences.ui?.theme || 'light'}
                  onSelect={setTheme}
                />
              </div>
            </CardContent>
          </Card>

          {/* Meeting Behavior */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Timer className="w-4 h-4" />
                Meeting Behavior
              </CardTitle>
              <CardDescription className="text-xs">
                Automatic agent behavior when in a meeting
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-xs">Auto-leave when alone</Label>
                  <p className="text-[10px] text-muted-foreground">Automatically leave the meeting when no other participants remain</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={preferences.idleTimeout?.enabled ?? DEFAULT_IDLE_TIMEOUT_CONFIG.enabled}
                  onClick={() => {
                    const current = preferences.idleTimeout?.enabled ?? DEFAULT_IDLE_TIMEOUT_CONFIG.enabled
                    setIdleTimeout({ enabled: !current })
                  }}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    (preferences.idleTimeout?.enabled ?? DEFAULT_IDLE_TIMEOUT_CONFIG.enabled) ? 'bg-primary' : 'bg-input'
                  }`}
                >
                  <span className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${
                    (preferences.idleTimeout?.enabled ?? DEFAULT_IDLE_TIMEOUT_CONFIG.enabled) ? 'translate-x-4' : 'translate-x-0'
                  }`} />
                </button>
              </div>

              {(preferences.idleTimeout?.enabled ?? DEFAULT_IDLE_TIMEOUT_CONFIG.enabled) && (
                <div className="space-y-2">
                  <Label htmlFor="idleTimeoutMinutes" className="text-xs">Timeout (minutes)</Label>
                  <p className="text-[10px] text-muted-foreground">How long to wait before leaving after all participants have left</p>
                  <Input
                    id="idleTimeoutMinutes"
                    type="number"
                    min={1}
                    max={60}
                    value={preferences.idleTimeout?.timeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_CONFIG.timeoutMinutes}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10)
                      if (!isNaN(val) && val >= 1 && val <= 60) {
                        setIdleTimeout({ timeoutMinutes: val })
                      }
                    }}
                    className="w-24"
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Azure Communication Services */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Server className="w-4 h-4" />
                Azure Communication Services
                {isAcsConfigured && acsValidation?.isValid && (
                  <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0">
                    <Check className="w-2.5 h-2.5 mr-0.5" />
                    Verified
                  </Badge>
                )}
                {isAcsConfigured && !acsValidation && (
                  <Badge variant="outline" className="ml-auto text-[10px] px-1.5 py-0">
                    Not Tested
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-xs">
                Required for joining Teams meetings
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="acsEndpoint" className="text-xs">ACS Endpoint</Label>
                <Input
                  id="acsEndpoint"
                  placeholder="https://your-resource.communication.azure.com"
                  value={formData.acsEndpoint}
                  onChange={(e) => updateFormField('acsEndpoint', e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="acsAccessKey" className="text-xs">ACS Access Key</Label>
                  {getEnvVarRef('acsAccessKey') && <EnvVarBadge rawRef={getEnvVarRef('acsAccessKey')!} />}
                </div>
                <Input
                  id="acsAccessKey"
                  type="password"
                  placeholder="Your ACS access key"
                  value={formData.acsAccessKey}
                  onChange={(e) => updateFormField('acsAccessKey', e.target.value)}
                />
              </div>
              
              {/* Validation Section */}
              <div className="pt-2 space-y-2">
                <Button 
                  onClick={handleValidateAcs} 
                  disabled={!isAcsConfigured || acsValidating || !configFileLoaded}
                  variant="outline"
                  size="sm"
                  className="w-full"
                >
                  {acsValidating ? (
                    <>
                      <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                      Testing Connection...
                    </>
                  ) : acsValidation?.isValid ? (
                    <>
                      <CheckCircle2 className="w-3 h-3 mr-2 text-green-600" />
                      Retest Connection
                    </>
                  ) : acsValidation && !acsValidation.isValid ? (
                    <>
                      <XCircle className="w-3 h-3 mr-2 text-red-500" />
                      Retry Test
                    </>
                  ) : (
                    <>
                      <PlayCircle className="w-3 h-3 mr-2" />
                      Test Connection
                    </>
                  )}
                </Button>
                
                {acsValidation && (
                  <div className={`rounded-lg border p-3 text-sm ${
                    acsValidation.isValid 
                      ? 'bg-green-50 border-green-200 text-green-800 dark:bg-green-950 dark:border-green-800 dark:text-green-200' 
                      : 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950 dark:border-red-800 dark:text-red-200'
                  }`}>
                    <div className="flex items-start gap-2">
                      {acsValidation.isValid ? (
                        <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      ) : (
                        <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="flex-1 space-y-1">
                        <p className="font-medium">{acsValidation.message}</p>
                        {acsValidation.details && (
                          <p className="text-xs opacity-90">{acsValidation.details}</p>
                        )}
                        <p className="text-[10px] opacity-70">
                          Tested at {acsValidation.testedAt.toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Azure Speech Services */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Volume2 className="w-4 h-4" />
                Azure Speech Services
                {isSpeechConfigured && speechValidation?.isValid && (
                  <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0">
                    <Check className="w-2.5 h-2.5 mr-0.5" />
                    Verified
                  </Badge>
                )}
                {isSpeechConfigured && !speechValidation && (
                  <Badge variant="outline" className="ml-auto text-[10px] px-1.5 py-0">
                    Not Tested
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-xs">
                Text-to-speech for AI responses
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="speechKey" className="text-xs">Speech Key</Label>
                    {getEnvVarRef('speechKey') && <EnvVarBadge rawRef={getEnvVarRef('speechKey')!} />}
                  </div>
                  <Input
                    id="speechKey"
                    type="password"
                    placeholder="Your Speech service key"
                    value={formData.speechKey}
                    onChange={(e) => updateFormField('speechKey', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="speechRegion" className="text-xs">Region</Label>
                  <Input
                    id="speechRegion"
                    placeholder="e.g., eastus"
                    value={formData.speechRegion}
                    onChange={(e) => updateFormField('speechRegion', e.target.value)}
                  />
                </div>
              </div>
              
              {/* Validation Section */}
              <div className="space-y-2">
                <Button 
                  onClick={handleValidateSpeech} 
                  disabled={!isSpeechConfigured || speechValidating || !configFileLoaded}
                  variant="outline"
                  size="sm"
                  className="w-full"
                >
                  {speechValidating ? (
                    <>
                      <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                      Testing Connection...
                    </>
                  ) : speechValidation?.isValid ? (
                    <>
                      <CheckCircle2 className="w-3 h-3 mr-2 text-green-600" />
                      Retest Connection
                    </>
                  ) : speechValidation && !speechValidation.isValid ? (
                    <>
                      <XCircle className="w-3 h-3 mr-2 text-red-500" />
                      Retry Test
                    </>
                  ) : (
                    <>
                      <PlayCircle className="w-3 h-3 mr-2" />
                      Test Connection
                    </>
                  )}
                </Button>
                
                {speechValidation && (
                  <div className={`rounded-lg border p-3 text-sm ${
                    speechValidation.isValid 
                      ? 'bg-green-50 border-green-200 text-green-800 dark:bg-green-950 dark:border-green-800 dark:text-green-200' 
                      : 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950 dark:border-red-800 dark:text-red-200'
                  }`}>
                    <div className="flex items-start gap-2">
                      {speechValidation.isValid ? (
                        <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      ) : (
                        <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="flex-1 space-y-1">
                        <p className="font-medium">{speechValidation.message}</p>
                        {speechValidation.details && (
                          <p className="text-xs opacity-90">{speechValidation.details}</p>
                        )}
                        <p className="text-[10px] opacity-70">
                          Tested at {speechValidation.testedAt.toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Azure OpenAI */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Key className="w-4 h-4" />
                Azure OpenAI (GPT)
                {isOpenAIConfigured && openaiValidation?.isValid && (
                  <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0">
                    <Check className="w-2.5 h-2.5 mr-0.5" />
                    Verified
                  </Badge>
                )}
                {isOpenAIConfigured && !openaiValidation && (
                  <Badge variant="outline" className="ml-auto text-[10px] px-1.5 py-0">
                    Not Tested
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-xs">
                AI model for generating responses
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="openaiEndpoint" className="text-xs">OpenAI Endpoint</Label>
                <Input
                  id="openaiEndpoint"
                  placeholder="https://your-resource.openai.azure.com or .cognitiveservices.azure.com"
                  value={formData.openaiEndpoint}
                  onChange={(e) => updateFormField('openaiEndpoint', e.target.value)}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="openaiApiKey" className="text-xs">API Key</Label>
                    {getEnvVarRef('openaiApiKey') && <EnvVarBadge rawRef={getEnvVarRef('openaiApiKey')!} />}
                  </div>
                  <Input
                    id="openaiApiKey"
                    type="password"
                    placeholder="Your OpenAI API key"
                    value={formData.openaiApiKey}
                    onChange={(e) => updateFormField('openaiApiKey', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="openaiDeployment" className="text-xs">Deployment</Label>
                  <Input
                    id="openaiDeployment"
                    placeholder="e.g., gpt-4"
                    value={formData.openaiDeployment}
                    onChange={(e) => updateFormField('openaiDeployment', e.target.value)}
                  />
                </div>
              </div>
              
              {/* Validation Section */}
              <div className="space-y-2">
                <Button
                  onClick={handleValidateOpenAI}
                  disabled={!isOpenAIConfigured || openaiValidating || !configFileLoaded}
                  variant="outline"
                  size="sm"
                  className="w-full"
                >
                  {openaiValidating ? (
                    <>
                      <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                      Testing Connection...
                    </>
                  ) : openaiValidation?.isValid ? (
                    <>
                      <CheckCircle2 className="w-3 h-3 mr-2 text-green-600" />
                      Retest Connection
                    </>
                  ) : openaiValidation && !openaiValidation.isValid ? (
                    <>
                      <XCircle className="w-3 h-3 mr-2 text-red-500" />
                      Retry Test
                    </>
                  ) : (
                    <>
                      <PlayCircle className="w-3 h-3 mr-2" />
                      Test Connection
                    </>
                  )}
                </Button>
                
                {openaiValidation && (
                  <div className={`rounded-lg border p-3 text-sm ${
                    openaiValidation.isValid 
                      ? 'bg-green-50 border-green-200 text-green-800 dark:bg-green-950 dark:border-green-800 dark:text-green-200' 
                      : 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950 dark:border-red-800 dark:text-red-200'
                  }`}>
                    <div className="flex items-start gap-2">
                      {openaiValidation.isValid ? (
                        <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      ) : (
                        <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="flex-1 space-y-1">
                        <p className="font-medium">{openaiValidation.message}</p>
                        {openaiValidation.details && (
                          <p className="text-xs opacity-90">{openaiValidation.details}</p>
                        )}
                        <p className="text-[10px] opacity-70">
                          Tested at {openaiValidation.testedAt.toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* MCP Server */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Server className="w-4 h-4" />
                MCP Server
                {mcpStatus.running ? (
                  <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0">
                    <CheckCircle2 className="w-2.5 h-2.5 mr-0.5 text-green-600" />
                    Running
                  </Badge>
                ) : (
                  <Badge variant="outline" className="ml-auto text-[10px] px-1.5 py-0">
                    Stopped
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-xs">
                Expose agent bridge as an MCP server (HTTP Streamable) for external clients
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Port */}
              <div className="space-y-2">
                <Label htmlFor="mcpPort" className="text-xs">Port</Label>
                <Input
                  id="mcpPort"
                  type="number"
                  min={1024}
                  max={65535}
                  placeholder="3100"
                  value={mcpPortInput}
                  disabled={mcpStatus.running}
                  onChange={(e) => setMcpPortInput(e.target.value)}
                />
                <p className="text-[10px] text-muted-foreground">
                  Local port for the MCP HTTP endpoint (1024-65535)
                </p>
              </div>

              {/* Max concurrent sessions */}
              <div className="space-y-2">
                <Label htmlFor="mcpMaxSessions" className="text-xs">Max concurrent sessions</Label>
                <Input
                  id="mcpMaxSessions"
                  type="number"
                  min={1}
                  max={50}
                  placeholder="10"
                  value={mcpMaxSessionsInput}
                  onChange={(e) => {
                    setMcpMaxSessionsInput(e.target.value)
                    const val = parseInt(e.target.value, 10)
                    if (!isNaN(val) && val >= 1 && val <= 50) {
                      setMcpConfig({ maxConcurrentSessions: val })
                      void saveConfigToFile()
                    }
                  }}
                />
                <p className="text-[10px] text-muted-foreground">
                  Maximum number of concurrent meeting sessions (1-50)
                </p>
              </div>

              {/* Session retention */}
              <div className="space-y-2">
                <Label htmlFor="mcpRetention" className="text-xs">Session retention (minutes)</Label>
                <Input
                  id="mcpRetention"
                  type="number"
                  min={1}
                  max={60}
                  placeholder="5"
                  value={mcpRetentionInput}
                  onChange={(e) => {
                    setMcpRetentionInput(e.target.value)
                    const val = parseInt(e.target.value, 10)
                    if (!isNaN(val) && val >= 1 && val <= 60) {
                      setMcpConfig({ sessionRetentionMinutes: val })
                      void saveConfigToFile()
                    }
                  }}
                />
                <p className="text-[10px] text-muted-foreground">
                  Ended sessions are automatically removed after this period to prevent enterprise data from lingering (1-60)
                </p>
              </div>

              {/* Auto-start */}
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-xs">Auto-start with app</Label>
                  <p className="text-[10px] text-muted-foreground">Start MCP server automatically when the app launches</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={mcpConfig.autoStart}
                  onClick={() => {
                    setMcpConfig({ autoStart: !mcpConfig.autoStart })
                    void saveConfigToFile()
                  }}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    mcpConfig.autoStart ? 'bg-primary' : 'bg-input'
                  }`}
                >
                  <span className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${
                    mcpConfig.autoStart ? 'translate-x-4' : 'translate-x-0'
                  }`} />
                </button>
              </div>

              {/* API Key Authentication */}
              <div className="space-y-3 pt-2 border-t">
                <div>
                  <Label className="text-xs font-medium">API Key</Label>
                  <p className="text-[10px] text-muted-foreground">Auto-generated. Use this key to authenticate MCP clients (e.g. VS Code, Copilot Studio).</p>
                </div>
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        id="mcpApiKey"
                        type={showApiKey ? 'text' : 'password'}
                        value={mcpConfig.apiKey}
                        readOnly
                        className="font-mono text-xs pr-8"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(mcpConfig.apiKey)
                        setApiKeyCopied(true)
                        setTimeout(() => setApiKeyCopied(false), 2000)
                      }}
                      className="shrink-0"
                    >
                      {apiKeyCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={mcpStatus.running}
                      onClick={async () => {
                        const bytes = new Uint8Array(16)
                        crypto.getRandomValues(bytes)
                        const nextApiKey = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
                        setMcpConfig({ apiKey: nextApiKey })
                        await saveConfigToFile()
                      }}
                      className="shrink-0"
                      title="Regenerate API key (disconnects existing clients)"
                    >
                      <RefreshCw className="w-3 h-3" />
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Clients authenticate with <span className="font-mono">Authorization: Bearer &lt;key&gt;</span> or <span className="font-mono">X-API-Key: &lt;key&gt;</span>
                  </p>
                </div>
              </div>

              {/* Start / Stop */}
              <Button
                onClick={handleMcpToggle}
                disabled={mcpLoading}
                variant={mcpStatus.running ? 'destructive' : 'default'}
                size="sm"
                className="w-full"
              >
                {mcpLoading ? (
                  <>
                    <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                    {mcpStatus.running ? 'Stopping...' : 'Starting...'}
                  </>
                ) : mcpStatus.running ? (
                  <>
                    <XCircle className="w-3 h-3 mr-2" />
                    Stop Server
                  </>
                ) : (
                  <>
                    <PlayCircle className="w-3 h-3 mr-2" />
                    Start Server
                  </>
                )}
              </Button>

              {mcpStatus.running && mcpStatus.uptimeSeconds != null && (
                <p className="text-[10px] text-muted-foreground">
                  Listening on <span className="font-mono">http://127.0.0.1:{mcpStatus.port}/mcp</span>
                  {' '}— uptime {Math.floor(mcpStatus.uptimeSeconds / 60)}m {mcpStatus.uptimeSeconds % 60}s
                </p>
              )}
            </CardContent>
          </Card>

        </div>
      </ScrollArea>
    </div>
  )
}

// Theme selection button component
function ThemeOption({ 
  icon, 
  label, 
  value, 
  current, 
  onSelect 
}: { 
  icon: React.ReactNode
  label: string
  value: ThemeMode
  current: ThemeMode
  onSelect: (theme: ThemeMode) => void
}) {
  const isSelected = current === value
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all ${
        isSelected 
          ? 'border-primary bg-primary/5' 
          : 'border-transparent bg-muted/50 hover:bg-muted'
      }`}
    >
      <div className={isSelected ? 'text-primary' : 'text-muted-foreground'}>
        {icon}
      </div>
      <span className={`text-xs font-medium ${isSelected ? 'text-primary' : 'text-muted-foreground'}`}>
        {label}
      </span>
      {isSelected && (
        <Check className="w-3 h-3 text-primary" />
      )}
    </button>
  )
}
