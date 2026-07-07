/**
 * Migrate legacy workflow nodes that still carry base64 / data URL
 * bytes inside `imageData` / `mediaData` / `videoData` / `videoPoster`
 * / `mediaPoster` into IndexedDB assetId references.
 *
 * Scope (explicit):
 *   MIGRATE legacy live workflow fields:
 *     imageData, mediaData, videoData, videoPoster, mediaPoster
 *
 *   DO NOT TOUCH:
 *     templateImagePreview, templateVideoPoster,
 *     template.thumbnail, template.thumbnailSourceNodeId
 *   These are the portability layer for saved templates — they
 *   intentionally survive an IndexedDB miss.
 *
 * Strategy:
 *   1. Walk every node in a workflow.
 *   2. For each candidate field, parse the data URL → Blob.
 *   3. Save the Blob to the asset store with source='upload'.
 *   4. Set the assetId pointer on the node + remove the legacy
 *      field, but ONLY when the asset write succeeded. If save
 *      fails, the legacy field stays — the in-memory preview
 *      keeps working and the next session retries migration.
 *
 *   The persist sanitizer's `stripLegacyBase64WhenAssetPresent`
 *   already drops these fields at write time when an assetId is
 *   present, so the moment migration succeeds, the next persist
 *   cycle no longer carries the bytes.
 *
 *   Failures are non-fatal: `console.warn` only, never throws.
 *   Partial migration is fine — node-by-node.
 */

import {
  saveAssetFromBlob,
  type AssetMeta,
  type AssetRecord
} from './assetStore'

interface MigrationResult {
  changed: boolean
  /** Asset IDs successfully migrated in this run, for caller logs. */
  migratedAssetIds: string[]
  /** Node IDs whose legacy fields remained because save failed. */
  failedNodeIds: string[]
}

const asString = (value: unknown): string =>
  typeof value === 'string' && value.length > 0 ? value : ''

const isDataUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('data:')

/** Decode a `data:` URL to a Blob. Returns null on any failure. */
const dataUrlToBlob = (dataUrl: string): Blob | null => {
  if (!isDataUrl(dataUrl)) return null
  try {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
    if (!match) return null
    const mime = match[1] || 'application/octet-stream'
    const isBase64 = match[2] === ';base64'
    const payload = match[3] || ''
    if (isBase64) {
      const binary = atob(payload)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
      }
      return new Blob([bytes], { type: mime })
    }
    // url-encoded payload — decode and treat as text/binary via decodeURIComponent + TextEncoder
    try {
      const decoded = decodeURIComponent(payload)
      return new Blob([decoded], { type: mime })
    } catch {
      return new Blob([payload], { type: mime })
    }
  } catch {
    return null
  }
}

const inferKindFromMime = (mime: string): 'image' | 'video' | 'poster' => {
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  // unknown / octet-stream — caller can override via field name.
  return 'image'
}

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

interface FieldSpec {
  /** Legacy field key on node.data carrying the data URL. */
  source: 'imageData' | 'mediaData' | 'videoData' | 'videoPoster' | 'mediaPoster'
  /** Asset pointer key to write on success. */
  assetKey:
    | 'assetId'
    | 'mediaAssetId'
    | 'imageAssetId'
    | 'posterAssetId'
    | 'thumbnailAssetId'
  /** AssetMeta.kind hint for the IndexedDB record. */
  kindHint: 'image' | 'video' | 'poster'
  /** Optional mime fallback when the data URL has no explicit mime. */
  mimeFallback: string
  /** Pull a couple of metadata hints from the node data. */
  pickMeta: (data: Record<string, unknown>) => {
    fileName?: string
    mimeType?: string
    width?: number
    height?: number
  }
}

/**
 * Field plan for an image node. We try `imageData` first, then
 * `mediaData` as a fallback — historically the codebase carried both
 * aliases. The FIRST successful candidate wins; the second is left
 * untouched (the sanitizer strips it on next persist once we drop the
 * first via assetId presence).
 */
