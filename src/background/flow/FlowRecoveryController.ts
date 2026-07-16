import type {
  FlowErrorCode,
  FlowErrorEvidence,
  FlowEvidenceConfidence,
  FlowHealthProbeResult,
  FlowRecoveryAdmissionDecision,
  FlowReconciliationResult,
  FlowRecoverySnapshot,
  FlowRecoveryState,
} from '../../types/flow.ts'
import type { FlowSessionRefreshResult } from './FlowSessionRefresher.ts'
import { calculateFlowRecoveryDelay } from './recoveryBackoff.ts'
import {
  classifyFlowRecoveryPolicy,
  type FlowRecoveryContext,
} from './recoveryPolicy.ts'

export type FlowRecoveryLogEvent =
  | 'FLOW_RECOVERY_INCIDENT_STARTED'
  | 'FLOW_RECOVERY_STATE_CHANGED'
  | 'FLOW_SESSION_REFRESH_STARTED'
  | 'FLOW_SESSION_REFRESH_SUCCEEDED'
  | 'FLOW_SESSION_REFRESH_FAILED'
  | 'FLOW_RECOVERY_PROBE_STARTED'
  | 'FLOW_RECOVERY_PROBE_RESULT'
  | 'FLOW_RATE_LIMIT_COOLDOWN_STARTED'
  | 'FLOW_RECOVERY_BLOCKED'
  | 'FLOW_RECOVERY_USER_ACTION_REQUIRED'
  | 'FLOW_UNCERTAIN_RECONCILIATION_STARTED'
  | 'FLOW_UNCERTAIN_RECONCILIATION_RESULT'
  | 'FLOW_RECOVERY_STALE_CALLBACK_IGNORED'
  | 'FLOW_RECOVERY_PERSISTENCE_FAILED'
  | 'FLOW_BRIDGE_RECOVERY_STARTED'
  | 'FLOW_BRIDGE_RECOVERY_RESULT'
  | 'FLOW_RECOVERY_MANUAL_RESET'

export interface FlowRecoveryStorage {
  load(): Promise<FlowRecoverySnapshot | null>
  save(snapshot: FlowRecoverySnapshot): Promise<void>
}

export interface FlowRecoveryTrigger {
  errorCode: FlowErrorCode
  jobId?: string
  tabId: number
  evidence?: FlowErrorEvidence[]
  context?: FlowRecoveryContext
}

export interface FlowBridgeReconnectResult {
  success: boolean
  reason: string
}

export interface FlowRecoveryControllerOptions {
  now?: () => number
  random?: () => number
  createIncidentId?: () => string
  storage?: FlowRecoveryStorage
  log?: (event: FlowRecoveryLogEvent, payload: Record<string, unknown>) => void
  probeHealth?: (tabId: number, signal?: AbortSignal) => Promise<FlowHealthProbeResult>
  reconnectBridge?: (tabId: number, signal?: AbortSignal) => Promise<FlowBridgeReconnectResult>
  sessionRefresher?: {
    refresh(request: {
      incidentId: string
      tabId: number
      confidence: FlowEvidenceConfidence
      allowControlledReload: boolean
      signal?: AbortSignal
    }): Promise<FlowSessionRefreshResult>
  }
  transientBaseDelayMs?: number
  transientMaxDelayMs?: number
  rateLimitBaseDelayMs?: number
  rateLimitMaxDelayMs?: number
  sessionRefreshCooldownMs?: number
  incidentWindowMs?: number
  maxIncidentsPerWindow?: number
}

const PERSISTENCE_VERSION = 1

function initialSnapshot(now: number): FlowRecoverySnapshot {
  return {
    state: 'healthy',
    failureCount: 0,
    recoveryAttemptCount: 0,
    sessionRefreshAttempted: false,
    userInterventionRequired: false,
    persistenceVersion: PERSISTENCE_VERSION,
    stateHistory: [],
    recoveryAttemptHistory: [],
    probeHistory: [],
    reloadCount: 0,
    recentIncidentStartedAt: [],
    capturedAt: now,
  }
}

function cloneSnapshot(snapshot: FlowRecoverySnapshot): FlowRecoverySnapshot {
  return structuredClone(snapshot)
}

