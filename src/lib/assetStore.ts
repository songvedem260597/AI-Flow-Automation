/**
 * Asset Store — IndexedDB-backed persistence for heavy Media-node blobs.
 *
 * Why this exists:
 * chrome.storage.local has a hard quota (≈ 10 MB total per extension
 * origin in MV3). Storing base64 dataUrl / imageData / videoData inline
 * in `node.data` blew past that quota as soon as a user uploaded more
 * than a couple of Media nodes. That triggered
 * `Resource::kQuotaBytes quota exceeded` and the workflowStore persist
 * silently failed.
 *
 * This module moves every heavy blob out of `chrome.storage.local` and
 * into a dedicated IndexedDB object store. Workflows only carry
 * `{ assetId, mimeType, size, width, height, fileName }` from now on;
 * the bytes live here, keyed by `assetId`.
 *
 * Public surface (intentionally narrow):
 *   saveAssetFromDataUrl  → returns StoredAssetMeta (no Blob in payload)
 *   saveAssetFromBlob     → returns StoredAssetMeta
 *   getAssetBlob          → returns Blob | null
 *   getAssetObjectUrl     → returns string | null (cached, lazily revoked)
 *   getAssetMeta          → returns StoredAssetMeta | null (no Blob)
 *   deleteAsset           → removes from IDB + revokes cached object URL
 *   listAssets            → returns StoredAssetMeta[] (no Blobs)
 *   blobToDataUrl         → helper used by runner when it needs base64
 *
 * The store is intentionally tolerant:
 * - private mode / Safari ITP / quota errors → resolve(null) or throw
 *   a typed `AssetStoreError` that callers can swallow.
 * - same-origin IDB only. The extension SW has its own quota.
 * - all write paths are async and idempotent on `id` collisions (last
 *   write wins, no merge). Callers should generate UUIDs externally.
 */

const DB_NAME = 'AI_FLOW_ASSETS_DB'
const DB_VERSION = 1
const STORE = 'assets'

export type AssetKind = 'image' | 'video' | 'file'

export interface StoredAsset {
  id: string
  kind: AssetKind
  blob: Blob
  mimeType: string
  fileName?: string
  size?: number
  width?: number
  height?: number
  createdAt: number
  updatedAt: number
}

export interface StoredAssetMeta {
  assetId: string
  kind: AssetKind
  mimeType: string
  fileName?: string
  size?: number
  width?: number
  height?: number
  createdAt: number
}

export class AssetStoreError extends Error {
  readonly code: 'unavailable' | 'quota' | 'not_found' | 'invalid'
  constructor(code: AssetStoreError['code'], message: string) {
    super(message)
    this.name = 'AssetStoreError'
    this.code = code
  }
}

const debugLog = (flag: string, ...args: unknown[]): void => {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(flag) === '1') {
      // eslint-disable-next-line no-console
      console.log(`[AssetStore][${flag}]`, ...args)
    }
  } catch {
    /* ignore */
  }
}

const isIdbAvailable = (): boolean => {
  try {
    return typeof indexedDB !== 'undefined'
  } catch {
    return false
  }
}

let dbPromise: Promise<IDBDatabase> | null = null

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise
  if (!isIdbAvailable()) {
    return Promise.reject(new AssetStoreError('unavailable', 'IndexedDB is not available'))
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt', { unique: false })
        store.createIndex('kind', 'kind', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      const err = req.error
      dbPromise = null
      reject(new AssetStoreError('unavailable', err?.message || 'Failed to open IndexedDB'))
    }
    req.onblocked = () => {
      // Another tab is holding an old version open. Surface as a soft
      // unavailability so callers can fall back rather than hang.
      dbPromise = null
      reject(new AssetStoreError('unavailable', 'IndexedDB upgrade blocked by another tab'))
    }
  })
  return dbPromise
}

const tx = (mode: IDBTransactionMode): Promise<IDBObjectStore> =>
  openDb().then(
    (db) => db.transaction(STORE, mode).objectStore(STORE)
  )

const promisifyRequest = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      const err = req.error
      reject(new AssetStoreError('unavailable', err?.message || 'IndexedDB request failed'))
    }
  })

