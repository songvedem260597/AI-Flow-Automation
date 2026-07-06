import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { HistoryEntry, SavedPrompt, PresetTemplate } from '@/types'
import { v4 as uuid } from 'uuid'

const chromeStorage = () => ({
  getItem: (key: string): Promise<string | null> =>
    new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (result) => {
          const error = chrome.runtime.lastError
          if (error) {
            console.warn(`[dataStore] Failed to read ${key}:`, error.message)
            resolve(null)
            return
          }
          resolve(result[key] ?? null)
        })
      } catch (error) {
        console.warn(`[dataStore] Failed to read ${key}:`, error)
        resolve(null)
      }
    }),

  setItem: (key: string, value: string): Promise<void> =>
    new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [key]: value }, () => {
          const error = chrome.runtime.lastError
          if (error) {
            console.warn(`[dataStore] Failed to write ${key}:`, error.message)
          }
          resolve()
        })
      } catch (error) {
        console.warn(`[dataStore] Failed to write ${key}:`, error)
        resolve()
      }
    }),

  removeItem: (key: string): Promise<void> =>
    new Promise((resolve) => {
      try {
        chrome.storage.local.remove(key, () => {
          const error = chrome.runtime.lastError
          if (error) {
            console.warn(`[dataStore] Failed to remove ${key}:`, error.message)
          }
          resolve()
        })
      } catch (error) {
        console.warn(`[dataStore] Failed to remove ${key}:`, error)
        resolve()
      }
    })
})

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
    { name: 'ai-flow-history', storage: createJSONStorage(() => chromeStorage()) }
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
    { name: 'ai-flow-prompts', storage: createJSONStorage(() => chromeStorage()) }
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
    { name: 'ai-flow-presets', storage: createJSONStorage(() => chromeStorage()) }
  )
)