function sanitizeEvidence(evidence: FlowErrorEvidence[] | undefined): FlowErrorEvidence[] | undefined {
  if (!evidence?.length) return undefined
  return evidence.slice(0, 20).map((item) => ({
    source: item.source,
    detectedAt: item.detectedAt,
    confidence: item.confidence,
    ...(item.statusReason ? { statusReason: item.statusReason.slice(0, 160) } : {}),
  }))
}

function normalizeSnapshot(value: FlowRecoverySnapshot | null, now: number): FlowRecoverySnapshot {
  if (!value || typeof value !== 'object') return initialSnapshot(now)
  if (value.persistenceVersion !== PERSISTENCE_VERSION) {
    // Unknown future or legacy shape: fail closed when it represented an
    // incident, otherwise safely migrate to the current healthy baseline.
    const migrated = initialSnapshot(now)
    if ((value as Partial<FlowRecoverySnapshot>).state && (value as Partial<FlowRecoverySnapshot>).state !== 'healthy') {
      migrated.state = 'blocked'
      migrated.errorCode = (value as Partial<FlowRecoverySnapshot>).errorCode || 'unknown'
      migrated.userInterventionRequired = true
      migrated.terminalDecision = 'unsupported_recovery_persistence_version'
    }
    return migrated
  }
  const base = initialSnapshot(now)
  const normalized: FlowRecoverySnapshot = {
    ...base,
    ...value,
    stateHistory: Array.isArray(value.stateHistory) ? value.stateHistory.slice(-100) : [],
    recoveryAttemptHistory: Array.isArray(value.recoveryAttemptHistory) ? value.recoveryAttemptHistory.slice(-100) : [],
    probeHistory: Array.isArray(value.probeHistory) ? value.probeHistory.slice(-100) : [],
    recentIncidentStartedAt: Array.isArray(value.recentIncidentStartedAt)
      ? value.recentIncidentStartedAt.filter((timestamp) => typeof timestamp === 'number').slice(-20)
      : [],
    triggeringEvidence: sanitizeEvidence(value.triggeringEvidence),
    persistenceVersion: PERSISTENCE_VERSION,
    persistenceError: undefined,
    capturedAt: now,
  }
  if (normalized.state === 'recovering') {
    normalized.stateHistory = [...normalized.stateHistory, {
      previousState: 'recovering' as const,
      nextState: 'blocked' as const,
      timestamp: now,
      reason: 'recovery_interrupted_by_service_worker_restart',
    }].slice(-100)
    normalized.state = 'blocked'
    normalized.userInterventionRequired = true
    normalized.terminalDecision = 'recovery_interrupted_by_service_worker_restart'
  }
  return normalized
}

export class FlowRecoveryController {
  private snapshot: FlowRecoverySnapshot
  private hydrated = false
  private hydratePromise: Promise<void> | null = null
  private activeAbortController: AbortController | null = null
  private persistenceFailure: string | null = null
  private readonly now: () => number
  private readonly random: () => number
  private readonly createIncidentId: () => string
  private readonly storage?: FlowRecoveryStorage
  private readonly logger?: FlowRecoveryControllerOptions['log']
  private readonly probeHealth?: FlowRecoveryControllerOptions['probeHealth']
  private readonly reconnectBridge?: FlowRecoveryControllerOptions['reconnectBridge']
  private readonly sessionRefresher?: FlowRecoveryControllerOptions['sessionRefresher']
  private readonly transientBaseDelayMs: number
  private readonly transientMaxDelayMs: number
  private readonly rateLimitBaseDelayMs: number
  private readonly rateLimitMaxDelayMs: number
  private readonly sessionRefreshCooldownMs: number
  private readonly incidentWindowMs: number
  private readonly maxIncidentsPerWindow: number

