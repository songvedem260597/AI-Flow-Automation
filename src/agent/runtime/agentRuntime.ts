import type { Workflow, WorkflowNode } from '@/types'
import type { AgentModelAdapter } from '@/agent/runtime/types'
import { listAgentTools } from '@/agent/runtime/agentToolRegistry'
import { executeAgentToolCalls } from '@/agent/runtime/agentToolExecutor'
import { compactWorkflowContext } from '@/agent/tools/workflowTools'
import { useAgentStore } from '@/agent/stores/agentStore'
import { useFilmProjectStore } from '@/agent/stores/filmProjectStore'
import type { AgentMode, FilmProject } from '@/agent/schemas/filmProjectSchemas'
import type { AgentToolResult, WorkflowPatch } from '@/agent/schemas/agentToolSchemas'

export interface RunFilmAgentTurnInput {
  workflow: Workflow
  selectedNode?: WorkflowNode | null
  userMessage: string
  conversationSummary?: string
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

export const runFilmAgentTurn = async (input: RunFilmAgentTurnInput): Promise<RunFilmAgentTurnResult> => {
  await Promise.all([
    useFilmProjectStore.getState().hydrate(),
    useAgentStore.getState().hydrate(),
  ])
  const initialProject = useFilmProjectStore.getState().getProjectForWorkflow(input.workflow.id)
  const turnInput = {
    userMessage: input.userMessage,
    conversationSummary: initialProject?.conversationSummary || input.conversationSummary || '',
    projectContext: initialProject,
    workflowContext: compactWorkflowContext(input.workflow),
    selectedNodeContext: compactSelectedNode(input.selectedNode),
    availableTools: toolsForMode(input.mode),
    agentMode: input.mode,
  }

  const firstTurn = await input.adapter.createTurn(turnInput)
  const firstExecution = await executeAgentToolCalls(firstTurn.toolCalls, {
    workflow: input.workflow,
    mode: input.mode,
  })
  let message = firstTurn.message
  let conversationSummary = firstTurn.conversationSummary
  let toolResults = firstExecution.results
  const validationErrors = [...firstTurn.validationErrors, ...firstExecution.validationErrors]

  if (firstTurn.toolCalls.length > 0 && firstTurn.toolCalls.length < 20) {
    const currentProject = useFilmProjectStore.getState().getProjectForWorkflow(input.workflow.id)
    const continuation = await input.adapter.continueWithToolResults({
      ...turnInput,
      conversationSummary: firstTurn.conversationSummary || currentProject?.conversationSummary || '',
      projectContext: currentProject,
      toolResults: firstExecution.results,
    })
    const remainingCalls = continuation.toolCalls.slice(0, 20 - firstTurn.toolCalls.length)
    const secondExecution = await executeAgentToolCalls(remainingCalls, {
      workflow: input.workflow,
      mode: input.mode,
    })
    message = continuation.message || message
    conversationSummary = continuation.conversationSummary || conversationSummary
    toolResults = [...toolResults, ...secondExecution.results]
    validationErrors.push(...continuation.validationErrors, ...secondExecution.validationErrors)
  }

  const project = useFilmProjectStore.getState().getProjectForWorkflow(input.workflow.id)
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
    project: useFilmProjectStore.getState().getProjectForWorkflow(input.workflow.id),
    pendingPatch,
    toolResults,
    validationErrors,
  }
}
