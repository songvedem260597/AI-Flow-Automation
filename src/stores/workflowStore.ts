import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'
import type { Workflow, WorkflowNode, WorkflowEdge, FlowNodeType } from '@/types'
import { v4 as uuid } from 'uuid'

type WorkflowHistory = {
  past: Workflow[]
  future: Workflow[]
}

const HISTORY_LIMIT = 80

const cloneWorkflow = (workflow: Workflow): Workflow => JSON.parse(JSON.stringify(workflow)) as Workflow

const workflowSnapshotKey = (workflow: Workflow): string =>
  JSON.stringify({
    id: workflow.id,
    name: workflow.name,
    nodes: workflow.nodes,
    edges: workflow.edges
  })

const emptyHistory = (): WorkflowHistory => ({ past: [], future: [] })

const pushWorkflowHistory = (
  state: Pick<WorkflowState, 'workflows' | 'activeWorkflowId' | 'history'>,
  workflowId = state.activeWorkflowId
): Record<string, WorkflowHistory> => {
  if (!workflowId) return state.history
  const workflow = state.workflows.find((item) => item.id === workflowId)
  if (!workflow) return state.history

  const currentHistory = state.history[workflowId] || emptyHistory()
  const snapshot = cloneWorkflow(workflow)
  const lastSnapshot = currentHistory.past[currentHistory.past.length - 1]
  if (lastSnapshot && workflowSnapshotKey(lastSnapshot) === workflowSnapshotKey(snapshot)) {
    return state.history
  }

  return {
    ...state.history,
    [workflowId]: {
      past: [...currentHistory.past, snapshot].slice(-HISTORY_LIMIT),
      future: []
    }
  }
}

/**
 * Promise-based adapter around `chrome.storage.local` implementing the
 * Zustand `StateStorage` contract (signature: getItem/setItem/removeItem
 * all take `name` as the FIRST argument).
 *
 * Historical bug: a previous wrapper used `chromeStorage(key)` factory
 * returning `{ getItem: () => …, setItem: (value) => … }` — no `name`.
 * Zustand's `createJSONStorage` calls `storage.setItem(name, value)`, so
 * the wrapper bound `value = name = "ai-flow-workflows"` and overwrote
 * the key with the literal string `"ai-flow-workflows"`. Rehydrate then
 * tried to JSON.parse("ai-flow-workflows") and failed.
 *
 * Fix: a single `StateStorage` object whose setItem takes (name, value)
 * and writes `{ [name]: value }` to chrome.storage.local.
 *
 * Diagnostic logs (prefix `[WorkflowPersist][storage.*]`) help confirm
 * the signature is wired correctly. They are gated by
 * `localStorage.AI_FLOW_DEBUG === '1'`; default OFF.
 */
const DEBUG_PERSIST = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('AI_FLOW_DEBUG') === '1'
  } catch {
    return false
  }
}

const countWorkflows = (raw: string | null): number => {
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw) as { state?: { workflows?: unknown[] } }
    return Array.isArray(parsed?.state?.workflows) ? parsed.state.workflows.length : 0
  } catch {
    return 0
  }
}

const activeWorkflowIdFromRaw = (raw: string | null): string | null => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { state?: { activeWorkflowId?: string | null } }
    return parsed?.state?.activeWorkflowId ?? null
  } catch {
    return null
  }
}

const parseValueForDiag = (value: string): {
  parsedTopKeys: string[] | null
  parsedStateKeys: string[] | null
  workflowCountFromParsed: number | null
  activeWorkflowIdFromParsed: string | null
} => {
  let parsedTopKeys: string[] | null = null
  let parsedStateKeys: string[] | null = null
  let workflowCountFromParsed: number | null = null
  let activeWorkflowIdFromParsed: string | null = null
  try {
    const top = JSON.parse(value) as Record<string, unknown>
    parsedTopKeys = Object.keys(top)
    if (top && typeof top === 'object' && 'state' in top) {
      const inner = (top as { state?: Record<string, unknown> }).state
      if (inner && typeof inner === 'object') {
        parsedStateKeys = Object.keys(inner)
        workflowCountFromParsed = Array.isArray((inner as { workflows?: unknown[] }).workflows)
          ? (inner as { workflows: unknown[] }).workflows.length
          : 0
        activeWorkflowIdFromParsed =
          (inner as { activeWorkflowId?: string | null }).activeWorkflowId ?? null
      }
    }
  } catch {
    parsedTopKeys = null
  }
  return { parsedTopKeys, parsedStateKeys, workflowCountFromParsed, activeWorkflowIdFromParsed }
}

