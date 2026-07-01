import type { ProviderAdapter } from '@/types'
import { PROVIDER_URLS } from '@/constants'

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
    const tabs = await chrome.tabs.query({ url: PROVIDER_URLS['grok'] })
    if (tabs.length > 0 && tabs[0].id) {
      this.tabId = tabs[0].id
      await chrome.tabs.update(this.tabId, { active: true }).catch(() => {})
    } else {
      const tab = await chrome.tabs.create({ url: PROVIDER_URLS['grok'], active: true })
      this.tabId = tab.id ?? null
    }
    await this.injectScript()
  }

  async insertPrompt(prompt: string): Promise<void> {
    await this.injectScript()
    await chrome.tabs.sendMessage(this.tabId!, {
      action: 'INSERT_PROMPT',
      payload: { prompt }
    })
  }

  async clickGenerate(): Promise<void> {
    await this.injectScript()
    await chrome.tabs.sendMessage(this.tabId!, {
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

  private async injectScript(): Promise<void> {
    if (!this.tabId) return
    try {
      await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        files: ['content-scripts/content-script.js']
      })
    } catch {
      // Script may already be injected
    }
  }
}
