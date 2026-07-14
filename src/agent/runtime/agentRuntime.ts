import type { Workflow, WorkflowNode } from '@/types'
import type { AgentModelAdapter } from '@/agent/runtime/types'
import { listAgentTools } from '@/agent/runtime/agentToolRegistry'
import { executeAgentToolCalls } from '@/agent/runtime/agentToolExecutor'
import { compactWorkflowContext } from '@/agent/tools/workflowTools'
import { useAgentStore } from '@/agent/stores/agentStore'
import { useFilmProjectStore } from '@/agent/stores/filmProjectStore'
import type { AgentMode, FilmProject } from '@/agent/schemas/filmProjectSchemas'
import type { AgentToolCall, AgentToolResult, WorkflowPatch } from '@/agent/schemas/agentToolSchemas'

export interface RunFilmAgentTurnInput {
  workflow: Workflow
  selectedNode?: WorkflowNode | null
  userMessage: string
  conversationSummary?: string
  /** undefined = legacy workflow context, null = start without a persisted FilmProject. */
  projectId?: string | null
  conversationId?: string
  signal?: AbortSignal
  mode: AgentMode
  adapter: AgentModelAdapter
}

export interface RunFilmAgentTurnResult {
  message: string
  conversationSummary: string
  project: FilmProject | null
  pendingPatch: WorkflowPatch | null
  toolResults: AgentToolResult[]
  validationErrors: string[]
}

const compactSelectedNode = (node?: WorkflowNode | null): Record<string, unknown> | null => {
  if (!node) return null
  const data = node.data as Record<string, unknown>
  return {
    id: node.id,
    type: node.type,
    label: String(data.label || node.type).slice(0, 160),
    enabled: data.enabled !== false,
    provider: typeof data.provider === 'string' ? data.provider : undefined,
    mediaType: typeof data.mediaType === 'string' ? data.mediaType : undefined,
    model: typeof data.model === 'string' ? data.model : undefined,
    agentManaged: data.agentManaged === true,
    filmProjectId: typeof data.filmProjectId === 'string' ? data.filmProjectId : undefined,
    sceneId: typeof data.sceneId === 'string' ? data.sceneId : undefined,
    shotId: typeof data.shotId === 'string' ? data.shotId : undefined,
  }
}

const toolsForMode = (mode: AgentMode) => listAgentTools().filter((tool) => {
  if (!tool.enabled) return false
  if (mode === 'edit-workflow') return !tool.name.startsWith('runner.')
  if (mode !== 'plan-only') return true
  return tool.name.startsWith('film.')
    || tool.name === 'workflow.get_state'
    || tool.name === 'workflow.get_node_outputs'
    || tool.name === 'asset.get_metadata'
    || tool.name === 'asset.get_preview'
    || tool.name === 'asset.list_for_project'
})

const normalizeIntentText = (message: string): string => message
  .trim()
  .toLocaleLowerCase()
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .replace(/\u0111/g, 'd')

const isProjectStatusQuestion = (message: string): boolean => {
  const normalized = normalizeIntentText(message)
  return /(?:da|tao|lam).{0,28}chua\??$/iu.test(normalized)
    || /(?:have you|is (?:it|the project)|did you).{0,40}(?:yet|already|created|done)\??$/iu.test(normalized)
}

const explicitlyCommitsProject = (message: string): boolean => {
  if (isProjectStatusQuestion(message)) return false
  const normalized = normalizeIntentText(message)
  return /^(?:ok|okay|yes|dong y|chot|tao|lam)$/iu.test(normalized)
    || /(?:hay|giup|bat dau|tien hanh)?\s*(?:tao|lam|chot)\s+(?:di|luon|giup|du an|bo phim|phim)/iu.test(normalized)
    || /(?:go ahead|create it|create the project|build it|start the project|use this idea|lock it in|proceed)/iu.test(normalized)
}

const explicitlyRequestsPilotSelection = (message: string): boolean => {
  const normalized = normalizeIntentText(message)
  return /(?:chon|select|choose|pick).{0,32}(?:pilot|shot thu|canh thu)/iu.test(normalized)
    || /(?:pilot|shot thu|canh thu).{0,32}(?:chon|select|choose|pick)/iu.test(normalized)
}

