import type { Workflow, WorkflowNode, WorkflowEdge, FlowNodeData, AIProvider } from '@/types'
import { getAdapter, type ProviderAdapter } from '@/providers'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useHistoryStore } from '@/stores/dataStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { hasExtensionContext, isContextInvalidated } from '@/lib/extensionContextGuard'

// Same helpers, plain JS names (avoid TS-only `unknown` typing here)
const hasExtensionContextSafe = (): boolean => hasExtensionContext()
const isContextInvalidatedSafe = (err: unknown): boolean => isContextInvalidated(err)

type MediaKind = 'image' | 'video'

// ── Pipeline event callbacks ─────────────────────────────────────────────
// Emitted during pipeline execution so the UI can update node/edge visual
// state in real time. All callbacks are fire-and-forget — throwing from a
// callback does NOT abort the pipeline.
export interface PipelineCallbacks {
  /** Fires immediately before a node starts executing. */
  onNodeStart?: (nodeId: string, nodeType: string) => void
  /** Fires immediately after a node succeeds. `output` is the value stored in pipeline context. */
  onNodeComplete?: (nodeId: string, output: unknown) => void
  /** Fires immediately after a node fails. */
  onNodeFail?: (nodeId: string, error: string) => void
  /** Fires when an edge starts carrying data to its target node. */
  onEdgeActive?: (edgeId: string) => void
  /** Fires when an edge stops carrying data. */
  onEdgeInactive?: (edgeId: string) => void
}

interface ResolvedInput {
  edge: WorkflowEdge
  sourceNode: WorkflowNode
  targetHandle: string
  sourceHandle: string
  value: unknown
}

interface NodeInputs {
  items: ResolvedInput[]
  all: unknown[]
  byHandle: Record<string, unknown[]>
}

interface MediaInput {
  mediaType: MediaKind
  data?: string
  url?: string
  name?: string
  mimeType?: string
  aspectRatio?: string
  targetHandle?: string
}

interface RuntimeResponse {
  success?: boolean
  error?: string
  status?: string
  jobId?: string
  accepted?: boolean
  tabId?: number
  [key: string]: unknown
}

const GOOGLE_FLOW_DEFAULT_IMAGE_MODEL = 'Nano Banana 2'
const GOOGLE_FLOW_DEFAULT_VIDEO_MODEL = 'Omni Flash'
const DEFAULT_IMAGE_RATIO = '1:1'
const DEFAULT_VIDEO_RATIO = '16:9'
const DEFAULT_VIDEO_DURATION = '8s'
const FLOW_OUTPUT_FOLDER = 'ai-flow-workflow'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function compactStrings(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean)
}

function normalizeProvider(value: unknown, fallback: AIProvider): AIProvider {
  const provider = String(value || fallback) as AIProvider
  return provider || fallback
}

function normalizeMediaType(value: unknown): MediaKind {
  return String(value || 'image').toLowerCase() === 'video' ? 'video' : 'image'
}

function dataUrlToUploadPayload(media: MediaInput, key: string) {
  const data = media.data || ''
  const match = data.match(/^data:([^;]+);base64,(.*)$/s)
  if (!match) {
    throw new Error(`Media "${media.name || key}" is not a base64 data URL`)
  }

  const mimeType = media.mimeType || match[1] || (media.mediaType === 'video' ? 'video/mp4' : 'image/png')
  const extension = mimeType.includes('quicktime')
    ? 'mov'
    : mimeType.includes('jpeg')
      ? 'jpg'
      : mimeType.split('/')[1] || (media.mediaType === 'video' ? 'mp4' : 'png')
  const name = media.name || `${media.mediaType}-${key}.${extension}`

  return {
    key,
    name,
    type: mimeType,
    base64: match[2]
  }
}

export class PipelineRunner {
  private workflow: Workflow
  private adapter: ProviderAdapter
  private context: Record<string, unknown> = {}
  isRunning = false
  private isPaused = false
  private shouldStop = false
  private taskId: string
  private wakeLock: WakeLockSentinel | null = null
  private callbacks: PipelineCallbacks

  constructor(workflow: Workflow, taskId: string, callbacks: PipelineCallbacks = {}) {
    this.workflow = workflow
    this.taskId = taskId
    this.callbacks = callbacks
    this.adapter = getAdapter(this.detectProvider())
  }

  private detectProvider(): AIProvider {
    const generateNode = this.workflow.nodes.find((node) => node.type === 'generate')
    const promptNode = this.workflow.nodes.find((node) => node.type === 'prompt')
    const providerNode = generateNode || promptNode

    if (providerNode) {
      const data = providerNode.data as Record<string, unknown>
      if (data.provider) return data.provider as AIProvider
    }

    return useSettingsStore.getState().defaultProvider
  }

  private getEnabledNodes(): WorkflowNode[] {
    return this.workflow.nodes.filter((node) => (node.data as Record<string, unknown>).enabled !== false)
  }

  private getEnabledEdges(nodes = this.getEnabledNodes()): WorkflowEdge[] {
    const ids = new Set(nodes.map((node) => node.id))
    return this.workflow.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  }

  /** Returns all edge IDs that carry data INTO a node (incoming edges). */
  private getIncomingEdgeIds(nodeId: string): string[] {
    return this.workflow.edges.filter((e) => e.target === nodeId).map((e) => e.id)
  }

  /** Returns all edge IDs that carry data OUT OF a node (outgoing edges). */
  private getOutgoingEdgeIds(nodeId: string): string[] {
    return this.workflow.edges.filter((e) => e.source === nodeId).map((e) => e.id)
  }

