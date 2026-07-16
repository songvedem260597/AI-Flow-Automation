import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { FlowAdmissionController } from '../../src/background/flow/FlowAdmissionController.ts'
import {
  FlowRecoveryController,
  type FlowRecoveryStorage,
} from '../../src/background/flow/FlowRecoveryController.ts'
import { FlowSessionRefresher } from '../../src/background/flow/FlowSessionRefresher.ts'
import { calculateFlowRecoveryDelay, waitForFlowRecoveryDelay } from '../../src/background/flow/recoveryBackoff.ts'
import { classifyFlowRecoveryPolicy, isManualSessionRecoveryAllowed } from '../../src/background/flow/recoveryPolicy.ts'
import { reconcileSubmitUncertain } from '../../src/background/flow/submitUncertainReconciliation.ts'
import { createFlowHealthProbeResult } from '../../src/background/flow/recoveryHealth.ts'
import type {
  FlowAdmissionHealth,
  FlowAdmissionSnapshot,
  FlowHealthProbeResult,
  FlowRecoverySnapshot,
} from '../../src/types/flow.ts'

const healthyProbe = (checkedAt = 1_000): FlowHealthProbeResult => createFlowHealthProbeResult({
  checkedAt,
  tabExists: true,
  routeValid: true,
  bridgeReady: true,
  composerReady: true,
  loginRequired: false,
  sessionWarning: false,
  unusualActivityWarning: false,
  rateLimitWarning: false,
  blockingDialog: false,
  activeGenerationCount: 0,
})

const unhealthyProbe = (checkedAt = 1_000): FlowHealthProbeResult => createFlowHealthProbeResult({
  checkedAt,
  tabExists: true,
  routeValid: true,
  bridgeReady: true,
  composerReady: false,
  loginRequired: true,
  sessionWarning: true,
  unusualActivityWarning: false,
  rateLimitWarning: false,
  blockingDialog: false,
  activeGenerationCount: 0,
})

const admissionHealth = (): FlowAdmissionHealth => ({
  healthy: true,
  tabExists: true,
  bridgeReady: true,
  composerPresent: true,
  processing: 0,
  pending: 0,
  generating: 0,
  blockingDialog: false,
  evidence: [],
})

const idleAdmission = (now = 1_000): FlowAdmissionSnapshot => ({
  scope: 'google-flow-global',
  state: 'idle',
  activeJob: null,
  lastJob: null,
  cooldownUntil: 0,
  capturedAt: now,
})

class MemoryRecoveryStorage implements FlowRecoveryStorage {
  value: FlowRecoverySnapshot | null = null
  failSave = false

  async load() { return this.value ? structuredClone(this.value) : null }
  async save(snapshot: FlowRecoverySnapshot) {
    if (this.failSave) throw new Error('storage unavailable')
    this.value = structuredClone(snapshot)
  }
}

const createController = (overrides: ConstructorParameters<typeof FlowRecoveryController>[0] = {}) => {
  let now = 1_000
  let refreshCalls = 0
  let reconnectCalls = 0
  const controller = new FlowRecoveryController({
    now: () => now,
    random: () => 0.5,
    createIncidentId: (() => { let id = 0; return () => `incident-${++id}` })(),
    probeHealth: async () => healthyProbe(now),
    sessionRefresher: {
      refresh: async () => {
        refreshCalls += 1
        return { success: true, reason: 'session_revalidated', probe: healthyProbe(now), reloadCount: 0 }
      },
    },
    reconnectBridge: async () => {
      reconnectCalls += 1
      return { success: true, reason: 'bridge_reconnected' }
    },
    ...overrides,
  })
  return {
    controller,
    setNow(value: number) { now = value },
    get refreshCalls() { return refreshCalls },
    get reconnectCalls() { return reconnectCalls },
  }
}

test('1 session_expired triggers exactly one silent refresh', async () => {
  const harness = createController()
  const snapshot = await harness.controller.handleFailure({ errorCode: 'session_expired', jobId: 'job-1', tabId: 7 })
  assert.equal(harness.refreshCalls, 1)
  assert.equal(snapshot.sessionRefreshAttempted, true)
})

