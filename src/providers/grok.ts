import type { ProviderAdapter } from '@/types'
import { PROVIDER_TABS } from '@/constants'

// Resolves the runtime-bundled generic content script file name by
// inspecting the live manifest. Plasmo emits hashed bundle names
// (e.g. `content-script.aabbccdd.js`), so we cannot hardcode the path.
//
// IMPORTANT: We must pick the entry whose JS file starts with
// `content-script.` — NOT any <all_urls>-matching entry. Other <all_urls>
// entries exist in the manifest (debug-bridge.*.js, flow-debug.*.js) and
// the previous resolver returned the FIRST match, which happened to be
// debug-bridge — the wrong bundle.
//
// Returns null if no entry matches.
async function resolveGenericContentScriptFile(): Promise<string | null> {
  try {
    const manifest = chrome.runtime.getManifest() as {
      content_scripts?: Array<{ matches?: string[]; js?: string[] }>
    }
    const scripts = manifest.content_scripts || []
    for (let i = 0; i < scripts.length; i++) {
      const entry = scripts[i]
      const matches = entry.matches || []
      const covers = matches.some(function (m) {
        return m === '<all_urls>' || m === '*://*/*' || m.indexOf('grok.com') !== -1
      })
      if (!covers) continue
      const js = entry.js || []
      for (let j = 0; j < js.length; j++) {
        if (js[j].indexOf('content-script.') === 0) return js[j]
      }
    }
  } catch (err) {
    console.warn('[GrokAdapter] resolveGenericContentScriptFile error:', (err as Error).message)
  }
  return null
}

export class GrokAdapter implements ProviderAdapter {
  name = 'grok' as const
  private tabId: number | null = null

  async detect(): Promise<boolean> {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const active = tabs[0]
        resolve(!!active?.url?.includes('grok.com') || !!active?.url?.includes('x.com/grok'))
      })
    })
  }

  async open(): Promise<void> {
    // queryUrl is a Chrome match pattern (must end in '/*' for origins);
    // createUrl is a navigable URL passed to chrome.tabs.create.
    const { queryUrl, createUrl } = PROVIDER_TABS.grok
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
    await chrome.tabs.sendMessage(tabId, {
      action: 'INSERT_PROMPT',
      payload: { prompt }
    })
  }

  async clickGenerate(): Promise<void> {
    const tabId = this.requireTabId()
    await this.injectScript()
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

  async getModels(): Promise<string[]> {
    return ['grok-3', 'grok-3-mini', 'grok-2']
  }

  async cleanup(): Promise<void> {
    this.tabId = null
  }

  private requireTabId(): number {
    if (typeof this.tabId !== 'number') {
      throw new Error('Grok tab not opened yet — call open() first')
    }
    return this.tabId
  }

  // Resolves the content script file at runtime from the live manifest
  // and injects it. NEVER swallows the error: if injection fails the
  // caller learns about it via the thrown exception.
  private async injectScript(): Promise<void> {
    if (!this.tabId) return
    const scriptFile = await resolveGenericContentScriptFile()
    if (!scriptFile) {
      throw new Error('Generic content script not declared in manifest')
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        files: [scriptFile]
      })
    } catch (err) {
      const msg = (err as Error).message || ''
      if (msg.indexOf('already') !== -1 || msg.indexOf('specified') !== -1) {
        return
      }
      throw err
    }
  }
}
