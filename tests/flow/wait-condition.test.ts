import assert from 'node:assert/strict'
import test from 'node:test'

import { waitForFlowCondition } from '../../src/lib/flow/waitForFlowCondition.ts'

test('selector wait polls until the selector condition is satisfied', async () => {
  let checks = 0
  const result = await waitForFlowCondition({
    condition: 'selector-exists',
    timeoutMs: 500,
    pollIntervalMs: 25,
    check: async () => ({ satisfied: ++checks >= 3, statusReason: 'selector_checked' }),
  })
  assert.equal(result.success, true)
  assert.ok(checks >= 3)
})

test('wait cancellation returns a structured cancelled result and cleans up', async () => {
  const controller = new AbortController()
  const pending = waitForFlowCondition({
    condition: 'provider-idle',
    timeoutMs: 1_000,
    pollIntervalMs: 25,
    signal: controller.signal,
    check: async () => ({ satisfied: false, statusReason: 'provider_busy' }),
  })
  controller.abort('test_cancel')
  const result = await pending
  assert.equal(result.cancelled, true)
  assert.equal(result.timedOut, false)
})

test('unsatisfied wait times out instead of resolving immediately', async () => {
  const result = await waitForFlowCondition({
    condition: 'flow-cooldown-ended',
    timeoutMs: 60,
    pollIntervalMs: 25,
    check: async () => ({ satisfied: false, statusReason: 'cooldown_active' }),
  })
  assert.equal(result.success, false)
  assert.equal(result.timedOut, true)
})