const chromeStorage: StateStorage = {
  getItem: (name: string): Promise<string | null> => {
    if (DEBUG_PERSIST()) {
      console.log('[WorkflowPersist][storage.getItem:start]', JSON.stringify({ name }))
    }
    return new Promise((resolve) => {
      chrome.storage.local.get(name, (result) => {
        const raw = result[name]
        let value: string | null = null
        if (typeof raw === 'string') {
          value = raw
        } else if (raw == null) {
          value = null
        } else {
          value = JSON.stringify(raw)
        }
        if (DEBUG_PERSIST()) {
          console.log('[WorkflowPersist][storage.getItem:resolved]', JSON.stringify({
            name,
            hasValue: value !== null,
            rawLength: value?.length ?? 0,
            workflowCount: countWorkflows(value),
            activeWorkflowId: activeWorkflowIdFromRaw(value)
          }))
        }
        resolve(value)
      })
    })
  },
  setItem: (name: string, value: string): Promise<void> => {
    if (DEBUG_PERSIST()) {
      const diag = parseValueForDiag(value)
      console.log('[WorkflowPersist][storage.setItem]', JSON.stringify({
        name,
        valuePreview: value.slice(0, 300),
        valueLength: value.length,
        parsedTopKeys: diag.parsedTopKeys,
        parsedStateKeys: diag.parsedStateKeys,
        workflowCountFromParsed: diag.workflowCountFromParsed,
        activeWorkflowIdFromParsed: diag.activeWorkflowIdFromParsed
      }))
      if (diag.workflowCountFromParsed === 0) {
        console.trace('[WorkflowPersist][storage.setItem:zero-workflows]')
      }
    }
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [name]: value }, () => {
        const err = chrome.runtime.lastError
        if (err) reject(err)
        else resolve()
      })
    })
  },
  removeItem: (name: string): Promise<void> => {
    if (DEBUG_PERSIST()) {
      console.log('[WorkflowPersist][storage.removeItem]', JSON.stringify({ name }))
    }
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(name, () => {
        const err = chrome.runtime.lastError
        if (err) reject(err)
        else resolve()
      })
    })
  }
}

interface WorkflowState {
  workflows: Workflow[]
  activeWorkflowId: string | null
  selectedNodeId: string | null
  selectedEdgeId: string | null
  isDirty: boolean
  history: Record<string, WorkflowHistory>
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
  updateNodePositions: (positions: Record<string, { x: number; y: number }>, workflowId?: string) => void
  deleteNode: (nodeId: string) => void
  setSelectedNode: (nodeId: string | null) => void

  addEdge: (edge: Omit<WorkflowEdge, 'id'>) => void
  updateEdge: (edgeId: string, updates: Partial<WorkflowEdge>) => void
  deleteEdge: (edgeId: string) => void
  setSelectedEdge: (edgeId: string | null) => void

  importWorkflow: (workflow: Workflow) => void
  exportWorkflow: (id: string) => Workflow | null
  clearAllWorkflows: () => void
  undoWorkflow: (workflowId?: string) => void
  redoWorkflow: (workflowId?: string) => void
  canUndoWorkflow: (workflowId?: string) => boolean
  canRedoWorkflow: (workflowId?: string) => boolean
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
        timeout: 300000
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
      history: {},

      hydrateFromStorage: async () => {
        if (DEBUG_PERSIST()) console.log('[WorkflowPersist][hydrateFromStorage:start]')
        const result = await chrome.storage.local.get('ai-flow-workflows')
        const saved = result['ai-flow-workflows']
        if (!saved) {
          if (DEBUG_PERSIST()) {
            console.log('[WorkflowPersist][hydrateFromStorage:read]', JSON.stringify({
              hasValue: false,
              workflowCount: 0,
              activeWorkflowId: null,
              rawLength: 0
            }))
          }
          return
        }

        let parsed: { state?: Partial<WorkflowState> } | null = null
        try {
          parsed = JSON.parse(saved) as { state?: Partial<WorkflowState> }
        } catch {
          if (DEBUG_PERSIST()) {
            console.log('[WorkflowPersist][hydrateFromStorage:read]', JSON.stringify({
              hasValue: true,
              workflowCount: 0,
              activeWorkflowId: null,
              rawLength: saved.length,
              parseError: true
            }))
          }
          return
        }

        const state = parsed?.state
        const wc = Array.isArray(state?.workflows) ? state.workflows.length : 0
        const aw = state?.activeWorkflowId ?? null
        if (DEBUG_PERSIST()) {
          console.log('[WorkflowPersist][hydrateFromStorage:read]', JSON.stringify({
            hasValue: true,
            workflowCount: wc,
            activeWorkflowId: aw,
            rawLength: saved.length
          }))
        }

        if (!state?.workflows) return

        if (DEBUG_PERSIST()) {
          console.log('[WorkflowPersist][hydrateFromStorage:set]', JSON.stringify({
            workflowCount: wc,
            activeWorkflowId: aw
          }))
          if (wc === 0) {
            console.trace('[WorkflowPersist][hydrateFromStorage:set:zero-workflows]')
          }
        }
        set({
          workflows: state.workflows,
          activeWorkflowId: state.activeWorkflowId ?? state.workflows[0]?.id ?? null,
          selectedNodeId: state.selectedNodeId ?? null,
          selectedEdgeId: state.selectedEdgeId ?? null
        })
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
        if (DEBUG_PERSIST()) {
          console.log('[WorkflowPersist][createWorkflow:before]', JSON.stringify({
            currentCount: get().workflows.length
          }))
        }
        set((state) => ({
          workflows: [...state.workflows, workflow],
          activeWorkflowId: workflow.id,
          history: { ...state.history, [workflow.id]: emptyHistory() },
          isDirty: true
        }))
        if (DEBUG_PERSIST()) {
          console.log('[WorkflowPersist][createWorkflow:after]', JSON.stringify({
            nextCount: get().workflows.length,
            createdId: workflow.id,
            activeWorkflowId: get().activeWorkflowId
          }))
        }
        return workflow
      },