  private emitStart(nodeId: string, nodeType: string) {
    console.log('[GlowDebug][Runner] start', { nodeId })
    try { this.callbacks.onNodeStart?.(nodeId, nodeType) } catch {}
    for (const edge of this.workflow.edges.filter((e) => e.target === nodeId)) {
      console.log('[GlowDebug][Runner] edgeActive', { edgeId: edge.id, source: edge.source, target: edge.target })
      try { this.callbacks.onEdgeActive?.(edge.id) } catch {}
    }
  }

  private emitComplete(nodeId: string, output: unknown) {
    console.log('[GlowDebug][Runner] complete', { nodeId, output })
    try { this.callbacks.onNodeComplete?.(nodeId, output) } catch {}
    for (const edge of this.workflow.edges.filter((e) => e.source === nodeId)) {
      console.log('[GlowDebug][Runner] edgeInactive', { edgeId: edge.id, source: edge.source, target: edge.target })
      try { this.callbacks.onEdgeInactive?.(edge.id) } catch {}
    }
  }

  private emitInactive(nodeId: string) {
    for (const edge of this.workflow.edges.filter((e) => e.target === nodeId)) {
      console.log('[GlowDebug][Runner] edgeInactive', { edgeId: edge.id, source: edge.source, target: edge.target })
      try { this.callbacks.onEdgeInactive?.(edge.id) } catch {}
    }
    for (const edge of this.workflow.edges.filter((e) => e.source === nodeId)) {
      console.log('[GlowDebug][Runner] edgeInactive', { edgeId: edge.id, source: edge.source, target: edge.target })
      try { this.callbacks.onEdgeInactive?.(edge.id) } catch {}
    }
  }

  private getSortedNodes(): WorkflowNode[] {
    const nodes = this.getEnabledNodes()
    if (nodes.length === 0) throw new Error('Workflow is empty')

    const edges = this.getEnabledEdges(nodes)
    const nodeMap = new Map(nodes.map((node) => [node.id, node]))
    const originalIndex = new Map(nodes.map((node, index) => [node.id, index]))
    const inDegree = new Map(nodes.map((node) => [node.id, 0]))
    const outgoing = new Map<string, WorkflowEdge[]>()

    for (const edge of edges) {
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1)
      const list = outgoing.get(edge.source) || []
      list.push(edge)
      outgoing.set(edge.source, list)
    }

    const compareNodes = (a: WorkflowNode, b: WorkflowNode) => {
      if (a.position.x !== b.position.x) return a.position.x - b.position.x
      if (a.position.y !== b.position.y) return a.position.y - b.position.y
      return (originalIndex.get(a.id) || 0) - (originalIndex.get(b.id) || 0)
    }

    const queue = nodes
      .filter((node) => (inDegree.get(node.id) || 0) === 0)
      .sort(compareNodes)
    const sorted: WorkflowNode[] = []

    while (queue.length > 0) {
      const node = queue.shift()!
      sorted.push(node)

      const nextEdges = (outgoing.get(node.id) || []).sort((a, b) => {
        const left = nodeMap.get(a.target)
        const right = nodeMap.get(b.target)
        if (!left || !right) return 0
        return compareNodes(left, right)
      })

      for (const edge of nextEdges) {
        const nextDegree = (inDegree.get(edge.target) || 0) - 1
        inDegree.set(edge.target, nextDegree)
        if (nextDegree === 0) {
          const nextNode = nodeMap.get(edge.target)
          if (nextNode) {
            queue.push(nextNode)
            queue.sort(compareNodes)
          }
        }
      }
    }

    if (sorted.length !== nodes.length) {
      throw new Error('Workflow contains a cycle. Remove circular connections before running.')
    }

