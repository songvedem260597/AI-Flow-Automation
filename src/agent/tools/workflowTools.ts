import type { AIProvider, FlowNodeData, Workflow, WorkflowEdge, WorkflowNode } from '@/types'
import type { FilmProject, FilmShot } from '@/agent/schemas/filmProjectSchemas'
import type { WorkflowPatch } from '@/agent/schemas/agentToolSchemas'

export interface ShotPipelineOptions {
  shotIds?: string[]
  imageProvider?: AIProvider
  videoProvider?: AIProvider
  imageModel?: string
  videoModel?: string
  idempotencyKey: string
}

const stableHash = (value: string): string => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

const safeSegment = (value: string): string => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 34) || stableHash(value)

const nodeMetadata = (project: FilmProject, shot: FilmShot, agentTaskId: string, patchId: string) => ({
  agentManaged: true,
  filmProjectId: project.id,
  sceneId: shot.sceneId,
  shotId: shot.id,
  agentTaskId,
  agentPatchId: patchId,
})

const buildShotNodes = (
  project: FilmProject,
  shot: FilmShot,
  rowIndex: number,
  startX: number,
  startY: number,
  patchId: string,
  options: ShotPipelineOptions,
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } => {
  const projectSegment = safeSegment(project.id)
  const shotSegment = safeSegment(shot.id)
  const prefix = `agent-${projectSegment}-${shotSegment}`
  const promptImageId = `${prefix}-prompt-image`
  const generateImageId = `${prefix}-generate-image`
  const promptVideoId = `${prefix}-prompt-video`
  const generateVideoId = `${prefix}-generate-video`
  const imageProvider = options.imageProvider || 'chatgpt'
  const videoProvider = options.videoProvider || 'google-flow'
  const y = startY + rowIndex * 620
  const metadata = nodeMetadata(project, shot, 'task-6', patchId)
  const aspectRatio = project.brief.aspectRatio

  const nodes: WorkflowNode[] = [
    {
      id: promptImageId,
      type: 'prompt',
      position: { x: startX, y },
      data: {
        label: `Prompt Image · ${shot.id}`,
        prompt: shot.imagePrompt || shot.description,
        provider: imageProvider,
        enabled: true,
        ...metadata,
      } as FlowNodeData,
    },
    {
      id: generateImageId,
      type: 'generate',
      position: { x: startX + 340, y },
      data: {
        label: `Generate Image · ${shot.id}`,
        provider: imageProvider,
        mediaType: 'image',
        aspectRatio,
        model: options.imageModel || '',
        autoGenerate: true,
        waitForCompletion: true,
        timeout: 300_000,
        enabled: true,
        ...metadata,
      } as FlowNodeData,
    },
    {
      id: promptVideoId,
      type: 'prompt',
      position: { x: startX + 700, y },
      data: {
        label: `Prompt Video · ${shot.id}`,
        prompt: shot.videoPrompt || shot.action || shot.description,
        provider: videoProvider,
        enabled: true,
        ...metadata,
      } as FlowNodeData,
    },
    {
      id: generateVideoId,
      type: 'generate',
      position: { x: startX + 1040, y },
      data: {
        label: `Generate Video · ${shot.id}`,
        provider: videoProvider,
        mediaType: 'video',
        flowVideoMode: 'frame',
        aspectRatio,
        videoDuration: `${Math.max(1, Math.round(shot.durationSec))}s`,
        model: options.videoModel || '',
        autoGenerate: true,
        waitForCompletion: true,
        timeout: 600_000,
        enabled: true,
        ...metadata,
      } as FlowNodeData,
    },
  ]

  const edges: WorkflowEdge[] = [
    {
      id: `${prefix}-edge-image-prompt`,
      source: promptImageId,
      target: generateImageId,
      sourceHandle: 'output_1',
      targetHandle: 'input_2',
    },
    {
      id: `${prefix}-edge-image-frame`,
      source: generateImageId,
      target: generateVideoId,
      sourceHandle: 'output_1',
      targetHandle: 'input_1',
    },
    {
      id: `${prefix}-edge-video-prompt`,
      source: promptVideoId,
      target: generateVideoId,
      sourceHandle: 'output_1',
      targetHandle: 'input_2',
    },
  ]
  return { nodes, edges }
}

