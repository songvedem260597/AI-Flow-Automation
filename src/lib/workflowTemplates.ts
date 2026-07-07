/**
 * User-saved workflow templates.
 *
 * Spec: store under chrome.storage.local key `ai-flow-workflow-templates`.
 * Each template is a snapshot of a Workflow with two enforced invariants:
 *
 *   1. NO heavy asset data. Base64 / blob / dataUrl / file / outputs full
 *      descriptors are stripped before serialization. Only URLs and small
 *      metadata survive. This keeps the storage payload tiny — a workflow
 *      with 20 MB of inline image data still saves in a few KB without a
 *      thumbnail, and under ~50 KB with one.
 *
 *   2. NO runtime state. selectedNodeId, editor flags, transient errors,
 *      logs, run results, draft inputs are all stripped. Only the
 *      runnable shape (nodes + edges + their config) is preserved.
 *
 * The OutputItem / Generate node may carry `outputs[]` rich descriptors
 * (`{ videoUrl, imageUrl, mediaUrl, url, thumbnailUrl, savedFilename }`).
 * We keep only the string URL fields and drop every heavyweight blob —
 * `outputs[]` for a video generation can be MB-sized otherwise.
 *
 * Image-bearing nodes (Media / Generate) in the source workflow almost
 * always live as raw base64 in `data.imageData` / `data.mediaData` /
 * `data.videoData`. The sanitizer strips those. Without a fallback
 * the restored template renders every Media node as a placeholder.
 *
 * `extractImageNodePreviews` walks every image-bearing node,
 * downscales its current preview to a max 1024px JPEG (q=0.75) and
 * writes the compressed data URL into `data.templateImagePreview`
 * (or `data.templateVideoPoster` for video Media-nodes). These are
 * fields the sanitizer explicitly preserves and the Media node
 * renderer falls back to. They are the only path that survives the
 * template round-trip without an external asset store.
 *
 * Thumbnail extraction is best-effort and 100% async. It walks the
 * workflow in priority order:
 *   a) Image-node first media (assetId > mediaUrl > imageUrl).
 *   b) Generate-node first successfulOutputImage.
 *   c) Video poster fallback.
 * Whatever resolves first wins. The originating node id is recorded
 * as `thumbnailSourceNodeId` so the restore path can prefer that
 * node's preview first. If nothing works the template is saved
 * without a thumbnail — UI will show a placeholder.
 *
 * Thumbnail is size-capped at 320x180 JPEG quality 0.75 — never more
 * than ~30 KB. Per-node previews are sized at 1024px longest side
 * (JPEG q=0.75) — enough for any Media-node preview but never full
 * resolution. The whole point is quota safety.
 */
import type { Workflow, WorkflowNode, WorkflowEdge } from '@/types'

const TEMPLATE_STORAGE_KEY = 'ai-flow-workflow-templates'

const THUMBNAIL_MAX_WIDTH = 320
const THUMBNAIL_MAX_HEIGHT = 180
const THUMBNAIL_QUALITY = 0.75
const THUMBNAIL_TIMEOUT_MS = 6000

// [WorkflowTemplate] Per-node preview caps. We keep this looser
// than the card thumbnail (1024 vs 320) because the preview has to
// survive a 100% zoom on the canvas. JPEG q=0.75 stays the same.
// Worst-case 1024×1024 JPEG ≈ ~120 KB; 3-4 image-bearing nodes
// still stay well under the chrome.storage.local per-entry quota.
const PREVIEW_MAX_SIDE = 1024
const PREVIEW_QUALITY = 0.75
const PREVIEW_TIMEOUT_MS = 6000

/**
 * [WorkflowTemplate] Field names that carry a per-node compressed
 * preview. The sanitizer keeps these explicit because we want a
 * grep-able whitelist instead of having to remember the magic
 * strings inside `sanitizeNodeForTemplate`. They are SAFE-TO-KEEP
 * because we wrote them ourselves with strict JPEG caps. Never add
 * raw base64 to this list.
 */
const SAFE_PREVIEW_FIELDS = new Set([
  'templateImagePreview',
  'templateVideoPoster',
  'templateAssetId',
  'templateThumbnailSource'
])

