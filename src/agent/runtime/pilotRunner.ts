import type { PipelineTask, Workflow, WorkflowEdge, WorkflowNode } from '@/types'
import { runPipeline, stopPipeline, type PipelineCallbacks } from '@/pipeline/runner'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useWorkflowStore } from '@/stores/workflowStore'
import { cacheGenerateOutputs } from '@/lib/assets/outputAssetCache'
import { getAsset, type AssetRecord } from '@/lib/assets/assetStore'
import { useAgentStore, type PilotJob } from '@/agent/stores/agentStore'
import { useFilmProjectStore } from '@/agent/stores/filmProjectStore'
import type { AgentApproval, FilmProject, FilmShot } from '@/agent/schemas/filmProjectSchemas'
import {
  createAssetMapping,
  createPilotReviewApproval,
  findPilotGenerateNode,
  pilotIdempotencyKey,
  setPilotTaskState,
  transitionPilotShot,
  updateAssetMappingStatus,
  type PilotKind,
} from '@/agent/tools/pilotTools'

export interface RunPilotJobInput {
  projectId: string
  shotId: string
  workflowId: string
  generateNodeId: string
  approvalId: string
  idempotencyKey: string
  kind: PilotKind
}

export interface PilotRunResult {
  jobId: string
  status: PilotJob['status']
  idempotencyKey: string
  assetId?: string
  error?: string
  idempotentReplay?: boolean
}

interface PipelineStateSnapshot {
  isRunning: boolean
  activeTaskId: string | null
  tasks: PipelineTask[]
}

export interface PilotRunnerDependencies {
  run: (workflow: Workflow, callbacks?: PipelineCallbacks) => Promise<void>
  stop: () => void
  cacheOutput: (output: unknown) => Promise<unknown>
  readAsset: (assetId: string) => Promise<AssetRecord | null>
  pipelineState: () => PipelineStateSnapshot
  updateWorkflowOutput: (workflowId: string, nodeId: string, output: unknown) => void
}

const defaultDependencies: PilotRunnerDependencies = {
  run: runPipeline,
  stop: stopPipeline,
  cacheOutput: cacheGenerateOutputs,
  readAsset: getAsset,
  pipelineState: () => {
    const state = usePipelineStore.getState()
    return { isRunning: state.isRunning, activeTaskId: state.activeTaskId, tasks: state.tasks }
  },
  updateWorkflowOutput: (workflowId, nodeId, output) => {
    const store = useWorkflowStore.getState()
    const workflow = store.workflows.find((item) => item.id === workflowId)
    if (!workflow) return
    store.updateWorkflow(workflowId, {
      nodes: workflow.nodes.map((node) => {
        if (node.id !== nodeId) return node
        const persistentData = { ...(node.data as Record<string, unknown>) }
        delete persistentData.pilotExecution
        return { ...node, data: { ...persistentData, _output: output, selectedOutputIndex: 0 } as WorkflowNode['data'] }
      }),
    })
  },
}

const inFlightJobs = new Map<string, Promise<PilotRunResult>>()

const filmAgentDebugEnabled = (): boolean => {
  try {
    return typeof localStorage !== 'undefined'
      && (localStorage.getItem('AI_FLOW_DEBUG_FILM_AGENT') === '1' || localStorage.getItem('AI_FLOW_DEBUG') === '1')
  } catch {
    return false
  }
}

const filmAgentDebugLog = (event: 'PilotJobReserved' | 'PilotSubgraph' | 'PilotOutputLinked', payload: Record<string, unknown>): void => {
  if (!filmAgentDebugEnabled()) return
  console.debug(`[FilmAgent][${event}]`, payload)
}

interface PreparedPilotExecution {
  project: FilmProject
  shot: FilmShot
  approval: AgentApproval
  attempt: number
}

const valueAsString = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

const readStringArray = (value: unknown): string[] => Array.isArray(value)
  ? Array.from(new Set(value.map(valueAsString).filter(Boolean)))
  : []

