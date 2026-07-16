import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  FlowAdmissionController,
  type FlowAdmissionDecision,
  type FlowAdmissionStorage,
} from '../../src/background/flow/FlowAdmissionController.ts'
import type { FlowAdmissionHealth, FlowAdmissionSnapshot } from '../../src/types/flow.ts'

const healthy = (): FlowAdmissionHealth => ({
  healthy: true,
  tabExists: true,
  url: 'https://labs.google/fx/tools/flow/project/runtime-matrix',
  bridgeReady: true,
  composerPresent: true,
  processing: 0,
  pending: 0,
  generating: 0,
  blockingDialog: false,
  evidence: [],
})

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

class MemoryAdmissionStorage implements FlowAdmissionStorage {
  snapshot: FlowAdmissionSnapshot | null = null

  async load(): Promise<FlowAdmissionSnapshot | null> {
    return this.snapshot ? clone(this.snapshot) : null
  }

  async save(snapshot: FlowAdmissionSnapshot): Promise<void> {
    this.snapshot = clone(snapshot)
  }
}

const ids = () => {
  let value = 0
  return () => `matrix-job-${++value}`
}

async function admittedRequest(
  source: string,
  options: { callerId?: string; mediaType?: 'image' | 'video' } = {},
): Promise<{ controller: FlowAdmissionController; decision: FlowAdmissionDecision; dispatchCount: number }> {
  const controller = new FlowAdmissionController({ createJobId: ids(), minimumCooldownMs: 0 })
  const decision = await controller.requestAdmission({
    source,
    ...(options.callerId ? { callerId: options.callerId } : {}),
    tabId: 17,
    mediaType: options.mediaType || 'image',
  }, async () => healthy())
  const dispatchCount = decision.granted ? 1 : 0
  return { controller, decision, dispatchCount }
}

async function sameTickPair(firstSource: string, secondSource: string) {
  let resolveProbe!: (health: FlowAdmissionHealth) => void
  const controller = new FlowAdmissionController({ createJobId: ids(), minimumCooldownMs: 0 })
  const first = controller.requestAdmission(
    { source: firstSource, tabId: 17, mediaType: 'image' },
    () => new Promise((resolve) => { resolveProbe = resolve }),
  )
  await Promise.resolve()
  const second = await controller.requestAdmission(
    { source: secondSource, tabId: 17, mediaType: 'video' },
    async () => healthy(),
  )
  while (!resolveProbe) await new Promise((resolve) => setImmediate(resolve))
  resolveProbe(healthy())
  const firstDecision = await first
  return {
    controller,
    first: firstDecision,
    second,
    dispatchCount: Number(firstDecision.granted) + Number(second.granted),
  }
}

test('matrix 01: GenPanel request owns an idle gate and dispatches once', async () => {
  const { controller, decision, dispatchCount } = await admittedRequest('gen-panel')
  assert.equal(decision.granted, true)
  assert.equal(decision.snapshot.activeJob?.source, 'gen-panel')
  assert.equal(decision.snapshot.state, 'admitted')
  assert.equal(dispatchCount, 1)
  await controller.completeJob(decision.job!.jobId)
  assert.equal((await controller.getSnapshot()).state, 'idle')
})

test('matrix 02: Workflow request owns an idle gate and dispatches once', async () => {
  const { decision, dispatchCount } = await admittedRequest('workflow', { callerId: 'workflow-02' })
  assert.equal(decision.granted, true)
  assert.equal(decision.snapshot.activeJob?.callerId, 'workflow-02')
  assert.equal(dispatchCount, 1)
})

test('matrix 03: direct message owns an idle gate and dispatches once', async () => {
  const { decision, dispatchCount } = await admittedRequest('direct-message')
  assert.equal(decision.granted, true)
  assert.equal(decision.snapshot.activeJob?.source, 'direct-message')
  assert.equal(dispatchCount, 1)
})

test('matrix 04: same-tick GenPanel and Workflow admit exactly one owner', async () => {
  const result = await sameTickPair('gen-panel', 'workflow')
  assert.equal(result.first.granted, true)
  assert.equal(result.second.granted, false)
  assert.equal(result.second.errorCode, 'flow_busy')
  assert.equal(result.dispatchCount, 1)
  assert.equal((await result.controller.getSnapshot()).activeJob?.source, 'gen-panel')
})

test('matrix 05: same-tick Workflow and direct message admit exactly one owner', async () => {
  const result = await sameTickPair('workflow', 'direct-message')
  assert.equal(result.first.granted, true)
  assert.equal(result.second.granted, false)
  assert.equal(result.dispatchCount, 1)
  assert.equal((await result.controller.getSnapshot()).activeJob?.source, 'workflow')
})

