import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { FlowAdmissionController, type FlowAdmissionLogEvent } from '../../src/background/flow/FlowAdmissionController.ts'
import {
  sampleFlowSubmissionPacingDelay,
  waitForFlowSubmissionPacingDelay,
  type FlowPacingTimerAdapter,
} from '../../src/background/flow/submissionPacing.ts'
import type { FlowAdmissionHealth, FlowRecoveryAdmissionDecision } from '../../src/types/flow.ts'

const healthy = (): FlowAdmissionHealth => ({
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

class FakePacingTimer implements FlowPacingTimerAdapter {
  now = 1_000
  private nextId = 0
  private tasks = new Map<number, { at: number; callback: () => void }>()

  setTimer(callback: () => void, delayMs: number): number {
    const id = ++this.nextId
    this.tasks.set(id, { at: this.now + Math.max(0, delayMs), callback })
    return id
  }

  clearTimer(handle: unknown): void {
    this.tasks.delete(Number(handle))
  }

  get pendingCount(): number {
    return this.tasks.size
  }

  get nextDelayMs(): number | null {
    const next = [...this.tasks.values()].sort((a, b) => a.at - b.at)[0]
    return next ? Math.max(0, next.at - this.now) : null
  }

  advanceBy(durationMs: number): void {
    const target = this.now + durationMs
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.now = next[1].at
      this.tasks.delete(next[0])
      next[1].callback()
    }
    this.now = target
  }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

test('injected RNG samples deterministic inclusive pacing bounds', () => {
  const range = { minMs: 300, maxMs: 900 }
  assert.equal(sampleFlowSubmissionPacingDelay(range, () => 0), 300)
  assert.equal(sampleFlowSubmissionPacingDelay(range, () => 0.5), 600)
  assert.equal(sampleFlowSubmissionPacingDelay(range, () => 1), 900)
})

test('abortable pacing clears its fake timer and cannot resolve later', async () => {
  const timer = new FakePacingTimer()
  const abort = new AbortController()
  let resolved = false
  const pending = waitForFlowSubmissionPacingDelay(600, abort.signal, timer)
    .then(() => { resolved = true })

  assert.equal(timer.pendingCount, 1)
  abort.abort('test_cancelled')
  await assert.rejects(pending, /test_cancelled/)
  assert.equal(timer.pendingCount, 0)
  timer.advanceBy(1_000)
  assert.equal(resolved, false)
})

test('Admission Controller owns deterministic insert and submit permits', async () => {
  const timer = new FakePacingTimer()
  const randomValues = [0, 1]
  const pacingLogs: Array<{ event: FlowAdmissionLogEvent; payload: Record<string, unknown> }> = []
  const controller = new FlowAdmissionController({
    now: () => timer.now,
    createJobId: () => 'paced-job',
    random: () => randomValues.shift() ?? 0,
    pacingTimer: timer,
    minimumCooldownMs: 0,
    submissionPacing: {
      enabled: true,
      beforeInsert: { minMs: 300, maxMs: 900 },
      beforeSubmit: { minMs: 500, maxMs: 1_500 },
      betweenAutomaticJobs: { minMs: 5_000, maxMs: 15_000 },
    },
    log(event, payload) {
      if (event.startsWith('FLOW_PACING_')) pacingLogs.push({ event, payload })
    },
  })
  const admitted = await controller.requestAdmission(
    { source: 'workflow', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  assert.equal(admitted.granted, true)

  const insertPermit = controller.waitForSubmissionPacing('paced-job', 'before_insert')
  await flush()
  assert.equal(timer.nextDelayMs, 300)
  timer.advanceBy(299)
  await flush()
  assert.equal((await controller.getSnapshot()).state, 'admitted')
  timer.advanceBy(1)
  assert.equal((await insertPermit).granted, true)

  const submitPermit = controller.waitForSubmissionPacing('paced-job', 'before_submit')
  await flush()
  assert.equal(timer.nextDelayMs, 1_500)
  timer.advanceBy(1_500)
  assert.equal((await submitPermit).granted, true)
  assert.equal((await controller.getSnapshot()).state, 'in_flight')

  assert.deepEqual(pacingLogs, [
    { event: 'FLOW_PACING_BEFORE_INSERT', payload: { jobId: 'paced-job', durationMs: 300 } },
    { event: 'FLOW_PACING_BEFORE_SUBMIT', payload: { jobId: 'paced-job', durationMs: 1_500 } },
  ])
  for (const entry of pacingLogs) {
    assert.deepEqual(Object.keys(entry.payload).sort(), ['durationMs', 'jobId'])
  }
})

test('cancelling a phase prevents its old timer from affecting a new job', async () => {
  const timer = new FakePacingTimer()
  let id = 0
  const controller = new FlowAdmissionController({
    now: () => timer.now,
    createJobId: () => `cancel-pacing-${++id}`,
    random: () => 0,
    pacingTimer: timer,
    minimumCooldownMs: 0,
    submissionPacing: { enabled: true, beforeInsert: { minMs: 300, maxMs: 300 } },
  })
  const first = await controller.requestAdmission(
    { source: 'workflow', callerId: 'run-1', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  const permit = controller.waitForSubmissionPacing(first.job!.jobId, 'before_insert')
  await flush()
  assert.equal(timer.pendingCount, 1)

  await controller.requestCancellation({ callerId: 'run-1' })
  assert.equal((await permit).granted, false)
  assert.equal(timer.pendingCount, 0)

  const second = await controller.requestAdmission(
    { source: 'workflow', callerId: 'run-2', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  assert.equal(second.granted, true)
  timer.advanceBy(10_000)
  assert.equal((await controller.getSnapshot()).activeJob?.jobId, second.job?.jobId)
  assert.equal((await controller.getSnapshot()).state, 'admitted')
})

test('automatic jobs wait 5-15 seconds instead of failing busy', async () => {
  const timer = new FakePacingTimer()
  let id = 0
  let probeCount = 0
  const controller = new FlowAdmissionController({
    now: () => timer.now,
    createJobId: () => `between-job-${++id}`,
    random: () => 0,
    pacingTimer: timer,
    minimumCooldownMs: 0,
    submissionPacing: {
      enabled: true,
      beforeInsert: { minMs: 0, maxMs: 0 },
      beforeSubmit: { minMs: 0, maxMs: 0 },
      betweenAutomaticJobs: { minMs: 5_000, maxMs: 15_000 },
    },
  })
  const first = await controller.requestAdmission(
    { source: 'workflow', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  await controller.waitForSubmissionPacing(first.job!.jobId, 'before_submit')
  await controller.markSubmitConfirmed(first.job!.jobId)
  await controller.completeJob(first.job!.jobId)
  assert.equal((await controller.getSnapshot()).cooldownUntil, timer.now + 5_000)

  const secondPending = controller.requestAdmission(
    { source: 'workflow', tabId: 7, mediaType: 'image' },
    async () => { probeCount += 1; return healthy() },
  )
  await flush()
  assert.equal((await controller.getSnapshot()).state, 'checking')
  assert.equal(timer.nextDelayMs, 5_000)
  assert.equal(probeCount, 0)

  timer.advanceBy(4_999)
  await flush()
  assert.equal(probeCount, 0)
  timer.advanceBy(1)
  const second = await secondPending
  assert.equal(second.granted, true)
  assert.equal(probeCount, 1)
})

test('cancelling the between-job wait clears its timer before the next job', async () => {
  const timer = new FakePacingTimer()
  let id = 0
  const controller = new FlowAdmissionController({
    now: () => timer.now,
    createJobId: () => `between-cancel-${++id}`,
    random: () => 0,
    pacingTimer: timer,
    minimumCooldownMs: 0,
    submissionPacing: {
      enabled: true,
      beforeSubmit: { minMs: 0, maxMs: 0 },
      betweenAutomaticJobs: { minMs: 5_000, maxMs: 5_000 },
    },
  })
  const first = await controller.requestAdmission(
    { source: 'workflow', callerId: 'run-1', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  await controller.waitForSubmissionPacing(first.job!.jobId, 'before_submit')
  await controller.markSubmitConfirmed(first.job!.jobId)
  await controller.completeJob(first.job!.jobId)

  const cancelledPending = controller.requestAdmission(
    { source: 'workflow', callerId: 'run-2', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  await flush()
  assert.equal(timer.pendingCount, 1)
  const cancellation = await controller.requestCancellation({ callerId: 'run-2' })
  assert.equal(cancellation.accepted, true)
  assert.equal((await cancelledPending).granted, false)
  assert.equal(timer.pendingCount, 0)

  const nextPending = controller.requestAdmission(
    { source: 'workflow', callerId: 'run-3', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  await flush()
  assert.equal(timer.pendingCount, 1)
  timer.advanceBy(5_000)
  const next = await nextPending
  assert.equal(next.granted, true)
  assert.equal((await controller.getSnapshot()).activeJob?.jobId, next.job?.jobId)
})

test('content requests controller permits in verify-before-click order', () => {
  const content = readFileSync('src/contents/flow-content.ts', 'utf8')
  const background = readFileSync('src/background/index.ts', 'utf8')

  const insertPermit = content.indexOf('const insertPacing = await requestFlowSubmissionPacing(')
  const insertCall = content.indexOf("bridgeCall('insert'", insertPermit)
  const exactSlateVerification = content.indexOf('if (!isExactMatch)', insertCall)
  const submitPermit = content.indexOf('const submitPacing = await requestFlowSubmissionPacing(', exactSlateVerification)
  const submitCall = content.indexOf("bridgeCall('submit'", submitPermit)

  assert.ok(insertPermit >= 0)
  assert.ok(insertCall > insertPermit)
  assert.ok(exactSlateVerification > insertCall)
  assert.ok(submitPermit > exactSlateVerification)
  assert.ok(submitCall > submitPermit)
  assert.match(background, /case 'FLOW_REQUEST_SUBMISSION_PACING':[\s\S]*handleFlowSubmissionPacing/)
  assert.match(background, /flowAdmissionController\.waitForSubmissionPacing\(jobId, phase\)/)
})

test('recovery or rate-limit cooldown owns the wait without submission pacing', async () => {
  const timer = new FakePacingTimer()
  let recoveryAllowed = true
  const recoveryGate = async (): Promise<FlowRecoveryAdmissionDecision> => recoveryAllowed
    ? { allowed: true, state: 'healthy', statusReason: 'healthy' }
    : { allowed: false, state: 'rate_limited', errorCode: 'rate_limited', statusReason: 'rate_limit_cooldown_active' }
  let id = 0
  const pacingLogs: FlowAdmissionLogEvent[] = []
  const controller = new FlowAdmissionController({
    now: () => timer.now,
    createJobId: () => `recovery-pacing-${++id}`,
    random: () => 0,
    pacingTimer: timer,
    minimumCooldownMs: 0,
    recoveryGate,
    submissionPacing: {
      enabled: true,
      beforeSubmit: { minMs: 0, maxMs: 0 },
      betweenAutomaticJobs: { minMs: 5_000, maxMs: 5_000 },
    },
    log(event) {
      if (event.startsWith('FLOW_PACING_')) pacingLogs.push(event)
    },
  })
  const failed = await controller.requestAdmission(
    { source: 'workflow', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  await controller.waitForSubmissionPacing(failed.job!.jobId, 'before_submit')
  await controller.completeJob(failed.job!.jobId, 'rate_limited', 'provider_rate_limited')
  assert.equal((await controller.getSnapshot()).cooldownUntil, 0)
  assert.equal(pacingLogs.includes('FLOW_PACING_BETWEEN_JOBS'), false)

  recoveryAllowed = false
  const denied = await controller.requestAdmission(
    { source: 'workflow', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  assert.equal(denied.granted, false)
  assert.equal(denied.errorCode, 'rate_limited')
  assert.equal(timer.pendingCount, 0)
})