const findApproval = (project: FilmProject, approvalId: string, kind: PilotKind): AgentApproval => {
  const approval = project.approvals.find((item) => item.id === approvalId)
  if (!approval) throw new Error(`Approval not found: ${approvalId}.`)
  if (approval.type !== (kind === 'image' ? 'pilot-image' : 'pilot-video')) {
    throw new Error(`Approval ${approvalId} does not authorize a pilot ${kind} run.`)
  }
  if (approval.status !== 'approved') throw new Error('Provider execution requires an explicitly approved approval card.')
  if (approval.payload.stage !== 'run') throw new Error('A review approval cannot start a provider job.')
  return approval
}

const assertInputMatchesApproval = (input: RunPilotJobInput, approval: AgentApproval): number => {
  const fields: Array<[keyof RunPilotJobInput, string]> = [
    ['projectId', valueAsString(approval.payload.projectId)],
    ['shotId', valueAsString(approval.payload.shotId)],
    ['workflowId', valueAsString(approval.payload.workflowId)],
    ['generateNodeId', valueAsString(approval.payload.generateNodeId)],
    ['idempotencyKey', valueAsString(approval.payload.idempotencyKey)],
  ]
  for (const [field, expected] of fields) {
    if (!expected || input[field] !== expected) throw new Error(`Pilot run ${String(field)} does not match its approval.`)
  }
  if (approval.payload.kind !== input.kind) throw new Error('Pilot run media kind does not match its approval.')
  const attempt = Math.max(1, Math.min(999, Number(approval.payload.attempt) || 1))
  if (input.idempotencyKey !== pilotIdempotencyKey(input.kind, input.projectId, input.shotId, attempt)) {
    throw new Error('Pilot run idempotency key is invalid for this attempt.')
  }
  return attempt
}

const verifyAssetKind = (asset: AssetRecord, kind: PilotKind): boolean =>
  kind === 'video' ? asset.kind === 'video' : asset.kind === 'image'

const PILOT_OUTPUT_STALE_OR_UNCORRELATED = 'PILOT_OUTPUT_STALE_OR_UNCORRELATED'

const collectCandidateAssetIds = (value: unknown, seen = new Set<unknown>(), depth = 0): string[] => {
  if (depth > 8 || value === null || value === undefined || seen.has(value)) return []
  if (typeof value !== 'object') return []
  seen.add(value)
  const record = value as Record<string, unknown>
  const ids: string[] = []
  for (const key of ['assetId', 'imageAssetId', 'videoAssetId']) {
    const assetId = valueAsString(record[key])
    if (assetId) ids.push(assetId)
  }
  for (const key of ['outputs', 'successfulOutputs', 'images']) {
    if (!Array.isArray(record[key])) continue
    for (const item of record[key] as unknown[]) ids.push(...collectCandidateAssetIds(item, seen, depth + 1))
  }
  if (record.result && typeof record.result === 'object') ids.push(...collectCandidateAssetIds(record.result, seen, depth + 1))
  return Array.from(new Set(ids))
}

const resolveVerifiedOutput = async (
  output: unknown,
  kind: PilotKind,
  dependencies: PilotRunnerDependencies,
): Promise<{ output: unknown; asset: AssetRecord }> => {
  let enriched = output
  let ids = collectCandidateAssetIds(enriched)
  for (const assetId of ids) {
    const asset = await dependencies.readAsset(assetId)
    if (asset && verifyAssetKind(asset, kind)) return { output: enriched, asset }
  }
  enriched = await dependencies.cacheOutput(output)
  ids = collectCandidateAssetIds(enriched)
  for (const assetId of ids) {
    const asset = await dependencies.readAsset(assetId)
    if (asset && verifyAssetKind(asset, kind)) return { output: enriched, asset }
  }
  throw new Error(PILOT_OUTPUT_STALE_OR_UNCORRELATED)
}