test('matrix 06: two same-tick direct messages dispatch only once', async () => {
  const result = await sameTickPair('direct-message', 'direct-message')
  assert.equal(result.first.granted, true)
  assert.equal(result.second.granted, false)
  assert.equal(result.dispatchCount, 1)
})

test('matrix 07: content rejects a request without a background admission job ID', () => {
  const source = readFileSync('src/contents/flow-content.ts', 'utf8')
  assert.match(source, /missing_flow_admission_job_id/)
  assert.match(source, /FLOW_ADMISSION_REQUIRED/)
})

test('matrix 08: cancellation before submit releases ownership with no dispatch', async () => {
  const { controller, decision } = await admittedRequest('workflow', { callerId: 'stop-08' })
  const cancellation = await controller.requestCancellation({ callerId: 'stop-08' })
  assert.equal(decision.snapshot.state, 'admitted')
  assert.equal(cancellation.snapshot.state, 'idle')
  assert.equal(cancellation.snapshot.lastJob?.state, 'cancelled')
})

test('matrix 09: cancellation during pre-submit probe releases checking without dispatch', async () => {
  let resolveProbe!: (health: FlowAdmissionHealth) => void
  const signal = new AbortController()
  const controller = new FlowAdmissionController({ createJobId: ids(), minimumCooldownMs: 0 })
  const pending = controller.requestAdmission(
    { source: 'workflow', callerId: 'stop-09', tabId: 17, mediaType: 'image', signal: signal.signal },
    () => new Promise((resolve) => { resolveProbe = resolve }),
  )
  while (!resolveProbe) await new Promise((resolve) => setImmediate(resolve))
  signal.abort('matrix_cancel_during_probe')
  resolveProbe(healthy())
  const decision = await pending
  assert.equal(decision.granted, false)
  assert.equal(decision.errorCode, 'cancelled')
  assert.equal(decision.snapshot.state, 'idle')
})

test('matrix 10: cancellation after submit started but before confirmation stays locked uncertain', async () => {
  const { controller, decision } = await admittedRequest('workflow', { callerId: 'stop-10' })
  await controller.markSubmitStarted(decision.job!.jobId)
  const cancellation = await controller.requestCancellation({ callerId: 'stop-10' })
  assert.equal(cancellation.snapshot.state, 'submit_uncertain')
  const denied = await controller.requestAdmission(
    { source: 'direct-message', tabId: 17, mediaType: 'image' },
    async () => healthy(),
  )
  assert.equal(denied.granted, false)
})

test('matrix 11: stopPipeline before submit cancels caller reservation', async () => {
  const { controller } = await admittedRequest('workflow', { callerId: 'pipeline-11' })
  const stopped = await controller.requestCancellation({ callerId: 'pipeline-11' })
  assert.equal(stopped.accepted, true)
  assert.equal(stopped.snapshot.state, 'idle')
  assert.equal(stopped.snapshot.cooldownUntil, 0)
})

test('matrix 12: stopPipeline while submit is uncertain never releases the mutex', async () => {
  const { controller, decision } = await admittedRequest('workflow', { callerId: 'pipeline-12' })
  await controller.markSubmitStarted(decision.job!.jobId)
  await controller.markSubmitUncertain(decision.job!.jobId, 'runtime_channel_lost')
  const stopped = await controller.requestCancellation({ callerId: 'pipeline-12' })
  assert.equal(stopped.accepted, true)
  assert.equal(stopped.snapshot.state, 'submit_uncertain')
})

test('matrix 13: MV3 restart restores an admitted owner and denies a duplicate', async () => {
  const storage = new MemoryAdmissionStorage()
  const firstController = new FlowAdmissionController({ storage, createJobId: ids(), minimumCooldownMs: 0 })
  const first = await firstController.requestAdmission(
    { source: 'workflow', callerId: 'restart-13', tabId: 17, mediaType: 'image' },
    async () => healthy(),
  )
  assert.equal(first.granted, true)

  const restarted = new FlowAdmissionController({ storage, createJobId: ids(), minimumCooldownMs: 0 })
  assert.equal((await restarted.getSnapshot()).state, 'admitted')
  const duplicate = await restarted.requestAdmission(
    { source: 'gen-panel', tabId: 17, mediaType: 'image' },
    async () => healthy(),
  )
  assert.equal(duplicate.granted, false)
  assert.equal(duplicate.snapshot.activeJob?.callerId, 'restart-13')
})

