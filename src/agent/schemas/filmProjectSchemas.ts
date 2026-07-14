export type FilmProjectStatus = 'draft' | 'planning' | 'production' | 'review' | 'completed'

export type AgentMode = 'plan-only' | 'edit-workflow' | 'run-with-approval' | 'auto'

export interface FilmBrief {
  logline: string
  genre: string
  audience: string
  targetDurationSec: number
  aspectRatio: '9:16' | '16:9' | '1:1'
  visualStyle: string
  language: string
  platform: string
  constraints: string[]
}

export interface StyleBible {
  visualIdentity: string
  palette: string[]
  lighting: string
  cameraLanguage: string
  renderStyle: string
  lockedRules: string[]
}

export interface FilmCharacter {
  id: string
  name: string
  role: string
  age?: string
  appearance: string
  hair?: string
  clothing?: string
  personality?: string
  lockedTraits: string[]
  referenceAssetIds: string[]
}

export interface FilmLocation {
  id: string
  name: string
  description: string
  lighting: string
  palette: string[]
  lockedTraits: string[]
  referenceAssetIds: string[]
}

export interface FilmScene {
  id: string
  order: number
  title: string
  locationId?: string
  summary: string
  purpose: string
  characterIds: string[]
  shotIds: string[]
}

export interface ShotReviewResult {
  shotId: string
  score: number
  approved: boolean
  problems: string[]
  action: 'approve' | 'regenerate-image' | 'regenerate-video' | 'manual-review'
  promptPatch?: string
}

export type FilmShotStatus =
  | 'planned'
  | 'workflow-ready'
  | 'generating-image'
  | 'image-ready'
  | 'image-approved'
  | 'generating-video'
  | 'video-ready'
  | 'needs-review'
  | 'approved'
  | 'failed'

export interface FilmShot {
  id: string
  sceneId: string
  order: number
  durationSec: number
  description: string
  camera: string
  action: string
  emotion: string
  imagePrompt: string
  videoPrompt: string
  negativePrompt?: string
  characterIds: string[]
  referenceAssetIds: string[]
  workflowNodeIds: string[]
  imageAssetId?: string
  videoAssetId?: string
  status: FilmShotStatus
  attempt: number
  imageAttempt: number
  videoAttempt: number
  review?: ShotReviewResult
}

export interface FilmAssetMapping {
  id: string
  projectId: string
  sceneId: string
  shotId: string
  workflowId: string
  nodeId: string
  assetId: string
  kind: 'image' | 'video'
  attempt: number
  status: 'ready' | 'approved' | 'rejected' | 'stale'
  createdAt: number
  updatedAt: number
}

export type AgentTaskType =
  | 'brief'
  | 'character'
  | 'world'
  | 'script'
  | 'storyboard'
  | 'workflow'
  | 'generate-image'
  | 'generate-video'
  | 'review'
  | 'pilot-image'
  | 'pilot-image-review'
  | 'pilot-video'
  | 'pilot-video-review'
  | 'export'

export type AgentTaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'waiting-output'
  | 'waiting-approval'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

export interface AgentTask {
  id: string
  type: AgentTaskType
  title: string
  status: AgentTaskStatus
  dependsOn: string[]
  progress: number
  progressMode?: 'real' | 'status'
  shotId?: string
  result?: unknown
  error?: string
}

export interface AgentApproval {
  id: string
  type: 'workflow-patch' | 'pilot-image' | 'pilot-video' | 'batch-generation' | 'destructive-change'
  title: string
  description: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  payload: Record<string, unknown>
  createdAt: number
  resolvedAt?: number
}

export interface FilmProject {
  id: string
  workflowId: string
  title: string
  status: FilmProjectStatus
  brief: FilmBrief
  styleBible: StyleBible
  characters: FilmCharacter[]
  locations: FilmLocation[]
  scenes: FilmScene[]
  shots: FilmShot[]
  tasks: AgentTask[]
  approvals: AgentApproval[]
  pilotShotId?: string
  assetMappings: FilmAssetMapping[]
  conversationSummary: string
  staleAssetIds: string[]
  createdAt: number
  updatedAt: number
}

