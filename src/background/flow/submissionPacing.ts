export type FlowSubmissionPacingPhase = 'before_insert' | 'before_submit'

export interface FlowPacingRange {
  minMs: number
  maxMs: number
}

export interface FlowSubmissionPacingConfig {
  enabled: boolean
  beforeInsert: FlowPacingRange
  beforeSubmit: FlowPacingRange
  betweenAutomaticJobs: FlowPacingRange
  automaticSources: string[]
}

export interface FlowSubmissionPacingOptions {
  enabled?: boolean
  beforeInsert?: Partial<FlowPacingRange>
  beforeSubmit?: Partial<FlowPacingRange>
  betweenAutomaticJobs?: Partial<FlowPacingRange>
  automaticSources?: readonly string[]
}

export interface FlowPacingTimerAdapter {
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(handle: unknown): void
}

export const DEFAULT_FLOW_SUBMISSION_PACING: FlowSubmissionPacingConfig = {
  enabled: true,
  beforeInsert: { minMs: 300, maxMs: 900 },
  beforeSubmit: { minMs: 500, maxMs: 1_500 },
  betweenAutomaticJobs: { minMs: 5_000, maxMs: 15_000 },
  automaticSources: [
    'gen-tab',
    'gen-panel',
    'workflow',
    'pipeline',
    'google-flow-adapter',
    'direct-message',
  ],
}

const defaultTimer: FlowPacingTimerAdapter = {
  setTimer(callback, delayMs) {
    return setTimeout(callback, delayMs)
  },
  clearTimer(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

const normalizeRange = (
  value: Partial<FlowPacingRange> | undefined,
  fallback: FlowPacingRange,
): FlowPacingRange => {
  const minMs = Math.max(0, Math.floor(Number(value?.minMs ?? fallback.minMs)))
  const maxMs = Math.max(minMs, Math.floor(Number(value?.maxMs ?? fallback.maxMs)))
  return { minMs, maxMs }
}

export function resolveFlowSubmissionPacingConfig(
  options?: FlowSubmissionPacingOptions,
): FlowSubmissionPacingConfig {
  return {
    // Controllers used by tests or non-production callers remain unchanged
    // unless pacing is explicitly enabled. The background runtime opts in.
    enabled: options?.enabled === true,
    beforeInsert: normalizeRange(options?.beforeInsert, DEFAULT_FLOW_SUBMISSION_PACING.beforeInsert),
    beforeSubmit: normalizeRange(options?.beforeSubmit, DEFAULT_FLOW_SUBMISSION_PACING.beforeSubmit),
    betweenAutomaticJobs: normalizeRange(
      options?.betweenAutomaticJobs,
      DEFAULT_FLOW_SUBMISSION_PACING.betweenAutomaticJobs,
    ),
    automaticSources: Array.from(new Set(
      options?.automaticSources?.length
        ? options.automaticSources.map((source) => String(source))
        : DEFAULT_FLOW_SUBMISSION_PACING.automaticSources,
    )),
  }
}

export function sampleFlowSubmissionPacingDelay(
  range: FlowPacingRange,
  random: () => number = Math.random,
): number {
  const minMs = Math.max(0, Math.floor(Number(range.minMs) || 0))
  const maxMs = Math.max(minMs, Math.floor(Number(range.maxMs) || 0))
  const unit = Math.min(1, Math.max(0, Number(random()) || 0))
  return Math.round(minMs + ((maxMs - minMs) * unit))
}

export function waitForFlowSubmissionPacingDelay(
  durationMs: number,
  signal?: AbortSignal,
  timer: FlowPacingTimerAdapter = defaultTimer,
): Promise<void> {
  if (signal?.aborted) {
    const error = new Error(String(signal.reason || 'flow_submission_pacing_aborted'))
    error.name = 'AbortError'
    return Promise.reject(error)
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let handle: unknown
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      timer.clearTimer(handle)
      cleanup()
      const error = new Error(String(signal?.reason || 'flow_submission_pacing_aborted'))
      error.name = 'AbortError'
      reject(error)
    }
    handle = timer.setTimer(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }, Math.max(0, Math.floor(durationMs)))
    signal?.addEventListener('abort', onAbort, { once: true })
    // Close the small race where the signal aborts after the initial check
    // but before the listener is attached.
    if (signal?.aborted) onAbort()
  })
}
