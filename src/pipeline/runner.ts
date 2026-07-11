import type { Workflow, WorkflowNode, WorkflowEdge, FlowNodeData, AIProvider } from '@/types'
import { getAdapter, type ProviderAdapter } from '@/providers'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useHistoryStore } from '@/stores/dataStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { hasExtensionContext, isContextInvalidated } from '@/lib/extensionContextGuard'
import { debugLog, debugWarn, DEBUG_FLAGS } from '@/lib/debug'
import { getAsset } from '@/lib/assets/assetStore'

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
  // Provider origin (e.g. 'https://labs.google') attached by the
  // Flow content script. Used to repair path-relative URLs that
  // somehow slip through the bridge normalization (e.g. a legacy
  // asset that did not go through toAbsoluteFlowUrl).
  providerOrigin?: string
  // Where the asset was first seen (e.g. Flow project page URL).
  sourcePageUrl?: string
}

// FALLBACK_LABS_ORIGIN — used when an asset lacks providerOrigin but
// is clearly Flow-side (path begins with /fx/ or contains
// media.getMediaUrlRedirect). We assume `https://labs.google` for the
// host since Flow's CDN lives there. This is a last-resort repair for
// older / legacy asset descriptors.
const FALLBACK_LABS_ORIGIN = 'https://labs.google'

// Repair a possibly-relative URL into an absolute URL. Mirrors
// flow-slate-bridge.toAbsoluteFlowUrl and flow-content.toAbsoluteFlowUrl
// so any path-relative URL the runner sees can be reconstructed without
// the browser resolving it against the extension / file:// origin.
//
// Rules:
//   blob:           — keep
//   data:           — keep
//   http(s)://      — keep
//   //foo           — prepend `https:`
//   /foo            — resolve against `origin` (providerOrigin) or
//                     FALLBACK_LABS_ORIGIN when the path looks Flow-
//                     specific
//   anything else   — keep
function repairFlowUrl(value: string, origin?: string): string {
  if (!value) return value
  if (
    value.indexOf('blob:') === 0 ||
    value.indexOf('data:') === 0 ||
    value.indexOf('http://') === 0 ||
    value.indexOf('https://') === 0
  ) {
    return value
  }
  if (value.indexOf('//') === 0) {
    return 'https:' + value
  }
  if (value.indexOf('/') === 0) {
    const base = origin || (
      value.indexOf('/fx/') !== -1 || value.indexOf('media.getMediaUrlRedirect') !== -1
        ? FALLBACK_LABS_ORIGIN
        : ''
    )
    if (!base) return value
    try {
      return new URL(value, base).href
    } catch (_) {
      return value
    }
  }
  return value
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
const DEFAULT_WORKFLOW_FOCUS_POLICY = 'restore-editor-after-submit'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

function shouldRestoreEditorAfterProviderAction(data: Record<string, unknown>): boolean {
  const policy = asString(data.restoreFocusPolicy) || DEFAULT_WORKFLOW_FOCUS_POLICY
  return policy === 'restore-editor-after-submit'
}

function getForegroundRequiredReason(provider: string, error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error || '')
  const normalized = message.toLowerCase()
  const sharedSignals = [
    'not focused',
    'background tab',
  ]
  const chatgptSignals = [
    'composer_not_focused',
    'paste_failed_background_tab',
    'file_input_requires_active_tab',
    'chatgpt_background_insert_failed',
    'chatgpt_submit_failed_background',
    'paste failed',
    'file input',
  ]
  const flowSignals = [
    'flow_background_insert_failed',
    'flow_submit_requires_active_tab',
  ]
  const signals = provider === 'chatgpt'
    ? [...sharedSignals, ...chatgptSignals]
    : provider === 'google-flow'
      ? [...sharedSignals, ...flowSignals]
      : sharedSignals
  const matched = signals.find((signal) => normalized.includes(signal))
  return matched ? message || matched : null
}

function compactStrings(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean)
}

