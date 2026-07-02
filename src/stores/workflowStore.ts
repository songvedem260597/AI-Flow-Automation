import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Workflow, WorkflowNode, WorkflowEdge, FlowNodeType } from '@/types'
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

interface WorkflowState {
  workflows: Workflow[]
  activeWorkflowId: string | null
  selectedNodeId: string | null
  selectedEdgeId: string | null
  isDirty: boolean
  hydrateFromStorage: () => Promise<void>

  createWorkflow: (name?: string) => Workflow
  updateWorkflow: (id: string, updates: Partial<Workflow>) => void
  deleteWorkflow: (id: string) => void
  duplicateWorkflow: (id: string) => Workflow | null
  setActiveWorkflow: (id: string | null) => void
  getActiveWorkflow: () => Workflow | null

  addNode: (type: FlowNodeType, position: { x: number; y: number }) => WorkflowNode | null
  updateNode: (nodeId: string, data: Partial<WorkflowNode['data']>) => void
  updateNodePosition: (nodeId: string, position: { x: number; y: number }) => void
  deleteNode: (nodeId: string) => void
  setSelectedNode: (nodeId: string | null) => void

  addEdge: (edge: Omit<WorkflowEdge, 'id'>) => void
  updateEdge: (edgeId: string, updates: Partial<WorkflowEdge>) => void
  deleteEdge: (edgeId: string) => void
  setSelectedEdge: (edgeId: string | null) => void

  importWorkflow: (workflow: Workflow) => void
  exportWorkflow: (id: string) => Workflow | null
  clearAllWorkflows: () => void
  markDirty: () => void
  markClean: () => void
}

const createDefaultNodeData = (type: FlowNodeType): Record<string, unknown> => {
  const base: Record<string, unknown> = { label: `New ${type.charAt(0).toUpperCase() + type.slice(1)} Node` }
  switch (type) {
    case 'prompt':
      return { ...base, prompt: '', provider: 'chatgpt', model: '' }
    case 'image':
      return {
        ...base,
        label: 'New Media Node',
        mediaType: 'image',
        mediaUrl: '',
        mediaData: '',
        mediaName: '',
        mediaPoster: '',
        imageUrl: '',
        imageData: '',
        videoUrl: '',
        videoData: '',
        videoPoster: '',
        aspectRatio: '1:1',
        provider: 'chatgpt'
      }
    case 'generate':
      return {
        ...base,
        provider: 'chatgpt',
        mediaType: 'image',
        aspectRatio: '1:1',
        model: '',
        autoGenerate: true,
        waitForCompletion: true,
        timeout: 60000
      }
    case 'delay':
      return { ...base, duration: 1000 }
    case 'download':
      return { ...base, format: 'png', autoDownload: true }
    case 'wait':
      return { ...base, condition: 'dom-change', selector: '', timeout: 30000 }
    case 'condition':
      return { ...base, condition: '' }
    case 'loop':
      return { ...base, iterations: 1, delayBetween: 1000 }
    default:
      return base
  }
}

