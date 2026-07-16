import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readSource = (relativePath: string): string =>
  readFileSync(relativePath, 'utf8')

test('direct RUN_FLOW_PROMPT messages reach the background admission gate before content dispatch', () => {
  const source = readSource('src/background/index.ts')
  assert.match(source, /case 'RUN_FLOW_PROMPT':\s*return runFlowPrompt/)

  const handlerStart = source.indexOf('async function runFlowPrompt(')
  const gate = source.indexOf('flowAdmissionController.requestAdmission(', handlerStart)
  const contentDispatch = source.indexOf("action: 'RUN_FLOW_PROMPT'", gate)
  assert.ok(handlerStart >= 0)
  assert.ok(gate > handlerStart)
  assert.ok(contentDispatch > gate)
})

test('content and provider direct-submit paths fail closed without background admission', () => {
  const content = readSource('src/contents/flow-content.ts')
  const provider = readSource('src/providers/googleFlow.ts')
  const bridge = readSource('src/contents/flow-slate-bridge.ts')

  assert.match(content, /missing_flow_admission_job_id/)
  assert.match(provider, /FLOW_DIRECT_CLICK_BLOCKED_USE_RUN_FLOW_PROMPT/)
  assert.match(bridge, /MAIN-world direct submit is disabled/)
  assert.match(bridge, /__flowTestSubmit[\s\S]*FLOW_ADMISSION_REQUIRED/)
})

test('pipeline stop keeps ownership only while a Google Flow request is pending', () => {
  const runner = readSource('src/pipeline/runner.ts')
  assert.match(runner, /if \(this\.flowRequestPending\) \{[\s\S]*action: 'FLOW_CANCEL_ADMISSION'/)
  assert.match(runner, /if \(!runner\?\.hasPendingFlowRequest\(\)\) \{[\s\S]*currentRunner = null/)
})