  constructor(options: FlowRecoveryControllerOptions = {}) {
    this.now = options.now || (() => Date.now())
    this.random = options.random || Math.random
    this.createIncidentId = options.createIncidentId || (() => `flow_recovery_${this.now()}_${Math.random().toString(36).slice(2, 10)}`)
    this.storage = options.storage
    this.logger = options.log
    this.probeHealth = options.probeHealth
    this.reconnectBridge = options.reconnectBridge
    this.sessionRefresher = options.sessionRefresher
    this.transientBaseDelayMs = options.transientBaseDelayMs ?? 5_000
    this.transientMaxDelayMs = options.transientMaxDelayMs ?? 60_000
    this.rateLimitBaseDelayMs = options.rateLimitBaseDelayMs ?? 60_000
    this.rateLimitMaxDelayMs = options.rateLimitMaxDelayMs ?? 10 * 60_000
    this.sessionRefreshCooldownMs = options.sessionRefreshCooldownMs ?? 5 * 60_000
    this.incidentWindowMs = options.incidentWindowMs ?? 30 * 60_000
    this.maxIncidentsPerWindow = options.maxIncidentsPerWindow ?? 2
    this.snapshot = initialSnapshot(this.now())
  }

  async getSnapshot(): Promise<FlowRecoverySnapshot> {
    await this.ensureHydrated()
    return cloneSnapshot({
      ...this.snapshot,
      ...(this.persistenceFailure ? { persistenceError: this.persistenceFailure } : {}),
      capturedAt: this.now(),
    })
  }

  async handleFailure(trigger: FlowRecoveryTrigger): Promise<FlowRecoverySnapshot> {
    await this.ensureHydrated()
    const policy = classifyFlowRecoveryPolicy(trigger)
    if (!policy.createIncident) return this.getSnapshot()

    this.activeAbortController?.abort('superseded_by_new_recovery_incident')
    this.activeAbortController = new AbortController()
    const now = this.now()
    const recent = this.snapshot.recentIncidentStartedAt.filter((timestamp) => now - timestamp < this.incidentWindowMs)
    const incidentId = this.createIncidentId()
    const tooManyIncidents = recent.length >= this.maxIncidentsPerWindow
    const initialState: FlowRecoveryState = tooManyIncidents ? 'blocked' : policy.initialState
    const terminalDecision = tooManyIncidents ? 'recovery_incident_frequency_limit' : undefined
    const blockedUntil = !tooManyIncidents && (policy.action === 'cooldown' || policy.action === 'bridge_reconnect')
      ? now + calculateFlowRecoveryDelay({
        baseDelayMs: trigger.errorCode === 'rate_limited' ? this.rateLimitBaseDelayMs : this.transientBaseDelayMs,
        maxDelayMs: trigger.errorCode === 'rate_limited' ? this.rateLimitMaxDelayMs : this.transientMaxDelayMs,
        attempt: Math.max(0, this.snapshot.failureCount),
        random: this.random,
      })
      : undefined
    const next: FlowRecoverySnapshot = {
      ...this.snapshot,
      state: initialState,
      incidentId,
      errorCode: trigger.errorCode,
      failureCount: this.snapshot.failureCount + 1,
      recoveryAttemptCount: 0,
      firstFailureAt: this.snapshot.firstFailureAt || now,
      lastFailureAt: now,
      ...(blockedUntil !== undefined ? { cooldownStartedAt: now, blockedUntil } : { cooldownStartedAt: undefined, blockedUntil: undefined }),
      recoveryStartedAt: undefined,
      recoveryCompletedAt: undefined,
      sessionRefreshAttempted: false,
      sessionRefreshSucceeded: undefined,
      userInterventionRequired: tooManyIncidents || policy.userInterventionRequired,
      triggeringJobId: trigger.jobId,
      triggeringTabId: trigger.tabId,
      triggeringEvidence: sanitizeEvidence(trigger.evidence),
      startedAt: now,
      terminalDecision,
      reloadCount: 0,
      recentIncidentStartedAt: [...recent, now],
      stateHistory: [...this.snapshot.stateHistory, {
        previousState: this.snapshot.state,
        nextState: initialState,
        timestamp: now,
        reason: terminalDecision || policy.reason,
      }].slice(-100),
      capturedAt: now,
    }
    await this.commit(next, [{ event: 'FLOW_RECOVERY_INCIDENT_STARTED', reason: policy.reason }, {
      event: 'FLOW_RECOVERY_STATE_CHANGED',
      reason: terminalDecision || policy.reason,
      previousState: this.snapshot.state,
      nextState: initialState,
    }])

    if (trigger.errorCode === 'rate_limited') {
      this.emit('FLOW_RATE_LIMIT_COOLDOWN_STARTED', { incidentId, jobId: trigger.jobId, errorCode: trigger.errorCode, blockedUntil })
    }
    if (initialState === 'blocked') {
      this.emitBlocked(terminalDecision || policy.reason)
      return this.getSnapshot()
    }
    if (policy.action === 'session_refresh') {
      return this.attemptSessionRecovery(incidentId, trigger.tabId, policy.sessionEvidenceConfidence, policy.allowControlledReload)
    }
    if (policy.action === 'bridge_reconnect') {
      return this.attemptBridgeRecovery(incidentId, trigger.tabId)
    }
    if (policy.action === 'probe') {
      await this.probeAndApply(incidentId, trigger.tabId, this.activeAbortController.signal)
    } else if (policy.action === 'reconcile') {
      this.emit('FLOW_UNCERTAIN_RECONCILIATION_STARTED', { incidentId, jobId: trigger.jobId, errorCode: trigger.errorCode })
      this.emit('FLOW_RECOVERY_USER_ACTION_REQUIRED', { incidentId, jobId: trigger.jobId, reason: policy.reason })
    }
    return this.getSnapshot()
  }

