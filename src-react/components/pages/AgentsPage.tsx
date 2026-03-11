import { useState, useEffect, useCallback, useRef } from 'react'
import { useAgentProvidersStore } from '@/stores/agentProvidersStore'
import { useConfigStore } from '@/stores/configStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { 
  Bot, 
  Plus, 
  Pencil, 
  Trash2, 
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Shield,
  Cloud,
  Settings2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Copy,
  Info,
  Volume2,
  Square,
  Search,
  Filter,
  Zap,
  MessageSquare,
  RotateCcw,
  Sparkles,
  LogOut
} from 'lucide-react'
import type { CopilotStudioProviderConfig, AzureFoundryProviderConfig, AgentProviderConfig, WelcomeMessageMode } from '@/types'
import { buildDefaultWelcomeMessage } from '@/lib/welcomeMessage'
import {
  DEFAULT_PROACTIVE_TURN_TAKING_MODE,
  LEGACY_PROACTIVE_TURN_TAKING_MODE,
} from '@/types/behavior'
import type { ProactiveResponseChannel, ProactiveTurnTakingMode } from '@/types/behavior'
import { AZURE_VOICES as VOICE_OPTIONS, AZURE_VOICE_STYLES as STYLE_OPTIONS } from '@/types'
import { useMeetingAgent, type MeetingAgentConfig } from '@/hooks/useMeetingAgent'
import { useVoicePreview } from '@/hooks/useVoicePreview'
import { VoicePreviewButton } from '@/components/ui/VoicePreviewButton'
import { TypingIndicator } from '@/components/ui/TypingIndicator'

// Supported agent types for the form
type FormAgentType = 'copilot-studio' | 'azure-foundry'

// Form data for authenticated Copilot Studio
interface AuthenticatedFormData {
  type: 'copilot-studio'
  name: string
  clientId: string
  tenantId: string
  environmentId: string
  botId: string
  botName: string
  voiceName: string
  ttsStyle: string
  speechRate: number
  styleDegree: number
  captionResponseAsChat: boolean
  welcomeMode: WelcomeMessageMode
  welcomeStaticMessage: string
  welcomeTriggerPrompt: string
  proactiveEnabled: boolean
  proactiveInstructions: string
  proactiveSilenceThresholdSec: number
  proactiveResponseChannel: 'speech' | 'chat' | 'auto'
  proactiveTurnTakingMode: ProactiveTurnTakingMode
  proactiveAutoLeave: boolean
  proactiveGoodbyeMessage: string
  proactiveGoodbyeChannel: 'speech' | 'chat' | 'both'
}

// Form data for Azure Foundry
interface FoundryFormData {
  type: 'azure-foundry'
  name: string
  projectEndpoint: string
  agentName: string
  tenantId: string
  clientId: string
  clientSecret: string
  region: string
  displayName: string
  voiceName: string
  ttsStyle: string
  speechRate: number
  styleDegree: number
  captionResponseAsChat: boolean
  welcomeMode: WelcomeMessageMode
  welcomeStaticMessage: string
  welcomeTriggerPrompt: string
  proactiveEnabled: boolean
  proactiveInstructions: string
  proactiveSilenceThresholdSec: number
  proactiveResponseChannel: 'speech' | 'chat' | 'auto'
  proactiveTurnTakingMode: ProactiveTurnTakingMode
  proactiveAutoLeave: boolean
  proactiveGoodbyeMessage: string
  proactiveGoodbyeChannel: 'speech' | 'chat' | 'both'
}

type AgentFormData = AuthenticatedFormData | FoundryFormData

interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: Date
}

const emptyAuthenticatedFormData: AuthenticatedFormData = {
  type: 'copilot-studio',
  name: '',
  clientId: '',
  tenantId: '',
  environmentId: '',
  botId: '',
  botName: '',
  voiceName: 'en-US-JennyNeural',
  ttsStyle: 'chat',
  speechRate: 1.0,
  styleDegree: 1.3,
  captionResponseAsChat: false,
  welcomeMode: 'default',
  welcomeStaticMessage: '',
  welcomeTriggerPrompt: '',
  proactiveEnabled: false,
  proactiveInstructions: '',
  proactiveSilenceThresholdSec: 10,
  proactiveResponseChannel: 'speech',
  proactiveTurnTakingMode: DEFAULT_PROACTIVE_TURN_TAKING_MODE,
  proactiveAutoLeave: false,
  proactiveGoodbyeMessage: '',
  proactiveGoodbyeChannel: 'both',
}

const emptyFoundryFormData: FoundryFormData = {
  type: 'azure-foundry',
  name: '',
  projectEndpoint: '',
  agentName: '',
  tenantId: '',
  clientId: '',
  clientSecret: '',
  region: '',
  displayName: '',
  voiceName: 'en-US-JennyNeural',
  ttsStyle: 'chat',
  speechRate: 1.0,
  styleDegree: 1.3,
  captionResponseAsChat: false,
  welcomeMode: 'default',
  welcomeStaticMessage: '',
  welcomeTriggerPrompt: '',
  proactiveEnabled: false,
  proactiveInstructions: '',
  proactiveSilenceThresholdSec: 10,
  proactiveResponseChannel: 'speech',
  proactiveTurnTakingMode: DEFAULT_PROACTIVE_TURN_TAKING_MODE,
  proactiveAutoLeave: false,
  proactiveGoodbyeMessage: '',
  proactiveGoodbyeChannel: 'both',
}

function getProactiveTurnTakingSummary(mode?: ProactiveTurnTakingMode): string {
  return (mode ?? LEGACY_PROACTIVE_TURN_TAKING_MODE) === 'interview-safe'
    ? 'interview-safe turns'
    : 'interruptible turns'
}

