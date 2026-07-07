import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'
import type { Workflow, WorkflowNode, WorkflowEdge, FlowNodeType } from '@/types'
import { v4 as uuid } from 'uuid'
import { canvasLog } from '@/lib/canvasInvestigate'

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
 * Diagnostic logs (`[WorkflowPersist][storage.*]`) were removed in the
 * log-cleanup pass — production console must stay quiet. Only the
 * `[WorkflowPersist][storage.setItem:quota.retry]` warning remains
 * because quota exhaustion is a real operational signal.
 */
const DEBUG_PERSIST = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('AI_FLOW_DEBUG_PERSIST') === '1'
  } catch {
    return false
  }
}

let workflowStorageHydrated = false
let isManualHydratingWorkflowStorage = false
let allowNextEmptyWorkflowPersist = false
const lastPersistedWorkflowValues = new Map<string, string | null>()

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

const stringifyStoredValue = (raw: unknown): string | null => {
  if (typeof raw === 'string') return raw
  if (raw == null) return null
  try {
    return JSON.stringify(raw)
  } catch {
    return null
  }
}

const chromeStorage: StateStorage = {
  getItem: (name: string): Promise<string | null> => {
    return new Promise((resolve) => {
      chrome.storage.local.get(name, (result) => {
        const raw = result[name]
        const value = stringifyStoredValue(raw)
        lastPersistedWorkflowValues.set(name, value)
        resolve(value)
      })
    })
  },
  setItem: (name: string, value: string): Promise<void> => {
    const nextWorkflowCount = countWorkflows(value)
    return new Promise((resolve, reject) => {
      if (isManualHydratingWorkflowStorage) {
        resolve()
        return
      }
      if (!workflowStorageHydrated && nextWorkflowCount === 0) {
        resolve()
        return
      }
      if (lastPersistedWorkflowValues.get(name) === value) {
        resolve()
        return
      }

      const writeValue = (nextValue: string, allowQuotaRetry: boolean) => {
        chrome.storage.local.set({ [name]: nextValue }, () => {
          const err = chrome.runtime.lastError
          if (!err) {
            lastPersistedWorkflowValues.set(name, nextValue)
            allowNextEmptyWorkflowPersist = false
            resolve()
            return
          }
          if (!allowQuotaRetry || !isQuotaError(err)) {
            allowNextEmptyWorkflowPersist = false
            reject(err)
            return
          }

          const sanitizedValue = sanitizeWorkflowPayloadString(nextValue)
          if (sanitizedValue === nextValue) {
            allowNextEmptyWorkflowPersist = false
            reject(err)
            return
          }
          // Real warning, not gated debug — quota retry is a real
          // operational signal worth surfacing even in production.
          // eslint-disable-next-line no-console
          console.warn('[WorkflowPersist][storage.setItem:quota.retry]', JSON.stringify({
            name,
            beforeKb: Math.round(nextValue.length / 1024 * 10) / 10,
            afterKb: Math.round(sanitizedValue.length / 1024 * 10) / 10
          }))
          writeValue(sanitizedValue, false)
        })
      }

      chrome.storage.local.get(name, (result) => {
        const currentValue = stringifyStoredValue(result[name])
        const currentWorkflowCount = countWorkflows(currentValue)
        lastPersistedWorkflowValues.set(name, currentValue)

        if (currentValue === value) {
          resolve()
          return
        }
        if (nextWorkflowCount === 0 && currentWorkflowCount > 0 && !allowNextEmptyWorkflowPersist) {
          resolve()
          return
        }
        writeValue(value, true)
      })
    })
  },
  removeItem: (name: string): Promise<void> => {
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
  updateNodeAndRemoveEdges: (nodeId: string, data: Partial<WorkflowNode['data']>, edgeIds: string[]) => void
  updateNodePosition: (nodeId: string, position: { x: number; y: number }) => void
  updateNodePositions: (positions: Record<string, { x: number; y: number }>, workflowId?: string) => void
  deleteNode: (nodeId: string) => void
  deleteNodes: (workflowId: string, nodeIds: string[]) => void
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

const HEAVY_PERSIST_KEYS = new Set([
  'mediaData',
  'imageData',
  'videoData',
  'base64',
  'dataUrl',
  'thumbnailData',
  'rawFile',
  'file',
  'blob',
  'result',
  'runResult',
  'logs',
  'mediaPoster',
  'videoPoster'
])

// [AssetStore] Legacy base64-style fields that are explicitly safe to
// drop whenever the node already carries an assetId pointer. Used by
// the sanitizer so a freshly uploaded image does not bloat
// chrome.storage.local with the parallel data URL — IndexedDB owns
// the blob now and the store only has a 16-char id.
const LEGACY_BASE64_DROP_WHEN_ASSET_PRESENT = new Set([
  'mediaData',
  'imageData',
  'videoData',
  'mediaPoster',
  'videoPoster'
])

// [AssetStore] Lightweight metadata fields written by the upload
// path that are SAFE-TO-KEEP across persist because they are short
// strings. They never grow large.
const ASSET_METADATA_KEYS = new Set([
  'assetId',
  'mediaAssetId',
  'imageAssetId',
  'posterAssetId',
  'thumbnailAssetId',
  'fileName',
  'mediaName',
  'imageName',
  'videoName',
  'mimeType',
  'mediaMimeType',
  'size',
  'width',
  'height',
  'mediaWidth',
  'mediaHeight',
  'imageWidth',
  'imageHeight',
  'videoWidth',
  'videoHeight',
  'duration',
  'mediaType',
  'aspectRatio'
])

// [AssetStore] Object URL strings minted by `URL.createObjectURL`.
// The blob lives only inside the asset cache and the URL is useless
// after a reload. Never persist them.
const TRANSIENT_OBJECT_URL_KEYS = new Set([
  'objectUrl',
  'assetObjectUrl',
  'resolvedAssetUrl',
  'previewUrl'
])

// [AssetStore][GenerateOutput] Whitelist of safe keys to keep
// inside a `_output.outputs[]` descriptor so the preview survives a
// reload. Items without any matching key are dropped. Remote http(s)
// URLs are short, assetIds are 16 chars, mimeType / size are short —
// nothing here ever grows large.
const GENERATE_OUTPUT_SAFE_KEYS = new Set([
  'assetId',
  'posterAssetId',
  'thumbnailAssetId',
  'url',
  'videoUrl',
  'imageUrl',
  'mediaUrl',
  'thumbnailUrl',
  'poster',
  'mediaType',
  'type',
  'mimeType',
  'size',
  'width',
  'height',
  'duration',
  'savedFilename',
  'fileNameFromFlow',
  'name',
  'outputAvailable',
  'createdAt'
])

// [AssetStore][GenerateOutput] Safe top-level keys inside `_output`
// itself. Mirrors what the renderer reads from `_output` — any URL
// field is fine (short), thumbnail / poster URLs are short, and the
// cached assetId pointers are tiny. We deliberately do NOT keep
// arbitrary `_output` fields the runner may have stuffed in; if a
// future field is needed, add it here.
const GENERATE_OUTPUT_TOP_LEVEL_SAFE_KEYS = new Set([
  'assetId',
  'posterAssetId',
  'thumbnailAssetId',
  'outputs',
  'images',
  'imageUrls',
  'url',
  'videoUrl',
  'imageUrl',
  'mediaUrl',
  'thumbnailUrl',
  'poster',
  'mediaType',
  'type',
  'mimeType',
  'size',
  'createdAt'
])

const PERSIST_STRING_LENGTH_LIMIT = 100_000
const PERSIST_BUDGET_WARN_KB = 5000

const isQuotaError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error || '')
  return /quota|kQuotaBytes|QUOTA_BYTES|exceeded/i.test(message)
}

