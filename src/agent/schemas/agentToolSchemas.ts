import type { WorkflowEdge, WorkflowNode } from '@/types'
import type { AgentMode, FilmProject } from '@/agent/schemas/filmProjectSchemas'

export const AGENT_TOOL_NAMES = [
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
  'workflow.get_state',
  'workflow.create_patch',
  'workflow.preview_patch',
  'workflow.apply_patch',
  'workflow.layout_nodes',
  'workflow.get_node_outputs',
  'runner.run_node',
  'runner.run_subgraph',
  'runner.get_status',
  'runner.cancel',
  'runner.prepare_pilot',
  'runner.run_pilot_image',
  'runner.run_pilot_video',
  'runner.get_job_status',
  'runner.cancel_job',
  'asset.get_metadata',
  'asset.get_preview',
  'asset.assign_to_shot',
  'asset.attach_to_media_node',
  'asset.list_for_project',
  'review.create',
  'review.approve_shot',
  'review.reject_shot',
  'review.request_regeneration',
  'review.mark_asset_stale',
  'approval.request',
  'approval.resolve',
  'approval.cancel',
] as const

export type AgentToolName = typeof AGENT_TOOL_NAMES[number]

export interface AgentToolCall {
  id: string
  name: AgentToolName
  arguments: Record<string, unknown>
  idempotencyKey: string
}

export interface AgentToolResult {
  toolCallId: string
  name: AgentToolName
  success: boolean
  result?: unknown
  error?: string
  idempotentReplay?: boolean
}

export interface AgentToolDefinition {
  name: AgentToolName
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  sideEffect: boolean
  requiresApproval: boolean
  enabled: boolean
  idempotencyKey: string
}

export interface WorkflowPatch {
  id: string
  workflowId: string
  projectId?: string
  summary: string
  addNodes: WorkflowNode[]
  updateNodes: Array<{ nodeId: string; patch: Record<string, unknown> }>
  deleteNodeIds: string[]
  addEdges: WorkflowEdge[]
  deleteEdgeIds: string[]
  createdAt: number
}

export interface WorkflowPatchApplyResult {
  success: boolean
  applied: boolean
  error?: string
}

export interface AgentTurnInput {
  userMessage: string
  conversationSummary: string
  projectContext: FilmProject | null
  workflowContext: Record<string, unknown>
  selectedNodeContext: Record<string, unknown> | null
  availableTools: AgentToolDefinition[]
  agentMode: AgentMode
}

export interface AgentTurnResult {
  message: string
  conversationSummary: string
  toolCalls: AgentToolCall[]
  validationErrors: string[]
  rawText: string
}

export interface AgentToolContinuationInput extends AgentTurnInput {
  toolResults: AgentToolResult[]
}

const TOOL_NAME_SET = new Set<string>(AGENT_TOOL_NAMES)

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const extractJsonCandidates = (text: string): string[] => {
  const candidates: string[] = []
  const trimmed = text.trim()
  if (trimmed) candidates.push(trimmed)
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) candidates.push(match[1].trim())
  }
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  return Array.from(new Set(candidates))
}

const parseEnvelopeObject = (text: string): Record<string, unknown> | null => {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate)
      const record = asRecord(parsed)
      if (record) return record
    } catch {
      // Try the next bounded candidate. Invalid JSON is reported by the caller.
    }
  }
  return null
}

export const parseAgentTurnResult = (rawText: string): AgentTurnResult => {
  const envelope = parseEnvelopeObject(rawText)
  if (!envelope) {
    return {
      message: rawText.trim(),
      conversationSummary: '',
      toolCalls: [],
      validationErrors: ['The model did not return the required structured JSON envelope. No tools were executed.'],
      rawText,
    }
  }

  const validationErrors: string[] = []
  const calls = Array.isArray(envelope.toolCalls) ? envelope.toolCalls.slice(0, 20) : []
  if (Array.isArray(envelope.toolCalls) && envelope.toolCalls.length > 20) {
    validationErrors.push('Tool-call limit exceeded. Only the first 20 calls were considered.')
  }
  const toolCalls: AgentToolCall[] = []
  calls.forEach((value, index) => {
    const record = asRecord(value)
    if (!record) {
      validationErrors.push(`Tool call ${index + 1} must be an object.`)
      return
    }
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!TOOL_NAME_SET.has(name)) {
      validationErrors.push(`Tool call ${index + 1} uses an unknown tool: ${name || '(missing)'}.`)
      return
    }
    const args = asRecord(record.arguments)
    if (!args) {
      validationErrors.push(`Tool call ${index + 1} has invalid arguments.`)
      return
    }
    const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `tool-call-${index + 1}`
    const idempotencyKey = typeof record.idempotencyKey === 'string' ? record.idempotencyKey.trim() : ''
    if (!idempotencyKey) {
      validationErrors.push(`Tool call ${index + 1} is missing idempotencyKey.`)
      return
    }
    toolCalls.push({
      id,
      name: name as AgentToolName,
      arguments: args,
      idempotencyKey: idempotencyKey.slice(0, 240),
    })
  })

  return {
    message: typeof envelope.message === 'string' ? envelope.message.trim() : '',
    conversationSummary: typeof envelope.conversationSummary === 'string'
      ? envelope.conversationSummary.trim().slice(0, 12_000)
      : '',
    toolCalls,
    validationErrors,
    rawText,
  }
}

export const isWorkflowPatch = (value: unknown): value is WorkflowPatch => {
  const record = asRecord(value)
  if (!record) return false
  return Boolean(
    typeof record.id === 'string'
    && typeof record.workflowId === 'string'
    && (record.projectId === undefined || typeof record.projectId === 'string')
    && typeof record.summary === 'string'
    && Array.isArray(record.addNodes)
    && Array.isArray(record.updateNodes)
    && Array.isArray(record.deleteNodeIds)
    && Array.isArray(record.addEdges)
    && Array.isArray(record.deleteEdgeIds)
    && Number.isFinite(Number(record.createdAt))
  )
}
