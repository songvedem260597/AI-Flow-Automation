export interface FlowRecoveryBackoffOptions {
  baseDelayMs: number
  maxDelayMs: number
  attempt: number
  random?: () => number
}

export function calculateFlowRecoveryDelay(options: FlowRecoveryBackoffOptions): number {
  const attempt = Math.max(0, Math.floor(options.attempt))
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * (2 ** attempt))
  const random = Math.min(1, Math.max(0, (options.random || Math.random)()))
  const jitter = 0.8 + (random * 0.4)
  return Math.round(exponential * jitter)
}

interface TimerAdapter {
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(handle: unknown): void
}

const defaultTimerAdapter: TimerAdapter = {
  setTimer(callback, delayMs) {
    return setTimeout(callback, delayMs)
  },
  clearTimer(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export function waitForFlowRecoveryDelay(
  delayMs: number,
  signal?: AbortSignal,
  timer: TimerAdapter = defaultTimerAdapter,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error(String(signal.reason || 'flow_recovery_delay_aborted')))
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const handle = timer.setTimer(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }, Math.max(0, delayMs))
    const onAbort = () => {
      if (settled) return
      settled = true
      timer.clearTimer(handle)
      cleanup()
      reject(new Error(String(signal?.reason || 'flow_recovery_delay_aborted')))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