const toolsForTurn = (mode: AgentMode, project: FilmProject | null, userMessage: string) => {
  const canPersistProject = Boolean(project) || explicitlyCommitsProject(userMessage)
  const canSelectPilot = explicitlyRequestsPilotSelection(userMessage)
  return toolsForMode(mode).filter((tool) => {
    if (tool.name === 'film.select_pilot_shot') return canSelectPilot
    if (!canPersistProject && tool.name.startsWith('film.') && tool.name !== 'film.get_project') return false
    return true
  })
}

const shouldRecoverFromPassiveClarification = (
  message: string,
  userMessage: string,
  conversationSummary: string,
): boolean => {
  const response = message.toLocaleLowerCase()
  const context = `${conversationSummary}\n${userMessage}`.toLocaleLowerCase()
  const isPassiveClarification = /(?:vui lòng cung cấp|ban vui long cung cap|cần thêm|can them|hãy cho biết|hay cho biet|bạn có thể cung cấp|ban co the cung cap|cần một số thông tin|can mot so thong tin|need more (?:details|information)|please provide|could you provide|before (?:i|we) can (?:start|create)|to get started)/iu.test(response)
  if (!isPassiveClarification) return false

  const delegatedCreativeControl = /(?:gợi ý|goi y|tự chọn|tu chon|bạn quyết|ban quyet|tùy bạn|tuy ban|bạn hãy quyết định|ban hay quyet dinh|suggest|you decide|surprise me|anything is fine)/iu.test(context)
  const hasProductionSeed = /(?:phim|film|video|story|kịch bản|kich ban|thể loại|the loai|du hành|du hanh|youtube|tiktok|netflix|16:9|9:16|1:1|phút|phut|minutes?|seconds?|cinematic|animation|anime|documentary)/iu.test(context)
    && context.trim().split(/\s+/).length >= 4
  return delegatedCreativeControl || hasProductionSeed
}