  async attemptSessionRecovery(
    expectedIncidentId = this.snapshot.incidentId,
    tabId?: number,
    confidence: FlowEvidenceConfidence = 'high',
    allowControlledReload = true,
  ): Promise<FlowRecoverySnapshot> {
    await this.ensureHydrated()
    const incidentId = expectedIncidentId
    if (!incidentId || this.snapshot.incidentId !== incidentId) return this.getSnapshot()
    if (this.snapshot.sessionRefreshAttempted) return this.getSnapshot()
    if (!this.sessionRefresher || tabId === undefined) {
      return this.blockCurrentIncident('session_refresher_unavailable')
    }
    const now = this.now()
    if (this.snapshot.lastSessionRefreshAt !== undefined && now - this.snapshot.lastSessionRefreshAt < this.sessionRefreshCooldownMs) {
      return this.blockCurrentIncident('session_refresh_cooldown_active')
    }

    const previousState = this.snapshot.state
    const attempt = this.snapshot.recoveryAttemptCount + 1
    const recovering: FlowRecoverySnapshot = {
      ...this.snapshot,
      state: 'recovering',
      recoveryAttemptCount: attempt,
      recoveryStartedAt: now,
      sessionRefreshAttempted: true,
      lastSessionRefreshAt: now,
      stateHistory: [...this.snapshot.stateHistory, {
        previousState,
        nextState: 'recovering' as const,
        timestamp: now,
        reason: 'session_refresh_started',
      }].slice(-100),
      recoveryAttemptHistory: [...this.snapshot.recoveryAttemptHistory, {
        attempt,
        timestamp: now,
        action: 'session_refresh' as const,
        result: 'started',
      }].slice(-100),
      capturedAt: now,
    }
    await this.commit(recovering, [{ event: 'FLOW_RECOVERY_STATE_CHANGED', reason: 'session_refresh_started', previousState, nextState: 'recovering' }])
    this.emit('FLOW_SESSION_REFRESH_STARTED', { incidentId, jobId: this.snapshot.triggeringJobId, errorCode: this.snapshot.errorCode, attempt })

    const signal = this.activeAbortController?.signal
    let result: FlowSessionRefreshResult
    try {
      result = await this.sessionRefresher.refresh({ incidentId, tabId, confidence, allowControlledReload, signal })
    } catch (error) {
      result = { success: false, reason: error instanceof Error ? error.message : String(error), reloadCount: 0 }
    }
    if (this.snapshot.incidentId !== incidentId) {
      this.emit('FLOW_RECOVERY_STALE_CALLBACK_IGNORED', { incidentId, reason: 'session_refresh_callback_for_inactive_incident' })
      return this.getSnapshot()
    }

    if (result.success && result.probe?.overall === 'healthy') {
      const completedAt = this.now()
      const healthy = this.withTransition({
        ...this.snapshot,
        state: 'healthy',
        sessionRefreshSucceeded: true,
        recoveryCompletedAt: completedAt,
        lastProbeAt: result.probe.checkedAt,
        lastProbeResult: result.probe,
        reloadCount: result.reloadCount,
        userInterventionRequired: false,
        terminalDecision: 'session_refresh_probe_healthy',
        probeHistory: [...this.snapshot.probeHistory, { timestamp: result.probe.checkedAt, overall: result.probe.overall }].slice(-100),
        recoveryAttemptHistory: [...this.snapshot.recoveryAttemptHistory, {
          attempt,
          timestamp: completedAt,
          action: (result.reloadCount > 0 ? 'controlled_reload' : 'session_refresh') as 'controlled_reload' | 'session_refresh',
          result: result.reason,
        }].slice(-100),
      }, 'healthy', result.reason)
      await this.commit(healthy, [{ event: 'FLOW_RECOVERY_STATE_CHANGED', reason: result.reason, previousState: 'recovering', nextState: 'healthy' }])
      this.emit('FLOW_SESSION_REFRESH_SUCCEEDED', { incidentId, jobId: this.snapshot.triggeringJobId, attempt, reason: result.reason })
      return this.getSnapshot()
    }

    this.emit('FLOW_SESSION_REFRESH_FAILED', { incidentId, jobId: this.snapshot.triggeringJobId, attempt, reason: result.reason })
    return this.blockCurrentIncident(result.reason || 'session_refresh_failed', result.probe, result.reloadCount)
  }

