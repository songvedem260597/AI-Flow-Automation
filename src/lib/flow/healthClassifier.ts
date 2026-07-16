import type { FlowErrorCode } from '../../types/flow.ts'
import { classifyFlowErrorText, type FlowTextClassification } from './resultContract.ts'

export type FlowWarningContextKind =
  | 'dialog'
  | 'alert'
  | 'toast'
  | 'status'
  | 'composer'
  | 'tile'
  | 'body'

export interface FlowWarningContext {
  kind: FlowWarningContextKind
  text: string
  selector?: string
}

export interface FlowAdmissionWarningClassification extends FlowTextClassification {
  selector?: string
  contextKind: FlowWarningContextKind
}

const ADMISSION_WARNING_CONTEXTS = new Set<FlowWarningContextKind>([
  'dialog',
  'alert',
  'toast',
  'status',
])

const ADMISSION_BLOCKING_CODES = new Set<FlowErrorCode>([
  'unusual_activity',
  'rate_limited',
  'session_expired',
])

/**
 * Classifies provider-wide warnings only from explicit UI warning surfaces.
 * Composer, tile, and document-body text are deliberately excluded because
 * they can contain user prompts or historical generation errors.
 */
export function classifyFlowAdmissionWarningContexts(
  contexts: FlowWarningContext[],
): FlowAdmissionWarningClassification | null {
  for (const context of contexts) {
    if (!ADMISSION_WARNING_CONTEXTS.has(context.kind)) continue
    const classification = classifyFlowErrorText(String(context.text || '').slice(0, 4_000))
    if (!classification || !ADMISSION_BLOCKING_CODES.has(classification.errorCode)) continue
    return {
      ...classification,
      contextKind: context.kind,
      ...(context.selector ? { selector: context.selector } : {}),
    }
  }
  return null
}

export interface FlowTileActivityObservation {
  status: string
  progress?: number
  statusReason?: string
  visible?: boolean
}

export interface FlowTileActivityCounts {
  processing: number
  pending: number
  generating: number
}

export function isFlowQueueStatusText(value: string): boolean {
  const normalized = String(value || '')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.…]+$/g, '')
    .trim()

  return /^(?:in (?:the )?queue|queued|waiting(?: in (?:the )?queue)?|(?:hiện )?(?:đang )?(?:ở )?trong hàng đợi|(?:hiện )?đang xếp hàng|(?:hiện )?đang chờ)$/.test(normalized)
}

/** Keeps the three health counters explicit without changing the Tile contract. */
export function countFlowTileActivity(
  tiles: FlowTileActivityObservation[],
): FlowTileActivityCounts {
  let processing = 0
  let pending = 0
  let generating = 0

  for (const tile of tiles) {
    // Flow retains stale/virtualized cards in the DOM after their visible UI
    // is gone. Their old percentage/queue labels are not provider activity.
    if (tile.visible === false) continue
    const status = String(tile.status || '').toLocaleLowerCase()
    const reason = String(tile.statusReason || '').toLocaleLowerCase()
    const progress = Number(tile.progress || 0)
    if (status === 'generating') generating++
    if (status === 'generating' && (progress > 0 || reason.includes('processing') || reason.includes('progress'))) {
      processing++
    }
    if (/pending|queued|waiting/.test(reason) && status !== 'done' && status !== 'failed') {
      pending++
    }
  }

  return { processing, pending, generating }
}