export const runFilmAgentTurn = async (input: RunFilmAgentTurnInput): Promise<RunFilmAgentTurnResult> => {
  const throwIfStopped = () => {
    if (!input.signal?.aborted) return
    const error = new Error('AI Idea Agent request stopped by the user.')
    error.name = 'AbortError'
    throw error
  }
  throwIfStopped()
  await Promise.all([
    useFilmProjectStore.getState().hydrate(),
    useAgentStore.getState().hydrate(),
  ])
  throwIfStopped()
  const filmStore = useFilmProjectStore.getState()
  const initialProject = input.projectId === undefined
    ? filmStore.getProjectForWorkflow(input.workflow.id)
    : input.projectId ? filmStore.getProjectById(input.projectId) : null
  const executionContext = {
    workflow: input.workflow,
    mode: input.mode,
    projectId: input.projectId === undefined ? initialProject?.id : input.projectId,
    scopeId: input.conversationId,
  }
  const availableTools = toolsForTurn(input.mode, initialProject, input.userMessage)
  const availableToolNames = new Set(availableTools.map((tool) => tool.name))
  const executeAvailableToolCalls = async (calls: AgentToolCall[]) => {
    const allowedCalls = calls.filter((call) => availableToolNames.has(call.name))
    const blockedCalls = calls.filter((call) => !availableToolNames.has(call.name))
    const execution = await executeAgentToolCalls(allowedCalls, executionContext)
    if (blockedCalls.length === 0) return execution
    const blockedResults: AgentToolResult[] = blockedCalls.map((call) => ({
      toolCallId: call.id,
      name: call.name,
      success: false,
      error: call.name === 'film.select_pilot_shot'
        ? 'Pilot selection requires an explicit request from the user.'
        : 'Creating project state requires explicit user confirmation of the proposed direction.',
    }))
    return {
      ...execution,
      results: [...execution.results, ...blockedResults],
      validationErrors: [
        ...execution.validationErrors,
        ...blockedResults.map((result) => result.error || 'Agent tool was not available for this turn.'),
      ],
    }
  }
  const turnInput = {
    userMessage: input.userMessage,
    conversationSummary: initialProject?.conversationSummary || input.conversationSummary || '',
    projectContext: initialProject,
    workflowContext: compactWorkflowContext(input.workflow),
    selectedNodeContext: compactSelectedNode(input.selectedNode),
    availableTools,
    agentMode: input.mode,
  }

  const firstTurn = await input.adapter.createTurn(turnInput)
  throwIfStopped()
  const firstExecution = await executeAvailableToolCalls(firstTurn.toolCalls)
  throwIfStopped()
  let message = firstTurn.message
  let conversationSummary = firstTurn.conversationSummary
  let toolResults = firstExecution.results
  const validationErrors = [...firstTurn.validationErrors, ...firstExecution.validationErrors]

  if (firstTurn.toolCalls.length > 0 && firstTurn.toolCalls.length < 20) {
    const currentProject = executionContext.projectId
      ? useFilmProjectStore.getState().getProjectById(executionContext.projectId)
      : null
    const continuation = await input.adapter.continueWithToolResults({
      ...turnInput,
      conversationSummary: firstTurn.conversationSummary || currentProject?.conversationSummary || '',
      projectContext: currentProject,
      toolResults: firstExecution.results,
    })
    throwIfStopped()
    const remainingCalls = continuation.toolCalls.slice(0, 20 - firstTurn.toolCalls.length)
    const secondExecution = await executeAvailableToolCalls(remainingCalls)
    throwIfStopped()
    message = continuation.message || message
    conversationSummary = continuation.conversationSummary || conversationSummary
    toolResults = [...toolResults, ...secondExecution.results]
    validationErrors.push(...continuation.validationErrors, ...secondExecution.validationErrors)
  } else if (firstTurn.toolCalls.length === 0 && shouldRecoverFromPassiveClarification(
    firstTurn.message,
    input.userMessage,
    turnInput.conversationSummary,
  )) {
    // Some API models ignore the autonomy rules and repeatedly ask for an
    // intake checklist. Give the model one bounded retry with a verified
    // local project read and an explicit instruction to proceed. This never
    // loops and does not create provider/generation side effects by itself.
    const recoveryRead = await executeAgentToolCalls([{
      id: 'autonomy-recovery-project-read',
      name: 'film.get_project' as const,
      arguments: {},
      idempotencyKey: 'autonomy-recovery-project-read',
    }], executionContext)
    throwIfStopped()
    const currentProject = executionContext.projectId
      ? useFilmProjectStore.getState().getProjectById(executionContext.projectId)
      : null
    const continuation = await input.adapter.continueWithToolResults({
      ...turnInput,
      userMessage: `${input.userMessage}\n\nINTERNAL AUTONOMY RECOVERY: Your previous reply stalled by asking for an intake checklist. Do not ask for those details again. Use sensible assumptions and return a concrete creative proposal in the user's language. Only create or update structured FilmProject state if the latest user request explicitly commits to creating the proposed direction.`,
      projectContext: currentProject,
      toolResults: recoveryRead.results,
    })
    throwIfStopped()
    const secondExecution = await executeAvailableToolCalls(continuation.toolCalls.slice(0, 19))
    throwIfStopped()
    message = continuation.message || message
    conversationSummary = continuation.conversationSummary || conversationSummary
    toolResults = [...toolResults, ...recoveryRead.results, ...secondExecution.results]
    validationErrors.push(...recoveryRead.validationErrors, ...continuation.validationErrors, ...secondExecution.validationErrors)
  }

  const project = executionContext.projectId
    ? useFilmProjectStore.getState().getProjectById(executionContext.projectId)
    : null
  if (project && conversationSummary) {
    useFilmProjectStore.getState().updateProject(project.id, (current) => ({
      ...current,
      conversationSummary: conversationSummary.slice(0, 12_000),
    }))
  }

  const pendingPatch = useAgentStore.getState().pendingPatchesByWorkflow[input.workflow.id] || null
  return {
    message: message || (toolResults.some((result) => result.success)
      ? 'Film project structure updated. Review Tasks, Context, Scenes, and the workflow proposal before applying changes.'
      : 'No structured project changes were applied.'),
    conversationSummary,
    project,
    pendingPatch,
    toolResults,
    validationErrors,
  }
}
