import { createAgentId, sanitizeAgentValue, type AgentApproval, type FilmProject } from '@/agent/schemas/filmProjectSchemas'

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export const createApprovalFromTool = (project: FilmProject, args: Record<string, unknown>): AgentApproval => {
  const rawType = typeof args.type === 'string' ? args.type : 'workflow-patch'
  const allowedTypes = new Set<AgentApproval['type']>([
    'workflow-patch', 'pilot-image', 'pilot-video', 'batch-generation', 'destructive-change'
  ])
  const type = allowedTypes.has(rawType as AgentApproval['type'])
    ? rawType as AgentApproval['type']
    : 'workflow-patch'
  return {
    id: typeof args.id === 'string' && args.id.trim() ? args.id.trim() : createAgentId('approval'),
    type,
    title: typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 200) : 'Approval required',
    description: typeof args.description === 'string' ? args.description.trim().slice(0, 4_000) : '',
    status: 'pending',
    payload: asRecord(sanitizeAgentValue(args.payload)),
    createdAt: Date.now(),
  }
}

export const resolveApproval = (
  project: FilmProject,
  approvalId: string,
  status: 'approved' | 'rejected' | 'cancelled',
): FilmProject => {
  if (!project.approvals.some((approval) => approval.id === approvalId)) {
    throw new Error(`Approval not found: ${approvalId || '(missing)'}.`)
  }
  return {
    ...project,
    approvals: project.approvals.map((approval) => approval.id === approvalId
      ? { ...approval, status, resolvedAt: Date.now() }
      : approval),
    updatedAt: Date.now(),
  }
}
