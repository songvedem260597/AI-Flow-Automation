import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { HistoryEntry, SavedPrompt, PresetTemplate } from '@/types'
import { v4 as uuid } from 'uuid'

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

interface HistoryState {
  entries: HistoryEntry[]
  addEntry: (entry: Omit<HistoryEntry, 'id' | 'completedAt'>) => void
  deleteEntry: (id: string) => void
  clearHistory: () => void
  getRecentEntries: (limit?: number) => HistoryEntry[]
}

interface PromptStore {
  prompts: SavedPrompt[]
  addPrompt: (prompt: Omit<SavedPrompt, 'id' | 'createdAt' | 'updatedAt'>) => void
  updatePrompt: (id: string, updates: Partial<SavedPrompt>) => void
  deletePrompt: (id: string) => void
  incrementUsage: (id: string) => void
  getPromptsByProvider: (provider: string) => SavedPrompt[]
  searchPrompts: (query: string) => SavedPrompt[]
}

interface PresetStore {
  presets: PresetTemplate[]
  addPreset: (preset: Omit<PresetTemplate, 'id' | 'createdAt'>) => void
  deletePreset: (id: string) => void
  incrementUsage: (id: string) => void
  getPresetsByCategory: (category: string) => PresetTemplate[]
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set, get) => ({
      entries: [],

      addEntry: (entry) => {
        set((state) => ({
          entries: [
            { ...entry, id: uuid(), completedAt: Date.now() },
            ...state.entries.slice(0, 99)
          ]
        }))
      },

      deleteEntry: (id) => {
        set((state) => ({ entries: state.entries.filter((e) => e.id !== id) }))
      },

      clearHistory: () => {
        set({ entries: [] })
      },

      getRecentEntries: (limit = 10) => {
        return get().entries.slice(0, limit)
      }
    }),
    { name: 'ai-flow-history', storage: createJSONStorage(() => chromeStorage('ai-flow-history')),
      onRehydrateStorage: () => (state) => {
        if (state) {
          chrome.storage.local.get('ai-flow-history', (result) => {
            const saved = result['ai-flow-history']
            if (saved) {
              try {
                const parsed = JSON.parse(saved)
                if (parsed.state?.entries?.length > 0) {
                  state.entries = parsed.state.entries
                }
              } catch {}
            }
          })
        }
      }
    }
  )
)

export const usePromptStore = create<PromptStore>()(
  persist(
    (set, get) => ({
      prompts: [],

      addPrompt: (prompt) => {
        set((state) => ({
          prompts: [...state.prompts, { ...prompt, id: uuid(), createdAt: Date.now(), updatedAt: Date.now() }]
        }))
      },

      updatePrompt: (id, updates) => {
        set((state) => ({
          prompts: state.prompts.map((p) =>
            p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p
          )
        }))
      },

      deletePrompt: (id) => {
        set((state) => ({ prompts: state.prompts.filter((p) => p.id !== id) }))
      },

      incrementUsage: (id) => {
        set((state) => ({
          prompts: state.prompts.map((p) =>
            p.id === id ? { ...p, usageCount: (p.usageCount || 0) + 1 } : p
          )
        }))
      },

      getPromptsByProvider: (provider) => {
        return get().prompts.filter((p) => p.provider === provider)
      },

      searchPrompts: (query) => {
        const q = query.toLowerCase()
        return get().prompts.filter(
          (p) => p.name.toLowerCase().includes(q) || p.content.toLowerCase().includes(q)
        )
      }
    }),
    { name: 'ai-flow-prompts', storage: createJSONStorage(() => chromeStorage('ai-flow-prompts')),
      onRehydrateStorage: () => (state) => {
        if (state) {
          chrome.storage.local.get('ai-flow-prompts', (result) => {
            const saved = result['ai-flow-prompts']
            if (saved) {
              try {
                const parsed = JSON.parse(saved)
                if (parsed.state?.prompts?.length > 0) {
                  state.prompts = parsed.state.prompts
                }
              } catch {}
            }
          })
        }
      }
    }
  )
)

export const usePresetStore = create<PresetStore>()(
  persist(
    (set, get) => ({
      presets: [],

      addPreset: (preset) => {
        set((state) => ({
          presets: [...state.presets, { ...preset, id: uuid(), createdAt: Date.now() }]
        }))
      },

      deletePreset: (id) => {
        set((state) => ({ presets: state.presets.filter((p) => p.id !== id) }))
      },

      incrementUsage: (id) => {
        set((state) => ({
          presets: state.presets.map((p) =>
            p.id === id ? { ...p, usageCount: (p.usageCount || 0) + 1 } : p
          )
        }))
      },

      getPresetsByCategory: (category) => {
        return get().presets.filter((p) => p.category === category)
      }
    }),
    { name: 'ai-flow-presets', storage: createJSONStorage(() => chromeStorage('ai-flow-presets')),
      onRehydrateStorage: () => (state) => {
        if (state) {
          chrome.storage.local.get('ai-flow-presets', (result) => {
            const saved = result['ai-flow-presets']
            if (saved) {
              try {
                const parsed = JSON.parse(saved)
                if (parsed.state?.presets?.length > 0) {
                  state.presets = parsed.state.presets
                }
              } catch {}
            }
          })
        }
      }
    }
  )
)
