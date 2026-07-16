import type {
  FlowAdmissionHealth,
  FlowAdmissionJob,
  FlowAdmissionSnapshot,
  FlowErrorCode,
} from '../../types/flow.ts'

export type FlowAdmissionLogEvent =
  | 'FLOW_ADMISSION_REQUESTED'
  | 'FLOW_ADMISSION_CHECKING'
  | 'FLOW_ADMISSION_DENIED_BUSY'
  | 'FLOW_ADMISSION_GRANTED'
  | 'FLOW_SUBMIT_STARTED'
  | 'FLOW_SUBMIT_CONFIRMED'
  | 'FLOW_SUBMIT_UNCERTAIN'
  | 'FLOW_JOB_TERMINAL'
  | 'FLOW_MUTEX_RELEASED'
  | 'FLOW_CANCELLATION_REQUESTED'

export interface FlowAdmissionRequest {
  source: string
  callerId?: string
  tabId: number
  mediaType: 'image' | 'video'
  signal?: AbortSignal
}

export interface FlowAdmissionDecision {
  granted: boolean
  job?: FlowAdmissionJob
  errorCode?: FlowErrorCode
  statusReason: string
  health?: FlowAdmissionHealth
  snapshot: FlowAdmissionSnapshot
}

export interface FlowCancellationDecision {
  accepted: boolean
  job?: FlowAdmissionJob
  statusReason: string
  snapshot: FlowAdmissionSnapshot
}

export interface FlowAdmissionStorage {
  load(): Promise<FlowAdmissionSnapshot | null>
  save(snapshot: FlowAdmissionSnapshot): Promise<void>
}

export interface FlowAdmissionControllerOptions {
  now?: () => number
  createJobId?: () => string
  storage?: FlowAdmissionStorage
  log?: (event: FlowAdmissionLogEvent, payload: Record<string, unknown>) => void
  preSubmitLeaseMs?: number
  inFlightSafetyMs?: number
  minimumCooldownMs?: number
}

const GLOBAL_SCOPE = 'google-flow-global' as const

const cloneJob = (job: FlowAdmissionJob | null): FlowAdmissionJob | null =>
  job ? { ...job } : null

export class FlowAdmissionController {
  private activeJob: FlowAdmissionJob | null = null
  private lastJob: FlowAdmissionJob | null = null
  private cooldownUntil = 0
  private pendingAdmissionJob: FlowAdmissionJob | null = null
  private hydrated = false
  private hydratePromise: Promise<void> | null = null
  private activeAbortController: AbortController | null = null
  private readonly now: () => number
  private readonly createJobId: () => string
  private readonly storage?: FlowAdmissionStorage
  private readonly logger?: FlowAdmissionControllerOptions['log']
  private readonly preSubmitLeaseMs: number
  private readonly inFlightSafetyMs: number
  private readonly minimumCooldownMs: number

  constructor(options: FlowAdmissionControllerOptions = {}) {
    this.now = options.now || (() => Date.now())
    this.createJobId = options.createJobId || (() => `flow_${this.now()}_${Math.random().toString(36).slice(2, 10)}`)
    this.storage = options.storage
    this.logger = options.log
    this.preSubmitLeaseMs = options.preSubmitLeaseMs || 45_000
    this.inFlightSafetyMs = options.inFlightSafetyMs || 5 * 60_000
    this.minimumCooldownMs = options.minimumCooldownMs ?? 1_000
  }

