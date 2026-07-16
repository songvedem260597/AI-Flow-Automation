import type { ProviderAdapter } from '@/types'
import { PROVIDER_TABS } from '@/constants'
import { ensureFlowResultContract } from '@/lib/flow/resultContract'
import type { FlowResultContract } from '@/types/flow'

// Resolves the runtime-bundled flow content script file name by
// inspecting the live manifest. Plasmo emits hashed bundle names
// (e.g. `flow-content.aabbccdd.js`), so we cannot hardcode the path.
//
// We pick the entry whose JS file starts with `flow-content.` — NOT
// any <all_urls>-matching entry. Other <all_urls> entries exist in the
// manifest (debug-bridge.*.js, content-script.*.js, flow-debug.*.js)
// and the previous resolver returned the FIRST match, which happened to
// be debug-bridge — the wrong bundle.
//
// Returns null if no entry matches.
async function resolveFlowContentScriptFile(): Promise<string | null> {
  try {
    const manifest = chrome.runtime.getManifest() as {
      content_scripts?: Array<{ matches?: string[]; js?: string[] }>
    }
    const scripts = manifest.content_scripts || []
    for (let i = 0; i < scripts.length; i++) {
      const entry = scripts[i]
      const matches = entry.matches || []
      const covers = matches.some(function (m) {
        return m.indexOf('labs.google') !== -1 || m === '<all_urls>' || m === '*://*/*'
      })
      if (!covers) continue
      const js = entry.js || []
      for (let j = 0; j < js.length; j++) {
        if (js[j].indexOf('flow-content.') === 0) return js[j]
      }
    }
  } catch (err) {
    console.warn('[GoogleFlowAdapter] resolveFlowContentScriptFile error:', (err as Error).message)
  }
  return null
}

export class GoogleFlowAdapter implements ProviderAdapter {
  name = 'google-flow' as const
  private tabId: number | null = null

  async detect(): Promise<boolean> {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const active = tabs[0]
        resolve(
          !!active?.url?.includes('labs.google/fx/tools/flow') ||
          !!active?.url?.includes('labs.google/fx/vi/tools/flow') ||
          !!active?.url?.includes('flow.google.com')
        )
      })
    })
  }

  async open(): Promise<void> {
    // queryUrl is a Chrome match pattern (must end in '/*' for origins);
    // createUrl is a navigable URL passed to chrome.tabs.create.
    const { queryUrl, createUrl } = PROVIDER_TABS['google-flow']
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

  async uploadImage(imageData: string): Promise<void> {
    const tabId = this.requireTabId()
    await this.injectScript()
    await chrome.tabs.sendMessage(tabId, {
      action: 'UPLOAD_IMAGE',
      payload: { imageData }
    })
  }

  async clickGenerate(): Promise<void> {
    // owner: google-flow â€” a direct CLICK_GENERATE would bypass the
    // background admission mutex. Production callers must submit the full
    // prompt through runPrompt()/RUN_FLOW_PROMPT instead.
    throw new Error('FLOW_DIRECT_CLICK_BLOCKED_USE_RUN_FLOW_PROMPT')
  }

  async runPrompt(payload: Record<string, unknown>): Promise<FlowResultContract> {
    const response = await chrome.runtime.sendMessage({
      action: 'RUN_FLOW_PROMPT',
      payload: { ...payload, source: String(payload.source || 'google-flow-adapter') },
    })
    return ensureFlowResultContract(response, 'orchestrator')
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
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'DOWNLOAD_RESULT'
    })
    return response.data as string
  }

  async getModels(): Promise<string[]> {
    return [
      'Nano Banana Pro',
      'Nano Banana 2',
      'Nano Banana 2 Lite',
      'Omni Flash',
      'Veo 3.1 - Lite',
      'Veo 3.1 - Fast',
      'Veo 3.1 - Quality',
      'Veo 3.1 - Lite [Lower Priority]'
    ]
  }

  async setModel(modelId: string): Promise<void> {
    const tabId = this.requireTabId()
    await this.injectScript()
    await chrome.tabs.sendMessage(tabId, {
      action: 'SET_MODEL',
      payload: { model: modelId }
    })
  }

  async setAspectRatio(ratio: string): Promise<void> {
    const tabId = this.requireTabId()
    await this.injectScript()
    await chrome.tabs.sendMessage(tabId, {
      action: 'SET_ASPECT_RATIO',
      payload: { ratio }
    })
  }

  async setMediaType(mediaType: 'image' | 'video'): Promise<void> {
    const tabId = this.requireTabId()
    await this.injectScript()
    await chrome.tabs.sendMessage(tabId, {
      action: 'SET_MEDIA_TYPE',
      payload: { mediaType }
    })
  }

  async setDuration(duration: string): Promise<void> {
    const tabId = this.requireTabId()
    await this.injectScript()
    await chrome.tabs.sendMessage(tabId, {
      action: 'SET_DURATION',
      payload: { duration }
    })
  }

  async cleanup(): Promise<void> {
    this.tabId = null
  }

  private requireTabId(): number {
    if (typeof this.tabId !== 'number') {
      throw new Error('Google Flow tab not opened yet — call open() first')
    }
    return this.tabId
  }

  // Resolves the flow content script file at runtime from the live
  // manifest and injects it. NEVER swallows the error: if injection
  // fails the caller learns about it via the thrown exception.
  private async injectScript(): Promise<void> {
    if (!this.tabId) return
    const scriptFile = await resolveFlowContentScriptFile()
    if (!scriptFile) {
      throw new Error('Flow content script not declared in manifest')
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
