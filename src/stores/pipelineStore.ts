import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { PipelineTask, PipelineLog, PipelineError } from '@/types'
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

interface PipelineState {
  tasks: PipelineTask[]
  logs: PipelineLog[]
  activeTaskId: string | null
  isRunning: boolean
  isPaused: boolean

  createTask: (workflowId: string) => PipelineTask
  updateTask: (taskId: string, updates: Partial<PipelineTask>) => void
  deleteTask: (taskId: string) => void
  clearCompletedTasks: () => void
  setActiveTask: (taskId: string | null) => void
  getActiveTask: () => PipelineTask | null
  startPipeline: (taskId: string) => void
  pausePipeline: (taskId: string) => void
  resumePipeline: (taskId: string) => void
  stopPipeline: (taskId: string) => void
  updateProgress: (taskId: string, nodeId: string, progress: number, results?: Record<string, unknown>) => void
  completePipeline: (taskId: string, results?: Record<string, unknown>) => void
  failPipeline: (taskId: string, error: PipelineError) => void
  addLog: (pipelineId: string, level: PipelineLog['level'], message: string, nodeId?: string, metadata?: Record<string, unknown>) => void
  clearLogs: (pipelineId?: string) => void
  setRunning: (running: boolean) => void
  setPaused: (paused: boolean) => void
}

export const usePipelineStore = create<PipelineState>()(
  persist(
    (set, get) => ({
      tasks: [],
      logs: [],
      activeTaskId: null,
      isRunning: false,
      isPaused: false,

      createTask: (workflowId) => {
        const task: PipelineTask = {
          id: uuid(),
          workflowId,
          status: 'pending',
          progress: 0,
          results: {},
          errors: [],
          createdAt: Date.now()
        }
        set((state) => ({ tasks: [task, ...state.tasks] }))
        return task
      },

      updateTask: (taskId, updates) => {
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, ...updates } : t))
        }))
      },

      deleteTask: (taskId) => {
        set((state) => ({
          tasks: state.tasks.filter((t) => t.id !== taskId),
          activeTaskId: state.activeTaskId === taskId ? null : state.activeTaskId,
          isRunning: state.activeTaskId === taskId ? false : state.isRunning,
          isPaused: state.activeTaskId === taskId ? false : state.isPaused,
          logs: state.logs.filter((l) => l.pipelineId !== taskId)
        }))
      },

      clearCompletedTasks: () => {
        set((state) => ({
          tasks: state.tasks.filter((t) =>
            t.status === 'running' || t.status === 'pending' || t.status === 'paused'
          )
        }))
      },

      setActiveTask: (taskId) => {
        set({ activeTaskId: taskId })
      },

      getActiveTask: () => {
        const state = get()
        return state.tasks.find((t) => t.id === state.activeTaskId) || null
      },

      startPipeline: (taskId) => {
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId ? { ...t, status: 'running', startedAt: Date.now(), errors: [] } : t
          ),
          activeTaskId: taskId,
          isRunning: true,
          isPaused: false
        }))
      },

      pausePipeline: (taskId) => {
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId ? { ...t, status: 'paused' } : t
          ),
          isPaused: true
        }))
      },

      resumePipeline: (taskId) => {
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId ? { ...t, status: 'running' } : t
          ),
          isPaused: false
        }))
      },

      stopPipeline: (taskId) => {
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId ? { ...t, status: 'cancelled', completedAt: Date.now() } : t
          ),
          isRunning: false,
          isPaused: false,
          activeTaskId: null
        }))
      },

      updateProgress: (taskId, nodeId, progress, results) => {
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId
              ? { ...t, currentNodeId: nodeId, progress: Math.min(100, Math.max(0, progress)), results: results ? { ...t.results, ...results } : t.results }
              : t
          )
        }))
      },

      completePipeline: (taskId, results) => {
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId
              ? { ...t, status: 'completed', progress: 100, completedAt: Date.now(), results: results ? { ...t.results, ...results } : t.results }
              : t
          ),
          isRunning: false,
          isPaused: false
        }))
      },

      failPipeline: (taskId, error) => {
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId
              ? { ...t, status: 'failed', errors: [...t.errors, error], completedAt: Date.now() }
              : t
          ),
          isRunning: false,
          isPaused: false
        }))
      },

      addLog: (pipelineId, level, message, nodeId, metadata) => {
        set((state) => ({
          logs: [
            { id: uuid(), pipelineId, nodeId, level, message, timestamp: Date.now(), metadata },
            ...state.logs.slice(0, 999)
          ]
        }))
      },

      clearLogs: (pipelineId) => {
        set((state) => ({
          logs: pipelineId ? state.logs.filter((l) => l.pipelineId !== pipelineId) : []
        }))
      },

      setRunning: (running) => set({ isRunning: running }),
      setPaused: (paused) => set({ isPaused: paused })
    }),
    {
      name: 'ai-flow-pipeline',
      storage: createJSONStorage(() => chromeStorage('ai-flow-pipeline')),
      partialize: (state) => ({ tasks: state.tasks }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          chrome.storage.local.get('ai-flow-pipeline', (result) => {
            const saved = result['ai-flow-pipeline']
            if (saved) {
              try {
                const parsed = JSON.parse(saved)
                if (parsed.state?.tasks?.length > 0) {
                  state.tasks = parsed.state.tasks
                }
              } catch {}
            }
          })
        }
      }
    }
  )
)
