/**
 * [AssetGC] Phase 5 — IndexedDB asset reference collection,
 * orphan detection, and user-driven cleanup.
 *
 * Goals (locked by user request):
 *   1. Collect every `asset_<id>` pointer referenced by any
 *      workflow / template / history / pending editor payload
 *      stored in `chrome.storage.local`.
 *   2. List IndexedDB assets and classify them as referenced vs
 *      orphan.
 *   3. Surface a Storage report so the user can see total /
 *      referenced / orphan bytes and the top offenders.
 *   4. Cleanup is user-initiated only, gated by a confirm dialog,
 *      and never touches assets that are still referenced.
 *
 * NOT in scope for Phase 5:
 *   - Auto cleanup (no silent delete).
 *   - Checksum / dedupe / remap (deferred; only reported).
 *   - Editing the export/import bundle contract.
 *   - Touching Flow / ChatGPT automation or any provider path.
 *   - Modifying `templateImagePreview` / `templateVideoPoster`.
 */

import {
  deleteAsset,
  listAssets,
  type AssetRecord,
  type AssetSource
} from './assetStore'

/**
 * Asset pointer keys — every field on a workflow node / template /
 * history entry that may carry an `asset_<id>` pointer. URL-shaped
 * fields (`url`, `imageUrl`, `videoUrl`, `mediaUrl`,
 * `thumbnailUrl`, `poster`, `originalUrl`) are intentionally
 * excluded — they may carry remote URLs or data: blobs and are
 * NOT assetId references.
 *
 * Mirrors `ASSET_POINTER_KEYS` in `assetBundle.ts` and the
 * migration table in `assetMigration.ts`. Keep these in sync.
 */
export const ASSET_POINTER_KEYS: ReadonlySet<string> = new Set<string>([
  'assetId',
  'mediaAssetId',
  'imageAssetId',
  'posterAssetId',
  'thumbnailAssetId',
  'templateAssetId'
])

/**
 * chrome.storage.local keys that may carry assetId pointers and
 * should be scanned. The list is intentionally explicit so we
 * never accidentally walk a future key that contains URL-shaped
 * data without realising it.
 *
 *   ai-flow-workflows              — main workflow store
 *   ai-flow-workflow-templates     — saved templates
 *   ai-flow-history                — history panel entries
 *   _pendingWorkflowEditor         — pending handoff on
 *                                    workflow-editor window open
 */
const SCAN_STORAGE_KEYS: ReadonlyArray<string> = [
  'ai-flow-workflows',
  'ai-flow-workflow-templates',
  'ai-flow-history',
  '_pendingWorkflowEditor'
]

/**
 * Recent-asset grace window. An asset created within the last
 * `RECENT_ASSET_GRACE_MS` ms is treated as not-yet-referenced
 * even if it isn't referenced anywhere — workflow persistence
 * and generate-output caching are async, and the user could
 * otherwise lose freshly-uploaded or freshly-generated media.
 */
export const RECENT_ASSET_GRACE_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Orphan-report rows are considered "stale" after this much wall
 * clock time. The UI must re-run `findOrphanAssets()` before any
 * destructive action whenever the cached report is older than this
 * — using a stale report could let the user delete an asset that
 * just got referenced.
 */
const REPORT_STALE_MS = 30 * 1000 // 30 seconds

/** Max depth for the recursive walker. Defensive against circular
 *  / runaway references. Matches the depth used in `assetBundle`. */
const WALK_MAX_DEPTH = 64

const ASSET_ID_PREFIX = 'asset_'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isAssetPointerCandidate = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(ASSET_ID_PREFIX)

const looksLikeWorkflowNodeShape = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  return typeof value.type === 'string' && typeof value.id !== 'undefined' && isRecord(value.data)
}

/**
 * Recursive walker that harvests every `asset_<id>` value from any
 * object / array. Walks only keys in `ASSET_POINTER_KEYS` when
 * descending into record children — URL-shaped keys are still
 * descended (they may nest other objects), but the walker will not
 * treat their string values as assetIds.
 *
 * The walk is bounded by `WALK_MAX_DEPTH`; deeper payloads are
 * truncated defensively. Dedupe is via a single Set per call.
 */
export const collectAssetRefsFromUnknown = (value: unknown, out?: Set<string>): Set<string> => {
  const ids = out || new Set<string>()
  const stack: unknown[] = [value]
  let depth = 0

  while (stack.length && depth < WALK_MAX_DEPTH) {
    depth += 1
    const current = stack.pop()
    if (current === null || current === undefined) continue
    if (typeof current !== 'object') continue

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item)
      continue
    }

    const record = current as Record<string, unknown>
    for (const [key, child] of Object.entries(record)) {
      if (ASSET_POINTER_KEYS.has(key) && isAssetPointerCandidate(child)) {
        ids.add(child)
      }
      // Always descend into nested objects / arrays — the walker
      // gates which string values count, not which keys are
      // entered. URL-shaped keys (e.g. `thumbnailUrl` carrying an
      // http URL) may still nest a `_output` sub-object on a
      // generate node.
      if (child !== null && typeof child === 'object') {
        stack.push(child)
      }
    }
  }

  return ids
}

