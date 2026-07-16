import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FlowAdmissionController,
  type FlowAdmissionLogEvent,
} from '../../src/background/flow/FlowAdmissionController.ts'
import type { FlowAdmissionHealth, FlowAdmissionSnapshot } from '../../src/types/flow.ts'

const healthy = (): FlowAdmissionHealth => ({
  healthy: true,
  tabExists: true,
  url: 'https://labs.google/fx/tools/flow/project/runtime-test',
  bridgeReady: true,
  composerPresent: true,
  processing: 0,
  pending: 0,
  generating: 0,
  blockingDialog: false,
  evidence: [],
})

test('blocked jobs reject a late submit confirmation instead of becoming in_flight', async () => {
  const controller = new FlowAdmissionController({ createJobId: () => 'blocked-transition' })
  await controller.requestAdmission(
    { source: 'direct-message', tabId: 9, mediaType: 'image' },
    async () => ({
      ...healthy(),
      healthy: false,
      errorCode: 'unusual_activity',
      statusReason: 'unusual_activity_warning',
    }),
  )

  await controller.markSubmitConfirmed('blocked-transition', 'late_confirmation')
  const snapshot = await controller.getSnapshot()
  assert.equal(snapshot.state, 'blocked')
  assert.equal(snapshot.activeJob?.submitConfirmedAt, undefined)
})

test('in-flight safety timeout starts at submittedAt, not admittedAt', async () => {
  let now = 1_000
  const controller = new FlowAdmissionController({
    now: () => now,
    createJobId: () => 'submit-clock',
    inFlightSafetyMs: 100,
  })
  await controller.requestAdmission(
    { source: 'workflow', tabId: 9, mediaType: 'video' },
    async () => healthy(),
  )
  now = 1_090
  await controller.markSubmitStarted('submit-clock')
  now = 1_101
  assert.equal((await controller.getSnapshot()).state, 'in_flight')
})