/**
 * [WorkflowTemplate] Total per-template soft cap for the combined
 * preview payload. Summed across every node in a save. Prevents a
 * pathological 50-image-node workflow from accidentally blowing
 * chrome.storage.local quotas. We silently skip per-node previews
 * past the cap rather than failing the whole save.
 */
const PREVIEW_TOTAL_BYTES_CAP = 4 * 1024 * 1024

// Fields that are guaranteed-to-be-base64 or inline blob strings — get
// nuked from every node without exception.
const HEAVY_NODE_FIELDS = new Set([
  'mediaData',
  'imageData',
  'videoData',
  'mediaPoster',
  'videoPoster'
])

// Field names whose VALUE we walk recursively to strip the same heavy
// fields. Top-level we only sanitize node.data, but Generate-node
// runs may have arbitrary ad-hoc structures (e.g. outputs[]) that
// hold base64.
const NESTED_OUTPUT_FIELDS = new Set([
  'outputs',
  'images',
  'imageUrls',
  'output',
  'result',
  'resultList'
])

// String keys nested outputs may use — we extract the URL fields and
// drop every other key (savedFilename / mime / data may be huge).
const URL_FIELDS_IN_OUTPUT = new Set([
  'url',
  'videoUrl',
  'imageUrl',
  'mediaUrl',
  'thumbnailUrl',
  'poster'
])

export interface UserWorkflowTemplate {
  id: string
  name: string
  description?: string
  /**
   * 320x180 JPEG data URL used for the Templates-tab card cover.
   * Best-effort — absent when nothing in the workflow resolved.
   */
  thumbnail?: string
  /**
   * Node id the card thumbnail was extracted from. Used by the
   * restore path so a Template with a missing thumbnail on a
   * specific node can fall back to that node's preview instead.
   * Optional and advisory — the renderer still walks the full
   * preview map regardless.
   */
  thumbnailSourceNodeId?: string
  workflow: {
    nodes: WorkflowNode[]
    edges: WorkflowEdge[]
  }
  nodeCount: number
  edgeCount: number
  createdAt: number
  updatedAt: number
  /** Origin marker so future migrations can detect user-saved entries
   * vs anything else that ever lived under this key. */
  source: 'user'
}

/**
 * Build the URL we try to render first for a single node. The priority
 * list matches the spec — image-node first, then generate-node output.
 * Empty string = nothing usable on this node.
 */
function pickCandidateImageUrl(node: WorkflowNode): string {
  const data = node.data as Record<string, unknown>
  const nodeType = String(node.type || '')

  if (nodeType === 'image') {
    const mediaType = String(data.mediaType || '').toLowerCase()
    // Image-node: prefer the literal-URL field for the active media type.
    const candidates: unknown[] = [
      data.imageUrl,
      data.mediaUrl,
      mediaType === 'video' ? data.videoUrl : null,
      data.thumbnailUrl,
      data.poster
    ]
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c
    }
    return ''
  }

  if (nodeType === 'generate') {
    // Generate-node: walk outputs[] for a successfulOutput / usable URL.
    const outputs = data.outputs
    if (Array.isArray(outputs) && outputs.length > 0) {
      for (const raw of outputs) {
        if (!raw || typeof raw !== 'object') continue
        const record = raw as Record<string, unknown>
        if (record.outputAvailable === false) continue
        const mediaType = String(record.mediaType || '').toLowerCase()
        if (mediaType && mediaType !== 'image') continue
        for (const field of URL_FIELDS_IN_OUTPUT) {
          const v = record[field]
          if (typeof v === 'string' && v.length > 0) return v
        }
      }
    }
    // Legacy fallback: data.imageUrls[] is a flat string array.
    const flatImages = data.imageUrls
    if (Array.isArray(flatImages)) {
      for (const v of flatImages) {
        if (typeof v === 'string' && v.length > 0) return v
      }
    }
    // poster fallback for video outputs.
    for (const field of ['mediaPoster', 'videoPoster', 'thumbnailUrl']) {
      const v = data[field]
      if (typeof v === 'string' && v.length > 0) return v
    }
    return ''
  }

  // Any other node type — generic fallthrough.
  const genericCandidates: unknown[] = [
    data.imageUrl,
    data.mediaUrl,
    data.thumbnailUrl
  ]
  for (const c of genericCandidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return ''
}

