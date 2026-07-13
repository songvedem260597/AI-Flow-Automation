import { PROVIDER_TABS } from '@/constants'
import { useSettingsStore } from '@/stores/settingsStore'
import type { AppSettings } from '@/types'
import { loadPromptAssistantApiKey } from '@/lib/promptAssistantSecretStore'

export type PromptAssistantProvider = 'chatgpt' | 'gemini' | 'api'
type BrowserPromptAssistantProvider = Exclude<PromptAssistantProvider, 'api'>
export type PromptAssistantApiConfig = AppSettings['apiProvider']

export interface PromptAssistantMediaUpload {
  base64: string
  name: string
  type: string
}

export interface PromptAssistantApiModel {
  id: string
  name: string
  owner: string
  plan: string
  isFree: boolean
  inputModalities: string[]
  recommendedForMedia: boolean
}

type OpenAICompatibleModel = {
  id?: string
  name?: string
  owned_by?: string
  input_modalities?: unknown
  modalities?: unknown
  architecture?: {
    input_modalities?: unknown
  }
}

interface PromptAssistantResponse {
  success?: boolean
  text?: string
  error?: string
  message?: string
  provider?: string
}

type OpenAICompatibleResponse = {
  choices?: Array<{
    text?: string
    finish_reason?: string | null
    message?: {
      content?: string | Array<{ type?: string; text?: string }>
    }
    delta?: {
      content?: string | Array<{ type?: string; text?: string }>
    }
  }>
  output_text?: string
  error?: { message?: string } | string
  message?: string
}

export function promptAssistantProviderLabel(provider: PromptAssistantProvider): string {
  if (provider === 'chatgpt') return 'ChatGPT'
  if (provider === 'gemini') return 'Gemini'
  return 'API'
}

function normalizeApiUrl(endpoint: string, path: 'chat/completions' | 'models'): string {
  const normalized = endpoint.trim().replace(/\/+$/, '')
  if (!normalized) return ''
  if (path === 'chat/completions' && /\/chat\/completions$/i.test(normalized)) return normalized
  if (path === 'models' && /\/models$/i.test(normalized)) return normalized
  return `${normalized}/${path}`
}

const FULL_MEDIA_MODALITIES = ['text', 'image', 'video', 'file', 'audio'] as const

function normalizeInputModalities(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,+|\s]+/)
      : []
  return Array.from(new Set(candidates
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)))
}

function readModelInputModalities(model: OpenAICompatibleModel | undefined): string[] {
  if (!model) return []
  const architectureModalities = normalizeInputModalities(model.architecture?.input_modalities)
  if (architectureModalities.length > 0) return architectureModalities
  const directModalities = normalizeInputModalities(model.input_modalities)
  if (directModalities.length > 0) return directModalities
  if (model.modalities && typeof model.modalities === 'object') {
    const input = (model.modalities as { input?: unknown }).input
    const nestedModalities = normalizeInputModalities(input)
    if (nestedModalities.length > 0) return nestedModalities
  }
  return []
}

function inferModelInputModalities(modelId: string): string[] {
  const normalized = modelId.toLowerCase()
  if (normalized.includes('gemini')) return [...FULL_MEDIA_MODALITIES]
  if (/qwen[^/]*.*(?:vl|omni)|(?:vl|omni).*qwen/.test(normalized)) return ['text', 'image', 'video']
  if (normalized.includes('nemotron') && normalized.includes('omni')) return ['text', 'image', 'video', 'audio']
  if (normalized.includes('claude')) return ['text', 'image', 'file']
  if (/gpt-(?:4o|4\.1|5)/.test(normalized) && !normalized.includes('gpt-oss')) return ['text', 'image', 'file']
  return ['text']
}

function modelPlan(modelId: string, owner: string, isFree: boolean): string {
  const normalizedId = modelId.toLowerCase()
  const normalizedOwner = owner.toLowerCase()
  if (normalizedId.startsWith('openrouter/') || normalizedOwner === 'openrouter') {
    return isFree ? 'OpenRouter Free' : 'OpenRouter'
  }
  if (normalizedId.startsWith('ag/') || normalizedOwner === 'ag') return 'Antigravity Plan'
  if (normalizedOwner && normalizedOwner !== 'unknown') return `${owner} Plan`
  return '9Router Models'
}