// ── Object URL cache ────────────────────────────────────────────────
// Keep one URL.createObjectURL per asset. We revoke on delete() and on
// module unload. Other call sites should use `getAssetObjectUrl` and
// `URL.revokeObjectURL` their own copies if they need to (we never
// revoke a cached URL while the asset still exists).
const objectUrlCache = new Map<string, string>()

const dataUrlToBlob = (dataUrl: string): Blob => {
  const match = dataUrl.match(/^data:([^;]+)(;base64)?,(.*)$/s)
  if (!match) {
    throw new AssetStoreError('invalid', 'dataUrl is not a valid base64 data URL')
  }
  const mime = match[1] || 'application/octet-stream'
  const isBase64 = !!match[2]
  const payload = match[3] || ''
  if (isBase64) {
    try {
      const binary = atob(payload)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return new Blob([bytes], { type: mime })
    } catch (err) {
      throw new AssetStoreError('invalid', `dataUrl base64 decode failed: ${(err as Error).message}`)
    }
  }
  try {
    return new Blob([decodeURIComponent(payload)], { type: mime })
  } catch {
    return new Blob([payload], { type: mime })
  }
}

const probeImageSize = (blob: Blob): Promise<{ width?: number; height?: number }> =>
  new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(blob)
      const img = new Image()
      img.onload = () => {
        const width = img.naturalWidth || undefined
        const height = img.naturalHeight || undefined
        URL.revokeObjectURL(url)
        resolve({ width, height })
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        resolve({})
      }
      img.src = url
    } catch {
      resolve({})
    }
  })

const probeVideoSize = (blob: Blob): Promise<{ width?: number; height?: number }> =>
  new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(blob)
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.onloadedmetadata = () => {
        const width = video.videoWidth || undefined
        const height = video.videoHeight || undefined
        URL.revokeObjectURL(url)
        resolve({ width, height })
      }
      video.onerror = () => {
        URL.revokeObjectURL(url)
        resolve({})
      }
      video.src = url
    } catch {
      resolve({})
    }
  })

const inferKind = (mimeType: string, hint?: AssetKind): AssetKind => {
  if (hint) return hint
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  return 'file'
}

const metaFromAsset = (asset: StoredAsset): StoredAssetMeta => ({
  assetId: asset.id,
  kind: asset.kind,
  mimeType: asset.mimeType,
  fileName: asset.fileName,
  size: asset.size,
  width: asset.width,
  height: asset.height,
  createdAt: asset.createdAt,
})

const generateId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* ignore */
  }
  return 'asset_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
}

export interface SaveAssetMetaInput {
  kind?: AssetKind
  mimeType?: string
  fileName?: string
  width?: number
  height?: number
}

const writeAssetRecord = async (asset: StoredAsset): Promise<StoredAssetMeta> => {
  const store = await tx('readwrite')
  await promisifyRequest(store.put(asset))
  debugLog('AI_FLOW_DEBUG', 'asset saved', asset.id, asset.kind, asset.size)
  return metaFromAsset(asset)
}

export const saveAssetFromBlob = async (
  blob: Blob,
  meta: SaveAssetMetaInput = {}
): Promise<StoredAssetMeta> => {
  const mimeType = meta.mimeType || blob.type || 'application/octet-stream'
  const kind = inferKind(mimeType, meta.kind)
  let width = meta.width
  let height = meta.height
  if ((width === undefined || height === undefined) && typeof window !== 'undefined') {
    try {
      const probed = kind === 'image'
        ? await probeImageSize(blob)
        : kind === 'video'
          ? await probeVideoSize(blob)
          : {}
      width = width ?? probed.width
      height = height ?? probed.height
    } catch {
      /* ignore probe failures */
    }
  }
  const now = Date.now()
  const record: StoredAsset = {
    id: generateId(),
    kind,
    blob,
    mimeType,
    fileName: meta.fileName,
    size: blob.size,
    width,
    height,
    createdAt: now,
    updatedAt: now,
  }
  return writeAssetRecord(record)
}

