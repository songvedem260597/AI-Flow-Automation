import {
  normalizeFilmProject,
  sanitizeFilmProjectForPersist,
  type FilmProject,
} from '@/agent/schemas/filmProjectSchemas'

export const FILM_PROJECTS_STORAGE_KEY = 'ai-flow-film-projects'
export const AGENT_ACTIVE_PROJECT_STORAGE_KEY = 'ai-flow-agent-active-project'
export const AGENT_RUNS_STORAGE_KEY = 'ai-flow-agent-runs'

export interface FilmProjectPersistenceSnapshot {
  projects: FilmProject[]
  activeProjectByWorkflow: Record<string, string>
}

let projectWriteQueue: Promise<void> = Promise.resolve()

const readStorage = async (keys: string[]): Promise<Record<string, unknown>> => {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return {}
  return chrome.storage.local.get(keys) as Promise<Record<string, unknown>>
}

const writeStorage = async (values: Record<string, unknown>): Promise<void> => {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  await chrome.storage.local.set(values)
}

const normalizeActiveMap = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const output: Record<string, string> = {}
  for (const [workflowId, projectId] of Object.entries(value as Record<string, unknown>)) {
    if (workflowId.trim() && typeof projectId === 'string' && projectId.trim()) {
      output[workflowId.trim()] = projectId.trim()
    }
  }
  return output
}

export const loadFilmProjectSnapshot = async (): Promise<FilmProjectPersistenceSnapshot> => {
  await projectWriteQueue
  const stored = await readStorage([FILM_PROJECTS_STORAGE_KEY, AGENT_ACTIVE_PROJECT_STORAGE_KEY])
  const projects = Array.isArray(stored[FILM_PROJECTS_STORAGE_KEY])
    ? (stored[FILM_PROJECTS_STORAGE_KEY] as unknown[])
      .map((project) => normalizeFilmProject(project, true))
      .filter((project): project is FilmProject => Boolean(project))
    : []
  const activeProjectByWorkflow = normalizeActiveMap(stored[AGENT_ACTIVE_PROJECT_STORAGE_KEY])
  return { projects, activeProjectByWorkflow }
}

export const saveFilmProjectSnapshot = async (snapshot: FilmProjectPersistenceSnapshot): Promise<void> => {
  const projects = snapshot.projects
    .map(sanitizeFilmProjectForPersist)
    .filter((project): project is FilmProject => Boolean(project))
  const activeProjectByWorkflow = normalizeActiveMap(snapshot.activeProjectByWorkflow)
  const operation = projectWriteQueue.then(() => writeStorage({
    [FILM_PROJECTS_STORAGE_KEY]: projects,
    [AGENT_ACTIVE_PROJECT_STORAGE_KEY]: activeProjectByWorkflow,
  }))
  projectWriteQueue = operation.catch(() => undefined)
  await operation
}

export const queueFilmProjectSnapshotSave = (snapshot: FilmProjectPersistenceSnapshot): void => {
  const operation = projectWriteQueue.then(() => writeStorage({
    [FILM_PROJECTS_STORAGE_KEY]: snapshot.projects
      .map(sanitizeFilmProjectForPersist)
      .filter((project): project is FilmProject => Boolean(project)),
    [AGENT_ACTIVE_PROJECT_STORAGE_KEY]: normalizeActiveMap(snapshot.activeProjectByWorkflow),
  }))
  projectWriteQueue = operation.catch(() => undefined)
}