function mediaModelScore(model: PromptAssistantApiModel): number {
  const id = model.id.toLowerCase()
  let score = model.inputModalities.filter((modality) => FULL_MEDIA_MODALITIES.includes(modality as typeof FULL_MEDIA_MODALITIES[number])).length * 10
  if (model.recommendedForMedia) score += 100
  if (id.includes('gemini')) score += 24
  if (id.includes('flash')) score += 8
  if (id.includes('3.5')) score += 5
  if (id.startsWith('ag/')) score += 3
  if (id.includes('extra-low')) score -= 2
  return score
}

export function selectPromptAssistantApiModel(
  models: PromptAssistantApiModel[],
  currentModelId: string,
  hasMedia: boolean,
): string {
  const currentId = currentModelId.trim()
  if (!hasMedia || models.length === 0) return currentId

  const ranked = [...models]
    .filter((model) => model.inputModalities.includes('image'))
    .sort((left, right) => mediaModelScore(right) - mediaModelScore(left) || left.name.localeCompare(right.name))
  return ranked[0]?.id || currentId
}

export async function loadPromptAssistantApiModels(endpointOverride?: string): Promise<PromptAssistantApiModel[]> {
  const config = await readLatestApiConfig()
  const endpoint = normalizeApiUrl(endpointOverride?.trim() || config.endpoint, 'models')
  if (!endpoint) throw new Error('API endpoint is not configured.')

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`
  const response = await fetch(endpoint, { headers })
  const rawText = await response.text()
  let payload: { data?: unknown; error?: { message?: string } | string; message?: string } = {}
  try {
    payload = rawText ? JSON.parse(rawText) : {}
  } catch {
    throw new Error(response.ok ? '9Router returned an invalid model list.' : rawText || `Model request failed with HTTP ${response.status}.`)
  }
  if (!response.ok) {
    const apiError = typeof payload.error === 'string' ? payload.error : payload.error?.message
    throw new Error(apiError || payload.message || `Model request failed with HTTP ${response.status}.`)
  }

  const rawModels = Array.isArray(payload.data)
    ? payload.data.filter((item): item is OpenAICompatibleModel => Boolean(item && typeof item === 'object'))
    : []
  if (rawModels.length === 0) return []

  const openRouterIds = new Set(rawModels
    .map((model) => String(model.id || '').trim())
    .filter((id) => id.startsWith('openrouter/'))
    .map((id) => id.slice('openrouter/'.length)))
  const openRouterMetadata = new Map<string, OpenAICompatibleModel>()
  if (openRouterIds.size > 0) {
    try {
      const upstreamResponse = await fetch('https://openrouter.ai/api/v1/models')
      if (upstreamResponse.ok) {
        const upstreamPayload = await upstreamResponse.json() as { data?: unknown }
        if (Array.isArray(upstreamPayload.data)) {
          for (const item of upstreamPayload.data) {
            if (!item || typeof item !== 'object') continue
            const model = item as OpenAICompatibleModel
            const id = String(model.id || '').trim()
            if (openRouterIds.has(id)) openRouterMetadata.set(id, model)
          }
        }
      }
    } catch {
      // 9Router remains the source of truth. Family inference below is the safe fallback.
    }
  }

  return rawModels
    .map((model): PromptAssistantApiModel | null => {
      const id = String(model.id || '').trim()
      if (!id) return null
      const owner = String(model.owned_by || id.split('/')[0] || 'unknown').trim()
      const upstreamId = id.startsWith('openrouter/') ? id.slice('openrouter/'.length) : id
      const upstream = openRouterMetadata.get(upstreamId)
      const inputModalities = readModelInputModalities(model).length > 0
        ? readModelInputModalities(model)
        : readModelInputModalities(upstream).length > 0
          ? readModelInputModalities(upstream)
          : inferModelInputModalities(id)
      const isFree = /:free(?:$|:)/i.test(id)
      return {
        id,
        name: String(model.name || upstream?.name || upstreamId).trim(),
        owner,
        plan: modelPlan(id, owner, isFree),
        isFree,
        inputModalities,
        recommendedForMedia: FULL_MEDIA_MODALITIES.every((modality) => inputModalities.includes(modality)),
      }
    })
    .filter((model): model is PromptAssistantApiModel => Boolean(model))
    .sort((left, right) => {
      const planOrder = left.plan.localeCompare(right.plan)
      if (planOrder !== 0) return planOrder
      return mediaModelScore(right) - mediaModelScore(left) || left.name.localeCompare(right.name)
    })
}

async function readLatestApiConfig(): Promise<PromptAssistantApiConfig> {
  const fallback = useSettingsStore.getState().apiProvider
  const apiKey = await loadPromptAssistantApiKey()
  try {
    const stored = await chrome.storage.local.get('ai-flow-settings')
    const raw = stored['ai-flow-settings']
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    const value = parsed?.state?.apiProvider
    if (value && typeof value === 'object') {
      return {
        enabled: value.enabled === true,
        endpoint: typeof value.endpoint === 'string' ? value.endpoint : fallback.endpoint,
        apiKey,
        model: typeof value.model === 'string' ? value.model : fallback.model,
      }
    }
  } catch {
    // The hydrated Zustand state remains a safe fallback in this UI context.
  }
  return { ...fallback, apiKey }
}

function extractOpenAICompatibleText(payload: OpenAICompatibleResponse): string {
  const content = payload.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n')
      .trim()
    if (joined) return joined
  }
  const legacyText = payload.choices?.[0]?.text
  if (typeof legacyText === 'string' && legacyText.trim()) return legacyText.trim()
  return typeof payload.output_text === 'string' ? payload.output_text.trim() : ''
}

function extractOpenAICompatibleSseText(rawText: string): string {
  const chunks: string[] = []
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const payload = JSON.parse(data) as OpenAICompatibleResponse
      const deltaContent = payload.choices?.[0]?.delta?.content
      if (typeof deltaContent === 'string') {
        chunks.push(deltaContent)
        continue
      }
      if (Array.isArray(deltaContent)) {
        chunks.push(...deltaContent.map((part) => part?.text || '').filter(Boolean))
        continue
      }
      const completedText = extractOpenAICompatibleText(payload)
      if (completedText) chunks.push(completedText)
    } catch {
      // Ignore keep-alive comments and malformed provider-specific SSE frames.
    }
  }
  return chunks.join('').trim()
}

async function requestOpenAICompatiblePrompt(
  config: PromptAssistantApiConfig,
  instruction: string,
  timeoutMs: number,
  mediaUploads: PromptAssistantMediaUpload[],
): Promise<string> {
  const endpoint = normalizeApiUrl(config.endpoint, 'chat/completions')
  if (!endpoint) throw new Error('API endpoint is not configured. Open Settings and add an OpenAI-compatible endpoint.')
  if (!config.model.trim()) throw new Error('API model is not configured. Open Settings and enter a model name.')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(5000, timeoutMs))
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`
  const content = mediaUploads.length > 0
    ? [
        { type: 'text', text: instruction },
        ...mediaUploads.slice(0, 5).map((upload) => ({
          type: 'image_url',
          image_url: { url: `data:${upload.type || 'image/png'};base64,${upload.base64}` },
        })),
      ]
    : instruction

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model.trim(),
        messages: [{ role: 'user', content }],
        // 9Router may default Antigravity (`ag/*`) models to SSE when this
        // field is omitted, even though the endpoint is OpenAI-compatible.
        stream: false,
      }),
      signal: controller.signal,
    })
    const rawText = await response.text()
    let payload: OpenAICompatibleResponse = {}
    try {
      payload = rawText ? JSON.parse(rawText) as OpenAICompatibleResponse : {}
    } catch {
      if (!response.ok) throw new Error(rawText || `API request failed with HTTP ${response.status}.`)
    }
    if (!response.ok) {
      const apiError = typeof payload.error === 'string' ? payload.error : payload.error?.message
      throw new Error(apiError || payload.message || `API request failed with HTTP ${response.status}.`)
    }
    const text = extractOpenAICompatibleText(payload) || extractOpenAICompatibleSseText(rawText)
    if (!text) {
      const finishReason = payload.choices?.[0]?.finish_reason
      throw new Error(
        finishReason
          ? `The API returned no text (finish_reason: ${finishReason}).`
          : 'The API returned no text in its JSON or SSE response.'
      )
    }
    return text
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`API request timed out after ${Math.round(timeoutMs / 1000)} seconds.`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function testPromptAssistantApi(config: PromptAssistantApiConfig): Promise<string> {
  return requestOpenAICompatiblePrompt(config, 'Reply with exactly: API connection successful', 30000, [])
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForTabComplete(tabId: number, timeoutMs = 20000): Promise<void> {
  const current = await chrome.tabs.get(tabId)
  if (current.status === 'complete') return

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated)
      reject(new Error('Timed out while loading the AI provider tab.'))
    }, timeoutMs)

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      resolve()
    }

    chrome.tabs.onUpdated.addListener(onUpdated)
  })
}