test('2 successful silent refresh plus healthy probe reopens recovery admission', async () => {
  const harness = createController()
  await harness.controller.handleFailure({ errorCode: 'session_expired', jobId: 'job-1', tabId: 7 })
  assert.equal((await harness.controller.getAdmissionDecision()).allowed, true)
  assert.equal((await harness.controller.getSnapshot()).state, 'healthy')
})

test('3 failed silent refresh blocks recovery', async () => {
  const harness = createController({
    sessionRefresher: { refresh: async () => ({ success: false, reason: 'session_still_invalid', probe: unhealthyProbe(), reloadCount: 0 }) },
  })
  const snapshot = await harness.controller.handleFailure({ errorCode: 'session_expired', jobId: 'job-1', tabId: 7 })
  assert.equal(snapshot.state, 'blocked')
  assert.equal(snapshot.userInterventionRequired, true)
})

test('4 the same incident cannot run silent refresh twice', async () => {
  const harness = createController()
  const first = await harness.controller.handleFailure({ errorCode: 'session_expired', jobId: 'job-1', tabId: 7 })
  await harness.controller.attemptSessionRecovery(first.incidentId)
  assert.equal(harness.refreshCalls, 1)
})

test('5 session refresh cooldown survives controller restart', async () => {
  const storage = new MemoryRecoveryStorage()
  const first = createController({ storage })
  await first.controller.handleFailure({ errorCode: 'session_expired', jobId: 'job-1', tabId: 7 })
  const second = createController({ storage })
  const snapshot = await second.controller.handleFailure({ errorCode: 'session_expired', jobId: 'job-2', tabId: 7 })
  assert.equal(second.refreshCalls, 0)
  assert.equal(snapshot.state, 'blocked')
  assert.match(snapshot.terminalDecision || '', /refresh_cooldown/)
})

test('6 rate_limited uses cooldown without session refresh', async () => {
  const harness = createController()
  const snapshot = await harness.controller.handleFailure({ errorCode: 'rate_limited', jobId: 'job-1', tabId: 7 })
  assert.equal(snapshot.state, 'rate_limited')
  assert.equal(snapshot.blockedUntil, 61_000)
  assert.equal(harness.refreshCalls, 0)
})

test('7 unusual_activity blocks without session refresh', async () => {
  const harness = createController()
  const snapshot = await harness.controller.handleFailure({ errorCode: 'unusual_activity', jobId: 'job-1', tabId: 7 })
  assert.equal(snapshot.state, 'blocked')
  assert.equal(harness.refreshCalls, 0)
})

test('8 first generation_failed incident does not refresh session', async () => {
  const harness = createController()
  const snapshot = await harness.controller.handleFailure({ errorCode: 'generation_failed', jobId: 'job-1', tabId: 7 })
  assert.equal(snapshot.state, 'transient_failure')
  assert.equal(harness.refreshCalls, 0)
})

test('9 repeated generation_failed incidents without session evidence do not refresh', async () => {
  const harness = createController()
  await harness.controller.handleFailure({ errorCode: 'generation_failed', jobId: 'job-1', tabId: 7 })
  await harness.controller.handleFailure({ errorCode: 'generation_failed', jobId: 'job-2', tabId: 7 })
  assert.equal(harness.refreshCalls, 0)
})

test('10 download_failed does not create a recovery incident', async () => {
  const harness = createController()
  const before = await harness.controller.getSnapshot()
  const after = await harness.controller.handleFailure({ errorCode: 'download_failed', jobId: 'job-1', tabId: 7 })
  assert.equal(after.incidentId, before.incidentId)
  assert.equal(after.failureCount, 0)
})

test('11 flow_busy does not create a recovery incident', async () => {
  const harness = createController()
  const after = await harness.controller.handleFailure({ errorCode: 'flow_busy', jobId: 'job-1', tabId: 7 })
  assert.equal(after.incidentId, undefined)
  assert.equal(after.state, 'healthy')
})

test('12 bridge_unavailable recovers through safe reconnect and health probe', async () => {
  const harness = createController()
  const snapshot = await harness.controller.handleFailure({ errorCode: 'bridge_unavailable', jobId: 'job-1', tabId: 7 })
  assert.equal(harness.reconnectCalls, 1)
  assert.equal(snapshot.state, 'healthy')
})