/**
 * Read every `SCAN_STORAGE_KEYS` entry out of `chrome.storage.local`
 * and union their asset pointer sets.
 *
 * Storage values are stored as plain JSON strings (zustand
 * `persist` wraps them). The walker accepts either a parsed object
 * or a JSON string — strings are parsed best-effort, parse
 * failures silently contribute nothing.
 */
export const collectReferencedAssetIdsFromStorage = async (): Promise<Set<string>> => {
  const refs = new Set<string>()

  if (typeof chrome === 'undefined' || !chrome?.storage?.local) {
    return refs
  }

  const snapshot = await new Promise<Record<string, unknown>>((resolve) => {
    try {
      chrome.storage.local.get(SCAN_STORAGE_KEYS as unknown as string[], (result) => {
        resolve(result || {})
      })
    } catch {
      resolve({})
    }
  })

  for (const key of SCAN_STORAGE_KEYS) {
    const raw = snapshot[key]
    if (raw === undefined || raw === null) continue
    collectAssetRefsFromUnknown(raw, refs)
  }

  return refs
}

interface AssetUsageBucket {
  count: number
  bytes: number
}

export interface AssetUsageReport {
  totalAssets: number
  referencedAssets: number
  orphanAssets: number
  recentGraceAssets: number
  totalBytes: number
  referencedBytes: number
  orphanBytes: number
  byKind: Record<string, AssetUsageBucket>
  bySource: Record<string, AssetUsageBucket>
  largestAssets: Array<{
    id: string
    kind: AssetRecord['kind']
    source: AssetSource
    size: number
    mimeType: string
    fileName?: string
    createdAt: number
  }>
}

const emptyBucket = (): AssetUsageBucket => ({ count: 0, bytes: 0 })
const bumpBucket = (bucket: AssetUsageBucket, size: number): void => {
  bucket.count += 1
  bucket.bytes += size
}

export interface ListAssetUsageOptions {
  /** Override the referenced-id set (skips `chrome.storage.local` scan). */
  references?: Set<string>
  /** Override the IndexedDB listing (skips `listAssets()`). */
  assets?: AssetRecord[]
}

/**
 * Build a full usage report:
 *   - total / referenced / orphan counts and bytes
 *   - per-kind and per-source buckets
 *   - top 5 largest assets
 *
 * A fresh report is computed by default; callers with their own
 * `AssetRecord[]` / reference set (e.g. tests) can pass them via
 * the options.
 */
export const listAssetUsage = async (
  options: ListAssetUsageOptions = {}
): Promise<AssetUsageReport> => {
  const [assets, references] = await Promise.all([
    Promise.resolve(options.assets ?? (await listAssets())),
    Promise.resolve(options.references ?? (await collectReferencedAssetIdsFromStorage()))
  ])

  const byKind: Record<string, AssetUsageBucket> = {}
  const bySource: Record<string, AssetUsageBucket> = {}
  let totalBytes = 0
  let referencedBytes = 0
  let orphanBytes = 0
  let referencedAssets = 0
  let recentGraceAssets = 0

  for (const asset of assets) {
    const size = asset.size || 0
    totalBytes += size

    const kindBucket = byKind[asset.kind] || emptyBucket()
    bumpBucket(kindBucket, size)
    byKind[asset.kind] = kindBucket

    const sourceBucket = bySource[asset.source] || emptyBucket()
    bumpBucket(sourceBucket, size)
    bySource[asset.source] = sourceBucket

    if (references.has(asset.id)) {
      referencedAssets += 1
      referencedBytes += size
      continue
    }

    if (Date.now() - (asset.createdAt || 0) < RECENT_ASSET_GRACE_MS) {
      recentGraceAssets += 1
      // Still counts as orphan in the size tally — the report
      // shows "used bytes vs freeable bytes" honestly. The recent
      // grace bucket is reported separately so the UI can hide
      // it from the "clean up" CTA.
      orphanBytes += size
      continue
    }

    orphanBytes += size
  }

  const largestAssets = [...assets]
    .sort((a, b) => (b.size || 0) - (a.size || 0))
    .slice(0, 5)
    .map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      source: asset.source,
      size: asset.size || 0,
      mimeType: asset.mimeType,
      fileName: asset.fileName,
      createdAt: asset.createdAt || 0
    }))

  return {
    totalAssets: assets.length,
    referencedAssets,
    orphanAssets: assets.length - referencedAssets - recentGraceAssets,
    recentGraceAssets,
    totalBytes,
    referencedBytes,
    orphanBytes,
    byKind,
    bySource,
    largestAssets
  }
}

export type OrphanReason = 'unreferenced' | 'recent-grace'

