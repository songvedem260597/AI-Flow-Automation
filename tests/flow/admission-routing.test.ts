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

test('health probe never classifies warning text from the whole document body', () => {
  const bridge = readSource('src/contents/flow-slate-bridge.ts')
  assert.doesNotMatch(bridge, /document\.body\?\.(?:innerText|textContent)[\s\S]{0,300}classifyFlowErrorText/)
})

test('health probe ignores synthetic wrappers without shadowing real provider tiles', () => {
  const bridge = readSource('src/contents/flow-slate-bridge.ts')
  const scanStart = bridge.indexOf('function scanTiles(): Tile[]')
  const scanEnd = bridge.indexOf('function detectNewTiles(', scanStart)
  const scanner = bridge.slice(scanStart, scanEnd)
  const wrapperSkip = scanner.indexOf("if (!id && el.querySelector('[data-tile-id], [data-gen-tile]')) return")
  const processedRegistration = scanner.indexOf('processedElements.add(el)')

  assert.ok(scanStart >= 0)
  assert.ok(scanEnd > scanStart)
  assert.ok(wrapperSkip >= 0)
  assert.ok(processedRegistration > wrapperSkip)
  assert.match(scanner, /\[data-tile-id\], \[data-gen-tile\], \[class\*="tile"\]/)
  assert.match(scanner, /providerIdentity: providerIdentity/)
})

test('manual reset UI has an in-progress guard against double-clicks', () => {
  const genPanel = readSource('src/components/gen/GenPanel.tsx')
  assert.match(genPanel, /flowAdmissionResetting/)
  assert.match(genPanel, /disabled=\{flowAdmissionResetting\}/)
})

test('workflow blocked results include safe manual-reset guidance', () => {
  const runner = readSource('src/pipeline/runner.ts')
  assert.match(runner, /reset admission only after confirming no generation is active/)
})

test('ChatGPT provider-idle wait uses ChatGPT job status, not Flow admission state', () => {
  const runner = readSource('src/pipeline/runner.ts')
  assert.match(runner, /waitContext\.provider === 'chatgpt'/)
  assert.match(runner, /action: 'GET_CHATGPT_JOB_STATUS'/)
  assert.match(runner, /action: 'FLOW_GET_ADMISSION_SNAPSHOT'/)
})