  async requestAdmission(
    request: FlowAdmissionRequest,
    probe: (signal: AbortSignal) => Promise<FlowAdmissionHealth>,
  ): Promise<FlowAdmissionDecision> {
    const requestedAt = this.now()
    const requestedJob: FlowAdmissionJob = {
      jobId: this.createJobId(),
      source: request.source || 'unknown',
      ...(request.callerId ? { callerId: request.callerId } : {}),
      tabId: request.tabId,
      mediaType: request.mediaType,
      requestedAt,
      state: 'checking',
    }
    this.emit('FLOW_ADMISSION_REQUESTED', requestedJob, 'request_received')

    // Reserve synchronously before the first await. MV3 can deliver two
    // runtime messages in the same tick; without this reservation both could
    // pass hydration before either publishes activeJob.
    if (this.pendingAdmissionJob) {
      this.emit('FLOW_ADMISSION_DENIED_BUSY', requestedJob, `pending_job_${this.pendingAdmissionJob.jobId}`)
      return {
        granted: false,
        errorCode: 'flow_busy',
        statusReason: `Flow admission is checking job ${this.pendingAdmissionJob.jobId}`,
        snapshot: this.getSnapshotUnsafe(),
      }
    }
    this.pendingAdmissionJob = requestedJob

    await this.ensureHydrated()
    await this.expireStaleLeaseIfSafe()

    if (this.activeJob && !this.isTerminal(this.activeJob.state)) {
      this.pendingAdmissionJob = null
      this.emit('FLOW_ADMISSION_DENIED_BUSY', requestedJob, `active_job_${this.activeJob.state}`)
      return {
        granted: false,
        errorCode: 'flow_busy',
        statusReason: `Flow admission is occupied by job ${this.activeJob.jobId} (${this.activeJob.state})`,
        snapshot: this.getSnapshotUnsafe(),
      }
    }

    if (this.now() < this.cooldownUntil) {
      this.pendingAdmissionJob = null
      this.emit('FLOW_ADMISSION_DENIED_BUSY', requestedJob, `minimum_cooldown_until_${this.cooldownUntil}`)
      return {
        granted: false,
        errorCode: 'flow_busy',
        statusReason: `Flow minimum cooldown is active until ${this.cooldownUntil}`,
        snapshot: this.getSnapshotUnsafe(),
      }
    }

    this.activeJob = requestedJob
    this.pendingAdmissionJob = null
    const jobAbortController = new AbortController()
    this.activeAbortController = jobAbortController
    const relayAbort = () => jobAbortController.abort(request.signal?.reason)
    if (request.signal?.aborted) relayAbort()
    else request.signal?.addEventListener('abort', relayAbort, { once: true })

    this.emit('FLOW_ADMISSION_CHECKING', requestedJob, 'pre_submit_health_probe')
    await this.persist()

    try {
      if (jobAbortController.signal.aborted) {
        return this.cancelBeforeSubmit(requestedJob, 'cancelled_before_health_probe')
      }

      let health: FlowAdmissionHealth
      try {
        health = await probe(jobAbortController.signal)
      } catch (error) {
        health = {
          healthy: false,
          tabExists: true,
          bridgeReady: false,
          composerPresent: false,
          processing: 0,
          pending: 0,
          generating: 0,
          blockingDialog: false,
          errorCode: 'bridge_unavailable',
          statusReason: error instanceof Error ? error.message : String(error),
          evidence: [],
        }
      }

      if (jobAbortController.signal.aborted) {
        return this.cancelBeforeSubmit(requestedJob, 'cancelled_during_health_probe')
      }

      if (!health.healthy) {
        const errorCode = health.errorCode || 'unknown'
        const blocking = errorCode === 'unusual_activity' || errorCode === 'rate_limited' || errorCode === 'session_expired'
        requestedJob.state = blocking ? 'blocked' : 'terminal'
        requestedJob.errorCode = errorCode
        requestedJob.statusReason = health.statusReason || 'pre_submit_health_probe_failed'
        requestedJob.completedAt = this.now()
        this.lastJob = { ...requestedJob }
        if (blocking) {
          this.activeJob = requestedJob
        } else {
          this.activeJob = null
          this.activeAbortController = null
          this.emit('FLOW_MUTEX_RELEASED', requestedJob, requestedJob.statusReason)
        }
        if (errorCode === 'flow_busy') {
          this.emit('FLOW_ADMISSION_DENIED_BUSY', requestedJob, requestedJob.statusReason)
        } else {
          this.emit('FLOW_JOB_TERMINAL', requestedJob, requestedJob.statusReason)
        }
        await this.persist()
        return {
          granted: false,
          errorCode,
          statusReason: requestedJob.statusReason,
          health,
          snapshot: this.getSnapshotUnsafe(),
        }
      }

      requestedJob.state = 'admitted'
      requestedJob.admittedAt = this.now()
      requestedJob.statusReason = 'pre_submit_health_probe_passed'
      this.activeJob = requestedJob
      this.emit('FLOW_ADMISSION_GRANTED', requestedJob, requestedJob.statusReason)
      await this.persist()
      return {
        granted: true,
        job: { ...requestedJob },
        statusReason: requestedJob.statusReason,
        health,
        snapshot: this.getSnapshotUnsafe(),
      }
    } finally {
      request.signal?.removeEventListener('abort', relayAbort)
    }
  }