export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set, get) => ({
      workflows: [],
      activeWorkflowId: null,
      selectedNodeId: null,
      selectedEdgeId: null,
      isDirty: false,

      hydrateFromStorage: async () => {
        const result = await chrome.storage.local.get('ai-flow-workflows')
        const saved = result['ai-flow-workflows']
        if (!saved) return

        try {
          const parsed = JSON.parse(saved)
          const state = parsed.state as Partial<WorkflowState> | undefined
          if (!state?.workflows) return

          set({
            workflows: state.workflows,
            activeWorkflowId: state.activeWorkflowId ?? state.workflows[0]?.id ?? null,
            selectedNodeId: state.selectedNodeId ?? null,
            selectedEdgeId: state.selectedEdgeId ?? null
          })
        } catch {
          // Ignore corrupt persisted state.
        }
      },

      createWorkflow: (name) => {
        const workflow: Workflow = {
          id: uuid(),
          name: name || 'Untitled Workflow',
          nodes: [],
          edges: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        set((state) => ({ workflows: [...state.workflows, workflow], activeWorkflowId: workflow.id, isDirty: true }))
        return workflow
      },

      updateWorkflow: (id, updates) => {
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === id ? { ...w, ...updates, updatedAt: Date.now() } : w
          ),
          isDirty: true
        }))
      },

      deleteWorkflow: (id) => {
        set((state) => {
          const workflows = state.workflows.filter((w) => w.id !== id)
          return {
            workflows,
            activeWorkflowId: state.activeWorkflowId === id ? (workflows[0]?.id || null) : state.activeWorkflowId,
            isDirty: true
          }
        })
      },

      duplicateWorkflow: (id) => {
        const wf = get().workflows.find((w) => w.id === id)
        if (!wf) return null
        const duplicate: Workflow = {
          ...JSON.parse(JSON.stringify(wf)),
          id: uuid(),
          name: `${wf.name} (Copy)`,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        set((state) => ({ workflows: [...state.workflows, duplicate], activeWorkflowId: duplicate.id, isDirty: true }))
        return duplicate
      },

      setActiveWorkflow: (id) => {
        set({ activeWorkflowId: id, selectedNodeId: null, selectedEdgeId: null })
      },

      getActiveWorkflow: () => {
        const state = get()
        return state.workflows.find((w) => w.id === state.activeWorkflowId) || null
      },

      addNode: (type, position) => {
        const workflow = get().getActiveWorkflow()
        if (!workflow) return null
        const node: WorkflowNode = {
          id: uuid(),
          type,
          position,
          data: createDefaultNodeData(type) as WorkflowNode['data']
        }
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === state.activeWorkflowId
              ? { ...w, nodes: [...w.nodes, node], updatedAt: Date.now() }
              : w
          ),
          isDirty: true
        }))
        return node
      },

      updateNode: (nodeId, data) => {
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === state.activeWorkflowId
              ? {
                  ...w,
                  nodes: w.nodes.map((n) =>
                    n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n
                  ),
                  updatedAt: Date.now()
                }
              : w
          ),
          isDirty: true
        }))
      },

      updateNodePosition: (nodeId, position) => {
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === state.activeWorkflowId
              ? {
                  ...w,
                  nodes: w.nodes.map((n) =>
                    n.id === nodeId ? { ...n, position } : n
                  ),
                  updatedAt: Date.now()
                }
              : w
          )
        }))
      },

      deleteNode: (nodeId) => {
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === state.activeWorkflowId
              ? {
                  ...w,
                  nodes: w.nodes.filter((n) => n.id !== nodeId),
                  edges: w.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
                  updatedAt: Date.now()
                }
              : w
          ),
          selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
          isDirty: true
        }))
      },

      setSelectedNode: (nodeId) => {
        set({ selectedNodeId: nodeId, selectedEdgeId: nodeId ? null : get().selectedEdgeId })
      },

      addEdge: (edge) => {
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === state.activeWorkflowId
              ? {
                  ...w,
                  edges: w.edges.some((existing) =>
                    existing.source === edge.source &&
                    existing.target === edge.target &&
                    existing.sourceHandle === edge.sourceHandle &&
                    existing.targetHandle === edge.targetHandle
                  )
                    ? w.edges
                    : [...w.edges, { ...edge, id: uuid() }],
                  updatedAt: Date.now()
                }
              : w
          ),
          isDirty: true
        }))
      },

      updateEdge: (edgeId, updates) => {
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === state.activeWorkflowId
              ? {
                  ...w,
                  edges: w.edges.map((e) => (e.id === edgeId ? { ...e, ...updates } : e)),
                  updatedAt: Date.now()
                }
              : w
          ),
          isDirty: true
        }))
      },

      deleteEdge: (edgeId) => {
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === state.activeWorkflowId
              ? { ...w, edges: w.edges.filter((e) => e.id !== edgeId), updatedAt: Date.now() }
              : w
          ),
          selectedEdgeId: state.selectedEdgeId === edgeId ? null : state.selectedEdgeId,
          isDirty: true
        }))
      },

      setSelectedEdge: (edgeId) => {
        set({ selectedEdgeId: edgeId, selectedNodeId: edgeId ? null : get().selectedNodeId })
      },

      importWorkflow: (workflow) => {
        set((state) => {
          const idx = state.workflows.findIndex((w) => w.id === workflow.id)
          const updated = { ...workflow, updatedAt: Date.now() }
          return {
            workflows: idx !== -1
              ? state.workflows.map((w, i) => (i === idx ? updated : w))
              : [...state.workflows, updated],
            activeWorkflowId: updated.id,
            isDirty: true
          }
        })
      },

      exportWorkflow: (id) => {
        return get().workflows.find((w) => w.id === id) || null
      },

      clearAllWorkflows: () => {
        set({ workflows: [], activeWorkflowId: null, selectedNodeId: null, selectedEdgeId: null, isDirty: true })
      },

      markDirty: () => set({ isDirty: true }),
      markClean: () => set({ isDirty: false })
    }),
    {
      name: 'ai-flow-workflows',
      storage: createJSONStorage(() => chromeStorage('ai-flow-workflows')),
      onRehydrateStorage: () => (state) => {
        if (state) {
          chrome.storage.local.get('ai-flow-workflows', (result) => {
            const saved = result['ai-flow-workflows']
            if (saved) {
              try {
                const parsed = JSON.parse(saved)
                if (parsed.state?.workflows?.length > 0) {
                  state.workflows = parsed.state.workflows
                  state.activeWorkflowId = parsed.state.activeWorkflowId ?? null
                  state.selectedNodeId = parsed.state.selectedNodeId ?? null
                  state.selectedEdgeId = parsed.state.selectedEdgeId ?? null
                }
              } catch {}
            }
          })
        }
      }
    }
  )
)
