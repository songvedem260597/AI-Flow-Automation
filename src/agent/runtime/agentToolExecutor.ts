import type { AIProvider, Workflow } from '@/types'
import { listAssets, getAsset } from '@/lib/assets/assetStore'
import { useAgentStore } from '@/agent/stores/agentStore'
import { useFilmProjectStore } from '@/agent/stores/filmProjectStore'
import { AGENT_TOOL_REGISTRY } from '@/agent/runtime/agentToolRegistry'
import {
  type AgentToolCall,
  type AgentToolResult,
  type WorkflowPatch,
} from '@/agent/schemas/agentToolSchemas'
import type { AgentMode, FilmProject } from '@/agent/schemas/filmProjectSchemas'
import {
  createFilmProjectFromTool,
  createScenesFromTool,
  createShotsFromTool,
  markShotStatusFromTool,
  updateFilmBriefFromTool,
  updateShotFromTool,
  upsertCharacterFromTool,
  upsertLocationFromTool,
} from '@/agent/tools/filmTools'
import { createApprovalFromTool } from '@/agent/tools/approvalTools'
import { compactWorkflowContext, createShotPipelinePatch } from '@/agent/tools/workflowTools'
import {
  createPilotRunApproval,
  selectPilotShot,
  type PilotKind,
} from '@/agent/tools/pilotTools'
import {
  cancelPilotJob,
  getPilotJobStatus,
  runPilotJob,
} from '@/agent/runtime/pilotRunner'

export interface AgentToolExecutionContext {
  workflow: Workflow
  mode: AgentMode
  /** undefined keeps legacy workflow fallback; null is an explicitly fresh conversation. */
  projectId?: string | null
  /** Keeps idempotent tool results isolated between separate conversations. */
  scopeId?: string
}

export interface AgentToolExecutionSummary {
  results: AgentToolResult[]
  project: FilmProject | null
  pendingPatch: WorkflowPatch | null
  validationErrors: string[]
}

const stringValue = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const parseProvider = (value: unknown): AIProvider | undefined => {
  const provider = stringValue(value) as AIProvider
  return ['google-flow', 'chatgpt', 'grok', 'claude', 'gemini'].includes(provider) ? provider : undefined
}

