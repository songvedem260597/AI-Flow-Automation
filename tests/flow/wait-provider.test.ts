import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectChatGPTWaitJobIds,
  isChatGPTJobIdle,
  resolveProviderWaitTarget,
} from '../../src/lib/flow/waitProvider.ts'

test('provider-idle resolves ChatGPT from upstream output instead of querying Flow', () => {
  const upstream = [{ type: 'generation', provider: 'chatgpt', jobId: 'chat-job-1' }]
  assert.equal(resolveProviderWaitTarget(undefined, upstream), 'chatgpt')
  assert.deepEqual(collectChatGPTWaitJobIds(upstream), ['chat-job-1'])
})

test('explicit wait provider overrides mixed upstream outputs', () => {
  assert.equal(resolveProviderWaitTarget('google_flow', [
    { provider: 'chatgpt', jobId: 'chat-job-1' },
  ]), 'google-flow')
})

test('provider-idle defaults to Google Flow for legacy Wait nodes', () => {
  assert.equal(resolveProviderWaitTarget(undefined, []), 'google-flow')
})

test('ChatGPT running is busy while done and failed are idle terminal states', () => {
  assert.equal(isChatGPTJobIdle('running'), false)
  assert.equal(isChatGPTJobIdle('done'), true)
  assert.equal(isChatGPTJobIdle('failed'), true)
})
