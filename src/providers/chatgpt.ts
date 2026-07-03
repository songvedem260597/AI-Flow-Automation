import type { ProviderAdapter } from '@/types'
import { PROVIDER_TABS } from '@/constants'

// Resolves the runtime-bundled ChatGPT content script file name by
// inspecting the live manifest. Plasmo emits hashed bundle names
// (e.g. `content-script.aabbccdd.js`), so we cannot hardcode the path.
//
// IMPORTANT: We must pick the entry whose JS file starts with
// `content-script.` — NOT any <all_urls>-matching entry. Other <all_urls>
// entries exist in the manifest (debug-bridge.*.js, flow-debug.*.js) and
// the previous resolver returned the FIRST match, which happened to be
// debug-bridge — the wrong bundle.
//
// Returns null if no entry matches — caller should treat that as a fatal
// configuration error. Sidepanel context has `chrome.runtime.getManifest`,
// so this works in the adapter (which is bundled into the sidepanel).
async function resolveChatGPTContentScriptFile(): Promise<string | null> {
  try {
    const manifest = chrome.runtime.getManifest() as {
      content_scripts?: Array<{ matches?: string[]; js?: string[] }>
    }
    const scripts = manifest.content_scripts || []
    for (let i = 0; i < scripts.length; i++) {
      const entry = scripts[i]
      const matches = entry.matches || []
      const covers = matches.some(function (m) {
        return m === '<all_urls>' || m === '*://*/*' || m.indexOf('chatgpt.com') !== -1
      })
      if (!covers) continue
      const js = entry.js || []
      for (let j = 0; j < js.length; j++) {
        if (js[j].indexOf('content-script.') === 0) return js[j]
      }
    }
  } catch (err) {
    console.warn('[ChatGPTAdapter] resolveChatGPTContentScriptFile error:', (err as Error).message)
  }
  return null
}

// Pings the content script listener with CHATGPT_PING, retrying up to
// 10 times with 300ms between attempts. The content script's listener
// for CHATGPT_PING already exists (verified in src/contents/content-script.ts
// handleMessage). On a successful pong, returns true. If every attempt
// fails, attempts a one-time injection of the runtime-resolved content
// script and retries once more. Mirrors the background's
// ensureChatGPTContentReady but lives in the sidepanel adapter.
//
// This avoids the previous "Could not establish connection. Receiving
// end does not exist" race when the adapter's hardcoded
// 'content-scripts/content-script.js' path was rejected and the listener
// was not yet attached.
async function ensureChatGPTListenerReady(tabId: number): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { action: 'CHATGPT_PING' })
      if (pong && pong.success) {
        return true
      }
    } catch (_) {
      // Listener not yet attached; retry
    }
    await new Promise(function (r) { setTimeout(r, 300) })
  }

  // One-time injection attempt with the runtime-resolved file
  const scriptFile = await resolveChatGPTContentScriptFile()
  if (scriptFile) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] })
    } catch (err) {
      console.warn('[ChatGPTAdapter] inject content script failed:', (err as Error).message)
    }
  } else {
    console.warn('[ChatGPTAdapter] no content script entry found in manifest for chatgpt.com')
  }

  for (let i = 0; i < 10; i++) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { action: 'CHATGPT_PING' })
      if (pong && pong.success) {
        return true
      }
    } catch (_) { /* retry */ }
    await new Promise(function (r) { setTimeout(r, 300) })
  }

  return false
}

export class ChatGPTAdapter implements ProviderAdapter {
  name = 'chatgpt' as const
  private tabId: number | null = null