  async attemptBridgeRecovery(expectedIncidentId = this.snapshot.incidentId, tabId?: number): Promise<FlowRecoverySnapshot> {
    await this.ensureHydrated()
    const incidentId = expectedIncidentId
    if (!incidentId || this.snapshot.incidentId !== incidentId) return this.getSnapshot()
    if (!this.reconnectBridge || tabId === undefined) return this.blockCurrentIncident('bridge_reconnect_unavailable')
    const previousState = this.snapshot.state
    const attempt = this.snapshot.recoveryAttemptCount + 1
    const now = this.now()
    const recovering = this.withTransition({
      ...this.snapshot,
      state: 'recovering',
      recoveryAttemptCount: attempt,
      recoveryStartedAt: now,
      recoveryAttemptHistory: [...this.snapshot.recoveryAttemptHistory, {
        attempt,
        timestamp: now,
        action: 'bridge_reconnect' as const,
        result: 'started',
      }].slice(-100),
    }, 'recovering', 'bridge_recovery_started')
    await this.commit(recovering, [{ event: 'FLOW_RECOVERY_STATE_CHANGED', reason: 'bridge_recovery_started', previousState, nextState: 'recovering' }])
    this.emit('FLOW_BRIDGE_RECOVERY_STARTED', { incidentId, jobId: this.snapshot.triggeringJobId, attempt })
    const result = await this.reconnectBridge(tabId, this.activeAbortController?.signal).catch((error) => ({
      success: false,
      reason: error instanceof Error ? error.message : String(error),
    }))
    if (this.snapshot.incidentId !== incidentId) {
      this.emit('FLOW_RECOVERY_STALE_CALLBACK_IGNORED', { incidentId, reason: 'bridge_callback_for_inactive_incident' })
      return this.getSnapshot()
    }
    this.emit('FLOW_BRIDGE_RECOVERY_RESULT', { incidentId, jobId: this.snapshot.triggeringJobId, attempt, success: result.success, reason: result.reason })
    if (result.success) {
      await this.probeAndApply(incidentId, tabId, this.activeAbortController?.signal)
      return this.getSnapshot()
    }
    const blockedUntil = this.now() + calculateFlowRecoveryDelay({
      baseDelayMs: this.transientBaseDelayMs,
      maxDelayMs: this.transientMaxDelayMs,
      attempt: Math.max(0, attempt - 1),
      random: this.random,
    })
    const transient = this.withTransition({
      ...this.snapshot,
      state: 'transient_failure',
      cooldownStartedAt: this.now(),
      blockedUntil,
      terminalDecision: result.reason,
      recoveryAttemptHistory: [...this.snapshot.recoveryAttemptHistory, {
        attempt,
        timestamp: this.now(),
        action: 'bridge_reconnect' as const,
        result: result.reason,
      }].slice(-100),
    }, 'transient_failure', result.reason)
    await this.commit(transient, [{ event: 'FLOW_RECOVERY_STATE_CHANGED', reason: result.reason, previousState: 'recovering', nextState: 'transient_failure' }])
    return this.getSnapshot()
  }