test('safety timeout fires exactly at its configured boundary', async () => {
  let now = 2_000
  const controller = new FlowAdmissionController({
    now: () => now,
    createJobId: () => 'exact-timeout',
    inFlightSafetyMs: 100,
  })
  await controller.requestAdmission(
    { source: 'workflow', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  await controller.markSubmitStarted('exact-timeout')
  now = 2_100
  assert.equal((await controller.getSnapshot()).state, 'submit_uncertain')
})

test('state transition logs include previousState and nextState', async () => {
  const logs: Array<{ event: FlowAdmissionLogEvent; payload: Record<string, unknown> }> = []
  const controller = new FlowAdmissionController({
    createJobId: () => 'transition-log',
    log: (event, payload) => logs.push({ event, payload }),
  })
  await controller.requestAdmission(
    { source: 'gen-panel', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  await controller.markSubmitStarted('transition-log')

  const transition = logs.find((entry) => String(entry.event) === 'FLOW_ADMISSION_STATE_TRANSITION' && entry.payload.nextState === 'in_flight')
  assert.equal(transition?.payload.previousState, 'admitted')
  assert.equal(transition?.payload.jobId, 'transition-log')
  assert.equal(transition?.payload.tabId, 9)
  assert.equal(typeof transition?.payload.timestamp, 'number')
})

test('manual reset emits a dedicated lifecycle log', async () => {
  const logs: Array<{ event: FlowAdmissionLogEvent; payload: Record<string, unknown> }> = []
  const controller = new FlowAdmissionController({
    createJobId: () => 'manual-reset-log',
    log: (event, payload) => logs.push({ event, payload }),
  })
  await controller.requestAdmission(
    { source: 'direct-message', tabId: 9, mediaType: 'image' },
    async () => ({
      ...healthy(),
      healthy: false,
      errorCode: 'session_expired',
      statusReason: 'session_expired_warning',
    }),
  )
  await controller.resetBlockedState(true)
  assert.ok(logs.some((entry) => String(entry.event) === 'FLOW_ADMISSION_MANUAL_RESET'))
})

test('storage hydration failure fails closed instead of admitting a new submit', async () => {
  const controller = new FlowAdmissionController({
    createJobId: () => 'storage-failure',
    storage: {
      async load() { throw new Error('storage unavailable') },
      async save() {},
    },
  })
  await assert.rejects(
    controller.requestAdmission(
      { source: 'direct-message', tabId: 9, mediaType: 'image' },
      async () => healthy(),
    ),
    /storage unavailable/,
  )
})

test('valid lifecycle emits checking, admitted, in_flight, and terminal transitions', async () => {
  const transitions: Array<Record<string, unknown>> = []
  const controller = new FlowAdmissionController({
    createJobId: () => 'legal-lifecycle',
    minimumCooldownMs: 0,
    log: (event, payload) => {
      if (event === 'FLOW_ADMISSION_STATE_TRANSITION') transitions.push(payload)
    },
  })
  const admitted = await controller.requestAdmission(
    { source: 'workflow', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  await controller.markSubmitStarted(admitted.job!.jobId)
  await controller.markSubmitConfirmed(admitted.job!.jobId)
  await controller.completeJob(admitted.job!.jobId)
  assert.deepEqual(transitions.map((entry) => [entry.previousState, entry.nextState]), [
    ['idle', 'checking'],
    ['checking', 'admitted'],
    ['admitted', 'in_flight'],
    ['in_flight', 'terminal'],
  ])
})

test('cancelled jobs reject stale submit-started and confirmation callbacks', async () => {
  const controller = new FlowAdmissionController({ createJobId: () => 'cancelled-late-submit', minimumCooldownMs: 0 })
  const admitted = await controller.requestAdmission(
    { source: 'workflow', callerId: 'cancel-race', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  await controller.requestCancellation({ callerId: 'cancel-race' })
  assert.equal(await controller.markSubmitStarted(admitted.job!.jobId), null)
  assert.equal(await controller.markSubmitConfirmed(admitted.job!.jobId), null)
  assert.equal((await controller.getSnapshot()).state, 'idle')
})

test('confirmation winning the cancellation race keeps a confirmed job in flight', async () => {
  const controller = new FlowAdmissionController({ createJobId: () => 'confirm-wins', minimumCooldownMs: 0 })
  const admitted = await controller.requestAdmission(
    { source: 'workflow', callerId: 'confirm-race', tabId: 9, mediaType: 'video' },
    async () => healthy(),
  )
  await controller.markSubmitConfirmed(admitted.job!.jobId)
  const cancellation = await controller.requestCancellation({ callerId: 'confirm-race' })
  assert.equal(cancellation.snapshot.state, 'in_flight')
  assert.equal(cancellation.snapshot.activeJob?.submitConfirmedAt !== undefined, true)
})

test('terminal before safety timeout releases and stale time cannot affect a new job', async () => {
  let now = 10_000
  let id = 0
  const controller = new FlowAdmissionController({
    now: () => now,
    createJobId: () => `terminal-before-${++id}`,
    inFlightSafetyMs: 100,
    minimumCooldownMs: 0,
  })
  const first = await controller.requestAdmission(
    { source: 'workflow', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  await controller.markSubmitStarted(first.job!.jobId)
  now = 10_099
  await controller.completeJob(first.job!.jobId)
  const second = await controller.requestAdmission(
    { source: 'gen-panel', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  now = 10_100
  assert.equal((await controller.getSnapshot()).activeJob?.jobId, second.job?.jobId)
  assert.equal((await controller.getSnapshot()).state, 'admitted')
})

test('timeout-first at the exact boundary becomes uncertain until terminal evidence arrives', async () => {
  let now = 20_000
  const controller = new FlowAdmissionController({
    now: () => now,
    createJobId: () => 'timeout-first-exact',
    inFlightSafetyMs: 100,
    minimumCooldownMs: 0,
  })
  const admitted = await controller.requestAdmission(
    { source: 'workflow', tabId: 9, mediaType: 'video' },
    async () => healthy(),
  )
  await controller.markSubmitStarted(admitted.job!.jobId)
  now = 20_100
  assert.equal((await controller.getSnapshot()).state, 'submit_uncertain')
  assert.equal((await controller.getSnapshot()).activeJob?.errorCode, 'submit_uncertain')
  assert.equal((await controller.completeJob(admitted.job!.jobId)).state, 'idle')
})

test('terminal-first at the exact timeout boundary wins and remains released', async () => {
  let now = 30_000
  const controller = new FlowAdmissionController({
    now: () => now,
    createJobId: () => 'terminal-first-exact',
    inFlightSafetyMs: 100,
    minimumCooldownMs: 0,
  })
  const admitted = await controller.requestAdmission(
    { source: 'workflow', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  await controller.markSubmitStarted(admitted.job!.jobId)
  now = 30_100
  await controller.completeJob(admitted.job!.jobId)
  assert.equal((await controller.getSnapshot()).state, 'idle')
})

test('terminal after safety timeout is the only automatic evidence that releases uncertain state', async () => {
  let now = 40_000
  const controller = new FlowAdmissionController({
    now: () => now,
    createJobId: () => 'terminal-after-timeout',
    inFlightSafetyMs: 100,
    minimumCooldownMs: 0,
  })
  const admitted = await controller.requestAdmission(
    { source: 'workflow', tabId: 9, mediaType: 'video' },
    async () => healthy(),
  )
  await controller.markSubmitStarted(admitted.job!.jobId)
  now = 40_150
  assert.equal((await controller.getSnapshot()).state, 'submit_uncertain')
  const denied = await controller.requestAdmission(
    { source: 'direct-message', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  assert.equal(denied.granted, false)
  assert.equal((await controller.completeJob(admitted.job!.jobId)).state, 'idle')
})

test('manual-reset and terminal race is deterministic in either order', async () => {
  const resetFirst = new FlowAdmissionController({ createJobId: () => 'reset-first', minimumCooldownMs: 0 })
  await resetFirst.requestAdmission(
    { source: 'direct-message', tabId: 9, mediaType: 'image' },
    async () => ({ ...healthy(), healthy: false, errorCode: 'session_expired', statusReason: 'session_expired_warning' }),
  )
  await resetFirst.resetBlockedState(true)
  await resetFirst.completeJob('reset-first')
  assert.equal((await resetFirst.getSnapshot()).lastJob?.state, 'manual_reset')

  const terminalFirst = new FlowAdmissionController({ createJobId: () => 'terminal-first', minimumCooldownMs: 0 })
  const admitted = await terminalFirst.requestAdmission(
    { source: 'workflow', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  await terminalFirst.markSubmitStarted(admitted.job!.jobId)
  await terminalFirst.markSubmitUncertain(admitted.job!.jobId, 'race_uncertain')
  await terminalFirst.completeJob(admitted.job!.jobId)
  await terminalFirst.resetBlockedState(true)
  assert.equal((await terminalFirst.getSnapshot()).lastJob?.state, 'terminal')
})

test('pre-submit lease releases at exactly 45 seconds and never starts cooldown', async () => {
  let now = 50_000
  const controller = new FlowAdmissionController({
    now: () => now,
    createJobId: () => 'lease-exact-45s',
    minimumCooldownMs: 1_000,
  })
  await controller.requestAdmission(
    { source: 'direct-message', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  now = 95_000
  const snapshot = await controller.getSnapshot()
  assert.equal(snapshot.state, 'idle')
  assert.equal(snapshot.lastJob?.state, 'cancelled')
  assert.equal(snapshot.cooldownUntil, 0)
})

test('submit started before 45 seconds disables pre-submit lease release', async () => {
  let now = 60_000
  const controller = new FlowAdmissionController({
    now: () => now,
    createJobId: () => 'submitted-before-lease',
    inFlightSafetyMs: 300_000,
    minimumCooldownMs: 0,
  })
  const admitted = await controller.requestAdmission(
    { source: 'workflow', tabId: 9, mediaType: 'video' },
    async () => healthy(),
  )
  now = 104_999
  await controller.markSubmitStarted(admitted.job!.jobId)
  now = 106_000
  assert.equal((await controller.getSnapshot()).state, 'in_flight')
})

test('MV3 restart preserves admitted lease timestamp and expires it safely', async () => {
  let now = 70_000
  let persisted: FlowAdmissionSnapshot | null = null
  const storage = {
    async load() { return persisted ? JSON.parse(JSON.stringify(persisted)) as FlowAdmissionSnapshot : null },
    async save(snapshot: FlowAdmissionSnapshot) { persisted = JSON.parse(JSON.stringify(snapshot)) as FlowAdmissionSnapshot },
  }
  const first = new FlowAdmissionController({ now: () => now, createJobId: () => 'restart-lease', storage, minimumCooldownMs: 0 })
  await first.requestAdmission(
    { source: 'direct-message', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  now = 115_000
  const restarted = new FlowAdmissionController({ now: () => now, createJobId: () => 'restart-next', storage, minimumCooldownMs: 0 })
  const snapshot = await restarted.getSnapshot()
  assert.equal(snapshot.state, 'idle')
  assert.equal(snapshot.lastJob?.statusReason, 'pre_submit_lease_expired_without_submit')
})

test('MV3 restart before safety timeout preserves submittedAt and later becomes uncertain', async () => {
  let now = 80_000
  let persisted: FlowAdmissionSnapshot | null = null
  const storage = {
    async load() { return persisted ? JSON.parse(JSON.stringify(persisted)) as FlowAdmissionSnapshot : null },
    async save(snapshot: FlowAdmissionSnapshot) { persisted = JSON.parse(JSON.stringify(snapshot)) as FlowAdmissionSnapshot },
  }
  const first = new FlowAdmissionController({
    now: () => now, createJobId: () => 'restart-safety', storage, inFlightSafetyMs: 100, minimumCooldownMs: 0,
  })
  const admitted = await first.requestAdmission(
    { source: 'workflow', tabId: 9, mediaType: 'video' },
    async () => healthy(),
  )
  await first.markSubmitStarted(admitted.job!.jobId)
  now = 80_099
  const restarted = new FlowAdmissionController({
    now: () => now, createJobId: () => 'restart-safety-next', storage, inFlightSafetyMs: 100, minimumCooldownMs: 0,
  })
  assert.equal((await restarted.getSnapshot()).state, 'in_flight')
  now = 80_100
  assert.equal((await restarted.getSnapshot()).state, 'submit_uncertain')
})

test('failed terminal persistence rolls back to the prior in-flight lock', async () => {
  let saveCount = 0
  const events: FlowAdmissionLogEvent[] = []
  const controller = new FlowAdmissionController({
    createJobId: () => 'terminal-persist-failure',
    minimumCooldownMs: 0,
    storage: {
      async load() { return null },
      async save() {
        saveCount++
        if (saveCount === 4) throw new Error('terminal persistence failed')
      },
    },
    log: (event) => events.push(event),
  })
  const admitted = await controller.requestAdmission(
    { source: 'workflow', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  await controller.markSubmitStarted(admitted.job!.jobId)
  await assert.rejects(controller.completeJob(admitted.job!.jobId), /terminal persistence failed/)
  assert.equal((await controller.getSnapshot()).state, 'in_flight')
  assert.equal(events.includes('FLOW_ADMISSION_PERSISTENCE_FAILED'), true)
  assert.equal(events.includes('FLOW_MUTEX_RELEASED'), false)
})

test('failed manual-reset persistence rolls back to blocked', async () => {
  let saveCount = 0
  const controller = new FlowAdmissionController({
    createJobId: () => 'reset-persist-failure',
    minimumCooldownMs: 0,
    storage: {
      async load() { return null },
      async save() {
        saveCount++
        if (saveCount === 3) throw new Error('reset persistence failed')
      },
    },
  })
  await controller.requestAdmission(
    { source: 'direct-message', tabId: 9, mediaType: 'image' },
    async () => ({ ...healthy(), healthy: false, errorCode: 'unusual_activity', statusReason: 'unusual_activity_warning' }),
  )
  await assert.rejects(controller.resetBlockedState(true), /reset persistence failed/)
  assert.equal((await controller.getSnapshot()).state, 'blocked')
})

test('restart between checking and admitted persistence stays fail-closed without dispatch', async () => {
  let persisted: FlowAdmissionSnapshot | null = null
  let saveCount = 0
  const storage = {
    async load() { return persisted ? JSON.parse(JSON.stringify(persisted)) as FlowAdmissionSnapshot : null },
    async save(snapshot: FlowAdmissionSnapshot) {
      saveCount++
      if (saveCount === 2) throw new Error('admitted persistence failed')
      persisted = JSON.parse(JSON.stringify(snapshot)) as FlowAdmissionSnapshot
    },
  }
  const first = new FlowAdmissionController({ createJobId: () => 'between-persistence', storage, minimumCooldownMs: 0 })
  await assert.rejects(first.requestAdmission(
    { source: 'workflow', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  ), /admitted persistence failed/)

  const restarted = new FlowAdmissionController({ createJobId: () => 'restart-denied', storage, minimumCooldownMs: 0 })
  assert.equal((await restarted.getSnapshot()).state, 'checking')
  const duplicate = await restarted.requestAdmission(
    { source: 'gen-panel', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  assert.equal(duplicate.granted, false)
})

test('controller uses lazy timestamp checks and owns no stale cleanup timer', () => {
  const source = String(FlowAdmissionController)
  assert.doesNotMatch(source, /setTimeout|setInterval/)
})

test('pre-submit cancellation and failed health probe do not start generation cooldown', async () => {
  let id = 0
  const controller = new FlowAdmissionController({ createJobId: () => `no-cooldown-${++id}`, minimumCooldownMs: 1_000 })
  const admitted = await controller.requestAdmission(
    { source: 'workflow', callerId: 'no-cooldown-cancel', tabId: 9, mediaType: 'image' },
    async () => healthy(),
  )
  await controller.requestCancellation({ jobId: admitted.job!.jobId })
  assert.equal((await controller.getSnapshot()).cooldownUntil, 0)

  const failed = await controller.requestAdmission(
    { source: 'direct-message', tabId: 9, mediaType: 'image' },
    async () => ({ ...healthy(), healthy: false, errorCode: 'composer_missing', statusReason: 'flow_composer_not_found' }),
  )
  assert.equal(failed.granted, false)
  assert.equal(failed.snapshot.cooldownUntil, 0)
})
