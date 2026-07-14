import type {
  AgentToolContinuationInput,
  AgentTurnInput,
  AgentTurnResult,
} from '@/agent/schemas/agentToolSchemas'

export { parseAgentTurnResult } from '@/agent/schemas/agentToolSchemas'
export type { AgentToolContinuationInput, AgentTurnInput, AgentTurnResult }

export interface AgentModelAdapter {
  createTurn(input: AgentTurnInput): Promise<AgentTurnResult>
  continueWithToolResults(input: AgentToolContinuationInput): Promise<AgentTurnResult>
}
