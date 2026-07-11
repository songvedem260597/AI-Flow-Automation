import { PROVIDER_TABS } from '@/constants'

export type PromptAssistantProvider = 'chatgpt' | 'gemini'

interface PromptAssistantResponse {
  success?: boolean
  text?: string
  error?: string
  message?: string
  provider?: string
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

async function pingPromptAssistant(tabId: number, provider: PromptAssistantProvider): Promise<boolean> {
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

async function ensurePromptAssistantListener(tabId: number, provider: PromptAssistantProvider): Promise<void> {
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

async function findOrCreateProviderTab(provider: PromptAssistantProvider): Promise<number> {
  const config = PROVIDER_TABS[provider]
  let tabs = await chrome.tabs.query({ url: config.queryUrl, currentWindow: true })
  if (tabs.length === 0) tabs = await chrome.tabs.query({ url: config.queryUrl })

  const existing = tabs.find((tab) => typeof tab.id === 'number')
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true })
    await waitForTabComplete(existing.id)
    return existing.id
  }

  const created = await chrome.tabs.create({ url: config.createUrl, active: true })
  if (!created.id) throw new Error(`Could not open ${provider === 'chatgpt' ? 'ChatGPT' : 'Gemini'}.`)
  await waitForTabComplete(created.id)
  return created.id
}

export async function runPromptAssistant(
  provider: PromptAssistantProvider,
  instruction: string,
  timeoutMs = 90000,
): Promise<string> {
  const tabId = await findOrCreateProviderTab(provider)
  await ensurePromptAssistantListener(tabId, provider)

  const response = await chrome.tabs.sendMessage(tabId, {
    action: 'PROMPT_ASSISTANT_SUBMIT_TEXT',
    payload: { provider, instruction, timeoutMs },
  }) as PromptAssistantResponse

  if (!response?.success || !response.text?.trim()) {
    throw new Error(response?.message || response?.error || 'The AI provider returned an empty prompt.')
  }
  return response.text.trim()
}