const MEDIA_NODE_FIELDS: FieldSpec[] = [
  {
    source: 'imageData',
    assetKey: 'assetId',
    kindHint: 'image',
    mimeFallback: 'image/jpeg',
    pickMeta: (data) => ({
      fileName: asString(data.mediaName) || asString(data.imageName) || asString(data.fileName) || undefined,
      mimeType: asString(data.mediaMimeType) || asString(data.imageMimeType) || asString(data.mimeType) || undefined,
      width: asNumber(data.mediaWidth) ?? asNumber(data.imageWidth) ?? asNumber(data.width),
      height: asNumber(data.mediaHeight) ?? asNumber(data.imageHeight) ?? asNumber(data.height)
    })
  },
  {
    source: 'mediaData',
    assetKey: 'mediaAssetId',
    kindHint: 'image',
    mimeFallback: 'image/jpeg',
    pickMeta: (data) => ({
      fileName: asString(data.mediaName) || asString(data.fileName) || undefined,
      mimeType: asString(data.mediaMimeType) || asString(data.mimeType) || undefined,
      width: asNumber(data.mediaWidth) ?? asNumber(data.width),
      height: asNumber(data.mediaHeight) ?? asNumber(data.height)
    })
  },
  {
    source: 'videoData',
    assetKey: 'assetId',
    kindHint: 'video',
    mimeFallback: 'video/mp4',
    pickMeta: (data) => ({
      fileName: asString(data.mediaName) || asString(data.videoName) || asString(data.fileName) || undefined,
      mimeType: asString(data.mediaMimeType) || asString(data.videoMimeType) || asString(data.mimeType) || undefined,
      width: asNumber(data.mediaWidth) ?? asNumber(data.videoWidth) ?? asNumber(data.width),
      height: asNumber(data.mediaHeight) ?? asNumber(data.videoHeight) ?? asNumber(data.height),
      duration: asNumber(data.duration)
    })
  }
]

const POSTER_FIELDS: FieldSpec[] = [
  {
    source: 'videoPoster',
    assetKey: 'posterAssetId',
    kindHint: 'poster',
    mimeFallback: 'image/jpeg',
    pickMeta: (data) => ({
      mimeType: 'image/jpeg'
    })
  },
  {
    source: 'mediaPoster',
    assetKey: 'thumbnailAssetId',
    kindHint: 'poster',
    mimeFallback: 'image/jpeg',
    pickMeta: (data) => ({
      mimeType: 'image/jpeg'
    })
  }
]

const existingAssetIdFor = (
  data: Record<string, unknown>,
  field: FieldSpec
): string => {
  if (typeof data[field.assetKey] === 'string' && data[field.assetKey]) {
    return String(data[field.assetKey])
  }
  // Media-asset alias resolution so a node that already has mediaAssetId
  // (from Phase 1) does not double-write imageData.
  if (field.assetKey === 'assetId' && typeof data.mediaAssetId === 'string' && data.mediaAssetId) {
    return String(data.mediaAssetId)
  }
  if (field.assetKey === 'mediaAssetId' && typeof data.assetId === 'string' && data.assetId) {
    return String(data.assetId)
  }
  if (field.assetKey === 'posterAssetId' && typeof data.thumbnailAssetId === 'string' && data.thumbnailAssetId) {
    return String(data.thumbnailAssetId)
  }
  if (field.assetKey === 'thumbnailAssetId' && typeof data.posterAssetId === 'string' && data.posterAssetId) {
    return String(data.posterAssetId)
  }
  return ''
}