const syntheticMediaNode = (asset: AssetRecord, shot: FilmShot, index: number): WorkflowNode => ({
  id: `pilot-${shot.id}-reference-${index + 1}`,
  type: 'image',
  position: { x: 0, y: index * 160 },
  data: {
    label: `Pilot reference ${index + 1}`,
    provider: 'chatgpt',
    mediaType: asset.kind === 'video' ? 'video' : 'image',
    assetId: asset.id,
    mediaName: asset.fileName || `pilot-reference-${index + 1}`,
    mediaMimeType: asset.mimeType,
    aspectRatio: 'custom',
    enabled: true,
    agentManaged: true,
    shotId: shot.id,
  } as WorkflowNode['data'],
})

const collectEnabledUpstreamDelays = (workflow: Workflow, targetNodeId: string): {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
} => {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]))
  const included = new Set<string>([targetNodeId])
  const queue = [targetNodeId]
  while (queue.length > 0) {
    const targetId = queue.shift()!
    for (const edge of workflow.edges) {
      if (edge.target !== targetId || included.has(edge.source)) continue
      const source = nodeById.get(edge.source)
      if (!source || source.type !== 'delay' || source.data.enabled === false) continue
      included.add(source.id)
      queue.push(source.id)
    }
  }
  return {
    nodes: workflow.nodes.filter((node) => node.type === 'delay' && included.has(node.id)).map((node) => ({
      ...node,
      data: { ...node.data, enabled: true },
    })),
    edges: workflow.edges.filter((edge) => included.has(edge.source) && included.has(edge.target)),
  }
}

export const buildPilotSubgraph = async (
  workflow: Workflow,
  shot: FilmShot,
  approval: AgentApproval,
  kind: PilotKind,
  dependencies: PilotRunnerDependencies,
): Promise<Workflow> => {
  const target = findPilotGenerateNode(workflow, shot, kind)
  if (target.id !== valueAsString(approval.payload.generateNodeId)) throw new Error('Approved Generate node is no longer the active pilot node.')
  const data = target.data as Record<string, unknown>
  if (kind === 'video') {
    if (!shot.imageAssetId) throw new Error('Pilot video requires imageAssetId.')
    if (shot.status !== 'image-approved') throw new Error(`Pilot video requires image-approved status; current status is ${shot.status}.`)
    if (valueAsString(data.provider) !== 'google-flow') throw new Error('The current workflow runner supports video generation through Google Flow only.')
    if (!['frame', 'ingredient'].includes(valueAsString(data.flowVideoMode))) throw new Error('Google Flow pilot video requires flowVideoMode frame or ingredient.')
  } else if (!['workflow-ready', 'image-ready', 'image-approved', 'approved', 'failed'].includes(shot.status)) {
    throw new Error(`Pilot image requires workflow-ready or explicit regeneration state; current status is ${shot.status}.`)
  }

  const referenceIds = kind === 'video' ? [shot.imageAssetId!] : readStringArray(approval.payload.referenceAssetIds)
  const referenceAssets: AssetRecord[] = []
  for (const assetId of referenceIds) {
    const asset = await dependencies.readAsset(assetId)
    if (!asset) throw new Error(`Reference asset is missing from IndexedDB: ${assetId}.`)
    if (asset.kind !== 'image') throw new Error(`Pilot ${kind} reference ${assetId} must be an image asset.`)
    referenceAssets.push(asset)
  }

  const promptId = `pilot-${shot.id}-${kind}-prompt`
  const prompt = valueAsString(approval.payload.prompt)
  if (!prompt) throw new Error(`Approved pilot ${kind} prompt is empty.`)
  const promptNode: WorkflowNode = {
    id: promptId,
    type: 'prompt',
    position: { x: 300, y: 0 },
    data: {
      label: `Pilot ${kind} prompt`,
      prompt,
      provider: data.provider,
      model: data.model,
      enabled: true,
      agentManaged: true,
      shotId: shot.id,
    } as WorkflowNode['data'],
  }
  const referenceNodes = referenceAssets.map((asset, index) => syntheticMediaNode(asset, shot, index))
  const upstreamDelays = collectEnabledUpstreamDelays(workflow, target.id)
  const generateNode: WorkflowNode = {
    ...target,
    position: { x: 700, y: 0 },
    data: {
      ...target.data,
      prompt: undefined,
      _output: undefined,
      quantity: 1,
      enabled: true,
    },
  }
  const edges: WorkflowEdge[] = [
    {
      id: `pilot-${shot.id}-${kind}-prompt-edge`,
      source: promptId,
      target: generateNode.id,
      sourceHandle: 'output_1',
      targetHandle: 'input_2',
    },
    ...referenceNodes.map((node, index) => ({
      id: `pilot-${shot.id}-${kind}-reference-edge-${index + 1}`,
      source: node.id,
      target: generateNode.id,
      sourceHandle: 'output_1',
      targetHandle: 'input_1',
    })),
    ...upstreamDelays.edges.map((edge) => ({ ...edge })),
  ]
  const nodes = [promptNode, ...referenceNodes, ...upstreamDelays.nodes, generateNode]
  const generateCount = nodes.filter((node) => node.type === 'generate').length
  if (generateCount !== 1) throw new Error(`Pilot runtime slice must contain exactly one Generate node; found ${generateCount}.`)
  return {
    ...workflow,
    name: `${workflow.name} · Pilot ${kind} ${shot.id}`,
    nodes,
    edges,
    updatedAt: Date.now(),
  }
}

