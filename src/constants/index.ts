import type { FlowNodeType, AIProvider } from '@/types'

export type { FlowNodeType, AIProvider }

export const PROVIDER_URLS: Record<string, string> = {
  'google-flow': 'https://labs.google/fx/tools/flow',
  'chatgpt': 'https://chatgpt.com',
  'grok': 'https://grok.com',
  'claude': 'https://claude.ai',
  'gemini': 'https://gemini.google.com'
}

export const PROVIDER_LABELS: Record<string, string> = {
  'google-flow': 'Google Flow',
  'chatgpt': 'ChatGPT',
  'grok': 'Grok',
  'claude': 'Claude',
  'gemini': 'Gemini'
}

export const NODE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  prompt: { bg: 'bg-violet-500/20', border: 'border-violet-500', text: 'text-violet-400' },
  image: { bg: 'bg-pink-500/20', border: 'border-pink-500', text: 'text-pink-400' },
  generate: { bg: 'bg-emerald-500/20', border: 'border-emerald-500', text: 'text-emerald-400' },
  delay: { bg: 'bg-amber-500/20', border: 'border-amber-500', text: 'text-amber-400' },
  download: { bg: 'bg-blue-500/20', border: 'border-blue-500', text: 'text-blue-400' },
  wait: { bg: 'bg-orange-500/20', border: 'border-orange-500', text: 'text-orange-400' },
  condition: { bg: 'bg-cyan-500/20', border: 'border-cyan-500', text: 'text-cyan-400' },
  loop: { bg: 'bg-purple-500/20', border: 'border-purple-500', text: 'text-purple-400' },
  merge: { bg: 'bg-slate-500/20', border: 'border-slate-500', text: 'text-slate-400' },
  split: { bg: 'bg-indigo-500/20', border: 'border-indigo-500', text: 'text-indigo-400' }
}

export const ASPECT_RATIOS = [
  { label: '1:1', value: '1:1', description: 'Square' },
  { label: '16:9', value: '16:9', description: 'Landscape' },
  { label: '9:16', value: '9:16', description: 'Portrait' },
  { label: '4:3', value: '4:3', description: 'Standard' },
  { label: '3:4', value: '3:4', description: 'Portrait Standard' }
]

export const DEFAULT_SETTINGS = {
  theme: 'dark' as const,
  autoDownload: true,
  downloadFormat: 'png' as const,
  defaultProvider: 'chatgpt' as const,
  maxRetries: 3,
  retryDelay: 2000,
  timeoutDuration: 60000,
  wakeLockEnabled: true,
  notifications: {
    onComplete: true,
    onError: true,
    onProgress: false
  },
  shortcuts: {
    runWorkflow: 'Ctrl+Shift+R',
    pauseWorkflow: 'Ctrl+Shift+P',
    stopWorkflow: 'Ctrl+Shift+S',
    openPanel: 'Ctrl+Shift+F'
  },
  advanced: {
    headlessMode: false,
    debugMode: false,
    preserveSession: true,
    parallelExecution: false
  }
}

export const STORAGE_KEYS = {
  WORKFLOWS: 'ai-flow-workflows',
  SETTINGS: 'ai-flow-settings',
  HISTORY: 'ai-flow-history',
  PROMPTS: 'ai-flow-prompts',
  PRESETS: 'ai-flow-presets',
  ACTIVE_WORKFLOW: 'ai-flow-active-workflow'
}

export const DEFAULT_WORKFLOW = {
  id: '',
  name: 'Untitled Workflow',
  description: '',
  nodes: [],
  edges: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  isTemplate: false,
  tags: []
}