    return sorted
  }

  private getNodeInputs(node: WorkflowNode): NodeInputs {
    const nodes = this.getEnabledNodes()
    const nodeMap = new Map(nodes.map((item) => [item.id, item]))
    const incoming = this.getEnabledEdges(nodes)
      .filter((edge) => edge.target === node.id && this.context[edge.source] !== undefined)
      .sort((a, b) => {
        const handleCompare = (a.targetHandle || 'input_1').localeCompare(b.targetHandle || 'input_1')
        if (handleCompare !== 0) return handleCompare
        const left = nodeMap.get(a.source)
        const right = nodeMap.get(b.source)
        if (!left || !right) return 0
        if (left.position.y !== right.position.y) return left.position.y - right.position.y
        return left.position.x - right.position.x
      })

    const items: ResolvedInput[] = []
    const byHandle: Record<string, unknown[]> = {}

    for (const edge of incoming) {
      const sourceNode = nodeMap.get(edge.source)
      if (!sourceNode) continue
      const targetHandle = edge.targetHandle || 'input_1'
      const sourceHandle = edge.sourceHandle || 'output_1'
      const value = this.context[edge.source]

      items.push({ edge, sourceNode, targetHandle, sourceHandle, value })
      byHandle[targetHandle] = [...(byHandle[targetHandle] || []), value]
    }

    return {
      items,
      all: items.map((item) => item.value),
      byHandle
    }
  }

  async run(): Promise<void> {
    this.isRunning = true
    this.shouldStop = false

    const pipelineStore = usePipelineStore.getState()
    const settings = useSettingsStore.getState()

    try {
      await this.acquireWakeLock()
      pipelineStore.startPipeline(this.taskId)
      pipelineStore.addLog(this.taskId, 'info', `Workflow started: ${this.workflow.name}`)

      const sortedNodes = this.getSortedNodes()
      const totalNodes = sortedNodes.length
      pipelineStore.addLog(
        this.taskId,
        'info',
        `Execution order: ${sortedNodes.map((node) => node.data.label || node.type).join(' -> ')}`
      )

      const retryByNode = new Map<string, number>()

      for (let i = 0; i < sortedNodes.length; i++) {
        if (this.shouldStop) {
          pipelineStore.stopPipeline(this.taskId)
          pipelineStore.addLog(this.taskId, 'warn', 'Workflow stopped by user')
          break
        }

        while (this.isPaused) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          if (this.shouldStop) break
        }

        const node = sortedNodes[i]
        const inputs = this.getNodeInputs(node)
        const progress = Math.round(((i + 1) / totalNodes) * 100)

        pipelineStore.updateProgress(this.taskId, node.id, progress, this.context)
        pipelineStore.addLog(this.taskId, 'info', `Executing: ${node.data.label}`, node.id, {
          inputCount: inputs.items.length
        })

        // Emit visual state events
        this.emitStart(node.id, node.type)

        try {
          const result = await this.executeNode(node, inputs)
          this.context[node.id] = result
          pipelineStore.updateProgress(this.taskId, node.id, progress, {
            ...this.context,
            [node.id]: result
          })
          pipelineStore.addLog(this.taskId, 'success', `Completed: ${node.data.label}`, node.id)

          // Emit success events
          this.emitComplete(node.id, result)
          this.emitInactive(node.id)
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          pipelineStore.addLog(this.taskId, 'error', `Failed: ${node.data.label} - ${errorMessage}`, node.id)

          // Generate-node retries with media uploads are NOT idempotent:
          // re-running the node re-uploads the reference images into the
          // ChatGPT composer / Flow tab, producing N×attempts duplicate
          // attachments. Disable node-level retry for any Generate Node
          // whose media-input count is > 0. Per-step recovery (tab
          // complete, content-script ping, find composer, find send
          // button) still happens inside the provider path; the gate
          // here only closes the cross-node retry loop.
          let isNonRetryableGenerate = false
          try {
            isNonRetryableGenerate = this.isNonRetryableGenerateNode(node)
          } catch (_) {
            isNonRetryableGenerate = false
          }
          if (isNonRetryableGenerate) {
            pipelineStore.addLog(
              this.taskId,
              'warn',
              `Generate node has media uploads — skipping node-level retry to avoid duplicate attachments. ` +
                `Cause: ${errorMessage}`,
              node.id
            )
            try { this.callbacks.onNodeFail?.(node.id, errorMessage) } catch {}
            console.log('[GlowDebug][Runner] fail', { nodeId: node.id, error: errorMessage })
            this.emitInactive(node.id)
            pipelineStore.failPipeline(this.taskId, {
              nodeId: node.id,
              message: errorMessage,
              timestamp: Date.now(),
              recoverable: false
            })
            break
          }

          const retries = retryByNode.get(node.id) || 0
          if (retries < settings.maxRetries) {
            retryByNode.set(node.id, retries + 1)
            pipelineStore.addLog(this.taskId, 'warn', `Retrying (${retries + 1}/${settings.maxRetries})...`, node.id)
            await new Promise((resolve) => setTimeout(resolve, settings.retryDelay))
            i--
            continue
          }

          try { this.callbacks.onNodeFail?.(node.id, errorMessage) } catch {}
          console.log('[GlowDebug][Runner] fail', { nodeId: node.id, error: errorMessage })
          this.emitInactive(node.id)
          pipelineStore.failPipeline(this.taskId, {
            nodeId: node.id,
            message: errorMessage,
            timestamp: Date.now(),
            recoverable: false
          })
          break
        }
      }

      if (!this.shouldStop) {
        const task = pipelineStore.getActiveTask()
        if (task && task.status !== 'failed') {
          pipelineStore.completePipeline(this.taskId, this.context)

          useHistoryStore.getState().addEntry({
            workflowId: this.workflow.id,
            workflowName: this.workflow.name,
            status: 'completed',
            duration: task.startedAt ? Date.now() - task.startedAt : undefined,
            nodeResults: this.context,
            errorCount: 0
          })

          pipelineStore.addLog(this.taskId, 'success', 'Workflow completed successfully')
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      pipelineStore.failPipeline(this.taskId, {
        nodeId: '',
        message: errorMessage,
        timestamp: Date.now(),
        recoverable: false
      })
      pipelineStore.addLog(this.taskId, 'error', `Workflow failed: ${errorMessage}`)
    } finally {
      await this.releaseWakeLock()
      await this.adapter.cleanup()
      this.isRunning = false
    }
  }

  private async executeNode(node: WorkflowNode, inputs: NodeInputs): Promise<unknown> {
    const data = node.data as FlowNodeData

    switch (node.type) {
      case 'prompt':
        return this.executePromptNode(data as Record<string, unknown>, inputs)

      case 'image':
        return this.executeMediaNode(data as Record<string, unknown>)

      case 'generate':
        return this.executeGenerateNode(node, data as Record<string, unknown>, inputs)

      case 'delay': {
        const delayData = data as { duration: number }
        const duration = Number(delayData.duration || 0)
        if (duration > 0) await new Promise((resolve) => setTimeout(resolve, duration))
        return { type: 'delay', delayed: duration }
      }

      case 'download':
        return this.executeDownloadNode(data as Record<string, unknown>, inputs)

      case 'wait': {
        const waitData = data as { condition?: string; selector?: string; timeout?: number }
        await this.waitForCondition(waitData)
        return { type: 'wait', waited: true }
      }

      default:
        return { type: node.type, executed: true, inputs: inputs.all }
    }
  }

  private executePromptNode(data: Record<string, unknown>, inputs: NodeInputs) {
    const upstreamText = compactStrings(inputs.items.map((input) => this.coerceText(input.value)))
    const ownPrompt = this.interpolateVariables(asString(data.prompt))
    const parts = compactStrings(upstreamText.length > 0 && !ownPrompt.trim()
      ? upstreamText
      : [...upstreamText, ownPrompt])
    const text = parts.join('\n\n')

    return {
      type: 'text',
      text,
      prompt: text,
      provider: data.provider,
      model: data.model
    }
  }

  private executeMediaNode(data: Record<string, unknown>) {
    const mediaType = normalizeMediaType(data.mediaType || (data.videoData || data.videoUrl ? 'video' : 'image'))
    const mediaData = asString(data.mediaData) || asString(data.imageData) || asString(data.videoData)
    const mediaUrl = asString(data.mediaUrl) || asString(data.imageUrl) || asString(data.videoUrl)
    const mediaName = asString(data.mediaName) || asString(data.imageName) || asString(data.videoName) || 'media'
    const mimeType = asString(data.mediaMimeType)
      || (mediaData.match(/^data:([^;]+);base64,/)?.[1] || '')
      || (mediaType === 'video' ? 'video/mp4' : 'image/png')

    return {
      type: 'media',
      mediaType,
      data: mediaData,
      url: mediaUrl,
      name: mediaName,
      mimeType,
      aspectRatio: asString(data.aspectRatio) || (mediaType === 'video' ? DEFAULT_VIDEO_RATIO : DEFAULT_IMAGE_RATIO),
      poster: asString(data.mediaPoster) || asString(data.videoPoster)
    }
  }

  private async executeGenerateNode(
    node: WorkflowNode,
    data: Record<string, unknown>,
    inputs: NodeInputs
  ): Promise<unknown> {
    const fallbackProvider = this.detectProvider()
    const provider = normalizeProvider(data.provider, fallbackProvider)
    const mediaType = provider === 'google-flow' && normalizeMediaType(data.mediaType) === 'video'
      ? 'video'
      : 'image'
    const prompt = this.resolveGeneratePrompt(data, inputs)
    const mediaInputs = this.resolveGenerateMediaInputs(provider, mediaType, data, inputs)

    if (!prompt.trim()) {
      throw new Error(`Generate node "${node.data.label}" has no prompt input`)
    }

    if (provider === 'chatgpt') {
      return this.runChatGPTGenerate(data, prompt, mediaInputs)
    }

    if (provider === 'google-flow') {
      return this.runGoogleFlowGenerate(node, data, prompt, mediaType, mediaInputs)
    }

    throw new Error(`Provider "${provider}" is not supported by workflow run yet`)
  }

  private resolveGeneratePrompt(data: Record<string, unknown>, inputs: NodeInputs): string {
    const promptPortText = compactStrings(
      inputs.items
        .filter((input) => input.targetHandle === 'input_2')
        .map((input) => this.coerceText(input.value))
    )
    const allText = compactStrings(inputs.items.map((input) => this.coerceText(input.value)))
    const ownPrompt = this.interpolateVariables(asString(data.prompt))

    if (promptPortText.length > 0) return promptPortText.join('\n\n')
    if (ownPrompt.trim()) return ownPrompt
    return allText.join('\n\n')
  }

  private resolveGenerateMediaInputs(
    provider: AIProvider,
    mediaType: MediaKind,
    data: Record<string, unknown>,
    inputs: NodeInputs
  ): MediaInput[] {
    const allMedia: MediaInput[] = []
    for (const input of inputs.items) {
      const media = this.coerceMedia(input.value)
      if (media) allMedia.push({ ...media, targetHandle: input.targetHandle })
    }

    if (provider === 'chatgpt') {
      return allMedia.filter((media) => media.mediaType === 'image')
    }

    if (provider !== 'google-flow') return allMedia

    if (mediaType === 'image') {
      return allMedia.filter((media) => media.mediaType === 'image')
    }

    const model = asString(data.model) || GOOGLE_FLOW_DEFAULT_VIDEO_MODEL
    return allMedia.filter((media) => {
      if (media.targetHandle === 'input_1') return media.mediaType === 'image'
      if (media.targetHandle === 'input_3') return model === 'Omni Flash' && media.mediaType === 'video'
      return media.mediaType === 'image' || (model === 'Omni Flash' && media.mediaType === 'video')
    })
  }

  // Returns true when a Generate Node has media inputs that would be
  // side-effect-reuploaded by a node-level retry. Used by the runner's
  // catch block to disable retries for Generate Nodes with media.
  //
  // Provider rules (mirrors resolveGenerateMediaInputs above):
  //   - chatgpt: any image media in inputs
  //   - google-flow: any media that would survive the per-provider filter
  //
  // Inputs are re-derived from the current context (this.context) which
  // is set by the time the catch block runs, so the result is faithful
  // to what executeGenerateNode would have computed.
  private isNonRetryableGenerateNode(node: WorkflowNode): boolean {
    if (!node || node.type !== 'generate') return false
    const fallbackProvider = this.detectProvider()
    const data = (node.data || {}) as Record<string, unknown>
    const provider = normalizeProvider(data.provider, fallbackProvider)
    if (provider !== 'chatgpt' && provider !== 'google-flow') return false

    const mediaType = provider === 'google-flow' && normalizeMediaType(data.mediaType) === 'video'
      ? 'video'
      : 'image'

    const inputs = this.getNodeInputs(node)
    const mediaInputs = this.resolveGenerateMediaInputs(provider, mediaType, data, inputs)
    if (mediaInputs.length === 0) return false

    // Extra defensive filter: only count media that has actual upload
    // payload. Media without `data` cannot be uploaded, so retrying
    // would not re-trigger an upload (safe to retry).
    const uploadable = mediaInputs.filter((m) => Boolean(m.data))
    return uploadable.length > 0
  }

  private async runChatGPTGenerate(
    data: Record<string, unknown>,
    prompt: string,
    mediaInputs: MediaInput[]
  ): Promise<unknown> {
    const settings = useSettingsStore.getState()
    const configuredTimeoutMs = Number(data.timeout || settings.timeoutDuration || 300000)
    const timeoutMs = Math.max(configuredTimeoutMs > 0 ? configuredTimeoutMs : 300000, 300000)

    // Route ChatGPT media uploads through the background's
    // RUN_CHATGPT_PROMPT path instead of the direct provider adapter path.
    // The adapter path is unreliable: it tries to inject a hardcoded
    // 'content-scripts/content-script.js' (which does not exist in the
    // built extension) and then send chrome.tabs.sendMessage to a tab
    // whose content script may not yet be registered, producing
    // "Could not establish connection. Receiving end does not exist."
    //
    // The background's runChatGPTPrompt already calls
    // ensureChatGPTContentReady (wait tab complete + CHATGPT_PING retry
    // + runtime-resolved content script injection) before sending
    // CHATGPT_SUBMIT_AND_WAIT, so the tab is guaranteed to have a
    // listener when the upload + submit fires.
    const mediaUploads = mediaInputs
      .filter((media) => Boolean(media.data))
      .map((media, index) => {
        const payload = dataUrlToUploadPayload(
          media,
          `workflow_media_${index}_${Date.now()}`
        )
        return {
          name: payload.name,
          type: payload.type,
          base64: payload.base64,
        }
      })

    const response = await this.sendRuntimeMessage({
      action: 'RUN_CHATGPT_PROMPT',
      payload: {
        prompt,
        ratio: asString(data.aspectRatio) || DEFAULT_IMAGE_RATIO,
        autoDownload: false,
        timeoutMs,
        mediaUploads,
        // Workflow Editor / Side Panel callers — keep the user's tab
        // visible while the ChatGPT tab runs in the background.
        focus: false
      }
    })

    if (!response.success || !response.jobId) {
      throw new Error(response.error || 'ChatGPT automation failed to start')
    }

    if (data.waitForCompletion === false) {
      return {
        type: 'generation',
        provider: 'chatgpt',
        mediaType: 'image',
        prompt,
        jobId: response.jobId,
        triggered: true,
        images: []
      }
    }

    const job = await this.waitForChatGPTJob(String(response.jobId), timeoutMs)
    const imageUrls = Array.isArray(job.imageUrls) ? job.imageUrls : []
    return {
      type: 'generation',
      provider: 'chatgpt',
      mediaType: 'image',
      aspectRatio: asString(data.aspectRatio) || DEFAULT_IMAGE_RATIO,
      prompt,
      jobId: response.jobId,
      imageUrls,
      // Normalized media array for downstream nodes (Download, etc.)
      images: imageUrls.map((url: string) => ({ url, source: 'chatgpt' })),
      result: job
    }
  }

  private async runGoogleFlowGenerate(
    node: WorkflowNode,
    data: Record<string, unknown>,
    prompt: string,
    mediaType: MediaKind,
    mediaInputs: MediaInput[]
  ): Promise<unknown> {
    const model = asString(data.model)
      || (mediaType === 'video' ? GOOGLE_FLOW_DEFAULT_VIDEO_MODEL : GOOGLE_FLOW_DEFAULT_IMAGE_MODEL)
    const aspectRatio = asString(data.aspectRatio) || (mediaType === 'video' ? DEFAULT_VIDEO_RATIO : DEFAULT_IMAGE_RATIO)
    const duration = mediaType === 'video'
      ? asString(data.videoDuration) || asString(data.duration) || DEFAULT_VIDEO_DURATION
      : undefined
    const quantity = Math.max(1, Math.min(4, Number(data.quantity || 1)))
    const opened = await this.sendRuntimeMessage({
      action: 'OPEN_PROVIDER_TAB',
      payload: { provider: 'google-flow', focus: false }
    })

    if (!opened.success) {
      throw new Error(opened.error || 'Could not open Google Flow tab')
    }

    const fileIds: string[] = []
    const fileNameMap: Record<string, string> = {}
    const flowMediaInputs = mediaInputs.filter((media) => Boolean(media.data))

    for (let index = 0; index < flowMediaInputs.length; index++) {
      const media = flowMediaInputs[index]
      const payload = dataUrlToUploadPayload(media, `workflow_${node.id}_${index}_${Date.now()}`)
      const upload = await this.sendRuntimeMessage({
        action: 'FLOW_UPLOAD_IMAGE',
        payload
      })

      if (!upload.success || !upload.tileId) {
        throw new Error(upload.error || `Failed to upload media "${media.name || index}" to Google Flow`)
      }

      const tileId = String(upload.tileId)
      fileIds.push(tileId)
      fileNameMap[tileId] = String(upload.fileName || payload.name)
    }

    const shouldAutoDownload = data.waitForCompletion !== false || this.hasDirectDownstreamType(node.id, 'download')
    const payload = {
      tabId: opened.tabId,
      prompt,
      provider: 'google_flow',
      mode: mediaType,
      model,
      aspectRatio,
      quantity,
      duration,
      style: null,
      fileIds,
      referenceImages: fileIds,
      fileNameMap,
      autoDownload: shouldAutoDownload,
      outputFolder: FLOW_OUTPUT_FOLDER,
      resolution: '1k',
      videoResolution: '720p',
      videoDownloadResolution: '720p',
      // Workflow Editor / Side Panel callers — keep the user's tab
      // visible while the Flow tab runs in the background.
      focusTab: false,
      debugGenState: {
        mode: mediaType,
        isVideoMode: mediaType === 'video',
        imageModel: mediaType === 'image' ? model : GOOGLE_FLOW_DEFAULT_IMAGE_MODEL,
        videoModel: mediaType === 'video' ? model : GOOGLE_FLOW_DEFAULT_VIDEO_MODEL,
        activeModel: model,
        activeModelOptions: [],
        aspectRatio,
        quantity,
        videoDuration: duration,
        builtAt: new Date().toISOString()
      }
    }

    const response = await this.sendRuntimeMessage({
      action: 'RUN_FLOW_PROMPT',
      payload
    })

    const partialSuccess = response.status === 'AUTO_DOWNLOAD_PARTIAL_SUCCESS'
    if (!response.success && !partialSuccess) {
      throw new Error(response.error || response.status || 'Google Flow automation failed')
    }

    return {
      type: 'generation',
      provider: 'google-flow',
      mediaType,
      model,
      aspectRatio,
      videoDuration: duration,
      prompt,
      fileIds,
      fileNameMap,
      autoDownload: response.autoDownload,
      status: response.status,
      result: response
    }
  }

  private async executeDownloadNode(data: Record<string, unknown>, inputs: NodeInputs): Promise<unknown> {
    const upstreamAutoDownload = inputs.all.some((value) => {
      if (!isRecord(value)) return false
      return value.provider === 'google-flow' && Boolean(value.autoDownload)
    })

    if (upstreamAutoDownload) {
      return {
        type: 'download',
        downloaded: true,
        handledBy: 'google-flow-generate'
      }
    }

    const format = asString(data.format) || useSettingsStore.getState().downloadFormat || 'png'
    const filename = asString(data.filename) || `ai-flow-${Date.now()}`
    const sources = this.extractDownloadSources(inputs)

    if (sources.length > 0) {
      for (let index = 0; index < sources.length; index++) {
        await this.downloadSource(sources[index], format, sources.length === 1 ? filename : `${filename}-${index + 1}`)
      }
      return { type: 'download', downloaded: true, count: sources.length, format }
    }

    const result = await this.adapter.downloadResult?.()
    if (result) {
      await this.downloadFile(result, format, filename)
    }
    return { type: 'download', downloaded: Boolean(result), format }
  }

  private coerceText(value: unknown): string {
    if (typeof value === 'string') return value
    if (!isRecord(value)) return ''

    if (value.type === 'media') return ''
    return asString(value.text)
      || asString(value.prompt)
      || asString(value.result)
      || ''
  }

  private coerceMedia(value: unknown): MediaInput | null {
    if (!isRecord(value)) return null

    const mediaType = normalizeMediaType(value.mediaType || (value.videoData || value.videoUrl ? 'video' : 'image'))
    const data = asString(value.data)
      || asString(value.mediaData)
      || asString(value.imageData)
      || asString(value.videoData)
    const url = asString(value.url)
      || asString(value.mediaUrl)
      || asString(value.imageUrl)
      || asString(value.videoUrl)

    if (!data && !url) return null

    return {
      mediaType,
      data,
      url,
      name: asString(value.name) || asString(value.mediaName) || asString(value.imageName) || asString(value.videoName),
      mimeType: asString(value.mimeType) || asString(value.mediaMimeType),
      aspectRatio: asString(value.aspectRatio)
    }
  }

  private extractDownloadSources(inputs: NodeInputs): string[] {
    const sources: string[] = []

    const pushSource = (value: unknown) => {
      if (typeof value === 'string' && value) {
        sources.push(value)
        return
      }
      if (!isRecord(value)) return

      for (const key of ['data', 'mediaData', 'imageData', 'videoData', 'mediaUrl', 'imageUrl', 'videoUrl', 'result']) {
        const source = asString(value[key])
        if (source) sources.push(source)
      }

      const imageUrls = value.imageUrls
      if (Array.isArray(imageUrls)) {
        for (const url of imageUrls) {
          if (typeof url === 'string' && url) sources.push(url)
        }
      }
    }

    for (const value of inputs.all) pushSource(value)

    return Array.from(new Set(sources))
  }

  private async switchAdapter(provider: AIProvider): Promise<void> {
    if (this.adapter.name !== provider) {
      await this.adapter.cleanup()
      this.adapter = getAdapter(provider)
    }
    await this.adapter.open()
  }

  private async runAdapterGenerate(
    provider: AIProvider,
    data: Record<string, unknown>,
    prompt: string,
    mediaType: MediaKind,
    mediaInputs: MediaInput[]
  ): Promise<unknown> {
    await this.switchAdapter(provider)

    await this.adapter.setMediaType?.(mediaType)
    const aspectRatio = asString(data.aspectRatio) || (mediaType === 'video' ? DEFAULT_VIDEO_RATIO : DEFAULT_IMAGE_RATIO)
    await this.adapter.setAspectRatio?.(aspectRatio)
    if (data.model) await this.adapter.setModel?.(String(data.model))
    if (mediaType === 'video' && data.videoDuration) await this.adapter.setDuration?.(String(data.videoDuration))

    for (const media of mediaInputs) {
      if (media.data) await this.adapter.uploadImage?.(media.data)
    }

    await this.adapter.insertPrompt(prompt)
    if (data.autoGenerate !== false) await this.adapter.clickGenerate()

    if (data.waitForCompletion !== false) {
      const result = await this.adapter.waitForResult()
      return { type: 'generation', provider, mediaType, aspectRatio, prompt, result }
    }

    return { type: 'generation', provider, mediaType, aspectRatio, prompt, triggered: true }
  }

  // Heartbeat-based wait for a ChatGPT job to terminate.
  //
  // Two distinct time signals are read from the job record:
  //
  //   * `lastHeartbeatAt`  — bumped on EVERY CHATGPT_JOB_PROGRESS
  //                          message (proves the content script is
  //                          alive and the message channel works).
  //   * `lastProgressAt`   — bumped ONLY when the content script
  //                          reports a real generation advance.
  //
  // Three gates decide when to fail:
  //
  //   GATE A — dead content script / tab crash / context loss.
  //       now - lastHeartbeatAt > heartbeatStaleMs
  //
  //   GATE B — initial no-progress budget exceeded.
  //       never saw progress AND elapsedMs > initialNoProgressTimeoutMs
  //
  //   GATE C — generation has stalled (no active signal).
  //       ever saw progress AND now - lastProgressAt > staleMs
  //       AND !generating AND !hasPendingImage AND candidateImages === 0
  //       throw "progress stale".
  //       With an active signal we extend grace to staleMs * 2.
  //
  // maxWaitMs = max(payload.timeoutMs, 600000). The runner-side
  // Generate Node retry gate is untouched: this wait never asks
  // the runner to retry the node.
  private async waitForChatGPTJob(jobId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const startedAt = Date.now()
    const configuredTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 300000
    const initialNoProgressTimeoutMs = Math.max(configuredTimeoutMs, 300000)
    const maxWaitMs = Math.max(initialNoProgressTimeoutMs, 600000)
    const staleMs = 90000
    const heartbeatStaleMs = 40000
    let everSawProgress = false
    let lastLogAt = 0

    while (Date.now() - startedAt < maxWaitMs) {
      const response = await this.sendRuntimeMessage({
        action: 'GET_CHATGPT_JOB_STATUS',
        payload: { jobId },
      })

      if (!response.success && response.error === 'context_invalidated') {
        throw new Error(
          'ChatGPT job aborted: extension context invalidated. ' +
          'Reload the chatgpt.com tab and re-run the workflow.'
        )
      }
      if (!response.success) throw new Error(response.error || 'Could not read ChatGPT job status')

      const job = response.job
      const elapsedMs = Date.now() - startedAt
      const now = Date.now()

      if (isRecord(job)) {
        const lastHeartbeatAt = typeof job.lastHeartbeatAt === 'number' ? job.lastHeartbeatAt : 0
        const lastProgressAt = typeof job.lastProgressAt === 'number' ? job.lastProgressAt : 0
        const progress = isRecord(job.progress) ? job.progress : null
        const hasPendingImage = !!(job.hasPendingImage || (progress && progress.hasPendingImage))
        const phase = progress && typeof progress.phase === 'string' ? progress.phase : 'unknown'
        const generating = !!(progress && progress.generating)
        const candidateImages = (progress && Number(progress.candidateImages)) || 0
        const acceptedImages = (progress && Number(progress.acceptedImages)) || 0
        const stillActive = generating || hasPendingImage || candidateImages > 0

        if (lastProgressAt > 0) everSawProgress = true
        const lastHeartbeatAgoMs = lastHeartbeatAt > 0 ? now - lastHeartbeatAt : -1
        const lastProgressAgoMs = lastProgressAt > 0 ? now - lastProgressAt : -1

        if (Date.now() - lastLogAt > 1500) {
          lastLogAt = Date.now()
          console.log('[Runner] wait chatgpt job', {
            jobId,
            elapsedMs,
            lastHeartbeatAgoMs,
            lastProgressAgoMs,
            phase,
            generating,
            candidateImages,
            acceptedImages,
            hasPendingImage,
            status: job.status,
          })
        }

        if (job.status === 'done') {
          console.log('[Runner] chatgpt job done', {
            jobId,
            imageCount: Array.isArray(job.imageUrls) ? job.imageUrls.length : 0,
            elapsedMs,
          })
          return job
        }

        if (job.status === 'failed') {
          const errMsg = asString(job.error) || 'ChatGPT generation failed'
          // TIMEOUT + hasPendingImage → keep waiting. Re-running the
          // Generate Node would re-upload refs and ChatGPT would
          // duplicate the attachments. The heartbeat-stale gate is
          // the real authority on when to give up.
          if (/timeout/i.test(errMsg) && hasPendingImage) {
            console.log(
              '[Runner] ChatGPT timeout but image still pending — not retrying ' +
              'to avoid duplicate submit; continuing to wait for asset render.',
              { jobId, elapsedMs, lastHeartbeatAgoMs, lastProgressAgoMs, hasPendingImage }
            )
            await new Promise((resolve) => setTimeout(resolve, 1500))
            continue
          }
          throw new Error(errMsg)
        }

        // ── GATE A — dead content script / lost message channel. ──
        // No heartbeat for > heartbeatStaleMs means the polling loop
        // died or the tab crashed. Even if lastProgressAt is recent,
        // we cannot trust future updates.
        if (lastHeartbeatAt > 0 && lastHeartbeatAgoMs > heartbeatStaleMs) {
          console.log('[Runner] chatgpt job heartbeat lost', {
            jobId,
            elapsedMs,
            lastHeartbeatAgoMs,
            lastProgressAgoMs,
            heartbeatStaleMs,
            phase,
          })
          throw new Error(
            'ChatGPT content script heartbeat lost: no update for ' +
            Math.round(lastHeartbeatAgoMs / 1000) + 's. ' +
            'The chatgpt.com tab or content script may have been unloaded.'
          )
        }

        // ── GATE B — initial no-progress budget. ────────────────────
        if (!everSawProgress) {
          if (elapsedMs > initialNoProgressTimeoutMs) {
            console.log('[Runner] chatgpt job no-progress timeout', {
              jobId,
              elapsedMs,
              initialNoProgressTimeoutMs,
            })
            throw new Error(
              'Timeout waiting for ChatGPT result: no generation progress within ' +
              Math.round(initialNoProgressTimeoutMs / 1000) + 's'
            )
          }
        } else {
          // ── GATE C — generation has stalled. ────────────────────
          if (lastProgressAgoMs > staleMs && !stillActive) {
            console.log('[Runner] chatgpt job stale timeout', {
              jobId,
              elapsedMs,
              lastHeartbeatAgoMs,
              lastProgressAgoMs,
              staleMs,
              phase,
            })
            throw new Error(
              'Timeout waiting for ChatGPT result: progress stale for ' +
              Math.round(lastProgressAgoMs / 1000) + 's'
            )
          }
          // Heartbeat keeps coming but real progress hasn't moved
          // for 2x staleMs — even with an active signal we should
          // not wait forever.
          if (lastProgressAgoMs > staleMs * 2) {
            console.log('[Runner] chatgpt job hard stale timeout', {
              jobId,
              elapsedMs,
              lastHeartbeatAgoMs,
              lastProgressAgoMs,
              phase,
            })
            throw new Error(
              'Timeout waiting for ChatGPT result: progress stale for ' +
              Math.round(lastProgressAgoMs / 1000) + 's despite heartbeat'
            )
          }
        }
      } else {
        if (elapsedMs > initialNoProgressTimeoutMs) {
          throw new Error('Timeout waiting for ChatGPT result: job record not found')
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1500))
    }

    console.log('[Runner] chatgpt job max-wait timeout', {
      jobId,
      elapsedMs: Date.now() - startedAt,
      maxWaitMs,
    })
    throw new Error('Timeout waiting for ChatGPT result: max wait reached after ' + Math.round(maxWaitMs / 1000) + 's')
  }

  private async sendRuntimeMessage(message: Record<string, unknown>): Promise<RuntimeResponse> {
    try {
      // Sidepanel / extension context. After a reload, `chrome.runtime`
      // itself throws "Extension context invalidated". Translate that
      // into a tagged error so callers (waitForChatGPTJob) can stop
      // polling instead of hanging.
      if (!hasExtensionContextSafe()) {
        return { success: false, error: 'context_invalidated' }
      }
      const response = await chrome.runtime.sendMessage(message)
      return (response || {}) as RuntimeResponse
    } catch (err) {
      if (isContextInvalidatedSafe(err)) {
        return { success: false, error: 'context_invalidated' }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  }

  private hasDirectDownstreamType(sourceId: string, type: WorkflowNode['type']): boolean {
    const nodeMap = new Map(this.workflow.nodes.map((node) => [node.id, node]))
    return this.workflow.edges.some((edge) => edge.source === sourceId && nodeMap.get(edge.target)?.type === type)
  }

  private interpolateVariables(prompt: string): string {
    let result = prompt || ''
    for (const [key, value] of Object.entries(this.context)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), this.valueToPromptText(value))
    }
    return result
  }

  private valueToPromptText(value: unknown): string {
    if (typeof value === 'string') return value
    if (!isRecord(value)) return String(value ?? '')
    return asString(value.text)
      || asString(value.prompt)
      || asString(value.result)
      || JSON.stringify(value)
  }

  private async waitForCondition(config: { condition?: string; selector?: string; timeout?: number }): Promise<void> {
    const { condition = 'dom-change', timeout = 30000 } = config
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Wait condition timeout')), timeout)
      if (condition === 'manual') {
        clearTimeout(timeoutId)
        resolve()
      } else {
        clearTimeout(timeoutId)
        resolve()
      }
    })
  }

  private async downloadSource(source: string, format: string, filename: string): Promise<void> {
    if (source.startsWith('data:')) {
      await this.downloadFile(source, format, filename)
      return
    }

    if (!useSettingsStore.getState().autoDownload) return

    const extension = this.inferDownloadExtension(source, format)
    await chrome.downloads.download({
      url: source,
      filename: `${filename}.${extension}`,
      saveAs: true
    })
  }

  private inferDownloadExtension(source: string, fallback: string): string {
    const clean = source.split('?')[0].split('#')[0]
    const match = clean.match(/\.([a-z0-9]{2,5})$/i)
    return match?.[1] || fallback
  }

  private async downloadFile(data: string, format: string, filename?: string): Promise<void> {
    const settings = useSettingsStore.getState()
    if (!settings.autoDownload) return

    const name = filename || `ai-flow-${Date.now()}`
    const mimeType = format === 'jpg'
      ? 'image/jpeg'
      : format === 'webp'
        ? 'image/webp'
        : format === 'mp4'
          ? 'video/mp4'
          : 'image/png'

    const base64Data = data.replace(/^data:[^;]+;base64,/, '')
    const binaryString = atob(base64Data)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }

    const blob = new Blob([bytes], { type: mimeType })
    const url = URL.createObjectURL(blob)

    await chrome.downloads.download({
      url,
      filename: `${name}.${format}`,
      saveAs: true
    })

    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  pause(): void {
    this.isPaused = true
    usePipelineStore.getState().pausePipeline(this.taskId)
  }

  resume(): void {
    this.isPaused = false
    usePipelineStore.getState().resumePipeline(this.taskId)
  }

  stop(): void {
    this.shouldStop = true
    this.isRunning = false
    usePipelineStore.getState().stopPipeline(this.taskId)
  }

  private async acquireWakeLock(): Promise<void> {
    const settings = useSettingsStore.getState()
    if (settings.wakeLockEnabled && 'wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen')
      } catch {
        // Wake lock not available
      }
    }
  }

  private async releaseWakeLock(): Promise<void> {
    if (this.wakeLock) {
      await this.wakeLock.release()
      this.wakeLock = null
    }
  }
}

let currentRunner: PipelineRunner | null = null

export async function runPipeline(
  workflow: Workflow,
  callbacks: PipelineCallbacks = {}
): Promise<void> {
  if (currentRunner?.isRunning) {
    throw new Error('A pipeline is already running')
  }
  const pipelineStore = usePipelineStore.getState()
  const task = pipelineStore.createTask(workflow.id)
  currentRunner = new PipelineRunner(workflow, task.id, callbacks)
  await currentRunner.run()
}

export function pausePipeline(): void {
  currentRunner?.pause()
}

export function resumePipeline(): void {
  currentRunner?.resume()
}

export function stopPipeline(): void {
  currentRunner?.stop()
  currentRunner = null
}