const restoreStatusAfterFailure = (shot: FilmShot, kind: PilotKind): FilmShot['status'] => {
  if (kind === 'video') return 'image-approved'
  if (shot.imageAssetId && ['image-approved', 'approved'].includes(shot.status)) return 'image-approved'
  return 'failed'
}

const preparePilotExecution = (input: RunPilotJobInput, workflow: Workflow): PreparedPilotExecution => {
  const project = useFilmProjectStore.getState().projects.find((item) => item.id === input.projectId)
  if (!project || project.workflowId !== input.workflowId || workflow.id !== input.workflowId) {
    throw new Error('Pilot FilmProject does not match the workflow.')
  }
  const shot = project.shots.find((item) => item.id === input.shotId)
  if (!shot || project.pilotShotId !== shot.id) throw new Error('Pilot shot is missing or no longer selected.')
  const approval = findApproval(project, input.approvalId, input.kind)
  const attempt = assertInputMatchesApproval(input, approval)
  const mode = useAgentStore.getState().modesByWorkflow[input.workflowId] || 'run-with-approval'
  if (mode !== 'run-with-approval' && mode !== 'auto') throw new Error(`${mode} mode does not permit provider execution.`)
  return { project, shot, approval, attempt }
}

const reservePilotJob = (input: RunPilotJobInput, prepared: PreparedPilotExecution): PilotJob => {
  const startedAt = Date.now()
  const job: PilotJob = {
    id: `pilot-job-${input.kind}-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    idempotencyKey: input.idempotencyKey,
    projectId: prepared.project.id,
    shotId: prepared.shot.id,
    workflowId: input.workflowId,
    nodeId: input.generateNodeId,
    generateNodeId: input.generateNodeId,
    approvalId: input.approvalId,
    kind: input.kind,
    attempt: prepared.attempt,
    status: 'queued',
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  }
  useAgentStore.getState().upsertPilotJob(job)
  filmAgentDebugLog('PilotJobReserved', {
    jobId: job.id,
    shotId: job.shotId,
    nodeId: job.nodeId,
    kind: job.kind,
    attempt: job.attempt,
    idempotencyKey: job.idempotencyKey,
  })
  return job
}

const failPilot = (
  projectId: string,
  shotBeforeRun: FilmShot,
  kind: PilotKind,
  jobId: string,
  error: string,
): PilotRunResult => {
  const filmStore = useFilmProjectStore.getState()
  const project = filmStore.projects.find((item) => item.id === projectId)
  if (project) {
    let next = {
      ...project,
      shots: project.shots.map((shot) => shot.id === shotBeforeRun.id
        ? { ...shot, status: restoreStatusAfterFailure(shotBeforeRun, kind) }
        : shot),
    }
    next = setPilotTaskState(next, kind, 'failed', { error })
    filmStore.upsertProject(next)
  }
  useAgentStore.getState().updatePilotJob(jobId, { status: 'failed', error, completedAt: Date.now() })
  const job = useAgentStore.getState().pilotJobs.find((item) => item.id === jobId)
  return { jobId, status: 'failed', idempotencyKey: job?.idempotencyKey || '', error }
}

const executeReservedPilot = async (
  input: RunPilotJobInput,
  workflow: Workflow,
  dependencies: PilotRunnerDependencies,
  prepared: PreparedPilotExecution,
  job: PilotJob,
): Promise<PilotRunResult> => {
  const filmStore = useFilmProjectStore.getState()
  const agentStore = useAgentStore.getState()
  const { project, shot, approval, attempt } = prepared
  let runtimeWorkflow: Workflow
  try {
    runtimeWorkflow = await buildPilotSubgraph(workflow, shot, approval, input.kind, dependencies)
  } catch (error) {
    return failPilot(project.id, shot, input.kind, job.id, error instanceof Error ? error.message : 'Pilot subgraph build failed.')
  }
  const generateNodeIds = runtimeWorkflow.nodes.filter((node) => node.type === 'generate').map((node) => node.id)
  filmAgentDebugLog('PilotSubgraph', {
    nodeIds: runtimeWorkflow.nodes.map((node) => node.id),
    edgeIds: runtimeWorkflow.edges.map((edge) => edge.id),
    generateNodeIds,
  })
  const transitionOptions = { allowRegeneration: Boolean(input.kind === 'image' ? shot.imageAssetId : shot.videoAssetId) }
  let runningProject = transitionPilotShot(project, shot.id, input.kind === 'image' ? 'generating-image' : 'generating-video', transitionOptions)
  runningProject = {
    ...runningProject,
    shots: runningProject.shots.map((item) => item.id === shot.id ? {
      ...item,
      attempt: Math.max(item.attempt, attempt),
      ...(input.kind === 'image' ? { imageAttempt: attempt } : { videoAttempt: attempt }),
    } : item),
  }
  runningProject = setPilotTaskState(runningProject, input.kind, 'queued')
  filmStore.upsertProject(runningProject)

  let output: unknown
  let outputTimestamp = 0
  let nodeError = ''
  const beforeTaskIds = new Set(dependencies.pipelineState().tasks.map((task) => task.id))
  const runPromise = dependencies.run(runtimeWorkflow, {
    onNodeStart: (nodeId) => {
      if (nodeId !== input.generateNodeId) return
      useAgentStore.getState().updatePilotJob(job.id, { status: 'running' })
      const current = useFilmProjectStore.getState().projects.find((item) => item.id === project.id)
      if (current) useFilmProjectStore.getState().upsertProject(setPilotTaskState(current, input.kind, 'running'))
    },
    onNodeComplete: (nodeId, result) => {
      if (nodeId !== input.generateNodeId) return
      output = result
      outputTimestamp = Date.now()
      useAgentStore.getState().updatePilotJob(job.id, { status: 'waiting-output' })
      const current = useFilmProjectStore.getState().projects.find((item) => item.id === project.id)
      if (current) useFilmProjectStore.getState().upsertProject(setPilotTaskState(current, input.kind, 'waiting-output'))
    },
    onNodeFail: (nodeId, error) => {
      if (nodeId === input.generateNodeId) nodeError = error
    },
  })
  const runnerTask = dependencies.pipelineState().tasks.find((task) => !beforeTaskIds.has(task.id))
  if (runnerTask) agentStore.updatePilotJob(job.id, { runnerTaskId: runnerTask.id })
  try {
    await runPromise
  } catch (error) {
    return failPilot(project.id, shot, input.kind, job.id, error instanceof Error ? error.message : 'Pilot pipeline execution failed.')
  }

  const latestJob = useAgentStore.getState().pilotJobs.find((item) => item.id === job.id)
  if (latestJob?.cancellationRequested || latestJob?.status === 'cancelled') {
    return { jobId: job.id, status: 'cancelled', idempotencyKey: input.idempotencyKey }
  }
  const completedTask = runnerTask
    ? dependencies.pipelineState().tasks.find((task) => task.id === runnerTask.id)
    : null
  if (nodeError || completedTask?.status === 'failed') {
    const error = nodeError || completedTask?.errors?.[0]?.message || 'Pilot Generate node failed.'
    return failPilot(project.id, shot, input.kind, job.id, error)
  }
  if (output === undefined || outputTimestamp < job.startedAt) {
    return failPilot(project.id, shot, input.kind, job.id, PILOT_OUTPUT_STALE_OR_UNCORRELATED)
  }

  try {
    const verified = await resolveVerifiedOutput(output, input.kind, dependencies)
    const current = useFilmProjectStore.getState().projects.find((item) => item.id === project.id)
    const currentShot = current?.shots.find((item) => item.id === shot.id)
    if (!current || !currentShot) throw new Error('Pilot project disappeared before asset linking.')
    let linkedProject = current
    const previousAssetId = input.kind === 'image' ? currentShot.imageAssetId : currentShot.videoAssetId
    if (previousAssetId && previousAssetId !== verified.asset.id) linkedProject = updateAssetMappingStatus(linkedProject, previousAssetId, 'stale')
    const mapping = createAssetMapping(linkedProject, workflow.id, input.generateNodeId, currentShot, input.kind, verified.asset.id, attempt)
    linkedProject = {
      ...linkedProject,
      shots: linkedProject.shots.map((item) => item.id === shot.id ? {
        ...item,
        ...(input.kind === 'image' ? { imageAssetId: verified.asset.id } : { videoAssetId: verified.asset.id }),
        status: input.kind === 'image' ? 'image-ready' as const : 'video-ready' as const,
      } : item),
      assetMappings: [...linkedProject.assetMappings.filter((item) => item.id !== mapping.id), mapping],
    }
    linkedProject = setPilotTaskState(linkedProject, input.kind, 'completed', { result: { assetId: verified.asset.id }, progress: 100 })
    linkedProject = createPilotReviewApproval(linkedProject, shot.id, input.kind, verified.asset.id, valueAsString(approval.payload.prompt))
    filmStore.upsertProject(linkedProject)
    dependencies.updateWorkflowOutput(workflow.id, input.generateNodeId, verified.output)
    const completedAt = Date.now()
    agentStore.updatePilotJob(job.id, {
      status: 'completed',
      outputAssetId: verified.asset.id,
      assetId: verified.asset.id,
      completedAt,
      error: undefined,
    })
    filmAgentDebugLog('PilotOutputLinked', {
      jobId: job.id,
      nodeId: input.generateNodeId,
      assetId: verified.asset.id,
      assetKind: verified.asset.kind,
      startedAt: job.startedAt,
      outputTimestamp,
    })
    return { jobId: job.id, status: 'completed', idempotencyKey: input.idempotencyKey, assetId: verified.asset.id }
  } catch (error) {
    return failPilot(project.id, shot, input.kind, job.id, error instanceof Error ? error.message : 'Pilot asset linking failed.')
  }
}

export const runPilotJob = (
  input: RunPilotJobInput,
  workflowOverride?: Workflow,
  dependencyOverrides: Partial<PilotRunnerDependencies> = {},
): Promise<PilotRunResult> => {
  const existing = useAgentStore.getState().getPilotJobByKey(input.idempotencyKey)
  if (existing?.status === 'completed') {
    return Promise.resolve({
      jobId: existing.id,
      status: existing.status,
      idempotencyKey: existing.idempotencyKey,
      assetId: existing.outputAssetId || existing.assetId,
      idempotentReplay: true,
    })
  }
  if (existing && ['queued', 'running', 'waiting-output'].includes(existing.status)) {
    const active = inFlightJobs.get(input.idempotencyKey)
    return active || Promise.resolve({ jobId: existing.id, status: existing.status, idempotencyKey: existing.idempotencyKey, assetId: existing.outputAssetId || existing.assetId, idempotentReplay: true })
  }
  if (existing && ['failed', 'cancelled', 'interrupted'].includes(existing.status)) {
    return Promise.reject(new Error(`Attempt ${existing.attempt} is ${existing.status}; regeneration requires a new approved attempt.`))
  }
  const active = inFlightJobs.get(input.idempotencyKey)
  if (active) return active
  const workflow = workflowOverride || useWorkflowStore.getState().workflows.find((item) => item.id === input.workflowId)
  if (!workflow) return Promise.reject(new Error(`Workflow not found: ${input.workflowId}.`))
  const dependencies = { ...defaultDependencies, ...dependencyOverrides }
  let prepared: PreparedPilotExecution
  try {
    prepared = preparePilotExecution(input, workflow)
    if (dependencies.pipelineState().isRunning) throw new Error('Another workflow is already running. Wait for it to finish before starting the pilot.')
  } catch (error) {
    return Promise.reject(error)
  }
  // Reservation is synchronous: a second click observes this queued job
  // before any reference lookup or provider runner await can occur.
  const job = reservePilotJob(input, prepared)
  const promise = executeReservedPilot(input, workflow, dependencies, prepared, job).finally(() => {
    if (inFlightJobs.get(input.idempotencyKey) === promise) inFlightJobs.delete(input.idempotencyKey)
  })
  inFlightJobs.set(input.idempotencyKey, promise)
  return promise
}

export const getPilotJobStatus = (idOrKey: string): PilotJob | null =>
  useAgentStore.getState().pilotJobs.find((job) => job.id === idOrKey || job.idempotencyKey === idOrKey) || null

export const cancelPilotJob = (jobId: string, dependencyOverrides: Partial<PilotRunnerDependencies> = {}): PilotRunResult => {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides }
  const job = useAgentStore.getState().pilotJobs.find((item) => item.id === jobId)
  if (!job) throw new Error(`Pilot job not found: ${jobId}.`)
  if (!['queued', 'running', 'waiting-output'].includes(job.status)) {
    return { jobId: job.id, status: job.status, idempotencyKey: job.idempotencyKey, assetId: job.outputAssetId || job.assetId, idempotentReplay: true }
  }
  const activeTaskId = dependencies.pipelineState().activeTaskId
  if (!job.runnerTaskId || activeTaskId !== job.runnerTaskId) {
    throw new Error('This pilot job is not the active local runner job; remote cancellation was not claimed.')
  }
  useAgentStore.getState().updatePilotJob(job.id, {
    cancellationRequested: true,
    error: 'Stopping the active local runner. The provider may already have accepted the request.',
  })
  dependencies.stop()
  useAgentStore.getState().updatePilotJob(job.id, {
    status: 'cancelled',
    error: 'Local runner stopped. A provider request already accepted remotely may still finish.',
    completedAt: Date.now(),
  })
  const project = useFilmProjectStore.getState().projects.find((item) => item.id === job.projectId)
  if (project) {
    const shot = project.shots.find((item) => item.id === job.shotId)
    if (shot) {
      let next = {
        ...project,
        shots: project.shots.map((item) => item.id === shot.id
          ? { ...item, status: restoreStatusAfterFailure(shot, job.kind) }
          : item),
      }
      next = setPilotTaskState(next, job.kind, 'cancelled', { error: 'Local runner cancellation requested.' })
      useFilmProjectStore.getState().upsertProject(next)
    }
  }
  return { jobId: job.id, status: 'cancelled', idempotencyKey: job.idempotencyKey }
}