  async getAdmissionDecision(): Promise<FlowRecoveryAdmissionDecision> {
    await this.ensureHydrated()
    if (this.persistenceFailure) {
      return this.buildAdmissionDecision(false, `flow_recovery_persistence_unavailable:${this.persistenceFailure}`)
    }
    if (this.snapshot.state === 'healthy') {
      return this.buildAdmissionDecision(true, 'flow_recovery_healthy')
    }
    if ((this.snapshot.state === 'transient_failure' || this.snapshot.state === 'cooldown' || this.snapshot.state === 'rate_limited')
      && this.snapshot.blockedUntil !== undefined && this.now() >= this.snapshot.blockedUntil) {
      const incidentId = this.snapshot.incidentId
      if (incidentId && this.probeHealth && this.snapshot.triggeringTabId !== undefined) {
        await this.probeAndApply(incidentId, this.snapshot.triggeringTabId, this.activeAbortController?.signal)
        if (String(this.snapshot.state) === 'healthy') return this.buildAdmissionDecision(true, 'flow_recovery_probe_healthy')
      }
    }
    return this.buildAdmissionDecision(false, this.snapshot.state === 'blocked'
      ? 'flow_recovery_blocked_user_action_required'
      : `flow_recovery_${this.snapshot.state}`)
  }

  async manualReset(userAcknowledged: boolean): Promise<FlowRecoverySnapshot> {
    await this.ensureHydrated()
    if (!userAcknowledged) return this.getSnapshot()
    this.activeAbortController?.abort('flow_recovery_manual_reset')
    this.activeAbortController = null
    const previousState = this.snapshot.state
    const reset: FlowRecoverySnapshot = {
      ...initialSnapshot(this.now()),
      // Acknowledgement clears the incident lock, not conservative refresh
      // frequency limits. Otherwise repeated manual resets could create a
      // refresh loop that bypasses the five-minute/session-window policy.
      lastSessionRefreshAt: this.snapshot.lastSessionRefreshAt,
      recentIncidentStartedAt: [...this.snapshot.recentIncidentStartedAt],
    }
    await this.commit(reset, [{ event: 'FLOW_RECOVERY_STATE_CHANGED', reason: 'user_acknowledged_recovery_reset', previousState, nextState: 'healthy' }])
    this.emit('FLOW_RECOVERY_MANUAL_RESET', { previousState, nextState: 'healthy', reason: 'user_acknowledged_recovery_reset' })
    return this.getSnapshot()
  }

  async recordReconciliationResult(
    expectedIncidentId: string,
    result: FlowReconciliationResult,
  ): Promise<FlowRecoverySnapshot> {
    await this.ensureHydrated()
    if (this.snapshot.incidentId !== expectedIncidentId) {
      this.emit('FLOW_RECOVERY_STALE_CALLBACK_IGNORED', {
        incidentId: expectedIncidentId,
        reason: 'reconciliation_result_for_inactive_incident',
      })
      return this.getSnapshot()
    }
    const attempt = this.snapshot.recoveryAttemptCount + 1
    const next: FlowRecoverySnapshot = {
      ...this.snapshot,
      recoveryAttemptCount: attempt,
      terminalDecision: `reconciliation_${result.status}:${result.reason}`,
      userInterventionRequired: result.status === 'no_evidence' || result.status === 'ambiguous',
      recoveryAttemptHistory: [...this.snapshot.recoveryAttemptHistory, {
        attempt,
        timestamp: this.now(),
        action: 'reconciliation' as const,
        result: result.status,
      }].slice(-100),
      capturedAt: this.now(),
    }
    await this.commit(next, [])
    this.emit('FLOW_UNCERTAIN_RECONCILIATION_RESULT', {
      incidentId: expectedIncidentId,
      jobId: this.snapshot.triggeringJobId,
      attempt,
      status: result.status,
      reason: result.reason,
    })
    return this.getSnapshot()
  }