const PROJECT_STATUSES = new Set<FilmProjectStatus>(['draft', 'planning', 'production', 'review', 'completed'])
const SHOT_STATUSES = new Set<FilmShotStatus>([
  'planned',
  'workflow-ready',
  'generating-image',
  'image-ready',
  'image-approved',
  'generating-video',
  'video-ready',
  'needs-review',
  'approved',
  'failed',
])
const TASK_TYPES = new Set<AgentTaskType>([
  'brief',
  'character',
  'world',
  'script',
  'storyboard',
  'workflow',
  'generate-image',
  'generate-video',
  'review',
  'pilot-image',
  'pilot-image-review',
  'pilot-video',
  'pilot-video-review',
  'export',
])
const TASK_STATUSES = new Set<AgentTaskStatus>([
  'pending',
  'queued',
  'running',
  'waiting-output',
  'waiting-approval',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
])

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value.trim().slice(0, 20_000) : fallback

const asNumber = (value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

const asStringArray = (value: unknown, limit = 100): string[] =>
  Array.isArray(value)
    ? Array.from(new Set(value.map((item) => asString(item)).filter(Boolean))).slice(0, limit)
    : []

export const createAgentId = (prefix: string): string => {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  return `${prefix}-${random}`
}

export const sanitizeAgentValue = (value: unknown, depth = 0): unknown => {
  if (depth > 8 || value === undefined || value === null) return value === null ? null : undefined
  if (typeof Blob !== 'undefined' && value instanceof Blob) return undefined
  if (typeof File !== 'undefined' && value instanceof File) return undefined
  if (typeof value === 'string') {
    if (/^(?:data|blob):/i.test(value) || value.length > 100_000) return undefined
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((item) => sanitizeAgentValue(item, depth + 1)).filter((item) => item !== undefined)
  }
  if (typeof value !== 'object') return undefined
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:blob|base64|dataUrl|objectUrl|mediaData|imageData|videoData)$/i.test(key)) continue
    const sanitized = sanitizeAgentValue(child, depth + 1)
    if (sanitized !== undefined) output[key] = sanitized
  }
  return output
}

export const createDefaultAgentTasks = (): AgentTask[] => {
  const definitions: Array<[string, AgentTaskType, string, string[]]> = [
    ['task-1', 'brief', 'Create project brief', []],
    ['task-2', 'character', 'Lock character bible', ['task-1']],
    ['task-3', 'world', 'Lock world and style bible', ['task-1']],
    ['task-4', 'script', 'Write screenplay progression', ['task-2', 'task-3']],
    ['task-5', 'storyboard', 'Split scenes and compose shots', ['task-4']],
    ['task-6', 'workflow', 'Propose workflow patch', ['task-5']],
    ['task-7', 'pilot-image', 'Generate pilot shot image', ['task-6']],
    ['task-8', 'pilot-image-review', 'Review pilot image', ['task-7']],
    ['task-9', 'pilot-video', 'Generate pilot shot video', ['task-8']],
    ['task-10', 'pilot-video-review', 'Review pilot video before batch', ['task-9']],
    ['task-11', 'export', 'Prepare edit and export plan', ['task-10']],
  ]
  return definitions.map(([id, type, title, dependsOn]) => ({
    id,
    type,
    title,
    status: 'pending',
    dependsOn,
    progress: 0,
    ...(type.startsWith('pilot-') ? { progressMode: 'status' as const } : {}),
  }))
}

