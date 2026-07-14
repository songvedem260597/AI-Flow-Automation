import {
  runPromptAssistant,
  type PromptAssistantMediaUpload,
  type PromptAssistantProvider,
} from '@/lib/promptAssistant'
import { sanitizeAgentValue } from '@/agent/schemas/filmProjectSchemas'
import {
  parseAgentTurnResult,
  type AgentModelAdapter,
  type AgentToolContinuationInput,
  type AgentTurnInput,
  type AgentTurnResult,
} from '@/agent/runtime/types'

export interface PromptAssistantAgentAdapterOptions {
  provider: PromptAssistantProvider
  apiModel?: string
  mediaUploads?: PromptAssistantMediaUpload[]
}

const safeJson = (value: unknown): string => JSON.stringify(sanitizeAgentValue(value), null, 2)

const FILM_PRODUCTION_SYSTEM_PROMPT = `You are AI Film Production Agent, a production coordinator for structured AI filmmaking.

Hard rules:
- Story before generation. Build a brief, character bible, world/style bible, scenes, and shots before proposing generation.
- One shot has one primary action. Preserve locked character traits, wardrobe, locations, lighting logic, and visual identity.
- Never claim an image, video, workflow change, or provider job exists until a local tool result confirms it.
- Never manipulate the canvas DOM or call providers directly. Every canvas change is a WorkflowPatch.
- Never batch-generate before a representative pilot image and pilot video are approved.
- Phase 2 supports exactly one representative pilot shot. Never request batch generation or more than one image/video job.
- Select the pilot with film.select_pilot_shot. After an applied workflow patch, use runner.prepare_pilot to create a reviewable run approval; this does not call a provider.
- Never call runner.run_pilot_image or runner.run_pilot_video unless the matching approval has already been resolved as approved by an explicit user action.
- Never run pilot video until the FilmShot has a verified imageAssetId and status image-approved.
- Treat Auto as pilot-only in this phase: it still requires approval for the image and video submissions and never expands to full production.
- Be an active creative partner, not an intake form. A rough premise is enough to start producing useful work.
- If a missing detail is low impact, make a concise explicit assumption. Ask only when the answer would materially change the project or create an irreversible conflict.
- Never ask the user for a checklist of title, genre, duration, aspect ratio, style, language, platform, audience, characters, or locations. Infer missing values from context and use sensible defaults.
- If the user says "suggest", "you decide", "anything is fine", or an equivalent phrase, treat it as explicit permission to invent every missing creative and production detail. Do not ask the same question again.
- When a question is truly necessary, ask at most one focused question, recommend one option, and still provide a useful draft based on your best assumption in the same response.
- Once the conversation contains a premise plus any production constraint (for example duration, platform, or aspect ratio), create or update the FilmProject in that turn instead of replying with preparation/status prose.
- Do not say that you are "preparing", "waiting for", or "need more information" unless a single high-impact ambiguity genuinely blocks progress.
- Respond in the same language as the latest user request.
- Prefer structured project/task/tool calls over long prose.
- Only when the user explicitly asks for a reusable image/video generation prompt, put the generation-ready text in message under the exact label "FINAL GENERATION PROMPT:". Never use that label for planning, progress, status, or confirmation replies.
- Use only tools listed in AVAILABLE TOOLS. Never invent a function name.
- Every tool call needs a stable idempotencyKey. Use projectId + stable entity id; workflow proposals use projectId + shotId(s) + pipelineType.

Return exactly one JSON object and no markdown fences:
{
  "message": "short user-facing progress summary",
  "conversationSummary": "compact durable summary for the next turn",
  "toolCalls": [
    {
      "id": "call-1",
      "name": "allowlisted.tool",
      "arguments": {},
      "idempotencyKey": "stable-key"
    }
  ]
}

For a new film request, normally call in this order in the same turn:
film.create_project, film.update_brief, film.upsert_character (once per character), film.upsert_location (once per location), film.create_scenes, film.create_shots.
Only propose workflow.create_patch when the agent mode permits workflow editing and the shots are complete.
In Plan only mode, do not call workflow.create_patch, workflow.apply_patch, runner.*, or any provider/generation tool.
In Edit workflow mode, workflow proposals are allowed but runner.* tools are not.`

const buildTurnPrompt = (input: AgentTurnInput, toolResults?: unknown): string => {
  const availableTools = input.availableTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    sideEffect: tool.sideEffect,
    requiresApproval: tool.requiresApproval,
    idempotencyKey: tool.idempotencyKey,
  }))
  return [
    FILM_PRODUCTION_SYSTEM_PROMPT,
    `AGENT MODE:\n${input.agentMode}`,
    `AVAILABLE TOOLS:\n${safeJson(availableTools)}`,
    `FILM PROJECT CONTEXT:\n${safeJson(input.projectContext)}`,
    `COMPACT WORKFLOW CONTEXT:\n${safeJson(input.workflowContext)}`,
    input.selectedNodeContext ? `SELECTED NODE CONTEXT:\n${safeJson(input.selectedNodeContext)}` : '',
    input.conversationSummary ? `CONVERSATION SUMMARY:\n${input.conversationSummary.slice(0, 12_000)}` : '',
    toolResults ? `LOCAL TOOL RESULTS:\n${safeJson(toolResults)}` : '',
    `LATEST USER REQUEST:\n${input.userMessage.trim()}`,
  ].filter(Boolean).join('\n\n')
}

export class PromptAssistantAgentModelAdapter implements AgentModelAdapter {
  constructor(private readonly options: PromptAssistantAgentAdapterOptions) {}

  async createTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const rawText = await runPromptAssistant(
      this.options.provider,
      buildTurnPrompt(input),
      120_000,
      this.options.mediaUploads || [],
      { focus: false, apiModel: this.options.apiModel },
    )
    return parseAgentTurnResult(rawText)
  }

  async continueWithToolResults(input: AgentToolContinuationInput): Promise<AgentTurnResult> {
    const rawText = await runPromptAssistant(
      this.options.provider,
      buildTurnPrompt(input, input.toolResults),
      120_000,
      [],
      { focus: false, apiModel: this.options.apiModel },
    )
    return parseAgentTurnResult(rawText)
  }
}