  private async probeAndApply(incidentId: string, tabId: number, signal?: AbortSignal): Promise<void> {
    if (!this.probeHealth || this.snapshot.incidentId !== incidentId) return
    const attempt = this.snapshot.recoveryAttemptCount + 1
    this.emit('FLOW_RECOVERY_PROBE_STARTED', { incidentId, jobId: this.snapshot.triggeringJobId, attempt })
    let probe: FlowHealthProbeResult
    try {
      probe = await this.probeHealth(tabId, signal)
    } catch {
      return
    }
    if (this.snapshot.incidentId !== incidentId) {
      this.emit('FLOW_RECOVERY_STALE_CALLBACK_IGNORED', { incidentId, reason: 'probe_callback_for_inactive_incident' })
      return
    }
    const now = this.now()
    const previousState = this.snapshot.state
    if (probe.overall === 'busy') {
      const busy = {
        ...this.snapshot,
        recoveryAttemptCount: attempt,
        lastProbeAt: probe.checkedAt,
        lastProbeResult: probe,
        terminalDecision: 'health_probe_busy',
        probeHistory: [...this.snapshot.probeHistory, { timestamp: probe.checkedAt, overall: probe.overall }].slice(-100),
        recoveryAttemptHistory: [...this.snapshot.recoveryAttemptHistory, {
          attempt,
          timestamp: now,
          action: 'health_probe' as const,
          result: probe.overall,
        }].slice(-100),
        capturedAt: now,
      }
      // Busy/queued is an admission condition, not a recovery failure. Keep
      // the existing recovery state and let Admission Controller reject any
      // duplicate submit until the provider becomes idle.
      await this.commit(busy, [])
      this.emit('FLOW_RECOVERY_PROBE_RESULT', { incidentId, jobId: this.snapshot.triggeringJobId, attempt, overall: probe.overall })
      return
    }
    const nextState: FlowRecoveryState = probe.overall === 'healthy'
      ? 'healthy'
      : probe.overall === 'rate_limited'
        ? 'rate_limited'
        : probe.overall === 'session_suspect'
          ? 'session_suspect'
          : probe.overall === 'blocked'
            ? 'blocked'
            : 'transient_failure'
    const next = this.withTransition({
      ...this.snapshot,
      state: nextState,
      recoveryAttemptCount: attempt,
      recoveryCompletedAt: nextState === 'healthy' ? now : this.snapshot.recoveryCompletedAt,
      lastProbeAt: probe.checkedAt,
      lastProbeResult: probe,
      userInterventionRequired: nextState === 'blocked' || nextState === 'session_suspect',
      terminalDecision: `health_probe_${probe.overall}`,
      probeHistory: [...this.snapshot.probeHistory, { timestamp: probe.checkedAt, overall: probe.overall }].slice(-100),
      recoveryAttemptHistory: [...this.snapshot.recoveryAttemptHistory, {
        attempt,
        timestamp: now,
        action: 'health_probe' as const,
        result: probe.overall,
      }].slice(-100),
    }, nextState, `health_probe_${probe.overall}`)
    await this.commit(next, [{ event: 'FLOW_RECOVERY_STATE_CHANGED', reason: `health_probe_${probe.overall}`, previousState, nextState }])
    this.emit('FLOW_RECOVERY_PROBE_RESULT', { incidentId, jobId: this.snapshot.triggeringJobId, attempt, overall: probe.overall })
    if (nextState === 'blocked') this.emitBlocked(`health_probe_${probe.overall}`)
  }