function mediaFingerprint(media: { data?: string; url?: string; name?: string }): string {
  const data = media?.data || ''
  const url = media?.url || ''
  if (data) {
    return 'd[' + data.length + ']:' + data.slice(0, 64)
  }
  if (url) {
    return 'u[' + url.length + ']:' + url.slice(0, 96)
  }
  return 'empty'
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

// [Workflow][OutputNormalize] Per-output normalization for the Generate-node
// result bundle (`outputs[]` and `images[]`).
//
// Why this exists:
//   flow-content.ts produces a per-asset descriptor with `url`, `mediaUrl`,
//   `imageUrl`, `videoUrl`, `thumbnailUrl`, `poster`, etc. When the asset is
//   a video the bridge only guarantees `videoUrl` (and sometimes `mediaUrl`)
//   while `imageUrl` / `thumbnail` may be the FIRST tile thumbnail (an
//   image, not the video) or empty. Without normalization the Workflow UI
//   reads `imageUrl` for the preview, fails on `<img src="video url">`, and
//   the Generate node renders blank even though `outputsCount=1`.
//
// Behavior:
//   - Detect video via `mediaType === 'video'` || `type === 'video'`
//     (covers both the rich outputs[] shape and the MediaItem images[]
//     shape, where `mediaType` is the canonical key).
//   - For video: resolvedUrl = videoUrl || mediaUrl || url. Set
//     `videoUrl`, `mediaUrl`, `url` to resolvedUrl. CLEAR `imageUrl` so
//     downstream image consumers don't accidentally render a `<video>` URL
//     as an image. Preserve `thumbnailUrl` / `thumbnail` / `poster` as the
//     first-frame poster (the bridge already normalizes that).
//   - For image: resolvedUrl = imageUrl || mediaUrl || url. Set
//     `imageUrl`, `mediaUrl`, `url` to resolvedUrl. Leave `videoUrl`
//     untouched (it should already be empty for image).
//   - Pass-through for items we can't classify — don't mutate unknown
//     shapes, the Workflow UI's existing getGenerateOutputImageUrls walk
//     still works.
//
// Owner: shared (workflow runner). Does NOT touch Flow bridge or ChatGPT
// contracts; it only re-shapes the runner's own output bundle so the
// downstream Workflow UI sees the right field per media type.
function normalizeWorkflowOutput(output: Record<string, unknown>): Record<string, unknown> {
  if (!output || typeof output !== 'object') return output
  const rawMediaType = String(output.mediaType || output.type || '').toLowerCase()
  const videoUrl = asString(output.videoUrl)
  const mediaUrl = asString(output.mediaUrl)
  const imageUrl = asString(output.imageUrl)
  const url = asString(output.url)
  const thumbnailUrl = asString(output.thumbnailUrl) || asString(output.thumbnail)
  const poster = asString(output.poster) || thumbnailUrl

  if (rawMediaType === 'video') {
    const resolved = videoUrl || mediaUrl || url
    if (!resolved) return output
    return {
      ...output,
      type: 'video',
      mediaType: 'video',
      url: resolved,
      mediaUrl: resolved,
      videoUrl: resolved,
      // Critical: do NOT put the video URL into imageUrl. Downstream
      // consumers that default to `<img src={imageUrl}>` would otherwise
      // try to load the video URL as an image and fail.
      imageUrl: '',
      thumbnailUrl,
      thumbnail: thumbnailUrl,
      poster,
    }
  }

  if (rawMediaType === 'image') {
    const resolved = imageUrl || mediaUrl || url
    if (!resolved) return output
    return {
      ...output,
      type: 'image',
      mediaType: 'image',
      url: resolved,
      mediaUrl: resolved,
      imageUrl: resolved,
      // Don't carry a stale videoUrl forward — image-only outputs should
      // have an empty videoUrl so video-aware consumers don't misroute.
      videoUrl: '',
    }
  }

  return output
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
    const nodes = this.getEnabledNodes()
    const generateNode = nodes.find((node) => node.type === 'generate')
    const promptNode = nodes.find((node) => node.type === 'prompt')
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
    return this.getEnabledEdges().filter((e) => e.target === nodeId).map((e) => e.id)
  }

  /** Returns all edge IDs that carry data OUT OF a node (outgoing edges). */
  private getOutgoingEdgeIds(nodeId: string): string[] {
    return this.getEnabledEdges().filter((e) => e.source === nodeId).map((e) => e.id)
  }

  private emitStart(nodeId: string, nodeType: string) {
    // Edge active timing — incoming only:
    //   When a node starts, only edges INCOMING to it (i.e. edges whose
    //   target === nodeId) become active. Outgoing edges of the node
    //   stay INACTIVE — they should only light up when the NEXT node
    //   starts, at which point the edge's target is the next node and
    //   it gets activated as part of that next-node's incoming set.
    //
    // This avoids the UI bug where the edge leaving a still-running
    // node lights up early (e.g. edge G1 → G2 glowing while G1 is
    // still rendering).
    debugLog('edgeFlow', '[EdgeFlowDebug][Runner] node start', {
      nodeId,
      activeIncomingEdges: this.getIncomingEdgeIds(nodeId),
      incorrectlyActiveOutgoingEdges: this.getOutgoingEdgeIds(nodeId),
    })
    debugLog('glow', '[GlowDebug][Runner] start', { nodeId })
    try { this.callbacks.onNodeStart?.(nodeId, nodeType) } catch {}
    for (const edge of this.getEnabledEdges().filter((e) => e.target === nodeId)) {
      debugLog('edgeFlow', '[EdgeFlowDebug][Runner] edge active', {
        runningNodeId: nodeId,
        edgeId: edge.id,
        source: edge.source,
        target: edge.target,
        reason: 'incoming-to-running-node',
      })
      debugLog('glow', '[GlowDebug][Runner] edgeActive', { edgeId: edge.id, source: edge.source, target: edge.target })
      try { this.callbacks.onEdgeActive?.(edge.id) } catch {}
    }
  }

  private emitComplete(nodeId: string, output: unknown) {
    // Edge inactive timing — incoming only:
    //   When a node completes, only edges INCOMING to it (i.e. edges
    //   whose target === nodeId) become inactive — data has finished
    //   flowing into the node. Outgoing edges of the node stay
    //   INACTIVE (they were never active); they will only light up
    //   when the next node starts.
    //
    // Outgoing edges of the just-completed node are NOT activated
    // here — that activation lives in the next-node's onNodeStart,
    // not here.
    debugLog('edgeFlow', '[EdgeFlowDebug][Runner] node complete', {
      nodeId,
      deactivatingIncomingEdges: this.getIncomingEdgeIds(nodeId),
    })
    debugLog('glow', '[GlowDebug][Runner] complete', { nodeId, output })
    try { this.callbacks.onNodeComplete?.(nodeId, output) } catch {}
    for (const edge of this.getEnabledEdges().filter((e) => e.target === nodeId)) {
      debugLog('edgeFlow', '[EdgeFlowDebug][Runner] edge inactive', {
        runningNodeId: nodeId,
        edgeId: edge.id,
        source: edge.source,
        target: edge.target,
        reason: 'node-finished',
      })
      debugLog('glow', '[GlowDebug][Runner] edgeInactive', { edgeId: edge.id, source: edge.source, target: edge.target })
      try { this.callbacks.onEdgeInactive?.(edge.id) } catch {}
    }
  }

  private emitInactive(nodeId: string) {
    // Defensive cleanup — used on FAILURE only (the success path goes
    // through emitComplete, which already deactivates incoming edges
    // of the completed node). For failed nodes we don't know which
    // edges are "active" semantically, so we deactivate both incoming
    // and outgoing of the failed node. The editor's onEdgeInactive
    // short-circuits on already-inactive edges so the duplicate work
    // is harmless.
    for (const edge of this.getEnabledEdges().filter((e) => e.target === nodeId)) {
      debugLog('edgeFlow', '[EdgeFlowDebug][Runner] edge inactive (failure cleanup)', {
        runningNodeId: nodeId,
        edgeId: edge.id,
        source: edge.source,
        target: edge.target,
        reason: 'node-failed',
      })
      debugLog('glow', '[GlowDebug][Runner] edgeInactive', { edgeId: edge.id, source: edge.source, target: edge.target })
      try { this.callbacks.onEdgeInactive?.(edge.id) } catch {}
    }
    for (const edge of this.getEnabledEdges().filter((e) => e.source === nodeId)) {
      debugLog('edgeFlow', '[EdgeFlowDebug][Runner] edge inactive (failure cleanup)', {
        runningNodeId: nodeId,
        edgeId: edge.id,
        source: edge.source,
        target: edge.target,
        reason: 'node-failed',
      })
      debugLog('glow', '[GlowDebug][Runner] edgeInactive', { edgeId: edge.id, source: edge.source, target: edge.target })
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

  // ── Lazy execution plan ──────────────────────────────────────────────
  // The legacy `getSortedNodes()` is a textbook Kahn's algorithm that
  // pops every node with in-degree 0 first. For a workflow like:
  //
  //     M1 → G1   M2 → G2
  //     P1 → G1   P2 → G2
  //                 G1 → G2
  //
  // the legacy order is [M1, P1, M2, P2, G1, G2] — M2/P2 execute BEFORE
  // G1 completes, which makes them glow "completed" while G1 is still
  // running. The UI then shows a downstream node finished early.
  //
  // The fix: build a lazy plan from the TERMINAL nodes (no outgoing
  // edges), and only execute a node's direct upstream dependencies
  // when the downstream node is about to run. For the same workflow:
  //
  //     terminals = [G2]
  //     lazy plan = [M1, P1, G1, M2, P2, G2]
  //
  // — M2 and P2 execute AFTER G1 completes, so they only glow
  // "completed" once G2 is actually starting up. That matches user
  // intent and the visual lifecycle.
  //
  // The execution order is computed once at the start of run() and
  // iterated like before — same retry / stop / pause semantics, same
  // emitStart / emitComplete lifecycle. The only change is WHICH order
  // we iterate.
  private pickExecutionTargets(): WorkflowNode[] {
    const nodes = this.getEnabledNodes()
    if (nodes.length === 0) return []

    const edges = this.getEnabledEdges(nodes)
    const hasOutgoing = new Set<string>()
    for (const edge of edges) hasOutgoing.add(edge.source)

    const terminals = nodes.filter((node) => !hasOutgoing.has(node.id))
    if (terminals.length > 0) return terminals

    // Fallback: every node has an outgoing edge (e.g. feedback loop
    // that isn't a true cycle, or workflow ending in a node whose
    // outgoing edge points outside the enabled set). Use ALL enabled
    // nodes as targets so we still execute the full graph.
    return nodes
  }

  private buildLazyExecutionPlan(targets: WorkflowNode[]): WorkflowNode[] {
    const nodes = this.getEnabledNodes()
    const nodeMap = new Map(nodes.map((node) => [node.id, node]))
    const edges = this.getEnabledEdges(nodes)
    const originalIndex = new Map(nodes.map((n, idx) => [n.id, idx]))
    const compareNodes = (a: WorkflowNode, b: WorkflowNode) => {
      if (a.position.x !== b.position.x) return a.position.x - b.position.x
      if (a.position.y !== b.position.y) return a.position.y - b.position.y
      return (originalIndex.get(a.id) || 0) - (originalIndex.get(b.id) || 0)
    }

    // Group incoming edges by target. Sort each group's edges so we
    // walk the "upstream chain" (the source whose own ancestry is
    // longest — GENERATE nodes first, then by position) BEFORE
    // walking sibling leaf sources. This makes the lazy plan match
    // user intent: for the topology M1→G1, P1→G1, G1→G2, M2→G2,
    // P2→G2 the DFS visits G2's incoming edges in order
    // [G1, M2, P2] so the G1 chain (M1, P1, G1) is fully executed
    // before M2 / P2 are touched. Walking [M2, P2, G1] would
    // produce [M2, P2, M1, P1, G1, G2] which fires M2/P2 visual
    // lifecycle while G1 is still pending.
    const incomingByTarget = new Map<string, WorkflowEdge[]>()
    for (const edge of edges) {
      const list = incomingByTarget.get(edge.target) || []
      list.push(edge)
      incomingByTarget.set(edge.target, list)
    }
    for (const [targetId, list] of incomingByTarget) {
      list.sort((a, b) => {
        const aNode = nodeMap.get(a.source)
        const bNode = nodeMap.get(b.source)
        if (!aNode || !bNode) return 0
        const rank = (n: WorkflowNode): number => {
          if (n.type === 'generate') return 0
          if (n.type === 'image' || n.type === 'video') return 1
          return 2
        }
        const aRank = rank(aNode)
        const bRank = rank(bNode)
        if (aRank !== bRank) return aRank - bRank
        return compareNodes(aNode, bNode)
      })
      incomingByTarget.set(targetId, list)
    }

    const visited = new Set<string>()
    const plan: WorkflowNode[] = []
    // Stack-based DFS to avoid recursion blowup on large workflows.
    // We push a "frame" for each (nodeId, edgeIndex) pair so we can
    // walk deps one at a time and resume after each dep finishes.
    type Frame = { nodeId: string; edgeIndex: number }
    const stack: Frame[] = []

    // Sort targets so the plan visits them in a stable order. For two
    // independent chains ending in two terminals, we want to walk the
    // earlier (top-left) terminal's chain first.
    const sortedTargets = [...targets].sort(compareNodes)

    for (const target of sortedTargets) {
      stack.push({ nodeId: target.id, edgeIndex: 0 })
      while (stack.length > 0) {
        // Cycle guard — if we ever revisit the same node within a
        // single DFS branch, bail out instead of looping forever.
        // The plan will still be valid (the visited check below
        // prevents duplicates across branches); we just need to
        // avoid infinite recursion.
        const frame = stack[stack.length - 1]
        const incoming = incomingByTarget.get(frame.nodeId) || []
        const incomingNodeIds = incoming
          .map((e) => e.source)
          .filter((sid) => !visited.has(sid))

        if (frame.edgeIndex === 0 && incomingNodeIds.length > 0) {
          // Log the full dep list once per node (the first time we
          // touch it on the stack), so operators can read the
          // upstream chain at a glance.
          const frameNode = nodeMap.get(frame.nodeId)
          const frameTitle = (frameNode?.data as Record<string, unknown> | undefined)?.label as string || frameNode?.type
          const depSummaries = incomingNodeIds.map((sid) => {
            const sn = nodeMap.get(sid)
            return {
              nodeId: sid,
              nodeTitle: (sn?.data as Record<string, unknown> | undefined)?.label as string || sn?.type,
              type: sn?.type,
            }
          })
          debugLog('scheduler', '[SchedulerDebug][Runner] execute deps', {
            nodeId: frame.nodeId,
            nodeTitle: frameTitle,
            deps: depSummaries,
          })
        }

        if (frame.edgeIndex < incoming.length) {
          const edge = incoming[frame.edgeIndex]
          frame.edgeIndex++
          if (visited.has(edge.source)) continue
          if (stack.some((f) => f.nodeId === edge.source)) {
            // Cycle: edge.source is on the current DFS stack. Skip it
            // rather than loop. This can happen if the workflow has
            // a cycle that Kahn's algorithm would have rejected; we
            // tolerate it here by treating the cycle edge as a no-op
            // for scheduling (the downstream node will read context
            // from earlier executions / fall back to undefined).
            debugWarn('scheduler', '[SchedulerDebug][Runner] cycle detected, skipping edge', {
              source: edge.source,
              target: edge.target,
              edgeId: edge.id,
            })
            continue
          }
          const sourceNode = nodeMap.get(edge.source)
          if (!sourceNode) continue
          stack.push({ nodeId: edge.source, edgeIndex: 0 })
          continue
        }

        // All incoming edges walked — this node is ready to be added
        // to the plan (post-order, so deps come before dependents).
        stack.pop()
        if (visited.has(frame.nodeId)) continue
        visited.add(frame.nodeId)
        const node = nodeMap.get(frame.nodeId)
        if (node) {
          plan.push(node)
          debugLog('scheduler', '[SchedulerDebug][Runner] execute node', {
            nodeId: frame.nodeId,
            nodeTitle: node.data?.label || node.type,
            type: node.type,
            index: plan.length,
          })
        }
      }
    }

    // Final dedup pass in case targets overlap (e.g. workflow with
    // duplicate terminal references). Should be unreachable in
    // practice but harmless.
    return plan
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

    console.log(`[Runner] start workflow: ${this.workflow.name} (${this.workflow.nodes?.length || 0} nodes)`)
    // [WorkflowRun][start] — single source of truth for "did this
    // run actually start". Default verbosity. The `source` field
    // disambiguates which UI / API entry fired it (button, the
    // dashboard quick-run, hotkey, etc.) so duplicate entries can
    // be traced back to the originating call site. If you see two
    // `[WorkflowRun][start]` for the same workflowRunId without an
    // intervening `[ignoredDuplicate]`, you have a non-handler
    // dispatch path that needs the single-flight guard.
    console.log(`[WorkflowRun][start] ` + JSON.stringify({
      workflowRunId: this.taskId,
      workflowId: this.workflow.id,
      workflowName: this.workflow.name,
      nodeCount: this.workflow.nodes?.length || 0,
      source: 'pipeline',
    }))

    try {
      await this.acquireWakeLock()
      pipelineStore.startPipeline(this.taskId)
      pipelineStore.addLog(this.taskId, 'info', `Workflow started: ${this.workflow.name}`)

      // Compute both the legacy Kahn-topological order and the new
      // lazy-dependency plan. The lazy plan is what we actually
      // execute; the legacy order is logged for comparison so the
      // [SchedulerDebug] log shows the exact diff that fixed the bug.
      const sortedNodes = this.getSortedNodes()
      const totalNodes = sortedNodes.length
      pipelineStore.addLog(
        this.taskId,
        'info',
        `Execution order: ${sortedNodes.map((node) => node.data.label || node.type).join(' -> ')}`
      )

      const lazyTargets = this.pickExecutionTargets()
      const lazyPlan = this.buildLazyExecutionPlan(lazyTargets)
      debugLog('scheduler', '[SchedulerDebug][Runner] execution plan', {
        oldOrder: sortedNodes.map((node) => `${node.id}:${node.data?.label || node.type}`),
        newOrder: lazyPlan.map((node) => `${node.id}:${node.data?.label || node.type}`),
        reason: 'lazy-dependency — execute a node\'s direct upstream only when the downstream is about to run',
        lazyTargets: lazyTargets.map((node) => node.id),
      })
      pipelineStore.addLog(
        this.taskId,
        'info',
        `Lazy plan: ${lazyPlan.map((node) => node.data.label || node.type).join(' -> ')}`
      )

      const retryByNode = new Map<string, number>()

      for (let i = 0; i < lazyPlan.length; i++) {
        if (this.shouldStop) {
          pipelineStore.stopPipeline(this.taskId)
          pipelineStore.addLog(this.taskId, 'warn', 'Workflow stopped by user')
          break
        }

        while (this.isPaused) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          if (this.shouldStop) break
        }

        const node = lazyPlan[i]
        const inputs = this.getNodeInputs(node)
        const progress = Math.round(((i + 1) / lazyPlan.length) * 100)

        pipelineStore.updateProgress(this.taskId, node.id, progress, this.context)
        pipelineStore.addLog(this.taskId, 'info', `Executing: ${node.data.label}`, node.id, {
          inputCount: inputs.items.length
        })

        console.log(`[Runner] node start: ${node.id} (${node.type})`)
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

          console.log(`[Runner] node done: ${node.id} (${node.type})`)
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
              `Generate node failed — terminal for this run (no auto-retry, would re-submit to the provider). ` +
                `Cause: ${errorMessage}. Re-run the workflow to retry.`,
              node.id
            )
            console.log(`[WorkflowRun][nodeResult] workflowRunId=${this.taskId} nodeId=${node.id} success=false status=TERMINAL_NO_RETRY error=${errorMessage}`)
            try { this.callbacks.onNodeFail?.(node.id, errorMessage) } catch {}
            debugLog('glow', '[GlowDebug][Runner] fail', { nodeId: node.id, error: errorMessage })
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
          debugLog('glow', '[GlowDebug][Runner] fail', { nodeId: node.id, error: errorMessage })
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
          console.log(`[Runner] workflow done: ${this.workflow.name}`)
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
      console.error(`[Runner] workflow failed: ${this.workflow.name} — ${errorMessage}`)
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

  private async executeMediaNode(data: Record<string, unknown>) {
    let mediaType = normalizeMediaType(data.mediaType || (data.videoData || data.videoUrl ? 'video' : 'image'))
    let mediaData = asString(data.mediaData) || asString(data.imageData) || asString(data.videoData)
    const mediaUrl = asString(data.mediaUrl) || asString(data.imageUrl) || asString(data.videoUrl)
    let mediaName = asString(data.mediaName) || asString(data.imageName) || asString(data.videoName) || 'media'
    let storedMimeType = ''

    // Persisted Media nodes intentionally keep only a lightweight
    // assetId pointer; their bytes live in IndexedDB. The editor resolves
    // that pointer for preview, so the runner must resolve the same pointer
    // before deciding that a visibly populated node has no media.
    const assetId = asString(data.assetId) || asString(data.mediaAssetId) || asString(data.imageAssetId)
    if (!mediaData && !mediaUrl && assetId) {
      const asset = await getAsset(assetId)
      if (asset) {
        mediaData = await blobToDataUrl(asset.blob)
        mediaName = asString(data.mediaName)
          || asString(data.imageName)
          || asString(data.videoName)
          || asset.fileName
          || 'media'
        storedMimeType = asset.mimeType
        if (!data.mediaType && asset.kind === 'video') mediaType = 'video'
      }
    }

    if (!mediaData && !mediaUrl) {
      const label = asString(data.label) || 'Media node'
      throw new Error(`${label} has no media. Upload an image or video before running.`)
    }
    const mimeType = asString(data.mediaMimeType)
      || (mediaData.match(/^data:([^;]+);base64,/)?.[1] || '')
      || storedMimeType
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
      const aspectRatio = asString(data.aspectRatio) || DEFAULT_IMAGE_RATIO
      const trimmedPrompt = prompt.trim()
      const chatgptPrompt = trimmedPrompt.toLowerCase().endsWith(aspectRatio.toLowerCase())
        ? trimmedPrompt
        : `${trimmedPrompt.replace(/,\s*$/, '')}, ${aspectRatio}`
      console.log('[Workflow][ProviderRoute] dispatch node=' + node.id + ' provider=chatgpt')
      return this.runWithForegroundFallback('chatgpt', node.id, () =>
        this.runChatGPTGenerate({ ...data, nodeId: node.id }, chatgptPrompt, mediaInputs)
      )
    }

    if (provider === 'google-flow') {
      console.log('[Workflow][ProviderRoute] dispatch node=' + node.id + ' provider=google-flow')
      return this.runWithForegroundFallback('google-flow', node.id, () =>
        this.runGoogleFlowGenerate(node, data, prompt, mediaType, mediaInputs)
      )
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

  // Default behavior for media propagation across edges:
  //
  //   * Source node is `image` / `media`:
  //       contribute exactly ONE media (the media node's own value).
  //   * Source node is `generate`:
  //       look at the upstream `_output.outputs[]` (the rich asset
  //       descriptors). Forward ONE asset (the
  //       `selectedOutputIndex`-th one) by default. Only forward
  //       ALL outputs when the caller explicitly opts in via
  //       `data.useAllOutputs === true` (downstream node data) OR
  //       the edge's `sourceHandle === 'all-images' | 'batch'`.
  //   * Source node is anything else (prompt, etc.): contribute
  //       ZERO media (prompt is text-only, no media to forward).
  //
  // Why this matters:
  //   The previous `coerceMediaList(input.value)` walked the
  //   upstream Generate node's `_output.images[]` AND
  //   `_output.imageUrls[]` AND recursed into `_output.result`.
  //   With `quantity=2`, that pushed THREE refs into the downstream
  //   addRef loop instead of the user's selected one.
  //
  // We intentionally do NOT use `coerceMediaList` for the Generate
  // source path — `coerceMediaList` is a permissive fallback that
  // does exhaustive walks, which is exactly what the policy must
  // avoid for a controlled per-edge flow.
  private extractEdgeMedia(input: ResolvedInput, downstreamUseAll = false): MediaInput[] {
    const value = input.value
    if (value === null || value === undefined) return []

    // ── Generate-node source policy ───────────────────────────────────
    // Google Flow outputs come with a rich `outputs[]` array of asset
    // descriptors (provider, type, tileId, urls, etc.) — a carousel.
    // The default policy is "forward only the user's currently
    // selected asset" so downstream addRef doesn't re-upload 3
    // images when the user only wants 1.
    //
    // ChatGPT outputs (CLAUDE.md "Do not regress" list) keep their
    // existing contract: forward ALL images unconditionally. ChatGPT
    // has no carousel, so "selected" doesn't apply — the user
    // expects the full set.
    if (isRecord(value) && value.provider === 'google-flow') {
      const outputsRaw = value.outputs
      const outputs = Array.isArray(outputsRaw) ? outputsRaw.filter((o): o is Record<string, unknown> => isRecord(o)) : []
      const sourceNode = input.sourceNode
      const sourceData = (sourceNode?.data || {}) as Record<string, unknown>
      // Default: single-output. Opt-in: useAllOutputs / batch handle.
      const useAllOutputs =
        value.useAllOutputs === true ||
        downstreamUseAll ||
        input.sourceHandle === 'all-images' ||
        input.sourceHandle === 'batch' ||
        sourceData.useAllOutputs === true
      const selectedIndexRaw =
        typeof value.selectedOutputIndex === 'number' ? value.selectedOutputIndex
        : typeof sourceData.selectedOutputIndex === 'number' ? sourceData.selectedOutputIndex
        : 0
      const selectedIndex = Math.max(0, Math.min(Math.max(0, outputs.length - 1), selectedIndexRaw))

      if (outputs.length === 0) {
        // Pre-existing google-flow bundles that have only
        // `imageUrls[]` (no `outputs[]`) — fall back to the
        // permissive list walk. This avoids regressing older
        // workflows where the contract was "all images".
        return this.coerceMediaList(value)
      }

      if (useAllOutputs || outputs.length === 1) {
        return outputs.map((asset) => this.outputAssetToMediaInput(asset, input.targetHandle))
      }
      // Single-selected path.
      const picked = outputs[selectedIndex] || outputs[0]
      const mediaInput = this.outputAssetToMediaInput(picked, input.targetHandle)
      return mediaInput ? [mediaInput] : []
    }

    // ChatGPT (no carousel) and any other non-Flow generation shape:
    // fall through to the permissive coerceMediaList so the existing
    // contract is preserved verbatim. Touching this branch would
    // break the runner's "do not regress ChatGPT" invariants.
    if (isRecord(value) && value.provider === 'chatgpt') {
      return this.coerceMediaList(value)
    }

    // ── Non-Generate sources (Media/Image/Prompt/etc.) ───────────────
    return this.coerceMediaList(value)
  }

  // Convert one asset descriptor from `outputAssets[]` into a
  // `MediaInput` for the runner's downstream consumers. Honors
  // providerOrigin so a path-relative URL is repaired.
  private outputAssetToMediaInput(asset: Record<string, unknown>, targetHandle?: string): MediaInput {
    const assetUrl = asString(asset.url)
      || asString(asset.mediaUrl)
      || asString(asset.imageUrl)
      || asString(asset.thumbnailUrl)
    const providerOrigin = asString(asset.providerOrigin)
    const repairedUrl = assetUrl ? repairFlowUrl(assetUrl, providerOrigin) : ''
    const dataUrl = asString(asset.data)
    const mediaType = normalizeMediaType(
      asString(asset.mediaType) || asString(asset.type) || 'image'
    )
    const name = asString(asset.savedFilename)
      || asString(asset.fileNameFromFlow)
      || asString(asset.name)
      || `flow-output-${asset.index || 0}.${mediaType === 'video' ? 'mp4' : 'png'}`
    return {
      mediaType,
      data: dataUrl || undefined,
      url: repairedUrl || undefined,
      name,
      mimeType: asString(asset.mimeType) || (mediaType === 'video' ? 'video/mp4' : 'image/png'),
      aspectRatio: asString(asset.aspectRatio) || undefined,
      targetHandle,
      providerOrigin: providerOrigin || undefined,
      sourcePageUrl: asString(asset.sourcePageUrl) || undefined,
    }
  }

  private resolveGenerateMediaInputs(
    provider: AIProvider,
    mediaType: MediaKind,
    data: Record<string, unknown>,
    inputs: NodeInputs
  ): MediaInput[] {
    // Downstream-side opt-in. If the downstream Generate node explicitly
    // opts in to forwarding all upstream images (e.g. a batch workflow
    // that fans-in N images to one output), each edge policy defaults to
    // 'all' instead of 'single'. Per-edge opt-in is still preferred —
    // see `edge.useAllOutputs` / sourceHandle — but this is a safety
    // net for users who didn't customize the edge.
    const downstreamUseAll = data.useAllOutputs === true
    const allMedia: MediaInput[] = []
    const edgeContributions: Array<{ edgeId: string; sourceType: string; sourceHandle: string; count: number; mode: string; names: string[] }> = []
    const emptyMediaEdges: Array<{ edgeId: string; sourceLabel: string; targetHandle: string }> = []
    for (const input of inputs.items) {
      const mediaItems = this.extractEdgeMedia(input, downstreamUseAll)
      if ((input.targetHandle === 'input_1' || input.targetHandle === 'input_3') && mediaItems.length === 0) {
        emptyMediaEdges.push({
          edgeId: String(input.edge?.id || ''),
          sourceLabel: asString(input.sourceNode?.data?.label) || input.sourceNode?.type || 'upstream node',
          targetHandle: input.targetHandle
        })
      }
      for (const media of mediaItems) {
        allMedia.push({ ...media, targetHandle: input.targetHandle })
      }
      const sourceType = String(input.sourceNode?.type || 'unknown')
      const sourceHandle = String(input.sourceHandle || 'output_1')
      const useAll =
        isRecord(input.value) && (
          input.value.useAllOutputs === true ||
          sourceHandle === 'all-images' ||
          sourceHandle === 'batch'
        ) ||
        downstreamUseAll
      const singleMode =
        sourceType === 'generate' &&
        !useAll &&
        Array.isArray((input.value as Record<string, unknown>)?.outputs) &&
        ((input.value as Record<string, unknown>).outputs as unknown[]).length > 0
      edgeContributions.push({
        edgeId: String(input.edge?.id || ''),
        sourceType,
        sourceHandle,
        count: mediaItems.length,
        mode: singleMode ? 'single' : (useAll ? 'all' : 'default'),
        names: mediaItems.map((m) => m.name || m.url || '(unnamed)').slice(0, 4),
      })
    }

    // [Workflow][InputResolve] — always-on log so operators can see
    // exactly which edges contributed what media to this Generate node.
    // Logs edge-by-edge breakdown + the final list so it is obvious
    // when an extra edge slipped through or the batch opt-in was
    // missing.
    try {
      console.log('[Workflow][InputResolve] ' + JSON.stringify({
        nodeId: String((data as Record<string, unknown>).nodeId || inputs.items[0]?.edge?.target || '(unknown)'),
        provider,
        mediaType,
        upstreamMediaCount: allMedia.length,
        edges: edgeContributions,
      }))
    } catch (_) {}

    if (emptyMediaEdges.length > 0) {
      const first = emptyMediaEdges[0]
      throw new Error(`Generate node has a connected media input from "${first.sourceLabel}", but that node has no media.`)
    }

    // [SeqDebug][Runner] resolved generate inputs — TEMPORARY diagnostic,
    // always-on while investigating sequential multi-generate duplicate
    // attachments. Logs the upstream edge topology and the final media
    // list (post-coercion) so we can verify whether the same upstream
    // image is being sent twice via different paths (transitive ancestor
    // collapse / edge duplication).
    try {
      const incomingEdges = inputs.items.map((input) => ({
        edgeId: input.edge?.id,
        source: input.sourceNode?.id,
        sourceType: input.sourceNode?.type,
        sourceHandle: input.sourceHandle,
        targetHandle: input.targetHandle,
      }))
      const targetNodeId = inputs.items[0]?.edge?.target || '(unknown)'
      debugLog('seq', '[SeqDebug][Runner] resolved generate inputs', {
        nodeId: targetNodeId,
        provider,
        promptInputsCount: inputs.items.filter((i) => i.targetHandle === 'input_2').length,
        mediaInputsCount: allMedia.length,
        mediaInputs: allMedia.map((media, index) => ({
          index,
          sourceNodeId: incomingEdges.find((e) => e.targetHandle === media.targetHandle)?.source,
          sourceHandle: incomingEdges.find((e) => e.targetHandle === media.targetHandle)?.sourceHandle,
          targetHandle: media.targetHandle,
          mediaType: media.mediaType,
          hasData: Boolean(media.data),
          hasUrl: Boolean(media.url),
          name: media.name,
          mimeType: media.mimeType,
          fingerprint: mediaFingerprint(media),
        })),
        incomingEdges,
      })
    } catch (_) {}

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

// Returns true when a Generate Node should NOT be retried by the
// runner's catch block (`i--; continue` retry loop). Used by the
// runner's catch block to disable retries for Generate Nodes.
//
// Provider rules:
//   - chatgpt / google-flow: ANY Generate Node is non-retryable.
//
// Why ALL Generate Nodes (not just media-bearing ones):
//   The previous gate only returned true when `mediaInputs.length
//   > 0` AND there was an uploadable `data` / `url`. That gate was
//   originally designed to prevent duplicate reference-image
//   attachments on retry (re-uploading refs would N×attempts
//   duplicate files). But the same hazard exists WITHOUT refs:
//   - Google Flow: every `RUN_FLOW_PROMPT` creates new tiles in
//     the Flow tab. Re-running the node produces ANOTHER set of
//     tiles. The user's baselineIds=4→5→6 evidence came from this
//     path — `AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS` on a bare
//     Generate node (no refs) was being retried, each retry
//     stamping a new tile in Flow.
//   - ChatGPT: a retried Generate re-uploads any refs (N×attempts
//     duplicates) AND submits the composer again, producing a
//     second turn of images. Same hazard, different surface.
//
// So the safe policy is: Generate Nodes are ALWAYS terminal on
// failure. If the user wants to retry, they explicitly click Run
// again on the workflow. The runner must not silently re-dispatch
// RUN_FLOW_PROMPT / RUN_CHATGPT_PROMPT.
//
// Per-step recovery (tab complete, content-script ping, find
// composer, find send button) still happens INSIDE the provider
// path; the gate here only closes the cross-node retry loop.
private isNonRetryableGenerateNode(node: WorkflowNode): boolean {
  if (!node || node.type !== 'generate') return false
  const fallbackProvider = this.detectProvider()
  const data = (node.data || {}) as Record<string, unknown>
  const provider = normalizeProvider(data.provider, fallbackProvider)
  if (provider !== 'chatgpt' && provider !== 'google-flow') return false
  return true
}

  private async runWithForegroundFallback<T>(
    provider: 'chatgpt' | 'google-flow',
    nodeId: string,
    action: () => Promise<T>
  ): Promise<T> {
    try {
      return await action()
    } catch (error) {
      const reason = getForegroundRequiredReason(provider, error)
      if (!reason) throw error

      console.warn('[Workflow][ProviderRoute] focusFallbackRequired', JSON.stringify({
        provider,
        nodeId,
        reason,
      }))

      const focused = await this.sendRuntimeMessage({
        action: 'ENSURE_PROVIDER_TAB_FOR_WORKFLOW',
        payload: {
          provider,
          nodeId,
          waitReady: true,
          activate: true,
          focusWindow: true,
          preserveEditor: false,
        }
      })
      if (!focused.success) {
        throw error
      }

      try {
        return await action()
      } finally {
        const restored = await this.sendRuntimeMessage({
          action: 'RESTORE_EDITOR_FOCUS',
          payload: { nodeId, provider }
        })
        console.log('[Workflow][EditorFocus] restoredAfterFallback', JSON.stringify({
          provider,
          nodeId,
          success: !!restored.success,
          error: restored.error || null,
        }))
      }
    }
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
    const uploadableMediaInputs = await this.prepareUploadableMediaInputs(mediaInputs)
    const mediaUploads = uploadableMediaInputs
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

    // [SeqDebug][Runner] chatgpt payload — TEMPORARY diagnostic,
    // always-on while investigating sequential multi-generate duplicate
    // attachments. Captures the EXACT mediaUploads we are about to ship
    // to the background. Fingerprints let us see at a glance whether the
    // same upstream image arrived twice (e.g. via both a direct edge AND
    // a Media Node copy).
    try {
      debugLog('seq', '[SeqDebug][Runner] chatgpt payload', {
        nodeId: asString(data.nodeId) || '(no-nodeId)',
        promptLength: prompt.length,
        mediaUploadsCount: mediaUploads.length,
        fingerprints: mediaUploads.map((m) => mediaFingerprint({ data: 'data:' + m.type + ';base64,' + m.base64 })),
      })
    } catch (_) {}

    // Workflow contract: ALWAYS focus the ChatGPT tab before the
    // submit + upload pipeline fires. The legacy `focus: false`
    // contract is what caused the manual-switch bug — Flow → ChatGPT
    // chains left the user staring at the Flow tab while ChatGPT
    // uploads were silently queuing in a backgrounded tab. The
    // ensureProviderTabForWorkflow helper:
    //   - finds / creates the ChatGPT tab,
    //   - activates it + brings its window to front,
    //   - waits for the content script (CHATGPT_PING),
    //   - emits [Workflow][ProviderRoute] trace lines so operators
    //     can confirm the routing sequence in BG console.
    //
    // We do this for both directions:
    //   Flow → ChatGPT: user was looking at Flow tab; now ChatGPT.
    //   ChatGPT → Flow: user was looking at ChatGPT tab; now Flow.
    //
    // GenPanel direct calls (not in this code path) keep the old
    // focus contract — they call runChatGPTPrompt directly with
    // payload.focus defaulting to true.
    const nodeId = asString(data.nodeId)
    const routed = await this.sendRuntimeMessage({
      action: 'ENSURE_PROVIDER_TAB_FOR_WORKFLOW',
      payload: {
        provider: 'chatgpt',
        nodeId,
        waitReady: true,
        activate: true,
        focusWindow: false,
        preserveEditor: true,
      }
    })
    let chatgptTabId: number | undefined
    if (!routed || !routed.success) {
      console.warn('[Workflow][Runner] ensureProviderTabForWorkflow chatgpt failed (continuing — RUN_CHATGPT_PROMPT will retry)', {
        nodeId,
        error: routed?.error,
      })
    } else {
      chatgptTabId = routed.tabId
      // Single condensed line that the operator-facing log grep
      // expects: `[Workflow][ProviderRoute] node=<id> provider=chatgpt
      // tabId=<id> focused=false`. The structured JSON lives below.
      console.log('[Workflow][ProviderRoute] node=' + nodeId + ' provider=chatgpt tabId=' + routed.tabId + ' activated=' + !!routed.activated + ' focused=' + !!routed.focused + ' ready=' + !!routed.ready)
      console.log('[Workflow][Runner] provider tab routed', JSON.stringify({
        provider: 'chatgpt',
        nodeId,
        tabId: routed.tabId,
        windowId: routed.windowId,
        ready: routed.ready,
        activated: routed.activated,
        focused: routed.focused,
      }))
    }

    const response = await this.sendRuntimeMessage({
      action: 'RUN_CHATGPT_PROMPT',
      payload: {
        prompt,
        ratio: asString(data.aspectRatio) || DEFAULT_IMAGE_RATIO,
        fallbackPrefix: 'Generate an image of: ',
        autoDownload: false,
        timeoutMs,
        mediaUploads,
        tabId: chatgptTabId,
        // Workflow editor preservation: keep ChatGPT targeted by tabId
        // without stealing focus unless foreground fallback is required.
        focus: false,
        focusWindow: false,
        activateTab: true,
        preserveEditor: true,
        source: 'workflow'
      }
    })

    if (!response.success || !response.jobId) {
      throw new Error(response.error || 'ChatGPT automation failed to start')
    }

    // Optional focus-restore policy. Default is
    // 'provider-during-node' (no restore) — by design, this is the
    // safest contract because:
    //   - ChatGPT upload + insert + submit are still running in the
    //     background while we waitForChatGPTJob. Putting the
    //     ChatGPT tab in background is fine for the generation
    //     itself (chatgpt.com's React UI doesn't lose state when
    //     backgrounded) but the user may want to keep watching the
    //     ChatGPT tab if they care.
    //   - The editor popup is preserved in either case (the helper
    //     skip above already prevents it from being closed /
    //     navigated).
    // Opt in by setting `data.restoreFocusPolicy ===
    // 'restore-editor-after-submit'` on the Generate node. Once
    // the BG has accepted the job (above), it's safe to refocus
    // the editor — the content script pipeline runs independently
    // of tab visibility.
    if (shouldRestoreEditorAfterProviderAction(data)) {
      this.sendRuntimeMessage({
        action: 'RESTORE_EDITOR_FOCUS',
        payload: { nodeId, provider: 'chatgpt' }
      }).catch((err) => {
        console.warn('[Workflow][Runner] restore editor focus failed (non-fatal)', {
          nodeId,
          provider: 'chatgpt',
          error: (err as Error)?.message,
        })
      })
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
    const jobImages = Array.isArray(job.images)
      ? job.images
          .map((image, index) => {
            if (!isRecord(image)) return null
            const dataUrl = asString(image.data) || asString(image.mediaData) || asString(image.imageData)
            const url = asString(image.url) || asString(image.mediaUrl) || asString(image.imageUrl)
            if (!dataUrl && !url) return null
            return {
              mediaType: 'image' as const,
              data: dataUrl,
              url,
              name: asString(image.name) || asString(image.mediaName) || asString(image.imageName) || `chatgpt-generated-${index + 1}.png`,
              mimeType: asString(image.mimeType) || asString(image.mediaMimeType) || 'image/png',
              aspectRatio: asString(image.aspectRatio) || asString(data.aspectRatio) || DEFAULT_IMAGE_RATIO,
              source: asString(image.source) || 'chatgpt',
            }
          })
          .filter((image): image is NonNullable<typeof image> => Boolean(image))
      : []
    const imageUrls = Array.isArray(job.imageUrls)
      ? job.imageUrls
      : jobImages.map((image) => image.url || image.data || '').filter(Boolean)
    const images = jobImages.length > 0
      ? jobImages
      : imageUrls.map((url: string) => ({
          mediaType: 'image' as const,
          url,
          source: 'chatgpt',
          mimeType: 'image/png',
          aspectRatio: asString(data.aspectRatio) || DEFAULT_IMAGE_RATIO,
        }))
    return {
      type: 'generation',
      provider: 'chatgpt',
      mediaType: 'image',
      aspectRatio: asString(data.aspectRatio) || DEFAULT_IMAGE_RATIO,
      prompt,
      jobId: response.jobId,
      imageUrls,
      // Normalized media array for downstream nodes (Download, etc.)
      images,
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
    // Workflow contract: ALWAYS focus the provider tab so the user
    // does not have to click the Flow tab manually as the workflow
    // transitions between providers (Flow → ChatGPT and back). This
    // replaces the legacy OPEN_PROVIDER_TAB path which routed with
    // focus:false to "keep the user's tab visible" — that policy
    // was the source of the manual-switch bug. The user's own tab
    // (Workflow Editor / Side Panel) is preserved by the sidepanel
    // UX itself; the browser tab order is not a contract the
    // workflow runner must honor.
    const routed = await this.sendRuntimeMessage({
      action: 'ENSURE_PROVIDER_TAB_FOR_WORKFLOW',
      payload: {
        provider: 'google-flow',
        nodeId: node.id,
        waitReady: true,
        activate: false,
        focusWindow: false,
        preserveEditor: true,
      }
    })
    let flowTabId: number | undefined
    if (routed && routed.success && routed.tabId) {
      flowTabId = routed.tabId
      console.log('[Workflow][ProviderRoute] node=' + node.id + ' provider=google-flow tabId=' + flowTabId + ' focused=' + !!routed.activated + ' ready=' + !!routed.ready)
    } else {
      // Soft fallback: legacy OPEN_PROVIDER_TAB. We still pass
      // focus:true here — the workflow contract is "always focus".
      console.warn('[Workflow][Runner] ensureProviderTabForWorkflow google-flow failed, falling back to OPEN_PROVIDER_TAB', {
        nodeId: node.id,
        error: routed?.error,
      })
      const opened = await this.sendRuntimeMessage({
        action: 'OPEN_PROVIDER_TAB',
        payload: { provider: 'google-flow', focus: false }
      })
      if (!opened.success || !opened.tabId) {
        throw new Error(opened.error || 'Could not open Google Flow tab')
      }
      flowTabId = opened.tabId
    }

    const fileIds: string[] = []
    const fileNameMap: Record<string, string> = {}
    const flowMediaInputs = await this.prepareUploadableMediaInputs(mediaInputs)

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

    // Workflow Editor never auto-downloads. Generation still runs to
    // completion so the node has output assets for the preview
    // thumbnail and for downstream Media / Download / Generate
    // nodes. Auto-download is the user's choice only when they
    // click Generate in the Gen tab — never when this code path
    // runs from a workflow run.
    //
    // `shouldAutoDownload` is intentionally fixed to false here.
    // The legacy `waitForCompletion !== false || hasDirectDownstreamType`
    // logic was the source of the bug: downstream Download nodes
    // would silently trigger file writes to the user's disk even
    // when they never asked for an automatic save. Workflow nodes
    // must be deterministic — explicit manual actions only.
    const shouldAutoDownload = false
    // Download resolution. Google Flow workflow nodes now expose
    // a per-node resolution pill (`1k` | `2k` | `4k`); default
    // `1k` for legacy / chatgpt-irrelevant nodes. Sanitized in
    // sanitizeGenerateDataPatch, so this should always be one of
    // the three valid values when the provider is `google-flow`.
    const resolution = String(asString(data.resolution) || '1k').toLowerCase()
    // Google Flow Video only — "Khung hình" / "Thành phần". Forward
    // only when the field is set to a valid value and we're in video
    // mode; legacy workflows without it pass undefined → bridge skips
    // the segmented-control click (Flow keeps its current default).
    const rawFlowVideoMode = asString(data.flowVideoMode)
    const flowVideoMode: 'frame' | 'ingredient' | undefined =
      mediaType === 'video' && (rawFlowVideoMode === 'frame' || rawFlowVideoMode === 'ingredient')
        ? rawFlowVideoMode
        : undefined
    const payload = {
      tabId: flowTabId,
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
      flowVideoMode,
      autoDownload: shouldAutoDownload,
      outputFolder: FLOW_OUTPUT_FOLDER,
      resolution,
      videoResolution: '720p',
      videoDownloadResolution: '720p',
      // Source-of-call: 'workflow' lets flow-content distinguish
      // this payload from Gen-tab traffic and refuse auto-download
      // even if upstream callers forget to set suppressAutoDownload.
      source: 'workflow',
      collectOutputs: true,
      suppressAutoDownload: true,
      // Workflow contract — the Flow tab is already focused by
      // ensureProviderTabForWorkflow above; this flag is logged by
      // flow-content.ts as the tab's intent, mirrored to true so
      // operators can verify the workflow path matches the
      // focusedTab trace line.
      focusTab: false,
      preserveEditor: true,
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

    // [WorkflowRun][nodeDispatch] — single source of truth that the
    // runner actually fired the provider action. Default verbosity.
    // Pairs with [WorkflowRun][nodeResult] (logged below on response
    // and via the catch block on failure) so an operator can confirm
    // a single user click → single dispatch → single result. If you
    // see multiple `[nodeDispatch]` for the same workflowRunId +
    // nodeId without `[ignoredDuplicate]`, the runner's catch block
    // is retrying the same node — fix is to mark the Generate node
    // terminal (see isNonRetryableGenerateNode).
    console.log(`[WorkflowRun][nodeDispatch] ` + JSON.stringify({
      workflowRunId: this.taskId,
      nodeId: node.id,
      nodeType: node.type,
      provider: 'google-flow',
      action: 'RUN_FLOW_PROMPT',
      mediaType,
      quantity,
      fileIdsCount: fileIds.length,
      // Google Flow Video only — "Khung hình" / "Thành phần". Null
      // for legacy / image mode. Single-line log key; preserves the
      // existing JSON.stringify shape so log scrapers stay stable.
      // `provider: 'google-flow'` is hardcoded above so the gate
      // collapses to `mediaType === 'video'`.
      flowVideoMode: mediaType === 'video' ? (flowVideoMode ?? null) : null,
    }))

    const response = await this.sendRuntimeMessage({
      action: 'RUN_FLOW_PROMPT',
      payload
    })

    const partialSuccess = response.status === 'AUTO_DOWNLOAD_PARTIAL_SUCCESS'
    if (!response.success && !partialSuccess) {
      console.log(`[WorkflowRun][nodeResult] ` + JSON.stringify({
        workflowRunId: this.taskId,
        nodeId: node.id,
        success: false,
        status: response.status,
        error: response.error,
        outputsCount: Array.isArray(response.outputs) ? (response.outputs as unknown[]).length : 0,
      }))
      throw new Error(response.error || response.status || 'Google Flow automation failed')
    }
    console.log(`[WorkflowRun][nodeResult] ` + JSON.stringify({
      workflowRunId: this.taskId,
      nodeId: node.id,
      success: true,
      status: response.status,
      outputsCount: Array.isArray(response.outputs) ? (response.outputs as unknown[]).length : 0,
    }))

    // Output assets — pulled off the BG response (which forwards them
    // from flow-content.ts) and exposed at the top level so:
    //   (a) WorkflowEditor.renderDrawflowNode can show the Generate
    //       node's preview thumbnail via data._output → runner's
    //       onNodeComplete → updateNode({_output}) →
    //       getGenerateOutputImageUrls(_output) walks images[] /
    //       imageUrls[] / result.images[] / result.imageUrls[].
    //   (b) Downstream Media/Download/Generate nodes can consume the
    //       outputs via runner.coerceMediaList, which reads
    //       value.images[] (MediaItem shape) and value.imageUrls[].
    // We expose three shapes on purpose:
    //   - `outputs`   : rich per-tile descriptor (Flow-specific
    //                  metadata: tileId, savedFilename, outputFolder,
    //                  resolution, mode, ...).
    //   - `images`    : MediaItem shape compatible with ChatGPT's
    //                  `images` array (data/url, mimeType, aspectRatio,
    //                  source) so downstream nodes see one contract
    //                  across both providers.
    //   - `imageUrls` : flat string[] of asset URLs for the UI
    //                  renderer, which prefers this for thumbnails.
    //   - `result`    : full BG response (already includes
    //                  outputs/images/imageUrls — kept for callers
    //                  that recurse into the raw response).
    const responseOutputs = Array.isArray(response.outputs) ? response.outputs : []
    const responseImages = Array.isArray(response.images) ? response.images : []
    const responseImageUrls = Array.isArray(response.imageUrls) ? response.imageUrls : []

    // [Workflow][OutputNormalize] Apply per-output normalization to BOTH
    // `outputs[]` (rich descriptor) and `images[]` (MediaItem shape) so the
    // video case has `videoUrl`/`mediaUrl`/`url` populated and `imageUrl`
    // CLEARED. Without this, `getGenerateOutputImageUrls` walks
    // `imageUrl` (which carries the video URL when the bridge fills it),
    // and the Workflow UI tries to render a `<video>` URL as `<img>` —
    // the Generate node preview shows blank even though the run
    // succeeded with `outputsCount=1`. See normalizeWorkflowOutput for
    // the exact contract.
    const normalizedOutputs = responseOutputs
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => normalizeWorkflowOutput(item))
    const normalizedImages = responseImages
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => normalizeWorkflowOutput(item))
    // `imageUrls[]` is a flat string[]; normalization just keeps the
    // existing entries (no field-by-field rewrite needed).
    const normalizedImageUrls = responseImageUrls.filter((u): u is string => typeof u === 'string' && u.length > 0)

    // [Workflow][NodeOutput] google-flow outputs=N — emitted exactly once
    // per Generate node so operators can confirm the node received the
    // produced assets. Logged at default verbosity (no debug flag).
    // `outputsAvailableCount` counts tiles that Flow produced with a
    // usable URL (independent of whether they were saved to disk);
    // `outputsDownloadedCount` counts only the ones where the file
    // actually landed on disk via chrome.downloads.download.
    console.log(`[Workflow][NodeOutput] google-flow outputs=${normalizedOutputs.length} (${normalizedOutputs.filter(function (o) { return (o as Record<string, unknown>).outputAvailable === true }).length} available / ${normalizedOutputs.filter(function (o) { return (o as Record<string, unknown>).downloadSuccess === true }).length} downloaded)`)

    // Optional focus-restore policy (mirror of the ChatGPT branch).
    // The flow generation has already completed by this point, so
    // the Flow tab is no longer driving any pipeline. Restoring
    // the editor here is purely cosmetic — but it gives the user
    // the visual cue "the workflow advanced". Default is
    // 'provider-during-node' (no restore) for safety; opt in via
    // `data.restoreFocusPolicy === 'restore-editor-after-submit'`.
    if (shouldRestoreEditorAfterProviderAction(data)) {
      this.sendRuntimeMessage({
        action: 'RESTORE_EDITOR_FOCUS',
        payload: { nodeId: node.id, provider: 'google-flow' }
      }).catch((err) => {
        console.warn('[Workflow][Runner] restore editor focus failed (non-fatal)', {
          nodeId: node.id,
          provider: 'google-flow',
          error: (err as Error)?.message,
        })
      })
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
      // Top-level output assets — these are what the Workflow UI walks
      // for the Generate-node preview and what downstream
      // Media/Download/Generate nodes see via coerceMediaList.
      //
      // `normalizedOutputs` / `normalizedImages` are the per-asset
      // descriptors re-shaped by `normalizeWorkflowOutput` so each
      // item has the correct `videoUrl`/`imageUrl`/`mediaUrl`/`url`
      // for its media type. The Workflow UI's renderDrawflowNode +
      // getGenerateOutputImageUrls rely on this — see the comment
      // above `normalizeWorkflowOutput` for the exact contract.
      outputs: normalizedOutputs,
      images: normalizedImages,
      imageUrls: normalizedImageUrls,
      // Convenience: pre-filtered list of usable outputs (outputAvailable).
      // Use this instead of `outputs` filtering downstream — it
      // matches the semantic of "what can I render / forward".
      // `downloadSuccess === true` is narrower (only file-on-disk),
      // so we deliberately DO NOT use it here.
      successfulOutputs: normalizedOutputs.filter(function (o) { return (o as Record<string, unknown>).outputAvailable === true }),
      // Default selectedOutputIndex = 0 on first run. The editor's
      // onNodeComplete persists it back into node data; this default
      // ensures downstream nodes reading the in-memory output before
      // the persistence flush still get index 0 instead of undefined.
      selectedOutputIndex: 0,
      outputsCount: normalizedOutputs.length,
      downloadFailReason: response.downloadFailReason,
      lastError: response.lastError,
      tileErrors: response.tileErrors,
      firstDirectSrcAvailable: response.firstDirectSrcAvailable,
      // `result` retained for backward-compat with callers that read
      // response.status, response.autoDownload, etc. It also embeds
      // outputs/images/imageUrls for the recursive
      // getGenerateOutputImageUrls path.
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

  private coerceMedia(value: unknown, inheritedOrigin?: string): MediaInput | null {
    if (!isRecord(value)) return null

    const mediaType = normalizeMediaType(value.mediaType || (value.videoData || value.videoUrl ? 'video' : 'image'))
    const data = asString(value.data)
      || asString(value.mediaData)
      || asString(value.imageData)
      || asString(value.videoData)
    // URL repair — see repairFlowUrl above. Asset descriptors that
    // originated from flow-content.ts already carry absolute URLs,
    // but legacy / 3rd-party descriptors might still have a path-
    // relative URL. Repair against providerOrigin first, then
    // FALLBACK_LABS_ORIGIN when the path looks Flow-specific.
    const providerOrigin = asString(value.providerOrigin) || inheritedOrigin
    const rawUrl = asString(value.url)
      || asString(value.mediaUrl)
      || asString(value.imageUrl)
      || asString(value.videoUrl)
    const url = repairFlowUrl(rawUrl, providerOrigin)

    if (!data && !url) return null

    return {
      mediaType,
      data,
      url,
      name: asString(value.name) || asString(value.mediaName) || asString(value.imageName) || asString(value.videoName),
      mimeType: asString(value.mimeType) || asString(value.mediaMimeType),
      aspectRatio: asString(value.aspectRatio),
      providerOrigin: providerOrigin || undefined,
      sourcePageUrl: asString(value.sourcePageUrl) || undefined,
    }
  }

  private coerceMediaList(value: unknown, inheritedOrigin?: string): MediaInput[] {
    if (Array.isArray(value)) {
      return value.flatMap((item) => this.coerceMediaList(item, inheritedOrigin))
    }
    if (!isRecord(value)) return []

    const media: MediaInput[] = []
    // Inherit providerOrigin from the parent record so a relative URL
    // at any depth can be repaired against the Flow origin.
    const nextInheritedOrigin = asString(value.providerOrigin) || inheritedOrigin
    const direct = this.coerceMedia(value, nextInheritedOrigin)
    if (direct) media.push(direct)

    const inheritedAspectRatio = asString(value.aspectRatio)
    const pushGeneratedMedia = (item: unknown, index: number) => {
      if (!isRecord(item)) return
      const generated = this.coerceMedia({
        mediaType: item.mediaType || 'image',
        data: asString(item.data) || asString(item.mediaData) || asString(item.imageData),
        url: asString(item.url) || asString(item.mediaUrl) || asString(item.imageUrl),
        name: asString(item.name) || asString(item.mediaName) || asString(item.imageName) || `generated-image-${index + 1}`,
        mimeType: asString(item.mimeType) || asString(item.mediaMimeType) || 'image/png',
        aspectRatio: asString(item.aspectRatio) || inheritedAspectRatio,
        providerOrigin: asString(item.providerOrigin) || nextInheritedOrigin,
        sourcePageUrl: asString(item.sourcePageUrl),
      }, nextInheritedOrigin)
      if (generated) media.push(generated)
    }

    const generatedImages = value.images
    if (Array.isArray(generatedImages)) {
      generatedImages.forEach(pushGeneratedMedia)
    }

    const imageUrls = value.imageUrls
    if (Array.isArray(imageUrls)) {
      imageUrls.forEach((url, index) => {
        if (typeof url !== 'string' || !url) return
        const repaired = repairFlowUrl(url, nextInheritedOrigin)
        const alreadyIncluded = media.some((item) => item.url === repaired)
        if (!alreadyIncluded) {
          media.push({
            mediaType: 'image',
            url: repaired,
            name: `generated-image-${index + 1}.png`,
            mimeType: 'image/png',
            aspectRatio: inheritedAspectRatio,
            providerOrigin: nextInheritedOrigin,
          })
        }
      })
    }

    const result = value.result
    if (isRecord(result)) {
      for (const item of this.coerceMediaList(result, nextInheritedOrigin)) {
        const alreadyIncluded = media.some((existing) => {
          return (item.data && existing.data === item.data) || (item.url && existing.url === item.url)
        })
        if (!alreadyIncluded) media.push(item)
      }
    }

    return media
  }

  private async prepareUploadableMediaInputs(mediaInputs: MediaInput[]): Promise<MediaInput[]> {
    const uploadable: MediaInput[] = []

    for (const media of mediaInputs) {
      if (media.data) {
        uploadable.push(media)
        continue
      }

      if (!media.url) continue

      const resolved = await this.resolveMediaUrlToData(media)
      if (!resolved?.data) {
        throw new Error(`Could not prepare media "${media.name || media.url}" for upload`)
      }
      uploadable.push(resolved)
    }

    return uploadable
  }

  private async resolveMediaUrlToData(media: MediaInput): Promise<MediaInput | null> {
    const rawUrl = media.url || ''
    if (!rawUrl) return null

    // Repair any path-relative URL against the asset's providerOrigin
    // (or fallback to labs.google for Flow-style paths) BEFORE the
    // fetch attempt. The browser would otherwise resolve a relative
    // URL against the extension / file:// origin and report
    // ERR_FILE_NOT_FOUND.
    const url = repairFlowUrl(rawUrl, media.providerOrigin)

    if (url.startsWith('data:')) {
      return { ...media, data: url }
    }

    // 1) Direct fetch — works for non-Flow URLs and for any asset the
    //    runner can reach on its own (e.g. an externally hosted image
    //    that the user dragged into a Media Node).
    try {
      const response = await fetch(url)
      if (response.ok) {
        const blob = await response.blob()
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result || ''))
          reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
          reader.readAsDataURL(blob)
        })
        const mimeType = media.mimeType || blob.type || (media.mediaType === 'video' ? 'video/mp4' : 'image/png')
        return {
          ...media,
          data,
          mimeType,
          name: media.name || this.mediaNameFromMime(media.mediaType, mimeType),
        }
      }
    } catch (_) {
      // Direct fetch failed — fall through to the Flow-tab proxy.
    }

    // 2) Flow-tab proxy. Required when:
    //   - the URL is a Flow-style path the runner cannot resolve from
    //     the extension / side panel context (cookie + same-origin
    //     context missing);
    //   - or the asset's source is google-flow (legacy / current path
    //     both qualify).
    const isFlowUrl = url.indexOf('https://labs.google/') === 0
      || url.indexOf('http://labs.google/') === 0
      || url.indexOf('labs.google/') !== -1
    const isFlowSource = media.providerOrigin === 'google-flow' || (media as Record<string, unknown>).source === 'google-flow'
    if (isFlowUrl || isFlowSource) {
      const proxied = await this.fetchFlowMediaAsData(url)
      if (proxied) return proxied
    }

    console.warn('[Runner] Failed to fetch upstream media URL for upload', {
      name: media.name,
      mediaType: media.mediaType,
      urlSnippet: url.slice(0, 120),
    })
    return null
  }

  // Proxy a Flow-style URL through the BG's FLOW_FETCH_MEDIA_AS_DATA.
  // Returns a MediaInput with `data` set to a data URL (or null on
  // failure). The proxy fetch happens in the Flow tab's content script
  // so it has the cookie + same-origin context the runner is missing.
  private async fetchFlowMediaAsData(url: string): Promise<MediaInput | null> {
    try {
      if (!hasExtensionContextSafe()) {
        return null
      }
      const response = await chrome.runtime.sendMessage({
        action: 'FLOW_FETCH_MEDIA_AS_DATA',
        payload: {
          url,
          maxBytes: 25 * 1024 * 1024,
          asArrayBuffer: false,
        }
      }) as Record<string, unknown> | undefined
      if (!response || response.success !== true) {
        console.warn('[Runner] FLOW_FETCH_MEDIA_AS_DATA failed', {
          urlSnippet: url.slice(0, 120),
          error: (response && (response.error as string)) || 'unknown',
        })
        return null
      }
      const dataUrl = String(response.dataUrl || '')
      if (!dataUrl) return null
      const mimeType = String(response.mimeType || '')
      return {
        mediaType: 'image',
        data: dataUrl,
        url,
        mimeType,
        name: this.mediaNameFromMime('image', mimeType || 'image/png'),
        providerOrigin: 'google-flow',
        sourcePageUrl: url,
      }
    } catch (err) {
      console.warn('[Runner] FLOW_FETCH_MEDIA_AS_DATA threw', {
        urlSnippet: url.slice(0, 120),
        error: err,
      })
      return null
    }
  }

  private mediaNameFromMime(mediaType: MediaKind, mimeType: string): string {
    const fallbackExtension = mediaType === 'video' ? 'mp4' : 'png'
    const extension = mimeType.includes('quicktime')
      ? 'mov'
      : mimeType.includes('jpeg')
        ? 'jpg'
        : mimeType.includes('/')
          ? mimeType.split('/')[1] || fallbackExtension
          : fallbackExtension
    return `${mediaType}-${Date.now()}.${extension}`
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
    // Default-mode logging: only emit a status line when the phase
    // changes (queued → submitting → waiting_result → rendering →
    // done/failed). With DEBUG_CHATGPT_HEARTBEAT or DEBUG_RUNNER_WAIT
    // enabled, also dump a verbose throttled status every ~15s for
    // operator debugging.
    let lastPhase: string | null = null

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
          // Phase-change log: always emit when the phase string from
          // the content script differs from what we saw last. With
          // debug flags enabled, also emit a throttled full-status
          // dump so operators can see heartbeat / progress deltas.
          const phaseChanged = phase !== lastPhase
          if (phaseChanged) {
            const elapsedSec = Math.round(elapsedMs / 1000)
            console.log(
              `[Runner] chatgpt phase: ${phase || 'unknown'} ` +
              `(${elapsedSec}s elapsed, job ${jobId})`
            )
            lastPhase = phase
          }
          if (DEBUG_FLAGS.chatgptHeartbeat || DEBUG_FLAGS.runnerWait) {
            debugLog('chatgptHeartbeat', '[Runner] wait chatgpt job', {
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
        }

        if (job.status === 'done') {
          console.log(
            `[Runner] chatgpt job done (${Math.round(elapsedMs / 1000)}s, ` +
            `${Array.isArray(job.imageUrls) ? job.imageUrls.length : 0} images, job ${jobId})`
          )
          if (DEBUG_FLAGS.chatgptHeartbeat) {
            debugLog('chatgptHeartbeat', '[Runner] chatgpt job done (verbose)', {
              jobId,
              imageCount: Array.isArray(job.imageUrls) ? job.imageUrls.length : 0,
              elapsedMs,
            })
          }
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
          console.error(`[Runner] chatgpt job failed: ${errMsg}`, { jobId, elapsedMs })
          throw new Error(errMsg)
        }

        // ── GATE A — dead content script / lost message channel. ──
        // No heartbeat for > heartbeatStaleMs means the polling loop
        // died or the tab crashed. Even if lastProgressAt is recent,
        // we cannot trust future updates.
        if (lastHeartbeatAt > 0 && lastHeartbeatAgoMs > heartbeatStaleMs) {
          console.error(
            `[Runner] chatgpt heartbeat lost: no update for ` +
            `${Math.round(lastHeartbeatAgoMs / 1000)}s (job ${jobId})`
          )
          if (DEBUG_FLAGS.chatgptHeartbeat) {
            debugLog('chatgptHeartbeat', '[Runner] chatgpt heartbeat lost (verbose)', {
              jobId,
              elapsedMs,
              lastHeartbeatAgoMs,
              lastProgressAgoMs,
              heartbeatStaleMs,
              phase,
            })
          }
          throw new Error(
            'ChatGPT content script heartbeat lost: no update for ' +
            Math.round(lastHeartbeatAgoMs / 1000) + 's. ' +
            'The chatgpt.com tab or content script may have been unloaded.'
          )
        }

        // ── GATE B — initial no-progress budget. ────────────────────
        if (!everSawProgress) {
          if (elapsedMs > initialNoProgressTimeoutMs) {
            console.error(
              `[Runner] chatgpt no-progress timeout after ` +
              `${Math.round(initialNoProgressTimeoutMs / 1000)}s (job ${jobId})`
            )
            if (DEBUG_FLAGS.chatgptHeartbeat) {
              debugLog('chatgptHeartbeat', '[Runner] chatgpt no-progress timeout (verbose)', {
                jobId,
                elapsedMs,
                initialNoProgressTimeoutMs,
              })
            }
            throw new Error(
              'Timeout waiting for ChatGPT result: no generation progress within ' +
              Math.round(initialNoProgressTimeoutMs / 1000) + 's'
            )
          }
        } else {
          // ── GATE C — generation has stalled. ────────────────────
          if (lastProgressAgoMs > staleMs && !stillActive) {
            console.error(
              `[Runner] chatgpt stale timeout: progress frozen for ` +
              `${Math.round(lastProgressAgoMs / 1000)}s (job ${jobId})`
            )
            if (DEBUG_FLAGS.chatgptHeartbeat) {
              debugLog('chatgptHeartbeat', '[Runner] chatgpt stale timeout (verbose)', {
                jobId,
                elapsedMs,
                lastHeartbeatAgoMs,
                lastProgressAgoMs,
                staleMs,
                phase,
              })
            }
            throw new Error(
              'Timeout waiting for ChatGPT result: progress stale for ' +
              Math.round(lastProgressAgoMs / 1000) + 's'
            )
          }
          // Heartbeat keeps coming but real progress hasn't moved
          // for 2x staleMs — even with an active signal we should
          // not wait forever.
          if (lastProgressAgoMs > staleMs * 2) {
            console.error(
              `[Runner] chatgpt hard-stale timeout: progress frozen for ` +
              `${Math.round(lastProgressAgoMs / 1000)}s despite heartbeat (job ${jobId})`
            )
            if (DEBUG_FLAGS.chatgptHeartbeat) {
              debugLog('chatgptHeartbeat', '[Runner] chatgpt hard-stale timeout (verbose)', {
                jobId,
                elapsedMs,
                lastHeartbeatAgoMs,
                lastProgressAgoMs,
                phase,
              })
            }
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

    console.error(
      `[Runner] chatgpt max-wait timeout after ` +
      `${Math.round((Date.now() - startedAt) / 1000)}s (job ${jobId})`
    )
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

/**
 * [WorkflowRun][probe] Investigation-only runner-side probe.
 * Mirrors the UI-side `probeRunRequest` helper. Enabled by
 * `localStorage.AI_FLOW_DEBUG_RUN_SOURCE === '1'`. Default OFF.
 */
const WORKFLOW_RUN_SOURCE_PROBE: boolean =
  typeof localStorage !== 'undefined'
  && localStorage.getItem('AI_FLOW_DEBUG_RUN_SOURCE') === '1'

const probeRunnerState = (
  event: 'create' | 'enter-guard' | 'ignored-duplicate' | 'start' | 'finish' | 'error' | 'cancel' | 'cleanup',
  payload: Record<string, unknown>
): void => {
  if (!WORKFLOW_RUN_SOURCE_PROBE) return
  // eslint-disable-next-line no-console
  console.log('[WorkflowRun][runnerState]', { event, ...payload })
}

export async function runPipeline(
  workflow: Workflow,
  callbacks: PipelineCallbacks = {}
): Promise<void> {
  // [WorkflowRun] Single-flight guard at the runner boundary.
  //
  // The runner is the only place a workflow execution starts in
  // production. If a second `runPipeline` arrives while the first
  // is still running (rapid double-click on the toolbar button, an
  // effect re-firing after re-render, or the dashboard quick-run
  // racing the editor Run button), we MUST NOT start a parallel
  // execution. Two parallel runs would each dispatch their own
  // `RUN_FLOW_PROMPT` / `RUN_CHATGPT_PROMPT`, producing duplicate
  // tiles / duplicate ChatGPT turns — exactly the symptom the
  // hotfix is closing.
  //
  // Returning silently (instead of throwing) lets the caller's
  // `handleRun` finish without raising the "Unable to run workflow."
  // alert that double-clicks would otherwise surface.
  probeRunnerState('enter-guard', {
    workflowId: workflow.id,
    workflowName: workflow.name,
    previousRunnerTaskId: currentRunner?.taskId ?? null,
    previousRunnerIsRunning: currentRunner?.isRunning ?? false
  })
  if (currentRunner?.isRunning) {
    probeRunnerState('ignored-duplicate', {
      workflowId: workflow.id,
      workflowName: workflow.name,
      previousRunnerTaskId: currentRunner.taskId,
      previousRunnerIsRunning: currentRunner.isRunning
    })
    console.warn(`[WorkflowRun][ignoredDuplicate] ` + JSON.stringify({
      workflowRunId: currentRunner.taskId,
      workflowId: workflow.id,
      reason: 'currentRunner.isRunning',
      note: 'A pipeline is already running for another workflow (or this one). Returning silently.',
    }))
    return
  }
  const pipelineStore = usePipelineStore.getState()
  const task = pipelineStore.createTask(workflow.id)
  currentRunner = new PipelineRunner(workflow, task.id, callbacks)
  probeRunnerState('create', {
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflowRunId: task.id,
    activeTaskId: pipelineStore.activeTaskId
  })
  try {
    await currentRunner.run()
    probeRunnerState('finish', {
      workflowId: workflow.id,
      workflowRunId: task.id
    })
  } catch (error) {
    probeRunnerState('error', {
      workflowId: workflow.id,
      workflowRunId: task.id,
      errorMessage: error instanceof Error ? error.message : String(error)
    })
    throw error
  } finally {
    // Clear the singleton so a follow-up run can start. Only the
    // runner that owns the slot may clear it — guards against
    // a stale `currentRunner` surviving across workflow swaps.
    const isOwner = currentRunner && currentRunner.taskId === task.id
    probeRunnerState('cleanup', {
      workflowId: workflow.id,
      workflowRunId: task.id,
      isOwner,
      clearedToNull: isOwner ? null : 'preserved'
    })
    if (isOwner) {
      currentRunner = null
    }
  }
}

export function pausePipeline(): void {
  currentRunner?.pause()
}

export function resumePipeline(): void {
  currentRunner?.resume()
}

export function stopPipeline(): void {
  currentRunner?.stop()
  // Clear the singleton on explicit stop so the next Run can start
  // a fresh pipeline. The runner's own `run()` finally{} block
  // covers the natural-completion case; this covers user-initiated
  // cancellation which never reaches the finally{} block.
  currentRunner = null
}