const isHeavyPersistString = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  if (value.startsWith('data:') || value.startsWith('blob:')) return true
  return value.length > PERSIST_STRING_LENGTH_LIMIT
}

/**
 * [AssetStore] Strip legacy base64-style fields from a node's `data`
 * when an `assetId` reference is already in place. Called from
 * `sanitizePersistValue` for objects that look like a workflow node
 * (`type` + `data`). Returns a new object — never mutates input.
 */
const stripLegacyBase64WhenAssetPresent = (data: Record<string, unknown>): Record<string, unknown> => {
  const assetId = typeof data.assetId === 'string'
    ? data.assetId
    : typeof data.mediaAssetId === 'string'
      ? data.mediaAssetId
      : typeof data.imageAssetId === 'string'
        ? data.imageAssetId
        : ''
  const posterAssetId = typeof data.posterAssetId === 'string'
    ? data.posterAssetId
    : typeof data.thumbnailAssetId === 'string'
      ? data.thumbnailAssetId
      : ''
  if (!assetId && !posterAssetId) return data

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (LEGACY_BASE64_DROP_WHEN_ASSET_PRESENT.has(key)) continue
    out[key] = value
  }
  return out
}

/**
 * [AssetStore][GenerateOutput] Sanitize a `_output` descriptor so
 * the persisted payload only carries the safe metadata the editor
 * reads back on reload. Items inside `outputs[]` are filtered
 * through `GENERATE_OUTPUT_SAFE_KEYS`; remote http(s) URLs are
 * preserved; anything else (custom runner fields, runtime stats,
 * diagnostic blobs) is dropped. Heavy strings (data:, blob:,
 * > 100 KB) inside safe fields are still filtered by
 * `isHeavyPersistString` in the generic recursive pass.
 */