export const createShotPipelinePatch = (
  workflow: Workflow,
  project: FilmProject,
  options: ShotPipelineOptions,
): WorkflowPatch => {
  const requestedIds = new Set(options.shotIds || [])
  const shots = project.shots
    .filter((shot) => requestedIds.size === 0 || requestedIds.has(shot.id))
    .sort((left, right) => left.order - right.order)
  if (shots.length === 0) throw new Error('No FilmProject shots are available for a workflow proposal.')
  if (shots.length * 4 > 100) throw new Error('Workflow proposal exceeds 100 nodes. Split the shots into smaller approved patches.')
  const maxX = workflow.nodes.reduce((maximum, node) => Math.max(maximum, node.position.x), 0)
  const minY = workflow.nodes.reduce((minimum, node) => Math.min(minimum, node.position.y), 120)
  const patchId = `film-patch-${stableHash(`${project.id}:${options.idempotencyKey}`)}`
  const addNodes: WorkflowNode[] = []
  const addEdges: WorkflowEdge[] = []
  shots.forEach((shot, index) => {
    const pipeline = buildShotNodes(project, shot, index, maxX + 420, minY, patchId, options)
    addNodes.push(...pipeline.nodes)
    addEdges.push(...pipeline.edges)
  })
  return {
    id: patchId,
    workflowId: workflow.id,
    projectId: project.id,
    summary: `Create image-to-video pipelines for ${shots.length} shot${shots.length === 1 ? '' : 's'}.`,
    addNodes,
    updateNodes: [],
    deleteNodeIds: [],
    addEdges,
    deleteEdgeIds: [],
    createdAt: Date.now(),
  }
}

const safeAssetIdsFromNode = (node: WorkflowNode): string[] => {
  const data = node.data as Record<string, unknown>
  const ids = new Set<string>()
  for (const key of ['assetId', 'mediaAssetId', 'imageAssetId', 'videoAssetId', 'posterAssetId', 'thumbnailAssetId']) {
    if (typeof data[key] === 'string' && String(data[key]).trim()) ids.add(String(data[key]).trim())
  }
  const output = data._output && typeof data._output === 'object' ? data._output as Record<string, unknown> : null
  if (output) {
    for (const key of ['assetId', 'posterAssetId', 'thumbnailAssetId']) {
      if (typeof output[key] === 'string' && String(output[key]).trim()) ids.add(String(output[key]).trim())
    }
    for (const item of Array.isArray(output.outputs) ? output.outputs : []) {
      if (!item || typeof item !== 'object') continue
      const assetId = (item as Record<string, unknown>).assetId
      if (typeof assetId === 'string' && assetId.trim()) ids.add(assetId.trim())
    }
  }
  return Array.from(ids)
}

export const compactWorkflowContext = (workflow: Workflow): Record<string, unknown> => ({
  workflowId: workflow.id,
  name: workflow.name,
  nodes: workflow.nodes.slice(0, 250).map((node) => {
    const data = node.data as Record<string, unknown>
    return {
      id: node.id,
      type: node.type,
      label: String(data.label || node.type).slice(0, 160),
      enabled: data.enabled !== false,
      provider: typeof data.provider === 'string' ? data.provider : undefined,
      mediaType: typeof data.mediaType === 'string' ? data.mediaType : undefined,
      model: typeof data.model === 'string' ? data.model : undefined,
      assetIds: safeAssetIdsFromNode(node),
      outputAssetIds: safeAssetIdsFromNode(node.type === 'generate' ? node : { ...node, data: { label: '' } as FlowNodeData }),
    }
  }),
  edges: workflow.edges.slice(0, 500).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
  })),
})