/**
 * Render an external image URL into a same-origin data URL sized into
 * THUMBNAIL_MAX_WIDTH × THUMBNAIL_MAX_HEIGHT. Cross-origin URLs that
 * block canvas (CORS) silently fall through to `null` — caller will
 * skip the thumbnail and save anyway.
 */
async function urlToResizedDataUrl(
  rawUrl: string,
  timeoutMs: number = THUMBNAIL_TIMEOUT_MS
): Promise<string | null> {
  let url = rawUrl.trim()
  if (!url) return null
  // Inline data: URLs — try directly without fetch (canvas can usually
  // read them same-origin even when larger).
  const isInlineData = url.startsWith('data:')

  const loadImage = (): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('image load failed'))
      img.src = url
    })

  let img: HTMLImageElement
  try {
    const imagePromise = loadImage()
    if (!isInlineData) {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('image load timeout')), timeoutMs)
      )
      img = await Promise.race([imagePromise, timeout])
    } else {
      img = await imagePromise
    }
  } catch {
    return null
  }
  if (!img.naturalWidth || !img.naturalHeight) return null

  const scale = Math.min(
    THUMBNAIL_MAX_WIDTH / img.naturalWidth,
    THUMBNAIL_MAX_HEIGHT / img.naturalHeight,
    1
  )
  const width = Math.max(1, Math.round(img.naturalWidth * scale))
  const height = Math.max(1, Math.round(img.naturalHeight * scale))

  if (typeof OffscreenCanvas !== 'undefined') {
    const off = new OffscreenCanvas(width, height)
    const ctx = off.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, width, height)
    try {
      const blob = await off.convertToBlob({ type: 'image/jpeg', quality: THUMBNAIL_QUALITY })
      return await blobToDataUrl(blob)
    } catch {
      return null
    }
  }

  const domCanvas = document.createElement('canvas')
  domCanvas.width = width
  domCanvas.height = height
  const domCtx = domCanvas.getContext('2d')
  if (!domCtx) return null
  domCtx.drawImage(img, 0, 0, width, height)
  return domCanvas.toDataURL('image/jpeg', THUMBNAIL_QUALITY)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * [WorkflowTemplate] Per-node preview source picker. Walks the
 * exact same field list the renderer uses to read the live preview,
 * but also includes the heavy raw base64 fields so the sanitizer
 * strip doesn't accidentally eliminate the only available source.
 *
 * Returns `{ kind, url }` so the caller knows which preview slot
 * (`templateImagePreview` vs `templateVideoPoster`) to write into.
 */
function pickImageNodePreviewSource(node: WorkflowNode): { kind: 'image' | 'video'; url: string } | null {
  const data = node.data as Record<string, unknown>
  const explicitMediaType = String(data.mediaType || '').toLowerCase()
  const nodeType = String(node.type || '')

  if (nodeType === 'generate') {
    // Walk outputs[] for the first successful image / video.
    const outputs = data.outputs
    if (Array.isArray(outputs)) {
      for (const raw of outputs) {
        if (!raw || typeof raw !== 'object') continue
        const record = raw as Record<string, unknown>
        if (record.outputAvailable === false) continue
        const mediaType = String(record.mediaType || '').toLowerCase()
        for (const field of URL_FIELDS_IN_OUTPUT) {
          const v = record[field]
          if (typeof v === 'string' && v.length > 0) {
            return { kind: mediaType === 'video' ? 'video' : 'image', url: v }
          }
        }
      }
    }
    const flatImages = data.imageUrls
    if (Array.isArray(flatImages)) {
      for (const v of flatImages) {
        if (typeof v === 'string' && v.length > 0) return { kind: 'image', url: v }
      }
    }
    for (const field of ['mediaPoster', 'videoPoster', 'thumbnailUrl']) {
      const v = data[field]
      if (typeof v === 'string' && v.length > 0) return { kind: 'video', url: v }
    }
    return null
  }

  if (nodeType === 'image') {
    // Video Media node — try the video fields first.
    if (explicitMediaType === 'video') {
      const v = data.videoData || data.videoUrl || data.mediaData || data.mediaUrl
      if (typeof v === 'string' && v.length > 0) return { kind: 'video', url: v }
      const poster = data.videoPoster || data.mediaPoster
      if (typeof poster === 'string' && poster.length > 0) return { kind: 'video', url: poster }
      return null
    }
    // Image Media node — image fields first.
    const v = data.imageData || data.imageUrl || data.mediaData || data.mediaUrl
    if (typeof v === 'string' && v.length > 0) return { kind: 'image', url: v }
    return null
  }

  // Other node types — generic fallthrough to imageUrl.
  const v = data.imageUrl || data.mediaUrl
  if (typeof v === 'string' && v.length > 0) return { kind: 'image', url: v }
  return null
}