function resolveSharedContentScriptFile(): string | null {
  try {
    const manifest = chrome.runtime.getManifest() as {
      content_scripts?: Array<{ matches?: string[]; js?: string[] }>
    }
    for (const entry of manifest.content_scripts || []) {
      const script = (entry.js || []).find((file) => file.startsWith('content-script.'))
      if (script) return script
    }
  } catch (error) {
    console.warn('[PromptAssistant] Could not inspect extension manifest:', error)
  }
  return null
}

async function pingPromptAssistant(tabId: number, provider: BrowserPromptAssistantProvider): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'PROMPT_ASSISTANT_PING',
      payload: { provider },
    }) as PromptAssistantResponse
    return response?.success === true && response.provider === provider
  } catch {
    return false
  }
}

async function ensurePromptAssistantListener(tabId: number, provider: BrowserPromptAssistantProvider): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await pingPromptAssistant(tabId, provider)) return
    await sleep(250)
  }

  const scriptFile = resolveSharedContentScriptFile()
  if (!scriptFile) throw new Error('Prompt Assistant content script is missing from the extension build.')

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/already|specified|duplicate/i.test(message)) throw error
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await pingPromptAssistant(tabId, provider)) return
    await sleep(300)
  }
  throw new Error(`${provider === 'chatgpt' ? 'ChatGPT' : 'Gemini'} is not ready. Reload its tab and try again.`)
}