  private async blockCurrentIncident(
    reason: string,
    probe?: FlowHealthProbeResult,
    reloadCount = this.snapshot.reloadCount,
  ): Promise<FlowRecoverySnapshot> {
    const previousState = this.snapshot.state
    const now = this.now()
    const blocked = this.withTransition({
      ...this.snapshot,
      state: 'blocked',
      sessionRefreshSucceeded: false,
      recoveryCompletedAt: now,
      lastProbeAt: probe?.checkedAt || this.snapshot.lastProbeAt,
      lastProbeResult: probe || this.snapshot.lastProbeResult,
      reloadCount,
      userInterventionRequired: true,
      terminalDecision: reason,
      ...(probe ? { probeHistory: [...this.snapshot.probeHistory, { timestamp: probe.checkedAt, overall: probe.overall }].slice(-100) } : {}),
    }, 'blocked', reason)
    await this.commit(blocked, [{ event: 'FLOW_RECOVERY_STATE_CHANGED', reason, previousState, nextState: 'blocked' }])
    this.emitBlocked(reason)
    return this.getSnapshot()
  }

  private withTransition(snapshot: FlowRecoverySnapshot, nextState: FlowRecoveryState, reason: string): FlowRecoverySnapshot {
    const last = snapshot.stateHistory[snapshot.stateHistory.length - 1]
    if (last?.nextState === nextState && last.reason === reason && last.timestamp === this.now()) return snapshot
    return {
      ...snapshot,
      state: nextState,
      stateHistory: [...snapshot.stateHistory, {
        previousState: this.snapshot.state,
        nextState,
        timestamp: this.now(),
        reason,
      }].slice(-100),
      capturedAt: this.now(),
    }
  }

  private buildAdmissionDecision(allowed: boolean, statusReason: string): FlowRecoveryAdmissionDecision {
    return {
      allowed,
      state: this.snapshot.state,
      statusReason,
      ...(this.snapshot.errorCode ? { errorCode: this.snapshot.errorCode } : {}),
      ...(this.snapshot.blockedUntil !== undefined ? { blockedUntil: this.snapshot.blockedUntil } : {}),
      snapshot: cloneSnapshot({
        ...this.snapshot,
        ...(this.persistenceFailure ? { persistenceError: this.persistenceFailure } : {}),
        capturedAt: this.now(),
      }),
    }
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return
    if (!this.hydratePromise) {
      this.hydratePromise = (async () => {
        const persisted = await this.storage?.load()
        this.snapshot = normalizeSnapshot(persisted || null, this.now())
        this.hydrated = true
      })()
    }
    await this.hydratePromise
  }

  private async commit(
    next: FlowRecoverySnapshot,
    events: Array<{ event: FlowRecoveryLogEvent; reason: string; previousState?: FlowRecoveryState; nextState?: FlowRecoveryState }>,
  ): Promise<void> {
    const candidate = cloneSnapshot({ ...next, persistenceVersion: PERSISTENCE_VERSION, capturedAt: this.now() })
    try {
      await this.storage?.save(candidate)
    } catch (error) {
      this.persistenceFailure = error instanceof Error ? error.message : String(error)
      this.emit('FLOW_RECOVERY_PERSISTENCE_FAILED', { reason: error instanceof Error ? error.message : String(error) })
      throw error
    }
    this.persistenceFailure = null
    this.snapshot = candidate
    for (const item of events) {
      this.emit(item.event, {
        incidentId: candidate.incidentId,
        jobId: candidate.triggeringJobId,
        errorCode: candidate.errorCode,
        previousState: item.previousState,
        nextState: item.nextState,
        blockedUntil: candidate.blockedUntil,
        reason: item.reason,
      })
    }
  }

  private emitBlocked(reason: string): void {
    this.emit('FLOW_RECOVERY_BLOCKED', {
      incidentId: this.snapshot.incidentId,
      jobId: this.snapshot.triggeringJobId,
      errorCode: this.snapshot.errorCode,
      reason,
    })
    this.emit('FLOW_RECOVERY_USER_ACTION_REQUIRED', {
      incidentId: this.snapshot.incidentId,
      jobId: this.snapshot.triggeringJobId,
      errorCode: this.snapshot.errorCode,
      reason,
    })
  }

  private emit(event: FlowRecoveryLogEvent, payload: Record<string, unknown>): void {
    this.logger?.(event, { ...payload, timestamp: this.now() })
  }
}
