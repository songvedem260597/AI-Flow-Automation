// Per-provider tab configuration — single source of truth for `chrome.tabs.*` URLs.
//
// IMPORTANT — `queryUrl` and `createUrl` have different formats:
//   - queryUrl: a Chrome match pattern consumed by `chrome.tabs.query({ url })`.
//     Bare origins like 'https://chatgpt.com' are INVALID and throw
//     "Invalid url pattern 'https://chatgpt.com'" at query time. A valid
//     origin pattern must end in '/*' (e.g. 'https://chatgpt.com/*').
//   - createUrl: a normal navigable URL consumed by `chrome.tabs.create({ url })`.
//     For domains this should end with a trailing slash (e.g. 'https://chatgpt.com/').
//
// See: https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
import type { AIProvider } from '@/types'

export interface ProviderTabConfig {
  /** Chrome match pattern for `chrome.tabs.query({ url })`. Must end in '/*' for origins. */
  queryUrl: string
  /** Navigable URL for `chrome.tabs.create({ url })`. */
  createUrl: string
}

export const PROVIDER_TABS: Record<AIProvider, ProviderTabConfig> = {
  'google-flow': {
    queryUrl: 'https://labs.google/fx/*',
    createUrl: 'https://labs.google/fx/tools/flow',
  },
  chatgpt: {
    queryUrl: 'https://chatgpt.com/*',
    createUrl: 'https://chatgpt.com/',
  },
  grok: {
    queryUrl: 'https://grok.com/*',
    createUrl: 'https://grok.com/',
  },
  claude: {
    queryUrl: 'https://claude.ai/*',
    createUrl: 'https://claude.ai/',
  },
  gemini: {
    queryUrl: 'https://gemini.google.com/*',
    createUrl: 'https://gemini.google.com/',
  },
}
