import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyFlowAdmissionWarningContexts,
  countFlowTileActivity,
  isFlowQueueStatusText,
} from '../../src/lib/flow/healthClassifier.ts'

test('composer prompt text cannot become an admission warning', () => {
  const result = classifyFlowAdmissionWarningContexts([{
    kind: 'composer',
    selector: '[contenteditable="true"]',
    text: 'Write a story containing the phrase unusual activity.',
  }])
  assert.equal(result, null)
})

test('document body text is never a warning context', () => {
  const result = classifyFlowAdmissionWarningContexts([{
    kind: 'body',
    selector: 'body',
    text: 'Session expired. Please sign in to continue.',
  }])
  assert.equal(result, null)
})

test('visible English dialog unusual-activity warning is classified', () => {
  const result = classifyFlowAdmissionWarningContexts([{
    kind: 'dialog',
    selector: '[role="dialog"]',
    text: 'We noticed unusual activity. Try again later.',
  }])
  assert.equal(result?.errorCode, 'unusual_activity')
  assert.equal(result?.selector, '[role="dialog"]')
})

test('visible Vietnamese session warning is classified', () => {
  const result = classifyFlowAdmissionWarningContexts([{
    kind: 'alert',
    selector: '[role="alert"]',
    text: 'Phiên đã hết hạn. Vui lòng đăng nhập để tiếp tục.',
  }])
  assert.equal(result?.errorCode, 'session_expired')
})

test('visible Vietnamese rate-limit status is classified', () => {
  const result = classifyFlowAdmissionWarningContexts([{
    kind: 'status',
    selector: '[aria-live="assertive"]',
    text: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.',
  }])
  assert.equal(result?.errorCode, 'rate_limited')
})

test('historical tile generation failure is not a provider-wide blocker', () => {
  const result = classifyFlowAdmissionWarningContexts([{
    kind: 'tile',
    selector: '[data-tile-id="old"]',
    text: 'Generation failed. Retry.',
  }])
  assert.equal(result, null)
})

test('generation-failed toast does not become an account/session/rate blocker', () => {
  const result = classifyFlowAdmissionWarningContexts([{
    kind: 'toast',
    selector: '[data-sonner-toast]',
    text: 'Generation failed. Retry.',
  }])
  assert.equal(result, null)
})

test('health activity counters preserve processing, pending, and generating', () => {
  assert.deepEqual(countFlowTileActivity([
    { status: 'generating', progress: 42, statusReason: 'progress_percent' },
    { status: 'unknown', progress: 0, statusReason: 'queued_pending' },
    { status: 'done', progress: 0, statusReason: 'media_success' },
  ]), {
    processing: 1,
    pending: 1,
    generating: 1,
  })
})

test('explicit English and Vietnamese queue labels are pending signals', () => {
  assert.equal(isFlowQueueStatusText('In queue'), true)
  assert.equal(isFlowQueueStatusText('Waiting in the queue…'), true)
  assert.equal(isFlowQueueStatusText('Hiện đang trong hàng đợi'), true)
  assert.equal(isFlowQueueStatusText('Đang chờ'), true)
  assert.equal(isFlowQueueStatusText('Create a scene about waiting in the queue'), false)
})
