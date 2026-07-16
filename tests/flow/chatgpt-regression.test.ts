import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('ChatGPT background route does not enter Flow Admission Controller', () => {
  const source = read('src/background/index.ts')
  const start = source.indexOf("case 'RUN_CHATGPT_PROMPT':")
  const end = source.indexOf("case 'GET_CHATGPT_JOB_STATUS':", start)
  assert.ok(start >= 0 && end > start)
  const route = source.slice(start, end)
  assert.match(route, /runChatGPTPrompt/)
  assert.doesNotMatch(route, /flowAdmissionController|FLOW_/)
})

test('flowRequestPending wraps only the RUN_FLOW_PROMPT dispatch', () => {
  const runner = read('src/pipeline/runner.ts')
  const chatStart = runner.indexOf('private async runChatGPTGenerate(')
  const flowStart = runner.indexOf('private async runGoogleFlowGenerate(', chatStart)
  const chatSection = runner.slice(chatStart, flowStart)
  assert.match(chatSection, /RUN_CHATGPT_PROMPT/)
  assert.doesNotMatch(chatSection, /flowRequestPending/)

  const pendingStart = runner.indexOf('this.flowRequestPending = true', flowStart)
  const pendingEnd = runner.indexOf('this.flowRequestPending = false', pendingStart)
  assert.ok(pendingStart > flowStart && pendingEnd > pendingStart)
  assert.match(runner.slice(pendingStart, pendingEnd), /RUN_FLOW_PROMPT/)
})

test('stopPipeline clears ChatGPT runner ownership when no Flow request is pending', () => {
  const runner = read('src/pipeline/runner.ts')
  const start = runner.indexOf('export function stopPipeline()')
  const section = runner.slice(start, start + 800)
  assert.match(section, /runner\?\.stop\(\)/)
  assert.match(section, /if \(!runner\?\.hasPendingFlowRequest\(\)\)/)
  assert.match(section, /currentRunner = null/)
})

test('ChatGPT request and result contract retains mediaUploads, focus false, and images', () => {
  const runner = read('src/pipeline/runner.ts')
  const background = read('src/background/index.ts')
  const start = runner.indexOf('private async runChatGPTGenerate(')
  const end = runner.indexOf('private async runGoogleFlowGenerate(', start)
  const section = runner.slice(start, end)
  assert.match(section, /mediaUploads/)
  assert.match(section, /focus: false/)
  assert.match(section, /images/)
  assert.doesNotMatch(section, /flowAdmissionController|FLOW_GET_ADMISSION_SNAPSHOT/)
  assert.match(background, /requestFingerprint/)
})

test('GenPanel reset controls remain Flow-only and do not alter ChatGPT request payload', () => {
  const genPanel = read('src/components/gen/GenPanel.tsx')
  assert.match(genPanel, /activeProvider === 'flow' && flowAdmissionResetReason/)
  const chatStart = genPanel.indexOf("if (activeProvider === 'chatgpt')")
  const chatEnd = genPanel.indexOf('return', genPanel.indexOf("action: 'RUN_CHATGPT_PROMPT'", chatStart))
  const chatSection = genPanel.slice(chatStart, chatEnd)
  assert.match(chatSection, /RUN_CHATGPT_PROMPT/)
  assert.doesNotMatch(chatSection, /FLOW_RESET_ADMISSION|flowAdmissionResetReason/)
})