/**
 * [WorkflowTemplate] Downscale an arbitrary source URL into a JPEG
 * data URL sized into PREVIEW_MAX_SIDE × PREVIEW_MAX_SIDE. Mirrors
 * `urlToResizedDataUrl` but with the preview-side caps and uses a
 * separate timeout to avoid one slow node blocking the rest.
 *
 * Returns `null` on CORS / decode / canvas failure — caller skips
 * that node and saves the template without it.
 */
async function urlToPreviewDataUrl(rawUrl: string): Promise<string | null> {
  let url = rawUrl.trim()
  if (!url) return null
  const isInlineData = url.startsWith('data:')

  const loadImage = (): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('image load failed'))
      img.src = url
    })

  let img: HTMLImageElement
  try {
    const imagePromise = loadImage()
    if (!isInlineData) {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('image load timeout')), PREVIEW_TIMEOUT_MS)
      )
      img = await Promise.race([imagePromise, timeout])
    } else {
      img = await imagePromise
    }
  } catch {
    return null
  }
  if (!img.naturalWidth || !img.naturalHeight) return null

  const scale = Math.min(
    PREVIEW_MAX_SIDE / img.naturalWidth,
    PREVIEW_MAX_SIDE / img.naturalHeight,
    1
  )
  const width = Math.max(1, Math.round(img.naturalWidth * scale))
  const height = Math.max(1, Math.round(img.naturalHeight * scale))

  if (typeof OffscreenCanvas !== 'undefined') {
    const off = new OffscreenCanvas(width, height)
    const ctx = off.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, width, height)
    try {
      const blob = await off.convertToBlob({ type: 'image/jpeg', quality: PREVIEW_QUALITY })
      return await blobToDataUrl(blob)
    } catch {
      return null
    }
  }

  const domCanvas = document.createElement('canvas')
  domCanvas.width = width
  domCanvas.height = height
  const domCtx = domCanvas.getContext('2d')
  if (!domCtx) return null
  domCtx.drawImage(img, 0, 0, width, height)
  return domCanvas.toDataURL('image/jpeg', PREVIEW_QUALITY)
}

/**
 * [WorkflowTemplate] Per-node preview extractor. Walks the workflow
 * once and resolves every image-bearing node (Media / Generate) to
 * a compressed JPEG data URL small enough to live inside the
 * sanitized template.
 *
 * Returns a `Map<nodeId, { dataUrl, kind }>`. Nodes without a usable
 * image are simply absent from the map. The caller decides whether
 * to bail or save anyway.
 *
 * Total size cap: PREVIEW_TOTAL_BYTES_CAP. Per-node previews are
 * skipped (silently) past the cap so a pathological workflow does
 * not break storage.
 */
export async function extractImageNodePreviews(
  workflow: Pick<Workflow, 'nodes'>
): Promise<Map<string, { dataUrl: string; kind: 'image' | 'video' }>> {
  const out = new Map<string, { dataUrl: string; kind: 'image' | 'video' }>()
  let totalBytes = 0
  for (const node of workflow.nodes) {
    const source = pickImageNodePreviewSource(node)
    if (!source) continue
    const dataUrl = await urlToPreviewDataUrl(source.url)
    if (!dataUrl) continue
    // Approximate byte count: data URL = ~1.37× raw bytes after base64.
    const approxBytes = Math.ceil(dataUrl.length / 1.37)
    if (totalBytes + approxBytes > PREVIEW_TOTAL_BYTES_CAP) continue
    totalBytes += approxBytes
    out.set(node.id, { dataUrl, kind: source.kind })
  }
  return out
}

/**
 * [WorkflowTemplate] Apply a per-node preview map onto a sanitized
 * node list. Mutates the input node list (a copy is made first).
 * The renderer falls back to `data.templateImagePreview` /
 * `data.templateVideoPoster` so this single helper is enough to
 * restore the live image after a save → load round-trip.
 */
