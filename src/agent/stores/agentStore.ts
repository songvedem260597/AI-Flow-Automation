import { create } from 'zustand'
import { AGENT_RUNS_STORAGE_KEY } from '@/agent/persistence/filmProjectPersistence'
import { sanitizeAgentValue, type AgentMode, type AgentTask } from '@/agent/schemas/filmProjectSchemas'
import { useFilmProjectStore } from '@/agent/stores/filmProjectStore'
import {
  isWorkflowPatch,
  type AgentToolName,
  type AgentToolResult,
  type WorkflowPatch,
} from '@/agent/schemas/agentToolSchemas'

export type AgentPanelTab = 'chat' | 'tasks' | 'context' | 'scenes'

export interface AgentToolActivity {
  id: string
  projectId?: string
  toolName: AgentToolName
  status: 'running' | 'completed' | 'failed' | 'waiting-approval'
  summary: string
  createdAt: number
}

export type PilotJobStatus =
  | 'queued'
  | 'running'
  | 'waiting-output'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface AgentPilotJob {
  id: string
  idempotencyKey: string
  projectId: string
  shotId: string
  workflowId: string
  nodeId: string
  generateNodeId: string
  approvalId: string
  kind: 'image' | 'video'
  attempt: number
  status: PilotJobStatus
  runnerTaskId?: string
  outputAssetId?: string
  assetId?: string
  error?: string
  cancellationRequested?: boolean
  startedAt: number
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export type PilotJob = AgentPilotJob

interface PersistedAgentRunState {
  modesByWorkflow: Record<string, AgentMode>
  pendingPatchesByWorkflow: Record<string, WorkflowPatch>
  idempotencyResults: Record<string, AgentToolResult>
  activities: AgentToolActivity[]
  pilotJobs: PilotJob[]
}

interface AgentStoreState extends PersistedAgentRunState {
  activeTab: AgentPanelTab
  hydrated: boolean
  hydrate: () => Promise<void>
  setActiveTab: (tab: AgentPanelTab) => void
  setMode: (workflowId: string, mode: AgentMode) => void
  setPendingPatch: (workflowId: string, patch: WorkflowPatch | null) => void
  getIdempotentResult: (key: string) => AgentToolResult | null
  rememberIdempotentResult: (key: string, result: AgentToolResult) => void
  addActivity: (activity: AgentToolActivity) => void
  clearProjectActivities: (projectId: string) => void
  updateTask: (projectId: string, taskId: string, patch: Partial<Pick<AgentTask, 'status' | 'progress' | 'error' | 'result'>>) => void
  upsertPilotJob: (job: PilotJob) => void
  updatePilotJob: (jobId: string, patch: Partial<PilotJob>) => void
  getPilotJobByKey: (idempotencyKey: string) => PilotJob | null
}

const AGENT_MODES = new Set<AgentMode>(['plan-only', 'edit-workflow', 'run-with-approval', 'auto'])
let hydrationPromise: Promise<void> | null = null
let writeQueue: Promise<void> = Promise.resolve()

const normalizeStringMap = <T extends string>(value: unknown, allowed: Set<T>): Record<string, T> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const output: Record<string, T> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key && typeof child === 'string' && allowed.has(child as T)) output[key] = child as T
  }
  return output
}

const normalizePersistedState = (value: unknown): PersistedAgentRunState => {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const pendingPatchesByWorkflow: Record<string, WorkflowPatch> = {}
  if (record.pendingPatchesByWorkflow && typeof record.pendingPatchesByWorkflow === 'object') {
    for (const [workflowId, patch] of Object.entries(record.pendingPatchesByWorkflow as Record<string, unknown>)) {
      if (workflowId && isWorkflowPatch(patch)) pendingPatchesByWorkflow[workflowId] = patch
    }
  }
  const idempotencyResults: Record<string, AgentToolResult> = {}
  if (record.idempotencyResults && typeof record.idempotencyResults === 'object') {
    for (const [key, result] of Object.entries(record.idempotencyResults as Record<string, unknown>).slice(-300)) {
      const sanitized = sanitizeAgentValue(result)
      if (key && sanitized && typeof sanitized === 'object') idempotencyResults[key] = sanitized as AgentToolResult
    }
  }
  const activities = Array.isArray(record.activities)
    ? record.activities.slice(-120).filter((activity): activity is AgentToolActivity => Boolean(
      activity
      && typeof activity === 'object'
      && typeof (activity as AgentToolActivity).id === 'string'
      && typeof (activity as AgentToolActivity).toolName === 'string'
    ))
    : []
  const pilotJobs = Array.isArray(record.pilotJobs)
    ? record.pilotJobs.slice(-200).map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const job = value as Record<string, unknown>
      const status = typeof job.status === 'string' ? job.status as PilotJobStatus : 'failed'
      if (!['queued', 'running', 'waiting-output', 'completed', 'failed', 'cancelled', 'interrupted'].includes(status)) return null
      const interrupted = ['queued', 'running', 'waiting-output'].includes(status)
      const normalized: PilotJob = {
        id: String(job.id || ''),
        idempotencyKey: String(job.idempotencyKey || ''),
        projectId: String(job.projectId || ''),
        shotId: String(job.shotId || ''),
        workflowId: String(job.workflowId || ''),
        nodeId: String(job.nodeId || job.generateNodeId || ''),
        generateNodeId: String(job.generateNodeId || job.nodeId || ''),
        approvalId: String(job.approvalId || ''),
        kind: job.kind === 'video' ? 'video' : 'image',
        attempt: Math.max(1, Math.min(999, Number(job.attempt) || 1)),
        status: interrupted ? 'interrupted' : status,
        ...(typeof job.runnerTaskId === 'string' && job.runnerTaskId ? { runnerTaskId: job.runnerTaskId } : {}),
        ...(typeof job.outputAssetId === 'string' && job.outputAssetId
          ? { outputAssetId: job.outputAssetId }
          : typeof job.assetId === 'string' && job.assetId ? { outputAssetId: job.assetId } : {}),
        ...(typeof job.assetId === 'string' && job.assetId
          ? { assetId: job.assetId }
          : typeof job.outputAssetId === 'string' && job.outputAssetId ? { assetId: job.outputAssetId } : {}),
        ...(interrupted
          ? { error: 'Interrupted because the extension was reloaded. No provider request was resubmitted.' }
          : typeof job.error === 'string' && job.error ? { error: job.error } : {}),
        ...(job.cancellationRequested === true ? { cancellationRequested: true } : {}),
        startedAt: Number(job.startedAt) || Number(job.createdAt) || Date.now(),
        createdAt: Number(job.createdAt) || Date.now(),
        updatedAt: Number(job.updatedAt) || Date.now(),
        ...(Number.isFinite(Number(job.completedAt)) ? { completedAt: Number(job.completedAt) } : {}),
      }
      return normalized.id && normalized.idempotencyKey && normalized.projectId && normalized.shotId && normalized.workflowId && normalized.nodeId && normalized.generateNodeId
        ? normalized
        : null
    }).filter((job): job is PilotJob => Boolean(job))
    : []
  return {
    modesByWorkflow: normalizeStringMap(record.modesByWorkflow, AGENT_MODES),
    pendingPatchesByWorkflow,
    idempotencyResults,
    activities,
    pilotJobs,
  }
}