test('13 failed bridge reconnect remains transient and fail-closed', async () => {
  const harness = createController({ reconnectBridge: async () => ({ success: false, reason: 'bridge_missing' }) })
  const snapshot = await harness.controller.handleFailure({ errorCode: 'bridge_unavailable', jobId: 'job-1', tabId: 7 })
  assert.equal(snapshot.state, 'transient_failure')
  assert.equal((await harness.controller.getAdmissionDecision()).allowed, false)
})

test('14 composer_missing while page is loading is transient, not session suspect', () => {
  const policy = classifyFlowRecoveryPolicy({ errorCode: 'composer_missing', context: { pageLoading: true } })
  assert.equal(policy.initialState, 'transient_failure')
  assert.equal(policy.action, 'cooldown')
})

test('15 composer_missing with high-confidence login warning is session suspect', () => {
  const policy = classifyFlowRecoveryPolicy({
    errorCode: 'composer_missing',
    context: { loginRequired: true, sessionEvidenceConfidence: 'high' },
  })
  assert.equal(policy.initialState, 'session_suspect')
  assert.equal(policy.action, 'session_refresh')
})

test('16 active in-flight job prevents session refresh', async () => {
  let revalidateCalls = 0
  const refresher = new FlowSessionRefresher({
    getAdmissionSnapshot: async () => ({ ...idleAdmission(), state: 'in_flight', activeJob: { jobId: 'active', source: 'workflow', tabId: 7, mediaType: 'image', requestedAt: 1, state: 'in_flight' } }),
    revalidateSession: async () => { revalidateCalls += 1; return { success: true, supported: true, reason: 'ok' } },
    reconnectBridge: async () => ({ success: true, reason: 'ok' }),
    probeHealth: async () => healthyProbe(),
    controlledReload: async () => ({ success: true, reason: 'ok' }),
  })
  const result = await refresher.refresh({ incidentId: 'i-1', tabId: 7, confidence: 'high', allowControlledReload: true })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'active_flow_job_prevents_refresh')
  assert.equal(revalidateCalls, 0)
})

test('17 submit_uncertain job prevents session refresh', async () => {
  const refresher = new FlowSessionRefresher({
    getAdmissionSnapshot: async () => ({ ...idleAdmission(), state: 'submit_uncertain', activeJob: { jobId: 'uncertain', source: 'workflow', tabId: 7, mediaType: 'image', requestedAt: 1, state: 'submit_uncertain' } }),
    revalidateSession: async () => ({ success: true, supported: true, reason: 'ok' }),
    reconnectBridge: async () => ({ success: true, reason: 'ok' }),
    probeHealth: async () => healthyProbe(),
    controlledReload: async () => ({ success: true, reason: 'ok' }),
  })
  assert.equal((await refresher.refresh({ incidentId: 'i-1', tabId: 7, confidence: 'high', allowControlledReload: true })).reason, 'submit_uncertain_prevents_refresh')
})

test('18 controlled reload never runs while a job is active', async () => {
  let reloadCalls = 0
  const refresher = new FlowSessionRefresher({
    getAdmissionSnapshot: async () => ({ ...idleAdmission(), state: 'in_flight', activeJob: { jobId: 'active', source: 'workflow', tabId: 7, mediaType: 'image', requestedAt: 1, state: 'in_flight' } }),
    revalidateSession: async () => ({ success: false, supported: false, reason: 'unsupported' }),
    reconnectBridge: async () => ({ success: false, reason: 'failed' }),
    probeHealth: async () => unhealthyProbe(),
    controlledReload: async () => { reloadCalls += 1; return { success: true, reason: 'ok' } },
  })
  await refresher.refresh({ incidentId: 'i-1', tabId: 7, confidence: 'high', allowControlledReload: true })
  assert.equal(reloadCalls, 0)
})

