import type { FlowErrorEvidence, FlowWaitCondition, FlowWaitResult } from '../../types/flow.ts'

export interface FlowWaitCheckResult {
  satisfied: boolean
  statusReason: string
  evidence?: FlowErrorEvidence[]
}

export interface FlowWaitOptions {
  condition: FlowWaitCondition
  timeoutMs: number
  pollIntervalMs?: number
  signal?: AbortSignal
  check: () => Promise<FlowWaitCheckResult>
  now?: () => number
}

const abortableDelay = (delayMs: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason || new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export async function waitForFlowCondition(options: FlowWaitOptions): Promise<FlowWaitResult> {
  const now = options.now || (() => Date.now())
  const startedAt = now()
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 30_000)
  const pollIntervalMs = Math.max(25, Number(options.pollIntervalMs) || 250)
  let lastReason = 'condition_not_satisfied'
  let evidence: FlowErrorEvidence[] = []

  while (now() - startedAt < timeoutMs) {
    if (options.signal?.aborted) {
      const completedAt = now()
      return {
        success: false,
        condition: options.condition,
        startedAt,
        completedAt,
        elapsedMs: completedAt - startedAt,
        timedOut: false,
        cancelled: true,
        statusReason: 'wait_cancelled',
        evidence,
      }
    }

    const result = await options.check()
    lastReason = result.statusReason
    evidence = result.evidence || evidence
    if (result.satisfied) {
      const completedAt = now()
      return {
        success: true,
        condition: options.condition,
        startedAt,
        completedAt,
        elapsedMs: completedAt - startedAt,
        timedOut: false,
        cancelled: false,
        statusReason: result.statusReason,
        evidence,
      }
    }

    try {
      await abortableDelay(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (now() - startedAt))), options.signal)
    } catch {
      const completedAt = now()
      return {
        success: false,
        condition: options.condition,
        startedAt,
        completedAt,
        elapsedMs: completedAt - startedAt,
        timedOut: false,
        cancelled: true,
        statusReason: 'wait_cancelled',
        evidence,
      }
    }
  }

  const completedAt = now()
  return {
    success: false,
    condition: options.condition,
    startedAt,
    completedAt,
    elapsedMs: completedAt - startedAt,
    timedOut: true,
    cancelled: false,
    statusReason: `wait_timeout:${lastReason}`,
    evidence,
  }
}