export function AgentsPage() {
  const providers = useAgentProvidersStore((state) => state.providers)
  const addProvider = useAgentProvidersStore((state) => state.addProvider)
  const updateProvider = useAgentProvidersStore((state) => state.updateProvider)
  const removeProvider = useAgentProvidersStore((state) => state.removeProvider)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [isAddingNew, setIsAddingNew] = useState(false)
  const [formData, setFormData] = useState<AgentFormData>(emptyAuthenticatedFormData)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | FormAgentType>('all')
  const [displayNameManuallyEdited, setDisplayNameManuallyEdited] = useState(false)

  // Bootstrap a default Copilot Studio agent from saved app config if none exist.
  useEffect(() => {
    if (providers.length > 0) return

    // Create a default Copilot Studio provider from stored app config when available
    const { config } = useConfigStore.getState()
    const cs = config.copilotStudio
    const hasCopilotConfig = Boolean(
      (cs.clientId || cs.appClientId) && cs.tenantId && cs.environmentId && (cs.botId || cs.agentIdentifier)
    )

    if (!hasCopilotConfig) return

    const id = `copilot-${crypto.randomUUID()}`
    addProvider({
      id,
      name: cs.botName || 'Copilot Studio Agent',
      type: 'copilot-studio',
      authType: 'microsoft-device-code',
      createdAt: new Date(),
      preprocessing: { enabled: true, ttsOptimization: true },
      postprocessing: { enabled: true, formatLinks: true },
      settings: {
        clientId: cs.clientId || cs.appClientId || '',
        tenantId: cs.tenantId,
        environmentId: cs.environmentId,
        botId: cs.botId || cs.agentIdentifier || '',
        botName: cs.botName || 'AI Agent'
      }
    })
  }, [addProvider, providers.length])

  // Filter providers based on search and type
  const filteredProviders = providers.filter(provider => {
    const matchesSearch = provider.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (provider.type === 'copilot-studio' && provider.settings.botId.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (provider.type === 'azure-foundry' && provider.settings.agentName.toLowerCase().includes(searchQuery.toLowerCase()))
    
    const matchesType = typeFilter === 'all' || provider.type === typeFilter
    
    return matchesSearch && matchesType
  })

  const handleStartAdd = () => {
    setIsAddingNew(true)
    setEditingId(null)
    setExpandedId(null)
    setFormData(emptyAuthenticatedFormData)
    setDisplayNameManuallyEdited(false)
  }

  const handleStartEdit = (provider: AgentProviderConfig) => {
    setEditingId(provider.id)
    setExpandedId(provider.id)
    setIsAddingNew(false)
    // When editing, treat display name as manually edited (preserve existing values)
    setDisplayNameManuallyEdited(true)
    
    if (provider.type === 'copilot-studio') {
      setFormData({
        type: 'copilot-studio',
        name: provider.name,
        clientId: provider.settings.clientId,
        tenantId: provider.settings.tenantId,
        environmentId: provider.settings.environmentId,
        botId: provider.settings.botId,
        botName: provider.settings.botName || '',
        voiceName: provider.voiceName || 'en-US-JennyNeural',
        ttsStyle: provider.ttsStyle || 'chat',
        speechRate: provider.speechRate ?? 1.0,
        styleDegree: provider.styleDegree ?? 1.3,
        captionResponseAsChat: provider.captionResponseAsChat ?? false,
        welcomeMode: provider.welcomeConfig?.mode ?? 'default',
        welcomeStaticMessage: provider.welcomeConfig?.staticMessage ?? '',
        welcomeTriggerPrompt: provider.welcomeConfig?.triggerPrompt ?? '',
        proactiveEnabled: provider.proactiveConfig?.enabled ?? false,
        proactiveInstructions: provider.proactiveConfig?.instructions ?? '',
        proactiveSilenceThresholdSec: (provider.proactiveConfig?.silenceThresholdMs ?? 10000) / 1000,
        proactiveResponseChannel: provider.proactiveConfig?.responseChannel ?? 'speech',
        proactiveTurnTakingMode: provider.proactiveConfig?.turnTakingMode ?? LEGACY_PROACTIVE_TURN_TAKING_MODE,
        proactiveAutoLeave: provider.proactiveConfig?.autoLeaveOnCompletion ?? false,
        proactiveGoodbyeMessage: provider.proactiveConfig?.goodbyeMessage ?? '',
        proactiveGoodbyeChannel: provider.proactiveConfig?.goodbyeChannel ?? 'both',
      })
    } else if (provider.type === 'azure-foundry') {
      setFormData({
        type: 'azure-foundry',
        name: provider.name,
        projectEndpoint: provider.settings.projectEndpoint,
        agentName: provider.settings.agentName,
        tenantId: provider.settings.tenantId || '',
        clientId: provider.settings.clientId || '',
        clientSecret: provider.settings.clientSecret || '',
        region: provider.settings.region || '',
        displayName: provider.settings.displayName || '',
        voiceName: provider.voiceName || 'en-US-JennyNeural',
        ttsStyle: provider.ttsStyle || 'chat',
        speechRate: provider.speechRate ?? 1.0,
        styleDegree: provider.styleDegree ?? 1.3,
        captionResponseAsChat: provider.captionResponseAsChat ?? false,
        welcomeMode: provider.welcomeConfig?.mode ?? 'default',
        welcomeStaticMessage: provider.welcomeConfig?.staticMessage ?? '',
        welcomeTriggerPrompt: provider.welcomeConfig?.triggerPrompt ?? '',
        proactiveEnabled: provider.proactiveConfig?.enabled ?? false,
        proactiveInstructions: provider.proactiveConfig?.instructions ?? '',
        proactiveSilenceThresholdSec: (provider.proactiveConfig?.silenceThresholdMs ?? 10000) / 1000,
        proactiveResponseChannel: provider.proactiveConfig?.responseChannel ?? 'speech',
        proactiveTurnTakingMode: provider.proactiveConfig?.turnTakingMode ?? LEGACY_PROACTIVE_TURN_TAKING_MODE,
        proactiveAutoLeave: provider.proactiveConfig?.autoLeaveOnCompletion ?? false,
        proactiveGoodbyeMessage: provider.proactiveConfig?.goodbyeMessage ?? '',
        proactiveGoodbyeChannel: provider.proactiveConfig?.goodbyeChannel ?? 'both',
      })
    }
  }

  const handleToggleExpand = (id: string) => {
    if (editingId === id) return // Don't collapse while editing
    setExpandedId(expandedId === id ? null : id)
    if (editingId) {
      setEditingId(null)
      setFormData(emptyAuthenticatedFormData)
    }
  }

  const handleCancel = () => {
    setIsAddingNew(false)
    setEditingId(null)
    setFormData(emptyAuthenticatedFormData)
  }

  const handleSave = () => {
    if (formData.type === 'copilot-studio') {
      // Authenticated agent validation
      if (!formData.name.trim() || !formData.clientId.trim() || 
          !formData.tenantId.trim() || !formData.environmentId.trim() || 
          !formData.botId.trim()) {
        return
      }

      const providerConfig: CopilotStudioProviderConfig = {
        id: editingId || crypto.randomUUID(),
        name: formData.name.trim(),
        type: 'copilot-studio',
        authType: 'microsoft-device-code',
        createdAt: editingId ? providers.find(p => p.id === editingId)?.createdAt || new Date() : new Date(),
        preprocessing: { enabled: true, ttsOptimization: true },
        postprocessing: { enabled: true, formatLinks: true },
        voiceName: formData.voiceName || 'en-US-JennyNeural',
        ttsStyle: formData.ttsStyle || 'chat',
        speechRate: formData.speechRate ?? 1.0,
        styleDegree: formData.styleDegree ?? 1.3,
        captionResponseAsChat: formData.captionResponseAsChat ?? false,
        welcomeConfig: formData.welcomeMode !== 'default' ? {
          mode: formData.welcomeMode,
          staticMessage: formData.welcomeMode === 'custom' ? formData.welcomeStaticMessage : undefined,
          triggerPrompt: formData.welcomeMode === 'agent-triggered' ? formData.welcomeTriggerPrompt : undefined,
        } : undefined,
        proactiveConfig: formData.proactiveEnabled ? {
          enabled: true,
          instructions: formData.proactiveInstructions,
          silenceThresholdMs: (formData.proactiveSilenceThresholdSec ?? 10) * 1000,
          responseChannel: formData.proactiveResponseChannel ?? 'speech',
          turnTakingMode: formData.proactiveTurnTakingMode ?? DEFAULT_PROACTIVE_TURN_TAKING_MODE,
          autoLeaveOnCompletion: formData.proactiveAutoLeave ?? false,
          goodbyeMessage: formData.proactiveGoodbyeMessage ?? '',
          goodbyeChannel: formData.proactiveGoodbyeChannel ?? 'both',
        } : undefined,
        settings: {
          clientId: formData.clientId.trim(),
          tenantId: formData.tenantId.trim(),
          environmentId: formData.environmentId.trim(),
          botId: formData.botId.trim(),
          botName: formData.botName.trim() || formData.name.trim(),
        },
      }

      if (editingId) {
        updateProvider(editingId, providerConfig)
        setExpandedId(editingId)
      } else {
        addProvider(providerConfig)
      }
    } else if (formData.type === 'azure-foundry') {
      // Foundry agent validation
      if (!formData.name.trim() || !formData.projectEndpoint.trim() || 
          !formData.agentName.trim() || !formData.tenantId.trim() || !formData.clientId.trim() || 
          !formData.clientSecret.trim() || !formData.region.trim()) {
        return
      }

      const providerConfig: AzureFoundryProviderConfig = {
        id: editingId || crypto.randomUUID(),
        name: formData.name.trim(),
        type: 'azure-foundry',
        authType: 'service-principal',
        createdAt: editingId ? providers.find(p => p.id === editingId)?.createdAt || new Date() : new Date(),
        preprocessing: { enabled: true, ttsOptimization: true },
        postprocessing: { enabled: true, formatLinks: true },
        voiceName: formData.voiceName || 'en-US-JennyNeural',
        ttsStyle: formData.ttsStyle || 'chat',
        speechRate: formData.speechRate ?? 1.0,
        styleDegree: formData.styleDegree ?? 1.3,
        captionResponseAsChat: formData.captionResponseAsChat ?? false,
        welcomeConfig: formData.welcomeMode !== 'default' ? {
          mode: formData.welcomeMode,
          staticMessage: formData.welcomeMode === 'custom' ? formData.welcomeStaticMessage : undefined,
          triggerPrompt: formData.welcomeMode === 'agent-triggered' ? formData.welcomeTriggerPrompt : undefined,
        } : undefined,
        proactiveConfig: formData.proactiveEnabled ? {
          enabled: true,
          instructions: formData.proactiveInstructions,
          silenceThresholdMs: (formData.proactiveSilenceThresholdSec ?? 10) * 1000,
          responseChannel: formData.proactiveResponseChannel ?? 'speech',
          turnTakingMode: formData.proactiveTurnTakingMode ?? DEFAULT_PROACTIVE_TURN_TAKING_MODE,
          autoLeaveOnCompletion: formData.proactiveAutoLeave ?? false,
          goodbyeMessage: formData.proactiveGoodbyeMessage ?? '',
          goodbyeChannel: formData.proactiveGoodbyeChannel ?? 'both',
        } : undefined,
        settings: {
          projectEndpoint: formData.projectEndpoint.trim(),
          agentName: formData.agentName.trim(),
          tenantId: formData.tenantId.trim(),
          clientId: formData.clientId.trim(),
          clientSecret: formData.clientSecret.trim(),
          region: formData.region.trim(),
          displayName: formData.displayName.trim() || formData.name.trim(),
        },
      }

      if (editingId) {
        updateProvider(editingId, providerConfig)
        setExpandedId(editingId)
      } else {
        addProvider(providerConfig)
      }
    }

    setIsAddingNew(false)
    setEditingId(null)
    setFormData(emptyAuthenticatedFormData)
  }

  const handleDelete = (id: string) => {
    removeProvider(id)
    setDeleteConfirmId(null)
    if (expandedId === id) setExpandedId(null)
    if (editingId === id) {
      setEditingId(null)
      setFormData(emptyAuthenticatedFormData)
    }
  }

  const updateFormField= <K extends keyof AuthenticatedFormData | keyof FoundryFormData>(
    field: K, 
    value: string | number | boolean
  ) => {
    setFormData(prev => {
      const updated = { ...prev, [field]: value }
      
      // Auto-mirror Agent Name → Display Name when display name hasn't been manually edited
      if (field === 'name' && !displayNameManuallyEdited && typeof value === 'string') {
        if (prev.type === 'azure-foundry') {
          (updated as FoundryFormData).displayName = value
        } else {
          (updated as AuthenticatedFormData).botName = value
        }
      }
      
      // Mark display name as manually edited when user explicitly changes it
      if (field === 'botName' || field === 'displayName') {
        setDisplayNameManuallyEdited(true)
      }
      
      return updated
    })
  }

  const handleTypeChange = (type: FormAgentType) => {
    const currentName = formData.name
    // Preserve display name mirroring state across type changes
    const mirroredDisplayName = !displayNameManuallyEdited ? currentName : ''
    if (type === 'copilot-studio') {
      setFormData({ ...emptyAuthenticatedFormData, name: currentName, botName: mirroredDisplayName })
    } else if (type === 'azure-foundry') {
      setFormData({ ...emptyFoundryFormData, name: currentName, displayName: mirroredDisplayName })
    }
  }

  const isFormValid = (() => {
    if (formData.type === 'copilot-studio') {
      return !!(formData.name.trim() && formData.clientId.trim() && 
        formData.tenantId.trim() && formData.environmentId.trim() && 
        formData.botId.trim())
    } else if (formData.type === 'azure-foundry') {
      return !!(formData.name.trim() && formData.projectEndpoint.trim() && 
        formData.agentName.trim() && formData.tenantId.trim() && formData.clientId.trim() && 
        formData.clientSecret.trim() && formData.region.trim())
    }
    return false
  })()

  return (
    <div className="flex flex-col h-full">
      {/* Page Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b bg-background/80 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Bot className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">AI Agents</h1>
            <p className="text-xs text-muted-foreground">Manage your Copilot Studio agents</p>
          </div>
        </div>
        <Button onClick={handleStartAdd} disabled={isAddingNew}>
          <Plus className="w-4 h-4 mr-2" />
          Add Agent
        </Button>
      </div>

      {/* Main Content */}
      <ScrollArea className="flex-1">
        <div className="p-6 space-y-4">
          {/* Search and Filter Bar */}
          {providers.length > 0 && (
            <div className="space-y-3">
              <div className="flex gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search agents by name or ID..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
              
              {/* Type Filter Chips */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                  <Filter className="w-3 h-3" />
                  Filter:
                </span>
                <Button
                  size="sm"
                  variant={typeFilter === 'all' ? 'default' : 'outline'}
                  onClick={() => setTypeFilter('all')}
                  className="h-7 text-xs"
                >
                  All ({providers.length})
                </Button>
                <Button
                  size="sm"
                  variant={typeFilter === 'copilot-studio' ? 'default' : 'outline'}
                  onClick={() => setTypeFilter('copilot-studio')}
                  className="h-7 text-xs gap-1"
                >
                  <Shield className="w-3 h-3" />
                  Copilot Studio ({providers.filter(p => p.type === 'copilot-studio').length})
                </Button>
                <Button
                  size="sm"
                  variant={typeFilter === 'azure-foundry' ? 'default' : 'outline'}
                  onClick={() => setTypeFilter('azure-foundry')}
                  className="h-7 text-xs gap-1"
                >
                  <Zap className="w-3 h-3" />
                  Azure Foundry ({providers.filter(p => p.type === 'azure-foundry').length})
                </Button>
              </div>
            </div>
          )}

          {/* Add New Agent Form */}
          {isAddingNew && (
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                      <Plus className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold">Add New Agent</h3>
                      <p className="text-xs text-muted-foreground">Configure a Copilot Studio agent</p>
                    </div>
                  </div>
                </div>
                
                <AgentForm 
                  formData={formData}
                  updateFormField={updateFormField}
                  onToggleCaptionResponse={(checked) => setFormData(prev => ({ ...prev, captionResponseAsChat: checked }))}
                  onSave={handleSave}
                  onCancel={handleCancel}
                  isFormValid={isFormValid}
                  isNew
                  existingProviders={providers}
                  onTypeChange={handleTypeChange}
                  onCopyFrom={(provider) => {
                    if (provider.type === 'copilot-studio' && formData.type === 'copilot-studio') {
                      setFormData(prev => ({
                        ...prev as AuthenticatedFormData,
                        clientId: provider.settings.clientId,
                        tenantId: provider.settings.tenantId,
                        environmentId: provider.settings.environmentId,
                      }))
                    } else if (provider.type === 'azure-foundry' && formData.type === 'azure-foundry') {
                      setFormData(prev => ({
                        ...prev as FoundryFormData,
                        projectEndpoint: provider.settings.projectEndpoint,
                        region: provider.settings.region,
                        tenantId: provider.settings.tenantId ?? '',
                        clientId: provider.settings.clientId ?? '',
                        clientSecret: provider.settings.clientSecret ?? '',
                      }))
                    }
                  }}
                />
              </CardContent>
            </Card>
          )}

          {/* Agents List */}
          {providers.length === 0 && !isAddingNew ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
                  <Bot className="w-8 h-8 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-medium mb-1">No agents configured</h3>
                <p className="text-sm text-muted-foreground mb-6 max-w-sm">
                  Add a Copilot Studio agent to enable AI-powered responses in your meetings
                </p>
                <Button onClick={handleStartAdd}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add Your First Agent
                </Button>
              </CardContent>
            </Card>
          ) : filteredProviders.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
                  <Search className="w-6 h-6 text-muted-foreground" />
                </div>
                <h3 className="font-medium mb-1">No agents found</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Try adjusting your search or filter criteria
                </p>
                <Button size="sm" variant="outline" onClick={() => {
                  setSearchQuery('')
                  setTypeFilter('all')
                }}>
                  Clear Filters
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {filteredProviders.map((provider) => (
                <AgentCard
                  key={provider.id}
                  provider={provider}
                  isExpanded={expandedId === provider.id}
                  isEditing={editingId === provider.id}
                  isDeleting={deleteConfirmId === provider.id}
                  formData={editingId === provider.id ? formData : undefined}
                  onToggleExpand={() => handleToggleExpand(provider.id)}
                  onStartEdit={() => handleStartEdit(provider)}
                  onStartDelete={() => setDeleteConfirmId(provider.id)}
                  onConfirmDelete={() => handleDelete(provider.id)}
                  onCancelDelete={() => setDeleteConfirmId(null)}
                  onUpdateField={updateFormField}
                  onToggleCaptionResponse={(checked) => setFormData(prev => ({ ...prev, captionResponseAsChat: checked }))}
                  onSave={handleSave}
                  onCancelEdit={handleCancel}
                  isFormValid={isFormValid}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

// Agent Card Component
interface AgentCardProps {
  provider: AgentProviderConfig
  isExpanded: boolean
  isEditing: boolean
  isDeleting: boolean
  formData?: AgentFormData
  onToggleExpand: () => void
  onStartEdit: () => void
  onStartDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
  onUpdateField: <K extends keyof AuthenticatedFormData | keyof FoundryFormData>(field: K, value: string | number | boolean) => void
  onToggleCaptionResponse: (checked: boolean) => void
  onSave: () => void
  onCancelEdit: () => void
  isFormValid: boolean
}

function AgentCard({
  provider,
  isExpanded,
  isEditing,
  isDeleting,
  formData,
  onToggleExpand,
  onStartEdit,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
  onUpdateField,
  onToggleCaptionResponse,
  onSave,
  onCancelEdit,
  isFormValid,
}: AgentCardProps) {
  const isAuthenticated = provider.type === 'copilot-studio'
  const isFoundry = provider.type === 'azure-foundry'
  const settings = isAuthenticated ? provider.settings : null
  const foundrySettings = isFoundry ? provider.settings : null
  const [chatMessages, setChatMessages] = useState<AgentChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatPhase, setChatPhase] = useState<'idle' | 'connecting' | 'sending' | 'waiting'>('idle')
  const chatMessagesRef = useRef<AgentChatMessage[]>([])
  const chatEndRef = useRef<HTMLDivElement>(null)
  const hasAutoConnectedRef = useRef(false)

  const meetingAgent = useMeetingAgent({
    mode: 'pre-meeting',
    emitTelemetry: false,
    syncAgentStore: false,
    emitAppLogs: false,
    requireAccessTokenForCopilot: false,
    onMessageReceived: (message) => {
      setChatMessages((prev) => {
        const lastMessage = prev[prev.length - 1]
        if (lastMessage && lastMessage.role === message.role && lastMessage.text === message.text) {
          return prev
        }

        return [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: message.role,
            text: message.text,
            timestamp: message.timestamp,
          },
        ]
      })
      setChatError(null)
      setChatPhase('idle')
    },
  })

  useEffect(() => {
    chatMessagesRef.current = chatMessages
  }, [chatMessages])

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, meetingAgent.authPrompt])

  const buildMeetingConfig = useCallback((agentProvider: AgentProviderConfig): MeetingAgentConfig | null => {
    if (agentProvider.type === 'copilot-studio') {
      return {
        type: 'copilot-studio',
        clientId: agentProvider.settings.clientId,
        tenantId: agentProvider.settings.tenantId,
        environmentId: agentProvider.settings.environmentId,
        botId: agentProvider.settings.botId,
        botName: agentProvider.settings.botName || agentProvider.name,
      }
    }

    if (agentProvider.type === 'azure-foundry') {
      return {
        type: 'azure-foundry',
        projectEndpoint: agentProvider.settings.projectEndpoint,
        agentName: agentProvider.settings.agentName,
        tenantId: agentProvider.settings.tenantId || '',
        clientId: agentProvider.settings.clientId || '',
        clientSecret: agentProvider.settings.clientSecret || '',
        region: agentProvider.settings.region,
        displayName: agentProvider.settings.displayName || agentProvider.settings.agentName || agentProvider.name,
      }
    }

    return null
  }, [])

  const ensureConnected = useCallback(async (): Promise<boolean> => {
    if (meetingAgent.isConnected) {
      return true
    }

    // For Azure Foundry, verify required settings are present
    if (provider.type === 'azure-foundry') {
      const fs = provider.settings
      const missing: string[] = []
      if (!fs.projectEndpoint) missing.push('projectEndpoint')
      if (!fs.agentName) missing.push('agentName')
      if (!fs.tenantId) missing.push('tenantId')
      if (!fs.clientId) missing.push('clientId')
      if (!fs.clientSecret) missing.push('clientSecret')
      if (missing.length > 0) {
        setChatError(`Azure Foundry configuration incomplete: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`)
        return false
      }
    }

    const config = buildMeetingConfig(provider)
    if (!config) {
      setChatError('Unsupported provider type.')
      return false
    }

    setChatPhase('connecting')
    setChatError(null)

    try {
      const result = await meetingAgent.connect(config)
      if (!result.success) {
        setChatError(meetingAgent.error || 'Failed to connect.')
        setChatPhase('idle')
      } else {
        setChatPhase('idle')
      }
      return result.success
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Failed to connect.')
      setChatPhase('idle')
      return false
    }
  }, [buildMeetingConfig, meetingAgent, provider])

  // Auto-connect when expanding the card
  useEffect(() => {
    if (isExpanded && !isEditing && !meetingAgent.isConnected && !meetingAgent.isConnecting && !hasAutoConnectedRef.current) {
      hasAutoConnectedRef.current = true
      // Small delay to let the UI render first
      const timer = setTimeout(() => {
        void ensureConnected()
      }, 300)
      return () => clearTimeout(timer)
    }
    if (!isExpanded) {
      hasAutoConnectedRef.current = false
    }
  }, [isExpanded, isEditing, meetingAgent.isConnected, meetingAgent.isConnecting, ensureConnected])

  const handleSendChat = useCallback(async () => {
    const text = chatInput.trim()
    if (!text || meetingAgent.isConnecting || meetingAgent.isProcessing || chatPhase === 'connecting') {
      return
    }

    setChatError(null)
    setChatPhase('sending')

    const connected = await ensureConnected()
    if (!connected) {
      setChatPhase('idle')
      return
    }

    const assistantMessagesBefore = chatMessagesRef.current.filter((message) => message.role === 'assistant').length

    setChatMessages((prev) => {
      const lastMessage = prev[prev.length - 1]
      if (lastMessage && lastMessage.role === 'user' && lastMessage.text === text) {
        return prev
      }

      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'user',
          text,
          timestamp: new Date(),
        },
      ]
    })
    setChatInput('')

    const response = await meetingAgent.sendMessage(text, 'Operator')

    if (meetingAgent.error) {
      setChatError(meetingAgent.error)
      setChatPhase('idle')
      return
    }

    if (response?.text) {
      setChatPhase('idle')
      return
    }

    setChatPhase('waiting')
    await new Promise(resolve => setTimeout(resolve, 2500))

    const assistantMessagesAfter = chatMessagesRef.current.filter((message) => message.role === 'assistant').length
    if (assistantMessagesAfter <= assistantMessagesBefore) {
      setChatError('No response yet. The agent may still be processing your request.')
    }
    setChatPhase('idle')
  }, [chatInput, ensureConnected, meetingAgent, chatPhase])

  const handleResetChat = useCallback(async () => {
    setChatMessages([])
    setChatInput('')
    setChatError(null)
    setChatPhase('idle')
    hasAutoConnectedRef.current = false

    if (meetingAgent.isConnected) {
      await meetingAgent.disconnect()
    }
  }, [meetingAgent])

  useEffect(() => {
    if (meetingAgent.error) {
      setChatError(meetingAgent.error)
      if (chatPhase !== 'idle') setChatPhase('idle')
    }
  }, [meetingAgent.error])

  return (
    <Card className={`transition-all ${isExpanded ? 'ring-1 ring-primary/30' : ''}`}>
      <CardContent className="p-0">
        {/* Header Row - Always Visible */}
        <div 
          className="flex items-center gap-4 p-4 cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={onToggleExpand}
        >
          <button className="p-1 hover:bg-muted rounded transition-colors">
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
          
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
            isFoundry 
              ? 'bg-purple-500/10 text-purple-600 dark:bg-purple-500/20 dark:text-purple-400'
              : 'bg-blue-500/10 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400'
          }`}>
            {isFoundry ? <Zap className="w-5 h-5" /> : <Shield className="w-5 h-5" />}
          </div>
          
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold truncate">{provider.name}</h3>
              {meetingAgent.isConnected && (
                <Badge variant="secondary" className="text-[10px] gap-1 bg-green-500/10 text-green-600 border-green-500/20">
                  <CheckCircle2 className="w-2.5 h-2.5" />
                  Connected
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Agent Type Badge */}
              {isAuthenticated && (
                <Badge variant="outline" className="text-xs gap-1 bg-blue-500/5 text-blue-600 border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-400">
                  <Shield className="w-3 h-3" />
                  Copilot Studio
                </Badge>
              )}
              {isFoundry && (
                <Badge variant="outline" className="text-xs gap-1 bg-purple-500/5 text-purple-600 border-purple-500/20 dark:bg-purple-500/10 dark:text-purple-400">
                  <Zap className="w-3 h-3" />
                  Azure Foundry
                </Badge>
              )}
              {/* Agent ID/Details */}
              <span className="text-xs text-muted-foreground font-mono">
                {settings && settings.botId.slice(0, 12)}
                {foundrySettings && foundrySettings.agentName}
              </span>
            </div>
          </div>
          
          {/* Action Buttons */}
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {isDeleting ? (
              <>
                <Button size="sm" variant="destructive" onClick={onConfirmDelete}>
                  <Check className="w-3 h-3 mr-1" />
                  Delete
                </Button>
                <Button size="sm" variant="outline" onClick={onCancelDelete}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={onStartEdit}
                  title="Edit"
                >
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={onStartDelete}
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Expanded Content */}
        {isExpanded && (
          <div className="border-t px-4 pb-4 pt-4 bg-muted/30">
            {isEditing && formData ? (
              <AgentForm
                formData={formData}
                updateFormField={onUpdateField}
                onToggleCaptionResponse={onToggleCaptionResponse}
                onSave={onSave}
                onCancel={onCancelEdit}
                isFormValid={isFormValid}
              />
            ) : (
              <div className="space-y-4">
                {/* Config Display */}
                {settings && (
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <ConfigField label="App Client ID" value={settings.clientId} />
                    <ConfigField label="Tenant ID" value={settings.tenantId} />
                    <ConfigField label="Environment ID" value={settings.environmentId} />
                    <ConfigField label="Bot ID" value={settings.botId} />
                    {settings.botName && (
                      <ConfigField label="Bot Display Name" value={settings.botName} />
                    )}
                    <div className="flex items-center gap-2">
                      <ConfigField 
                        label="Voice" 
                        value={VOICE_OPTIONS.find(v => v.value === provider.voiceName)?.label || provider.voiceName || 'en-US-JennyNeural (Default)'} 
                      />
                      <VoicePreviewButton
                        voiceName={provider.voiceName || 'en-US-JennyNeural'}
                        ttsStyle={provider.ttsStyle}
                        speechRate={provider.speechRate}
                        compact
                        className="mt-3"
                      />
                    </div>
                    <ConfigField
                      label="Speaking Style"
                      value={STYLE_OPTIONS.find(s => s.value === provider.ttsStyle)?.label || 'Chat (Conversational)'}
                    />
                    <ConfigField
                      label="Speech Speed"
                      value={`${(provider.speechRate ?? 1.0).toFixed(1)}×`}
                    />
                    <ConfigField
                      label="Caption Response"
                      value={provider.captionResponseAsChat ? 'Via chat' : 'Via speech'}
                    />
                    {provider.proactiveConfig?.enabled && (
                      <ConfigField
                        label="Proactive Mode"
                        value={`Enabled (${provider.proactiveConfig.silenceThresholdMs / 1000}s silence, via ${provider.proactiveConfig.responseChannel}, ${getProactiveTurnTakingSummary(provider.proactiveConfig.turnTakingMode)})`}
                      />
                    )}
                  </div>
                )}
                {foundrySettings && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <ConfigField label="Project Endpoint" value={foundrySettings.projectEndpoint} />
                    <ConfigField label="Agent Name" value={foundrySettings.agentName} />
                    <ConfigField label="Tenant ID" value={(foundrySettings.tenantId || '').slice(0, 8) + '...'} />
                    <ConfigField label="Client ID" value={(foundrySettings.clientId || '').slice(0, 8) + '...'} />
                    <ConfigField label="Client Secret" value={
                      foundrySettings.clientSecret 
                        ? '•'.repeat(16) + foundrySettings.clientSecret.slice(-4)
                        : 'Not configured - please edit to add secret'
                    } />
                    {foundrySettings.displayName && (
                      <ConfigField label="Display Name" value={foundrySettings.displayName} />
                    )}
                    <div className="flex items-center gap-2">
                      <ConfigField 
                        label="Voice" 
                        value={VOICE_OPTIONS.find(v => v.value === provider.voiceName)?.label || provider.voiceName || 'en-US-JennyNeural (Default)'} 
                      />
                      <VoicePreviewButton
                        voiceName={provider.voiceName || 'en-US-JennyNeural'}
                        ttsStyle={provider.ttsStyle}
                        speechRate={provider.speechRate}
                        compact
                        className="mt-3"
                      />
                    </div>
                    <ConfigField
                      label="Speaking Style"
                      value={STYLE_OPTIONS.find(s => s.value === provider.ttsStyle)?.label || 'Chat (Conversational)'}
                    />
                    <ConfigField
                      label="Speech Speed"
                      value={`${(provider.speechRate ?? 1.0).toFixed(1)}×`}
                    />
                    <ConfigField
                      label="Caption Response"
                      value={provider.captionResponseAsChat ? 'Via chat' : 'Via speech'}
                    />
                    {provider.proactiveConfig?.enabled && (
                      <ConfigField
                        label="Proactive Mode"
                        value={`Enabled (${provider.proactiveConfig.silenceThresholdMs / 1000}s silence, via ${provider.proactiveConfig.responseChannel}, ${getProactiveTurnTakingSummary(provider.proactiveConfig.turnTakingMode)})`}
                      />
                    )}
                  </div>
                )}

                {/* Unified Test Chat Panel */}
                <div className="rounded-lg border bg-background/60 p-3 flex flex-col gap-3">
                  {/* Header with connection status */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <MessageSquare className="w-4 h-4" />
                      <span>Test Chat</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge 
                        variant={meetingAgent.isConnected ? 'default' : meetingAgent.isConnecting || chatPhase === 'connecting' ? 'outline' : 'secondary'}
                        className={meetingAgent.isConnected ? 'bg-green-500/10 text-green-600 border-green-500/20' : ''}
                      >
                        {meetingAgent.isConnected 
                          ? 'Connected' 
                          : meetingAgent.isConnecting || chatPhase === 'connecting'
                          ? 'Connecting...'
                          : chatError 
                          ? 'Error'
                          : 'Disconnected'}
                      </Badge>
                    </div>
                  </div>

                  {/* Auth prompt for CPS Auth (inline device code) */}
                  {meetingAgent.authPrompt && !meetingAgent.isConnected && (
                    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 flex flex-col gap-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Info className="w-4 h-4 text-blue-500" />
                        <span>Enter code {meetingAgent.authPrompt.userCode}</span>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 ml-1"
                          onClick={() => navigator.clipboard.writeText(meetingAgent.authPrompt!.userCode)}
                          title="Copy device code"
                        >
                          <Copy className="w-3 h-3" />
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {meetingAgent.authPrompt.message || `To sign in, open https://microsoft.com/devicelogin and enter the code ${meetingAgent.authPrompt.userCode} to authenticate.`}
                      </p>
                    </div>
                  )}

                  {/* Chat messages */}
                  <div className="max-h-64 overflow-y-auto rounded border bg-muted/30 p-2 space-y-2">
                    {chatMessages.length === 0 && !meetingAgent.isConnecting && chatPhase !== 'connecting' ? (
                      <p className="text-xs text-muted-foreground text-center py-4">
                        Send a message to start testing this agent.
                      </p>
                    ) : chatMessages.length === 0 && (meetingAgent.isConnecting || chatPhase === 'connecting') ? (
                      <TypingIndicator text="Connecting to agent..." className="justify-center py-4" />
                    ) : (
                      chatMessages.map((message) => (
                        <div
                          key={message.id}
                          className={`rounded-lg p-2.5 text-xs max-w-[85%] ${
                            message.role === 'assistant'
                              ? 'bg-background border text-foreground mr-auto'
                              : 'bg-primary/10 border border-primary/20 text-foreground ml-auto'
                          }`}
                        >
                          <p className="font-medium mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                            {message.role === 'assistant' 
                              ? (foundrySettings?.displayName || settings?.botName || provider.name) 
                              : 'You'}
                          </p>
                          <p className="whitespace-pre-wrap leading-relaxed">{message.text}</p>
                        </div>
                      ))
                    )}
                    {(meetingAgent.isTyping || chatPhase === 'waiting' || chatPhase === 'sending') && chatMessages.length > 0 && (
                      <TypingIndicator
                        text={chatPhase === 'sending' ? 'Sending...' : 'Agent is typing...'}
                      />
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  {/* Chat input */}
                  <div className="flex items-center gap-2">
                    <Input
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder="Type a test message..."
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void handleSendChat()
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      onClick={() => void handleSendChat()}
                      disabled={
                        meetingAgent.isConnecting ||
                        meetingAgent.isProcessing ||
                        chatPhase === 'connecting' ||
                        chatPhase === 'sending' ||
                        !chatInput.trim()
                      }
                    >
                      {chatPhase === 'sending' ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        'Send'
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleResetChat()}
                      title="Clear chat and disconnect"
                    >
                      <RotateCcw className="w-3 h-3" />
                    </Button>
                  </div>

                  {/* Error display with retry */}
                  {chatError && (
                    <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/5 p-2">
                      <AlertCircle className="w-3.5 h-3.5 text-destructive mt-0.5 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-destructive">{chatError}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs px-2 flex-shrink-0"
                        onClick={() => {
                          setChatError(null)
                          hasAutoConnectedRef.current = false
                          void ensureConnected()
                        }}
                      >
                        Retry
                      </Button>
                    </div>
                  )}
                </div>
                
                {/* Quick Actions */}
                <div className="flex items-center gap-2 pt-1">
                  <Button size="sm" variant="ghost" onClick={onStartEdit}>
                    <Settings2 className="w-3 h-3 mr-2" />
                    Edit Configuration
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// Config Field Display
function ConfigField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-sm font-mono bg-background/50 rounded px-2 py-1.5 truncate border">{value}</p>
    </div>
  )
}