interface NodeLike {
  id: string
  type?: string
  data?: unknown
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Try to migrate a single legacy field on a node's data.
 * Returns:
 *   { status: 'skipped' }  — nothing to migrate (no legacy field / no data URL / already has assetId)
 *   { status: 'migrated', data, asset }  — succeeded, `data` is the next node.data
 *   { status: 'failed', reason }  — save threw; caller keeps legacy data
 */
const migrateField = async (
  data: Record<string, unknown>,
  spec: FieldSpec
): Promise<
  | { status: 'skipped' }
  | { status: 'migrated'; nextData: Record<string, unknown>; asset: AssetRecord }
  | { status: 'failed'; reason: string }
> => {
  const legacy = asString(data[spec.source])
  if (!legacy) return { status: 'skipped' }
  if (!isDataUrl(legacy)) return { status: 'skipped' }
  if (existingAssetIdFor(data, spec)) return { status: 'skipped' }

  const blob = dataUrlToBlob(legacy)
  if (!blob) return { status: 'failed', reason: 'dataUrlToBlob:invalid' }
  if (blob.size === 0) return { status: 'failed', reason: 'dataUrlToBlob:empty' }

  const mimeType = blob.type || spec.pickMeta(data).mimeType || spec.mimeFallback
  const kind = blob.type ? inferKindFromMime(blob.type) : spec.kindHint
  const meta: AssetMeta = {
    kind,
    source: 'upload',
    mimeType,
    fileName: spec.pickMeta(data).fileName,
    width: spec.pickMeta(data).width,
    height: spec.pickMeta(data).height,
    duration: spec.pickMeta(data).duration,
    originalUrl: legacy.length > 1024 ? undefined : legacy
  }

  try {
    const asset = await saveAssetFromBlob(blob, meta)
    const { fileName: _fileName, width: _width, height: _height, mimeType: _mimeType, duration: _duration, ...rest } = spec.pickMeta(data)
    void _fileName; void _width; void _height; void _mimeType; void _duration
    const nextData: Record<string, unknown> = {
      ...rest,
      ...data,
      [spec.assetKey]: asset.id,
      mimeType,
      size: asset.size
    }
    // Always strip the legacy field after a successful save — the
    // sanitiser's heavy guard already excludes data: strings, so
    // stripping here keeps the in-memory state small too.
    delete nextData[spec.source]
    return { status: 'migrated', nextData, asset }
  } catch (err) {
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Migrate a single Media / Image node's legacy data fields. Only
 * runs on nodes whose `type` is `image` (or legacy aliases that
 * read like media nodes). Generate nodes are handled separately by
 * `migrateLegacyGenerateOutput`.
 */
const migrateMediaNode = async (
  node: NodeLike
): Promise<{
  changed: boolean
  nextData: Record<string, unknown> | null
  assetIds: string[]
  failedReason?: string
}> => {
  if (!isRecord(node.data)) return { changed: false, nextData: null, assetIds: [] }
  const data = node.data as Record<string, unknown>
  let working = data
  const assetIds: string[] = []
  let changed = false
  let lastFailure: string | undefined

  // Media field plan — try each in turn until one succeeds. We
  // intentionally allow multiple to migrate (e.g. a node carrying
  // both `imageData` and `mediaData` historically) so we don't
  // strand the secondary copy.
  for (const spec of MEDIA_NODE_FIELDS) {
    const result = await migrateField(working, spec)
    if (result.status === 'migrated') {
      working = result.nextData
      assetIds.push(result.asset.id)
      changed = true
    } else if (result.status === 'failed') {
      lastFailure = `${spec.source}:${result.reason}`
    }
  }

  // Poster field plan — independent of the media plan above. A
  // video node may carry both `videoData` (becomes assetId) and
  // `videoPoster` (becomes posterAssetId) without conflict.
  for (const spec of POSTER_FIELDS) {
    const result = await migrateField(working, spec)
    if (result.status === 'migrated') {
      working = result.nextData
      assetIds.push(result.asset.id)
      changed = true
    } else if (result.status === 'failed') {
      lastFailure = lastFailure || `${spec.source}:${result.reason}`
    }
  }

  return {
    changed,
    nextData: changed ? working : null,
    assetIds,
    failedReason: lastFailure
  }
}

/**
 * Migrate Generate node `_output` legacy fields. Phase 2 already
 * caches fresh outputs; this catches the case where a workflow was
 * generated BEFORE Phase 2 was deployed and the user reopens it.
 *
 * Only data: URLs in `url` / `imageUrl` / `videoUrl` / `mediaUrl` /
 * `poster` / `thumbnailUrl` are converted. http(s) and blob: URLs
 * are NOT migrated in Phase 3 — http(s) URLs may still be valid and
 * the editor's existing fallback chain handles missing assets; blob:
 * URLs are dead after reload so Phase 2 hotfix's data:/http(s) path
 * is the better fix going forward, not migration.
 */
const GENERATE_OUTPUT_URL_KEYS = ['url', 'imageUrl', 'videoUrl', 'mediaUrl', 'poster', 'thumbnailUrl'] as const

const migrateLegacyGenerateOutput = async (
  data: Record<string, unknown>
): Promise<{
  changed: boolean
  nextData: Record<string, unknown> | null
  assetIds: string[]
  failedReason?: string
}> => {
  if (!isRecord(data._output)) return { changed: false, nextData: null, assetIds: [] }
  const output = data._output as Record<string, unknown>
  const items = Array.isArray(output.outputs) ? output.outputs : null
  if (!items || items.length === 0) return { changed: false, nextData: null, assetIds: [] }

  let changed = false
  let lastFailure: string | undefined
  const assetIds: string[] = []
  const migratedItems: unknown[] = []

  for (const raw of items) {
    if (!isRecord(raw)) {
      migratedItems.push(raw)
      continue
    }
    const item = raw as Record<string, unknown>
    let nextItem: Record<string, unknown> = { ...item }
    let itemChanged = false

    for (const urlKey of GENERATE_OUTPUT_URL_KEYS) {
      const value = asString(item[urlKey])
      if (!isDataUrl(value)) continue
      const existingAssetId = asString(item.assetId)
      if (existingAssetId && urlKey === 'url') break // already migrated

      const blob = dataUrlToBlob(value)
      if (!blob || blob.size === 0) {
        lastFailure = lastFailure || `_output.${urlKey}:dataUrlToBlob`
        continue
      }
      const mime = blob.type || (urlKey === 'videoUrl' ? 'video/mp4' : 'image/png')
      const kind: 'image' | 'video' = mime.startsWith('video/') ? 'video' : 'image'
      try {
        const asset = await saveAssetFromBlob(blob, {
          kind,
          source: 'generated',
          mimeType: mime,
          originalUrl: undefined // data URL is too big to log
        })
        if (urlKey === 'poster' || urlKey === 'thumbnailUrl') {
          nextItem.posterAssetId = asset.id
          nextItem.thumbnailAssetId = asset.id
        } else {
          nextItem.assetId = asset.id
        }
        nextItem.mimeType = mime
        nextItem.size = asset.size
        // Strip the data URL — sanitizer also rejects data: strings,
        // but explicit removal keeps in-memory state compact too.
        delete nextItem[urlKey]
        assetIds.push(asset.id)
        itemChanged = true
      } catch (err) {
        lastFailure = lastFailure || `_output.${urlKey}:${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (itemChanged) changed = true
    migratedItems.push(nextItem)
  }

  if (!changed) return { changed: false, nextData: null, assetIds: [], failedReason: lastFailure }

  return {
    changed: true,
    nextData: {
      ...data,
      _output: { ...output, outputs: migratedItems }
    },
    assetIds,
    failedReason: lastFailure
  }
}

export interface MigrationSummary extends MigrationResult {
  workflowId: string
  nextNodes: NodeLike[]
}

interface MigrateOptions {
  workflowId: string
  nodes: NodeLike[]
}

/**
 * Walk a workflow's nodes, run media migration per image node, and
 * Generate-output migration per generate node. Returns the next
 * `nodes` array (unchanged when nothing migrated) and a summary for
 * caller logging. The function NEVER throws — every failure is
 * captured into `failedNodeIds` so the caller can log it.
 */
export const migrateLegacyWorkflowAssets = async (
  options: MigrateOptions
): Promise<MigrationSummary> => {
  const { workflowId, nodes } = options
  const migratedAssetIds: string[] = []
  const failedNodeIds: string[] = []
  const nextNodes: NodeLike[] = []

  for (const node of nodes) {
    const type = String(node.type || '')
    let nextNode = node

    if (type === 'image') {
      const result = await migrateMediaNode(node)
      if (result.changed && result.nextData) {
        nextNode = { ...node, data: result.nextData }
        migratedAssetIds.push(...result.assetIds)
      }
      if (result.failedReason) {
        failedNodeIds.push(node.id)
      }
    } else if (type === 'generate') {
      if (isRecord(node.data)) {
        const result = await migrateLegacyGenerateOutput(node.data as Record<string, unknown>)
        if (result.changed && result.nextData) {
          nextNode = { ...node, data: result.nextData }
          migratedAssetIds.push(...result.assetIds)
        }
        if (result.failedReason) {
          failedNodeIds.push(node.id)
        }
      }
    }

    nextNodes.push(nextNode)
  }

  if (failedNodeIds.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[AssetStore] legacy media migration partial', JSON.stringify({
      workflowId,
      migratedAssetIds: migratedAssetIds.length,
      failedNodeIds
    }))
  }

  return {
    workflowId,
    changed: migratedAssetIds.length > 0,
    migratedAssetIds,
    failedNodeIds,
    nextNodes
  }
}