/**
 * IndexedDB asset store for workflow media (images / videos / posters /
 * thumbnails / attachments). Stores Blob natively so we never persist
 * full base64 into chrome.storage.local. Renderer reads Blob via
 * cached `URL.createObjectURL` and revokes when no longer needed.
 *
 * Phase 1 scope: only the upload path writes here. Generate-node
 * outputs, template compressed previews, migration of legacy base64
 * workflows are deliberately out of scope for this commit.
 *
 * No external dependency — uses native `indexedDB`.
 */

export type AssetKind = 'image' | 'video' | 'poster' | 'thumbnail' | 'attachment'
export type AssetSource = 'upload' | 'generated' | 'template' | 'download' | 'cropped'

export interface AssetMeta {
  kind: AssetKind
  source: AssetSource
  fileName?: string
  mimeType?: string
  width?: number
  height?: number
  duration?: number
  originalUrl?: string
}

export interface AssetRecord {
  id: string
  kind: AssetKind
  blob: Blob
  mimeType: string
  fileName?: string
  size: number
  width?: number
  height?: number
  duration?: number
  createdAt: number
  updatedAt: number
  source: AssetSource
  originalUrl?: string
  checksum?: string
}

const DB_NAME = 'ai-flow-assets'
const DB_VERSION = 1
const ASSET_STORE = 'assets'

let dbPromise: Promise<IDBDatabase> | null = null

const objectUrlCache = new Map<string, string>()
const dbAvailability = new Map<'idb', boolean | null>([['idb', null]])

const isIndexedDbSupported = (): boolean => {
  if (typeof indexedDB === 'undefined') return false
  return true
}

export const openAssetDB = (): Promise<IDBDatabase> => {
  if (!dbPromise) {
    if (!isIndexedDbSupported()) {
      return Promise.reject(new Error('IndexedDB not available'))
    }
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(ASSET_STORE)) {
          const store = db.createObjectStore(ASSET_STORE, { keyPath: 'id' })
          store.createIndex('by_kind', 'kind', { unique: false })
          store.createIndex('by_source', 'source', { unique: false })
          store.createIndex('by_createdAt', 'createdAt', { unique: false })
        }
      }
      req.onsuccess = () => {
        dbAvailability.set('idb', true)
        resolve(req.result)
      }
      req.onerror = () => {
        dbAvailability.set('idb', false)
        reject(req.error || new Error('Failed to open asset DB'))
      }
      req.onblocked = () => {
        dbAvailability.set('idb', false)
        reject(new Error('Asset DB upgrade blocked'))
      }
    })
  }
  return dbPromise
}

const generateAssetId = (): string => {
  const c =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14)
  return `asset_${c}`
}

const putRecord = (db: IDBDatabase, record: AssetRecord): Promise<void> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE, 'readwrite')
    const store = tx.objectStore(ASSET_STORE)
    store.put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('Failed to write asset'))
    tx.onabort = () => reject(tx.error || new Error('Asset write aborted'))
  })

const getRecordById = (db: IDBDatabase, id: string): Promise<AssetRecord | null> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE, 'readonly')
    const store = tx.objectStore(ASSET_STORE)
    const req = store.get(id)
    req.onsuccess = () => {
      const value = req.result
      resolve(value ? (value as AssetRecord) : null)
    }
    req.onerror = () => reject(req.error || new Error('Failed to read asset'))
  })

const readAssetBlob = (db: IDBDatabase, id: string): Promise<Blob | null> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE, 'readonly')
    const store = tx.objectStore(ASSET_STORE)
    const req = store.get(id)
    req.onsuccess = () => {
      const value = req.result as AssetRecord | undefined
      resolve(value?.blob ?? null)
    }
    req.onerror = () => reject(req.error || new Error('Failed to read asset blob'))
  })

export const saveAssetFromFile = async (file: File, meta: AssetMeta): Promise<AssetRecord> => {
  const db = await openAssetDB()
  const now = Date.now()
  const record: AssetRecord = {
    id: generateAssetId(),
    kind: meta.kind,
    blob: file,
    mimeType: meta.mimeType ?? file.type ?? '',
    fileName: meta.fileName ?? file.name,
    size: file.size,
    width: meta.width,
    height: meta.height,
    duration: meta.duration,
    createdAt: now,
    updatedAt: now,
    source: meta.source,
    originalUrl: meta.originalUrl
  }
  await putRecord(db, record)
  return record
}

export const saveAssetFromBlob = async (blob: Blob, meta: AssetMeta): Promise<AssetRecord> => {
  const db = await openAssetDB()
  const now = Date.now()
  const record: AssetRecord = {
    id: generateAssetId(),
    kind: meta.kind,
    blob,
    mimeType: meta.mimeType ?? blob.type ?? '',
    fileName: meta.fileName,
    size: blob.size,
    width: meta.width,
    height: meta.height,
    duration: meta.duration,
    createdAt: now,
    updatedAt: now,
    source: meta.source,
    originalUrl: meta.originalUrl
  }
  await putRecord(db, record)
  return record
}

export const getAsset = async (id: string): Promise<AssetRecord | null> => {
  if (!id) return null
  try {
    const db = await openAssetDB()
    return await getRecordById(db, id)
  } catch {
    return null
  }
}

export const getAssetBlob = async (id: string): Promise<Blob | null> => {
  if (!id) return null
  try {
    const db = await openAssetDB()
    return await readAssetBlob(db, id)
  } catch {
    return null
  }
}

export const getAssetObjectUrl = async (id: string): Promise<string | null> => {
  if (!id) return null
  const cached = objectUrlCache.get(id)
  if (cached) return cached
  const blob = await getAssetBlob(id)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  objectUrlCache.set(id, url)
  return url
}

export const revokeAssetObjectUrl = (id: string): void => {
  const cached = objectUrlCache.get(id)
  if (cached) {
    URL.revokeObjectURL(cached)
    objectUrlCache.delete(id)
  }
}

export const revokeAllAssetObjectUrls = (): void => {
  for (const url of objectUrlCache.values()) {
    URL.revokeObjectURL(url)
  }
  objectUrlCache.clear()
}

export const deleteAsset = async (id: string): Promise<void> => {
  if (!id) return
  revokeAssetObjectUrl(id)
  try {
    const db = await openAssetDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ASSET_STORE, 'readwrite')
      const store = tx.objectStore(ASSET_STORE)
      store.delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('Failed to delete asset'))
      tx.onabort = () => reject(tx.error || new Error('Asset delete aborted'))
    })
  } catch {
    // Best-effort. Caller does not depend on delete success.
  }
}

/**
 * [AssetGC] List every record in the asset store. Phase 5 GC
 * needs the full table to compute orphan / referenced sets and
 * total bytes — getAsset() only resolves a single id.
 *
 * Records are returned in `createdAt` ASC order so the report is
 * stable across renders. Blob contents are NOT included — callers
 * that need bytes call getAssetBlob(id).
 */
export const listAssets = async (): Promise<AssetRecord[]> => {
  try {
    const db = await openAssetDB()
    return await new Promise<AssetRecord[]>((resolve, reject) => {
      const tx = db.transaction(ASSET_STORE, 'readonly')
      const store = tx.objectStore(ASSET_STORE)
      const req = store.getAll()
      req.onsuccess = () => {
        const records = Array.isArray(req.result) ? (req.result as AssetRecord[]) : []
        records.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        resolve(records)
      }
      req.onerror = () => reject(req.error || new Error('Failed to list assets'))
    })
  } catch {
    // IndexedDB not available → empty inventory. GC report falls
    // back to 0 assets so the UI stays usable.
    return []
  }
}
