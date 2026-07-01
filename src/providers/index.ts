import type { AIProvider, ProviderAdapter } from '@/types'
import { GoogleFlowAdapter } from './googleFlow'
import { ChatGPTAdapter } from './chatgpt'
import { GrokAdapter } from './grok'

export type { ProviderAdapter }

const adapters: Record<AIProvider, ProviderAdapter> = {
  'google-flow': new GoogleFlowAdapter(),
  'chatgpt': new ChatGPTAdapter(),
  'grok': new GrokAdapter(),
  'claude': {
    name: 'claude',
    async detect() { return false },
    async open() { await chrome.tabs.create({ url: 'https://claude.ai', active: true }) },
    async insertPrompt(prompt) { /* Claude integration */ },
    async clickGenerate() {},
    async waitForResult() { return '' },
    async getModels() { return ['claude-3-5-sonnet', 'claude-3-opus', 'claude-3-haiku'] },
    async cleanup() {}
  },
  'gemini': {
    name: 'gemini',
    async detect() { return false },
    async open() { await chrome.tabs.create({ url: 'https://gemini.google.com', active: true }) },
    async insertPrompt(prompt) {},
    async clickGenerate() {},
    async waitForResult() { return '' },
    async getModels() { return ['gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-1.5-pro'] },
    async cleanup() {}
  }
}

export function getAdapter(provider: AIProvider): ProviderAdapter {
  return adapters[provider] || adapters['chatgpt']
}

export function getAllProviders(): AIProvider[] {
  return Object.keys(adapters) as AIProvider[]
}

export { GoogleFlowAdapter, ChatGPTAdapter, GrokAdapter }
