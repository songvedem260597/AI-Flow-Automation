import type { Workflow, WorkflowNode } from '@/types'
import {
  createAgentId,
  type AgentApproval,
  type AgentTask,
  type FilmAssetMapping,
  type FilmProject,
  type FilmShot,
  type FilmShotStatus,
} from '@/agent/schemas/filmProjectSchemas'

export type PilotKind = 'image' | 'video'

export interface PilotSelectionResult {
  shotId: string
  reason: string
  requiredReferences: string[]
  estimatedImageJobs: 1
  estimatedVideoJobs: 1
}

const PILOT_TASK_TYPE: Record<PilotKind, AgentTask['type']> = {
  image: 'pilot-image',
  video: 'pilot-video',
}

const PILOT_REVIEW_TASK_TYPE: Record<PilotKind, AgentTask['type']> = {
  image: 'pilot-image-review',
  video: 'pilot-video-review',
}

const TRANSITIONS: Record<FilmShotStatus, ReadonlySet<FilmShotStatus>> = {
  planned: new Set(['workflow-ready']),
  'workflow-ready': new Set(['generating-image', 'failed']),
  'generating-image': new Set(['image-ready', 'workflow-ready', 'failed']),
  'image-ready': new Set(['image-approved', 'generating-image', 'workflow-ready', 'failed']),
  'image-approved': new Set(['generating-image', 'generating-video', 'failed']),
  'generating-video': new Set(['video-ready', 'image-approved', 'failed']),
  'video-ready': new Set(['approved', 'generating-video', 'image-approved', 'failed']),
  'needs-review': new Set(['image-approved', 'approved', 'generating-image', 'generating-video', 'failed']),
  approved: new Set(['generating-image', 'generating-video']),
  failed: new Set(['workflow-ready', 'generating-image', 'image-approved', 'generating-video']),
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

const collectShotReferences = (project: FilmProject, shot: FilmShot): string[] => {
  const refs = new Set(shot.referenceAssetIds)
  for (const character of project.characters) {
    if (shot.characterIds.includes(character.id)) character.referenceAssetIds.forEach((assetId) => refs.add(assetId))
  }
  const scene = project.scenes.find((item) => item.id === shot.sceneId)
  const location = scene?.locationId ? project.locations.find((item) => item.id === scene.locationId) : undefined
  location?.referenceAssetIds.forEach((assetId) => refs.add(assetId))
  return Array.from(refs).filter(Boolean)
}

const pilotScore = (project: FilmProject, shot: FilmShot): number => {
  const characterRoles = project.characters
    .filter((character) => shot.characterIds.includes(character.id))
    .map((character) => `${character.role} ${character.name}`.toLowerCase())
    .join(' ')
  const action = `${shot.action} ${shot.description}`.toLowerCase()
  const complexAction = /explosion|battle|fight|chase|crowd|transform|crash|earthquake|army|hundreds|thousands/.test(action)
  return (shot.characterIds.length > 0 ? 25 : 0)
    + (/(?:lead|main|hero|protagonist|chính)/.test(characterRoles) ? 35 : 0)
    + (shot.imagePrompt.trim() ? 15 : 0)
    + (project.styleBible.visualIdentity.trim() || project.brief.visualStyle.trim() ? 15 : 0)
    + (shot.camera.trim() ? 5 : 0)
    - (complexAction ? 30 : 0)
    - Math.max(0, shot.characterIds.length - 2) * 5
}

export const selectPilotShot = (project: FilmProject, requestedShotId?: string): {
  project: FilmProject
  selection: PilotSelectionResult
} => {
  if (project.shots.length === 0) throw new Error('Create at least one structured shot before selecting a pilot.')
  const requested = text(requestedShotId)
  const shot = requested
    ? project.shots.find((item) => item.id === requested)
    : [...project.shots].sort((left, right) => {
      const score = pilotScore(project, right) - pilotScore(project, left)
      if (score !== 0) return score
      const leftScene = project.scenes.find((scene) => scene.id === left.sceneId)?.order ?? Number.MAX_SAFE_INTEGER
      const rightScene = project.scenes.find((scene) => scene.id === right.sceneId)?.order ?? Number.MAX_SAFE_INTEGER
      return leftScene - rightScene || left.order - right.order
    })[0]
  if (!shot) throw new Error(`Pilot shot not found: ${requested}.`)
  const requiredReferences = collectShotReferences(project, shot)
  const reason = requested
    ? `${shot.id} was explicitly selected as the pilot shot.`
    : `${shot.id} is the strongest representative shot with clear visual direction and manageable action complexity.`
  const nextProject = ensurePilotTasks({ ...project, pilotShotId: shot.id }, shot.id)
  return {
    project: nextProject,
    selection: {
      shotId: shot.id,
      reason,
      requiredReferences,
      estimatedImageJobs: 1,
      estimatedVideoJobs: 1,
    },
  }
}

export const ensurePilotTasks = (project: FilmProject, shotId: string): FilmProject => {
  const types = new Set<AgentTask['type']>([
    'pilot-image', 'pilot-image-review', 'pilot-video', 'pilot-video-review',
  ])
  const tasks = project.tasks.map((task) => types.has(task.type)
    ? { ...task, shotId, progressMode: 'status' as const }
    : task)
  const required: Array<{ type: AgentTask['type']; title: string; dependsOnType?: AgentTask['type'] }> = [
    { type: 'pilot-image', title: 'Generate pilot shot image', dependsOnType: 'workflow' },
    { type: 'pilot-image-review', title: 'Review pilot image', dependsOnType: 'pilot-image' },
    { type: 'pilot-video', title: 'Generate pilot shot video', dependsOnType: 'pilot-image-review' },
    { type: 'pilot-video-review', title: 'Review pilot video before batch', dependsOnType: 'pilot-video' },
  ]
  for (const definition of required) {
    if (tasks.some((task) => task.type === definition.type)) continue
    const dependency = definition.dependsOnType ? tasks.find((task) => task.type === definition.dependsOnType)?.id : undefined
    tasks.push({
      id: `pilot-task-${shotId}-${definition.type}`,
      type: definition.type,
      title: definition.title,
      status: 'pending',
      dependsOn: dependency ? [dependency] : [],
      progress: 0,
      progressMode: 'status',
      shotId,
    })
  }
  return { ...project, pilotShotId: shotId, tasks, updatedAt: Date.now() }
}

export const transitionPilotShot = (
  project: FilmProject,
  shotId: string,
  nextStatus: FilmShotStatus,
  options: { allowRegeneration?: boolean; error?: string } = {},
): FilmProject => {
  const shot = project.shots.find((item) => item.id === shotId)
  if (!shot) throw new Error(`Shot not found: ${shotId}.`)
  if (shot.status === nextStatus) return project
  if (!TRANSITIONS[shot.status].has(nextStatus)) {
    throw new Error(`Invalid pilot transition: ${shot.status} -> ${nextStatus}.`)
  }
  if (nextStatus === 'generating-video' && (!shot.imageAssetId || !['image-approved', 'video-ready', 'approved', 'failed'].includes(shot.status))) {
    throw new Error('Pilot video requires an approved image asset.')
  }
  if (nextStatus === 'generating-image' && shot.imageAssetId && ['image-approved', 'approved'].includes(shot.status) && !options.allowRegeneration) {
    throw new Error('Regenerating an approved image requires explicit user approval.')
  }
  if (nextStatus === 'generating-video' && shot.videoAssetId && shot.status === 'approved' && !options.allowRegeneration) {
    throw new Error('Regenerating an approved video requires explicit user approval.')
  }
  return {
    ...project,
    shots: project.shots.map((item) => item.id === shotId ? { ...item, status: nextStatus } : item),
    updatedAt: Date.now(),
  }
}

export const findPilotGenerateNode = (workflow: Workflow, shot: FilmShot, kind: PilotKind): WorkflowNode => {
  const expectedMediaType = kind === 'video' ? 'video' : 'image'
  const candidates = workflow.nodes.filter((node) => {
    if (node.type !== 'generate' || (node.data as Record<string, unknown>).enabled === false) return false
    const data = node.data as Record<string, unknown>
    const belongsToShot = shot.workflowNodeIds.includes(node.id) || text(data.shotId) === shot.id
    const mediaType = text(data.mediaType) || 'image'
    return belongsToShot && mediaType === expectedMediaType
  })
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one enabled ${kind} Generate node for ${shot.id}; found ${candidates.length}.`)
  }
  return candidates[0]
}

export const pilotIdempotencyKey = (kind: PilotKind, projectId: string, shotId: string, attempt: number): string =>
  `pilot:${kind}:${projectId}:${shotId}:${attempt}`

const updatePilotTask = (
  project: FilmProject,
  kind: PilotKind,
  review: boolean,
  patch: Partial<AgentTask>,
): FilmProject => {
  const type = review ? PILOT_REVIEW_TASK_TYPE[kind] : PILOT_TASK_TYPE[kind]
  return {
    ...project,
    tasks: project.tasks.map((task) => task.type === type
      ? { ...task, ...patch, id: task.id, type: task.type, progressMode: 'status' as const }
      : task),
    updatedAt: Date.now(),
  }
}

export const setPilotTaskState = (
  project: FilmProject,
  kind: PilotKind,
  status: AgentTask['status'],
  options: { review?: boolean; error?: string; result?: unknown; progress?: number } = {},
): FilmProject => updatePilotTask(project, kind, Boolean(options.review), {
  status,
  progress: options.progress ?? (status === 'completed' ? 100 : status === 'running' ? 35 : status === 'waiting-output' ? 70 : 0),
  error: options.error,
  result: options.result,
})

const upsertApproval = (project: FilmProject, approval: AgentApproval): FilmProject => ({
  ...project,
  approvals: [...project.approvals.filter((item) => item.id !== approval.id), approval],
  updatedAt: Date.now(),
})

export const createPilotRunApproval = (
  project: FilmProject,
  workflow: Workflow,
  shotId: string,
  kind: PilotKind,
  promptOverride?: string,
): FilmProject => {
  const shot = project.shots.find((item) => item.id === shotId)
  if (!shot) throw new Error(`Shot not found: ${shotId}.`)
  if (kind === 'image' && !['workflow-ready', 'image-ready', 'image-approved', 'approved', 'failed'].includes(shot.status)) {
    throw new Error(`Pilot image approval cannot be created while shot is ${shot.status}.`)
  }
  if (kind === 'video' && (shot.status !== 'image-approved' || !shot.imageAssetId)) {
    throw new Error('Pilot video approval requires an approved pilot image.')
  }
  const node = findPilotGenerateNode(workflow, shot, kind)
  const data = node.data as Record<string, unknown>
  const attempt = (kind === 'image' ? shot.imageAttempt : shot.videoAttempt) + 1
  const idempotencyKey = pilotIdempotencyKey(kind, project.id, shot.id, attempt)
  const prompt = text(promptOverride) || (kind === 'image' ? shot.imagePrompt : shot.videoPrompt) || shot.description
  if (!prompt) throw new Error(`Pilot ${kind} prompt is empty.`)
  const existing = project.approvals.find((approval) => (
    approval.status === 'pending'
    && approval.type === (kind === 'image' ? 'pilot-image' : 'pilot-video')
    && approval.payload.stage === 'run'
    && approval.payload.idempotencyKey === idempotencyKey
  ))
  if (existing) return setPilotTaskState(project, kind, 'waiting-approval')
  const approval: AgentApproval = {
    id: createAgentId(`approval-pilot-${kind}`),
    type: kind === 'image' ? 'pilot-image' : 'pilot-video',
    title: `Run pilot ${kind} ${shot.id}`,
    description: `Submit exactly one ${kind} Generate node after approval.`,
    status: 'pending',
    payload: {
      stage: 'run',
      projectId: project.id,
      shotId: shot.id,
      workflowId: workflow.id,
      generateNodeId: node.id,
      kind,
      prompt,
      provider: text(data.provider),
      model: text(data.model),
      ratio: text(data.aspectRatio) || project.brief.aspectRatio,
      referenceAssetIds: kind === 'video' && shot.imageAssetId
        ? [shot.imageAssetId]
        : collectShotReferences(project, shot),
      estimatedJobs: 1,
      attempt,
      idempotencyKey,
    },
    createdAt: Date.now(),
  }
  return setPilotTaskState(upsertApproval(project, approval), kind, 'waiting-approval')
}

export const createPilotReviewApproval = (
  project: FilmProject,
  shotId: string,
  kind: PilotKind,
  assetId: string,
  prompt: string,
): FilmProject => {
  const shot = project.shots.find((item) => item.id === shotId)
  if (!shot) throw new Error(`Shot not found: ${shotId}.`)
  const attempt = kind === 'image' ? shot.imageAttempt : shot.videoAttempt
  const existing = project.approvals.find((approval) => (
    approval.status === 'pending'
    && approval.type === (kind === 'image' ? 'pilot-image' : 'pilot-video')
    && approval.payload.stage === 'review'
    && approval.payload.assetId === assetId
  ))
  if (existing) return setPilotTaskState(project, kind, 'waiting-approval', { review: true })
  const approval: AgentApproval = {
    id: createAgentId(`approval-review-${kind}`),
    type: kind === 'image' ? 'pilot-image' : 'pilot-video',
    title: `Review pilot ${kind} ${shot.id}`,
    description: `Review the cached ${kind} asset before continuing production.`,
    status: 'pending',
    payload: { stage: 'review', projectId: project.id, shotId, kind, assetId, prompt, attempt },
    createdAt: Date.now(),
  }
  return setPilotTaskState(upsertApproval(project, approval), kind, 'waiting-approval', { review: true })
}

export const updateAssetMappingStatus = (
  project: FilmProject,
  assetId: string,
  status: FilmAssetMapping['status'],
): FilmProject => ({
  ...project,
  assetMappings: project.assetMappings.map((mapping) => mapping.assetId === assetId
    ? { ...mapping, status, updatedAt: Date.now() }
    : mapping),
  staleAssetIds: status === 'stale' || status === 'rejected'
    ? Array.from(new Set([...project.staleAssetIds, assetId]))
    : project.staleAssetIds.filter((id) => id !== assetId),
  updatedAt: Date.now(),
})

export const createAssetMapping = (
  project: FilmProject,
  workflowId: string,
  nodeId: string,
  shot: FilmShot,
  kind: PilotKind,
  assetId: string,
  attempt: number,
): FilmAssetMapping => ({
  id: createAgentId(`mapping-${kind}`),
  projectId: project.id,
  sceneId: shot.sceneId,
  shotId: shot.id,
  workflowId,
  nodeId,
  assetId,
  kind,
  attempt,
  status: 'ready',
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

export type PilotReviewAction = 'approve' | 'reject' | 'regenerate'

export const resolvePilotReview = (
  project: FilmProject,
  workflow: Workflow,
  approvalId: string,
  action: PilotReviewAction,
  promptOverride?: string,
): FilmProject => {
  const approval = project.approvals.find((item) => item.id === approvalId)
  if (!approval || approval.status !== 'pending' || approval.payload.stage !== 'review') {
    throw new Error('Pilot review approval is no longer pending.')
  }
  const kind: PilotKind = approval.payload.kind === 'video' ? 'video' : 'image'
  const shotId = text(approval.payload.shotId)
  const assetId = text(approval.payload.assetId)
  if (!shotId || !assetId) throw new Error('Pilot review is missing shotId or assetId.')
  let next: FilmProject = {
    ...project,
    approvals: project.approvals.map((item) => item.id === approvalId
      ? { ...item, status: action === 'approve' ? 'approved' as const : 'rejected' as const, resolvedAt: Date.now() }
      : item),
  }

  if (action === 'approve') {
    next = updateAssetMappingStatus(next, assetId, 'approved')
    next = transitionPilotShot(next, shotId, kind === 'image' ? 'image-approved' : 'approved')
    next = setPilotTaskState(next, kind, 'completed', { review: true, result: { assetId }, progress: 100 })
    return kind === 'image' ? createPilotRunApproval(next, workflow, shotId, 'video') : next
  }

  next = updateAssetMappingStatus(next, assetId, action === 'reject' ? 'rejected' : 'stale')
  if (action === 'reject') {
    next = transitionPilotShot(next, shotId, kind === 'image' ? 'workflow-ready' : 'image-approved')
    return setPilotTaskState(next, kind, 'pending', { review: true, error: `Pilot ${kind} rejected. The cached asset was retained.` })
  }

  if (kind === 'video') next = transitionPilotShot(next, shotId, 'image-approved')
  return createPilotRunApproval(next, workflow, shotId, kind, text(promptOverride) || text(approval.payload.prompt))
}