test('19 controlled reload runs at most once when policy allows', async () => {
  let reloadCalls = 0
  const refresher = new FlowSessionRefresher({
    getAdmissionSnapshot: async () => idleAdmission(),
    revalidateSession: async () => ({ success: false, supported: false, reason: 'unsupported' }),
    reconnectBridge: async () => ({ success: false, reason: 'failed' }),
    probeHealth: async () => unhealthyProbe(),
    controlledReload: async () => { reloadCalls += 1; return { success: true, reason: 'reloaded' } },
  })
  const result = await refresher.refresh({ incidentId: 'i-1', tabId: 7, confidence: 'high', allowControlledReload: true })
  assert.equal(reloadCalls, 1)
  assert.equal(result.reloadCount, 1)
})

test('20 session refresher exposes no submit or prompt operation', () => {
  const names = Object.getOwnPropertyNames(FlowSessionRefresher.prototype)
  assert.deepEqual(names.sort(), ['constructor', 'refresh'].sort())
})

test('21 FlowRecoveryController source has no generation dispatch action', async () => {
  const source = await readFile(new URL('../../src/background/flow/FlowRecoveryController.ts', import.meta.url), 'utf8')
  assert.equal(source.includes(['RUN', 'FLOW', 'PROMPT'].join('_')), false)
})

test('22 admission blocks while recovery state is recovering', async () => {
  const controller = new FlowAdmissionController({
    recoveryGate: async () => ({ allowed: false, state: 'recovering', statusReason: 'flow_recovery_in_progress' }),
  })
  const decision = await controller.requestAdmission({ source: 'workflow', tabId: 7, mediaType: 'image' }, async () => admissionHealth())
  assert.equal(decision.granted, false)
  assert.match(decision.statusReason, /recovery/)
})

test('23 admission can proceed when recovery state is healthy', async () => {
  const controller = new FlowAdmissionController({
    recoveryGate: async () => ({ allowed: true, state: 'healthy', statusReason: 'flow_recovery_healthy' }),
  })
  const decision = await controller.requestAdmission({ source: 'workflow', tabId: 7, mediaType: 'image' }, async () => admissionHealth())
  assert.equal(decision.granted, true)
})

test('24 rate-limit backoff grows exponentially and jitter stays in range', () => {
  assert.equal(calculateFlowRecoveryDelay({ baseDelayMs: 60_000, maxDelayMs: 600_000, attempt: 0, random: () => 0 }), 48_000)
  assert.equal(calculateFlowRecoveryDelay({ baseDelayMs: 60_000, maxDelayMs: 600_000, attempt: 1, random: () => 0.5 }), 120_000)
  assert.equal(calculateFlowRecoveryDelay({ baseDelayMs: 60_000, maxDelayMs: 600_000, attempt: 2, random: () => 1 }), 288_000)
})

test('25 abort cancels delay and cleans up its timer', async () => {
  const abort = new AbortController()
  let cleared = 0
  let rejectDelay!: (error: Error) => void
  const promise = waitForFlowRecoveryDelay(100, abort.signal, {
    setTimer: (_callback, _delay) => ({ id: 1 }),
    clearTimer: () => { cleared += 1 },
  })
  void rejectDelay
  abort.abort('test_cancel')
  await assert.rejects(promise, /test_cancel|aborted/i)
  assert.equal(cleared, 1)
})

test('26 stale recovery callback cannot mutate a newer incident', async () => {
  let resolveRefresh!: (value: { success: boolean; reason: string; probe: FlowHealthProbeResult; reloadCount: number }) => void
  const events: string[] = []
  const harness = createController({
    sessionRefresher: { refresh: () => new Promise((resolve) => { resolveRefresh = resolve }) },
    log: (event) => events.push(event),
  })
  const pending = harness.controller.handleFailure({ errorCode: 'session_expired', jobId: 'job-1', tabId: 7 })
  while (!resolveRefresh) await new Promise((resolve) => setImmediate(resolve))
  await harness.controller.handleFailure({ errorCode: 'unusual_activity', jobId: 'job-2', tabId: 7 })
  resolveRefresh({ success: true, reason: 'late_success', probe: healthyProbe(), reloadCount: 0 })
  await pending
  const snapshot = await harness.controller.getSnapshot()
  assert.equal(snapshot.errorCode, 'unusual_activity')
  assert.equal(snapshot.state, 'blocked')
  assert.ok(events.includes('FLOW_RECOVERY_STALE_CALLBACK_IGNORED'))
})

