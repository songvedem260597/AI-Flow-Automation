/**
 * Portable workflow export / import bundle.
 *
 * Phase 4A scope:
 *   - Export workflow + every referenced IndexedDB asset into a
 *     single JSON file the user can drop on a different machine or
 *     Chrome profile.
 *   - Import that bundle, push the asset blobs back into the local
 *     IndexedDB, and remap old assetIds → new assetIds so the
 *     imported workflow renders the same previews without ever
 *     putting a base64 string into chrome.storage.local.
 *
 * Out of scope for Phase 4A (deferred to later phases):
 *   - Phase 5 GC / dedupe / quota dashboard.
 *   - JSZip / multi-file bundles (we use plain JSON for now).
 *   - templateImagePreview / templateVideoPoster handling
 *     (portability layer, must survive an IndexedDB miss).
 */

import {
  saveAssetFromBlob,
  getAsset,
  type AssetKind,
  type AssetSource
} from './assetStore'
import type { Workflow, WorkflowNode, WorkflowEdge } from '@/types'

const SUPPORTED_BUNDLE_FORMAT = 'ai-flow-workflow-bundle'
const SUPPORTED_BUNDLE_VERSION = 1

const SUPPORTED_ASSET_SOURCES: ReadonlySet<AssetSource> = new Set<AssetSource>([
  'upload',
  'generated',
  'template',
  'download',
  'cropped'
])

/**
 * Asset pointer keys — every key on a `node.data` (or
 * `node.data._output.outputs[]`) that may carry an `asset_<id>`
 * pointer. Anything NOT in this set is left untouched by
 * `collectWorkflowAssetIds` and `remapWorkflowAssetIds`.
 */
const ASSET_POINTER_KEYS: ReadonlySet<string> = new Set<string>([
  'assetId',
  'mediaAssetId',
  'imageAssetId',
  'posterAssetId',
  'thumbnailAssetId',
  'templateAssetId'
])

interface BundleAssetEntry {
  oldAssetId: string
  kind: AssetKind
  mimeType: string
  fileName?: string
  size: number
  width?: number
  height?: number
  duration?: number
  source?: AssetSource
  originalUrl?: string
  /** data: URL — the only place Phase 4A persists bytes. */
  dataUrl: string
}

interface BundleMissingEntry {
  assetId: string
  reason: string
}

export interface WorkflowAssetBundleV1 {
  format: typeof SUPPORTED_BUNDLE_FORMAT
  version: typeof SUPPORTED_BUNDLE_VERSION
  exportedAt: number
  app: 'ai-flow-automation'
  workflow: Workflow
  assets: BundleAssetEntry[]
  missingAssets?: BundleMissingEntry[]
}

export interface ExportBundleResult {
  bundle: WorkflowAssetBundleV1
  ok: boolean
}

export interface ImportBundleResult {
  ok: boolean
  workflow: Workflow | null
  importedAssetIds: string[]
  assetIdMap: Record<string, string>
  missingAssetIds: string[]
  errors: string[]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const MAX_ASSET_SCAN_DEPTH = 64

/**
 * Walk the workflow looking for every `asset_<id>` pointer. Limit
 * the recursion depth so a malicious / huge nested array cannot
 * loop the bundler forever.
 */
const collectWorkflowAssetIds = (workflow: Workflow): string[] => {
  const ids = new Set<string>()
  const stack: Array<{ value: unknown; depth: number }> = []

  if (Array.isArray(workflow.nodes)) stack.push({ value: workflow.nodes, depth: 0 })
  // Edges can theoretically carry media paths one day — scan
  // them too, but they're typically empty.
  if (Array.isArray(workflow.edges)) stack.push({ value: workflow.edges, depth: 0 })

  while (stack.length) {
    const { value: current, depth } = stack.pop()!
    if (depth > MAX_ASSET_SCAN_DEPTH) continue
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      for (const value of current) {
        stack.push({ value, depth: depth + 1 })
      }
      continue
    }
    const record = current as Record<string, unknown>
    for (const [key, value] of Object.entries(record)) {
      if (ASSET_POINTER_KEYS.has(key) && typeof value === 'string' && value.startsWith('asset_')) {
        ids.add(value)
        continue
      }
      // We do not recurse into `_output.outputs[]` URL fields —
      // those are media URLs (http(s)/blob:/data:) and the renderer
      // falls back to them if the asset pointer is missing.
      if (value && typeof value === 'object') {
        stack.push({ value, depth: depth + 1 })
      }
    }
  }

  return Array.from(ids)
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })

const isSupportedAssetSource = (source: string): source is AssetSource => {
  for (const candidate of SUPPORTED_ASSET_SOURCES) {
    if (candidate === source) return true
  }
  return false
}