// Agent Form Component
interface AgentFormProps {
  formData: AgentFormData
  updateFormField: <K extends keyof AuthenticatedFormData | keyof FoundryFormData>(field: K, value: string | number | boolean) => void
  onToggleCaptionResponse: (checked: boolean) => void
  onSave: () => void
  onCancel: () => void
  isFormValid: boolean
  isNew?: boolean
  existingProviders?: AgentProviderConfig[]
  onCopyFrom?: (provider: AgentProviderConfig) => void
  onTypeChange?: (type: FormAgentType) => void
}

function AgentForm({ formData, updateFormField, onToggleCaptionResponse, onSave, onCancel, isFormValid, isNew, existingProviders, onCopyFrom, onTypeChange }: AgentFormProps) {
  const copilotProviders = existingProviders?.filter(p => p.type === 'copilot-studio') || []
  const foundryProviders = existingProviders?.filter(p => p.type === 'azure-foundry') || []
  const isAuthenticated = formData.type === 'copilot-studio'
  const isFoundry = formData.type === 'azure-foundry'
  const [showReactiveAdvanced, setShowReactiveAdvanced] = useState(false)
  const [showProactiveAdvanced, setShowProactiveAdvanced] = useState(false)
  
  return (
    <div className="space-y-4">
      {/* Agent Type Selection - only show when adding new */}
      {isNew && onTypeChange && (
        <div className="flex flex-col gap-2 p-3 rounded-lg bg-background border">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-muted-foreground">Agent Type:</span>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={isAuthenticated ? 'default' : 'outline'}
                size="sm"
                className="h-8 text-xs"
                onClick={() => onTypeChange('copilot-studio')}
              >
                <Shield className="w-3 h-3 mr-1.5" />
                CPS Auth
              </Button>
              <Button
                variant={isFoundry ? 'default' : 'outline'}
                size="sm"
                className="h-8 text-xs"
                onClick={() => onTypeChange('azure-foundry')}
              >
                <Cloud className="w-3 h-3 mr-1.5" />
                Foundry
              </Button>
            </div>
          </div>
          <span className="text-[10px] text-muted-foreground">
            {isAuthenticated 
              ? 'Copilot Studio with Microsoft login (device code flow)' 
              : 'Azure AI Foundry agent with OAuth2 service principal'}
          </span>
        </div>
      )}

      {/* Copy from existing - only show when adding new authenticated agent */}
      {isNew && isAuthenticated && copilotProviders.length > 0 && onCopyFrom && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50 border border-dashed">
          <span className="text-xs text-muted-foreground">Copy settings from:</span>
          <div className="flex flex-wrap gap-2">
            {copilotProviders.map((provider) => (
              <Button
                key={provider.id}
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onCopyFrom(provider)}
              >
                <Bot className="w-3 h-3 mr-1.5" />
                {provider.name}
              </Button>
            ))}
          </div>
          <span className="text-[10px] text-muted-foreground ml-auto">Copies Client ID, Tenant ID, Environment ID</span>
        </div>
      )}

      {/* Copy from existing - only show when adding new foundry agent */}
      {isNew && isFoundry && foundryProviders.length > 0 && onCopyFrom && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50 border border-dashed">
          <span className="text-xs text-muted-foreground">Copy settings from:</span>
          <div className="flex flex-wrap gap-2">
            {foundryProviders.map((provider) => (
              <Button
                key={provider.id}
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onCopyFrom(provider)}
              >
                <Zap className="w-3 h-3 mr-1.5" />
                {provider.name}
              </Button>
            ))}
          </div>
          <span className="text-[10px] text-muted-foreground ml-auto">Copies Endpoint, Region, Tenant ID, Client ID, Client Secret</span>
        </div>
      )}

      {/* Common fields */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor="agent-name" className="text-xs font-medium">Agent Name *</Label>
          <Input
            id="agent-name"
            placeholder="e.g., Sales Assistant"
            value={formData.name}
            onChange={(e) => updateFormField('name', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bot-name" className="text-xs font-medium">Display Name</Label>
          <Input
            id="bot-name"
            placeholder="Name shown in chat"
            value={isFoundry ? (formData as FoundryFormData).displayName || '' : (formData as AuthenticatedFormData).botName || ''}
            onChange={(e) => {
              if (isFoundry) {
                updateFormField('displayName', e.target.value)
              } else {
                updateFormField('botName', e.target.value)
              }
            }}
          />
        </div>
      </div>

      {/* ── Reactive Mode Section ── */}
      <div className="space-y-3 rounded-lg border p-3">
        <div className="flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5 text-blue-500" />
          <span className="text-xs font-medium">Reactive Mode</span>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Responds when mentioned by name in captions or @mentioned in chat.
        </p>

        {/* Voice Selection */}
        <div className="space-y-1.5">
          <Label htmlFor="voice-select" className="text-xs font-medium">Voice</Label>
          <div className="flex gap-2">
            <Select
              value={formData.voiceName || 'en-US-JennyNeural'}
              onValueChange={(newVoice) => {
                updateFormField('voiceName', newVoice)
              }}
            >
              <SelectTrigger id="voice-select" className="flex-1">
                <SelectValue placeholder="Select voice" />
              </SelectTrigger>
              <SelectContent>
                {VOICE_OPTIONS.map((voice) => (
                  <SelectItem key={voice.value} value={voice.value}>{voice.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <VoicePreviewButton
              voiceName={formData.voiceName || 'en-US-JennyNeural'}
              ttsStyle={formData.ttsStyle}
              speechRate={formData.speechRate}
            />
          </div>
        </div>

        {/* Caption response channel */}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Caption Mention Response</Label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={formData.captionResponseAsChat ?? false}
              onChange={(e) => onToggleCaptionResponse(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <span className="text-xs text-muted-foreground">
              Respond to caption mentions via chat instead of speech
            </span>
          </label>
        </div>

        {/* Advanced voice options */}
        <button
          type="button"
          onClick={() => setShowReactiveAdvanced(!showReactiveAdvanced)}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {showReactiveAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <Settings2 className="w-3 h-3" />
          Advanced voice options
        </button>

        {showReactiveAdvanced && (
          <VoiceSelector
            voiceName={formData.voiceName || 'en-US-JennyNeural'}
            onVoiceChange={(voice) => updateFormField('voiceName', voice)}
            ttsStyle={formData.ttsStyle || 'chat'}
            onStyleChange={(style) => updateFormField('ttsStyle', style)}
            speechRate={formData.speechRate ?? 1.0}
            onSpeechRateChange={(rate) => updateFormField('speechRate', rate)}
            styleDegree={formData.styleDegree ?? 1.3}
            onStyleDegreeChange={(degree) => updateFormField('styleDegree', degree)}
          />
        )}
      </div>

      {/* ── Welcome Message Section ── */}
      <div className="space-y-3 rounded-lg border p-3">
        <div className="flex items-center gap-1.5">
          <MessageSquare className="w-3.5 h-3.5 text-green-500" />
          <span className="text-xs font-medium">Welcome Message</span>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Message sent to the meeting chat when the agent joins a call.
        </p>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Mode</Label>
          <Select
            value={formData.welcomeMode ?? 'default'}
            onValueChange={(val) => updateFormField('welcomeMode', val as WelcomeMessageMode)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Default greeting</SelectItem>
              <SelectItem value="custom">Custom static message</SelectItem>
              <SelectItem value="agent-triggered">Agent-triggered greeting</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {(!formData.welcomeMode || formData.welcomeMode === 'default') && (
          <p className="text-[10px] text-muted-foreground bg-muted/50 rounded-md px-3 py-2 italic">
            {buildDefaultWelcomeMessage(
              ('displayName' in formData && formData.displayName) ||
              ('botName' in formData && formData.botName) ||
              formData.name
            )}
          </p>
        )}

        {formData.welcomeMode === 'custom' && (
          <div className="space-y-1.5">
            <Label htmlFor="welcome-static" className="text-xs font-medium">Message</Label>
            <textarea
              id="welcome-static"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-[60px] resize-y"
              placeholder="e.g., Hi team! I'm here to help with your questions — just @mention me in chat."
              value={formData.welcomeStaticMessage || ''}
              onChange={(e) => updateFormField('welcomeStaticMessage', e.target.value)}
            />
          </div>
        )}

        {formData.welcomeMode === 'agent-triggered' && (
          <div className="space-y-1.5">
            <Label htmlFor="welcome-trigger" className="text-xs font-medium">Trigger Prompt</Label>
            <textarea
              id="welcome-trigger"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-[60px] resize-y"
              placeholder="e.g., Introduce yourself to the meeting participants and briefly explain how you can help."
              value={formData.welcomeTriggerPrompt || ''}
              onChange={(e) => updateFormField('welcomeTriggerPrompt', e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">
              This prompt is sent to the agent when it joins. The agent's response becomes the welcome message in chat.
            </p>
          </div>
        )}
      </div>

      {/* ── Proactive Mode Section ── */}
      <div className="space-y-3 rounded-lg border p-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={formData.proactiveEnabled ?? false}
            onChange={(e) => updateFormField('proactiveEnabled', e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-amber-500" />
            <span className="text-xs font-medium">Proactive Mode</span>
          </div>
        </label>
        <p className="text-[10px] text-muted-foreground">
          When enabled, the agent proactively speaks during silence based on its instructions — ideal for role-play, coaching, interviews, and facilitated conversations.
        </p>

        {formData.proactiveEnabled && (
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="proactive-instructions" className="text-xs font-medium">Agent Instructions *</Label>
              <textarea
                id="proactive-instructions"
                placeholder="Describe the agent's role, goals, and scenario. Example: You are a customer service training coach. Role-play as a difficult customer returning a defective product..."
                value={formData.proactiveInstructions || ''}
                onChange={(e) => updateFormField('proactiveInstructions', e.target.value)}
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                rows={4}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="proactive-channel" className="text-xs font-medium">Proactive Channel</Label>
              <Select
                value={formData.proactiveResponseChannel || 'speech'}
                onValueChange={(val) => updateFormField('proactiveResponseChannel', val)}
              >
                <SelectTrigger id="proactive-channel">
                  <SelectValue placeholder="Channel" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="speech">Speech (TTS)</SelectItem>
                  <SelectItem value="chat">Chat</SelectItem>
                  <SelectItem value="auto">Auto</SelectItem>
                </SelectContent>
              </Select>
              {(formData.proactiveResponseChannel as ProactiveResponseChannel) === 'auto' && (
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Info className="w-3 h-3 shrink-0" />
                  Auto applies to Proactive mode only; Reactive channel is unaffected.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="proactive-turn-taking" className="text-xs font-medium">Turn-taking</Label>
              <Select
                value={formData.proactiveTurnTakingMode ?? DEFAULT_PROACTIVE_TURN_TAKING_MODE}
                onValueChange={(val) => updateFormField('proactiveTurnTakingMode', val as ProactiveTurnTakingMode)}
              >
                <SelectTrigger id="proactive-turn-taking">
                  <SelectValue placeholder="Turn-taking mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="interview-safe">Interview-safe (keep the floor)</SelectItem>
                  <SelectItem value="interruptible">Interruptible (allow barge-in)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                <Info className="w-3 h-3 shrink-0" />
                {(formData.proactiveTurnTakingMode ?? DEFAULT_PROACTIVE_TURN_TAKING_MODE) === 'interview-safe'
                  ? 'Recommended for interviews, coaching, and role-play. The agent finishes its spoken turn, buffers overlapping human captions, then decides what to do next.'
                  : 'Matches the legacy behavior: any human caption can cut off spoken proactive responses immediately.'}
              </p>
            </div>

            {/* Advanced proactive options */}
            <button
              type="button"
              onClick={() => setShowProactiveAdvanced(!showProactiveAdvanced)}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {showProactiveAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              <Settings2 className="w-3 h-3" />
              Advanced options
            </button>

            {showProactiveAdvanced && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="silence-threshold" className="text-xs font-medium">Silence Threshold</Label>
                  <div className="flex items-center gap-2">
                    <input
                      id="silence-threshold"
                      type="range"
                      min={0.5}
                      max={30}
                      step={0.5}
                      value={formData.proactiveSilenceThresholdSec ?? 10}
                      onChange={(e) => updateFormField('proactiveSilenceThresholdSec', parseFloat(e.target.value))}
                      className="flex-1 h-1.5 accent-primary"
                    />
                    <span className="text-xs text-muted-foreground w-10 text-right">{(formData.proactiveSilenceThresholdSec ?? 10).toFixed(1)}s</span>
                  </div>
                </div>
              </div>
            )}

            {/* ── Auto-Leave on Completion ── */}
            <div className="space-y-3 rounded-md border border-dashed p-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.proactiveAutoLeave ?? false}
                  onChange={(e) => updateFormField('proactiveAutoLeave', e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                <div className="flex items-center gap-1.5">
                  <LogOut className="w-3.5 h-3.5 text-rose-500" />
                  <span className="text-xs font-medium">Auto-leave when done</span>
                </div>
              </label>
              <p className="text-[10px] text-muted-foreground">
                When the agent decides its role is complete, it will send a goodbye message and leave the meeting automatically. The agent signals this by including <code className="text-[10px] bg-muted px-1 rounded">[LEAVE_MEETING]</code> in its response.
              </p>

              {formData.proactiveAutoLeave && (
                <div className="space-y-3 pt-1">
                  <div className="space-y-1.5">
                    <Label htmlFor="goodbye-message" className="text-xs font-medium">Goodbye Message (optional)</Label>
                    <Input
                      id="goodbye-message"
                      placeholder="Exact message to use when the agent auto-leaves"
                      value={formData.proactiveGoodbyeMessage ?? ''}
                      onChange={(e) => updateFormField('proactiveGoodbyeMessage', e.target.value)}
                    />
                    <p className="text-[10px] text-muted-foreground">
                      If set, this exact message is used for the final speech/chat before leaving. If left blank, the agent text before [LEAVE_MEETING] is used instead.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="goodbye-channel" className="text-xs font-medium">Goodbye Channel</Label>
                    <Select
                      value={formData.proactiveGoodbyeChannel ?? 'both'}
                      onValueChange={(val) => updateFormField('proactiveGoodbyeChannel', val)}
                    >
                      <SelectTrigger id="goodbye-channel">
                        <SelectValue placeholder="Channel" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="both">Both (Speech + Chat)</SelectItem>
                        <SelectItem value="speech">Speech only</SelectItem>
                        <SelectItem value="chat">Chat only</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Authenticated agent fields */}
      {isAuthenticated && formData.type === 'copilot-studio' && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="bot-id" className="text-xs font-medium">Bot ID (Agent Identifier) *</Label>
            <Input
              id="bot-id"
              placeholder="cr123_agentName or your-agent-schema-name"
              value={formData.botId}
              onChange={(e) => updateFormField('botId', e.target.value)}
              className="font-mono text-sm"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="client-id" className="text-xs font-medium">App Client ID *</Label>
              <Input
                id="client-id"
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                value={formData.clientId}
                onChange={(e) => updateFormField('clientId', e.target.value)}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tenant-id" className="text-xs font-medium">Tenant ID *</Label>
              <Input
                id="tenant-id"
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                value={formData.tenantId}
                onChange={(e) => updateFormField('tenantId', e.target.value)}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="environment-id" className="text-xs font-medium">Environment ID *</Label>
              <Input
                id="environment-id"
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                value={formData.environmentId}
                onChange={(e) => updateFormField('environmentId', e.target.value)}
                className="font-mono text-sm"
              />
            </div>
          </div>
        </>
      )}

      {/* Azure Foundry agent fields */}
      {isFoundry && formData.type === 'azure-foundry' && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="project-endpoint" className="text-xs font-medium">Project Endpoint *</Label>
            <Input
              id="project-endpoint"
              placeholder="https://your-project.services.ai.azure.com/api/projects/your-project-name"
              value={formData.projectEndpoint}
              onChange={(e) => updateFormField('projectEndpoint', e.target.value)}
              className="font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Azure AI Foundry project endpoint URL
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-name" className="text-xs font-medium">Agent ID *</Label>
              <Input
                id="agent-name"
                placeholder="CAB-Foundry:2"
                value={formData.agentName}
                onChange={(e) => updateFormField('agentName', e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-[10px] text-muted-foreground">
                Agent ID from Azure AI Foundry (e.g., CAB-Foundry:2)
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="region" className="text-xs font-medium">Region *</Label>
              <Input
                id="region"
                placeholder="eastus2"
                value={formData.region}
                onChange={(e) => updateFormField('region', e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-[10px] text-muted-foreground">
                Azure region (e.g., eastus2)
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tenant-id" className="text-xs font-medium">Tenant ID *</Label>
            <Input
              id="tenant-id"
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              value={formData.tenantId}
              onChange={(e) => updateFormField('tenantId', e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-[10px] text-muted-foreground">
              Azure AD Tenant ID (Directory ID from Azure Portal → Azure Active Directory)
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="client-id" className="text-xs font-medium">Client ID *</Label>
              <Input
                id="client-id"
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                value={formData.clientId}
                onChange={(e) => updateFormField('clientId', e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-[10px] text-muted-foreground">
                Application (client) ID from App Registration
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="client-secret" className="text-xs font-medium">Client Secret *</Label>
              <Input
                id="client-secret"
                type="password"
                placeholder="Enter client secret"
                value={formData.clientSecret}
                onChange={(e) => updateFormField('clientSecret', e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-[10px] text-muted-foreground">
                Client secret from App Registration → Certificates & secrets
              </p>
            </div>
          </div>
        </>
      )}

      <div className="flex items-center gap-2 pt-2">
        <Button onClick={onSave} disabled={!isFormValid}>
          <Check className="w-4 h-4 mr-2" />
          {isNew ? 'Add Agent' : 'Save Changes'}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          <X className="w-4 h-4 mr-2" />
          Cancel
        </Button>
      </div>
    </div>
  )
}

// Voice Selector Component with Preview
interface VoiceSelectorProps {
  voiceName: string
  onVoiceChange: (voice: string) => void
  ttsStyle: string
  onStyleChange: (style: string) => void
  speechRate: number
  onSpeechRateChange: (rate: number) => void
  styleDegree: number
  onStyleDegreeChange: (degree: number) => void
}

function VoiceSelector({
  voiceName, onVoiceChange, ttsStyle, onStyleChange, speechRate, onSpeechRateChange,
  styleDegree, onStyleDegreeChange,
}: VoiceSelectorProps) {
  const { isPreviewing, previewError, handlePreview, stopPreview } = useVoicePreview({
    voiceName,
    ttsStyle,
    speechRate,
  })

  return (
    <div className="space-y-3">
      {/* Azure Voice Controls */}
      <div className="space-y-1.5">
        <Label htmlFor="voice-select" className="text-xs font-medium">Voice</Label>
        <div className="flex gap-2">
          <Select
            value={voiceName}
                valueText={VOICE_OPTIONS.find((v) => v.value === voiceName)?.label || voiceName}
                onValueChange={(newVoice) => { stopPreview(); onVoiceChange(newVoice) }}
              >
                <SelectTrigger id="voice-select" className="flex-1">
                  <SelectValue placeholder="Select voice" />
                </SelectTrigger>
                <SelectContent>
                  {VOICE_OPTIONS.map((voice) => (
                    <SelectItem key={voice.value} value={voice.value} textValue={voice.label}>
                      {voice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={ttsStyle}
                valueText={STYLE_OPTIONS.find((s) => s.value === ttsStyle)?.label || ttsStyle}
                onValueChange={(newStyle) => { stopPreview(); onStyleChange(newStyle) }}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Style" />
                </SelectTrigger>
                <SelectContent>
                  {STYLE_OPTIONS.map((style) => (
                    <SelectItem key={style.value} value={style.value} textValue={style.label}>
                      {style.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {isPreviewing ? (
                <Button type="button" variant="outline" size="sm" onClick={stopPreview}
                  className="shrink-0 text-red-600 hover:text-red-700 hover:bg-red-50">
                  <Square className="w-3 h-3 mr-1.5" />Stop
                </Button>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={handlePreview} className="shrink-0">
                  <Volume2 className="w-3 h-3 mr-1.5" />Preview
                </Button>
              )}
            </div>
          </div>

          {/* Speed + Expressiveness */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center gap-2">
              <Label className="text-xs font-medium shrink-0">Speed</Label>
              <input type="range" min={0.5} max={2.0} step={0.1} value={speechRate}
                onChange={(e) => onSpeechRateChange(parseFloat(e.target.value))}
                className="flex-1 h-1.5 accent-primary" />
              <span className="text-xs text-muted-foreground w-10 text-right">{speechRate.toFixed(1)}×</span>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs font-medium shrink-0">Expression</Label>
              <input type="range" min={0.5} max={2.0} step={0.1} value={styleDegree}
                onChange={(e) => onStyleDegreeChange(parseFloat(e.target.value))}
                className="flex-1 h-1.5 accent-primary" />
              <span className="text-xs text-muted-foreground w-10 text-right">{styleDegree.toFixed(1)}×</span>
            </div>
          </div>

          {previewError && <p className="text-[10px] text-amber-600">{previewError}</p>}
          <p className="text-[10px] text-muted-foreground">
            {voiceName.includes('DragonHD') ? '✨ HD voice — auto-detects emotion and context for natural speech.' : 'Adjust expressiveness to control how animated the voice sounds.'}
          </p>
    </div>
  )
}