export function applyNodePreviews(
  nodes: WorkflowNode[],
  previews: Map<string, { dataUrl: string; kind: 'image' | 'video' }>
): WorkflowNode[] {
  if (previews.size === 0) return nodes
  return nodes.map((node) => {
    const preview = previews.get(node.id)
    if (!preview) return node
    const dataRecord = (node.data && typeof node.data === 'object'
      ? (node.data as Record<string, unknown>)
      : {}) as Record<string, unknown>
    const slot = preview.kind === 'video' ? 'templateVideoPoster' : 'templateImagePreview'
    return {
      ...node,
      data: {
        ...dataRecord,
        [slot]: preview.dataUrl
      } as unknown as WorkflowNode['data']
    }
  })
}

/**
 * Walk order: first usable image-node asset, else first successful
 * Generate-node output, else first valid poster. Never throws.
 *
 * This variant also returns the originating node id. Most callers
 * want both the data URL and the id; the back-compat shim below
 * drops the id when only the URL is needed.
 */
export async function extractWorkflowThumbnail(
  workflow: Pick<Workflow, 'nodes'>
): Promise<string | undefined> {
  const result = await extractWorkflowThumbnailWithSource(workflow)
  return result?.dataUrl
}

/**
 * Like `extractWorkflowThumbnail`, but also returns the node id the
 * thumbnail was extracted from. The renderer can use that id to
 * prefer the originating node's preview when restoring a template.
 * If nothing resolved, returns `undefined`.
 */
export async function extractWorkflowThumbnailWithSource(
  workflow: Pick<Workflow, 'nodes'>
): Promise<{ dataUrl: string; sourceNodeId: string } | undefined> {
  // Order: image nodes first (deterministic — user's source media),
  // then generate nodes (run results).
  const orderedNodes = [
    ...workflow.nodes.filter((n) => n.type === 'image'),
    ...workflow.nodes.filter((n) => n.type === 'generate'),
    ...workflow.nodes.filter((n) => n.type !== 'image' && n.type !== 'generate')
  ]
  for (const node of orderedNodes) {
    const candidate = pickCandidateImageUrl(node)
    if (!candidate) continue
    const dataUrl = await urlToResizedDataUrl(candidate)
    if (dataUrl) return { dataUrl, sourceNodeId: node.id }
  }
  return undefined
}

/**
 * Clone a workflow into a strict template-safe shape. The returned
 * `nodes` array is a deep-cloned data tree with:
 *
 *   - heavy base64/blob fields stripped from `data.*`
 *   - heavy nested structures (`outputs[]`, etc.) replaced with a
 *     URL-only shrunken form so a video-result descriptor doesn't
 *     bloat the storage
 *   - `position` preserved (placeholder template still draws)
 *   - everything else preserved verbatim
 *
 * Edges are passed through unfiltered — they're always small.
 */
export function sanitizeWorkflowForTemplate(workflow: Pick<Workflow, 'nodes' | 'edges'>): {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
} {
  const nodes: WorkflowNode[] = workflow.nodes.map((node) =>
    sanitizeNodeForTemplate(node)
  )
  return { nodes, edges: workflow.edges.map((edge) => ({ ...edge })) }
}

function sanitizeNodeForTemplate(node: WorkflowNode): WorkflowNode {
  const dataRecord = (node.data && typeof node.data === 'object'
    ? (node.data as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const sanitizedData: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(dataRecord)) {
    if (HEAVY_NODE_FIELDS.has(key)) {
      // Drop entirely — base64/blob don't belong in templates.
      continue
    }
    if (NESTED_OUTPUT_FIELDS.has(key)) {
      sanitizedData[key] = sanitizeNestedOutputField(value)
      continue
    }
    sanitizedData[key] = value
  }

  return {
    id: node.id,
    type: node.type,
    position: { x: node.position?.x ?? 0, y: node.position?.y ?? 0 },
    data: sanitizedData as unknown as WorkflowNode['data']
  }
}

function sanitizeNestedOutputField(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeOutputItem(item))
  }
  if (value && typeof value === 'object') {
    return sanitizeOutputItem(value)
  }
  return undefined
}

