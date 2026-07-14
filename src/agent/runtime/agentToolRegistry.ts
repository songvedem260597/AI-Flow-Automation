import {
  AGENT_TOOL_NAMES,
  type AgentToolDefinition,
  type AgentToolName,
} from '@/agent/schemas/agentToolSchemas'

const FILM_TOOLS = new Set<AgentToolName>([
  'film.get_project',
  'film.create_project',
  'film.update_brief',
  'film.upsert_character',
  'film.upsert_location',
  'film.create_scenes',
  'film.create_shots',
  'film.update_shot',
  'film.list_shots',
  'film.mark_shot_status',
  'film.select_pilot_shot',
])

const READ_ONLY_TOOLS = new Set<AgentToolName>([
  'film.get_project',
  'film.list_shots',
  'workflow.get_state',
  'workflow.preview_patch',
  'workflow.get_node_outputs',
  'runner.get_status',
  'runner.get_job_status',
  'asset.get_metadata',
  'asset.get_preview',
  'asset.list_for_project',
])

const APPROVAL_TOOLS = new Set<AgentToolName>([
  'workflow.apply_patch',
  'workflow.layout_nodes',
  'runner.run_node',
  'runner.run_subgraph',
  'runner.cancel',
  'runner.run_pilot_image',
  'runner.run_pilot_video',
  'runner.cancel_job',
  'asset.assign_to_shot',
  'asset.attach_to_media_node',
  'review.approve_shot',
  'review.reject_shot',
  'review.request_regeneration',
  'review.mark_asset_stale',
  'approval.resolve',
  'approval.cancel',
])

const PHASE_ONE_DISABLED = new Set<AgentToolName>([
  'runner.run_node',
  'runner.run_subgraph',
  'runner.get_status',
  'runner.cancel',
  'asset.assign_to_shot',
  'asset.attach_to_media_node',
  'review.create',
  'review.approve_shot',
  'review.reject_shot',
  'review.request_regeneration',
  'review.mark_asset_stale',
  'workflow.layout_nodes',
])

const descriptions: Partial<Record<AgentToolName, string>> = {
  'film.get_project': 'Read the active structured FilmProject.',
  'film.create_project': 'Create the FilmProject scaffold and production task graph for this workflow.',
  'film.update_brief': 'Update the film brief and style bible with explicit production constraints.',
  'film.upsert_character': 'Create or update one character bible entry without silently changing locked traits.',
  'film.upsert_location': 'Create or update one world/location bible entry.',
  'film.create_scenes': 'Replace the ordered scene plan with validated structured scenes.',
  'film.create_shots': 'Create or update structured shots and connect them to their scenes.',
  'film.update_shot': 'Patch one existing shot.',
  'film.list_shots': 'List current shots and production statuses.',
  'film.mark_shot_status': 'Change one shot production status after a real local result.',
  'film.select_pilot_shot': 'Select one representative pilot shot. This never starts a provider job.',
  'workflow.get_state': 'Read compact workflow nodes and edges without binary data.',
  'workflow.create_patch': 'Build an idempotent local WorkflowPatch proposal from FilmProject shots.',
  'workflow.preview_patch': 'Read the current pending WorkflowPatch preview.',
  'workflow.apply_patch': 'Request approval to atomically apply the pending WorkflowPatch.',
  'workflow.layout_nodes': 'Propose layout changes for agent-managed workflow nodes.',
  'workflow.get_node_outputs': 'Read lightweight output asset IDs from workflow nodes.',
  'runner.run_node': 'Run one approved workflow node. Disabled during the foundation phase.',
  'runner.run_subgraph': 'Run an approved workflow subgraph. Disabled during the foundation phase.',
  'runner.get_status': 'Read runner status. Disabled during the foundation phase.',
  'runner.cancel': 'Cancel an active runner job. Disabled during the foundation phase.',
  'runner.prepare_pilot': 'Validate the selected pilot pipeline and create a one-job approval card. No provider request is sent.',
  'runner.run_pilot_image': 'Run exactly one approved pilot image Generate node through the existing workflow runner.',
  'runner.run_pilot_video': 'Run exactly one approved pilot video Generate node after the image is approved.',
  'runner.get_job_status': 'Read a persisted pilot runner job without resubmitting it.',
  'runner.cancel_job': 'Request cancellation of the active local pilot runner job without claiming remote provider cancellation.',
  'asset.get_metadata': 'Read lightweight IndexedDB asset metadata by asset ID.',
  'asset.get_preview': 'Resolve a local preview for the UI only; never send object URLs to the model.',
  'asset.assign_to_shot': 'Assign a real asset ID to a shot. Disabled during the foundation phase.',
  'asset.attach_to_media_node': 'Attach an existing asset to a Media node. Disabled during the foundation phase.',
  'asset.list_for_project': 'List project asset metadata without Blob content.',
  'review.create': 'Create a shot review record. Disabled during the foundation phase.',
  'review.approve_shot': 'Approve a shot. Disabled during the foundation phase.',
  'review.reject_shot': 'Reject a shot. Disabled during the foundation phase.',
  'review.request_regeneration': 'Propose regeneration. Disabled during the foundation phase.',
  'review.mark_asset_stale': 'Mark an asset mapping stale without deleting it. Disabled during the foundation phase.',
  'approval.request': 'Create a reviewable local approval request.',
  'approval.resolve': 'Resolve an approval after explicit user action.',
  'approval.cancel': 'Cancel a pending approval.',
}

