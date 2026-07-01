import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { AppSettings, AIProvider, ActiveView, UIState } from '@/types'
import { DEFAULT_SETTINGS } from '@/constants'

const chromeStorageCache: Record<string, string | null> = {}
const chromeStoragePending: Record<string, boolean> = {}

const chromeStorage = (key: string) => {
  if (!(key in chromeStorageCache)) {
    chromeStorageCache[key] = null
    chromeStoragePending[key] = true
    chrome.storage.local.get(key, (result) => {
      chromeStorageCache[key] = result[key] ?? null
      chromeStoragePending[key] = false
    })
  }

  return {
    getItem: () => chromeStorageCache[key] ?? null,
    setItem: (value: string) => {
      chromeStorageCache[key] = value
      chrome.storage.local.set({ [key]: value })
    },
    removeItem: () => {
      chromeStorageCache[key] = null
      chrome.storage.local.remove(key)
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
      onRehydrateStorage: () => (state) => {
        if (state) {
          chrome.storage.local.get('ai-flow-settings', (result) => {
            const saved = result['ai-flow-settings']
            if (saved) {
              try {
                const parsed = JSON.parse(saved)
                if (parsed.state) {
                  Object.assign(state, parsed.state)
                }
              } catch {}
            }
          })
        }
      }
    }
  )
)

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