test('27 recovery snapshot restores across MV3-style controller restart', async () => {
  const storage = new MemoryRecoveryStorage()
  const first = createController({ storage })
  await first.controller.handleFailure({ errorCode: 'rate_limited', jobId: 'job-1', tabId: 7 })
  const second = createController({ storage })
  const restored = await second.controller.getSnapshot()
  assert.equal(restored.state, 'rate_limited')
  assert.equal(restored.incidentId, 'incident-1')
})

test('MV3 restart converts an interrupted recovering callback into a conservative block', async () => {
  const storage = new MemoryRecoveryStorage()
  let resolveRefresh!: (value: { success: boolean; reason: string; probe: FlowHealthProbeResult; reloadCount: number }) => void
  const first = createController({
    storage,
    sessionRefresher: { refresh: () => new Promise((resolve) => { resolveRefresh = resolve }) },
  })
  const pending = first.controller.handleFailure({ errorCode: 'session_expired', jobId: 'job-1', tabId: 7 })
  while (!resolveRefresh) await new Promise((resolve) => setImmediate(resolve))
  const second = createController({ storage })
  const restored = await second.controller.getSnapshot()
  assert.equal(restored.state, 'blocked')
  assert.equal(restored.terminalDecision, 'recovery_interrupted_by_service_worker_restart')
  resolveRefresh({ success: false, reason: 'old_worker_gone', probe: unhealthyProbe(), reloadCount: 0 })
  await pending
})

test('28 persistence failure rolls back state and emits no fake state transition', async () => {
  const storage = new MemoryRecoveryStorage()
  storage.failSave = true
  const events: string[] = []
  const harness = createController({ storage, log: (event) => events.push(event) })
  await assert.rejects(harness.controller.handleFailure({ errorCode: 'rate_limited', jobId: 'job-1', tabId: 7 }), /storage unavailable/)
  assert.equal((await harness.controller.getSnapshot()).state, 'healthy')
  assert.equal(events.includes('FLOW_RECOVERY_STATE_CHANGED'), false)
})

test('29 uncertain reconciliation identifies a matching active job', () => {
  assert.equal(reconcileSubmitUncertain({ jobId: 'job-1', observedJobId: 'job-1', observedProcessing: true, activeGenerationCount: 1 }).status, 'job_found_active')
})

test('30 terminal reconciliation releases only through Admission Controller', async () => {
  const admission = new FlowAdmissionController({ createJobId: () => 'job-1', minimumCooldownMs: 0 })
  await admission.requestAdmission({ source: 'workflow', tabId: 7, mediaType: 'image' }, async () => admissionHealth())
  await admission.markSubmitStarted('job-1')
  await admission.markSubmitUncertain('job-1', 'message_channel_closed')
  const result = reconcileSubmitUncertain({ jobId: 'job-1', observedJobId: 'job-1', terminalResultObserved: true, activeGenerationCount: 0 })
  if (result.status === 'job_found_terminal') await admission.completeJob('job-1', undefined, 'reconciled_terminal')
  assert.equal((await admission.getSnapshot()).state, 'idle')
})

test('31 no-evidence reconciliation does not release or resubmit', () => {
  const result = reconcileSubmitUncertain({ jobId: 'job-1', activeGenerationCount: 0 })
  assert.equal(result.status, 'no_evidence')
  assert.equal(Object.keys(result).includes('resubmit'), false)
})

test('32 flow-cooldown-ended Wait Node reads real recovery snapshot', async () => {
  const source = await readFile(new URL('../../src/pipeline/runner.ts', import.meta.url), 'utf8')
  assert.match(source, /FLOW_GET_RECOVERY_SNAPSHOT/)
  assert.match(source, /flow-cooldown-ended/)
})

test('33 manual session recovery is disabled outside eligible policy states', () => {
  assert.equal(isManualSessionRecoveryAllowed({ state: 'rate_limited', errorCode: 'rate_limited', sessionRefreshAttempted: false }), false)
  assert.equal(isManualSessionRecoveryAllowed({ state: 'session_suspect', errorCode: 'session_expired', sessionRefreshAttempted: false }), true)
  assert.equal(isManualSessionRecoveryAllowed({ state: 'blocked', errorCode: 'session_expired', sessionRefreshAttempted: true }), false)
})