  async markSubmitStarted(jobId: string, statusReason = 'submit_attempt_started'): Promise<FlowAdmissionJob | null> {
    await this.ensureHydrated()
    if (!this.activeJob || this.activeJob.jobId !== jobId) return null
    if (this.activeJob.state !== 'admitted' && this.activeJob.state !== 'checking') return { ...this.activeJob }
    this.activeJob.state = 'in_flight'
    this.activeJob.submittedAt = this.now()
    this.activeJob.statusReason = statusReason
    this.emit('FLOW_SUBMIT_STARTED', this.activeJob, statusReason)
    await this.persist()
    return { ...this.activeJob }
  }

  async markSubmitConfirmed(jobId: string, statusReason = 'submit_click_confirmed'): Promise<FlowAdmissionJob | null> {
    await this.ensureHydrated()
    if (!this.activeJob || this.activeJob.jobId !== jobId) return null
    if (!this.activeJob.submittedAt) this.activeJob.submittedAt = this.now()
    this.activeJob.state = 'in_flight'
    this.activeJob.submitConfirmedAt = this.now()
    this.activeJob.statusReason = statusReason
    this.emit('FLOW_SUBMIT_CONFIRMED', this.activeJob, statusReason)
    await this.persist()
    return { ...this.activeJob }
  }

  async markSubmitUncertain(jobId: string, statusReason: string): Promise<FlowAdmissionJob | null> {
    await this.ensureHydrated()
    if (!this.activeJob || this.activeJob.jobId !== jobId) return null
    this.activeJob.state = 'submit_uncertain'
    this.activeJob.errorCode = 'submit_uncertain'
    this.activeJob.statusReason = statusReason
    this.emit('FLOW_SUBMIT_UNCERTAIN', this.activeJob, statusReason)
    await this.persist()
    return { ...this.activeJob }
  }