  async detect(): Promise<boolean> {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const active = tabs[0]
        resolve(!!active?.url?.includes('chatgpt.com'))
      })
    })
  }

  async open(): Promise<void> {
    // queryUrl is a Chrome match pattern (must end in '/*' for origins);
    // createUrl is a navigable URL passed to chrome.tabs.create.
    const { queryUrl, createUrl } = PROVIDER_TABS.chatgpt
    const tabs = await chrome.tabs.query({ url: queryUrl })
    if (tabs.length > 0 && tabs[0].id) {
      this.tabId = tabs[0].id
      await chrome.tabs.update(this.tabId, { active: true }).catch(() => {})
    } else {
      const tab = await chrome.tabs.create({ url: createUrl, active: true })
      this.tabId = tab.id ?? null
    }
    await this.injectScript()
  }

  async insertPrompt(prompt: string): Promise<void> {
    const tabId = this.requireTabId()
    await this.injectScript()
    if (!(await ensureChatGPTListenerReady(tabId))) {
      throw new Error('ChatGPT content script not ready after ping (insertPrompt)')
    }
    await chrome.tabs.sendMessage(tabId, {
      action: 'INSERT_PROMPT',
      payload: { prompt }
    })
  }

  async uploadImage(imageData: string): Promise<void> {
    const tabId = this.requireTabId()
    await this.injectScript()
    if (!(await ensureChatGPTListenerReady(tabId))) {
      throw new Error('ChatGPT content script not ready after ping (uploadImage)')
    }
    await chrome.tabs.sendMessage(tabId, {
      action: 'UPLOAD_IMAGE',
      payload: { imageData }
    })
  }

  async clickGenerate(): Promise<void> {
    const tabId = this.requireTabId()
    await this.injectScript()
    if (!(await ensureChatGPTListenerReady(tabId))) {
      throw new Error('ChatGPT content script not ready after ping (clickGenerate)')
    }
    await chrome.tabs.sendMessage(tabId, {
      action: 'CLICK_GENERATE'
    })
  }

  async waitForResult(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener)
        reject(new Error('Timeout waiting for result'))
      }, 120000)

      const listener = (msg: Record<string, unknown>) => {
        if (msg.action === 'GENERATION_COMPLETE') {
          clearTimeout(timeout)
          chrome.runtime.onMessage.removeListener(listener)
          resolve(msg.payload as string)
        }
        if (msg.action === 'GENERATION_ERROR') {
          clearTimeout(timeout)
          chrome.runtime.onMessage.removeListener(listener)
          reject(new Error(msg.error as string))
        }
      }
      chrome.runtime.onMessage.addListener(listener)
    })
  }

  async downloadResult(): Promise<string> {
    const tabId = this.requireTabId()
    await this.injectScript()
    if (!(await ensureChatGPTListenerReady(tabId))) {
      throw new Error('ChatGPT content script not ready after ping (downloadResult)')
    }
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'DOWNLOAD_RESULT'
    })
    return response.data as string
  }

  async getModels(): Promise<string[]> {
    return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'claude-3-5-sonnet']
  }

  async setModel(modelId: string): Promise<void> {
    const tabId = this.requireTabId()
    await this.injectScript()
    if (!(await ensureChatGPTListenerReady(tabId))) {
      throw new Error('ChatGPT content script not ready after ping (setModel)')
    }
    await chrome.tabs.sendMessage(tabId, {
      action: 'SET_MODEL',
      payload: { model: modelId }
    })
  }

  async cleanup(): Promise<void> {
    this.tabId = null
  }

  private requireTabId(): number {
    if (typeof this.tabId !== 'number') {
      throw new Error('ChatGPT tab not opened yet — call open() first')
    }
    return this.tabId
  }

  // Resolves the content script file at runtime from the live manifest
  // and injects it. NEVER swallows the error: if injection fails the
  // caller learns about it via the thrown exception.
  private async injectScript(): Promise<void> {
    if (!this.tabId) return
    const scriptFile = await resolveChatGPTContentScriptFile()
    if (!scriptFile) {
      throw new Error('ChatGPT content script not declared in manifest')
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        files: [scriptFile]
      })
    } catch (err) {
      // If the script is already injected, executeScript throws
      // "Cannot create script with specified ID" or similar. Treat that
      // as success; propagate any other error.
      const msg = (err as Error).message || ''
      if (msg.indexOf('already') !== -1 || msg.indexOf('specified') !== -1) {
        return
      }
      throw err
    }
  }
}
