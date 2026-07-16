export interface FlowTileObservation {
  id?: string
  fileName?: string
  mediaUrl?: string
  status?: string
  firstSeenAt?: number
  firstSeenState?: string
  observedProcessing?: boolean
  domFingerprint?: string
  [key: string]: unknown
}

export function sameFlowTileObservation(a: FlowTileObservation, b: FlowTileObservation): boolean {
  const aName = String(a.fileName || '')
  const bName = String(b.fileName || '')
  const aId = String(a.id || '')
  const bId = String(b.id || '')
  const aUrl = String(a.mediaUrl || '')
  const bUrl = String(b.mediaUrl || '')
  const aFingerprint = String(a.domFingerprint || '')
  const bFingerprint = String(b.domFingerprint || '')

  // An ID or filename alone is not authoritative. When both observations
  // carry IDs, different IDs always represent distinct tile lifecycles even
  // when Flow reuses the same filename. A reused ID is considered the same
  // only when the accompanying filename does not contradict it.
  if (aId && bId) {
    if (aId !== bId) return false
    if (aName && bName) return aName === bName
    return true
  }

  // ID-less nested DOM observations may still be deduped by stronger media
  // or DOM evidence. Filename is a fallback only when neither side has an ID.
  if (!aId && !bId) {
    if (aUrl && bUrl) return aUrl === bUrl
    if (aFingerprint && bFingerprint) return aFingerprint === bFingerprint
    return Boolean(aName && bName && aName === bName)
  }

  return false
}

export function dedupeFlowTileObservations<T extends FlowTileObservation>(tiles: T[]): T[] {
  const result: T[] = []
  for (const tile of tiles) {
    const existingIndex = result.findIndex((existing) => sameFlowTileObservation(existing, tile))
    if (existingIndex === -1) {
      result.push(tile)
      continue
    }

    // Keep the richer nested observation when the same logical tile was
    // painted more than once in the DOM.
    const existing = result[existingIndex]
    const existingScore = Number(Boolean(existing.fileName)) + Number(Boolean(existing.mediaUrl)) + Number(Boolean(existing.domFingerprint))
    const candidateScore = Number(Boolean(tile.fileName)) + Number(Boolean(tile.mediaUrl)) + Number(Boolean(tile.domFingerprint))
    if (candidateScore > existingScore) result[existingIndex] = tile
  }
  return result
}

export function isFlowTileInBaseline(tile: FlowTileObservation, baseline: FlowTileObservation[]): boolean {
  return baseline.some((existing) => sameFlowTileObservation(existing, tile))
}

export function flowTileProcessingKey(tile: FlowTileObservation): string {
  return String(tile.id || '')
}

export function wasFlowTileObservedProcessing(tile: FlowTileObservation, processingKeys: Set<string>): boolean {
  const key = flowTileProcessingKey(tile)
  return Boolean(key && processingKeys.has(key))
}

export interface FlowTileLifecycleState {
  processingKeys: Set<string>
  failedFirstSeenAt: Map<string, number>
}

export type FlowTileLifecycleClassification = 'pending' | 'confirmed' | 'failed' | 'suspicious_done'

export function createFlowTileLifecycleState(): FlowTileLifecycleState {
  return { processingKeys: new Set(), failedFirstSeenAt: new Map() }
}

export function observeFlowTileLifecycle(
  state: FlowTileLifecycleState,
  tile: FlowTileObservation,
  now: number,
  failedDebounceMs = 15_000,
): FlowTileLifecycleClassification {
  const key = flowTileProcessingKey(tile)
  const status = String(tile.status || 'unknown')

  if (status !== 'done' && status !== 'failed') {
    if (key) state.processingKeys.add(key)
    if (key) state.failedFirstSeenAt.delete(key)
    return 'pending'
  }

  if (status === 'failed') {
    if (key && !state.failedFirstSeenAt.has(key)) state.failedFirstSeenAt.set(key, now)
    const firstSeenAt = key ? state.failedFirstSeenAt.get(key) || now : now
    return now - firstSeenAt >= failedDebounceMs ? 'failed' : 'pending'
  }

  if (key) state.failedFirstSeenAt.delete(key)
  return wasFlowTileObservedProcessing(tile, state.processingKeys) ? 'confirmed' : 'suspicious_done'
}
