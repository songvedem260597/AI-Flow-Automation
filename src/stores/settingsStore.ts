import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { AppSettings, AIProvider, ActiveView, UIState } from '@/types'
import { DEFAULT_SETTINGS } from '@/constants'
import {
  migrateLegacyPromptAssistantApiKey,
  sanitizePersistedSettings,
} from '@/lib/promptAssistantSecretStore'

const chromeStorage = (key: string) => {
  return {
    getItem: async (_storageKey: string) => {
      const result = await chrome.storage.local.get(key)
      const storedValue = result[key]
      if (storedValue == null) return null
      const value = typeof storedValue === 'string' ? storedValue : JSON.stringify(storedValue)
      return key === 'ai-flow-settings' ? sanitizePersistedSettings(value) : value
    },
    setItem: async (_storageKey: string, value: string) => {
      const safeValue = key === 'ai-flow-settings' ? sanitizePersistedSettings(value) : value
      await chrome.storage.local.set({ [key]: safeValue })
    },
    removeItem: async (_storageKey: string) => {
      await chrome.storage.local.remove(key)
    }
  }
}

interface SettingsState extends AppSettings {
  updateSettings: (updates: Partial<AppSettings>) => void
  resetSettings: () => void
  setTheme: (theme: 'dark' | 'light' | 'system') => void
  setDefaultProvider: (provider: AIProvider) => void
  setAutoDownload: (enabled: boolean) => void
  setDownloadFormat: (format: 'png' | 'jpg' | 'webp') => void
  setWakeLock: (enabled: boolean) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,

      updateSettings: (updates) => set((state) => ({ ...state, ...updates })),
      resetSettings: () => set(() => ({ ...DEFAULT_SETTINGS })),
      setTheme: (theme) => set((state) => ({ ...state, theme })),
      setDefaultProvider: (provider) => set((state) => ({ ...state, defaultProvider: provider })),
      setAutoDownload: (enabled) => set((state) => ({ ...state, autoDownload: enabled })),
      setDownloadFormat: (format) => set((state) => ({ ...state, downloadFormat: format })),
      setWakeLock: (enabled) => set((state) => ({ ...state, wakeLockEnabled: enabled }))
    }),
    {
      name: 'ai-flow-settings',
      storage: createJSONStorage(() => chromeStorage('ai-flow-settings')),
    }
  )
)

// Migrate settings saved by older builds before any future persistence write
// can replace the legacy plaintext value.
void migrateLegacyPromptAssistantApiKey().catch(() => undefined)

interface UIStore extends UIState {
  setActiveView: (view: ActiveView) => void
  setSelectedNode: (nodeId: string | null) => void
  setPipelineRunning: (running: boolean) => void
  setPanelExpanded: (expanded: boolean) => void
  setShowMiniProgress: (show: boolean) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
}

export const useUIStore = create<UIStore>()((set, get) => ({
  activeView: 'workflow-editor',
  selectedNodeId: undefined,
  isPipelineRunning: false,
  isPanelExpanded: true,
  showMiniProgress: false,
  sidebarCollapsed: false,

  setActiveView: (view) => set({ activeView: view }),
  setSelectedNode: (nodeId) => set({ selectedNodeId: nodeId }),
  setPipelineRunning: (running) => set({ isPipelineRunning: running }),
  setPanelExpanded: (expanded) => set({ isPanelExpanded: expanded }),
  setShowMiniProgress: (show) => set({ showMiniProgress: show }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))
}))