function sanitizeOutputItem(item: unknown): Record<string, unknown> | undefined {
  if (!item || typeof item !== 'object') return undefined
  const record = item as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (HEAVY_NODE_FIELDS.has(key)) continue
    if (URL_FIELDS_IN_OUTPUT.has(key) && typeof value === 'string') {
      out[key] = value
    }
  }
  // Preserve outputAvailable / mediaType so downstream nodes that
  // run from the template can still distinguish image vs video.
  if (typeof record.outputAvailable === 'boolean') {
    out.outputAvailable = record.outputAvailable
  }
  if (typeof record.mediaType === 'string') {
    out.mediaType = record.mediaType
  }
  if (typeof record.savedFilename === 'string') {
    // savedFilename is a basename like `flow-output/foo.png` — safe
    // to keep.
    out.savedFilename = record.savedFilename
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Pick a unique template name. We never silently clobber an existing
 * entry — if the user already saved `${activeWorkflow.name} Template`
 * we'll append a numeric suffix.
 */
export function generateUniqueTemplateName(
  activeName: string,
  existing: Pick<UserWorkflowTemplate, 'name'>[]
): string {
  const base = `${activeName.trim() || 'Untitled Workflow'} Template`
  const taken = new Set(existing.map((t) => t.name))
  if (!taken.has(base)) return base
  for (let counter = 2; counter < 1000; counter += 1) {
    const candidate = `${base} (${counter})`
    if (!taken.has(candidate)) return candidate
  }
  // Extremely unlikely fallback — append the millisecond timestamp.
  return `${base} (${Date.now()})`
}

function readTemplatesFromStorage(): Promise<UserWorkflowTemplate[]> {
  return new Promise<UserWorkflowTemplate[]>((resolve) => {
    try {
      chrome.storage.local.get(TEMPLATE_STORAGE_KEY, (result) => {
        const raw = result?.[TEMPLATE_STORAGE_KEY]
        if (!raw) {
          resolve([])
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw))
        } catch {
          resolve([])
          return
        }
        if (!Array.isArray(parsed)) {
          resolve([])
          return
        }
        // Filter out malformed entries defensively.
        resolve(parsed.filter(isUserWorkflowTemplate))
      })
    } catch {
      resolve([])
    }
  })
}

function isUserWorkflowTemplate(value: unknown): value is UserWorkflowTemplate {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string') return false
  if (typeof record.name !== 'string') return false
  if (!record.workflow || typeof record.workflow !== 'object') return false
  const workflow = record.workflow as Record<string, unknown>
  if (!Array.isArray(workflow.nodes)) return false
  if (!Array.isArray(workflow.edges)) return false
  return typeof record.source === 'string'
}

function writeTemplatesToStorage(templates: UserWorkflowTemplate[]): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(
        { [TEMPLATE_STORAGE_KEY]: JSON.stringify(templates) },
        () => {
          const err = chrome.runtime.lastError
          if (err) reject(new Error(err.message))
          else resolve()
        }
      )
    } catch (err) {
      reject(err as Error)
    }
  })
}

/**
 * Read every saved template from chrome.storage.local. Returns `[]`
 * when the key is absent or the stored payload is malformed — the
 * Templates tab treats that as "no saved templates yet" and renders
 * only the built-in cards.
 */
export async function listWorkflowTemplates(): Promise<UserWorkflowTemplate[]> {
  return readTemplatesFromStorage()
}

/**
 * Persist a new template. Throws (Promise rejection) when chrome
 * storage reports a quota or write error — caller surfaces the
 * reason to the user.
 *
 * The helper is deliberately append-only — overwriting or renaming
 * is not in scope for the initial patch. If the user really wants to
 * update an entry, the right path is to delete the old one and save
 * again.
 */
export async function saveWorkflowTemplate(
  template: UserWorkflowTemplate
): Promise<UserWorkflowTemplate[]> {
  const existing = await readTemplatesFromStorage()
  const next = [...existing, template]
  await writeTemplatesToStorage(next)
  return next
}

/**
 * Drop a saved template by id. Returns the post-delete list. Used
 * by the Templates tab delete affordance — out of scope for this
 * patch but exposed here so the UI can wire it without re-implementing
 * the storage protocol.
 */
export async function deleteWorkflowTemplate(id: string): Promise<UserWorkflowTemplate[]> {
  const existing = await readTemplatesFromStorage()
  const next = existing.filter((t) => t.id !== id)
  await writeTemplatesToStorage(next)
  return next
}

