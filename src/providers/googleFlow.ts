import type { ProviderAdapter } from '@/types'
import { PROVIDER_URLS } from '@/constants'

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
    const tabs = await chrome.tabs.query({ url: PROVIDER_URLS['google-flow'] })
    if (tabs.length > 0 && tabs[0].id) {
      this.tabId = tabs[0].id
      await chrome.tabs.update(this.tabId, { active: true }).catch(() => {})
    } else {
      const tab = await chrome.tabs.create({ url: PROVIDER_URLS['google-flow'], active: true })
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
    await this.injectScript()
    await chrome.tabs.sendMessage(this.tabId!, {
      action: 'SET_MODEL',
      payload: { model: modelId }
    })
  }

  async setAspectRatio(ratio: string): Promise<void> {
    await this.injectScript()
    await chrome.tabs.sendMessage(this.tabId!, {
      action: 'SET_ASPECT_RATIO',
      payload: { ratio }
    })
  }

  async setMediaType(mediaType: 'image' | 'video'): Promise<void> {
    await this.injectScript()
    await chrome.tabs.sendMessage(this.tabId!, {
      action: 'SET_MEDIA_TYPE',
      payload: { mediaType }
    })
  }

  async setDuration(duration: string): Promise<void> {
    await this.injectScript()
    await chrome.tabs.sendMessage(this.tabId!, {
      action: 'SET_DURATION',
      payload: { duration }
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
