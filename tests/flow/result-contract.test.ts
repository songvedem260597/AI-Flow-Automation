import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyFlowErrorText, ensureFlowResultContract } from '../../src/lib/flow/resultContract.ts'

test('fixture 9: unusual activity is preserved as a specific error', () => {
  const classified = classifyFlowErrorText('We detected unusual activity. Please try again later.')
  assert.equal(classified?.errorCode, 'unusual_activity')
})

test('fixture 10: partial generation is separate from download outcome', () => {
  const result = ensureFlowResultContract({
    success: true,
    status: 'FLOW_SUBMIT_PARTIAL_SUCCESS',
    generation: { expected: 2, generated: 1, failed: 1, pending: 0, partial: true },
    downloadDetails: { downloadAttempted: false, downloaded: 0, skipped: 1 },
  })
  assert.equal(result.generationOutcome.status, 'partial')
  assert.equal(result.downloadOutcome.status, 'not_requested')
})

test('fixture 11: generation success with download failure remains distinguishable', () => {
  const result = ensureFlowResultContract({
    success: false,
    status: 'AUTO_DOWNLOAD_PARTIAL_FAILURE',
    generation: { expected: 1, generated: 1, failed: 0, pending: 0, partial: false },
    autoDownload: { attempted: true, successCount: 0, failCount: 1 },
  })
  assert.equal(result.generationOutcome.status, 'success')
  assert.equal(result.downloadOutcome.status, 'failed')
})

test('structured result keeps the legacy string error while adding flowError', () => {
  const result = ensureFlowResultContract({ success: false, status: 'BRIDGE_NOT_READY', error: 'bridge unavailable' })
  assert.equal(result.error, 'bridge unavailable')
  assert.equal(result.flowError?.code, 'bridge_unavailable')
})

test('legacy failures map to the complete Phase 1 error taxonomy without losing compatibility', () => {
  const cases = [
    ['HTTP 429 rate limit', 'rate_limited'],
    ['session expired', 'session_expired'],
    ['generation failed', 'generation_failed'],
    ['generation timeout', 'generation_timeout'],
    ['composer not found', 'composer_missing'],
    ['bridge unavailable', 'bridge_unavailable'],
    ['provider busy', 'flow_busy'],
    ['submit_uncertain', 'submit_uncertain'],
    ['download failed', 'download_failed'],
    ['cancelled by caller', 'cancelled'],
    ['opaque provider issue', 'unknown'],
  ] as const

  for (const [message, expected] of cases) {
    const result = ensureFlowResultContract({ success: false, status: message, error: message })
    assert.equal(result.errorCode, expected, message)
    assert.equal(typeof result.error, 'string')
  }
})
