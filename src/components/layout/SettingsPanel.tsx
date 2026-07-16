import React, { useEffect, useState } from 'react'
import {
  CheckCircle2,
  CircleAlert,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  PlugZap,
  Server,
} from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'
import { testPromptAssistantApi, type PromptAssistantApiConfig } from '@/lib/promptAssistant'
import {
  loadPromptAssistantApiKey,
  savePromptAssistantApiKey,
} from '@/lib/promptAssistantSecretStore'

export const SettingsPanel: React.FC = () => {
  const settings = useSettingsStore()
  const [showApiKey, setShowApiKey] = useState(false)
  const [testingApi, setTestingApi] = useState(false)
  const [apiTestResult, setApiTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [apiKeyReady, setApiKeyReady] = useState(false)
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const promptAssistantMode = settings.promptAssistantMode || 'tab'
  const persistedApiProvider: PromptAssistantApiConfig = settings.apiProvider || {
    enabled: false,
    endpoint: 'http://localhost:20128/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
  }
  const apiProvider: PromptAssistantApiConfig = { ...persistedApiProvider, apiKey }

  useEffect(() => {
    let active = true
    void loadPromptAssistantApiKey()
      .then((savedApiKey) => {
        if (!active) return
        setApiKey(savedApiKey)
        setApiKeyReady(true)
      })
      .catch((error) => {
        if (!active) return
        setApiKeyError(error instanceof Error ? error.message : 'Could not load the encrypted API key.')
        setApiKeyReady(true)
      })
    return () => { active = false }
  }, [])

  const updateApiProvider = (patch: Partial<PromptAssistantApiConfig>) => {
    const { apiKey: _ignoredApiKey, ...safePatch } = patch
    settings.updateSettings({
      apiProvider: { ...persistedApiProvider, ...safePatch, apiKey: '' },
    })
    setApiTestResult(null)
  }

  const updateApiKey = (value: string) => {
    setApiKey(value)
    setApiKeyError(null)
    setApiTestResult(null)
    void savePromptAssistantApiKey(value).catch((error) => {
      setApiKeyError(error instanceof Error ? error.message : 'Could not encrypt and save the API key.')
    })
  }

  const handleTestApi = async () => {
    if (!apiProvider.endpoint.trim() || !apiProvider.model.trim() || testingApi) return
    setTestingApi(true)
    setApiTestResult(null)
    try {
      const response = await testPromptAssistantApi(apiProvider)
      setApiTestResult({ ok: true, message: response || 'API connection successful' })
    } catch (error) {
      setApiTestResult({
        ok: false,
        message: error instanceof Error ? error.message : 'API connection failed.',
      })
    } finally {
      setTestingApi(false)
    }
  }

  const settingRowClass = 'grid min-h-14 grid-cols-[164px_minmax(0,1fr)] items-center gap-6 border-b border-white/[0.055] py-3.5'
  const settingLabelClass = 'flex items-center gap-2 text-xs font-medium text-white/50'
  const settingDescriptionClass = 'mt-1 text-[10px] leading-4 text-white/25'
  const settingInputClass = 'h-10 min-w-0 w-full rounded-lg border border-white/[0.07] bg-[#0C0C0C] px-3 font-mono text-[11px] text-white/70 outline-none transition-colors placeholder:text-white/20 hover:border-white/[0.13] focus:border-[#7C5CFF]/60 focus:ring-2 focus:ring-[#7C5CFF]/10'

  return (
    <div className="flex flex-col h-full bg-[#0A0A0A]">
      <div className="border-b border-white/5 px-5 py-4">
        <h2 className="text-xs font-semibold text-white/50 uppercase tracking-widest">Settings</h2>
      </div>
      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <div className="space-y-3">
          <label className="text-[10px] font-semibold text-white/30 uppercase tracking-widest">Appearance</label>
          <div className="space-y-1">
            <div className="flex min-h-8 items-center justify-between gap-6">
              <span className="text-xs font-medium text-white/50">Theme</span>
              <span className="text-[11px] font-medium capitalize text-white/35">{settings.theme}</span>
            </div>
            <div className="flex min-h-8 items-center justify-between gap-6">
              <span className="text-xs font-medium text-white/50">Default Provider</span>
              <span className="text-[11px] font-medium capitalize text-white/35">{settings.defaultProvider}</span>
            </div>
            <div className="flex min-h-8 items-center justify-between gap-6">
              <span className="text-xs font-medium text-white/50">Auto Download</span>
              <button
                onClick={() => settings.setAutoDownload(!settings.autoDownload)}
                className={cn(
                  'w-9 h-5 rounded-full transition-all relative',
                  settings.autoDownload ? 'bg-[#7C5CFF]' : 'bg-white/10'
                )}
              >
                <div className={cn(
                  'w-3.5 h-3.5 rounded-full bg-white absolute top-1/2 -translate-y-1/2 transition-all',
                  settings.autoDownload ? 'left-[22px]' : 'left-1'
                )} />
              </button>
            </div>
          </div>
        </div>

        <section>
          <div className="border-b border-white/[0.06] pb-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-white/30">Google Flow</h3>
          </div>
          <div className="flex min-h-14 items-center justify-between gap-6 border-b border-white/[0.055] py-3.5">
            <div>
              <p className="text-xs font-medium text-white/50">Recovery & Runtime Verification</p>
              <p className={settingDescriptionClass}>Show both utility panels in Generate. Flow safety remains active when hidden.</p>
            </div>
            <button
              type="button"
              aria-label="Show Flow Recovery and Runtime Verification"
              aria-pressed={settings.showFlowUtilityPanels !== false}
              onClick={() => settings.updateSettings({ showFlowUtilityPanels: settings.showFlowUtilityPanels === false })}
              className={cn(
                'relative h-5 w-9 shrink-0 rounded-full transition-all',
                settings.showFlowUtilityPanels !== false ? 'bg-[#7C5CFF]' : 'bg-white/10'
              )}
            >
              <span className={cn(
                'absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white transition-all',
                settings.showFlowUtilityPanels !== false ? 'left-[18px]' : 'left-1'
              )} />
            </button>
          </div>
        </section>

        <section>
          <div className="border-b border-white/[0.06] pb-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-white/30">Prompt execution</h3>
          </div>

          <div className={settingRowClass}>
            <div>
              <p className="text-xs font-medium text-white/50">Run prompts with</p>
              <p className={settingDescriptionClass}>Prompt Assistant and AI Idea Agent</p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                aria-pressed={promptAssistantMode === 'tab'}
                onClick={() => settings.updateSettings({ promptAssistantMode: 'tab' })}
                className={cn(
                  'h-9 rounded-lg px-4 text-[11px] font-semibold transition-colors',
                  promptAssistantMode === 'tab'
                    ? 'bg-[#7C5CFF]/18 text-[#D1C8FF]'
                    : 'text-white/30 hover:bg-white/[0.04] hover:text-white/60'
                )}
              >
                Browser tabs
              </button>
              <button
                type="button"
                aria-pressed={promptAssistantMode === 'api'}
                onClick={() => settings.updateSettings({
                  promptAssistantMode: 'api',
                  apiProvider: { ...persistedApiProvider, enabled: true, apiKey: '' },
                })}
                className={cn(
                  'h-9 rounded-lg px-4 text-[11px] font-semibold transition-colors',
                  promptAssistantMode === 'api'
                    ? 'bg-[#7C5CFF]/18 text-[#D1C8FF]'
                    : 'text-white/30 hover:bg-white/[0.04] hover:text-white/60'
                )}
              >
                API
              </button>
            </div>
          </div>

          <div className="flex min-h-14 items-center justify-between gap-6 border-b border-white/[0.055] py-3.5">
            <div className="flex min-w-0 items-center gap-3">
              <Server className="h-4 w-4 shrink-0 text-[#9D87FF]" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-white/55">Prompt Assistant API</p>
                <p className={cn(settingDescriptionClass, 'truncate')}>OpenAI-compatible endpoint, including local 9Router</p>
              </div>
            </div>
            <span className={cn('text-[10px] font-semibold', promptAssistantMode === 'api' ? 'text-emerald-300/75' : 'text-white/25')}>
              {promptAssistantMode === 'api' ? 'Active' : 'Inactive'}
            </span>
          </div>

          <label className={settingRowClass}>
            <span className={settingLabelClass}><Server className="h-3.5 w-3.5" /> API endpoint</span>
            <input
              value={apiProvider.endpoint}
              onChange={(event) => updateApiProvider({ endpoint: event.target.value })}
              placeholder="http://localhost:20128/v1"
              spellCheck={false}
              className={settingInputClass}
            />
          </label>

          <label className={settingRowClass}>
            <span className={settingLabelClass}><KeyRound className="h-3.5 w-3.5" /> API key</span>
            <div className="relative min-w-0">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiProvider.apiKey}
                onChange={(event) => updateApiKey(event.target.value)}
                placeholder={apiKeyReady ? 'Optional for local APIs' : 'Loading encrypted key...'}
                disabled={!apiKeyReady}
                autoComplete="off"
                spellCheck={false}
                className={cn(settingInputClass, 'pr-10 placeholder:font-sans')}
              />
              <button type="button" aria-label={showApiKey ? 'Hide API key' : 'Show API key'} onClick={() => setShowApiKey((current) => !current)} className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-lg text-white/25 hover:bg-white/[0.05] hover:text-white/60">
                {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </label>

          <label className={settingRowClass}>
            <span className={settingLabelClass}><Cpu className="h-3.5 w-3.5" /> Model</span>
            <input
              value={apiProvider.model}
              onChange={(event) => updateApiProvider({ model: event.target.value })}
              placeholder="gpt-4o-mini"
              spellCheck={false}
              className={settingInputClass}
            />
          </label>

          <div className={cn(settingRowClass, 'border-b-0')}>
            <div>
              <p className="text-xs font-medium text-white/50">Connection</p>
              <p className={settingDescriptionClass}>API key encrypted locally with AES-256-GCM</p>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                {apiTestResult && (
                  <div className={cn('flex items-start gap-2 text-[10px] leading-4', apiTestResult.ok ? 'text-emerald-300/75' : 'text-red-300/75')}>
                    {apiTestResult.ok ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" /> : <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />}
                    <span className="line-clamp-2">{apiTestResult.message}</span>
                  </div>
                )}
                {apiKeyError && !apiTestResult && (
                  <div className="flex items-start gap-2 text-[10px] leading-4 text-red-300/75">
                    <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="line-clamp-2">{apiKeyError}</span>
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={!apiKeyReady || !apiProvider.endpoint.trim() || !apiProvider.model.trim() || testingApi}
                onClick={() => void handleTestApi()}
                className="flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-[11px] font-semibold text-white/45 transition-colors hover:bg-white/[0.05] hover:text-white/75 disabled:cursor-not-allowed disabled:opacity-30"
              >
                {testingApi ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
                {testingApi ? 'Testing…' : 'Test connection'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