const persist = (state: PersistedAgentRunState): void => {
  const safeState = normalizePersistedState(sanitizeAgentValue(state))
  const operation = writeQueue.then(async () => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [AGENT_RUNS_STORAGE_KEY]: safeState })
    }
  })
  writeQueue = operation.catch(() => undefined)
}

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  activeTab: 'chat',
  hydrated: false,
  modesByWorkflow: {},
  pendingPatchesByWorkflow: {},
  idempotencyResults: {},
  activities: [],
  pilotJobs: [],

  hydrate: async () => {
    if (get().hydrated) return
    if (!hydrationPromise) {
      hydrationPromise = (async () => {
        const stored = typeof chrome !== 'undefined' && chrome.storage?.local
          ? await chrome.storage.local.get(AGENT_RUNS_STORAGE_KEY)
          : {}
        set({ ...normalizePersistedState(stored[AGENT_RUNS_STORAGE_KEY]), hydrated: true })
      })().finally(() => {
        hydrationPromise = null
      })
    }
    await hydrationPromise
  },

  setActiveTab: (activeTab) => set({ activeTab }),

  setMode: (workflowId, mode) => {
    if (!workflowId || !AGENT_MODES.has(mode)) return
    set((state) => {
      const modesByWorkflow = { ...state.modesByWorkflow, [workflowId]: mode }
      persist({ ...state, modesByWorkflow })
      return { modesByWorkflow }
    })
  },

  setPendingPatch: (workflowId, patch) => {
    set((state) => {
      const pendingPatchesByWorkflow = { ...state.pendingPatchesByWorkflow }
      if (patch) pendingPatchesByWorkflow[workflowId] = patch
      else delete pendingPatchesByWorkflow[workflowId]
      persist({ ...state, pendingPatchesByWorkflow })
      return { pendingPatchesByWorkflow }
    })
  },

  getIdempotentResult: (key) => get().idempotencyResults[key] || null,

  rememberIdempotentResult: (key, result) => {
    if (!key) return
    set((state) => {
      const entries = Object.entries({ ...state.idempotencyResults, [key]: result }).slice(-300)
      const idempotencyResults = Object.fromEntries(entries)
      persist({ ...state, idempotencyResults })
      return { idempotencyResults }
    })
  },

  addActivity: (activity) => {
    set((state) => {
      const activities = [...state.activities.filter((item) => item.id !== activity.id), activity].slice(-120)
      persist({ ...state, activities })
      return { activities }
    })
  },

  clearProjectActivities: (projectId) => {
    set((state) => {
      const activities = state.activities.filter((item) => item.projectId !== projectId)
      persist({ ...state, activities })
      return { activities }
    })
  },

  updateTask: (projectId, taskId, patch) => {
    useFilmProjectStore.getState().updateProject(projectId, (project) => ({
      ...project,
      tasks: project.tasks.map((task) => task.id === taskId ? { ...task, ...patch } : task),
    }))
  },

  upsertPilotJob: (job) => {
    set((state) => {
      const pilotJobs = [...state.pilotJobs.filter((item) => item.id !== job.id && item.idempotencyKey !== job.idempotencyKey), job].slice(-200)
      persist({ ...state, pilotJobs })
      return { pilotJobs }
    })
  },

  updatePilotJob: (jobId, patch) => {
    set((state) => {
      const pilotJobs = state.pilotJobs.map((job) => job.id === jobId
        ? { ...job, ...patch, id: job.id, idempotencyKey: job.idempotencyKey, updatedAt: Date.now() }
        : job)
      persist({ ...state, pilotJobs })
      return { pilotJobs }
    })
  },

  getPilotJobByKey: (idempotencyKey) => get().pilotJobs.find((job) => job.idempotencyKey === idempotencyKey) || null,
}))