/**
 * Derive a coarse category for a saved template so the Templates
 * tab filter chips can include it. The contract matches the
 * built-in cards:
 *   - 'Image' when the workflow contains any Image / Generate node
 *   - 'Batch' when the workflow contains Delay / Loop nodes
 *   - 'Custom' for everything else (still appears under "All")
 */
export function categorizeSavedTemplate(
  workflow: Pick<Workflow, 'nodes'>
): 'Image' | 'Batch' | 'Custom' {
  let hasImage = false
  let hasBatch = false
  for (const node of workflow.nodes) {
    if (node.type === 'image' || node.type === 'generate') hasImage = true
    if (node.type === 'delay' || node.type === 'loop') hasBatch = true
    if (hasImage && hasBatch) break
  }
  if (hasBatch && !hasImage) return 'Batch'
  if (hasImage) return 'Image'
  return 'Custom'
}

/**
 * Subscribe to chrome.storage.onChanged events for the user-template
 * key. Returns an unsubscribe fn. The callback fires after the
 * change has already been applied to storage, so callers can simply
 * re-invoke `listWorkflowTemplates()` to refresh in-memory state.
 *
 * No-op outside an extension runtime — the caller is expected to
 * gate on `typeof chrome !== 'undefined' && chrome.storage?.onChanged`.
 */
export function onWorkflowTemplatesChanged(
  callback: (next: UserWorkflowTemplate[]) => void
): () => void {
  if (
    typeof chrome === 'undefined' ||
    !chrome.storage ||
    !chrome.storage.onChanged
  ) {
    return () => {}
  }
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ) => {
    if (areaName !== 'local') return
    const change = changes[TEMPLATE_STORAGE_KEY]
    if (!change) return
    void listWorkflowTemplates()
      .then((list) => callback(list))
      .catch(() => {
        // Swallow — the next manual reload will reconcile.
      })
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}

export const WORKFLOW_TEMPLATE_STORAGE_KEY = TEMPLATE_STORAGE_KEY

/**
 * [WorkflowTemplate] Card-cover thumbnail resolver. Walks the
 * stored template in this order and returns the first non-empty
 * candidate:
 *
 *   1. `template.thumbnail`            — already-compressed card cover.
 *   2. First node `data.templateImagePreview`
 *                                     — per-node compressed preview
 *                                       saved at template-write time
 *                                       (see `applyNodePreviews`).
 *   3. First node `data.templateVideoPoster`
 *                                     — video poster slot; still
 *                                       usable as a static card cover.
 *   4. First node `data.imageUrl` /
 *      `data.mediaUrl` / `data.previewUrl`
 *                                     — pasted URL — only accepted
 *                                       when it parses as an
 *                                       http(s) / chrome-extension /
 *                                       storage URL, never `blob:` /
 *                                       `data:` (those die with the
 *                                       page that minted them).
 *
 * Returns `undefined` when the saved template has nothing usable —
 * the Templates tab then renders the regular text-only card.
 */
export function resolveTemplateCardThumbnail(
  template: Pick<UserWorkflowTemplate, 'thumbnail' | 'workflow'>
): string | undefined {
  const direct = template.thumbnail
  if (typeof direct === 'string' && direct.trim().length > 0) return direct

  for (const node of template.workflow.nodes) {
    const data = node.data as Record<string, unknown>
    if (!data || typeof data !== 'object') continue
    const inline = data.templateImagePreview
    if (typeof inline === 'string' && inline.trim().length > 0) return inline
    const poster = data.templateVideoPoster
    if (typeof poster === 'string' && poster.trim().length > 0) return poster
  }

  // [WorkflowTemplate] URL paste fallback — only accept
  // URLs that survive a tab swap. `blob:` and `data:` URLs are
  // scoped to the page that created them and produce broken
  // images once that tab closes.
  const SAFE_URL_PREFIXES = ['http://', 'https://', 'chrome-extension://', 'chrome://']
  for (const node of template.workflow.nodes) {
    const data = node.data as Record<string, unknown>
    if (!data || typeof data !== 'object') continue
    for (const field of ['imageUrl', 'mediaUrl', 'previewUrl', 'thumbnailUrl']) {
      const v = data[field]
      if (typeof v !== 'string') continue
      const trimmed = v.trim()
      if (trimmed.length === 0) continue
      if (SAFE_URL_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return trimmed
    }
  }

  return undefined
}