      updateWorkflow: (id, updates) => {
        set((state) => ({
          history: pushWorkflowHistory(state, id),
          workflows: state.workflows.map((w) =>
            w.id === id ? { ...w, ...updates, updatedAt: Date.now() } : w
          ),
          isDirty: true
        }))
      },

      deleteWorkflow: (id) => {
        set((state) => {
          const workflows = state.workflows.filter((w) => w.id !== id)
          const { [id]: _deletedHistory, ...history } = state.history
          return {
            workflows,
            history,
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
        set((state) => ({
          workflows: [...state.workflows, duplicate],
          activeWorkflowId: duplicate.id,
          history: { ...state.history, [duplicate.id]: emptyHistory() },
          isDirty: true
        }))
        return duplicate
      },

      setActiveWorkflow: (id) => {
        if (DEBUG_PERSIST()) {
          console.log('[WorkflowPersist][setActiveWorkflow:before]', JSON.stringify({
            currentCount: get().workflows.length,
            nextActiveWorkflowId: id
          }))
        }
        set({ activeWorkflowId: id, selectedNodeId: null, selectedEdgeId: null })
        if (DEBUG_PERSIST()) {
          console.log('[WorkflowPersist][setActiveWorkflow:after]', JSON.stringify({
            nextCount: get().workflows.length,
            activeWorkflowId: get().activeWorkflowId
          }))
        }
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
          history: pushWorkflowHistory(state),
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
          history: pushWorkflowHistory(state),
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
        set((state) => {
          const workflow = state.workflows.find((w) => w.id === state.activeWorkflowId)
          const node = workflow?.nodes.find((n) => n.id === nodeId)
          if (!workflow || !node) return state
          if (node.position.x === position.x && node.position.y === position.y) return state

          return {
            history: pushWorkflowHistory(state),
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
            ),
            isDirty: true
          }
        })
      },

      updateNodePositions: (positions, workflowId) => {
        set((state) => {
          const id = workflowId || state.activeWorkflowId
          const workflow = state.workflows.find((w) => w.id === id)
          if (!workflow) return state

          let changed = false
          const nextNodes = workflow.nodes.map((node) => {
            const position = positions[node.id]
            if (!position) return node
            if (node.position.x === position.x && node.position.y === position.y) return node
            changed = true
            return { ...node, position }
          })

          if (!changed) return state

          return {
            history: pushWorkflowHistory(state, id),
            workflows: state.workflows.map((w) =>
              w.id === id
                ? {
                    ...w,
                    nodes: nextNodes,
                    updatedAt: Date.now()
                  }
                : w
            ),
            isDirty: true
          }
        })
      },

      deleteNode: (nodeId) => {
        set((state) => ({
          history: pushWorkflowHistory(state),
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
        set((state) => {
          const workflow = state.workflows.find((item) => item.id === state.activeWorkflowId)
          const exists = workflow?.edges.some((existing) =>
            existing.source === edge.source &&
            existing.target === edge.target &&
            existing.sourceHandle === edge.sourceHandle &&
            existing.targetHandle === edge.targetHandle
          )
          if (!workflow || exists) return state

          return {
            history: pushWorkflowHistory(state),
            workflows: state.workflows.map((w) =>
              w.id === state.activeWorkflowId
                ? {
                    ...w,
                    edges: [...w.edges, { ...edge, id: uuid() }],
                    updatedAt: Date.now()
                  }
                : w
            ),
            isDirty: true
          }
        })
      },

      updateEdge: (edgeId, updates) => {
        set((state) => ({
          history: pushWorkflowHistory(state),
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
          history: pushWorkflowHistory(state),
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
            history: { ...state.history, [updated.id]: emptyHistory() },
            isDirty: true
          }
        })
      },

      exportWorkflow: (id) => {
        return get().workflows.find((w) => w.id === id) || null
      },

      clearAllWorkflows: () => {
        set({ workflows: [], activeWorkflowId: null, selectedNodeId: null, selectedEdgeId: null, history: {}, isDirty: true })
      },

      undoWorkflow: (workflowId) => {
        set((state) => {
          const id = workflowId || state.activeWorkflowId
          if (!id) return state
          const workflow = state.workflows.find((item) => item.id === id)
          const currentHistory = state.history[id] || emptyHistory()
          const previous = currentHistory.past[currentHistory.past.length - 1]
          if (!workflow || !previous) return state

          const nextPast = currentHistory.past.slice(0, -1)
          const nextFuture = [cloneWorkflow(workflow), ...currentHistory.future].slice(0, HISTORY_LIMIT)
          const restored = cloneWorkflow(previous)
          const selectedNodeId = state.selectedNodeId && restored.nodes.some((node) => node.id === state.selectedNodeId)
            ? state.selectedNodeId
            : null
          const selectedEdgeId = state.selectedEdgeId && restored.edges.some((edge) => edge.id === state.selectedEdgeId)
            ? state.selectedEdgeId
            : null

          return {
            workflows: state.workflows.map((item) => item.id === id ? { ...restored, updatedAt: Date.now() } : item),
            selectedNodeId,
            selectedEdgeId,
            history: {
              ...state.history,
              [id]: {
                past: nextPast,
                future: nextFuture
              }
            },
            isDirty: true
          }
        })
      },

      redoWorkflow: (workflowId) => {
        set((state) => {
          const id = workflowId || state.activeWorkflowId
          if (!id) return state
          const workflow = state.workflows.find((item) => item.id === id)
          const currentHistory = state.history[id] || emptyHistory()
          const next = currentHistory.future[0]
          if (!workflow || !next) return state

          const nextPast = [...currentHistory.past, cloneWorkflow(workflow)].slice(-HISTORY_LIMIT)
          const nextFuture = currentHistory.future.slice(1)
          const restored = cloneWorkflow(next)
          const selectedNodeId = state.selectedNodeId && restored.nodes.some((node) => node.id === state.selectedNodeId)
            ? state.selectedNodeId
            : null
          const selectedEdgeId = state.selectedEdgeId && restored.edges.some((edge) => edge.id === state.selectedEdgeId)
            ? state.selectedEdgeId
            : null

          return {
            workflows: state.workflows.map((item) => item.id === id ? { ...restored, updatedAt: Date.now() } : item),
            selectedNodeId,
            selectedEdgeId,
            history: {
              ...state.history,
              [id]: {
                past: nextPast,
                future: nextFuture
              }
            },
            isDirty: true
          }
        })
      },

      canUndoWorkflow: (workflowId) => {
        const id = workflowId || get().activeWorkflowId
        return Boolean(id && get().history[id]?.past.length)
      },

      canRedoWorkflow: (workflowId) => {
        const id = workflowId || get().activeWorkflowId
        return Boolean(id && get().history[id]?.future.length)
      },

      markDirty: () => set({ isDirty: true }),
      markClean: () => set({ isDirty: false })
    }),
    {
      name: 'ai-flow-workflows',
      storage: createJSONStorage(() => chromeStorage),
      partialize: (state) => {
        const partialized: Partial<WorkflowState> = {
          workflows: state.workflows,
          activeWorkflowId: state.activeWorkflowId
        }
        if (DEBUG_PERSIST()) {
          console.log('[WorkflowPersist][partialize]', JSON.stringify({
            workflowCount: state.workflows?.length,
            activeWorkflowId: state.activeWorkflowId,
            keys: Object.keys(partialized)
          }))
        }
        return partialized
      },
      onRehydrateStorage: () => (state, error) => {
        const wc = Array.isArray(state?.workflows) ? state.workflows.length : 0
        const aw = state?.activeWorkflowId ?? null
        if (DEBUG_PERSIST()) {
          console.log('[WorkflowPersist][rehydrate:finish]', JSON.stringify({
            workflowCount: wc,
            activeWorkflowId: aw,
            error: error ? String(error) : null
          }))
        }
      }
    }
  )
)
