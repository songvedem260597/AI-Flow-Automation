import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { HistoryEntry, SavedPrompt, PresetTemplate } from '@/types'
import { v4 as uuid } from 'uuid'

const DATA_HEAVY_KEYS = new Set([
  'nodeResults',
  'thumbnail',
  'mediaData',
  'imageData',
  'videoData',
  'base64',
  'dataUrl',
  'thumbnailData',
  'rawFile',
  'file',
  'blob',
  'outputs',
  'images',
  'result',
  'runResult',
  'logs',
  '_output',
  'mediaPoster',
  'videoPoster'
])

const DATA_STRING_LENGTH_LIMIT = 100_000

const isDataQuotaError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error || '')
  return /quota|kQuotaBytes|QUOTA_BYTES|exceeded/i.test(message)
}

const isHeavyDataString = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  if (value.startsWith('data:') || value.startsWith('blob:')) return true
  return value.length > DATA_STRING_LENGTH_LIMIT
}

const sanitizeDataPersistValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return value
  if (isHeavyDataString(value)) return undefined
  if (Array.isArray(value)) {
    return value
      .map(sanitizeDataPersistValue)
      .filter((item) => item !== undefined)
  }
  if (typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (DATA_HEAVY_KEYS.has(key)) continue
    const sanitized = sanitizeDataPersistValue(child)
    if (sanitized !== undefined) out[key] = sanitized
  }
  return out
}

const sanitizeJsonStorageValue = (value: string): string => {
  try {
    return JSON.stringify(sanitizeDataPersistValue(JSON.parse(value)))
  } catch {
    return value
  }
}

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
          const raw = result[key] ?? null
          if (typeof raw !== 'string') {
            resolve(raw == null ? null : JSON.stringify(raw))
            return
          }
          const sanitized = sanitizeJsonStorageValue(raw)
          if (sanitized !== raw && sanitized.length < raw.length) {
            chrome.storage.local.set({ [key]: sanitized }, () => {
              const writeBackError = chrome.runtime.lastError
              if (writeBackError) {
                console.warn(`[dataStore] Failed to compact ${key}:`, writeBackError.message)
              }
            })
            resolve(sanitized)
            return
          }
          resolve(raw)
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
            if (isDataQuotaError(error)) {
              const sanitizedValue = sanitizeJsonStorageValue(value)
              if (sanitizedValue !== value) {
                chrome.storage.local.set({ [key]: sanitizedValue }, () => {
                  const retryError = chrome.runtime.lastError
                  if (retryError) {
                    console.warn(`[dataStore] Failed to write sanitized ${key}:`, retryError.message)
                  }
                  resolve()
                })
                return
              }
            }
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
    {
      name: 'ai-flow-history',
      storage: createJSONStorage(() => chromeStorage()),
      partialize: (state) => ({
        entries: sanitizeDataPersistValue(state.entries) as HistoryEntry[]
      })
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
    {
      name: 'ai-flow-presets',
      storage: createJSONStorage(() => chromeStorage()),
      partialize: (state) => ({
        presets: sanitizeDataPersistValue(state.presets) as PresetTemplate[]
      })
    }
  )
)