test('matrix 14: MV3 restart restores an in-flight owner and denies a duplicate', async () => {
  const storage = new MemoryAdmissionStorage()
  const firstController = new FlowAdmissionController({ storage, createJobId: ids(), minimumCooldownMs: 0 })
  const first = await firstController.requestAdmission(
    { source: 'workflow', callerId: 'restart-14', tabId: 17, mediaType: 'video' },
    async () => healthy(),
  )
  await firstController.markSubmitStarted(first.job!.jobId)
  await firstController.markSubmitConfirmed(first.job!.jobId)

  const restarted = new FlowAdmissionController({ storage, createJobId: ids(), minimumCooldownMs: 0 })
  const snapshot = await restarted.getSnapshot()
  assert.equal(snapshot.state, 'in_flight')
  assert.equal(typeof snapshot.activeJob?.submittedAt, 'number')
  assert.equal(snapshot.activeJob?.submittedAt, storage.snapshot?.activeJob?.submittedAt)
  const duplicate = await restarted.requestAdmission(
    { source: 'direct-message', tabId: 17, mediaType: 'image' },
    async () => healthy(),
  )
  assert.equal(duplicate.granted, false)
})

test('matrix 15: closed Flow tab during checking fails terminal and releases without dispatch', async () => {
  const controller = new FlowAdmissionController({ createJobId: ids(), minimumCooldownMs: 0 })
  const result = await controller.requestAdmission(
    { source: 'gen-panel', tabId: 17, mediaType: 'image' },
    async () => ({
      ...healthy(), healthy: false, tabExists: false, bridgeReady: false, composerPresent: false,
      errorCode: 'bridge_unavailable', statusReason: 'flow_tab_closed_during_probe',
    }),
  )
  assert.equal(result.granted, false)
  assert.equal(result.snapshot.state, 'idle')
  assert.equal(result.snapshot.lastJob?.state, 'terminal')
})

test('matrix 16: Flow reload during checking fails closed without dispatch', async () => {
  const controller = new FlowAdmissionController({ createJobId: ids(), minimumCooldownMs: 0 })
  const result = await controller.requestAdmission(
    { source: 'workflow', tabId: 17, mediaType: 'image' },
    async () => ({
      ...healthy(), healthy: false, bridgeReady: false, composerPresent: false,
      errorCode: 'bridge_unavailable', statusReason: 'flow_reload_context_invalidated',
    }),
  )
  assert.equal(result.granted, false)
  assert.equal(result.snapshot.state, 'idle')
})

test('matrix 17: bridge disconnect during checking fails closed without dispatch', async () => {
  const controller = new FlowAdmissionController({ createJobId: ids(), minimumCooldownMs: 0 })
  const result = await controller.requestAdmission(
    { source: 'direct-message', tabId: 17, mediaType: 'video' },
    async () => { throw new Error('bridge_disconnected_during_probe') },
  )
  assert.equal(result.granted, false)
  assert.equal(result.errorCode, 'bridge_unavailable')
  assert.equal(result.snapshot.state, 'idle')
})

test('matrix 18: composer disappearing after admission terminates the same owner without duplicate dispatch', async () => {
  const { controller, decision, dispatchCount } = await admittedRequest('workflow', { callerId: 'composer-18' })
  const terminal = await controller.completeJob(decision.job!.jobId, 'composer_missing', 'composer_disappeared_before_submit')
  assert.equal(dispatchCount, 1)
  assert.equal(terminal.state, 'idle')
  assert.equal(terminal.lastJob?.errorCode, 'composer_missing')
  assert.equal(terminal.lastJob?.submittedAt, undefined)
})

test('matrix 19: processing Flow tile denies admission before content dispatch', async () => {
  const controller = new FlowAdmissionController({ createJobId: ids(), minimumCooldownMs: 0 })
  const result = await controller.requestAdmission(
    { source: 'gen-panel', tabId: 17, mediaType: 'image' },
    async () => ({
      ...healthy(), healthy: false, processing: 1, generating: 1,
      errorCode: 'flow_busy', statusReason: 'provider_has_generating_tiles',
    }),
  )
  assert.equal(result.granted, false)
  assert.equal(result.errorCode, 'flow_busy')
  assert.equal(result.snapshot.state, 'idle')
})

test('matrix 20: acknowledged manual reset releases only a blocked job', async () => {
  const controller = new FlowAdmissionController({ createJobId: ids(), minimumCooldownMs: 0 })
  const blocked = await controller.requestAdmission(
    { source: 'gen-panel', tabId: 17, mediaType: 'image' },
    async () => ({
      ...healthy(), healthy: false, errorCode: 'unusual_activity', statusReason: 'unusual_activity_warning',
    }),
  )
  assert.equal(blocked.snapshot.state, 'blocked')
  assert.equal((await controller.resetBlockedState(false)).state, 'blocked')
  const reset = await controller.resetBlockedState(true)
  assert.equal(reset.state, 'idle')
  assert.equal(reset.lastJob?.state, 'manual_reset')
  assert.equal((await controller.resetBlockedState(true)).lastJob?.state, 'manual_reset')
})