const sanitizeGenerateOutput = (value: unknown): unknown => {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    if (!GENERATE_OUTPUT_TOP_LEVEL_SAFE_KEYS.has(key)) continue
    if (key === 'outputs' && Array.isArray(child)) {
      const sanitizedItems: unknown[] = []
      for (const item of child) {
        if (!item || typeof item !== 'object') continue
        const itemRecord = item as Record<string, unknown>
        const safeItem: Record<string, unknown> = {}
        for (const [itemKey, itemValue] of Object.entries(itemRecord)) {
          if (!GENERATE_OUTPUT_SAFE_KEYS.has(itemKey)) continue
          if (typeof itemValue === 'string') {
            if (isHeavyPersistString(itemValue)) continue
            safeItem[itemKey] = itemValue
          } else if (typeof itemValue === 'number' || typeof itemValue === 'boolean') {
            safeItem[itemKey] = itemValue
          } else {
            // Nested object — drop. Outputs items are flat in the
            // contract; nested objects are usually runner-only
            // telemetry that has no business surviving reload.
          }
        }
        if (Object.keys(safeItem).length > 0) sanitizedItems.push(safeItem)
      }
      if (sanitizedItems.length > 0) out.outputs = sanitizedItems
      continue
    }
    if (key === 'images' && Array.isArray(child)) {
      const safeImages: unknown[] = []
      for (const item of child) {
        if (!item || typeof item !== 'object') continue
        const itemRecord = item as Record<string, unknown>
        const safeItem: Record<string, unknown> = {}
        for (const [itemKey, itemValue] of Object.entries(itemRecord)) {
          if (!GENERATE_OUTPUT_SAFE_KEYS.has(itemKey)) continue
          if (typeof itemValue === 'string' && !isHeavyPersistString(itemValue)) {
            safeItem[itemKey] = itemValue
          }
        }
        if (Object.keys(safeItem).length > 0) safeImages.push(safeItem)
      }
      if (safeImages.length > 0) out.images = safeImages
      continue
    }
    if (key === 'imageUrls' && Array.isArray(child)) {
      const safeUrls: unknown[] = []
      for (const url of child) {
        if (typeof url === 'string' && !isHeavyPersistString(url) && url.length > 0) {
          safeUrls.push(url)
        }
      }
      if (safeUrls.length > 0) out.imageUrls = safeUrls
      continue
    }
    if (typeof child === 'string') {
      if (isHeavyPersistString(child)) continue
      out[key] = child
    } else if (typeof child === 'number' || typeof child === 'boolean') {
      out[key] = child
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const sanitizePersistValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return value
  if (isHeavyPersistString(value)) return undefined
  if (Array.isArray(value)) {
    return value
      .map(sanitizePersistValue)
      .filter((item) => item !== undefined)
  }
  if (typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  // [AssetStore] Detect a workflow-node shape (it carries a string
  // `type` and an object `data`). Apply the per-node legacy-base64
  // strip BEFORE the generic recursive walk so the heavy fields
  // never reach `isHeavyPersistString` (which would already catch
  // them, but pre-stripping keeps the persisted payload smaller and
  // avoids the typeof string check for thousands of nested values).
  let working = record
  if (
    typeof working.type === 'string'
    && working.data
    && typeof working.data === 'object'
    && !Array.isArray(working.data)
  ) {
    const dataRecord = working.data as Record<string, unknown>
    const strippedData = stripLegacyBase64WhenAssetPresent(dataRecord)
    if (strippedData !== dataRecord) {
      working = { ...working, data: strippedData }
    }
  }

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(working)) {
    if (HEAVY_PERSIST_KEYS.has(key)) continue
    if (TRANSIENT_OBJECT_URL_KEYS.has(key)) continue
    // [AssetStore][GenerateOutput] `_output` carries a rich
    // descriptor; route it through the dedicated sanitiser so we
    // never persist arbitrary runtime fields the runner may have
    // stuffed in. Heavy strings are still filtered per-key.
    if (key === '_output') {
      const sanitizedOutput = sanitizeGenerateOutput(child)
      if (sanitizedOutput !== undefined) out[key] = sanitizedOutput
      continue
    }
    const sanitized = sanitizePersistValue(child)
    if (sanitized !== undefined) out[key] = sanitized
  }
  return out
}

const sanitizeWorkflowForPersist = (workflow: Workflow): Workflow =>
  sanitizePersistValue(workflow) as Workflow

const sanitizeWorkflowsForPersist = (workflows: Workflow[] = []): Workflow[] =>
  workflows.map(sanitizeWorkflowForPersist)

const sanitizeWorkflowPayloadString = (value: string): string => {
  try {
    const parsed = JSON.parse(value) as { state?: Partial<WorkflowState>; version?: number }
    if (!parsed?.state) return value
    const workflows = Array.isArray(parsed.state.workflows)
      ? sanitizeWorkflowsForPersist(parsed.state.workflows as Workflow[])
      : []
    return JSON.stringify({
      ...parsed,
      state: {
        workflows,
        activeWorkflowId: parsed.state.activeWorkflowId ?? workflows[0]?.id ?? null
      }
    })
  } catch {
    return value
  }
}

const approxKb = (value: unknown): number => {
  try {
    return Math.round(JSON.stringify(value ?? {}).length / 1024 * 10) / 10
  } catch {
    return 0
  }
}

const warnIfPersistPayloadLooksHeavy = (workflows: Workflow[]): void => {
  if (!DEBUG_PERSIST()) return
  const kb = approxKb(workflows)
  let heavyStringCount = 0
  const stack: unknown[] = [workflows]
  while (stack.length) {
    const current = stack.pop()
    if (typeof current === 'string') {
      if (isHeavyPersistString(current)) heavyStringCount += 1
      continue
    }
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) stack.push(...current)
    else stack.push(...Object.values(current as Record<string, unknown>))
  }
  if (kb > PERSIST_BUDGET_WARN_KB || heavyStringCount > 0) {
    console.warn('[WorkflowPersist][storage.size.warning]', JSON.stringify({
      sanitizedKb: kb,
      workflowCount: workflows.length,
      heavyStringCount,
      budgetKb: PERSIST_BUDGET_WARN_KB
    }))
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
        const result = await chrome.storage.local.get('ai-flow-workflows')
        const saved = result['ai-flow-workflows']
        if (!saved) {
          workflowStorageHydrated = true
          lastPersistedWorkflowValues.set('ai-flow-workflows', null)
          return
        }
        const savedRaw = stringifyStoredValue(saved)
        if (!savedRaw) {
          workflowStorageHydrated = true
          lastPersistedWorkflowValues.set('ai-flow-workflows', null)
          return
        }
        lastPersistedWorkflowValues.set('ai-flow-workflows', savedRaw)

        let parsed: { state?: Partial<WorkflowState> } | null = null
        try {
          parsed = JSON.parse(savedRaw) as { state?: Partial<WorkflowState> }
        } catch {
          workflowStorageHydrated = true
          return
        }

        const state = parsed?.state

        if (!state?.workflows) {
          workflowStorageHydrated = true
          return
        }
        const sanitizedWorkflows = sanitizeWorkflowsForPersist(state.workflows as Workflow[])
        const activeWorkflowId = state.activeWorkflowId ?? sanitizedWorkflows[0]?.id ?? null

        isManualHydratingWorkflowStorage = true
        try {
          set({
            workflows: sanitizedWorkflows,
            activeWorkflowId,
            selectedNodeId: state.selectedNodeId ?? null,
            selectedEdgeId: state.selectedEdgeId ?? null
          })
        } finally {
          isManualHydratingWorkflowStorage = false
          workflowStorageHydrated = true
        }

        const sanitizedPayload = sanitizeWorkflowPayloadString(savedRaw)
        if (sanitizedPayload !== savedRaw && sanitizedPayload.length < savedRaw.length) {
          try {
            await chrome.storage.local.set({ 'ai-flow-workflows': sanitizedPayload })
            lastPersistedWorkflowValues.set('ai-flow-workflows', sanitizedPayload)
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[WorkflowPersist][hydrateFromStorage:persist-back:failed]', (err as Error).message)
          }
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
        set((state) => ({
          workflows: [...state.workflows, workflow],
          activeWorkflowId: workflow.id,
          history: { ...state.history, [workflow.id]: emptyHistory() },
          isDirty: true
        }))
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
          if (workflows.length === 0) allowNextEmptyWorkflowPersist = true
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

      updateNodeAndRemoveEdges: (nodeId, data, edgeIds) => {
        const edgeIdSet = new Set(edgeIds)
        set((state) => {
          const workflow = state.workflows.find((w) => w.id === state.activeWorkflowId)
          if (!workflow) return state

          const nodeExists = workflow.nodes.some((node) => node.id === nodeId)
          if (!nodeExists) return state

          const shouldRemoveEdges = edgeIdSet.size > 0
          return {
            history: pushWorkflowHistory(state),
            workflows: state.workflows.map((w) =>
              w.id === state.activeWorkflowId
                ? {
                    ...w,
                    nodes: w.nodes.map((n) =>
                      n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n
                    ),
                    edges: shouldRemoveEdges ? w.edges.filter((edge) => !edgeIdSet.has(edge.id)) : w.edges,
                    updatedAt: Date.now()
                  }
                : w
            ),
            selectedEdgeId: state.selectedEdgeId && edgeIdSet.has(state.selectedEdgeId) ? null : state.selectedEdgeId,
            isDirty: true
          }
        })
      },

      updateNodePosition: (nodeId, position) => {
        set((state) => {
          const workflow = state.workflows.find((w) => w.id === state.activeWorkflowId)
          const node = workflow?.nodes.find((n) => n.id === nodeId)
          if (!workflow || !node) return state
          if (node.position.x === position.x && node.position.y === position.y) return state

          // [CanvasInvestigate] probe — fires for every distinct
          // (x,y) the runner-side drag crosses. The key signals:
          //   - "positionOnly: true"            — pure drag mutation
          //   - "updatedAtChanged: true"        — workflow list ordering shifts
          //   - "triggersHistoryPush: true"     — undo/redo churn
          // Counterpart: WorkflowEditor [nodeMoved] emits the
          // upstream Drawflow-side draw ticks. If the ratio is
          // 1:1 (one store update per draw tick), every tick is
          // triggering a full state-machine round-trip.
          const beforeUpdatedAt = workflow.updatedAt ?? null
          const nextUpdatedAt = Date.now()
          canvasLog('updateNodePosition', {
            nodeId,
            x: position.x,
            y: position.y,
            updatedAtChanged: beforeUpdatedAt !== nextUpdatedAt,
            triggersHistoryPush: true,
            positionOnly: true,
          })

          return {
            history: pushWorkflowHistory(state),
            workflows: state.workflows.map((w) =>
              w.id === state.activeWorkflowId
                ? {
                    ...w,
                    nodes: w.nodes.map((n) =>
                      n.id === nodeId ? { ...n, position } : n
                    ),
                    updatedAt: nextUpdatedAt
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

          // [CanvasInvestigate] probe — bulk per-frame position
          // commit (used at drag-end, not per draw tick). Pair
          // with [updateNodePosition] to confirm whether the
          // per-tick store churn is one or many round-trips.
          const beforeUpdatedAt = workflow.updatedAt ?? null
          const nextUpdatedAt = Date.now()
          canvasLog('updateNodePositions', {
            positionsCount: Object.keys(positions).length,
            updatedAtChanged: beforeUpdatedAt !== nextUpdatedAt,
            triggersHistoryPush: true,
            positionOnly: true,
          })

          return {
            history: pushWorkflowHistory(state, id),
            workflows: state.workflows.map((w) =>
              w.id === id
                ? {
                    ...w,
                    nodes: nextNodes,
                    updatedAt: nextUpdatedAt
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

      // [WorkflowDelete] Batch delete. Removes every node whose id is
      // in `nodeIds` plus every edge whose source OR target is in the
      // same set, in a single state write so undo/redo collapses the
      // whole gesture into one history entry. This is the path
      // `deleteSelectedNodes` (multi-select + Delete) takes — looping
      // `deleteNode` would push one history entry per node and require
      // the user to Ctrl+Z once per node.
      deleteNodes: (workflowId, nodeIds) => {
        const ids = Array.from(new Set((nodeIds || []).filter(Boolean)))
        if (ids.length === 0) return

        const before = get().workflows.find((w) => w.id === workflowId)
        if (!before) return

        const idSet = new Set(ids)

        set((state) => ({
          history: pushWorkflowHistory(state, workflowId),
          workflows: state.workflows.map((w) =>
            w.id === workflowId
              ? {
                  ...w,
                  nodes: w.nodes.filter((n) => !idSet.has(n.id)),
                  edges: w.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target)),
                  updatedAt: Date.now()
                }
              : w
          ),
          selectedNodeId: state.selectedNodeId && idSet.has(state.selectedNodeId)
            ? null
            : state.selectedNodeId,
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
        allowNextEmptyWorkflowPersist = true
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
        const sanitized = sanitizeWorkflowsForPersist(state.workflows || [])
        warnIfPersistPayloadLooksHeavy(sanitized)
        const partialized: Partial<WorkflowState> = {
          workflows: sanitized,
          activeWorkflowId: state.activeWorkflowId
        }
        return partialized
      },
      onRehydrateStorage: () => (state, error) => {
        workflowStorageHydrated = true
        // `error` is left unused — rehydrate is currently best-effort
        // and the `hydrateFromStorage()` action runs after mount.
        void error
      }
    }
  )
)