export interface OrphanAssetRow {
  id: string
  kind: AssetRecord['kind']
  source: AssetSource
  size: number
  mimeType: string
  fileName?: string
  createdAt: number
  reason: OrphanReason
}

export interface OrphanAssetReport {
  generatedAt: number
  recentGraceAssets: number
  /** Orphan assets that may be cleaned up. */
  cleanable: OrphanAssetRow[]
  /** Assets excluded from cleanup because of the recent-grace window. */
  recentGrace: OrphanAssetRow[]
  /** Total freeable bytes (sum of `cleanable.size`). */
  cleanableBytes: number
  /** Full referenced set used to compute this report. */
  references: Set<string>
}

/**
 * Compute the orphan / cleanable set for the current IndexedDB
 * inventory + storage references. Returns a structured report so
 * the UI can show counts + freeable bytes + the recent-grace
 * exclusion list.
 *
 * Never throws — IndexedDB or chrome.storage failures collapse
 * to empty reports.
 */
export const findOrphanAssets = async (
  options: ListAssetUsageOptions = {}
): Promise<OrphanAssetReport> => {
  const [assets, references] = await Promise.all([
    Promise.resolve(options.assets ?? (await listAssets())),
    Promise.resolve(options.references ?? (await collectReferencedAssetIdsFromStorage()))
  ])

  const cleanable: OrphanAssetRow[] = []
  const recentGrace: OrphanAssetRow[] = []
  let cleanableBytes = 0
  let recentGraceAssets = 0

  for (const asset of assets) {
    if (references.has(asset.id)) continue

    const inGrace = Date.now() - (asset.createdAt || 0) < RECENT_ASSET_GRACE_MS
    const row: OrphanAssetRow = {
      id: asset.id,
      kind: asset.kind,
      source: asset.source,
      size: asset.size || 0,
      mimeType: asset.mimeType,
      fileName: asset.fileName,
      createdAt: asset.createdAt || 0,
      reason: inGrace ? 'recent-grace' : 'unreferenced'
    }

    if (inGrace) {
      recentGrace.push(row)
      recentGraceAssets += 1
      continue
    }

    cleanable.push(row)
    cleanableBytes += row.size
  }

  return {
    generatedAt: Date.now(),
    recentGraceAssets,
    cleanable,
    recentGrace,
    cleanableBytes,
    references
  }
}

export interface DeleteAssetsResult {
  deleted: number
  failed: Array<{ id: string; reason: string }>
}

/**
 * Delete a batch of asset IDs. Per-id failure is captured; a
 * single bad row never aborts the whole batch. The caller decides
 * whether to surface partial success.
 */
export const deleteAssetsById = async (assetIds: string[]): Promise<DeleteAssetsResult> => {
  const failed: Array<{ id: string; reason: string }> = []
  let deleted = 0

  for (const id of assetIds) {
    if (!id) continue
    try {
      await deleteAsset(id)
      deleted += 1
    } catch (err) {
      failed.push({
        id,
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return { deleted, failed }
}

export interface StorageEstimateSnapshot {
  indexedDbBytes: number
  browserUsageBytes: number | null
  browserQuotaBytes: number | null
  assetCount: number
  /** True if the caller has access to `navigator.storage.estimate()`. */
  browserEstimateSupported: boolean
}

/**
 * Combine the IndexedDB asset-store total with the browser's
 * `navigator.storage.estimate()` (origin-wide, not just IndexedDB).
 *
 * `estimate()` may not be available in every environment — we
 * report `null` for the missing halves and the UI must fall back
 * to a friendly "unavailable" line.
 */
export const getAssetStorageEstimate = async (): Promise<StorageEstimateSnapshot> => {
  const [assets, estimate] = await Promise.all([
    listAssets(),
    typeof navigator !== 'undefined' && typeof navigator.storage?.estimate === 'function'
      ? (async () => {
          try {
            return await navigator.storage.estimate()
          } catch {
            return null
          }
        })()
      : Promise.resolve(null)
  ])

  let indexedDbBytes = 0
  for (const asset of assets) {
    indexedDbBytes += asset.size || 0
  }

  return {
    indexedDbBytes,
    browserUsageBytes: estimate?.usage ?? null,
    browserQuotaBytes: estimate?.quota ?? null,
    assetCount: assets.length,
    browserEstimateSupported: estimate !== null
  }
}

/**
 * Lock helper. Given a snapshot, returns true if it's still
 * considered fresh. The Storage modal calls this before any
 * destructive action — if the report is stale, the modal must
 * re-run `findOrphanAssets()` rather than delete against a
 * possibly-orphaned snapshot.
 */
export const isOrphanReportFresh = (report: OrphanAssetReport): boolean =>
  Date.now() - report.generatedAt <= REPORT_STALE_MS

export const __test = {
  ASSET_ID_PREFIX,
  SCAN_STORAGE_KEYS,
  WALK_MAX_DEPTH,
  REPORT_STALE_MS
}