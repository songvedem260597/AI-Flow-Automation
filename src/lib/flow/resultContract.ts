import type {
  FlowDownloadOutcome,
  FlowErrorCode,
  FlowErrorEvidence,
  FlowEvidenceSource,
  FlowGenerationOutcome,
  FlowResultContract,
  FlowStructuredError,
} from '../../types/flow.ts'

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}

const asCount = (value: unknown): number => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0
}

export interface FlowTextClassification {
  errorCode: FlowErrorCode
  statusReason: string
  matchedText: string[]
  confidence: 'medium' | 'high'
}

const TEXT_RULES: Array<{
  code: FlowErrorCode
  reason: string
  confidence: 'medium' | 'high'
  patterns: string[]
}> = [
  {
    code: 'unusual_activity',
    reason: 'unusual_activity_warning',
    confidence: 'high',
    patterns: ['unusual activity', 'hoạt động bất thường', 'chúng tôi nhận thấy hoạt động'],
  },
  {
    code: 'rate_limited',
    reason: 'rate_limit_warning',
    confidence: 'high',
    patterns: ['too many requests', 'rate limit', 'rate-limit', 'quota exceeded', 'quá nhiều yêu cầu', 'đã vượt quá hạn mức'],
  },
  {
    code: 'session_expired',
    reason: 'session_expired_warning',
    confidence: 'high',
    patterns: ['session expired', 'session has expired', 'please sign in', 'sign in to continue', 'phiên đã hết hạn', 'đăng nhập để tiếp tục'],
  },
  {
    code: 'generation_failed',
    reason: 'generation_failure_warning',
    confidence: 'medium',
    patterns: ['generation failed', 'unable to generate', 'an error occurred', 'không thành công'],
  },
]

export function classifyFlowErrorText(text: string): FlowTextClassification | null {
  const normalized = String(text || '').toLocaleLowerCase()
  if (!normalized) return null

  for (const rule of TEXT_RULES) {
    const matchedText = rule.patterns.filter((pattern) => normalized.includes(pattern))
    if (matchedText.length > 0) {
      return {
        errorCode: rule.code,
        statusReason: rule.reason,
        matchedText,
        confidence: rule.confidence,
      }
    }
  }
  return null
}

export interface FlowConfirmedPartialExitInput {
  expected: number
  confirmed: number
  failed: number
}

/** Partial completion requires at least one real successful output. */
export function shouldExitFlowConfirmedPartialCollection(
  input: FlowConfirmedPartialExitInput,
): boolean {
  if (input.confirmed <= 0 || input.failed <= 0) return false
  const targetSuccessful = Math.max(0, input.expected - input.failed)
  return input.confirmed >= targetSuccessful
}

export interface FlowVideoPartialGraceInput {
  expected: number
  confirmed: number
  pending: number
  failed: number
  freshFailed: number
  lastProgressMs: number
  waitedMs: number
  graceMs: number
}

/** A missing video may become partial only after every live tile is gone. */
export function shouldExitFlowVideoPartialGrace(input: FlowVideoPartialGraceInput): boolean {
  return input.confirmed > 0 &&
    input.confirmed < input.expected &&
    input.pending === 0 &&
    input.failed === 0 &&
    input.freshFailed === 0 &&
    input.lastProgressMs > 0 &&
    (input.waitedMs - input.lastProgressMs) >= input.graceMs
}

export function flowErrorCodeFromLegacy(status: unknown, error: unknown): FlowErrorCode | undefined {
  const combined = `${String(status || '')} ${String(error || '')}`.toLocaleLowerCase()
  const textClassification = classifyFlowErrorText(combined)
  if (textClassification) return textClassification.errorCode
  if (/submit_uncertain|message channel closed|context invalidated/.test(combined)) return 'submit_uncertain'
  if (/cancel/.test(combined)) return 'cancelled'
  if (/bridge|content script|receiving end/.test(combined)) return 'bridge_unavailable'
  if (/composer|editor element not found|submit button not found/.test(combined)) return 'composer_missing'
  if (/busy|in[_ -]?flight|admission/.test(combined)) return 'flow_busy'
  if (/timeout|timed out/.test(combined)) return 'generation_timeout'
  if (/download/.test(combined)) return 'download_failed'
  if (/failed|failure|no successful results/.test(combined)) return 'generation_failed'
  return undefined
}