const inputSchemas: Partial<Record<AgentToolName, Record<string, unknown>>> = {
  'film.create_project': {
    type: 'object',
    required: ['title'],
    properties: { title: { type: 'string', maxLength: 120 } },
  },
  'film.update_brief': {
    type: 'object',
    required: ['brief'],
    properties: {
      brief: {
        type: 'object',
        properties: {
          logline: { type: 'string' }, genre: { type: 'string' }, audience: { type: 'string' },
          targetDurationSec: { type: 'number', minimum: 1, maximum: 7200 },
          aspectRatio: { enum: ['9:16', '16:9', '1:1'] }, visualStyle: { type: 'string' },
          language: { type: 'string' }, platform: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } },
        },
      },
      styleBible: {
        type: 'object',
        properties: {
          visualIdentity: { type: 'string' }, palette: { type: 'array', items: { type: 'string' } },
          lighting: { type: 'string' }, cameraLanguage: { type: 'string' }, renderStyle: { type: 'string' },
          lockedRules: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  'film.upsert_character': {
    type: 'object',
    required: ['character'],
    properties: {
      character: {
        type: 'object', required: ['id', 'name', 'role', 'appearance'],
        properties: {
          id: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, age: { type: 'string' },
          appearance: { type: 'string' }, hair: { type: 'string' }, clothing: { type: 'string' }, personality: { type: 'string' },
          lockedTraits: { type: 'array', items: { type: 'string' } }, referenceAssetIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  'film.upsert_location': {
    type: 'object',
    required: ['location'],
    properties: {
      location: {
        type: 'object', required: ['id', 'name', 'description'],
        properties: {
          id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, lighting: { type: 'string' },
          palette: { type: 'array', items: { type: 'string' } }, lockedTraits: { type: 'array', items: { type: 'string' } },
          referenceAssetIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  'film.create_scenes': {
    type: 'object', required: ['scenes'],
    properties: { scenes: { type: 'array', items: { type: 'object', required: ['id', 'order', 'title', 'summary', 'purpose', 'characterIds'] } } },
  },
  'film.create_shots': {
    type: 'object', required: ['shots'],
    properties: {
      shots: {
        type: 'array',
        items: {
          type: 'object', required: ['id', 'sceneId', 'order', 'durationSec', 'description', 'camera', 'action', 'emotion', 'imagePrompt', 'videoPrompt', 'characterIds'],
          properties: {
            id: { type: 'string' }, sceneId: { type: 'string' }, order: { type: 'number' }, durationSec: { type: 'number' },
            description: { type: 'string' }, camera: { type: 'string' }, action: { type: 'string' }, emotion: { type: 'string' },
            imagePrompt: { type: 'string' }, videoPrompt: { type: 'string' }, negativePrompt: { type: 'string' },
            characterIds: { type: 'array', items: { type: 'string' } }, referenceAssetIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  'film.update_shot': { type: 'object', required: ['shotId', 'patch'], properties: { shotId: { type: 'string' }, patch: { type: 'object' } } },
  'film.mark_shot_status': { type: 'object', required: ['shotId', 'status'], properties: { shotId: { type: 'string' }, status: { type: 'string' } } },
  'film.select_pilot_shot': { type: 'object', properties: { projectId: { type: 'string' }, shotId: { type: 'string' } } },
  'workflow.create_patch': {
    type: 'object',
    properties: {
      shotIds: { type: 'array', items: { type: 'string' } }, imageProvider: { type: 'string' }, videoProvider: { type: 'string' },
      imageModel: { type: 'string' }, videoModel: { type: 'string' }, pipelineType: { const: 'image-to-video' },
    },
  },
  'runner.prepare_pilot': {
    type: 'object',
    required: ['projectId'],
    properties: { projectId: { type: 'string' }, shotId: { type: 'string' }, kind: { enum: ['image', 'video'] }, prompt: { type: 'string' } },
  },
  'runner.run_pilot_image': {
    type: 'object',
    required: ['projectId', 'shotId', 'workflowId', 'generateNodeId', 'approvalId', 'idempotencyKey'],
    properties: {
      projectId: { type: 'string' }, shotId: { type: 'string' }, workflowId: { type: 'string' }, generateNodeId: { type: 'string' },
      approvalId: { type: 'string' }, idempotencyKey: { type: 'string' },
    },
  },
  'runner.run_pilot_video': {
    type: 'object',
    required: ['projectId', 'shotId', 'workflowId', 'generateNodeId', 'approvalId', 'idempotencyKey'],
    properties: {
      projectId: { type: 'string' }, shotId: { type: 'string' }, workflowId: { type: 'string' }, generateNodeId: { type: 'string' },
      approvalId: { type: 'string' }, idempotencyKey: { type: 'string' },
    },
  },
  'runner.get_job_status': { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' } } },
  'runner.cancel_job': { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' } } },
  'asset.get_metadata': { type: 'object', required: ['assetId'], properties: { assetId: { type: 'string' } } },
  'asset.get_preview': { type: 'object', required: ['assetId'], properties: { assetId: { type: 'string' } } },
  'approval.request': { type: 'object', required: ['type', 'title', 'description'], properties: { type: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, payload: { type: 'object' } } },
}

export const AGENT_TOOL_REGISTRY: Record<AgentToolName, AgentToolDefinition> = Object.fromEntries(
  AGENT_TOOL_NAMES.map((name) => {
    const sideEffect = !READ_ONLY_TOOLS.has(name) && name !== 'workflow.create_patch'
    return [name, {
      name,
      description: descriptions[name] || name,
      inputSchema: inputSchemas[name] || { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: true },
      sideEffect,
      requiresApproval: APPROVAL_TOOLS.has(name),
      enabled: !PHASE_ONE_DISABLED.has(name),
      idempotencyKey: FILM_TOOLS.has(name)
        ? 'projectId + tool + stable entity id'
        : 'projectId + shotId + pipelineType',
    } satisfies AgentToolDefinition]
  })
) as unknown as Record<AgentToolName, AgentToolDefinition>

export const listAgentTools = (): AgentToolDefinition[] => AGENT_TOOL_NAMES.map((name) => AGENT_TOOL_REGISTRY[name])
