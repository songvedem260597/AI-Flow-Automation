import { create } from 'zustand'
import {
  createEmptyFilmProject,
  normalizeFilmProject,
  type AgentApproval,
  type AgentTask,
  type FilmProject,
} from '@/agent/schemas/filmProjectSchemas'
import {
  loadFilmProjectSnapshot,
  queueFilmProjectSnapshotSave,
} from '@/agent/persistence/filmProjectPersistence'

interface FilmProjectStoreState {
  projects: FilmProject[]
  activeProjectByWorkflow: Record<string, string>
  hydrated: boolean
  hydrate: () => Promise<void>
  getProjectForWorkflow: (workflowId: string) => FilmProject | null
  ensureProject: (workflowId: string, title?: string) => FilmProject
  setActiveProject: (workflowId: string, projectId: string) => void
  upsertProject: (project: FilmProject) => FilmProject
  updateProject: (projectId: string, updater: (project: FilmProject) => FilmProject) => FilmProject | null
  upsertTask: (projectId: string, task: AgentTask) => void
  upsertApproval: (projectId: string, approval: AgentApproval) => void
}

let hydrationPromise: Promise<void> | null = null

const persistState = (projects: FilmProject[], activeProjectByWorkflow: Record<string, string>): void => {
  queueFilmProjectSnapshotSave({ projects, activeProjectByWorkflow })
}

export const useFilmProjectStore = create<FilmProjectStoreState>((set, get) => ({
  projects: [],
  activeProjectByWorkflow: {},
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return
    if (!hydrationPromise) {
      hydrationPromise = loadFilmProjectSnapshot().then((snapshot) => {
        set({ ...snapshot, hydrated: true })
        // Persist once so tasks that were running before reload become
        // explicit interrupted failures instead of silently remaining active.
        persistState(snapshot.projects, snapshot.activeProjectByWorkflow)
      }).finally(() => {
        hydrationPromise = null
      })
    }
    await hydrationPromise
  },

  getProjectForWorkflow: (workflowId) => {
    const state = get()
    const activeId = state.activeProjectByWorkflow[workflowId]
    return state.projects.find((project) => project.id === activeId)
      || state.projects.find((project) => project.workflowId === workflowId)
      || null
  },

  ensureProject: (workflowId, title) => {
    const existing = get().getProjectForWorkflow(workflowId)
    if (existing) return existing
    const project = createEmptyFilmProject(workflowId, title)
    set((state) => {
      const projects = [...state.projects, project]
      const activeProjectByWorkflow = { ...state.activeProjectByWorkflow, [workflowId]: project.id }
      persistState(projects, activeProjectByWorkflow)
      return { projects, activeProjectByWorkflow }
    })
    return project
  },

  setActiveProject: (workflowId, projectId) => {
    if (!get().projects.some((project) => project.id === projectId && project.workflowId === workflowId)) return
    set((state) => {
      const activeProjectByWorkflow = { ...state.activeProjectByWorkflow, [workflowId]: projectId }
      persistState(state.projects, activeProjectByWorkflow)
      return { activeProjectByWorkflow }
    })
  },

  upsertProject: (project) => {
    const normalized = normalizeFilmProject(project)
    if (!normalized) throw new Error('Invalid FilmProject payload.')
    set((state) => {
      const exists = state.projects.some((item) => item.id === normalized.id)
      const projects = exists
        ? state.projects.map((item) => item.id === normalized.id ? normalized : item)
        : [...state.projects, normalized]
      const activeProjectByWorkflow = {
        ...state.activeProjectByWorkflow,
        [normalized.workflowId]: normalized.id,
      }
      persistState(projects, activeProjectByWorkflow)
      return { projects, activeProjectByWorkflow }
    })
    return normalized
  },

  updateProject: (projectId, updater) => {
    const existing = get().projects.find((project) => project.id === projectId)
    if (!existing) return null
    const next = normalizeFilmProject({ ...updater(existing), updatedAt: Date.now() })
    if (!next) throw new Error('FilmProject update failed schema validation.')
    set((state) => {
      const projects = state.projects.map((project) => project.id === projectId ? next : project)
      persistState(projects, state.activeProjectByWorkflow)
      return { projects }
    })
    return next
  },

  upsertTask: (projectId, task) => {
    get().updateProject(projectId, (project) => ({
      ...project,
      tasks: project.tasks.some((item) => item.id === task.id)
        ? project.tasks.map((item) => item.id === task.id ? task : item)
        : [...project.tasks, task],
    }))
  },

  upsertApproval: (projectId, approval) => {
    get().updateProject(projectId, (project) => ({
      ...project,
      approvals: project.approvals.some((item) => item.id === approval.id)
        ? project.approvals.map((item) => item.id === approval.id ? approval : item)
        : [...project.approvals, approval],
    }))
  },
}))