export const createEmptyFilmProject = (workflowId: string, title = 'Untitled Film'): FilmProject => {
  const now = Date.now()
  return {
    id: createAgentId('film'),
    workflowId,
    title: title.trim().slice(0, 120) || 'Untitled Film',
    status: 'planning',
    brief: {
      logline: '',
      genre: '',
      audience: 'General audience',
      targetDurationSec: 60,
      aspectRatio: '9:16',
      visualStyle: '',
      language: 'English',
      platform: 'Social video',
      constraints: [],
    },
    styleBible: {
      visualIdentity: '',
      palette: [],
      lighting: '',
      cameraLanguage: '',
      renderStyle: '',
      lockedRules: [],
    },
    characters: [],
    locations: [],
    scenes: [],
    shots: [],
    tasks: createDefaultAgentTasks(),
    approvals: [],
    assetMappings: [],
    conversationSummary: '',
    staleAssetIds: [],
    createdAt: now,
    updatedAt: now,
  }
}

const normalizeTask = (value: unknown, interruptRunning: boolean): AgentTask | null => {
  const record = asRecord(value)
  const id = asString(record.id)
  const type = asString(record.type) as AgentTaskType
  const rawStatus = asString(record.status) as AgentTaskStatus
  if (!id || !TASK_TYPES.has(type) || !TASK_STATUSES.has(rawStatus)) return null
  const interrupted = interruptRunning && ['queued', 'running', 'waiting-output'].includes(rawStatus)
  return {
    id,
    type,
    title: asString(record.title, type),
    status: interrupted ? 'interrupted' : rawStatus,
    dependsOn: asStringArray(record.dependsOn),
    progress: interrupted ? 0 : asNumber(record.progress, 0, 0, 100),
    ...(record.progressMode === 'real' || record.progressMode === 'status' ? { progressMode: record.progressMode } : {}),
    ...(asString(record.shotId) ? { shotId: asString(record.shotId) } : {}),
    ...(sanitizeAgentValue(record.result) !== undefined ? { result: sanitizeAgentValue(record.result) } : {}),
    ...(interrupted
      ? { error: 'Interrupted because the extension was reloaded. Resume status check or create a new approved attempt; no provider request was resubmitted.' }
      : asString(record.error) ? { error: asString(record.error) } : {}),
  }
}