export function createFlowEvidence(
  source: FlowEvidenceSource,
  statusReason: string,
  options: Partial<FlowErrorEvidence> = {},
): FlowErrorEvidence {
  return {
    source,
    detectedAt: options.detectedAt || Date.now(),
    confidence: options.confidence || 'medium',
    statusReason,
    ...(options.matchedText ? { matchedText: options.matchedText } : {}),
    ...(options.selector ? { selector: options.selector } : {}),
    ...(options.tileId ? { tileId: options.tileId } : {}),
    ...(options.fileName ? { fileName: options.fileName } : {}),
  }
}

function normalizeGeneration(input: Record<string, unknown>): FlowGenerationOutcome {
  const generation = asRecord(input.generationOutcome || input.generation)
  const details = asRecord(input.downloadDetails)
  const expected = asCount(generation.expected ?? details.expected)
  const generated = asCount(generation.generated ?? details.generated ?? input.outputsAvailableCount)
  const failed = asCount(generation.failed ?? details.generationFailedCount)
  const pending = asCount(generation.pending ?? details.generationPendingCount)
  const partial = generation.partial === true || details.generationPartial === true || (generated > 0 && generated < expected)
  let status: FlowGenerationOutcome['status'] = 'unknown'
  const errorCode = input.errorCode as FlowErrorCode | undefined
  if (errorCode === 'cancelled') status = 'cancelled'
  else if (errorCode === 'generation_timeout') status = 'timeout'
  else if (generated > 0 && (partial || failed > 0 || pending > 0)) status = 'partial'
  else if (generated > 0) status = 'success'
  else if (failed > 0 || input.success === false) status = 'failed'
  else if (String(input.status || '').includes('SUBMIT')) status = 'in_progress'
  else if (!input.status) status = 'not_started'
  return { expected, generated, failed, pending, partial, status }
}

function normalizeDownload(input: Record<string, unknown>): FlowDownloadOutcome {
  const existing = asRecord(input.downloadOutcome)
  const details = asRecord(input.downloadDetails)
  const autoDownload = asRecord(input.autoDownload)
  const attempted = existing.attempted === true || details.downloadAttempted === true || autoDownload.attempted === true
  const downloaded = asCount(existing.downloaded ?? details.downloaded ?? autoDownload.successCount ?? input.outputsDownloadedCount)
  const failed = asCount(existing.failed ?? autoDownload.failCount)
  const skipped = asCount(existing.skipped ?? details.skipped ?? input.outputsSkippedCount)
  let status: FlowDownloadOutcome['status'] = 'unknown'
  if (!attempted) status = 'not_requested'
  else if (downloaded > 0 && failed > 0) status = 'partial'
  else if (downloaded > 0) status = 'success'
  else if (failed > 0 || input.success === false) status = 'failed'
  return { attempted, downloaded, failed, skipped, status }
}

export function ensureFlowResultContract(
  value: unknown,
  fallbackSource: FlowEvidenceSource = 'orchestrator',
): FlowResultContract {
  const input = asRecord(value)
  const success = input.success === true
  const legacyError = typeof input.error === 'string' ? input.error : ''
  const existingEvidence = Array.isArray(input.evidence)
    ? input.evidence.filter((item): item is FlowErrorEvidence => !!item && typeof item === 'object')
    : []
  const existingFlowError = input.flowError && typeof input.flowError === 'object'
    ? input.flowError as FlowStructuredError
    : null
  const errorCode = (input.errorCode as FlowErrorCode | undefined)
    || existingFlowError?.code
    || (!success ? flowErrorCodeFromLegacy(input.status, legacyError) || 'unknown' : undefined)
  const statusReason = String(input.statusReason || existingFlowError?.statusReason || input.status || legacyError || (success ? 'flow_success' : 'unknown'))
  const evidence = existingEvidence.length > 0
    ? existingEvidence
    : (!success || errorCode
      ? [createFlowEvidence(fallbackSource, statusReason, { confidence: errorCode === 'unknown' ? 'low' : 'medium' })]
      : [])
  const flowError = existingFlowError || (errorCode
    ? {
        code: errorCode,
        message: legacyError || statusReason,
        statusReason,
        evidence,
      }
    : null)

  const base = {
    ...input,
    success,
    ...(legacyError ? { error: legacyError } : {}),
    ...(errorCode ? { errorCode } : {}),
    flowError,
    statusReason,
    evidence,
  }
  return {
    ...base,
    generationOutcome: normalizeGeneration(base),
    downloadOutcome: normalizeDownload(base),
  } as FlowResultContract
}
