/**
 * Cache Generate-node output URLs into the IndexedDB asset store.
 *
 * Strategy:
 *   1. Walk every entry in `output.outputs[]` (rich descriptor) and
 *      the flat `output.images[]` / `output.imageUrls[]` fallbacks.
 *   2. Try embedded media data first, then remote URLs. ChatGPT often
 *      returns both; embedded bytes are durable while a signed URL may
 *      require page credentials or expire before workflow reload.
 *   3. `fetch(candidate) → blob → saveAssetFromBlob(...)`. A failed
 *      candidate falls through to the next one. Total failure stays
 *      non-fatal and the caller keeps the original descriptor.
 *   4. For video outputs with an explicit `thumbnailUrl` / `poster`
 *      URL, attempt to cache the poster as a separate asset with
 *      `kind: 'poster'`. Failure stays silent.
 *
 * Inputs/outputs are kept in lock-step with `runner.normalizeWorkflowOutput`:
 *   - Original `url` / `videoUrl` / `imageUrl` / `mediaUrl` /
 *     `thumbnailUrl` / `poster` strings are NEVER removed.
 *   - The new `assetId` / `posterAssetId` / `thumbnailAssetId` fields
 *     are added alongside, and the original descriptor is returned as
 *     the source of truth so `WORKFLOW_DOWNLOAD_OUTPUT` keeps working
 *     unchanged.
 *   - Original `_output` itself is left untouched at the top level —
 *     `cacheGenerateOutputs` returns a fresh object only when at
 *     least one item successfully resolved an asset.
 */

import { saveAssetFromBlob, type AssetMeta } from './assetStore'

interface OutputItemLike {
  assetId?: unknown
  posterAssetId?: unknown
  thumbnailAssetId?: unknown
  data?: unknown
  mediaData?: unknown
  imageData?: unknown
  videoData?: unknown
  url?: unknown
  videoUrl?: unknown
  imageUrl?: unknown
  mediaUrl?: unknown
  thumbnailUrl?: unknown
  poster?: unknown
  mediaType?: unknown
  type?: unknown
  savedFilename?: unknown
  name?: unknown
  fileNameFromFlow?: unknown
  outputAvailable?: unknown
  mimeType?: unknown
  size?: unknown
}

interface OutputLike {
  assetId?: unknown
  imageAssetId?: unknown
  videoAssetId?: unknown
  posterAssetId?: unknown
  thumbnailAssetId?: unknown
  outputs?: unknown
  images?: unknown
  imageUrls?: unknown
  thumbnailUrl?: unknown
  poster?: unknown
}

const asString = (value: unknown): string =>
  typeof value === 'string' && value.length > 0 ? value : ''

const resolveItemSourceUrls = (item: OutputItemLike): string[] => {
  // ChatGPT's page-context collector can provide a data URL alongside
  // the visible remote URL. Prefer those bytes: fetching the remote URL
  // again from the extension side panel can fail because the request no
  // longer has ChatGPT's page credentials or because the URL expired.
  const candidates = [
    item.data,
    item.mediaData,
    item.imageData,
    item.videoData,
    item.videoUrl,
    item.url,
    item.mediaUrl,
    item.imageUrl,
    item.thumbnailUrl,
    item.poster
  ]
    .map(asString)
    .filter(Boolean)

  return Array.from(new Set(candidates))
}

const resolveItemSourceUrl = (item: OutputItemLike): string =>
  resolveItemSourceUrls(item)[0] || ''

const resolveItemKind = (item: OutputItemLike, blob: Blob | null): 'image' | 'video' => {
  const declared = String(item.mediaType || item.type || '').toLowerCase()
  if (declared === 'video') return 'video'
  if (declared === 'image') return 'image'
  const mime = (blob?.type || '').toLowerCase()
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('image/')) return 'image'
  const url = resolveItemSourceUrl(item).toLowerCase()
  if (/\.(mp4|mov|webm|m4v)(\?|$)/.test(url)) return 'video'
  if (url.includes('video')) return 'video'
  return 'image'
}