test('34 manual reset wins over a late recovery result', async () => {
  let resolveRefresh!: (value: { success: boolean; reason: string; probe: FlowHealthProbeResult; reloadCount: number }) => void
  const harness = createController({ sessionRefresher: { refresh: () => new Promise((resolve) => { resolveRefresh = resolve }) } })
  const pending = harness.controller.handleFailure({ errorCode: 'session_expired', jobId: 'job-1', tabId: 7 })
  while (!resolveRefresh) await new Promise((resolve) => setImmediate(resolve))
  await harness.controller.manualReset(true)
  resolveRefresh({ success: true, reason: 'late_success', probe: healthyProbe(), reloadCount: 0 })
  await pending
  assert.equal((await harness.controller.getSnapshot()).state, 'healthy')
  assert.equal((await harness.controller.getSnapshot()).incidentId, undefined)
})

test('manual reset does not bypass persisted session refresh cooldown', async () => {
  const harness = createController()
  await harness.controller.handleFailure({ errorCode: 'session_expired', jobId: 'job-1', tabId: 7 })
  await harness.controller.manualReset(true)
  const snapshot = await harness.controller.handleFailure({ errorCode: 'session_expired', jobId: 'job-2', tabId: 7 })
  assert.equal(harness.refreshCalls, 1)
  assert.match(snapshot.terminalDecision || '', /refresh_cooldown/)
})

test('35 ChatGPT routing does not reference FlowRecoveryController', async () => {
  const sources = await Promise.all([
    '../../src/contents/content-script.ts',
    '../../src/providers/chatgpt.ts',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')))
  assert.equal(sources.some((source) => source.includes('FlowRecoveryController')), false)
})

test('unknown required health signals never classify as healthy', () => {
  const probe = createFlowHealthProbeResult({ checkedAt: 1, tabExists: true })
  assert.equal(probe.overall, 'unknown')
})

test('active generation health classifies as busy instead of session suspect', () => {
  const probe = createFlowHealthProbeResult({
    checkedAt: 1,
    tabExists: true,
    routeValid: true,
    bridgeReady: true,
    composerReady: true,
    loginRequired: false,
    sessionWarning: false,
    unusualActivityWarning: false,
    rateLimitWarning: false,
    blockingDialog: false,
    activeGenerationCount: 2,
  })
  assert.equal(probe.overall, 'busy')
})

test('busy probe preserves the current recovery state instead of creating a transient failure', async () => {
  const busyProbe = createFlowHealthProbeResult({
    checkedAt: 6_001,
    tabExists: true,
    routeValid: true,
    bridgeReady: true,
    composerReady: true,
    loginRequired: false,
    sessionWarning: false,
    unusualActivityWarning: false,
    rateLimitWarning: false,
    blockingDialog: false,
    activeGenerationCount: 1,
  })
  const harness = createController({ probeHealth: async () => busyProbe })
  await harness.controller.handleFailure({ errorCode: 'rate_limited', jobId: 'job-1', tabId: 7 })
  harness.setNow(61_001)

  const decision = await harness.controller.getAdmissionDecision()
  const snapshot = await harness.controller.getSnapshot()
  assert.equal(decision.allowed, false)
  assert.equal(snapshot.state, 'rate_limited')
  assert.equal(snapshot.lastProbeResult?.overall, 'busy')
  assert.equal(snapshot.terminalDecision, 'health_probe_busy')
})

test('healthy transient probe reopens recovery only after cooldown expires', async () => {
  const harness = createController()
  await harness.controller.handleFailure({ errorCode: 'generation_failed', jobId: 'job-1', tabId: 7 })
  assert.equal((await harness.controller.getAdmissionDecision()).allowed, false)
  harness.setNow(6_001)
  assert.equal((await harness.controller.getAdmissionDecision()).allowed, true)
})

test('submit_uncertain policy remains blocked and never requests session refresh', () => {
  const policy = classifyFlowRecoveryPolicy({ errorCode: 'submit_uncertain' })
  assert.equal(policy.action, 'reconcile')
  assert.equal(policy.initialState, 'blocked')
})