async function findOrCreateProviderTab(provider: BrowserPromptAssistantProvider, focus = true): Promise<number> {
  const config = PROVIDER_TABS[provider]
  let tabs = await chrome.tabs.query({ url: config.queryUrl, currentWindow: true })
  if (tabs.length === 0) tabs = await chrome.tabs.query({ url: config.queryUrl })

  const existing = tabs.find((tab) => typeof tab.id === 'number')
  if (existing?.id) {
    if (focus) await chrome.tabs.update(existing.id, { active: true })
    await waitForTabComplete(existing.id)
    return existing.id
  }

  const created = await chrome.tabs.create({ url: config.createUrl, active: focus })
  if (!created.id) throw new Error(`Could not open ${provider === 'chatgpt' ? 'ChatGPT' : 'Gemini'}.`)
  await waitForTabComplete(created.id)
  return created.id
}

export async function runPromptAssistant(
  provider: PromptAssistantProvider,
  instruction: string,
  timeoutMs = 90000,
  mediaUploads: PromptAssistantMediaUpload[] = [],
  options: { focus?: boolean; apiModel?: string } = {},
): Promise<string> {
  if (provider === 'api') {
    const storedConfig = await readLatestApiConfig()
    const config = options.apiModel?.trim()
      ? { ...storedConfig, model: options.apiModel.trim() }
      : storedConfig
    return requestOpenAICompatiblePrompt(config, instruction, timeoutMs, mediaUploads)
  }
  const tabId = await findOrCreateProviderTab(provider, options.focus !== false)
  await ensurePromptAssistantListener(tabId, provider)

  const response = await chrome.tabs.sendMessage(tabId, {
    action: 'PROMPT_ASSISTANT_SUBMIT_TEXT',
    payload: { provider, instruction, timeoutMs, mediaUploads: mediaUploads.slice(0, 5) },
  }) as PromptAssistantResponse

  if (!response?.success || !response.text?.trim()) {
    throw new Error(response?.message || response?.error || 'The AI provider returned an empty prompt.')
  }
  return response.text.trim()
}