const validateToolValue = (value: unknown, schema: Record<string, unknown>, path = 'arguments', depth = 0): string | null => {
  if (depth > 6) return null
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}.`
  if ('const' in schema && value !== schema.const) return `${path} must equal ${String(schema.const)}.`
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object.`
    const record = value as Record<string, unknown>
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof required === 'string' && (record[required] === undefined || record[required] === null || record[required] === '')) {
        return `${path}.${required} is required.`
      }
    }
    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties as Record<string, unknown>
      : {}
    for (const [key, childSchema] of Object.entries(properties)) {
      if (record[key] === undefined || !childSchema || typeof childSchema !== 'object') continue
      const error = validateToolValue(record[key], childSchema as Record<string, unknown>, `${path}.${key}`, depth + 1)
      if (error) return error
    }
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array.`
    if (schema.items && typeof schema.items === 'object') {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateToolValue(value[index], schema.items as Record<string, unknown>, `${path}[${index}]`, depth + 1)
        if (error) return error
      }
    }
  }
  if (schema.type === 'string' && typeof value !== 'string') return `${path} must be a string.`
  if (schema.type === 'number' && !Number.isFinite(Number(value))) return `${path} must be a number.`
  return null
}

const projectSummary = (project: FilmProject) => ({
  projectId: project.id,
  title: project.title,
  briefReady: Boolean(project.brief.logline),
  characters: project.characters.length,
  locations: project.locations.length,
  scenes: project.scenes.length,
  shots: project.shots.length,
  tasks: project.tasks.map((task) => ({ id: task.id, type: task.type, status: task.status, progress: task.progress })),
})

const patchSummary = (patch: WorkflowPatch) => ({
  patchId: patch.id,
  workflowId: patch.workflowId,
  summary: patch.summary,
  addNodes: patch.addNodes.length,
  updateNodes: patch.updateNodes.length,
  deleteNodes: patch.deleteNodeIds.length,
  addEdges: patch.addEdges.length,
  deleteEdges: patch.deleteEdgeIds.length,
})

const updateWorkflowTaskForPatch = (project: FilmProject): FilmProject => ({
  ...project,
  tasks: project.tasks.map((task) => task.type === 'workflow'
    ? { ...task, status: 'waiting-approval' as const, progress: 80 }
    : task),
  updatedAt: Date.now(),
})

const executeOne = async (
  call: AgentToolCall,
  context: AgentToolExecutionContext,
): Promise<AgentToolResult> => {
  const agentState = useAgentStore.getState()
  const scopedIdempotencyKey = `${context.workflow.id}:${context.scopeId || 'workflow'}:${call.idempotencyKey}`
  const definition = AGENT_TOOL_REGISTRY[call.name]
  if (!definition) return { toolCallId: call.id, name: call.name, success: false, error: 'Tool is not allowlisted.' }
  const memoizeResult = definition.sideEffect || call.name === 'workflow.create_patch' || call.name === 'approval.request'
  const remembered = memoizeResult ? agentState.getIdempotentResult(scopedIdempotencyKey) : null
  if (remembered) return { ...remembered, toolCallId: call.id, idempotentReplay: true }
  const schemaError = validateToolValue(call.arguments, definition.inputSchema)
  if (schemaError) return { toolCallId: call.id, name: call.name, success: false, error: schemaError }
  if (!definition.enabled) {
    return {
      toolCallId: call.id,
      name: call.name,
      success: false,
      error: `${call.name} is registered but disabled during the foundation phase. No provider job was started.`,
    }
  }
  if (context.mode === 'plan-only' && call.name.startsWith('workflow.') && call.name !== 'workflow.get_state' && call.name !== 'workflow.get_node_outputs') {
    return { toolCallId: call.id, name: call.name, success: false, error: 'Plan only mode does not permit workflow changes.' }
  }
  if ((context.mode === 'plan-only' || context.mode === 'edit-workflow') && call.name.startsWith('runner.')) {
    return { toolCallId: call.id, name: call.name, success: false, error: `${context.mode} mode does not permit runner execution or pilot run preparation.` }
  }
  if (call.name === 'workflow.apply_patch' || call.name === 'approval.resolve' || call.name === 'approval.cancel') {
    return {
      toolCallId: call.id,
      name: call.name,
      success: false,
      error: 'This action can only be completed by an explicit user action in the approval card.',
    }
  }

  const filmStore = useFilmProjectStore.getState()
  let project = context.projectId === undefined
    ? filmStore.getProjectForWorkflow(context.workflow.id)
    : context.projectId ? filmStore.getProjectById(context.projectId) : null
  let result: unknown

  switch (call.name) {
    case 'film.get_project':
      result = project ? projectSummary(project) : { project: null }
      break
    case 'film.create_project': {
      project = createFilmProjectFromTool(context.workflow.id, call.arguments, project)
      filmStore.upsertProject(project)
      context.projectId = project.id
      result = projectSummary(project)
      break
    }
    case 'film.update_brief':
    case 'film.upsert_character':
    case 'film.upsert_location':
    case 'film.create_scenes':
    case 'film.create_shots':
    case 'film.update_shot':
    case 'film.mark_shot_status': {
      if (!project) throw new Error(`${call.name} requires film.create_project first.`)
      if (call.name === 'film.update_brief') project = updateFilmBriefFromTool(project, call.arguments)
      if (call.name === 'film.upsert_character') project = upsertCharacterFromTool(project, call.arguments)
      if (call.name === 'film.upsert_location') project = upsertLocationFromTool(project, call.arguments)
      if (call.name === 'film.create_scenes') project = createScenesFromTool(project, call.arguments)
      if (call.name === 'film.create_shots') project = createShotsFromTool(project, call.arguments)
      if (call.name === 'film.update_shot') project = updateShotFromTool(project, call.arguments)
      if (call.name === 'film.mark_shot_status') project = markShotStatusFromTool(project, call.arguments)
      filmStore.upsertProject(project)
      result = projectSummary(project)
      break
    }
    case 'film.list_shots':
      result = {
        shots: (project?.shots || []).slice(0, 200).map((shot) => ({
          id: shot.id,
          sceneId: shot.sceneId,
          order: shot.order,
          durationSec: shot.durationSec,
          description: shot.description,
          status: shot.status,
          workflowNodeIds: shot.workflowNodeIds,
          imageAssetId: shot.imageAssetId,
          videoAssetId: shot.videoAssetId,
        })),
      }
      break
    case 'film.select_pilot_shot': {
      if (!project) throw new Error('film.select_pilot_shot requires a FilmProject.')
      const requestedProjectId = stringValue(call.arguments.projectId)
      if (requestedProjectId && requestedProjectId !== project.id) throw new Error('film.select_pilot_shot projectId does not match the active project.')
      const selected = selectPilotShot(project, stringValue(call.arguments.shotId))
      project = selected.project
      filmStore.upsertProject(project)
      result = selected.selection
      break
    }
    case 'workflow.get_state':
      result = compactWorkflowContext(context.workflow)
      break
    case 'workflow.create_patch': {
      if (!project) throw new Error('workflow.create_patch requires a FilmProject.')
      if (project.shots.length === 0) throw new Error('workflow.create_patch requires structured shots first.')
      if (!project.pilotShotId) {
        const selected = selectPilotShot(project)
        project = selected.project
        filmStore.upsertProject(project)
      }
      const patch = createShotPipelinePatch(context.workflow, project, {
        idempotencyKey: call.idempotencyKey,
        shotIds: Array.isArray(call.arguments.shotIds) && call.arguments.shotIds.length > 0
          ? call.arguments.shotIds.map(stringValue).filter(Boolean)
          : project.pilotShotId ? [project.pilotShotId] : undefined,
        imageProvider: parseProvider(call.arguments.imageProvider),
        videoProvider: parseProvider(call.arguments.videoProvider),
        imageModel: stringValue(call.arguments.imageModel),
        videoModel: stringValue(call.arguments.videoModel),
      })
      useAgentStore.getState().setPendingPatch(context.workflow.id, patch)
      project = updateWorkflowTaskForPatch(project)
      const approval = createApprovalFromTool(project, {
        id: `approval-${patch.id}`,
        type: 'workflow-patch',
        title: 'Apply workflow proposal',
        description: patch.summary,
        payload: patchSummary(patch),
      })
      project = { ...project, approvals: [...project.approvals.filter((item) => item.id !== approval.id), approval] }
      filmStore.upsertProject(project)
      result = patchSummary(patch)
      break
    }
    case 'workflow.preview_patch': {
      const patch = useAgentStore.getState().pendingPatchesByWorkflow[context.workflow.id]
      result = patch ? patchSummary(patch) : { patch: null }
      break
    }
    case 'workflow.get_node_outputs':
      result = (compactWorkflowContext(context.workflow).nodes as Array<Record<string, unknown>>)
        .filter((node) => Array.isArray(node.outputAssetIds) && node.outputAssetIds.length > 0)
        .map((node) => ({ nodeId: node.id, outputAssetIds: node.outputAssetIds }))
      break
    case 'runner.prepare_pilot': {
      if (!project) throw new Error('runner.prepare_pilot requires a FilmProject.')
      if (stringValue(call.arguments.projectId) !== project.id) throw new Error('runner.prepare_pilot projectId does not match the active project.')
      const requestedShotId = stringValue(call.arguments.shotId) || project.pilotShotId
      const selected = selectPilotShot(project, requestedShotId)
      const kind: PilotKind = call.arguments.kind === 'video' ? 'video' : 'image'
      project = createPilotRunApproval(selected.project, context.workflow, selected.selection.shotId, kind, stringValue(call.arguments.prompt))
      filmStore.upsertProject(project)
      const approval = [...project.approvals].reverse().find((item) => item.status === 'pending' && item.payload.stage === 'run' && item.payload.kind === kind)
      result = { ...selected.selection, kind, approvalId: approval?.id, status: approval?.status || 'pending' }
      break
    }
    case 'runner.run_pilot_image':
    case 'runner.run_pilot_video': {
      const kind: PilotKind = call.name === 'runner.run_pilot_video' ? 'video' : 'image'
      const runResult = await runPilotJob({
        projectId: stringValue(call.arguments.projectId),
        shotId: stringValue(call.arguments.shotId),
        workflowId: stringValue(call.arguments.workflowId),
        generateNodeId: stringValue(call.arguments.generateNodeId),
        approvalId: stringValue(call.arguments.approvalId),
        idempotencyKey: stringValue(call.arguments.idempotencyKey),
        kind,
      }, context.workflow)
      if (runResult.status === 'failed') throw new Error(runResult.error || `Pilot ${kind} failed.`)
      result = runResult
      break
    }
    case 'runner.get_job_status':
      result = { job: getPilotJobStatus(stringValue(call.arguments.jobId)) }
      break
    case 'runner.cancel_job':
      result = cancelPilotJob(stringValue(call.arguments.jobId))
      break
    case 'asset.get_metadata': {
      const assetId = stringValue(call.arguments.assetId)
      if (!assetId) throw new Error('asset.get_metadata requires assetId.')
      const asset = await getAsset(assetId)
      result = asset ? {
        id: asset.id,
        kind: asset.kind,
        mimeType: asset.mimeType,
        fileName: asset.fileName,
        size: asset.size,
        width: asset.width,
        height: asset.height,
        duration: asset.duration,
        source: asset.source,
      } : { asset: null }
      break
    }
    case 'asset.get_preview': {
      const assetId = stringValue(call.arguments.assetId)
      const asset = assetId ? await getAsset(assetId) : null
      result = asset ? { assetId: asset.id, kind: asset.kind, previewAvailable: true } : { previewAvailable: false }
      break
    }
    case 'asset.list_for_project': {
      const mappedIds = new Set((project?.shots || []).flatMap((shot) => [
        ...shot.referenceAssetIds,
        shot.imageAssetId || '',
        shot.videoAssetId || '',
      ]).filter(Boolean))
      const assets = (await listAssets()).filter((asset) => mappedIds.has(asset.id)).map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        mimeType: asset.mimeType,
        fileName: asset.fileName,
        size: asset.size,
        width: asset.width,
        height: asset.height,
        duration: asset.duration,
      }))
      result = { assets }
      break
    }
    case 'approval.request': {
      if (!project) throw new Error('approval.request requires a FilmProject.')
      const approval = createApprovalFromTool(project, call.arguments)
      filmStore.upsertApproval(project.id, approval)
      result = { approvalId: approval.id, status: approval.status, type: approval.type }
      break
    }
    default:
      return { toolCallId: call.id, name: call.name, success: false, error: `${call.name} has no foundation-phase executor.` }
  }

  const toolResult: AgentToolResult = { toolCallId: call.id, name: call.name, success: true, result }
  if (memoizeResult) useAgentStore.getState().rememberIdempotentResult(scopedIdempotencyKey, toolResult)
  return toolResult
}

export const executeAgentToolCalls = async (
  calls: AgentToolCall[],
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionSummary> => {
  const results: AgentToolResult[] = []
  const validationErrors: string[] = []
  const projectForContext = (): FilmProject | null => context.projectId === undefined
    ? useFilmProjectStore.getState().getProjectForWorkflow(context.workflow.id)
    : context.projectId ? useFilmProjectStore.getState().getProjectById(context.projectId) : null
  for (const call of calls.slice(0, 20)) {
    const activityId = `activity-${context.workflow.id}-${context.scopeId || 'workflow'}-${call.idempotencyKey}`
    useAgentStore.getState().addActivity({
      id: activityId,
      projectId: projectForContext()?.id,
      toolName: call.name,
      status: 'running',
      summary: call.name,
      createdAt: Date.now(),
    })
    try {
      const result = await executeOne(call, context)
      results.push(result)
      if (!result.success && result.error) validationErrors.push(result.error)
      useAgentStore.getState().addActivity({
        id: activityId,
        projectId: projectForContext()?.id,
        toolName: call.name,
        status: result.success ? 'completed' : 'failed',
        summary: result.success ? `${call.name} completed` : result.error || `${call.name} failed`,
        createdAt: Date.now(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : `${call.name} failed validation.`
      results.push({ toolCallId: call.id, name: call.name, success: false, error: message })
      validationErrors.push(message)
      useAgentStore.getState().addActivity({
        id: activityId,
        projectId: projectForContext()?.id,
        toolName: call.name,
        status: 'failed',
        summary: message,
        createdAt: Date.now(),
      })
    }
  }
  return {
    results,
    project: projectForContext(),
    pendingPatch: useAgentStore.getState().pendingPatchesByWorkflow[context.workflow.id] || null,
    validationErrors,
  }
}
