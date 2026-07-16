import assert from 'node:assert/strict'
import test from 'node:test'

import { isGoogleFlowUrl } from '../../src/lib/flow/url.ts'

test('Flow URL accepts default and locale project routes', () => {
  assert.equal(isGoogleFlowUrl('https://labs.google/fx/tools/flow/project/abc'), true)
  assert.equal(isGoogleFlowUrl('https://labs.google/fx/vi/tools/flow/project/abc'), true)
  assert.equal(isGoogleFlowUrl('https://labs.google/fx/en-US/tools/flow'), true)
})

test('Flow URL rejects other labs tools and lookalike hosts', () => {
  assert.equal(isGoogleFlowUrl('https://labs.google/fx/tools/image-fx'), false)
  assert.equal(isGoogleFlowUrl('https://example.com/labs.google/fx/tools/flow'), false)
  assert.equal(isGoogleFlowUrl('http://labs.google/fx/tools/flow'), false)
})
