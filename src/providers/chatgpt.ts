import type { ProviderAdapter } from '@/types'
import { PROVIDER_URLS } from '@/constants'

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
    const tabs = await chrome.tabs.query({ url: PROVIDER_URLS['chatgpt'] })
    if (tabs.length > 0 && tabs[0].id) {
      this.tabId = tabs[0].id
      await chrome.tabs.update(this.tabId, { active: true }).catch(() => {})
    } else {
      const tab = await chrome.tabs.create({ url: PROVIDER_URLS['chatgpt'], active: true })
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

  async uploadImage(imageData: string): Promise<void> {
    await this.injectScript()
    await chrome.tabs.sendMessage(this.tabId!, {
      action: 'UPLOAD_IMAGE',
      payload: { imageData }
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

  async downloadResult(): Promise<string> {
    await this.injectScript()
    const response = await chrome.tabs.sendMessage(this.tabId!, {
      action: 'DOWNLOAD_RESULT'
    })
    return response.data as string
  }

  async getModels(): Promise<string[]> {
    return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'claude-3-5-sonnet']
  }

  async setModel(modelId: string): Promise<void> {
    await this.injectScript()
    await chrome.tabs.sendMessage(this.tabId!, {
      action: 'SET_MODEL',
      payload: { model: modelId }
    })
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