export const normalizeFilmProject = (value: unknown, interruptRunning = false): FilmProject | null => {
  const record = asRecord(value)
  const id = asString(record.id)
  const workflowId = asString(record.workflowId)
  if (!id || !workflowId) return null
  const brief = asRecord(record.brief)
  const styleBible = asRecord(record.styleBible)
  const createdAt = asNumber(record.createdAt, Date.now(), 0)
  const aspectRatio = asString(brief.aspectRatio)
  const project: FilmProject = {
    id,
    workflowId,
    title: asString(record.title, 'Untitled Film').slice(0, 120),
    status: PROJECT_STATUSES.has(record.status as FilmProjectStatus) ? record.status as FilmProjectStatus : 'planning',
    brief: {
      logline: asString(brief.logline),
      genre: asString(brief.genre),
      audience: asString(brief.audience, 'General audience'),
      targetDurationSec: asNumber(brief.targetDurationSec, 60, 1, 7_200),
      aspectRatio: aspectRatio === '16:9' || aspectRatio === '1:1' ? aspectRatio : '9:16',
      visualStyle: asString(brief.visualStyle),
      language: asString(brief.language, 'English'),
      platform: asString(brief.platform, 'Social video'),
      constraints: asStringArray(brief.constraints),
    },
    styleBible: {
      visualIdentity: asString(styleBible.visualIdentity),
      palette: asStringArray(styleBible.palette),
      lighting: asString(styleBible.lighting),
      cameraLanguage: asString(styleBible.cameraLanguage),
      renderStyle: asString(styleBible.renderStyle),
      lockedRules: asStringArray(styleBible.lockedRules),
    },
    characters: Array.isArray(record.characters) ? record.characters.slice(0, 100).map((item) => {
      const character = asRecord(item)
      const characterId = asString(character.id)
      if (!characterId) return null
      return {
        id: characterId,
        name: asString(character.name, 'Character'),
        role: asString(character.role),
        ...(asString(character.age) ? { age: asString(character.age) } : {}),
        appearance: asString(character.appearance),
        ...(asString(character.hair) ? { hair: asString(character.hair) } : {}),
        ...(asString(character.clothing) ? { clothing: asString(character.clothing) } : {}),
        ...(asString(character.personality) ? { personality: asString(character.personality) } : {}),
        lockedTraits: asStringArray(character.lockedTraits),
        referenceAssetIds: asStringArray(character.referenceAssetIds),
      } satisfies FilmCharacter
    }).filter((item): item is FilmCharacter => Boolean(item)) : [],
    locations: Array.isArray(record.locations) ? record.locations.slice(0, 100).map((item) => {
      const location = asRecord(item)
      const locationId = asString(location.id)
      if (!locationId) return null
      return {
        id: locationId,
        name: asString(location.name, 'Location'),
        description: asString(location.description),
        lighting: asString(location.lighting),
        palette: asStringArray(location.palette),
        lockedTraits: asStringArray(location.lockedTraits),
        referenceAssetIds: asStringArray(location.referenceAssetIds),
      } satisfies FilmLocation
    }).filter((item): item is FilmLocation => Boolean(item)) : [],
    scenes: Array.isArray(record.scenes) ? record.scenes.slice(0, 200).map((item, index) => {
      const scene = asRecord(item)
      const sceneId = asString(scene.id)
      if (!sceneId) return null
      return {
        id: sceneId,
        order: asNumber(scene.order, index + 1, 1, 10_000),
        title: asString(scene.title, `Scene ${index + 1}`),
        ...(asString(scene.locationId) ? { locationId: asString(scene.locationId) } : {}),
        summary: asString(scene.summary),
        purpose: asString(scene.purpose),
        characterIds: asStringArray(scene.characterIds),
        shotIds: asStringArray(scene.shotIds),
      } satisfies FilmScene
    }).filter((item): item is FilmScene => Boolean(item)) : [],
    shots: Array.isArray(record.shots) ? record.shots.slice(0, 500).map((item, index) => {
      const shot = asRecord(item)
      const shotId = asString(shot.id)
      const sceneId = asString(shot.sceneId)
      if (!shotId || !sceneId) return null
      const status = asString(shot.status) as FilmShotStatus
      const normalizedStatus = SHOT_STATUSES.has(status) ? status : 'planned'
      const restoredStatus: FilmShotStatus = interruptRunning && normalizedStatus === 'generating-image'
        ? (asString(shot.imageAssetId) ? 'image-approved' : 'workflow-ready')
        : interruptRunning && normalizedStatus === 'generating-video'
          ? (asString(shot.imageAssetId) ? 'image-approved' : 'failed')
          : normalizedStatus
      return {
        id: shotId,
        sceneId,
        order: asNumber(shot.order, index + 1, 1, 10_000),
        durationSec: asNumber(shot.durationSec, 5, 1, 120),
        description: asString(shot.description),
        camera: asString(shot.camera),
        action: asString(shot.action),
        emotion: asString(shot.emotion),
        imagePrompt: asString(shot.imagePrompt),
        videoPrompt: asString(shot.videoPrompt),
        ...(asString(shot.negativePrompt) ? { negativePrompt: asString(shot.negativePrompt) } : {}),
        characterIds: asStringArray(shot.characterIds),
        referenceAssetIds: asStringArray(shot.referenceAssetIds),
        workflowNodeIds: asStringArray(shot.workflowNodeIds),
        ...(asString(shot.imageAssetId) ? { imageAssetId: asString(shot.imageAssetId) } : {}),
        ...(asString(shot.videoAssetId) ? { videoAssetId: asString(shot.videoAssetId) } : {}),
        status: restoredStatus,
        attempt: asNumber(shot.attempt, 0, 0, 999),
        imageAttempt: asNumber(shot.imageAttempt, asNumber(shot.attempt, 0, 0, 999), 0, 999),
        videoAttempt: asNumber(shot.videoAttempt, 0, 0, 999),
        ...(shot.review && typeof shot.review === 'object' ? { review: sanitizeAgentValue(shot.review) as ShotReviewResult } : {}),
      } satisfies FilmShot
    }).filter((item): item is FilmShot => Boolean(item)) : [],
    tasks: Array.isArray(record.tasks)
      ? record.tasks.map((task) => normalizeTask(task, interruptRunning)).filter((task): task is AgentTask => Boolean(task))
      : createDefaultAgentTasks(),
    approvals: Array.isArray(record.approvals) ? record.approvals.slice(-100).map((item) => {
      const approval = asRecord(item)
      const approvalId = asString(approval.id)
      const type = asString(approval.type) as AgentApproval['type']
      const status = asString(approval.status) as AgentApproval['status']
      if (!approvalId || !['workflow-patch', 'pilot-image', 'pilot-video', 'batch-generation', 'destructive-change'].includes(type)) return null
      if (!['pending', 'approved', 'rejected', 'cancelled'].includes(status)) return null
      return {
        id: approvalId,
        type,
        title: asString(approval.title),
        description: asString(approval.description),
        status,
        payload: asRecord(sanitizeAgentValue(approval.payload)),
        createdAt: asNumber(approval.createdAt, Date.now(), 0),
        ...(Number.isFinite(Number(approval.resolvedAt)) ? { resolvedAt: Number(approval.resolvedAt) } : {}),
      } satisfies AgentApproval
    }).filter((item): item is AgentApproval => Boolean(item)) : [],
    ...(asString(record.pilotShotId) ? { pilotShotId: asString(record.pilotShotId) } : {}),
    assetMappings: Array.isArray(record.assetMappings) ? record.assetMappings.slice(-1_000).map((item) => {
      const mapping = asRecord(item)
      const mappingId = asString(mapping.id)
      const assetId = asString(mapping.assetId)
      const shotId = asString(mapping.shotId)
      const sceneId = asString(mapping.sceneId)
      const nodeId = asString(mapping.nodeId)
      const kind = asString(mapping.kind) as FilmAssetMapping['kind']
      const mappingStatus = asString(mapping.status) as FilmAssetMapping['status']
      if (!mappingId || !assetId || !shotId || !sceneId || !nodeId || !['image', 'video'].includes(kind)) return null
      if (!['ready', 'approved', 'rejected', 'stale'].includes(mappingStatus)) return null
      const mappingCreatedAt = asNumber(mapping.createdAt, Date.now(), 0)
      return {
        id: mappingId,
        projectId: asString(mapping.projectId, id),
        sceneId,
        shotId,
        workflowId: asString(mapping.workflowId, workflowId),
        nodeId,
        assetId,
        kind,
        attempt: asNumber(mapping.attempt, 1, 1, 999),
        status: mappingStatus,
        createdAt: mappingCreatedAt,
        updatedAt: asNumber(mapping.updatedAt, mappingCreatedAt, 0),
      } satisfies FilmAssetMapping
    }).filter((item): item is FilmAssetMapping => Boolean(item)) : [],
    conversationSummary: asString(record.conversationSummary).slice(0, 12_000),
    staleAssetIds: asStringArray(record.staleAssetIds, 500),
    createdAt,
    updatedAt: asNumber(record.updatedAt, createdAt, 0),
  }
  return project
}

export const sanitizeFilmProjectForPersist = (project: FilmProject): FilmProject | null =>
  normalizeFilmProject(sanitizeAgentValue(project), false)

export const completeProjectTask = (project: FilmProject, type: AgentTaskType): FilmProject => ({
  ...project,
  tasks: project.tasks.map((task) => task.type === type && task.status !== 'completed'
    ? { ...task, status: 'completed', progress: 100, error: undefined }
    : task),
  updatedAt: Date.now(),
})