  async completeJob(jobId: string, errorCode?: FlowErrorCode, statusReason = 'job_completed'): Promise<FlowAdmissionSnapshot> {
    await this.ensureHydrated()
    if (!this.activeJob || this.activeJob.jobId !== jobId) return this.getSnapshotUnsafe()
    this.activeJob.state = 'terminal'
    this.activeJob.completedAt = this.now()
    this.activeJob.statusReason = statusReason
    if (errorCode) this.activeJob.errorCode = errorCode
    if (this.activeJob.submittedAt && this.minimumCooldownMs > 0) {
      this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + this.minimumCooldownMs)
    }
    this.lastJob = { ...this.activeJob }
    this.emit('FLOW_JOB_TERMINAL', this.activeJob, statusReason)
    this.activeJob = null
    this.activeAbortController = null
    this.emit('FLOW_MUTEX_RELEASED', this.lastJob, statusReason)
    await this.persist()
    return this.getSnapshotUnsafe()
  }

  async requestCancellation(match: { jobId?: string; callerId?: string }): Promise<FlowCancellationDecision> {
    await this.ensureHydrated()
    const job = this.activeJob
    if (!job || (match.jobId && match.jobId !== job.jobId) || (match.callerId && match.callerId !== job.callerId)) {
      return { accepted: false, statusReason: 'no_matching_active_job', snapshot: this.getSnapshotUnsafe() }
    }

    job.cancellationRequestedAt = this.now()
    this.emit('FLOW_CANCELLATION_REQUESTED', job, 'caller_requested_cancellation')

    if (job.state === 'checking' || job.state === 'admitted') {
      this.activeAbortController?.abort('caller_cancelled_before_submit')
      const decision = await this.cancelBeforeSubmit(job, 'cancelled_before_submit')
      return { accepted: true, job: decision.job, statusReason: decision.statusReason, snapshot: decision.snapshot }
    }

    if (job.state === 'in_flight' && !job.submitConfirmedAt) {
      const uncertain = await this.markSubmitUncertain(job.jobId, 'cancelled_after_submit_started_before_confirmation')
      return { accepted: true, ...(uncertain ? { job: uncertain } : {}), statusReason: 'submit_uncertain', snapshot: this.getSnapshotUnsafe() }
    }

    await this.persist()
    return {
      accepted: true,
      job: { ...job },
      statusReason: job.submitConfirmedAt ? 'generation_continues_after_caller_cancel' : job.state,
      snapshot: this.getSnapshotUnsafe(),
    }
  }

  async getSnapshot(): Promise<FlowAdmissionSnapshot> {
    await this.ensureHydrated()
    await this.expireStaleLeaseIfSafe()
    return this.getSnapshotUnsafe()
  }

  async resetBlockedState(userAcknowledged: boolean): Promise<FlowAdmissionSnapshot> {
    await this.ensureHydrated()
    if (!userAcknowledged || !this.activeJob || (this.activeJob.state !== 'blocked' && this.activeJob.state !== 'submit_uncertain')) {
      return this.getSnapshotUnsafe()
    }
    return this.completeJob(this.activeJob.jobId, 'cancelled', 'user_acknowledged_flow_admission_reset')
  }

  private async cancelBeforeSubmit(job: FlowAdmissionJob, reason: string): Promise<FlowAdmissionDecision> {
    if (this.activeJob?.jobId !== job.jobId) {
      return { granted: false, errorCode: 'cancelled', statusReason: reason, snapshot: this.getSnapshotUnsafe() }
    }
    job.state = 'terminal'
    job.errorCode = 'cancelled'
    job.statusReason = reason
    job.completedAt = this.now()
    this.lastJob = { ...job }
    this.activeJob = null
    this.activeAbortController = null
    this.emit('FLOW_JOB_TERMINAL', job, reason)
    this.emit('FLOW_MUTEX_RELEASED', job, reason)
    await this.persist()
    return {
      granted: false,
      job: { ...job },
      errorCode: 'cancelled',
      statusReason: reason,
      snapshot: this.getSnapshotUnsafe(),
    }
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return
    if (!this.hydratePromise) {
      this.hydratePromise = (async () => {
        const persisted = await this.storage?.load().catch(() => null)
        if (persisted) {
          this.activeJob = cloneJob(persisted.activeJob)
          this.lastJob = cloneJob(persisted.lastJob)
          this.cooldownUntil = Number(persisted.cooldownUntil || 0)
        }
        this.hydrated = true
      })()
    }
    await this.hydratePromise
  }

  private async expireStaleLeaseIfSafe(): Promise<void> {
    const job = this.activeJob
    if (!job) return
    const age = this.now() - (job.admittedAt || job.requestedAt)
    if ((job.state === 'checking' || job.state === 'admitted') && age > this.preSubmitLeaseMs) {
      await this.completeJob(job.jobId, 'cancelled', 'pre_submit_lease_expired_without_submit')
      return
    }
    if (job.state === 'in_flight' && age > this.inFlightSafetyMs) {
      await this.markSubmitUncertain(job.jobId, 'in_flight_safety_timeout_requires_probe_or_user_reset')
    }
  }

  private isTerminal(state: FlowAdmissionJob['state']): boolean {
    return state === 'idle' || state === 'terminal'
  }

  private getSnapshotUnsafe(): FlowAdmissionSnapshot {
    return {
      scope: GLOBAL_SCOPE,
      state: this.activeJob?.state || 'idle',
      activeJob: cloneJob(this.activeJob),
      lastJob: cloneJob(this.lastJob),
      cooldownUntil: this.cooldownUntil,
      capturedAt: this.now(),
    }
  }

  private emit(event: FlowAdmissionLogEvent, job: FlowAdmissionJob, reason: string): void {
    this.logger?.(event, {
      jobId: job.jobId,
      source: job.source,
      tabId: job.tabId,
      mediaType: job.mediaType,
      state: job.state,
      timestamp: this.now(),
      reason,
    })
  }

  private async persist(): Promise<void> {
    await this.storage?.save(this.getSnapshotUnsafe()).catch(() => {})
  }
}