export const saveAssetFromDataUrl = async (
  dataUrl: string,
  meta: SaveAssetMetaInput = {}
): Promise<StoredAssetMeta> => {
  const blob = dataUrlToBlob(dataUrl)
  return saveAssetFromBlob(blob, meta)
}

export const getAsset = async (id: string): Promise<StoredAsset | null> => {
  try {
    const store = await tx('readonly')
    const result = await promisifyRequest<StoredAsset | undefined>(store.get(id) as IDBRequest<StoredAsset | undefined>)
    return result || null
  } catch (err) {
    if (err instanceof AssetStoreError && err.code === 'unavailable') return null
    throw err
  }
}

export const getAssetBlob = async (id: string): Promise<Blob | null> => {
  const asset = await getAsset(id)
  return asset?.blob || null
}

export const getAssetMeta = async (id: string): Promise<StoredAssetMeta | null> => {
  const asset = await getAsset(id)
  return asset ? metaFromAsset(asset) : null
}

export const getAssetObjectUrl = async (id: string): Promise<string | null> => {
  if (!id) return null
  const cached = objectUrlCache.get(id)
  if (cached) return cached
  const blob = await getAssetBlob(id)
  if (!blob) return null
  try {
    const url = URL.createObjectURL(blob)
    objectUrlCache.set(id, url)
    return url
  } catch {
    return null
  }
}

export const revokeAssetObjectUrl = (id: string): void => {
  const cached = objectUrlCache.get(id)
  if (cached) {
    try { URL.revokeObjectURL(cached) } catch { /* ignore */ }
    objectUrlCache.delete(id)
  }
}

export const deleteAsset = async (id: string): Promise<void> => {
  revokeAssetObjectUrl(id)
  try {
    const store = await tx('readwrite')
    await promisifyRequest(store.delete(id))
  } catch (err) {
    if (!(err instanceof AssetStoreError) || err.code !== 'unavailable') {
      debugLog('AI_FLOW_DEBUG', 'deleteAsset failed', id, err)
    }
  }
}

export const listAssets = async (): Promise<StoredAssetMeta[]> => {
  try {
    const store = await tx('readonly')
    const all = await promisifyRequest<StoredAsset[]>(store.getAll() as IDBRequest<StoredAsset[]>)
    return all.map(metaFromAsset)
  } catch (err) {
    if (err instanceof AssetStoreError && err.code === 'unavailable') return []
    throw err
  }
}

export const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    try {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') resolve(reader.result)
        else reject(new AssetStoreError('invalid', 'FileReader did not return a string'))
      }
      reader.onerror = () => reject(new AssetStoreError('unavailable', reader.error?.message || 'FileReader failed'))
      reader.readAsDataURL(blob)
    } catch (err) {
      reject(new AssetStoreError('unavailable', (err as Error).message || 'blobToDataUrl failed'))
    }
  })

export const getAssetDataUrl = async (id: string): Promise<string | null> => {
  const blob = await getAssetBlob(id)
  if (!blob) return null
  return blobToDataUrl(blob)
}

/**
 * Test/preview helpers (not for production paths):
 *   - `__aiFlowAssetStats` reports counts after a forced refresh.
 *   - `__aiFlowPurgeAssets` removes everything (used by manual QA tools).
 */
export const __aiFlowAssetStats = async (): Promise<{ count: number; totalBytes: number }> => {
  const all = await listAssets()
  const ids = all.map((meta) => meta.assetId)
  let totalBytes = 0
  for (const id of ids) {
    const blob = await getAssetBlob(id)
    if (blob) totalBytes += blob.size
  }
  return { count: ids.length, totalBytes }
}

export const __aiFlowPurgeAssets = async (): Promise<number> => {
  const all = await listAssets()
  for (const meta of all) await deleteAsset(meta.assetId)
  return all.length
}

export interface AssetStoreDebugSnapshot {
  cachedObjectUrls: string[]
  dbName: string
  dbVersion: number
  store: string
}

export const __aiFlowDebugSnapshot = (): AssetStoreDebugSnapshot => ({
  cachedObjectUrls: Array.from(objectUrlCache.keys()),
  dbName: DB_NAME,
  dbVersion: DB_VERSION,
  store: STORE,
})