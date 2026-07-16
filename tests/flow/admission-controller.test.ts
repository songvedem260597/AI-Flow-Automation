import assert from 'node:assert/strict'
import test from 'node:test'

import { FlowAdmissionController } from '../../src/background/flow/FlowAdmissionController.ts'
import type { FlowAdmissionHealth } from '../../src/types/flow.ts'

const healthy = (): FlowAdmissionHealth => ({
  healthy: true,
  tabExists: true,
  url: 'https://labs.google/fx/tools/flow/project/test',
  bridgeReady: true,
  composerPresent: true,
  processing: 0,
  pending: 0,
  generating: 0,
  blockingDialog: false,
  evidence: [],
})

test('fixture 14: concurrent GenPanel and Workflow requests admit only one source', async () => {
  let resolveProbe!: (health: FlowAdmissionHealth) => void
  const controller = new FlowAdmissionController({ createJobId: (() => { let i = 0; return () => `job-${++i}` })() })
  const first = controller.requestAdmission(
    { source: 'gen-panel', tabId: 7, mediaType: 'image' },
    () => new Promise((resolve) => { resolveProbe = resolve }),
  )
  await Promise.resolve()
  const second = await controller.requestAdmission(
    { source: 'workflow', callerId: 'run-2', tabId: 7, mediaType: 'video' },
    async () => healthy(),
  )
  assert.equal(second.granted, false)
  assert.equal(second.errorCode, 'flow_busy')
  while (!resolveProbe) await new Promise((resolve) => setImmediate(resolve))
  resolveProbe(healthy())
  assert.equal((await first).granted, true)
})

test('pre-submit busy health denies admission before submit', async () => {
  const controller = new FlowAdmissionController({ createJobId: () => 'busy-job' })
  const decision = await controller.requestAdmission(
    { source: 'direct-message', tabId: 7, mediaType: 'image' },
    async () => ({ ...healthy(), healthy: false, generating: 1, errorCode: 'flow_busy', statusReason: 'provider_generating' }),
  )
  assert.equal(decision.granted, false)
  assert.equal(decision.errorCode, 'flow_busy')
  assert.equal(decision.snapshot.state, 'idle')
})

test('fixture 13: cancellation before submit releases the mutex', async () => {
  const controller = new FlowAdmissionController({ createJobId: () => 'cancel-job' })
  const admitted = await controller.requestAdmission(
    { source: 'workflow', callerId: 'run-cancel', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  assert.equal(admitted.granted, true)
  const cancelled = await controller.requestCancellation({ callerId: 'run-cancel' })
  assert.equal(cancelled.accepted, true)
  assert.equal(cancelled.snapshot.state, 'idle')
})

test('fixture 15: stopping a pipeline after submit starts keeps Flow blocked as submit_uncertain', async () => {
  const controller = new FlowAdmissionController({ createJobId: () => 'in-flight-job' })
  await controller.requestAdmission(
    { source: 'workflow', callerId: 'run-stop', tabId: 7, mediaType: 'video' },
    async () => healthy(),
  )
  await controller.markSubmitStarted('in-flight-job')
  const cancelled = await controller.requestCancellation({ callerId: 'run-stop' })
  assert.equal(cancelled.snapshot.state, 'submit_uncertain')
  const next = await controller.requestAdmission(
    { source: 'gen-panel', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  assert.equal(next.granted, false)
  assert.equal(next.errorCode, 'flow_busy')
})

test('confirmed in-flight generation is not released by caller cancellation', async () => {
  const controller = new FlowAdmissionController({ createJobId: () => 'confirmed-job' })
  await controller.requestAdmission(
    { source: 'workflow', callerId: 'run-confirmed', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  await controller.markSubmitStarted('confirmed-job')
  await controller.markSubmitConfirmed('confirmed-job')
  const cancelled = await controller.requestCancellation({ callerId: 'run-confirmed' })
  assert.equal(cancelled.snapshot.state, 'in_flight')
  await controller.completeJob('confirmed-job')
  assert.equal((await controller.getSnapshot()).state, 'idle')
})

test('unusual activity moves the gate to blocked without resubmission', async () => {
  const controller = new FlowAdmissionController({ createJobId: () => 'blocked-job' })
  const decision = await controller.requestAdmission(
    { source: 'direct-message', tabId: 7, mediaType: 'image' },
    async () => ({ ...healthy(), healthy: false, errorCode: 'unusual_activity', statusReason: 'unusual_activity_warning' }),
  )
  assert.equal(decision.snapshot.state, 'blocked')
  assert.equal(decision.snapshot.activeJob?.errorCode, 'unusual_activity')
})

test('pre-submit lease timeout releases a job that never crossed submit', async () => {
  let now = 1_000
  const controller = new FlowAdmissionController({
    now: () => now,
    createJobId: () => 'lease-job',
    preSubmitLeaseMs: 100,
  })
  await controller.requestAdmission(
    { source: 'direct-message', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  now += 101
  assert.equal((await controller.getSnapshot()).state, 'idle')
})

test('in-flight safety timeout becomes submit_uncertain and never auto-releases', async () => {
  let now = 1_000
  const controller = new FlowAdmissionController({
    now: () => now,
    createJobId: () => 'deadlock-job',
    inFlightSafetyMs: 100,
  })
  await controller.requestAdmission(
    { source: 'workflow', callerId: 'run-deadlock', tabId: 7, mediaType: 'video' },
    async () => healthy(),
  )
  await controller.markSubmitStarted('deadlock-job')
  now += 101
  const snapshot = await controller.getSnapshot()
  assert.equal(snapshot.state, 'submit_uncertain')
  assert.equal(snapshot.activeJob?.errorCode, 'submit_uncertain')
})

test('submitted jobs enforce the configurable minimum cooldown before another admission', async () => {
  let now = 1_000
  const controller = new FlowAdmissionController({
    now: () => now,
    createJobId: (() => { let i = 0; return () => `cooldown-job-${++i}` })(),
    minimumCooldownMs: 500,
  })
  const first = await controller.requestAdmission(
    { source: 'workflow', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  await controller.markSubmitStarted(first.job!.jobId)
  await controller.markSubmitConfirmed(first.job!.jobId)
  await controller.completeJob(first.job!.jobId)

  const duringCooldown = await controller.requestAdmission(
    { source: 'gen-panel', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  assert.equal(duringCooldown.granted, false)
  assert.equal(duringCooldown.errorCode, 'flow_busy')
  now += 501
  const afterCooldown = await controller.requestAdmission(
    { source: 'gen-panel', tabId: 7, mediaType: 'image' },
    async () => healthy(),
  )
  assert.equal(afterCooldown.granted, true)
})