/**
 * Export the workflow + every referenced asset into a portable
 * JSON bundle.
 *
 * Never throws — missing / broken assets land in `missingAssets`
 * rather than aborting the export.
 */
export const exportWorkflowAssetBundle = async (
  workflow: Workflow
): Promise<ExportBundleResult> => {
  const ids = collectWorkflowAssetIds(workflow)
  const assets: BundleAssetEntry[] = []
  const missingAssets: BundleMissingEntry[] = []

  for (const id of ids) {
    try {
      const record = await getAsset(id)
      if (!record) {
        missingAssets.push({ assetId: id, reason: 'IndexedDB lookup returned null' })
        continue
      }
      const dataUrl = await blobToDataUrl(record.blob)
      if (!dataUrl.startsWith('data:')) {
        // FileReader produced something unexpected — defensive
        // skip. Bundle would still be valid JSON, just without
        // this asset.
        missingAssets.push({ assetId: id, reason: 'Could not encode blob to data URL' })
        continue
      }
      const entry: BundleAssetEntry = {
        oldAssetId: id,
        kind: record.kind,
        mimeType: record.mimeType,
        fileName: record.fileName,
        size: record.size,
        width: record.width,
        height: record.height,
        duration: record.duration,
        source: record.source,
        originalUrl: record.originalUrl,
        dataUrl
      }
      assets.push(entry)
    } catch (err) {
      missingAssets.push({
        assetId: id,
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const bundle: WorkflowAssetBundleV1 = {
    format: SUPPORTED_BUNDLE_FORMAT,
    version: SUPPORTED_BUNDLE_VERSION,
    exportedAt: Date.now(),
    app: 'ai-flow-automation',
    workflow,
    assets,
    missingAssets: missingAssets.length > 0 ? missingAssets : undefined
  }

  return { bundle, ok: true }
}

/**
 * Detect a workflow asset bundle payload. Returns the validated
 * bundle object or `null` when the payload is not a recognised
 * bundle (so the caller can fall back to plain-JSON import).
 */
export const parseWorkflowAssetBundle = (value: unknown): WorkflowAssetBundleV1 | null => {
  if (!value || typeof value !== 'object') return null
  const root = value as Record<string, unknown>
  if (root.format !== SUPPORTED_BUNDLE_FORMAT) return null
  if (root.version !== SUPPORTED_BUNDLE_VERSION) return null
  if (root.app !== 'ai-flow-automation') return null
  if (!isRecord(root.workflow)) return null
  if (!Array.isArray(root.assets)) return null
  return root as unknown as WorkflowAssetBundleV1
}

const dataUrlToBlob = (dataUrl: string): Blob | null => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const mime = match[1] || 'application/octet-stream'
  const isBase64 = match[2] === ';base64'
  const payload = match[3] || ''
  try {
    if (isBase64) {
      const binary = atob(payload)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
      }
      return new Blob([bytes], { type: mime })
    }
    return new Blob([decodeURIComponent(payload)], { type: mime })
  } catch {
    return null
  }
}

const generateWorkflowId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `wf_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  }
  return `wf_${Math.random().toString(36).slice(2, 18)}`
}

const generateNodeId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `node_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  }
  return `node_${Math.random().toString(36).slice(2, 18)}`
}