const fetchBlobFromUrl = async (url: string, timeoutMs = 8000): Promise<Blob | null> => {
  if (!url) return null
  // Skip only opaque page-internal protocols we cannot fetch from the
  // side panel document without security / CORS errors. `blob:` and
  // `data:` are fine — `fetch` against them in the same Document
  // resolves synchronously to the underlying Blob/byte stream, and
  // the cached asset lets the preview survive reload (the original
  // `blob:` URL is page-scoped and dies with the tab).
  if (/^(chrome-extension|chrome|file|about):/i.test(url)) return null
  // Only http(s)/blob/data survive the protocol allow-list above;
  // anything else (e.g. unsupported schemes) is skipped.
  if (!/^(https?|blob|data):/i.test(url)) return null
  // Soft cap: a `data:` URL larger than the size limit is almost
  // certainly a b64 image; we'd still cache it, but warn so an
  // operator can see why. Persisted `_output` will strip the URL
  // either way (sanitizer rejects data:/blob: strings > 100 KB).
  if (url.startsWith('data:') && url.length > 35_000_000) {
    // Keep transient base64 out of the persisted workflow when it is
    // beyond the existing output-cache safety ceiling. Normal ChatGPT
    // images are cached below this limit and replaced by assetId.
    // eslint-disable-next-line no-console
    console.warn('[AssetStore] data URL over 35 MB, skipping cache', { bytes: url.length })
    return null
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null
  try {
    const response = await fetch(url, controller ? { signal: controller.signal, credentials: 'omit' } : undefined)
    if (!response.ok) return null
    return await response.blob()
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const enrichItemWithAsset = async (
  item: OutputItemLike,
  index: number
): Promise<{ enriched: OutputItemLike; ok: boolean }> => {
  const sourceUrls = resolveItemSourceUrls(item)
  if (sourceUrls.length === 0) return { enriched: item, ok: false }

  let sourceUrl = ''
  let blob: Blob | null = null
  for (const candidate of sourceUrls) {
    blob = await fetchBlobFromUrl(candidate)
    if (blob) {
      sourceUrl = candidate
      break
    }
  }
  if (!sourceUrl || !blob) return { enriched: item, ok: false }

  const kind = resolveItemKind(item, blob)
  const fileName = asString(item.savedFilename).split(/[\\/]/).pop()
    || asString(item.name)
    || asString(item.fileNameFromFlow)
    || (kind === 'video' ? `generated-video-${index + 1}.${(blob.type.split('/')[1] || 'mp4')}` : `generated-image-${index + 1}.${(blob.type.split('/')[1] || 'png')}`)

  const meta: AssetMeta = {
    kind,
    source: 'generated',
    fileName,
    mimeType: blob.type || undefined,
    // Never duplicate a potentially multi-megabyte data URL inside
    // IndexedDB metadata; the Blob already contains the durable bytes.
    originalUrl: /^https?:/i.test(sourceUrl) ? sourceUrl : undefined
  }

  try {
    const record = await saveAssetFromBlob(blob, meta)
    const enriched: OutputItemLike = {
      ...item,
      assetId: record.id,
      mimeType: record.mimeType,
      size: record.size
    }

    // Poster cache for video outputs that ship an explicit poster URL.
    const posterUrl = asString(item.thumbnailUrl) || asString(item.poster)
    if (kind === 'video' && posterUrl && posterUrl !== sourceUrl) {
      try {
        const posterBlob = await fetchBlobFromUrl(posterUrl)
        if (posterBlob) {
          const posterMeta: AssetMeta = {
            kind: 'poster',
            source: 'generated',
            fileName: asString(item.savedFilename).split(/[\\/]/).pop()
              ? `${asString(item.savedFilename).split(/[\\/]/).pop()}-poster.jpg`
              : undefined,
            mimeType: posterBlob.type || 'image/jpeg',
            originalUrl: posterUrl
          }
          const posterRecord = await saveAssetFromBlob(posterBlob, posterMeta)
          enriched.posterAssetId = posterRecord.id
          enriched.thumbnailAssetId = posterRecord.id
        }
      } catch {
        // [AssetStore] Poster cache failure stays silent — poster URL
        // fallback in the renderer covers the gap.
      }
    }

    return { enriched, ok: true }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[AssetStore] output cache failed', {
      url: sourceUrl.slice(0, 160),
      kind,
      message: err instanceof Error ? err.message : String(err)
    })
    return { enriched: item, ok: false }
  }
}

const enrichTopLevelPoster = async (output: OutputLike): Promise<OutputItemLike | null> => {
  // Top-level thumbnailUrl / poster — applies to whole-output descriptors
  // that don't carry per-item posters (legacy flat shape).
  const url = asString(output.thumbnailUrl) || asString(output.poster)
  if (!url) return null
  const blob = await fetchBlobFromUrl(url)
  if (!blob) return null
  try {
    const record = await saveAssetFromBlob(blob, {
      kind: 'poster',
      source: 'generated',
      mimeType: blob.type || 'image/jpeg',
      originalUrl: url
    })
    return { assetId: record.id, mimeType: record.mimeType, size: record.size }
  } catch {
    return null
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Cache every URL inside a Generate-node output descriptor and return
 * a new descriptor with `assetId` / `posterAssetId` / `thumbnailAssetId`
 * populated where the cache succeeded. When nothing resolved, the
 * input object is returned unchanged.
 *
 * The function NEVER throws — all fetch/save errors are swallowed and
 * surfaced only via `console.warn` (real, gated-by-spec signal for an
 * operator diagnosing CORS / expired-URL bugs).
 */
export const cacheGenerateOutputs = async (
  output: unknown
): Promise<unknown> => {
  if (!output || typeof output !== 'object') return output
  const root = output as OutputLike

  const items: Array<OutputItemLike> = []
  if (Array.isArray(root.outputs)) {
    for (const candidate of root.outputs) {
      if (isObject(candidate)) items.push(candidate as OutputItemLike)
    }
  }
  if (items.length === 0 && Array.isArray(root.images)) {
    for (const candidate of root.images) {
      if (isObject(candidate)) items.push(candidate as OutputItemLike)
    }
  }
  if (items.length === 0 && Array.isArray(root.imageUrls)) {
    for (const url of root.imageUrls) {
      if (typeof url === 'string' && url) {
        items.push({ url })
      }
    }
  }

  if (items.length === 0) {
    // Nothing to cache per-item, but still try the top-level poster.
    const poster = await enrichTopLevelPoster(root)
    if (!poster) return output
    return { ...root, posterAssetId: poster.assetId, thumbnailAssetId: poster.assetId }
  }

  const results = await Promise.all(items.map((item, index) => enrichItemWithAsset(item, index)))
  const enriched = results.map((r) => r.enriched)
  let changed = results.some((r) => r.ok)

  const topPoster = await enrichTopLevelPoster(root)
  let nextRoot: OutputLike = { ...root, outputs: enriched }
  if (topPoster) {
    nextRoot = { ...nextRoot, posterAssetId: topPoster.assetId, thumbnailAssetId: topPoster.assetId }
    changed = true
  }
  return changed ? nextRoot : output
}