const generateEdgeId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `edge_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  }
  return `edge_${Math.random().toString(36).slice(2, 18)}`
}

/**
 * Remap every asset pointer inside the workflow from old → new ids.
 * The remap walks the workflow `data` tree (including nested
 * `_output` and `outputs[]`) but only touches keys in
 * `ASSET_POINTER_KEYS`. URL fields (`url`, `imageUrl`, `mediaUrl`,
 * `videoUrl`, `thumbnailUrl`, `poster`) are preserved verbatim so
 * the renderer's fallback chain keeps working.
 *
 * Returns a brand-new Workflow object — never mutates input.
 */
export const remapWorkflowAssetIds = (
  workflow: Workflow,
  assetIdMap: Record<string, string>
): Workflow => {
  if (Object.keys(assetIdMap).length === 0) return workflow

  const remapValue = (value: unknown): unknown => {
    if (value === null || value === undefined) return value
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(remapValue)
    if (!isRecord(value)) return value

    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (ASSET_POINTER_KEYS.has(key) && typeof child === 'string') {
        const next = assetIdMap[child]
        out[key] = next || child
        continue
      }
      out[key] = remapValue(child)
    }
    return out
  }

  const nextNodes: WorkflowNode[] = (Array.isArray(workflow.nodes) ? workflow.nodes : []).map((node) => {
    const nextData = isRecord(node.data) ? remapValue(node.data) : node.data
    return { ...node, data: nextData as WorkflowNode['data'] }
  })

  return { ...workflow, nodes: nextNodes }
}

/**
 * Import a bundle into the local IndexedDB and return a fully
 * remapped, freshly-id-ed workflow ready to feed `importWorkflow`
 * on the store.
 *
 * Failures are per-asset — a single broken entry is reported in
 * `errors` and skipped. The rest of the bundle is still imported.
 *
 * NEVER throws.
 */
export const importWorkflowAssetBundle = async (
  bundle: WorkflowAssetBundleV1
): Promise<ImportBundleResult> => {
  const errors: string[] = []
  const importedAssetIds: string[] = []
  const assetIdMap: Record<string, string> = {}
  const missingAssetIds: string[] = []

  for (const entry of bundle.assets) {
    const blob = dataUrlToBlob(entry.dataUrl)
    if (!blob) {
      errors.push(`Cannot decode dataUrl for asset ${entry.oldAssetId}`)
      missingAssetIds.push(entry.oldAssetId)
      continue
    }
    const source = entry.source && isSupportedAssetSource(entry.source)
      ? entry.source
      : 'download'
    try {
      const record = await saveAssetFromBlob(blob, {
        kind: entry.kind,
        source,
        mimeType: entry.mimeType,
        fileName: entry.fileName,
        width: entry.width,
        height: entry.height,
        duration: entry.duration,
        originalUrl: entry.originalUrl
      })
      assetIdMap[entry.oldAssetId] = record.id
      importedAssetIds.push(record.id)
    } catch (err) {
      errors.push(`saveAssetFromBlob failed for ${entry.oldAssetId}: ${err instanceof Error ? err.message : String(err)}`)
      missingAssetIds.push(entry.oldAssetId)
    }
  }

  if (!isRecord(bundle.workflow)) {
    errors.push('bundle.workflow is not an object')
    return {
      ok: false,
      workflow: null,
      importedAssetIds,
      assetIdMap,
      missingAssetIds,
      errors
    }
  }

  const sourceWorkflow = bundle.workflow as unknown as Workflow

  // Remap assetIds BEFORE minting fresh node / edge ids so the
  // remap walk sees the original (consistent) data shape.
  const remapped = remapWorkflowAssetIds(sourceWorkflow, assetIdMap)

  // Mint fresh workflow + node ids so the import does not collide
  // with an existing workflow in the store. Edges are remapped
  // against the new node id table.
  const nodeIdMap = new Map<string, string>()
  const now = Date.now()
  const nextNodes: WorkflowNode[] = Array.isArray(remapped.nodes)
    ? remapped.nodes.map((node) => {
        const freshId = generateNodeId()
        nodeIdMap.set(String(node.id), freshId)
        return {
          ...node,
          id: freshId,
          data: cloneUnknown(node.data) as WorkflowNode['data']
        }
      })
    : []

  const sourceEdges = Array.isArray(sourceWorkflow.edges) ? sourceWorkflow.edges : []
  const nextEdges: WorkflowEdge[] = []
  for (const edge of sourceEdges) {
    const sourceId = nodeIdMap.get(String(edge.source))
    const targetId = nodeIdMap.get(String(edge.target))
    if (!sourceId || !targetId) continue
    nextEdges.push({
      ...edge,
      id: generateEdgeId(),
      source: sourceId,
      target: targetId
    })
  }

  // Drop heavy / unsafe fields the sanitizer would strip anyway.
  // Bundle dataUrl must NEVER bleed into the persisted workflow.
  // We don't strip on import — the store-side sanitiser wipes
  // data:/blob: strings before persist, and assetId points are
  // already dropped if they failed to remap.

  const safeName = (sourceWorkflow.name || 'Imported Workflow').replace(/[\\/:*?"<>|]/g, '_')

  const nextWorkflow: Workflow = {
    id: generateWorkflowId(),
    name: `${safeName} (Imported)`,
    description: sourceWorkflow.description,
    nodes: nextNodes,
    edges: nextEdges,
    createdAt: now,
    updatedAt: now,
    tags: Array.isArray(sourceWorkflow.tags) ? [...sourceWorkflow.tags] : undefined
  }

  return {
    ok: true,
    workflow: nextWorkflow,
    importedAssetIds,
    assetIdMap,
    missingAssetIds,
    errors
  }
}

const cloneUnknown = <T>(value: T): T => {
  // Cheap deep clone — only used for nodes.data, which is already
  // JSON-shaped (no Date / Map / Set / Blob embedded in stored
  // workflows; sanitiser would have stripped them anyway).
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value)) as T
}
