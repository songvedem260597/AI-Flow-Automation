/**
 * Flow Content Script — ISOLATED world on https://labs.google/*
 * Receives RUN_FLOW_PROMPT from background, delegates to bridge (MAIN world).
 * Also exposes __flowDebugScan for DOM inspection from page console.
 */
const SOURCE = 'flow-auto-slate'
const RESULT_SOURCE = SOURCE + '-result'

// ── Safe sendMessage helpers (extension context invalidated resilience) ──────
// After chrome.runtime.reload() the old content script bundle keeps running
// in the page. Subsequent chrome.runtime.sendMessage calls throw
// "Extension context invalidated". These helpers silently skip those
// scenarios and tag errors so the polling loops can exit instead of
// retrying forever.
const CTX_INVALIDATED = 'Extension context invalidated'

function _isContextInvalidatedMsg(msg: string): boolean {
  return typeof msg === 'string' && msg.includes(CTX_INVALIDATED)
}

function safeRuntimeContext(): boolean {
  try {
    if (!chrome?.runtime?.id) return false
    if (typeof chrome.runtime.connect !== 'function') return false
    const port = chrome.runtime.connect({ name: '__ai_flow_ctx_probe__' })
    try { port.disconnect() } catch {}
    return true
  } catch {
    return Boolean(chrome?.runtime?.id)
  }
}

function safeSendFireAndForget(message: unknown): void {
  try {
    if (!safeRuntimeContext()) return
    chrome.runtime.sendMessage(message, () => {
      // Drain lastError so Chrome doesn't keep logging the rejected reply.
      void chrome.runtime.lastError
    })
  } catch {
    // silent — context invalid or message channel gone
  }
}

async function safeSendAwait(message: unknown): Promise<{ ok: boolean; response?: unknown; error?: string }> {
  if (!safeRuntimeContext()) {
    return { ok: false, error: 'context_invalidated' }
  }
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError
        if (err) {
          if (_isContextInvalidatedMsg(err.message || '')) {
            resolve({ ok: false, error: 'context_invalidated' })
          } else {
            resolve({ ok: false, error: err.message || 'sendMessage error' })
          }
          return
        }
        resolve({ ok: true, response })
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (_isContextInvalidatedMsg(msg)) {
        resolve({ ok: false, error: 'context_invalidated' })
      } else {
        resolve({ ok: false, error: msg })
      }
    }
  })
}

let _pendingRequests = new Map<number, { resolve: (v: unknown) => void; timeout: ReturnType<typeof setTimeout> }>()
let _requestId = 0

// ── PostMessage Bridge ───────────────────────────────────────────────────────

function bridgeCall(action: string, data: Record<string, unknown> = {}, timeoutMs = 15000): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const rid = ++_requestId
    const timeout = setTimeout(() => {
      _pendingRequests.delete(rid)
      resolve({ success: false, error: `Bridge timeout for action: ${action}` })
    }, timeoutMs)
    _pendingRequests.set(rid, { resolve, timeout })
    window.postMessage({ source: SOURCE, action, requestId: rid, ...data }, window.location.origin)
  })
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return
  const d = e.data as Record<string, unknown>
  if (!d || (d.source as string) !== RESULT_SOURCE) return

  const rid = d.requestId as number
  if (rid == null) return

  const pending = _pendingRequests.get(rid)
  if (!pending) return

  clearTimeout(pending.timeout)
  _pendingRequests.delete(rid)
  pending.resolve(d)
})

function isBridgeLoaded(): boolean {
  return !!(window as unknown as Record<string, unknown>).__flowSlateBridgeCleanup
}

async function waitBridgeReady(timeoutMs = 10000): Promise<{ ready: boolean; error?: string }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await bridgeCall('ping', {}, 3000)
      if ((result as Record<string, unknown>).ready) {
        console.log('[FlowContent] Bridge ready after', Date.now() - start, 'ms')
        return { ready: true }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500))
  }
  console.debug('[FlowContent] Bridge not ready after', timeoutMs, 'ms')
  return {
    ready: false,
    error: 'Slate bridge not loaded in MAIN world after ' + timeoutMs + 'ms. Try reloading the Flow tab.'
  }
}

// ── DOM Debug Scan (ISOLATED world — no React fiber access) ─────────────────

function getEditableCandidates() {
  const results: Array<Record<string, unknown>> = []
  const selectors = [
    '[contenteditable="true"]',
    '[role="textbox"]',
    '[role="combobox"]',
    'textarea',
    'input[type="text"]',
    'input:not([type])'
  ]
  const seen = new Set<Element>()

  selectors.forEach((sel) => {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        if (seen.has(el)) return
        seen.add(el)
        results.push({
          selector: sel,
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          placeholder: el.getAttribute('placeholder') || '',
          'aria-label': el.getAttribute('aria-label') || '',
          className: (el.className || '').toString().substring(0, 120),
          textContent: (el.textContent || '').trim().substring(0, 80),
          outerHTML: el.outerHTML.substring(0, 400),
        })
      })
    } catch (_) {}
  })

  return results
}

function getButtons() {
  const results: Array<Record<string, unknown>> = []
  const seen = new Set<Element>()

  document.querySelectorAll('button, [role="button"], div[aria-disabled="false"]').forEach((el, i) => {
    if (seen.has(el)) return
    seen.add(el)
    const svg = el.querySelector('svg')
    const pathD = svg ? (svg.querySelector('path')?.getAttribute('d') || '') : ''
    const rect = (() => { try { return el.getBoundingClientRect() } catch (_) { return null } })()

    results.push({
      index: i,
      tag: el.tagName,
      text: (el.textContent || '').trim().substring(0, 80),
      'aria-label': el.getAttribute('aria-label') || '',
      'data-testid': el.getAttribute('data-testid') || '',
      className: (el.className || '').toString().substring(0, 120),
      disabled: (el as HTMLButtonElement).disabled,
      svgPath: pathD.substring(0, 80),
      rect: rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) } : null,
      outerHTML: el.outerHTML.substring(0, 300),
    })
  })

  return results
}

function getPromptAreaCandidates() {
  const results: Array<Record<string, unknown>> = []

  // Scan for text content "Bạn muốn tạo"
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false)
    let node: Text | null = null
    while ((node = walker.nextNode() as Text | null)) {
      const txt = (node.textContent || '').trim()
      if (txt.includes('Bạn muốn tạo') || txt.includes('muốn tạo gì') || txt.includes('prompt')) {
        let parent: Element | null = node.parentElement
        for (let i = 0; i < 5 && parent; i++, parent = parent.parentElement) {
          const rfKey = Object.keys(parent).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactProps'))
          results.push({
            matchedText: txt.substring(0, 60),
            tag: parent.tagName,
            parentDepth: i,
            className: (parent.className || '').toString().substring(0, 120),
            'aria-label': parent.getAttribute('aria-label') || '',
            placeholder: parent.getAttribute('placeholder') || '',
            hasReactFiber: !!rfKey,
            outerHTML: parent.outerHTML.substring(0, 400),
          })
        }
      }
    }
  } catch (_) {}

  return results
}

// ── Expose Global Debug ─────────────────────────────────────────────────────

;(window as unknown as Record<string, unknown>).__flowDebugScan = function () {
  const report = {
    url: window.location.href,
    timestamp: Date.now(),
    editableCandidates: getEditableCandidates(),
    buttons: getButtons(),
    promptAreaMatches: getPromptAreaCandidates(),
    bodyHTML: document.body.innerHTML.substring(0, 500),
  }

  if (!FLOW_DEBUG_VERBOSE) {
    console.log('=== __flowDebugScan ===')
    console.log('( FLOW_DEBUG_VERBOSE=false — skipping verbose output )')
    console.log('URL:', report.url)
    console.log('editableCandidates:', report.editableCandidates.length)
    console.log('buttons:', report.buttons.length)
    console.log('promptAreaMatches:', report.promptAreaMatches.length)
    console.log('=== END ===')
    return report
  }
  console.log('=== __flowDebugScan ===')
  console.log('URL:', report.url)
  console.log('editableCandidates:', report.editableCandidates.length)
  report.editableCandidates.slice(0, 20).forEach((c: Record<string, unknown>, i: number) => {
    console.log(`  [${i}] ${c.tag} class="${c.className}" placeholder="${c.placeholder}" aria-label="${c['aria-label']}"`)
    console.log(`       text="${c.textContent}"`)
  })
  console.log('buttons:', report.buttons.length)
  report.buttons.slice(0, 20).forEach((b: Record<string, unknown>, i: number) => {
    console.log(`  [${i}] ${b.tag} text="${b.text}" dt=${b['data-testid']} dis=${b.disabled} rect=(${b.rect})`)
    if ((b.svgPath as string).length > 0) console.log(`       svg="${(b.svgPath as string).substring(0, 50)}"`)
  })
  console.log('promptAreaMatches:', report.promptAreaMatches.length)
  report.promptAreaMatches.slice(0, 5).forEach((p: Record<string, unknown>, i: number) => {
    console.log(`  [${i}] "${p.matchedText}" → ${p.tag} depth=${p.parentDepth} class="${p.className}"`)
  })
  console.log('=== END ===')
  return report
}

console.log('[FlowContent] Loaded on', window.location.href, '| bridge in MAIN world')

// ── Debug flags ────────────────────────────────────────────────────────────────
// Enable with: localStorage.setItem('FLOW_DEBUG_VERBOSE', '1')
var FLOW_DEBUG_VERBOSE =
  localStorage.getItem('FLOW_DEBUG_VERBOSE') === '1' ||
  (window as Record<string, unknown>).__FLOW_DEBUG_VERBOSE__ === true

var FLOW_DEBUG_SETTINGS =
  localStorage.getItem('FLOW_DEBUG_SETTINGS') === '1'

function flowDebug() {
  var args = []
  for (var _i = 0; _i < arguments.length; _i++) {
    args[_i] = arguments[_i]
  }
  if (FLOW_DEBUG_VERBOSE) console.log.apply(console, args)
}

function settingsDebug() {
  var args = []
  for (var _i = 0; _i < arguments.length; _i++) {
    args[_i] = arguments[_i]
  }
  if (FLOW_DEBUG_SETTINGS) console.log.apply(console, args)
}

// ── FlowTrace — always-on structured trace logs ─────────────────────────────
// Production trace for diagnosing failures. Always visible in console, not
// gated by debug flags. Use [FlowTrace] prefix for grep-ability.
function flowTrace(scope: string, event: string, data?: Record<string, unknown> | string | unknown) {
  var payload: unknown
  if (data === undefined) {
    payload = ''
  } else if (typeof data === 'string') {
    payload = data
  } else {
    try {
      payload = JSON.stringify(data)
    } catch (_) {
      payload = String(data)
    }
  }
  console.log('[FlowTrace][' + scope + '] ' + event + ' ' + payload)
}

function flowTraceFail(step: string, reason: string, extra: Record<string, unknown> = {}) {
  var failRecord = {
    step: step,
    reason: reason,
    rawResult: extra.rawResult,
    normalized: extra.normalized,
    payloadSummary: extra.payloadSummary,
    fallback: extra.fallback,
    extra: extra.extra,
    timestamp: Date.now(),
  }
  ;(window as unknown as Record<string, unknown>).__lastFlowTraceFail = failRecord
  console.error('[FlowTrace][Fail]', JSON.stringify(failRecord))
}

// ── Debug Run Flow Prompt ────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// Normalize a Flow-side URL to an absolute https://labs.google/...
// URL when possible. Flow's <img> / <video> elements frequently expose
// `src="/fx/api/trpc/media.getMediaUrlRedirect?name=..."` — a path-
// relative URL that ONLY resolves inside the Flow tab's origin. When
// the workflow runner forwards that URL to a downstream node and the
// node tries to fetch it from the extension / side panel context, the
// browser resolves it against `chrome-extension://...` and reports
// `ERR_FILE_NOT_FOUND`. We always normalize the URL the moment the
// asset crosses the bridge boundary, AND defensively normalize again
// when shipping the asset to the runner so legacy callers that somehow
// already saw a relative URL do not regress.
//
// Rules:
//   blob:           — keep as-is (already absolute within the page)
//   data:           — keep as-is (data URL is self-contained)
//   http(s)://      — keep as-is
//   protocol-relative `//foo` — prepend `https:`
//   path-relative `/foo`       — resolve against `location.origin`
//   anything else  — keep as-is
function toAbsoluteFlowUrl(value: unknown, origin?: string): string {
  if (typeof value !== 'string') return ''
  var v = value.trim()
  if (!v) return ''
  if (
    v.indexOf('blob:') === 0 ||
    v.indexOf('data:') === 0 ||
    v.indexOf('http://') === 0 ||
    v.indexOf('https://') === 0
  ) {
    return v
  }
  if (v.indexOf('//') === 0) {
    return 'https:' + v
  }
  if (v.indexOf('/') === 0) {
    try {
      var base = origin || (typeof location !== 'undefined' && location && location.origin) || ''
      if (!base) return v
      return new URL(v, base).href
    } catch (_) {
      return v
    }
  }
  return v
}

// Page origin (e.g. https://labs.google). Captured once at file load
// so every output asset can be tagged with the origin it came from.
// The runner can use this to repair relative URLs that somehow slip
// through the bridge normalization.
var FLOW_PROVIDER_ORIGIN: string = (typeof location !== 'undefined' && location && location.origin) || ''
var FLOW_SOURCE_PAGE_URL: string = (typeof location !== 'undefined' && location && location.href) || ''

/**
 * Build a sanitized download filename from prompt text.
 * Converts Vietnamese diacritics to ASCII, strips special chars.
 */
function buildDownloadFilename(
  promptText: string,
  index: number,
  taskName: string,
  resolution: string
): string {
  var date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  // Strip Vietnamese diacritics
  var slug = promptText
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, function (c) { return c === 'đ' ? 'd' : 'D' })
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .substring(0, 40)
  if (!slug) slug = 'flow'

  var idx = String(index).padStart(3, '0')
  var base = date + '_' + slug + '_' + idx
  return base + '_' + resolution
}

// Dedupe tile snapshots by identity (fileName > id). Used because Flow
// often paints each tile as multiple nested DOM nodes that all match the
// broad selectors in the bridge's scanTiles. Even after the bridge dedupes,
// we re-dedupe here as a safety net so the orchestrator never makes
// duplicate download calls.
function dedupeTilesByIdentity(tileList): any[] {
  var seen = new Set<string>()
  var out: any[] = []
  for (var di = 0; di < tileList.length; di++) {
    var t = tileList[di]
    var key = (t.fileName && t.fileName.length > 0 ? t.fileName : '') || (t.id || '')
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

// Pick up to `expectedQuantity` tiles from a unique list.
// Preserves DOM order (newest result lands at the END of the order list).
// slice(-N) returns the LAST N entries = the most recently rendered tiles.
function pickExpectedUniqueResultTiles(tiles: any[], expectedQuantity: number): any[] {
  var unique = dedupeTilesByIdentity(tiles)
  if (unique.length <= expectedQuantity) return unique
  return unique.slice(-expectedQuantity)
}

async function debugRunFlowPrompt(prompt: string): Promise<Record<string, unknown>> {
  if (FLOW_DEBUG_VERBOSE) console.log('[FlowContent] debugRunFlowPrompt START, prompt len:', prompt.length)

  const readyCheck = await waitBridgeReady()
  if (!readyCheck.ready) {
    return { success: false, bridgeReady: false, error: readyCheck.error, url: window.location.href }
  }

  // Step 1: Clear
  if (FLOW_DEBUG_VERBOSE) console.log('[FlowContent] [1/4] clear...')
  const clearResult = await bridgeCall('clear')
  if (FLOW_DEBUG_VERBOSE) console.log('[FlowContent] [1/4] clear result:', JSON.stringify(clearResult))
  await new Promise(r => setTimeout(r, 400))

  // Step 2: Insert
  if (FLOW_DEBUG_VERBOSE) console.log('[FlowContent] [2/4] insert...')
  const insertResult = await bridgeCall('insert', { text: prompt })
  if (FLOW_DEBUG_VERBOSE) console.log('[FlowContent] [2/4] insert result:', JSON.stringify(insertResult))
  await new Promise(r => setTimeout(r, 400))

  // Step 3: Submit
  if (FLOW_DEBUG_VERBOSE) console.log('[FlowContent] [3/4] submit...')
  const submitResult = await bridgeCall('submit')
  if (FLOW_DEBUG_VERBOSE) console.log('[FlowContent] [3/4] submit result:', JSON.stringify(submitResult))

  // Step 4: Return summary
  if (FLOW_DEBUG_VERBOSE) console.log('[FlowContent] [4/4] done')
  return {
    success: insertResult.success && submitResult.success,
    bridgeReady: true,
    clearSuccess: !!clearResult.success,
    insertSuccess: !!insertResult.success,
    submitSuccess: !!submitResult.success,
    insertMethod: (insertResult as Record<string, unknown>).method || '',
    submitMethod: (submitResult as Record<string, unknown>).method || '',
    insertStrategy: (insertResult as Record<string, unknown>).strategy || '',
    submitButtonText: (submitResult as Record<string, unknown>).buttonText || '',
    insertError: (insertResult as Record<string, unknown>).error || '',
    submitError: (submitResult as Record<string, unknown>).error || '',
  }
}

;(window as unknown as Record<string, unknown>).debugRunFlowPrompt = debugRunFlowPrompt

// ── Run Flow Prompt Pipeline ─────────────────────────────────────────────────

// Fallback: DOM-first Google Flow insert path.
//
// The Slate editor object is not always reachable through React fiber on
// the current Flow composer (slateEditorFound=false), but the DOM
// contenteditable IS mounted and `document.execCommand('insertText')` DOES
// drive Flow's onChange. When the Slate `insert` action fails, this helper
// invokes the new `insertGoogleFlowPromptOnly` bridge action which uses a
// selector-first editor discovery + execCommand.
//
// IMPORTANT: this is insert-only. It does NOT click Tạo — the submit
// step is a separate boundary so the auto-download polling loop in
// runFlowPrompt() can still capture a pre-submit tile snapshot. The
// normal Step 6 (verify) → Step 7 (pre-submit baseline + submit) →
// Step 8 (auto-download) pipeline continues unchanged after this
// fallback succeeds.
async function runFlowPromptInsertGoogleFlowFallback(
  payload: Record<string, unknown>
): Promise<{ success: boolean; status: string; error?: string; insertResult?: Record<string, unknown> }> {
  console.warn('[FlowContent] Falling back to insertGoogleFlowPromptOnly (DOM-first insert only)', JSON.stringify({
    fallbackReason: 'slate_insert_failed',
  }))
  notifyStatus('FLOW_GFLOW_INSERT_FALLBACK')

  const gflowInsert = await bridgeCall('insertGoogleFlowPromptOnly', { text: payload.prompt as string }, 15000)
  const gflowOk = !!(gflowInsert as Record<string, unknown>).success
  if (!gflowOk) {
    const reason = String((gflowInsert as Record<string, unknown>).error || 'unknown')
    return {
      success: false,
      status: 'FLOW_INSERT_FAILED',
      error: 'Slate insert failed AND DOM-first insert fallback failed: ' + reason,
    }
  }

  // Synthesize an insertResult in the same shape the Slate path returns,
  // so the rest of runFlowPrompt() (verify, pre-submit baseline, submit,
  // auto-download) can continue uninterrupted.
  return {
    success: true,
    status: 'FLOW_INSERT_SUCCESS',
    insertResult: {
      success: true,
      method: String((gflowInsert as Record<string, unknown>).method || 'gflow-dom-insert'),
      strategy: 'gflow-dom-fallback',
      error: '',
    },
  }
}

// Fallback: DOM-first Google Flow submit path (button click only).
//
// Invoked when the standard Slate `submit` action fails. Locates the
// Tạo button and clicks it. The prompt is assumed to already be
// inserted (Slate path or DOM-first insert fallback).
async function runFlowPromptSubmitGoogleFlowFallback(): Promise<{ success: boolean; submitResult: Record<string, unknown> }> {
  console.warn('[FlowContent] Falling back to submitGoogleFlowButtonOnly (DOM-first click only)', JSON.stringify({
    fallbackReason: 'slate_submit_failed',
  }))
  notifyStatus('FLOW_GFLOW_SUBMIT_FALLBACK')

  const gflowButton = await bridgeCall('submitGoogleFlowButtonOnly', {}, 15000)
  const gflowOk = !!(gflowButton as Record<string, unknown>).success
  if (!gflowOk) {
    const reason = String((gflowButton as Record<string, unknown>).error || 'unknown')
    return {
      success: false,
      submitResult: {
        success: false,
        method: 'gflow-dom-click',
        buttonText: '',
        error: 'Slate submit failed AND DOM-first submit fallback failed: ' + reason,
      },
    }
  }
  return {
    success: true,
    submitResult: {
      success: true,
      method: String((gflowButton as Record<string, unknown>).method || 'gflow-dom-click'),
      buttonText: '',
      error: '',
    },
  }
}

async function runFlowPrompt(payload: {
  prompt: string
  mode: 'image' | 'video'
  model: string
  aspectRatio: string
  quantity: number
  duration?: string
  style: string | null
  // fileIds: stable reference IDs (tileId from existing Flow images)
  fileIds: string[]
  // fileNameMap: maps fileId → display name for fallback lookup
  fileNameMap: Record<string, string>
  // frameFileIds: only for Video Frames mode. fileIds must be empty for Frames path.
  frameFileIds?: { frame1?: string; frame2?: string }
  // pendingFiles: REMOVED — files are resolved to tileIds before reaching FlowContent
  autoDownload: boolean
  outputFolder: string
  resolution: string
  videoResolution?: string
  focusTab?: boolean
}): Promise<Record<string, unknown>> {
  console.log('[FlowContent] runFlowPrompt START, mode=' + payload.mode + ', prompt len:', payload.prompt?.length)

  // ── FlowTrace: payload summary ──────────────────────────────────────
  var payloadSummary = {
    mode: payload.mode,
    model: payload.model,
    aspectRatio: payload.aspectRatio,
    quantity: payload.quantity,
    duration: payload.duration || '',
    autoDownload: !!payload.autoDownload,
    outputFolder: payload.outputFolder || '',
    resolution: payload.resolution || '',
    videoResolution: payload.videoResolution || '',
    fileIdsCount: (payload.fileIds || []).length,
    frameFileIds: payload.frameFileIds ? { hasFrame1: !!payload.frameFileIds.frame1, hasFrame2: !!payload.frameFileIds.frame2 } : null,
    flowVideoMode: payload.flowVideoMode || null,
    focusTab: !!payload.focusTab,
    promptLen: payload.prompt?.length || 0,
    url: window.location.href,
  }
  flowTrace('Content', 'RUN_FLOW_PROMPT_START', payloadSummary)

  // Wait for bridge to be ready (polls every 500ms, up to 10s)
  flowTrace('Content', 'BRIDGE_WAIT_START', { timeoutMs: 10000 })
  const readyCheck = await waitBridgeReady()
  if (!readyCheck.ready) {
    flowTraceFail('waitBridgeReady', 'BRIDGE_NOT_READY', {
      rawResult: readyCheck,
      payloadSummary: payloadSummary,
    })
    return {
      success: false,
      status: 'BRIDGE_NOT_READY',
      bridgeReady: false,
      error: readyCheck.error,
      url: window.location.href,
      hint: 'Reload the Flow tab and try again.',
    }
  }
  flowTrace('Content', 'BRIDGE_WAIT_DONE', { ready: true })

  // Step 1-2: Apply settings from Gen tab payload (NEVER skip in normal runs)
  // FlowTrace: explicit APPLY_SETTINGS_START (single, predictable key for grep)
  console.log('[FlowTrace][Content] APPLY_SETTINGS_START', JSON.stringify({
    mode: payload.mode,
    model: payload.model,
    ratio: payload.aspectRatio,
    quantity: payload.quantity,
    duration: payload.duration || '',
    flowVideoMode: payload.flowVideoMode || null,
    autoDownload: !!payload.autoDownload,
    outputFolder: payload.outputFolder || '',
    fileIdsCount: (payload.fileIds || []).length,
    promptLen: payload.prompt?.length || 0,
    url: window.location.href,
    flag_DISABLE_settings_automation_is_debug_only: true,
  }))
  flowTrace('Content', 'STEP_1_2_APPLY_SETTINGS_START', {
    target: { mode: payload.mode, model: payload.model, aspectRatio: payload.aspectRatio, quantity: payload.quantity, duration: payload.duration || '', flowVideoMode: payload.flowVideoMode || null },
  })
  let settingsResult: Record<string, unknown>
  try {
    settingsResult = await bridgeCall('applySettings', { payload })
  } catch (err) {
    console.error('[FlowContent] Step 1-2 apply settings THREW:', {
      message: (err as Error)?.message,
      stack: (err as Error)?.stack,
    })
    flowTraceFail('applySettings', 'FLOW_APPLY_SETTINGS_EXCEPTION', {
      rawResult: { message: (err as Error)?.message },
      payloadSummary: payloadSummary,
    })
    // Soft-fail policy: do NOT abort the pipeline. Settings automation is
    // currently gated by ENABLE_FLOW_SETTINGS_AUTOMATION=false in the
    // bridge, so this path is expected to fail in production. Continue
    // with insert/submit using the Flow page's current state.
    settingsResult = { success: false, error: 'FLOW_APPLY_SETTINGS_EXCEPTION', errorMessage: (err as Error)?.message, softFailed: true }
  }
  // FlowTrace: explicit APPLY_SETTINGS_RAW_RESULT (single, predictable key for grep)
  console.log('[FlowTrace][Content] APPLY_SETTINGS_RAW_RESULT', JSON.stringify({
    success: !!(settingsResult as Record<string, unknown>)?.success,
    error: (settingsResult as Record<string, unknown>)?.error || '',
    method: (settingsResult as Record<string, unknown>)?.method || '',
    hasDetails: !!(settingsResult as Record<string, unknown>)?.details,
  }))
  flowTrace('Content', 'STEP_1_2_APPLY_SETTINGS_RAW', settingsResult)
  if (!settingsResult?.success) {
    const settingsError = String((settingsResult as Record<string, unknown>)?.error || 'FLOW_APPLY_SETTINGS_FAILED')
    console.error('[FlowTrace][Fail]', JSON.stringify({
      step: 'applySettings',
      reason: settingsError,
      rawResult: settingsResult,
      payloadSummary: {
        mode: payload.mode,
        model: payload.model,
        ratio: payload.aspectRatio,
        quantity: payload.quantity,
        autoDownload: payload.autoDownload,
      },
    }))
    // Detect specific failure category for [FlowTrace][Fail] classification
    var settingsReason = 'FLOW_APPLY_SETTINGS_FAILED'
    if (settingsError.includes('FLOW_MODEL_MISSING')) settingsReason = 'FLOW_SETTINGS_MODEL_MISSING'
    else if (settingsError.includes('FLOW_MODEL_OPTION_NOT_FOUND')) settingsReason = 'FLOW_SETTINGS_MODEL_OPTION_NOT_FOUND'
    else if (settingsError.includes('FLOW_MODEL_DROPDOWN_NOT_FOUND')) settingsReason = 'FLOW_SETTINGS_MODEL_DROPDOWN_NOT_FOUND'
    else if (settingsError.includes('FLOW_MODEL_MENU_NOT_FOUND')) settingsReason = 'FLOW_SETTINGS_MODEL_MENU_NOT_FOUND'
    else if (settingsError.includes('FLOW_SETTINGS_BUTTON_NOT_FOUND')) settingsReason = 'FLOW_SETTINGS_BUTTON_NOT_FOUND'
    else if (settingsError.includes('FLOW_SETTINGS_PANEL_NOT_FOUND')) settingsReason = 'FLOW_SETTINGS_PANEL_NOT_FOUND'
    else if (settingsError.includes('FLOW_SETTINGS_VERIFY_MISMATCH')) settingsReason = 'FLOW_SETTINGS_VERIFY_MISMATCH'
    else if (settingsError.includes('FLOW_EDITOR_NOT_FOUND')) settingsReason = 'FLOW_EDITOR_NOT_FOUND'
    flowTraceFail('applySettings', settingsReason, {
      rawResult: settingsResult,
      payloadSummary: payloadSummary,
      extra: { settingsError: settingsError, settingsDetails: (settingsResult as Record<string, unknown>)?.details },
    })

    // ── HARD-STOP POLICY (video mismatch) ────────────────────────────
    // FLOW_SETTINGS_VERIFY_MISMATCH means the bridge successfully applied
    // every step AND re-tried where applicable, but the actual values
    // on the Flow page still don't match (e.g. Omni Flash reset
    // duration to 8s / quantity to x4 after a late model re-render).
    //
    // Submitting under these conditions would silently submit the wrong
    // settings — a video "4s x2" prompt would actually generate
    // "8s x4". That is the original bug. Therefore:
    //   - mode/ratio mismatch   → HARD STOP (visible so the user can
    //                             pick a different combination)
    //   - video duration mismatch → HARD STOP
    //   - video quantity mismatch → HARD STOP
    //   - model mismatch (image) → HARD STOP (was previously the same
    //                                "soft-fail" path, but submitting
    //                                with the wrong model is also a
    //                                silent incorrectness bug)
    //
    // Image quantity model-render drift is left to soft-fail because
    // it has not been observed to silently produce wrong outputs in
    // practice (the image apply order is stable).
    var isVerifyMismatch = settingsError.includes('FLOW_SETTINGS_VERIFY_MISMATCH')
    var mismatchDetails = (settingsResult as Record<string, unknown>)?.details as Record<string, unknown> | undefined
    var mismatchCompare = mismatchDetails?.compare as { diff?: { mode?: { match?: boolean }; ratio?: { match?: boolean }; model?: { match?: boolean }; duration?: { match?: boolean }; quantity?: { match?: boolean }; videoMode?: { match?: boolean } } } | undefined
    var isHardStop = false
    var hardStopReason = ''
    if (isVerifyMismatch && mismatchCompare?.diff) {
      var d = mismatchCompare.diff
      if (d.mode?.match === false) { isHardStop = true; hardStopReason = 'mode mismatch' }
      else if (d.ratio?.match === false) { isHardStop = true; hardStopReason = 'ratio mismatch' }
      else if (d.videoMode?.match === false) { isHardStop = true; hardStopReason = 'video mode mismatch' }
      else if (payload.mode === 'video' && d.duration?.match === false) { isHardStop = true; hardStopReason = 'video duration mismatch' }
      else if (payload.mode === 'video' && d.quantity?.match === false) { isHardStop = true; hardStopReason = 'video quantity mismatch' }
      else if (payload.mode === 'image' && d.model?.match === false) { isHardStop = true; hardStopReason = 'image model mismatch' }
    }

    if (isHardStop) {
      var targetDuration = (payload as Record<string, unknown>).duration || ''
      var targetQuantity = (payload as Record<string, unknown>).quantity
      var currentSnap = mismatchDetails?.current as Record<string, unknown> | undefined
      console.error('[FlowTrace][Fail]', JSON.stringify({
        step: 'applySettings',
        reason: 'VIDEO_SETTINGS_VERIFY_MISMATCH',
        hardStop: true,
        details: hardStopReason,
        target: { duration: targetDuration, quantity: targetQuantity, mode: payload.mode, ratio: (payload as Record<string, unknown>).aspectRatio, model: payload.model },
        current: currentSnap ? { duration: currentSnap.duration, quantity: currentSnap.quantity, mode: currentSnap.mode, ratio: currentSnap.ratioIcon, rawText: currentSnap.rawText } : null,
      }))
      return {
        success: false,
        status: 'FLOW_SETTINGS_VERIFY_MISMATCH',
        error: 'Video settings mismatch: expected '
          + (payload.mode === 'video' ? `${targetDuration} x${targetQuantity}` : `${(payload as Record<string, unknown>).aspectRatio} ${payload.model}`)
          + ', got '
          + (currentSnap ? `${currentSnap.rawText || ''}` : 'unknown'),
        settingsHardStop: true,
        hardStopReason: hardStopReason,
        settings: mismatchDetails,
      }
    }

    // ── SOFT-FAIL POLICY (image-only drift, non-verify-mismatch) ─────
    // For non-verify-mismatch settings errors AND image-mode apply
    // drift, we keep the legacy soft-fail behavior: continue with
    // insert/submit using whatever settings are currently visible on
    // the Flow page. The user gets a soft warning and a flowStep
    // message, but the queue keeps progressing.
    //
    // Video mismatch is NEVER soft-fail — see hard-stop above.
    console.warn('[FlowTrace][Content] APPLY_SETTINGS_SOFT_FAIL_CONTINUE', JSON.stringify({
      reason: settingsReason,
      mode: payload.mode,
      softFailed: true,
      willContinueWith: 'insert/submit using current Flow page settings',
    }))
    settingsResult = {
      success: false,
      softFailed: true,
      error: settingsError,
      method: 'soft-fail-continue',
      status: settingsReason,
    }
  }
  flowTrace('Content', 'STEP_1_2_APPLY_SETTINGS_DONE', {
    success: !!(settingsResult as Record<string, unknown>)?.success,
    softFailed: !!(settingsResult as Record<string, unknown>)?.softFailed,
    method: (settingsResult as Record<string, unknown>)?.method || '',
  })
  await new Promise(r => setTimeout(r, 400))

  // Step 3: Clear editor
  console.log('[FlowContent] Step 3: clearEditor')
  flowTrace('Content', 'STEP_3_CLEAR_START', {})
  notifyStatus('FLOW_RUN_STARTED')
  const clearResult = await bridgeCall('clear')
  flowTrace('Content', 'STEP_3_CLEAR_RAW', clearResult)
  if (!clearResult.success) {
    flowTraceFail('clear', 'FLOW_CLEAR_FAILED', {
      rawResult: clearResult,
      payloadSummary: payloadSummary,
    })
    return { success: false, status: 'FLOW_CLEAR_FAILED', error: (clearResult as Record<string, unknown>).error || 'clear failed' }
  }
  flowTrace('Content', 'STEP_3_CLEAR_DONE', { method: (clearResult as Record<string, unknown>).method })
  await new Promise(r => setTimeout(r, 300))
  // Snapshot editor text right after clear so we can prove addRef/insert
  // never introduced extra text from a duplicate bridge or stale state.
  await snapshotEditorText('after_clear')

  // Step 4: Add reference images BEFORE text
  const isFrames = !!(payload.frameFileIds && (payload.frameFileIds.frame1 || payload.frameFileIds.frame2))

  // Gate: if fileIds contain upload_xxx, it means GenPanel failed to resolve — abort
  if (payload.fileIds && payload.fileIds.some(id => id.startsWith('upload_'))) {
    const unresolved = payload.fileIds.filter(id => id.startsWith('upload_'))
    console.error('[FlowContent] REF_UPLOAD_NOT_RESOLVED: ' + JSON.stringify(unresolved))
    flowTraceFail('addRefImages', 'REF_UPLOAD_NOT_RESOLVED', {
      payloadSummary: payloadSummary,
      extra: { unresolved: unresolved },
    })
    return {
      success: false,
      status: 'REF_UPLOAD_NOT_RESOLVED',
      error: 'REF_UPLOAD_NOT_RESOLVED: some upload_xxx keys were not resolved before reaching FlowContent: ' + JSON.stringify(unresolved),
    }
  }

  if (payload.fileIds && payload.fileIds.length > 0 && !isFrames) {
    console.log('[FlowContent] Step 4: addRefImages, count=' + payload.fileIds.length)
    flowTrace('Content', 'STEP_4_ADD_REF_START', { count: payload.fileIds.length, isFrames: isFrames })
    for (const fileId of payload.fileIds) {
      const fileName = payload.fileNameMap?.[fileId] || ''
      console.log('[FlowContent][ADD_REF_START]', JSON.stringify({ fileId, fileName }))
      const addRefResult = await bridgeCall('addRef', { fileId, fileName })
      const addRefSuccess = !!(addRefResult as Record<string, unknown>).success
      const addRefMethod = String((addRefResult as Record<string, unknown>).method || 'unknown')
      const addRefError = String((addRefResult as Record<string, unknown>).error || '')
      console.log('[FlowContent][ADD_REF_RESULT]', JSON.stringify({
        fileId,
        success: addRefSuccess,
        error: addRefError,
        method: addRefMethod,
      }))
      if (!addRefSuccess) {
        flowTraceFail('addRefImages', 'FLOW_ADD_REF_FAILED', {
          rawResult: addRefResult,
          payloadSummary: payloadSummary,
          extra: { fileId: fileId, fileName: fileName, addRefError: addRefError },
        })
        return {
          success: false,
          status: 'FLOW_ADD_REF_FAILED',
          error: 'Failed to add ref image: ' + fileId + ' — ' + addRefError,
          details: addRefResult,
        }
      }
    }
    flowTrace('Content', 'STEP_4_ADD_REF_DONE', { count: payload.fileIds.length })
    await new Promise(r => setTimeout(r, 300))
    // Snapshot editor text after addRef to catch any prompt leakage from
    // the "Add to prompt" right-click menu (Flow sometimes appends the
    // prompt text as part of the chip caption).
    await snapshotEditorText('after_addRef')
  }

  // Step 5: Insert text
  console.log('[FlowContent] Step 5: insertText, len=', payload.prompt.length)
  flowTrace('Content', 'STEP_5_INSERT_START', { promptLen: payload.prompt.length })
  // Snapshot editor text BEFORE insert so the strict verify below can
  // diff cleanly against a known-clean baseline.
  await snapshotEditorText('before_insert')
  let insertResult = await bridgeCall('insert', { text: payload.prompt })
  flowTrace('Content', 'STEP_5_INSERT_RAW', insertResult)
  if (!insertResult.success) {
    // ── Fallback: DOM-first Google Flow INSERT path ─────────────────────
    flowTrace('Content', 'INSERT_FALLBACK_START', {
      reason: 'slate_insert_failed',
      slateError: (insertResult as Record<string, unknown>).error,
    })
    const insertFallback = await runFlowPromptInsertGoogleFlowFallback(payload as Record<string, unknown>)
    flowTrace('Content', 'INSERT_FALLBACK_RESULT', insertFallback)
    if (!insertFallback.success || !insertFallback.insertResult) {
      flowTraceFail('insertGoogleFlowPromptOnly', 'FLOW_GFLOW_INSERT_FALLBACK_FAILED', {
        rawResult: insertFallback,
        payloadSummary: payloadSummary,
        fallback: 'insertGoogleFlowPromptOnly',
      })
      return {
        success: false,
        status: insertFallback.status || 'FLOW_INSERT_FAILED',
        error: insertFallback.error || 'DOM-first insert fallback failed',
        insertMethod: 'gflow-dom-insert-failed',
        fallback: 'insertGoogleFlowPromptOnly',
      }
    }
    // Synthesize a successful insertResult and continue the normal flow.
    insertResult = insertFallback.insertResult
    notifyStatus('FLOW_INSERT_SUCCESS')
    console.log('[FlowContent] Step 5 DOM-first insert fallback succeeded, continuing normal pipeline', JSON.stringify({
      method: (insertResult as Record<string, unknown>).method,
      strategy: (insertResult as Record<string, unknown>).strategy,
    }))
  }
  flowTrace('Content', 'STEP_5_INSERT_DONE', {
    success: !!insertResult.success,
    method: (insertResult as Record<string, unknown>).method,
    strategy: (insertResult as Record<string, unknown>).strategy,
  })
  notifyStatus('FLOW_INSERT_SUCCESS')
  await new Promise(r => setTimeout(r, 500))

  // ── Step 5 verify: STRICT expected-vs-actual prompt check ─────────────
  // The Slate `insert` action's verifyText used to be satisfied by
  // "placeholderGone=true" alone, which let a duplicated prompt like
  // "ảnh 16:9ảnh 16:9" pass. After Step 5 we now ALWAYS call the new
  // bridge `verifyPrompt` action — which compares expected vs actual
  // character-for-character — and we surface the result with one
  // canonical log key for grep:
  //   [FlowContent][STEP_5_INSERT_VERIFY]
  //     expected="ảnh 16:9" actual="ảnh 16:9" duplicate=false
  // If `duplicate` is true the run is HARD-FAILED with
  // status='FLOW_INSERT_TEXT_DUPLICATED' — never submitted with a
  // doubled prompt. If `actual` is empty or doesn't match expected
  // the run HARD-FAILS with status='FLOW_INSERT_TEXT_MISMATCH'.
  let strictVerify: Record<string, unknown> = {}
  for (let vpAttempt = 0; vpAttempt < 3; vpAttempt++) {
    try {
      strictVerify = (await bridgeCall('verifyPrompt', { text: payload.prompt }, 5000)) as Record<string, unknown>
      break
    } catch (e) {
      console.warn('[FlowContent] verifyPrompt attempt ' + (vpAttempt + 1) + ' failed: ' + (e as Error)?.message)
      await new Promise(r => setTimeout(r, 300))
    }
  }
  const expectedText = String(strictVerify.expected || payload.prompt || '').trim()
  const actualText = String(strictVerify.domText || '').trim()
  const isDuplicate = !!(strictVerify.duplicate)
  const isExactMatch = !!(strictVerify.exactMatch)
  console.log('[FlowContent][STEP_5_INSERT_VERIFY] ' + JSON.stringify({
    expected: expectedText,
    actual: actualText,
    duplicate: isDuplicate,
    exactMatch: isExactMatch,
    slateMatch: !!(strictVerify.slateMatch),
    domMatch: !!(strictVerify.domMatch),
    slateText: String(strictVerify.slateText || '').substring(0, 60),
    attemptMethod: String((insertResult as Record<string, unknown>).method || ''),
    attemptStrategy: String((insertResult as Record<string, unknown>).strategy || ''),
  }))
  flowTrace('Content', 'STEP_5_INSERT_VERIFY', {
    expected: expectedText,
    actual: actualText,
    duplicate: isDuplicate,
    exactMatch: isExactMatch,
  })

  if (isDuplicate) {
    flowTraceFail('insertText', 'FLOW_INSERT_TEXT_DUPLICATED', {
      rawResult: strictVerify,
      payloadSummary: payloadSummary,
      extra: { expected: expectedText, actual: actualText, attemptMethod: String((insertResult as Record<string, unknown>).method || '') },
    })
    return {
      success: false,
      status: 'FLOW_INSERT_TEXT_DUPLICATED',
      error: 'Prompt appears more than once in editor. expected="' + expectedText + '" actual="' + actualText + '". The bridge or content script has a duplicate listener — verify only one bridge instance is installed.',
      expected: expectedText,
      actual: actualText,
      duplicate: true,
      insertMethod: String((insertResult as Record<string, unknown>).method || ''),
    }
  }
  if (!isExactMatch) {
    flowTraceFail('insertText', 'FLOW_INSERT_TEXT_MISMATCH', {
      rawResult: strictVerify,
      payloadSummary: payloadSummary,
      extra: { expected: expectedText, actual: actualText, attemptMethod: String((insertResult as Record<string, unknown>).method || '') },
    })
    return {
      success: false,
      status: 'FLOW_INSERT_TEXT_MISMATCH',
      error: 'Prompt not present verbatim after insert. expected="' + expectedText + '" actual="' + actualText + '"',
      expected: expectedText,
      actual: actualText,
      exactMatch: false,
      insertMethod: String((insertResult as Record<string, unknown>).method || ''),
    }
  }
  // Snapshot editor text after the strict verify passes so we have a
  // clean post-insert baseline.
  await snapshotEditorText('after_insert')

  // Step 6: Verify
  flowTrace('Content', 'STEP_6_VERIFY_START', {})
  const verifyResult = await bridgeCall('verify')
  flowTrace('Content', 'STEP_6_VERIFY_RAW', verifyResult)
  if (!(verifyResult as Record<string, unknown>).hasContent) {
    flowTrace('Content', 'STEP_6_VERIFY_NO_CONTENT', { retrying: true })
    const retryInsert = await bridgeCall('insert', { text: payload.prompt })
    flowTrace('Content', 'STEP_6_RETRY_INSERT_RAW', retryInsert)
    if (!retryInsert.success) {
      // ── Fallback: DOM-first Google Flow INSERT path (retry) ─────────
      console.warn('[FlowContent] Step 6 verify/retry failed, falling back to insertGoogleFlowPromptOnly (DOM-first insert only)')
      flowTrace('Content', 'INSERT_FALLBACK_START', {
        reason: 'step6_verify_retry_failed',
        slateError: (retryInsert as Record<string, unknown>).error,
      })
      const insertFallback2 = await runFlowPromptInsertGoogleFlowFallback(payload as Record<string, unknown>)
      flowTrace('Content', 'INSERT_FALLBACK_RESULT', insertFallback2)
      if (!insertFallback2.success || !insertFallback2.insertResult) {
        flowTraceFail('insertGoogleFlowPromptOnly', 'FLOW_GFLOW_INSERT_FALLBACK_FAILED', {
          rawResult: insertFallback2,
          payloadSummary: payloadSummary,
          fallback: 'insertGoogleFlowPromptOnly',
          extra: { triggerStep: 'step6_verify_retry' },
        })
        return {
          success: false,
          status: insertFallback2.status || 'FLOW_VERIFY_FAILED',
          error: insertFallback2.error || 'DOM-first insert fallback failed (verify retry)',
          insertMethod: 'gflow-dom-insert-failed',
          fallback: 'insertGoogleFlowPromptOnly',
        }
      }
      insertResult = insertFallback2.insertResult
      notifyStatus('FLOW_INSERT_SUCCESS')
      console.log('[FlowContent] Step 6 DOM-first insert fallback (retry) succeeded, continuing normal pipeline', JSON.stringify({
        method: (insertResult as Record<string, unknown>).method,
        strategy: (insertResult as Record<string, unknown>).strategy,
      }))
    }
    await new Promise(r => setTimeout(r, 500))
  }
  flowTrace('Content', 'STEP_6_VERIFY_DONE', { hasContent: !!(verifyResult as Record<string, unknown>).hasContent })

  // Step 7: Submit — capture baseline snapshot RIGHT BEFORE submit.
  // This is critical: if captured after submit, result tiles may already exist
  // and the diff will find 0 new tiles (download nothing).
  // Snapshot includes both tileIds AND fileNames for dual filtering.
  console.log('[FlowContent] Step 7: submit (capturing pre-submit baseline)')
  flowTrace('Content', 'STEP_7_BASELINE_CAPTURE_START', {})
  var preSubmitIds: string[] = []
  var preSubmitFileNames: string[] = []
  var preSubmitDetails: Array<{ id: string; fileName: string; status: string }> = []
  try {
    var preSubmitSnapshot = await bridgeCall('getTileSnapshot', {}, 5000)
    preSubmitIds = ((preSubmitSnapshot as Record<string, unknown>).ids as string[]) || []
    preSubmitFileNames = ((preSubmitSnapshot as Record<string, unknown>).fileNames as string[]) || []
    preSubmitDetails = ((preSubmitSnapshot as Record<string, unknown>).details as Array<{ id: string; fileName: string; status: string }>) || []
    flowTrace('Content', 'STEP_7_BASELINE_CAPTURED', {
      idsCount: preSubmitIds.length,
      fileNamesCount: preSubmitFileNames.length,
      nonEmptyFileNames: preSubmitFileNames.filter(function (f) { return f.length > 0 }).length,
    })
    if (FLOW_DEBUG_VERBOSE) console.log('[FlowContent][BASELINE]', JSON.stringify({
      ids: preSubmitIds.length,
      fileNames: preSubmitFileNames.length,
      nonEmptyFileNames: preSubmitFileNames.filter(function (f) { return f.length > 0 }).length,
    }))
    // Log non-empty fileNames for debugging. Always log a count line so
    // production logs show whether the baseline had any media to compare
    // against (a zero baseline is the textbook lazy-load bug signal).
    var baselineNonEmpty = preSubmitFileNames.filter(function (f) { return f.length > 0 })
    console.log('[FlowContent][BASELINE_FILE_NAMES]', JSON.stringify({
      count: baselineNonEmpty.length,
      truncatedTo: baselineNonEmpty.slice(0, 50),
      total: baselineNonEmpty.length,
    }))
    if (FLOW_DEBUG_VERBOSE && baselineNonEmpty.length > 0) {
      console.log('[FlowContent][BASELINE_FILE_NAMES_FULL]', JSON.stringify(baselineNonEmpty))
    }
  } catch (e) {
    flowTraceFail('getTileSnapshot', 'FLOW_BASELINE_CAPTURE_FAILED', {
      rawResult: { message: (e as Error)?.message },
      payloadSummary: payloadSummary,
    })
  }

  console.log('[FlowContent] Step 7: submit')
  flowTrace('Content', 'STEP_7_SUBMIT_START', {})
  let submitResult = await bridgeCall('submit')
  flowTrace('Content', 'STEP_7_SUBMIT_RAW', submitResult)
  if (!submitResult.success) {
    // ── Fallback: DOM-first Google Flow SUBMIT path (button click only) ─
    flowTrace('Content', 'SUBMIT_FALLBACK_START', {
      reason: 'slate_submit_failed',
      slateError: (submitResult as Record<string, unknown>).error,
    })
    const submitFallback = await runFlowPromptSubmitGoogleFlowFallback()
    flowTrace('Content', 'SUBMIT_FALLBACK_RESULT', submitFallback)
    if (!submitFallback.success) {
      flowTraceFail('submitGoogleFlowButtonOnly', 'FLOW_GFLOW_SUBMIT_FALLBACK_FAILED', {
        rawResult: submitFallback.submitResult,
        payloadSummary: payloadSummary,
        fallback: 'submitGoogleFlowButtonOnly',
      })
      return {
        success: false,
        status: 'FLOW_SUBMIT_FAILED',
        error: (submitFallback.submitResult as Record<string, unknown>).error || 'submit failed',
        submitMethod: (submitFallback.submitResult as Record<string, unknown>).method || '',
        fallback: 'submitGoogleFlowButtonOnly',
      }
    }
    // Synthesize a successful submitResult and continue the normal flow.
    submitResult = submitFallback.submitResult
    console.log('[FlowContent] Step 7 DOM-first submit fallback succeeded, continuing normal pipeline', JSON.stringify({
      method: (submitResult as Record<string, unknown>).method,
    }))
  }
  flowTrace('Content', 'STEP_7_SUBMIT_DONE', {
    success: !!submitResult.success,
    method: (submitResult as Record<string, unknown>).method,
  })
  notifyStatus('FLOW_SUBMIT_SUCCESS')
  await new Promise(r => setTimeout(r, 1000))

  // ── Step 8: Auto Download (if enabled) ─────────────────────────────
  // Normalize aliases: GenPanel may use different field names
  var normAutoDownload = !!(payload.autoDownload)
  var normDownloadResolution = String(
    (payload as Record<string, unknown>).downloadResolution ||
    (payload as Record<string, unknown>).downloadRes ||
    payload.resolution ||
    '1k'
  )
  var normVideoResolution = String(
    (payload as Record<string, unknown>).videoDownloadResolution ||
    (payload as Record<string, unknown>).videoDownloadRes ||
    payload.videoResolution ||
    '720p'
  )
  // AUTHORITATIVE mode from caller (the GenPanel / payload). This is the
  // single source of truth for whether the current run is a video or
  // image run — the bridge MUST receive it explicitly and must NOT
  // re-derive it from `videoResolution`.
  var normMode: 'image' | 'video' = String(
    (payload as Record<string, unknown>).mode ||
    (payload as Record<string, unknown>).mediaKind ||
    'image'
  ).toLowerCase() === 'video' ? 'video' : 'image'
  var normOutputFolder = String(
    (payload as Record<string, unknown>).outputFolder ||
    (payload as Record<string, unknown>).subFolder ||
    (payload as Record<string, unknown>).taskName ||
    ''
  )

  // Log normalized settings
  console.log('[FlowContent][AUTO_DOWNLOAD_SETTINGS]', JSON.stringify({
    autoDownload: normAutoDownload,
    mode: normMode,
    downloadResolution: normDownloadResolution,
    videoDownloadResolution: normVideoResolution,
    outputFolder: normOutputFolder,
    source: (payload as Record<string, unknown>).source || 'gen-tab',
    suppressAutoDownload: !!(payload as Record<string, unknown>).suppressAutoDownload,
    collectOutputs: (payload as Record<string, unknown>).collectOutputs !== false,
    rawPayloadKeys: Object.keys(payload),
  }))

  // ── Two-flag gate ─────────────────────────────────────────────
  // shouldCollectOutputs: should we wait for new result tiles and
  //   build outputAssets for the workflow preview / downstream
  //   media? Defaults to true. Workflow callers set this true so
  //   the node still shows its generated thumbnails even when no
  //   file is downloaded.
  // shouldAutoDownload: should we call bridge.downloadTileMedia and
  //   write files to the user's disk? Defense-in-depth gate: any
  //   caller (gen-tab, workflow, future sources) must satisfy all
  //   three — autoDownload===true, suppressAutoDownload!==true,
  //   source!=='workflow' — before a download fires.
  //   Gen tab: shouldAutoDownload = autoDownload toggle
  //   Workflow: shouldAutoDownload = false
  var payloadSource = String((payload as Record<string, unknown>).source || 'gen-tab')
  var payloadSuppress = !!(payload as Record<string, unknown>).suppressAutoDownload
  var shouldCollectOutputs = (payload as Record<string, unknown>).collectOutputs !== false
  var shouldAutoDownload =
    normAutoDownload === true &&
    payloadSuppress !== true &&
    payloadSource !== 'workflow'

  var autoDownloadResult: Record<string, unknown> = {
    attempted: shouldAutoDownload,
    skipped: !shouldAutoDownload,
  }
  if (!shouldCollectOutputs) {
    console.log('[FlowContent][RESULT_COLLECTION_SKIP] reason=collectOutputs_disabled', JSON.stringify({
      source: payloadSource,
      suppressAutoDownload: payloadSuppress,
    }))
  } else {
    if (shouldAutoDownload) {
      console.log('[FlowContent][RESULT_COLLECTION_START]', JSON.stringify({
        expectedCount: payload.quantity,
        baselineIds: preSubmitIds.length,
        baselineNonEmptyFileNames: preSubmitFileNames.filter(function (f) { return f.length > 0 }).length,
        downloadResolution: normDownloadResolution,
        videoDownloadResolution: normVideoResolution,
        outputFolder: normOutputFolder,
        source: payloadSource,
        downloadEnabled: true,
      }))
    } else {
      console.log('[FlowContent][RESULT_COLLECTION_START]', JSON.stringify({
        expectedCount: payload.quantity,
        baselineIds: preSubmitIds.length,
        baselineNonEmptyFileNames: preSubmitFileNames.filter(function (f) { return f.length > 0 }).length,
        downloadResolution: normDownloadResolution,
        videoDownloadResolution: normVideoResolution,
        outputFolder: normOutputFolder,
        source: payloadSource,
        downloadEnabled: false,
        reason: 'download_suppressed_collecting_outputs_only',
        autoDownloadRequested: normAutoDownload,
      }))
    }

    // ── Wait for new result tiles with DUAL filter (id + fileName) ──
    // This prevents lazy-loaded old tiles or mis-identified ref tiles from appearing
    // as "new" results. A result tile must have BOTH a new id AND a new fileName.
    var maxWaitMs = 120000
    var pollIntervalMs = 2000
    var waitedMs = 0
    var newTileIds: string[] = []
    var newTilesFullData: Array<{ id: string; status: string; fileName: string }> = []
    var preSubmitIdSet = new Set(preSubmitIds)
    var preSubmitFileNameSet = new Set(preSubmitFileNames.filter(function (f) { return f.length > 0 }))
    var refIdSet = new Set((payload as Record<string, unknown>).fileIds as string[] || [])
    // Build refFileNames from fileNameMap
    var refFileNames: string[] = []
    var rawFileNameMap = (payload as Record<string, unknown>).fileNameMap as Record<string, string> | undefined
    if (rawFileNameMap) {
      var refKeys = Object.keys(rawFileNameMap)
      for (var rfki = 0; rfki < refKeys.length; rfki++) {
        var fn = rawFileNameMap[refKeys[rfki]]
        if (fn) refFileNames.push(fn)
      }
    }
    var refFileNameSet = new Set(refFileNames)

    if (FLOW_DEBUG_VERBOSE) console.log('[FlowContent][REF_IDENTITY]', JSON.stringify({
      refIds: Array.from(refIdSet),
      refFileNames: refFileNames,
    }))

    // Track candidates by id. A candidate is "confirmed" only when:
    // - status === 'done' AND fileName is non-empty
    // A candidate is "pending" if status === 'processing' or fileName is empty.
    // We only count confirmed candidates against expectedQuantity.
    var pendingCandidatesById: Record<string, { id: string; status: string; fileName: string; failedFirstSeenAt?: number; statusReason?: string }> = {}
    // Track DOM order via last-seen snapshot order
    var lastDomOrder: string[] = []

    // Recency guard: tile-ids and fileNames observed as non-terminal
    // (status !== 'done' && status !== 'failed') at any poll AFTER submit.
    // Only tiles whose identity was first seen as pending/processing after
    // submit are accepted into `confirmed` — otherwise Flow's lazy-rendered
    // old images (new tileId, same fileName as a prior run) slip through
    // because the pre-submit baseline only captures visible tile cards.
    var seenProcessingIds: Set<string> = new Set()
    var seenProcessingFileNames: Set<string> = new Set()

    // Suspicious-done accumulator across polls. A done-without-processing
    // tile is the textbook lazy-loaded old image. We track it across polls
    // so that, after the loop, we can decide whether to accept it as a
    // fallback when no recency-clean candidate exists.
    var suspiciousDoneWithoutProcessing: Array<{ id: string; status: string; fileName: string }> = []  

    // Partial-grace timers
    // Reduced role: VIDEO_PARTIAL_GRACE_MS is now a fallback only when
    // no failed icon is detectable. Primary early-exit is the
    // confirmed + failed coexist branch (handled below).
    var VIDEO_PARTIAL_GRACE_MS = 8000
    // Minimum time a tile must stay in 'failed' state before we count it
    // as a real failure. Matches the constant on the bridge side.
    var MIN_FAIL_DETECT_MS = 15000
    var PROVISIONAL_GRACE_MS = 2000 // wait 2s after stableFailed > 0 for confirmed tiles before using provisional
    var lastProgressMs = 0 // last time confirmed count INCREASED
    var lastConfirmedCount = 0
    var lastConfirmedTilesSignature = ''

    // Track tile first-seen-as-failed across polling iterations so we
    // can enforce MIN_FAIL_DETECT_MS inside this script (the bridge also
    // tracks it but we keep an independent clock for cross-validation).
    var failedFirstSeenAt: Record<string, number> = {}
    var provisionalMediaSeenAt: number = 0 // first poll ms when stableFailed > 0 AND provisionalDone > 0

    // ── MutationObserver fast signal ─────────────────────────────────────
    // Attach a MutationObserver on the gallery root so we react to DOM
    // changes within ~200ms instead of waiting for the next 2000ms poll.
    // The observer is disconnected on break/return.
    var galleryRoot: HTMLElement | null = document.querySelector(
      '[data-tile-id], main, [class*="gallery"], [class*="results"]'
    ) as HTMLElement | null
    if (!galleryRoot) galleryRoot = document.body
    var observerFiredAt = 0
    var observer = new MutationObserver(function () {
      observerFiredAt = Date.now()
    })
    try {
      observer.observe(galleryRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'data-tile-id', 'src', 'aria-label', 'aria-disabled'],
      })
    } catch (_) {}

    // Cleanup helper — must be called whenever we leave the polling loop.
    var cleanupObserver = function () {
      try { observer.disconnect() } catch (_) {}
    }

    while (waitedMs < maxWaitMs) {
      // Stop polling if the extension context was invalidated mid-generation.
      // There's no live receiver for any further status updates, and the
      // timer/observer would keep the page busy for no reason. Mark
      // autoDownloadResult as a contextual failure and break so the
      // existing post-loop return path emits a graceful failure with
      // autoDownload populated — callers downstream (GenPanel) distinguish
      // by the autoDownload successCount/failCount and the propagated
      // `error` field.
      if (!safeRuntimeContext()) {
        cleanupObserver()
        console.warn('[FlowContent] waitForGeneratedTiles aborted: extension context invalidated')
        autoDownloadResult = {
          successCount: 0,
          failCount: 0,
          error: 'context_invalidated',
          abortedReason: 'extension_context_invalidated_reload_chatgpt_tab',
        }
        break
      }

      // ── Adaptive sleep ────────────────────────────────────────────────
      // - If the MutationObserver fired recently, sleep ~200ms then take
      //   a fresh snapshot. This is the fast-path that lets us react
      //   to DOM changes within a few hundred ms instead of waiting
      //   out a fixed 2000ms poll.
      // - Otherwise, fall back to the standard 2000ms poll.
      var sinceFire = observerFiredAt ? Date.now() - observerFiredAt : Number.POSITIVE_INFINITY
      var sleepMs: number
      if (sinceFire < pollIntervalMs) {
        sleepMs = 200
      } else {
        sleepMs = pollIntervalMs
      }
      await new Promise(r => setTimeout(r, sleepMs))
      waitedMs += sleepMs
      // Reset the fire timestamp AFTER consuming it so the next poll
      // doesn't immediately re-enter the 200ms branch on stale fires.
      if (sinceFire < pollIntervalMs) observerFiredAt = 0

      var snapResult = await bridgeCall('getTileSnapshot', {}, 5000)
      var allSnapTiles = ((snapResult as Record<string, unknown>).details as Array<{
        id: string
        fileName: string
        status: string
        failedFirstSeenAt?: number
        statusReason?: string
        textPreview?: string
        iconTexts?: string[]
        buttonTexts?: string[]
        className?: string
        hasVideo?: boolean
        hasImg?: boolean
        videoSrc?: string
        videoCurrentSrc?: string
        videoPoster?: string
        imgSrc?: string
        imgAlt?: string
        mediaReadyReason?: string
      }>) || []

      // Record DOM order
      lastDomOrder = allSnapTiles.map(function (t) { return t.id })

      // Stage 1: Apply dual filter (id + fileName) to find candidates
      var rawCandidates: Array<{ id: string; status: string; fileName: string; failedFirstSeenAt?: number; statusReason?: string }> = []
      var skippedOld = 0
      var skippedLazyLoaded = 0
      for (var ci = 0; ci < allSnapTiles.length; ci++) {
        var t = allSnapTiles[ci]
        if (preSubmitIdSet.has(t.id)) { skippedOld++; continue }
        // A tile is "lazy-loaded old" if its fileName was already in baseline
        // (the id might be new but the underlying media is an old one Flow re-painted).
        if (t.fileName && preSubmitFileNameSet.has(t.fileName)) { skippedLazyLoaded++; continue }
        // Skip ref tiles by id and fileName
        if (refIdSet.has(t.id)) continue
        if (t.fileName && refFileNameSet.has(t.fileName)) continue
        rawCandidates.push(t)
      }

      // Dedupe raw candidates — the bridge already dedupes but this is a safety net.
      var uniqueRawCandidates = dedupeTilesByIdentity(rawCandidates)

      // Track first-seen-as-failed timestamps (independent clock) so we
      // can promote pending→failed only after MIN_FAIL_DETECT_MS.
      var nowMs = Date.now()
      for (var fsi = 0; fsi < uniqueRawCandidates.length; fsi++) {
        var fsc = uniqueRawCandidates[fsi]
        if (fsc.status === 'failed') {
          if (!failedFirstSeenAt[fsc.id]) failedFirstSeenAt[fsc.id] = nowMs
        } else if (fsc.status === 'done') {
          delete failedFirstSeenAt[fsc.id]
        }
      }
      // Classification: stable vs fresh failed.
      // stable = FIRST_SEEN path (tile was failed for >= MIN_FAIL_DETECT_MS)
      //         OR ELAPSED path (waitedMs >= MIN_FAIL_DETECT_MS AND tile is currently failed)
      // The elapsed path handles the case where warning icon appears late but
      // the backend 403'd much earlier — we don't wait another 15s from firstSeen.
      var stableFailedIds = new Set<string>()
      var freshFailedIds = new Set<string>()
      for (var fsi2 = 0; fsi2 < uniqueRawCandidates.length; fsi2++) {
        var fsc2 = uniqueRawCandidates[fsi2]
        if (fsc2.status === 'failed') {
          var seenAt = failedFirstSeenAt[fsc2.id] || nowMs
          var ageMs = nowMs - seenAt
          var stableByFirstSeen = ageMs >= MIN_FAIL_DETECT_MS
          var stableByElapsed = waitedMs >= MIN_FAIL_DETECT_MS
          var isStable = stableByFirstSeen || stableByElapsed
          if (isStable) {
            stableFailedIds.add(fsc2.id)
          } else {
            freshFailedIds.add(fsc2.id)
          }
        }
      }

      // Stage 2: Split confirmed vs pending vs failed
      var confirmed: Array<{
        id: string; status: string; fileName: string;
        hasVideo?: boolean; hasImg?: boolean;
        videoSrc?: string; videoCurrentSrc?: string; videoPoster?: string;
        imgSrc?: string; imgAlt?: string; mediaReadyReason?: string;
      }> = []
      var failed: Array<{ id: string; status: string; fileName: string }> = []
      // Reset the per-poll suspicious-done counter. We append to the
      // top-level accumulator (declared before the loop) so duplicates
      // across polls can be deduped once the loop ends.
      var pollSuspiciousThisIteration: Array<{ id: string; status: string; fileName: string }> = []
      pendingCandidatesById = {}
      // Counters for [RESULT_CANDIDATE_TRACE].
      var traceSeenRecencyAccepted = 0
      var traceSeenRecencyRejected = 0
      for (var cci = 0; cci < uniqueRawCandidates.length; cci++) {
        var cand = uniqueRawCandidates[cci]
        // ── Update recency-tracker sets whenever we observe a candidate
        //    in a non-terminal state. `processing` covers status='processing'
        //    and any future non-terminal statuses Flow may add. failed is
        //    also non-terminal (Flow can retry), so we track it too.
        if (cand.status !== 'done') {
          seenProcessingIds.add(cand.id)
          if (cand.fileName && cand.fileName.length > 4 && cand.fileName !== 'media.getMediaUrlRedirect') {
            seenProcessingFileNames.add(cand.fileName)
          }
        }
        if (cand.status === 'failed' && stableFailedIds.has(cand.id)) {
          failed.push(cand)
          continue
        }
        // Fresh-failed (< MIN_FAIL_DETECT_MS) tiles stay pending so we
        // don't false-positive during a transient retry.
        if (cand.status === 'done' && cand.fileName && cand.fileName.length > 0 && cand.fileName !== 'media.getMediaUrlRedirect') {
          // ── Recency guard ──────────────────────────────────────────────
          // A tile that is done NOW but was never observed as non-terminal
          // since submit is almost certainly a Flow re-paint of an OLD
          // result (lazy-loaded with a new tileId, same underlying media).
          // We classify it as "suspicious" and defer it. If, after the
          // polling loop, it is the only candidate left, we accept it as
          // a fallback and emit [RESULT_DETECT_SUSPICIOUS_DONE_WITHOUT_PROCESSING].
          var inBaselineId = preSubmitIdSet.has(cand.id)
          var inBaselineFileName = !!(cand.fileName && preSubmitFileNameSet.has(cand.fileName))
          var seenProcessing = seenProcessingIds.has(cand.id) ||
            (cand.fileName && seenProcessingFileNames.has(cand.fileName))
          if (FLOW_DEBUG_VERBOSE) {
            console.log('[FlowContent][RESULT_CANDIDATE_TRACE]', JSON.stringify({
              tileId: cand.id,
              fileName: cand.fileName,
              status: cand.status,
              inBaselineId: inBaselineId,
              inBaselineFileName: inBaselineFileName,
              seenProcessing: seenProcessing,
              firstSeenMs: 0,
              accepted: seenProcessing,
              rejectReason: seenProcessing ? '' : 'suspicious_done_without_processing',
              waitedMs: waitedMs,
            }))
          }
          if (seenProcessing) {
            traceSeenRecencyAccepted++
            confirmed.push(cand)
          } else {
            traceSeenRecencyRejected++
            pollSuspiciousThisIteration.push(cand)
            // Also keep it tracked as pending so the early-exit logic
            // doesn't classify "0 confirmed + 0 pending" as a hard fail.
            pendingCandidatesById[cand.id] = cand
          }
        } else {
          pendingCandidatesById[cand.id] = cand
        }
      }
      // Merge per-poll suspicious-done tiles into the top-level accumulator,
      // deduped by fileName > id (matches dedupeTilesByIdentity behavior).
      if (pollSuspiciousThisIteration.length > 0) {
        var suspSeen = new Set<string>()
        for (var sspi = 0; sspi < suspiciousDoneWithoutProcessing.length; sspi++) {
          var prev = suspiciousDoneWithoutProcessing[sspi]
          var prevKey = (prev.fileName && prev.fileName.length > 0 ? prev.fileName : '') || prev.id
          if (prevKey) suspSeen.add(prevKey)
        }
        for (var spii = 0; spii < pollSuspiciousThisIteration.length; spii++) {
          var cur = pollSuspiciousThisIteration[spii]
          var curKey = (cur.fileName && cur.fileName.length > 0 ? cur.fileName : '') || cur.id
          if (!curKey || suspSeen.has(curKey)) continue
          suspSeen.add(curKey)
          suspiciousDoneWithoutProcessing.push(cur)
        }
      }
      if (FLOW_DEBUG_VERBOSE && (traceSeenRecencyAccepted > 0 || traceSeenRecencyRejected > 0)) {
        console.log('[FlowContent][RESULT_RECENCY_SUMMARY]', JSON.stringify({
          accepted: traceSeenRecencyAccepted,
          rejectedAsSuspicious: traceSeenRecencyRejected,
          suspiciousFileNames: pollSuspiciousThisIteration.map(function (t) { return t.fileName }),
          suspiciousTotalAccumulated: suspiciousDoneWithoutProcessing.length,
          waitedMs: waitedMs,
        }))
      }

      // Dedupe confirmed by identity — only count UNIQUE generated tiles.
      var uniqueConfirmed = dedupeTilesByIdentity(confirmed)
      var uniquePending = dedupeTilesByIdentity(Object.values(pendingCandidatesById))
      var uniqueFailed = dedupeTilesByIdentity(failed)

      // Progress tracking: update timestamp when confirmed count INCREASES
      // (i.e. a new confirmed tile appears) OR when the set of confirmed ids changes.
      var confirmedSig = uniqueConfirmed.map(function (c) { return c.id }).sort().join('|')
      if (uniqueConfirmed.length > lastConfirmedCount || (confirmedSig !== lastConfirmedTilesSignature && lastConfirmedTilesSignature.length > 0)) {
        lastProgressMs = waitedMs
        lastConfirmedCount = uniqueConfirmed.length
        lastConfirmedTilesSignature = confirmedSig
      } else if (lastConfirmedTilesSignature === '') {
        lastConfirmedTilesSignature = confirmedSig
        lastProgressMs = waitedMs
      }

      // FAILED_SIGNAL_DEBUG — sample every failed/fresh-failed tile in this
      // poll so we can confirm tileHasFailureSignals() is actually
      // catching the "Không thành công" / failure card. Without this
      // log a regression in the bridge detector would silently show
      // pending:2 failed:0 and the early-exit would never fire.
      for (var fdi = 0; fdi < uniqueRawCandidates.length; fdi++) {
        var fdTile = uniqueRawCandidates[fdi]
        if (fdTile.status !== 'failed' && !freshFailedIds.has(fdTile.id) && !stableFailedIds.has(fdTile.id)) continue
        var fdSeen = failedFirstSeenAt[fdTile.id] || 0
        var fdAge = fdSeen ? nowMs - fdSeen : 0
        var fdStable = stableFailedIds.has(fdTile.id)
        flowDebug('[FlowContent][FAILED_SIGNAL_DEBUG]', JSON.stringify({
          tileId: fdTile.id,
          status: fdTile.status,
          statusReason: (fdTile as Record<string, unknown>).statusReason || '',
          failedFirstSeenAt: fdSeen,
          failedAgeMs: fdAge,
          stable: fdStable,
          fileName: fdTile.fileName || '',
        }))
      }

      flowDebug('[FlowContent][RESULT_DETECT]', JSON.stringify({
        rawCandidates: rawCandidates.length,
        uniqueRawCandidates: uniqueRawCandidates.length,
        skippedOld: skippedOld,
        skippedLazyLoaded: skippedLazyLoaded,
        confirmed: confirmed.length,
        uniqueConfirmed: uniqueConfirmed.length,
        pending: uniquePending.length,
        failed: uniqueFailed.length,
        freshFailed: freshFailedIds.size,
        stableFailed: stableFailedIds.size,
        expected: payload.quantity,
        waitedMs: waitedMs,
      }))

      // PENDING_SIGNAL_DEBUG — log every pending candidate when we have
      // confirmed + pending coexistence. This is the primary debug signal
      // for detector regressions: if tileHasFailureSignals() is missing
      // the UI card, we will see textPreview/iconTexts/buttonTexts here.
      if (uniqueConfirmed.length > 0 && uniquePending.length > 0) {
        for (var psi = 0; psi < uniquePending.length; psi++) {
          var pTile = uniquePending[psi]
          var pSeen = failedFirstSeenAt[pTile.id] || 0
          var pAge = pSeen ? nowMs - pSeen : 0
          flowDebug('[FlowContent][PENDING_SIGNAL_DEBUG]', JSON.stringify({
            tileId: pTile.id,
            status: pTile.status,
            statusReason: pTile.statusReason || '',
            textPreview: pTile.textPreview || '',
            fileName: pTile.fileName || '',
            failedFirstSeenAt: pSeen,
            failedAgeMs: pAge,
            hasVideo: pTile.hasVideo || false,
            hasImg: pTile.hasImg || false,
            videoSrc: pTile.videoSrc || '',
            videoCurrentSrc: pTile.videoCurrentSrc || '',
            videoPoster: pTile.videoPoster || '',
            imgSrc: pTile.imgSrc || '',
            imgAlt: pTile.imgAlt || '',
            iconTexts: pTile.iconTexts || [],
            buttonTexts: pTile.buttonTexts || [],
            className: (pTile.className || '').slice(0, 120),
          }))
        }
      }

      // SUCCESS_SIGNAL_DEBUG — log pending tiles that have media ready when
      // stableFailed > 0. This shows why video tiles with visible media are
      // still stuck at pending (no fileName UUID yet), so we know when to
      // apply the provisionalDone path.
      if (stableFailedIds.size > 0) {
        for (var ssi = 0; ssi < uniquePending.length; ssi++) {
          var sTile = uniquePending[ssi]
          var sHasMedia = !!(sTile.hasVideo || sTile.hasImg)
          if (!sHasMedia) continue
          flowDebug('[FlowContent][SUCCESS_SIGNAL_DEBUG]', JSON.stringify({
            tileId: sTile.id,
            status: sTile.status,
            fileName: sTile.fileName || '',
            hasVideo: sTile.hasVideo || false,
            hasImg: sTile.hasImg || false,
            videoSrc: sTile.videoSrc || '',
            videoCurrentSrc: sTile.videoCurrentSrc || '',
            videoPoster: sTile.videoPoster || '',
            imgSrc: sTile.imgSrc || '',
            imgAlt: sTile.imgAlt || '',
            textPreview: (sTile.textPreview || '').slice(0, 100),
            statusReason: sTile.statusReason || '',
          }))
        }
      }
      if (uniqueConfirmed.length >= payload.quantity) {
        // Preserve DOM order from the most recent snapshot
        var confirmedSet = new Set(uniqueConfirmed.map(function (c) { return c.id }))
        var orderedConfirmed: Array<{ id: string; status: string; fileName: string }> = []
        for (var oi = 0; oi < lastDomOrder.length; oi++) {
          if (confirmedSet.has(lastDomOrder[oi])) {
            var match = uniqueConfirmed.find(function (c) { return c.id === lastDomOrder[oi] })
            if (match) orderedConfirmed.push(match)
          }
        }
        // Dedupe orderedConfirmed one more time before slicing
        var uniqueOrderedConfirmed = dedupeTilesByIdentity(orderedConfirmed)
        flowDebug('[FlowContent][RESULT_ORDER_DEBUG]', JSON.stringify({
          orderedConfirmed: orderedConfirmed.map(function (c) { return c.id }),
          uniqueOrderedConfirmed: uniqueOrderedConfirmed.map(function (c) { return { id: c.id, fileName: c.fileName, status: c.status } }),
        }))

        // Hard cap: only download the most recent expectedQuantity UNIQUE tiles.
        var finalTiles = pickExpectedUniqueResultTiles(uniqueOrderedConfirmed, payload.quantity)

        if (uniqueOrderedConfirmed.length > payload.quantity) {
          console.warn('[FlowContent][RESULT_DETECT_WARN]', JSON.stringify({
            expected: payload.quantity,
            actual: uniqueOrderedConfirmed.length,
            action: 'cap_to_expected',
            reason: 'too_many_unique_candidates',
          }))
        }

        // Store as a list of { tileId, fileName } for downstream download
        newTileIds = finalTiles.map(function (c) { return c.id })
        newTilesFullData = finalTiles
        cleanupObserver()
        break
      }

      // ── Provisional grace: no confirmed but media ready + stable failed ────
      // When confirmed=0, stableFailed>0, and there are tiles with video/img
      // media ready (provisionalDone), wait up to 2s for confirmed tiles to
      // appear. After the grace window, use provisional tiles as targets.
      var hasProvisional = uniquePending.some(function (p) {
        return !!(p.hasVideo || p.hasImg) && p.status !== 'failed'
      })
      if (uniqueConfirmed.length === 0 && stableFailedIds.size > 0 && hasProvisional) {
        if (provisionalMediaSeenAt === 0) provisionalMediaSeenAt = nowMs
        var provisionalElapsed = nowMs - provisionalMediaSeenAt
        if (provisionalElapsed >= PROVISIONAL_GRACE_MS) {
          console.warn('[FlowContent][RESULT_COLLECTION_PARTIAL_EARLY_EXIT]', JSON.stringify({
            reason: 'provisional_grace_expired',
            expected: payload.quantity,
            confirmed: 0,
            stableFailed: stableFailedIds.size,
            provisionalDone: uniquePending.filter(function (p) { return !!(p.hasVideo || p.hasImg) }).length,
            waitedMs: waitedMs,
            graceMs: provisionalElapsed,
            tileIds: uniquePending.filter(function (p) { return !!(p.hasVideo || p.hasImg) }).map(function (p) { return p.id }),
          }))
          newTilesFullData = uniquePending.filter(function (p) { return !!(p.hasVideo || p.hasImg) })
          cleanupObserver()
          break
        }
        // Within grace window: keep polling
      } else {
        // Any confirmed tile appearing resets the provisional clock.
        provisionalMediaSeenAt = 0
      }

      // ── Partial branch: confirmed > 0 AND stable-failed > 0 ────────────
      // Flow already signaled partial: at least one tile is fully done
      // and at least one tile has been failing for >= MIN_FAIL_DETECT_MS.
      //
      // BUT we must NOT exit early if the pending set still has room
      // for more confirmed tiles to reach the partial-success target.
      // Target semantics:
      //   targetSuccessful = expectedQuantity - failed.length
      //   e.g. expected=3 failed=1 → target=2 → we need 2 confirmed.
      //   e.g. expected=3 failed=2 → target=1 → we need 1 confirmed.
      //   e.g. expected=3 failed=3 → target=0 → nothing to download.
      //
      // Pre-fix behavior: exited at `confirmed>0 AND failed>0`
      // regardless of pending, which dropped outputs when a confirmed
      // tile would have arrived shortly after the failed tile. With
      // expected=3, confirmed=1, failed=1, pending=1 the legacy code
      // reported outputsCount=1 even though Flow was still painting
      // the second confirmed tile. The fix:
      //   exit when confirmed >= target OR pending.length === 0.
      // Pending=0 means "Flow is done emitting tiles" so any
      // confirmed we have IS the partial answer.
      var targetSuccessful = Math.max(0, payload.quantity - failed.length)
      if (uniqueConfirmed.length >= targetSuccessful && failed.length > 0) {
        console.warn('[FlowContent][RESULT_COLLECTION_PARTIAL_EARLY_EXIT]', JSON.stringify({
          reason: 'confirmed_and_stable_failed_coexist',
          expected: payload.quantity,
          confirmed: uniqueConfirmed.length,
          failed: failed.length,
          freshFailed: freshFailedIds.size,
          pending: uniquePending.length,
          targetSuccessful: targetSuccessful,
          waitedMs: waitedMs,
        }))
        cleanupObserver()
        // Mark newTilesFullData as the confirmed set so the post-loop branch
        // picks the partial path.
        newTilesFullData = uniqueConfirmed
        break
      }
      // Stable-failed with no remaining pending: nothing more to wait
      // for. Take the confirmed partial set as the final answer even
      // if confirmed < target (Flow has painted all its tiles).
      if (uniqueConfirmed.length > 0 && failed.length > 0 && uniquePending.length === 0) {
        console.warn('[FlowContent][RESULT_COLLECTION_PARTIAL_EARLY_EXIT]', JSON.stringify({
          reason: 'confirmed_failed_pending_zero',
          expected: payload.quantity,
          confirmed: uniqueConfirmed.length,
          failed: failed.length,
          pending: 0,
          targetSuccessful: targetSuccessful,
          waitedMs: waitedMs,
        }))
        cleanupObserver()
        newTilesFullData = uniqueConfirmed
        break
      }

      // ── Video partial grace fallback: no failed icon detected ─────────
      // This is a FALLBACK path. The primary exit is the
      // confirmed + stable-failed branch above. We reach this branch only
      // when Flow never painted a failure icon AND confirmed > 0 but
      // confirmed < expectedQuantity. Without a failed-icon signal we
      // cannot tell which tiles are stuck — the short 8s grace gives
      // them one more chance to settle. After that, download confirmed.
      if (
        payload.mode === 'video' &&
        uniqueConfirmed.length > 0 &&
        uniqueConfirmed.length < payload.quantity &&
        failed.length === 0 &&                       // no failed icon detected
        freshFailedIds.size === 0 &&                 // no transient failed either
        lastProgressMs > 0 &&
        (waitedMs - lastProgressMs) >= VIDEO_PARTIAL_GRACE_MS
      ) {
        var noProgressMs = waitedMs - lastProgressMs
        console.warn('[FlowContent][AUTO_DOWNLOAD_VIDEO_PARTIAL_GRACE]', JSON.stringify({
          expected: payload.quantity,
          confirmed: uniqueConfirmed.length,
          pending: uniquePending.length,
          failed: failed.length,
          noProgressMs: noProgressMs,
          waitedMs: waitedMs,
        }))
        newTilesFullData = uniqueConfirmed
        cleanupObserver()
        break
      }
    }

    // Unconditional cleanup. The observer is set up once and must be
    // disconnected whether we exited via break (success / partial /
    // grace) or fell through to maxWaitMs.
    cleanupObserver()

    // Promote pending tiles that have been showing a failed signal for
    // >= MIN_FAIL_DETECT_MS (by firstSeen OR by elapsed time).
    var promotedFailedFromPending: Array<{ id: string; status: string; fileName: string }> = []
    var pendingIds = Object.keys(pendingCandidatesById)
    for (var pfi = 0; pfi < pendingIds.length; pfi++) {
      var pendingTile = pendingCandidatesById[pendingIds[pfi]]
      var pSeen = failedFirstSeenAt[pendingTile.id]
      var pAgeMs = pSeen ? Date.now() - pSeen : 0
      var pStableByFirstSeen = pAgeMs >= MIN_FAIL_DETECT_MS
      var pStableByElapsed = waitedMs >= MIN_FAIL_DETECT_MS
      var pIsStable = pStableByFirstSeen || pStableByElapsed
      if (pendingTile.status === 'failed' && pIsStable) {
        promotedFailedFromPending.push(pendingTile)
      }
    }
    if (promotedFailedFromPending.length > 0) {
      console.warn('[FlowContent][PENDING_PROMOTED_TO_FAILED]', JSON.stringify({
        reason: 'failed_signal_stable_for_min_fail_detect_ms',
        count: promotedFailedFromPending.length,
        ids: promotedFailedFromPending.map(function (t) { return t.id }),
        minFailDetectMs: MIN_FAIL_DETECT_MS,
      }))
    }

    // ── Determine what to download after polling loop ─────────────────────
    // Build three separate sets from the last polling snapshot:
    // - confirmed: status=done, fileName valid (from last loop iteration)
    // - pending: status=processing or status=done but no valid fileName
    // - failed: tiles that reached a terminal state but with no valid identity
    var afterLoopConfirmed = dedupeTilesByIdentity(confirmed)
    var afterLoopPending = dedupeTilesByIdentity(Object.values(pendingCandidatesById))

    // ── Strict reject: suspicious-done-without-processing NEVER downloads ──
    // A done tile whose identity was never observed as non-terminal after
    // submit is rejected — full stop. If `afterLoopConfirmed` is empty as a
    // result, the auto-download path downstream will fail with
    // AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS rather than downloading a stale
    // tile from a previous run that Flow lazily re-mounted.
    if (suspiciousDoneWithoutProcessing.length > 0) {
      console.warn('[FlowContent][RESULT_DETECT_SUSPICIOUS_DONE_WITHOUT_PROCESSING]', JSON.stringify({
        reason: 'strict_reject_never_seen_as_processing_after_submit',
        suspiciousCount: suspiciousDoneWithoutProcessing.length,
        allSuspiciousIds: suspiciousDoneWithoutProcessing.map(function (t) { return t.id }),
        allSuspiciousFileNames: suspiciousDoneWithoutProcessing.map(function (t) { return t.fileName }),
        confirmedAfterStrictFilter: afterLoopConfirmed.length,
        waitedMs: waitedMs,
        outcome: afterLoopConfirmed.length === 0
          ? 'auto_download_will_fail_no_success'
          : 'suspicious_tile_excluded_real_result_will_download',
      }))
    }
    // failed = raw tiles that are neither confirmed nor pending (e.g. status=failed,
    // or id collision with no fileName). We track them from the last snapshot.
    var afterLoopAll: Array<{
        id: string; status: string; fileName: string
        failedFirstSeenAt?: number; statusReason?: string
        hasVideo?: boolean; hasImg?: boolean
        videoSrc?: string; videoCurrentSrc?: string; videoPoster?: string
        imgSrc?: string; imgAlt?: string; mediaReadyReason?: string
      }> = []
    var allSnapTilesLatest = ((snapResult as Record<string, unknown>).details as Array<{
        id: string; status: string; fileName: string
        failedFirstSeenAt?: number; statusReason?: string
        hasVideo?: boolean; hasImg?: boolean
        videoSrc?: string; videoCurrentSrc?: string; videoPoster?: string
        imgSrc?: string; imgAlt?: string; mediaReadyReason?: string
      }>) || []
    for (var alci = 0; alci < allSnapTilesLatest.length; alci++) {
      var at = allSnapTilesLatest[alci]
      if (preSubmitIdSet.has(at.id)) continue
      if (at.fileName && preSubmitFileNameSet.has(at.fileName)) continue
      if (refIdSet.has(at.id)) continue
      if (at.fileName && refFileNameSet.has(at.fileName)) continue
      afterLoopAll.push(at)
    }
    // Apply MIN_FAIL_DETECT_MS guard (firstSeen OR elapsed) to after-loop failed.
    var afterLoopFailed: Array<{ id: string; status: string; fileName: string }> = []
    var afterLoopFreshFailedCount = 0
    var nowLoopMs = Date.now()
    for (var alfLoop = 0; alfLoop < afterLoopAll.length; alfLoop++) {
      var alt = afterLoopAll[alfLoop]
      var isFailedStatus = alt.status === 'failed'
      var isDoneButNoFile = alt.status === 'done' && (!alt.fileName || alt.fileName.length < 4 || alt.fileName === 'media.getMediaUrlRedirect')
      var isNonDoneNonFailed = alt.status !== 'done' && alt.status !== 'failed'
      if (!isFailedStatus && !isDoneButNoFile && !isNonDoneNonFailed) continue
      if (isFailedStatus) {
        var altSeen = failedFirstSeenAt[alt.id] || 0
        var altAgeMs = nowLoopMs - altSeen
        var altStableByFirstSeen = altAgeMs >= MIN_FAIL_DETECT_MS
        var altStableByElapsed = waitedMs >= MIN_FAIL_DETECT_MS
        if (!altStableByFirstSeen && !altStableByElapsed) {
          afterLoopFreshFailedCount++
          continue
        }
      }
      afterLoopFailed.push(alt)
    }
    // Merge promoted failed-from-pending into afterLoopFailed.
    for (var pfl = 0; pfl < promotedFailedFromPending.length; pfl++) {
      var pf = promotedFailedFromPending[pfl]
      var alreadyInFailed = false
      for (var afc = 0; afc < afterLoopFailed.length; afc++) {
        if (afterLoopFailed[afc].id === pf.id) { alreadyInFailed = true; break }
      }
      if (!alreadyInFailed) afterLoopFailed.push(pf)
    }
    var uniqueFailed = dedupeTilesByIdentity(afterLoopFailed)

    // provisionalDone: tiles that have video/img media ready but no fileName UUID yet.
    // These are video tiles where the video is visible at ~30s but fileName resolves
    // at ~52s. We accept them when stableFailed > 0 (partial result) and the tile
    // is not in pre-submit / ref / failed sets.
    var provisionalDone: typeof afterLoopConfirmed = []
    if (afterLoopConfirmed.length === 0 && uniqueFailed.length > 0) {
      for (var provI = 0; provI < allSnapTilesLatest.length; provI++) {
        var pt = allSnapTilesLatest[provI]
        if (pt.status === 'failed' && stableFailedIds.has(pt.id)) continue
        if (preSubmitIdSet.has(pt.id)) continue
        if (pt.fileName && preSubmitFileNameSet.has(pt.fileName)) continue
        if (refIdSet.has(pt.id)) continue
        if (pt.fileName && refFileNameSet.has(pt.fileName)) continue
        // Strict recency guard: provisionalDone must also be a tile we
        // observed as non-terminal after submit. Otherwise Flow's
        // lazy-loaded old tiles with stale media would slip through the
        // provisional path even though Stage 2 already rejected them.
        var provSeen = seenProcessingIds.has(pt.id) ||
          (pt.fileName && seenProcessingFileNames.has(pt.fileName))
        if (!provSeen) continue
        var ptMediaReady = !!(pt.hasVideo || pt.hasImg)
        if (!ptMediaReady) continue
        // statusReason='none' + mediaReady means processing but media visible
        // (typical video tile: status=generating, videoSrc has value)
        if (pt.status === 'failed') continue
        provisionalDone.push(pt as typeof provisionalDone[0])
      }
      if (provisionalDone.length > 0) {
        flowDebug('[FlowContent][AUTO_DOWNLOAD_VIDEO_PROVISIONAL_CONFIRMED]', JSON.stringify({
          count: provisionalDone.length,
          tileIds: provisionalDone.map(function (t) { return t.id }),
          waitedMs: waitedMs,
          reason: 'no_confirmed_but_media_ready',
        }))
      }
    }

    // Case 1: zero confirmed tiles → nothing to download, fail hard.
    if (afterLoopConfirmed.length === 0 && provisionalDone.length === 0) {
      console.error('[FlowContent][AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS]', JSON.stringify({
        expected: payload.quantity,
        confirmed: 0,
        pending: afterLoopPending.length,
        failed: uniqueFailed.length,
      }))
      // Populate generation / downloadDetails even on hard failure so
      // downstream consumers (runner, GenPanel, workflow preview)
      // can render the same counters regardless of whether the run
      // succeeded or failed. Keeping these blocks identical in shape
      // to the success path means callers only need to read one set
      // of fields.
      autoDownloadResult = {
        successCount: 0,
        failCount: 0,
        skippedCount: 0,
        attempted: shouldAutoDownload,
        skipped: !shouldAutoDownload,
        source: payloadSource,
        error: 'AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS',
      }
      // RESULT_COLLECTION_DONE always fires — independent of
      // download gate. Even on hard failure, log the counters so
      // operators can grep for the exact reason.
      console.log('[FlowContent][RESULT_COLLECTION_DONE]', JSON.stringify({
        generationExpected: payload.quantity,
        generationGenerated: 0,
        generationFailed: uniqueFailed.length,
        generationPending: afterLoopPending.length,
        generationPartial: true,
        // status mirrors the response.status string so log and
        // payload stay in lockstep — operators greping one field
        // can find the other. The new normalizedStatus field
        // exposes the canonical FLOW_SUBMIT_PARTIAL_FAILURE class
        // for callers that want a single semantic status across
        // success / partial / failure paths.
        status: 'AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS',
        normalizedStatus: 'FLOW_SUBMIT_PARTIAL_FAILURE',
        success: false,
        outputsCount: 0,
        outputsAvailableCount: 0,
        outputsDownloadedCount: 0,
        outputsSkippedCount: 0,
        downloadAttempted: shouldAutoDownload,
        downloadSuccessCount: 0,
        downloadFailCount: 0,
        downloadSkippedCount: 0,
        totalFailedCount: uniqueFailed.length,
        source: payloadSource,
      }))
      return {
        success: false,
        status: 'AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS',
        error: 'No successful result tiles. expected=' + payload.quantity,
        bridgeReady: true,
        autoDownload: autoDownloadResult,
        generation: {
          expected: payload.quantity,
          generated: 0,
          failed: uniqueFailed.length,
          pending: afterLoopPending.length,
          partial: true,
        },
        downloadDetails: {
          expected: payload.quantity,
          generated: 0,
          generationFailedCount: uniqueFailed.length,
          generationPendingCount: afterLoopPending.length,
          generationPartial: true,
          downloadAttempted: shouldAutoDownload,
          downloaded: 0,
          skipped: 0,
          generationFailedCount_legacy: uniqueFailed.length,
          generationPendingCount_legacy: afterLoopPending.length,
        },
        outputsCount: 0,
        outputsAvailableCount: 0,
        outputsDownloadedCount: 0,
        outputsSkippedCount: 0,
        outputs: [],
        images: [],
        imageUrls: [],
      }
    }

    // Case 2: partial — some confirmed but not enough → warn and download confirmed only.
    // If confirmed=0 but provisionalDone > 0, use provisional tiles as targets.
    var isPartialResult = afterLoopConfirmed.length < payload.quantity
    var finalTargets: Array<{ id: string; status: string; fileName: string }> = []
    if (afterLoopConfirmed.length === 0 && provisionalDone.length > 0) {
      // Use provisional tiles as download targets (no fileName → prompt/index/resolution filename).
      console.warn('[FlowContent][RESULT_COLLECTION_PARTIAL_EARLY_EXIT]', JSON.stringify({
        reason: 'provisional_done_used',
        expected: payload.quantity,
        confirmed: afterLoopConfirmed.length,
        provisionalDone: provisionalDone.length,
        failed: uniqueFailed.length,
        tileIds: provisionalDone.map(function (t) { return t.id }),
      }))
      var provOrdered: typeof finalTargets = []
      var provSet = new Set(provisionalDone.map(function (p) { return p.id }))
      for (var provOi = 0; provOi < lastDomOrder.length; provOi++) {
        if (provSet.has(lastDomOrder[provOi])) {
          var provMatch = provisionalDone.find(function (p) { return p.id === lastDomOrder[provOi] })
          if (provMatch) provOrdered.push(provMatch)
        }
      }
      finalTargets = dedupeTilesByIdentity(provOrdered)
    } else if (isPartialResult) {
      console.warn('[FlowContent][RESULT_COLLECTION_PARTIAL_RESULTS]', JSON.stringify({
        expected: payload.quantity,
        confirmed: afterLoopConfirmed.length,
        pending: afterLoopPending.length,
        failed: uniqueFailed.length,
        tileIds: afterLoopConfirmed.map(function (t) { return t.id }),
        fileNames: afterLoopConfirmed.map(function (t) { return t.fileName }),
      }))
      // Download every unique confirmed tile in DOM order.
      var partialSet = new Set(afterLoopConfirmed.map(function (c) { return c.id }))
      var partialOrdered: Array<{ id: string; status: string; fileName: string }> = []
      for (var poi = 0; poi < lastDomOrder.length; poi++) {
        if (partialSet.has(lastDomOrder[poi])) {
          var pm = afterLoopConfirmed.find(function (c) { return c.id === lastDomOrder[poi] })
          if (pm) partialOrdered.push(pm)
        }
      }
      finalTargets = dedupeTilesByIdentity(partialOrdered)
    } else {
      // Case 3: full — we have all expected confirmed tiles from the loop break.
      // Preserve DOM order and cap to expectedQuantity.
      var fullSet = new Set((newTilesFullData || []).map(function (c) { return c.id }))
      var fullOrdered: Array<{ id: string; status: string; fileName: string }> = []
      for (var foi = 0; foi < lastDomOrder.length; foi++) {
        if (fullSet.has(lastDomOrder[foi])) {
          var fm = (newTilesFullData || []).find(function (c) { return c.id === lastDomOrder[foi] })
          if (fm) fullOrdered.push(fm)
        }
      }
      var uniqueFullOrdered = dedupeTilesByIdentity(fullOrdered)
      if (uniqueFullOrdered.length > payload.quantity) {
        console.warn('[FlowContent][RESULT_DETECT_WARN]', JSON.stringify({
          expected: payload.quantity,
          actual: uniqueFullOrdered.length,
          action: 'cap_to_expected_after_dedupe',
          reason: 'too_many_unique_candidates',
        }))
      }
      finalTargets = pickExpectedUniqueResultTiles(uniqueFullOrdered, payload.quantity)
    }

    // ── Duplicate guard ─────────────────────────────────────────────────
    if (finalTargets.length !== dedupeTilesByIdentity(finalTargets).length) {
      console.error('[FlowContent][AUTO_DOWNLOAD_DUPLICATE_TARGETS_BLOCKED]', JSON.stringify({
        beforeCount: finalTargets.length,
        afterCount: dedupeTilesByIdentity(finalTargets).length,
        beforeIds: finalTargets.map(function (t) { return t.id }),
        afterIds: dedupeTilesByIdentity(finalTargets).map(function (t) { return t.id }),
      }))
      autoDownloadResult = {
        successCount: 0,
        failCount: finalTargets.length,
        error: 'AUTO_DOWNLOAD_DUPLICATE_TARGETS_BLOCKED',
      }
      console.log('[FlowContent][AUTO_DOWNLOAD_DONE]', JSON.stringify(autoDownloadResult))
      return {
        success: false,
        status: 'AUTO_DOWNLOAD_DUPLICATE_TARGETS_BLOCKED',
        error: 'AUTO_DOWNLOAD_DUPLICATE_TARGETS_BLOCKED',
        bridgeReady: true,
        autoDownload: autoDownloadResult,
      }
    }

    console.log('[FlowContent][AUTO_DOWNLOAD_TARGETS_PRE]', JSON.stringify({
      count: finalTargets.length,
      expected: payload.quantity,
      partial: isPartialResult,
      mode: normMode,
      tileIds: finalTargets.map(function (t) { return t.id }),
      fileNames: finalTargets.map(function (t) { return t.fileName }),
    }))

    // ── Defense-in-depth: classification + success-only filter ─────────
    // Re-check each target's status against the last snapshot. A target
    // may have flipped to 'failed' between the polling loop and now.
    // Generation-failed tiles MUST NEVER enter AUTO_DOWNLOAD_TARGETS.
    var allSnapTilesFinal = ((snapResult as Record<string, unknown>).details as Array<{ id: string; fileName: string; status: string }>) || []
    var finalSnapById: Record<string, { id: string; fileName: string; status: string }> = {}
    for (var fsi = 0; fsi < allSnapTilesFinal.length; fsi++) {
      var fst = allSnapTilesFinal[fsi]
      finalSnapById[fst.id] = fst
    }
    var successTargets: Array<{ id: string; fileName: string; status: string }> = []
    var failedTargets: Array<{ id: string; fileName: string; status: string }> = []
    var pendingTargets: Array<{ id: string; fileName: string; status: string }> = []
    function hasValidFileName(fn: string | undefined | null): boolean {
      return !!(fn && fn.length >= 4 && fn !== 'media.getMediaUrlRedirect')
    }
    for (var cli = 0; cli < finalTargets.length; cli++) {
      var candTarget = finalTargets[cli]
      var snap = finalSnapById[candTarget.id]
      var status = snap ? snap.status : candTarget.status
      var fileName = (snap && snap.fileName) || candTarget.fileName
      if (status === 'failed') {
        // Generation failed — log explicitly and exclude from download.
        failedTargets.push(candTarget)
      } else if ((status === 'done' || status === 'success') && hasValidFileName(fileName)) {
        // Only done/success tiles with a valid fileName are eligible.
        successTargets.push(candTarget)
      } else {
        // Anything else (processing / status unknown / missing fileName) is
        // pending. We will NOT download it — log explicitly and exclude.
        pendingTargets.push(candTarget)
      }
    }
    flowDebug('[FlowContent][VIDEO_RESULT_CLASSIFY]', JSON.stringify({
      expected: payload.quantity,
      success: successTargets.length,
      failed: failedTargets.length,
      pending: pendingTargets.length,
      successTileIds: successTargets.map(function (t) { return t.id }),
      successFileNames: successTargets.map(function (t) { return t.fileName }),
      failedTileIds: failedTargets.map(function (t) { return t.id }),
      failedStatuses: failedTargets.map(function (t) { return t.status }),
      pendingTileIds: pendingTargets.map(function (t) { return t.id }),
      pendingStatuses: pendingTargets.map(function (t) { return t.status }),
    }))
    if (failedTargets.length > 0) {
      console.warn('[FlowContent][VIDEO_RESULT_FAILED_DROPPED]', JSON.stringify({
        reason: 'generation_failed_tiles_excluded',
        count: failedTargets.length,
        tileIds: failedTargets.map(function (t) { return t.id }),
        statuses: failedTargets.map(function (t) { return t.status }),
      }))
    }
    if (pendingTargets.length > 0) {
      console.warn('[FlowContent][VIDEO_RESULT_PENDING_DROPPED]', JSON.stringify({
        reason: 'pending_or_invalid_filename_tiles_excluded',
        count: pendingTargets.length,
        tileIds: pendingTargets.map(function (t) { return t.id }),
        statuses: pendingTargets.map(function (t) { return t.status }),
      }))
    }
    // Replace finalTargets with the success-only filtered list. Failed and
    // pending tiles are logged above and excluded — they are NEVER eligible
    // for download. Even when successTargets.length < expectedQuantity we
    // still download every successful tile (best-effort: download every
    // success tile regardless of quantity, report partial if not full).
    finalTargets = successTargets
    if (finalTargets.length === 0) {
      console.error('[FlowContent][AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS]', JSON.stringify({
        expected: payload.quantity,
        confirmed: 0,
        failed: failedTargets.length,
        pending: pendingTargets.length,
      }))
      // Hard failure after classification: 0 valid download targets.
      // generation{} / downloadDetails{} still populated so callers
      // see the same counter shape regardless of success / failure.
      autoDownloadResult = {
        successCount: 0,
        failCount: 0,
        skippedCount: 0,
        attempted: shouldAutoDownload,
        skipped: !shouldAutoDownload,
        source: payloadSource,
        error: 'AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS',
      }
      // RESULT_COLLECTION_DONE always fires — single source of
      // truth for the operator-facing counter dump. `status`
      // mirrors response.status so log and payload stay aligned;
      // `normalizedStatus` exposes the canonical generation-level
      // status class for callers that want one semantic across
      // success / partial / failure paths. Legacy
      // AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS callers keep matching
      // via response.status.
      console.log('[FlowContent][RESULT_COLLECTION_DONE]', JSON.stringify({
        generationExpected: payload.quantity,
        generationGenerated: 0,
        generationFailed: failedTargets.length,
        generationPending: pendingTargets.length,
        generationPartial: true,
        status: 'AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS',
        normalizedStatus: 'FLOW_SUBMIT_PARTIAL_FAILURE',
        success: false,
        outputsCount: 0,
        outputsAvailableCount: 0,
        outputsDownloadedCount: 0,
        outputsSkippedCount: 0,
        downloadAttempted: shouldAutoDownload,
        downloadSuccessCount: 0,
        downloadFailCount: 0,
        downloadSkippedCount: 0,
        totalFailedCount: failedTargets.length,
        source: payloadSource,
      }))
      return {
        success: false,
        status: 'AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS',
        error: 'No successful result tiles after classification. expected=' + payload.quantity,
        bridgeReady: true,
        autoDownload: autoDownloadResult,
        generation: {
          expected: payload.quantity,
          generated: 0,
          failed: failedTargets.length,
          pending: pendingTargets.length,
          partial: true,
        },
        downloadDetails: {
          expected: payload.quantity,
          generated: 0,
          generationFailedCount: failedTargets.length,
          generationPendingCount: pendingTargets.length,
          generationPartial: true,
          downloadAttempted: shouldAutoDownload,
          downloaded: 0,
          skipped: 0,
          generationFailedCount_legacy: failedTargets.length,
          generationPendingCount_legacy: pendingTargets.length,
        },
        outputsCount: 0,
        outputsAvailableCount: 0,
        outputsDownloadedCount: 0,
        outputsSkippedCount: 0,
        outputs: [],
        images: [],
        imageUrls: [],
      }
    }
    // Update isPartialResult to reflect the post-classification count.
    isPartialResult = finalTargets.length < payload.quantity
    console.log('[FlowContent][AUTO_DOWNLOAD_TARGETS_FINAL]', JSON.stringify({
      count: finalTargets.length,
      expected: payload.quantity,
      partial: isPartialResult,
      tileIds: finalTargets.map(function (t) { return t.id }),
      fileNames: finalTargets.map(function (t) { return t.fileName }),
    }))

    var successCount = 0
    var failCount = 0
    // Tracks tiles whose chrome.downloads.download call was
    // deliberately skipped (workflow / suppressed callers). Kept
    // separate from `failCount` because a skip is not a failure.
    var skippedCount = 0
    var tileErrors: Array<{ tileId: string; error: string; directSrc?: string; fileName?: string }> = []
    // Per-tile output asset descriptors. These power the workflow node
    // output preview (UI thumbnail) AND the downstream Generate/Download
    // node inputs (via runner.coerceMediaList). Fields mirror the runner's
    // expected media shape so coerceMediaList will accept each entry.
    var outputAssets: Array<Record<string, unknown>> = []
    // Map tileId → rich snapshot (thumbnail / imgSrc / videoSrc). One
    // snapshot at the start of the loop is enough — by the time the loop
    // opens each tile, all `done` tiles have their media URLs stable.
    var tileMediaMap: Record<string, { thumbnail?: string; imgSrc?: string; videoSrc?: string; videoPoster?: string; hasVideo?: boolean; hasImg?: boolean }> = {}
    try {
      var preSnap = (await bridgeCall('getTileSnapshot', {}, 5000)) as Record<string, unknown>
      var preSnapTiles = (preSnap.details as Array<Record<string, unknown>>) || []
      for (var psi = 0; psi < preSnapTiles.length; psi++) {
        var st = preSnapTiles[psi]
        if (st && typeof st.id === 'string' && st.id) {
          tileMediaMap[st.id] = {
            thumbnail: typeof st.thumbnail === 'string' ? st.thumbnail : '',
            imgSrc: typeof st.imgSrc === 'string' ? st.imgSrc : '',
            videoSrc: typeof st.videoSrc === 'string' ? st.videoSrc : '',
            videoPoster: typeof st.videoPoster === 'string' ? st.videoPoster : '',
            hasVideo: !!st.hasVideo,
            hasImg: !!st.hasImg,
          }
        }
      }
    } catch (_) { /* non-fatal: tile-media map is best-effort */ }
    for (var di = 0; di < finalTargets.length; di++) {
      var tileEntry = finalTargets[di]
      var tileId = tileEntry.id
      var tileFileName = tileEntry.fileName
      var tileIndex = di + 1

      // Hard gate: tile must have a valid fileName to download.
      // A done tile with empty/wrong fileName is an identity failure.
      if (!tileFileName || tileFileName.length < 4 || tileFileName === 'media.getMediaUrlRedirect') {
        console.warn('[FlowContent][RESULT_TILE_IDENTITY_TIMEOUT]', JSON.stringify({
          tileId: tileId,
          fileName: tileFileName || '(empty)',
          reason: 'tile_passed_filter_but_fileName_invalid',
        }))
        failCount++
        continue
      }

      // Poll tile status (up to 60s) — confirm still done before download.
    // FAST-EXIT: if the tile is already 'failed' in the very first poll,
    // skip immediately. No point waiting 60s for a tile Flow has already
    // marked as failed. The batch MUST NOT halt on this — increment
    // failCount and continue to the next target.
    var tileReady = false
    var finalTileData: { id: string; fileName: string; status: string; thumbnail?: string; imgSrc?: string; videoSrc?: string; videoPoster?: string; hasVideo?: boolean; hasImg?: boolean } | null = null
    var firstStatus = await bridgeCall('getTileSnapshot', {}, 5000)
    var firstSnapTiles = ((firstStatus as Record<string, unknown>).details as Array<{ id: string; fileName: string; status: string; thumbnail?: string; imgSrc?: string; videoSrc?: string; videoPoster?: string; hasVideo?: boolean; hasImg?: boolean }>) || []
    var firstTarget = firstSnapTiles.find(function (t) { return t.id === tileId })
    if (firstTarget && firstTarget.status === 'failed') {
      console.warn('[FlowContent][AUTO_DOWNLOAD] tile status=failed, skipping', JSON.stringify({
        tileId: tileId,
        fileName: tileFileName,
      }))
      failCount++
      continue
    }
    for (var pi = 0; pi < 30; pi++) {
      await new Promise(r => setTimeout(r, 2000))
      var statusResult = await bridgeCall('getTileSnapshot', {}, 5000)
      var snapTiles = ((statusResult as Record<string, unknown>).details as Array<{ id: string; fileName: string; status: string; thumbnail?: string; imgSrc?: string; videoSrc?: string; videoPoster?: string; hasVideo?: boolean; hasImg?: boolean }>) || []
      var targetTile = snapTiles.find(function (t) { return t.id === tileId })
      if (targetTile) {
        finalTileData = targetTile
        if (targetTile.status === 'done') {
          tileReady = true
          // Re-check fileName on each poll
          if (targetTile.fileName && targetTile.fileName.length > 4 && targetTile.fileName !== 'media.getMediaUrlRedirect') {
            tileFileName = targetTile.fileName
          }
          break
        }
        if (targetTile.status === 'failed') {
          // Tile flipped to failed mid-poll — skip it.
          break
        }
      }
    }

    if (!tileReady) {
      console.warn('[FlowContent][AUTO_DOWNLOAD] tile not ready/failed, skipping', JSON.stringify({
        tileId: tileId,
        status: finalTileData?.status || 'unknown',
      }))
      failCount++
      continue
    }

      // Log confirmed result tile with full identity
      console.log('[FlowContent][RESULT_TILE]', JSON.stringify({
        tileId: tileId,
        fileName: tileFileName,
        status: finalTileData?.status || 'done',
      }))

      // Build filename and prepare rename via background
      var promptText = payload.prompt || 'flow'
      // Filename MUST use the resolution that matches the tile's media
      // kind. For video runs the tile file name uses `videoResolution`
      // (e.g. 720p); for image runs it uses `downloadResolution` (e.g.
      // 2k). Using `downloadResolution` for a video tile was producing
      // filenames like `..._2k.mp4` while the menu actually clicked 720p.
      var filenameResolution = normMode === 'video' ? normVideoResolution : normDownloadResolution
      var fileName = buildDownloadFilename(promptText, tileIndex, normOutputFolder, filenameResolution)

      // Per-tile download — gated by `shouldAutoDownload`. Workflow
      // callers and any future caller with `suppressAutoDownload: true`
      // skip the bridge.downloadTileMedia + chrome.downloads chain
      // entirely, but still get a per-tile outputAsset descriptor so
      // the node preview / downstream consumers work.
      var dlResult: Record<string, unknown>
      if (shouldAutoDownload) {
        // Prepare rename in background (only meaningful when we
        // actually trigger the chrome.downloads.download below)
        try {
          await safeSendAwait({
            action: 'PREPARE_DOWNLOAD_RENAME',
            payload: {
              folder: normOutputFolder || 'aiflow-01',
              filename: fileName,
              identifier: tileId,
              resolution: filenameResolution,
              mediaKind: normMode,
            }
          })
          console.log('[Background][DOWNLOAD_RENAME_PREPARED]', JSON.stringify({ folder: normOutputFolder || 'aiflow-01', filename: fileName, identifier: tileId, resolution: filenameResolution, mode: normMode, mediaKind: normMode }))
        } catch (_) {}

        // Call bridge to download via native menu
        dlResult = await bridgeCall('downloadTileMedia', {
          tileId: tileId,
          mode: normMode,
          resolution: normDownloadResolution,
          videoResolution: normVideoResolution,
          fileName: fileName,
          outputFolder: normOutputFolder,
          index: tileIndex,
          promptText: promptText,
        }, 60000)
      } else {
        // Download suppressed — synthesize a no-op result so the
        // existing success / fail branches build the right
        // outputAsset descriptor (downloadSuccess:false,
        // downloadSkipped:true).
        console.log('[FlowContent][AUTO_DOWNLOAD] tile SKIPPED (suppressed)', JSON.stringify({
          tileId: tileId,
          source: payloadSource,
          suppressAutoDownload: payloadSuppress,
        }))
        dlResult = { success: false, error: 'download_suppressed', skipped: true }
      }

      if ((dlResult as Record<string, unknown>).success) {
        successCount++
        console.log('[FlowContent][AUTO_DOWNLOAD] tile SUCCESS', tileId)
        // Per-tile output asset descriptor (workflow node preview +
        // downstream media). The runner's coerceMediaList will pick up
        // either `images` (if renamed to MediaItem shape) or
        // `imageUrls` (string[]) when this asset is reached by a
        // downstream node. We populate BOTH shapes so the UI thumbnail
        // works even when downstream nodes are Media/Download with
        // a strict shape contract.
        //
        // `outputAvailable` is the load-bearing flag for downstream
        // consumers — true when Flow produced a tile we have a usable
        // URL for, regardless of whether the local file was saved.
        // `downloadSuccess` is the narrower question "did the file
        // land on disk" — separate from `outputAvailable` so callers
        // can distinguish "Flow produced N images" from "we saved N
        // files" without conflating suppressed-download (workflow
        // path) with hard download failures.
        //
        // URL fields are normalized via toAbsoluteFlowUrl so the runner
        // and downstream node see `https://labs.google/...` (or blob:)
        // instead of path-relative `/fx/api/trpc/...` which only
        // resolves inside the Flow tab and ERR_FILE_NOT_FOUNDs
        // everywhere else.
        var tileMedia = tileMediaMap[tileId] || {}
        var assetUrl = normMode === 'video'
          ? toAbsoluteFlowUrl(tileMedia.videoSrc || tileMedia.videoPoster || tileMedia.thumbnail || '', FLOW_PROVIDER_ORIGIN)
          : toAbsoluteFlowUrl(tileMedia.imgSrc || tileMedia.thumbnail || '', FLOW_PROVIDER_ORIGIN)
        var assetRecord: Record<string, unknown> = {
          provider: 'google-flow',
          type: normMode === 'video' ? 'video' : 'image',
          mediaType: normMode === 'video' ? 'video' : 'image',
          index: tileIndex,
          tileId: tileId,
          fileNameFromFlow: tileFileName,
          // savedFilename is the LOCAL on-disk path Flow's native
          // download wrote to. We keep it for inspection / debug
          // log lines, but the runner MUST NOT use it as a media
          // source for the preview or downstream — Chrome's
          // chrome-extension://... UI cannot read arbitrary local
          // file paths. UI / downstream always use the absolute URL.
          savedFilename: fileName,
          outputFolder: normOutputFolder || 'aiflow-01',
          resolution: filenameResolution,
          mode: normMode,
          mediaKind: normMode,
          providerOrigin: FLOW_PROVIDER_ORIGIN,
          sourcePageUrl: FLOW_SOURCE_PAGE_URL,
          // Successful tile: file saved to disk AND URL is available.
          outputAvailable: true,
          downloadSuccess: true,
          downloadSkipped: false,
          downloadId: typeof (dlResult as Record<string, unknown>).downloadId === 'number' ? (dlResult as Record<string, unknown>).downloadId : undefined,
        }
        if (assetUrl) {
          assetRecord.url = assetUrl
          assetRecord.mediaUrl = assetUrl
          assetRecord.imageUrl = assetUrl
        }
        if (tileMedia.thumbnail) {
          var thumbAbs = toAbsoluteFlowUrl(tileMedia.thumbnail, FLOW_PROVIDER_ORIGIN)
          assetRecord.thumbnailUrl = thumbAbs
          assetRecord.thumbnail = thumbAbs
        }
        if (normMode === 'video') {
          if (tileMedia.videoSrc) assetRecord.videoUrl = toAbsoluteFlowUrl(tileMedia.videoSrc, FLOW_PROVIDER_ORIGIN)
          if (tileMedia.videoPoster) assetRecord.poster = toAbsoluteFlowUrl(tileMedia.videoPoster, FLOW_PROVIDER_ORIGIN)
        }
        // mimeType: best-effort from fileName / mode
        if (normMode === 'video') {
          assetRecord.mimeType = 'video/mp4'
        } else {
          assetRecord.mimeType = 'image/png'
        }
        assetRecord.aspectRatio = payload.aspectRatio || '1:1'
        outputAssets.push(assetRecord)
      } else {
        var tileErr = String((dlResult as Record<string, unknown>).error || 'unknown')
        // When the per-tile download was suppressed (workflow path
        // or any future caller with `suppressAutoDownload: true`),
        // we still want the asset descriptor in outputAssets so the
        // node preview and downstream consumers see the generated
        // URL — but we do NOT increment `failCount`. A suppressed
        // tile is neither a success nor a failure; it's a
        // deliberate skip. Track these separately so the response
        // payload can distinguish "tried and failed" from "didn't
        // try".
        var isSkipped = (dlResult as Record<string, unknown>).skipped === true
        if (isSkipped) {
          skippedCount++
        } else {
          failCount++
        }
        // If the bridge surfaced a direct_src_available fallback, stash
        // the URL so flow-content.ts can return it for the background
        // to attempt a direct download. Note: a suppressed tile is
        // not a fallback target — only real download failures with a
        // direct URL fallback qualify here.
        if (!isSkipped && tileErr === 'direct_src_available') {
          tileErrors.push({
            tileId: tileId,
            error: tileErr,
            directSrc: String((dlResult as Record<string, unknown>).directSrc || ''),
            fileName: tileFileName,
          })
        } else if (!isSkipped) {
          // Suppressed tiles are not errors — don't pollute
          // tileErrors. They flow through downloadSkippedCount.
          tileErrors.push({ tileId: tileId, error: tileErr })
        }
        var failedMedia = tileMediaMap[tileId] || {}
        var failedAssetUrl = normMode === 'video'
          ? toAbsoluteFlowUrl(failedMedia.videoSrc || failedMedia.videoPoster || failedMedia.thumbnail || '', FLOW_PROVIDER_ORIGIN)
          : toAbsoluteFlowUrl(failedMedia.imgSrc || failedMedia.thumbnail || '', FLOW_PROVIDER_ORIGIN)
        var hasUsableUrl = !!failedAssetUrl
        var failedAsset: Record<string, unknown> = {
          provider: 'google-flow',
          type: normMode === 'video' ? 'video' : 'image',
          mediaType: normMode === 'video' ? 'video' : 'image',
          index: tileIndex,
          tileId: tileId,
          fileNameFromFlow: tileFileName,
          outputFolder: normOutputFolder || 'aiflow-01',
          resolution: filenameResolution,
          mode: normMode,
          mediaKind: normMode,
          providerOrigin: FLOW_PROVIDER_ORIGIN,
          sourcePageUrl: FLOW_SOURCE_PAGE_URL,
          // Three independent flags so downstream callers can tell
          // the three failure modes apart:
          //   outputAvailable — Flow produced a tile with a usable
          //     URL. Workflow preview + downstream media can render
          //     this even if the file is not on disk.
          //   downloadSuccess — did the file land on disk via
          //     chrome.downloads.download? Always false in the else
          //     branch.
          //   downloadSkipped — was the download deliberately
          //     suppressed (workflow / collect-only) vs a real
          //     failure (403, menu timeout, ...).
          outputAvailable: hasUsableUrl,
          downloadSuccess: false,
          downloadSkipped: isSkipped,
          downloadError: isSkipped ? 'download_suppressed' : tileErr,
        }
        if (failedMedia.thumbnail) {
          var failedThumbAbs = toAbsoluteFlowUrl(failedMedia.thumbnail, FLOW_PROVIDER_ORIGIN)
          failedAsset.thumbnailUrl = failedThumbAbs
          failedAsset.thumbnail = failedThumbAbs
        }
        if (failedAssetUrl) {
          failedAsset.url = failedAssetUrl
          failedAsset.mediaUrl = failedAssetUrl
        }
        outputAssets.push(failedAsset)
        // Log routing — three distinct prefixes so operator-facing
        // log greps are clean. Suppressed tiles are NOT failures.
        if (isSkipped) {
          console.log('[FlowContent][DOWNLOAD_SKIPPED]', JSON.stringify({
            tileId: tileId,
            reason: 'download_suppressed',
            outputAvailable: hasUsableUrl,
            source: payloadSource,
          }))
        } else {
          console.warn('[FlowContent][AUTO_DOWNLOAD] tile FAILED, continue next', JSON.stringify({
            tileId: tileId,
            error: tileErr,
          }))
        }
      }

      // Small delay between downloads
      await new Promise(r => setTimeout(r, 500))
    }

    // Aggregate failure reasons. The previous version only returned
    // { successCount, failCount } — callers could not tell WHY each
    // tile failed. We now expose `downloadFailReason` (lastError from
    // bridge) plus the full `tileErrors` list, plus an aggregated
    // `lastError` for the worst failure (most likely to explain a
    // total failure). Distinguishing generation-time failure
    // (AUTO_DOWNLOAD_PARTIAL_FAILURE) from submit-time failure
    // (FLOW_SUBMIT_FAILED) keeps downstream callers from conflating
    // the two.
    var aggregatedReason = ''
    if (failCount > 0) {
      // First non-empty tile error
      for (var ei = 0; ei < tileErrors.length; ei++) {
        if (tileErrors[ei] && tileErrors[ei].error) {
          aggregatedReason = tileErrors[ei].error
          break
        }
      }
      if (!aggregatedReason) aggregatedReason = 'unknown'
    }
    var directSrcFallbacks = tileErrors.filter(function (te) { return te.error === 'direct_src_available' })
    var aggregatedDirectSrcList: string[] = []
    for (var dsi = 0; dsi < directSrcFallbacks.length; dsi++) {
      var dItem = directSrcFallbacks[dsi]
      if (dItem && dItem.directSrc) aggregatedDirectSrcList.push(dItem.directSrc)
    }

    // Two parallel DONE logs:
//   - AUTO_DOWNLOAD_DONE: only when downloads were actually
//     attempted. Operators greping for download-path events get
//     one line per real download attempt.
//   - RESULT_COLLECTION_DONE: always. Reflects the result
//     collection outcome regardless of download gating.
    if (shouldAutoDownload) {
      console.log('[FlowContent][AUTO_DOWNLOAD_DONE]', JSON.stringify({
        downloadAttempted: true,
        downloadSuccessCount: successCount,
        downloadFailCount: failCount,
        downloadSkippedCount: skippedCount,
        downloadFailReason: aggregatedReason,
        lastError: aggregatedReason,
        tileErrorCount: tileErrors.length,
        firstDirectSrcAvailable: aggregatedDirectSrcList[0] || '',
        source: payloadSource,
      }))
    }
    // RESULT_COLLECTION_DONE always fires — independent of the
    // download gate. Operators greping for partial / fail events
    // can rely on this single line. Field names explicitly
    // distinguish generation counters (top of the log) from
    // download counters (bottom) so a single line answers both
    // questions without confusion.
    console.log('[FlowContent][RESULT_COLLECTION_DONE]', JSON.stringify({
      generationExpected: generationExpected,
      generationGenerated: generationGenerated,
      generationFailed: generationFailed,
      generationPending: generationPending,
      generationPartial: generationPartial,
      status: finalStatus,
      success: runSucceeded,
      outputsCount: outputAssets.length,
      outputsAvailableCount: outputsAvailableCount,
      outputsDownloadedCount: outputsDownloadedCount,
      outputsSkippedCount: outputsSkippedCount,
      downloadAttempted: shouldAutoDownload,
      downloadSuccessCount: outputsDownloadedCount,
      downloadFailCount: shouldAutoDownload ? failCount : 0,
      downloadSkippedCount: outputsSkippedCount,
      totalFailedCount: generationFailed + (shouldAutoDownload ? failCount : 0),
      source: payloadSource,
    }))
    autoDownloadResult = {
      successCount: successCount,
      failCount: failCount,
      skippedCount: skippedCount,
      downloadFailReason: aggregatedReason,
      lastError: aggregatedReason,
      tileErrors: tileErrors,
      firstDirectSrcAvailable: aggregatedDirectSrcList[0] || '',
      allDownloadFailures: tileErrors.map(function (te) { return te.error }),
      attempted: shouldAutoDownload,
      skipped: !shouldAutoDownload,
      source: payloadSource,
    }
  }

  flowTrace('Content', 'STEP_8_AUTO_DOWNLOAD_RESULT', {
    autoDownload: normAutoDownload,
    autoDownloadResult: autoDownloadResult,
    normMode: normMode,
    downloadResolution: normDownloadResolution,
    videoDownloadResolution: normVideoResolution,
    outputFolder: normOutputFolder,
  })

// Generation / download counters. These are the source of truth
    // for `generation{}` and `downloadDetails{}` below — kept
    // independent of the AUTO_DOWNLOAD result so callers can
    // distinguish "Flow produced N tiles" from "we saved N files".
    var generationGenerated = afterLoopConfirmed.length
    var generationPending = afterLoopPending.length
    var generationFailed = uniqueFailed.length
    var generationExpected = payload.quantity
    // generationPartial is true whenever the final tile accounting
    // does not match the requested quantity. Three independent
    // conditions can trigger it (any one is enough):
    //   1. generated < expected  → fewer confirmed tiles than asked
    //   2. failed > 0            → at least one tile failed generation
    //   3. pending > 0           → at least one tile is still in-flight
    // We OR them so a user-visible "partial" badge fires even when
    // generation succeeded but Flow didn't finish painting the last
    // tile (we got `generated = expected` but pending > 0 indicates
    // Flow emitted extra tiles that didn't settle).
    var generationPartial =
      generationGenerated < generationExpected ||
      generationFailed > 0 ||
      generationPending > 0
    // Sum of (downloadSuccess === true) on outputAssets. Counts
    // only tiles where chrome.downloads.download actually fired
    // AND succeeded. Skipped tiles are NOT failures.
    var outputsAvailableCount = outputAssets.filter(function (a) { return a.outputAvailable === true }).length
    var outputsDownloadedCount = outputAssets.filter(function (a) { return a.downloadSuccess === true }).length
    var outputsSkippedCount = outputAssets.filter(function (a) { return a.downloadSkipped === true }).length

    // Status decision tree. We separate generation-success from
    // download-success because Flow can produce a partial set of
    // tiles that are still perfectly usable (workflow path with
    // downloads suppressed, or hard-fail with at least one
    // usable asset):
    //   - generated == expected → full success (FLOW_SUBMIT_SUCCESS)
    //   - generated > 0 && generated < expected → partial success;
    //     workflow + downstream still get useful assets, so
    //     success:true. Distinguish from a download-only partial
    //     (legacy AUTO_DOWNLOAD_PARTIAL_SUCCESS) by using a
    //     status string that callers can grep for generation-level
    //     partials.
    //   - generated == 0 && pending == 0 → no usable outputs;
    //     hard failure.
    //   - generated == 0 && pending > 0 → loop already handled
    //     this earlier (it would have either fallen through to
    //     provisionalDone or kept waiting).
    var runSucceeded = true
    var finalStatus = 'FLOW_SUBMIT_SUCCESS'
    if (generationGenerated === 0 && generationPending === 0) {
      runSucceeded = false
      finalStatus = 'FLOW_SUBMIT_PARTIAL_FAILURE'
    } else if (generationPartial) {
      runSucceeded = true
      finalStatus = 'FLOW_SUBMIT_PARTIAL_SUCCESS'
    }
    // When autoDownload is enabled and downloads themselves failed
    // (so the user got tiles they cannot preview locally) but
    // generation succeeded, downgrade success to false so the GenPanel
    // "Partial" UI shows. This mirrors the legacy behavior — but
    // only when downloads were ATTEMPTED. Suppressed downloads do
    // not affect runSucceeded.
    if (shouldAutoDownload && outputsDownloadedCount < generationGenerated) {
      // The user wanted files on disk but did not get all of them.
      runSucceeded = false
      if (outputsDownloadedCount > 0) {
        finalStatus = 'AUTO_DOWNLOAD_PARTIAL_SUCCESS'
      } else {
        finalStatus = 'AUTO_DOWNLOAD_PARTIAL_FAILURE'
      }
    }

    flowTrace('Content', 'RUN_FLOW_PROMPT_RETURN', {
      success: runSucceeded,
      status: finalStatus,
      autoDownload: autoDownloadResult,
      submitMethod: (submitResult as Record<string, unknown>).method || '',
      insertStrategy: (insertResult as Record<string, unknown>).strategy || '',
      // Generation outcome (independent of download).
      generationExpected: generationExpected,
      generationGenerated: generationGenerated,
      generationFailed: generationFailed,
      generationPending: generationPending,
      generationPartial: generationPartial,
      // Output assets.
      outputsCount: outputAssets.length,
      outputsAvailableCount: outputsAvailableCount,
      outputsDownloadedCount: outputsDownloadedCount,
      outputsSkippedCount: outputsSkippedCount,
      // Download outcome (only meaningful when attempted).
      downloadAttempted: shouldAutoDownload,
      downloadSuccessCount: outputsDownloadedCount,
      downloadFailCount: shouldAutoDownload ? failCount : 0,
      downloadSkippedCount: outputsSkippedCount,
      // Aggregated.
      totalFailedCount: generationFailed + (shouldAutoDownload ? failCount : 0),
    })

    return {
      success: runSucceeded,
      status: finalStatus,
      bridgeReady: true,
      submitMethod: (submitResult as Record<string, unknown>).method as string || '',
      insertStrategy: (insertResult as Record<string, unknown>).strategy as string || '',
      clearMethod: (clearResult as Record<string, unknown>).method as string || '',
      autoDownload: autoDownloadResult,
      // Generation outcome — independent of download outcome.
      // `generated` = tiles that Flow produced and the result
      // collection loop accepted. `failed` = tiles with stable
      // failed status from Flow. `pending` = tiles Flow still
      // emitted but that did not yet settle by the time we
      // exited the loop. The sum `generated + failed + pending`
      // is `expected` in normal cases; partial mismatches are
      // possible when Flow emits extra tiles (capped by the
      // result dedupe).
      generation: {
        expected: generationExpected,
        generated: generationGenerated,
        failed: generationFailed,
        pending: generationPending,
        partial: generationPartial,
      },
      // Structured metadata for UI / caller. The downloadFailReason +
      // lastError fields distinguish generation-time failure (Flow did
      // not produce tiles) from download-time failure (tiles exist but
      // the menu-driven download failed). GenPanel can render them
      // directly without conflating FLOW_SUBMIT_FAILED and
      // AUTO_DOWNLOAD_PARTIAL_FAILURE.
      downloadFailReason: (autoDownloadResult as Record<string, unknown>).downloadFailReason || '',
      lastError: (autoDownloadResult as Record<string, unknown>).lastError || '',
      tileErrors: (autoDownloadResult as Record<string, unknown>).tileErrors || [],
      firstDirectSrcAvailable: (autoDownloadResult as Record<string, unknown>).firstDirectSrcAvailable || '',
      // New structured downloadDetails — generation outcome + download
      // outcome in one payload. `generated` is the source of truth
      // for "did Flow produce something"; `downloaded` is the source
      // of truth for "did the file land on disk"; `skipped` is the
      // count of deliberately-not-attempted tiles (workflow / collect-
      // only path). `downloadAttempted` makes the suppression
      // observable so callers don't have to guess from a 0 value.
      downloadDetails: {
        expected: generationExpected,
        generated: generationGenerated,
        generationFailedCount: generationFailed,
        generationPendingCount: generationPending,
        generationPartial: generationPartial,
        downloadAttempted: shouldAutoDownload,
        downloaded: outputsDownloadedCount,
        skipped: outputsSkippedCount,
        // Legacy fields kept for backward-compat with callers that
        // already read them. Semantically identical to the new
        // explicit fields above.
        generationFailedCount_legacy: generationFailed,
        generationPendingCount_legacy: generationPending,
      },
      // Top-level count aliases — convenience fields so existing
      // operators reading RUN_FLOW_PROMPT_RETURN don't have to walk
      // through `generation`. (Legacy `outputsSuccessful` field is
      // intentionally renamed to `outputsAvailableCount` to remove
      // the semantic conflation with `downloadSuccess`.)
      outputsCount: outputAssets.length,
      outputsAvailableCount: outputsAvailableCount,
      outputsDownloadedCount: outputsDownloadedCount,
      outputsSkippedCount: outputsSkippedCount,
      // Output assets — power the workflow node preview AND downstream
      // media inputs. Three shapes are exposed to match the three
      // consumers in the codebase:
      //   `outputs`    — rich per-tile descriptor (provider, tileId,
      //                  savedFilename, outputFolder, resolution, mode,
      //                  thumbnailUrl, mediaUrl, etc.). Used by the
      //                  Workflow UI to render previews + counts.
      //   `images`     — MediaItem-shaped array filtered by
      //                  `outputAvailable === true` so workflow callers
      //                  see usable tiles even when downloads were
      //                  suppressed. The runner.coerceMediaList walks
      //                  this for downstream Media / Download / Generate
      //                  nodes.
      //   `imageUrls`  — flat string[] of asset URLs. The Workflow UI
      //                  renderer (`getGenerateOutputImageUrls`) walks
      //                  this when the rich shape is missing.
      // Output of the workflow Generate node MUST include `outputs` so
      // the node card shows the produced assets instead of staying
      // empty after a successful Flow run.
      //
      // Final defensive URL normalization pass: even if a `tileMediaMap`
      // entry somehow slipped through with a relative URL (older bridge
      // build, third-party tile paint), the runner still sees an
      // absolute `https://labs.google/...` (or blob:). This also re-
      // applies providerOrigin / sourcePageUrl so a single asset
      // descriptor carries everything the runner needs to repair
      // itself.
      outputs: outputAssets.map(function (a) {
        return {
          ...a,
          url: toAbsoluteFlowUrl(a.url, FLOW_PROVIDER_ORIGIN),
          mediaUrl: toAbsoluteFlowUrl(a.mediaUrl, FLOW_PROVIDER_ORIGIN),
          imageUrl: toAbsoluteFlowUrl(a.imageUrl, FLOW_PROVIDER_ORIGIN),
          thumbnailUrl: toAbsoluteFlowUrl(a.thumbnailUrl, FLOW_PROVIDER_ORIGIN),
          thumbnail: toAbsoluteFlowUrl(a.thumbnail, FLOW_PROVIDER_ORIGIN),
          videoUrl: toAbsoluteFlowUrl(a.videoUrl, FLOW_PROVIDER_ORIGIN),
          poster: toAbsoluteFlowUrl(a.poster, FLOW_PROVIDER_ORIGIN),
          providerOrigin: a.providerOrigin || FLOW_PROVIDER_ORIGIN,
          sourcePageUrl: a.sourcePageUrl || FLOW_SOURCE_PAGE_URL,
        }
      }),
      images: outputAssets
        // Filter on `outputAvailable` so workflow callers with
        // suppressed downloads still see usable tiles here.
        // Previously this filter used `downloadSuccess === true`,
        // which collapsed every workflow-path response into an
        // empty `images[]` even when tiles were produced and the
        // downstream Media/Download/Generate nodes could consume
        // them via the URL.
        .filter(function (a) { return a.outputAvailable === true })
        .map(function (a) {
          return {
            mediaType: a.type,
            data: '',
            // Defensive: re-normalize at the very last mile so the
            // MediaItem shape the runner consumes is always absolute.
            url: toAbsoluteFlowUrl(a.url || a.thumbnailUrl || '', FLOW_PROVIDER_ORIGIN),
            mediaUrl: toAbsoluteFlowUrl(a.mediaUrl || a.url || a.thumbnailUrl || '', FLOW_PROVIDER_ORIGIN),
            imageUrl: toAbsoluteFlowUrl(a.imageUrl || a.url || a.thumbnailUrl || '', FLOW_PROVIDER_ORIGIN),
            name: (a.savedFilename as string) || (a.fileNameFromFlow as string) || ('flow-output-' + a.index + '.' + ((a.type === 'video') ? 'mp4' : 'png')),
            mimeType: a.mimeType,
            aspectRatio: a.aspectRatio,
            source: 'google-flow',
            providerOrigin: a.providerOrigin || FLOW_PROVIDER_ORIGIN,
            sourcePageUrl: a.sourcePageUrl || FLOW_SOURCE_PAGE_URL,
          }
        }),
      imageUrls: outputAssets
        .map(function (a) { return a.url || a.thumbnailUrl || '' })
        .map(function (u) { return toAbsoluteFlowUrl(u, FLOW_PROVIDER_ORIGIN) })
        .filter(function (u) { return !!u }),
    }
  }

function notifyStatus(status: string, data: Record<string, unknown> = {}) {
  safeSendFireAndForget({
    action: 'FLOW_STATUS',
    payload: { status, timestamp: Date.now(), ...data }
  })
}

// ── Editor text snapshot helper ─────────────────────────────────────────────
// Reads the current editor text via bridge `verify` action and produces
// a single structured log line so the pipeline can grep the lifecycle of
// the editor text. Used after clear / addRef / insert / submit so a
// "prompt is duplicate" regression is immediately visible.
async function snapshotEditorText(stage: string): Promise<{ stage: string; domText: string; slateText: string; url: string }> {
  let res: Record<string, unknown> = {}
  try {
    res = await bridgeCall('verify', {}, 3000) as Record<string, unknown>
  } catch (_) { res = {} }
  var domText = String((res as Record<string, unknown>).editableText || '')
  var slateText = String((res as Record<string, unknown>).slateEditorFound ? domText : '')
  var url = String((res as Record<string, unknown>).url || window.location.href)
  console.log('[FlowContent][EDITOR_TEXT_SNAPSHOT] ' + JSON.stringify({
    stage: stage,
    domText: domText.substring(0, 120),
    slateText: slateText.substring(0, 120),
    hasContent: !!(res as Record<string, unknown>).hasContent,
    placeholderGone: !!(res as Record<string, unknown>).placeholderGone,
    url: url,
  }))
  return { stage: stage, domText: domText, slateText: slateText, url: url }
}

// ── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = (message as Record<string, unknown>).action as string

  // FlowTrace: log every incoming action so listener-race issues are visible.
  // Other content scripts (e.g. generic content-script.ts) may also receive
  // the same message and respond first. This log proves whether THIS content
  // script's listener was reached at all.
  console.log('[FlowTrace][Content] ON_MESSAGE_RECEIVED', JSON.stringify({
    action: action,
    senderTabId: sender?.tab?.id,
    senderUrl: sender?.tab?.url,
    senderFrameId: sender?.frameId,
    url: window.location.href,
  }))

  if (action === 'FLOW_DEBUG_PING') {
    const scan = (window as unknown as Record<string, unknown>).__flowDebugScan?.()
    sendResponse({
      contentLoaded: true,
      bridgeLoaded: isBridgeLoaded(),
      currentUrl: window.location.href,
      scan: scan,
    })
    return true
  }

  // Lightweight ping used by the background's FLOW_UPLOAD_IMAGES path
  // to confirm the flow-content onMessage listener is attached before
  // firing the upload. Mirrors ChatGPT's CHATGPT_PING pattern. Returns
  // immediately — does NOT wait for the bridge, since FLOW_UPLOAD_IMAGES
  // uploads via this content script and the bridge is not required for
  // that path. The full bridge handshake is still performed by
  // RUN_FLOW_PROMPT.
  if (action === 'FLOW_CONTENT_PING') {
    sendResponse({
      success: true,
      provider: 'google-flow',
      contentLoaded: true,
      currentUrl: window.location.href,
    })
    return true
  }

  // In-page fetch of a Flow media URL → data URL.
  //
  // The workflow runner cannot fetch `https://labs.google/fx/api/trpc/
  // media.getMediaUrlRedirect?...` from the side panel / service
  // worker because the request needs Flow's auth cookie and same-origin
  // context. We expose this action so the runner can ask the Flow
  // tab's content script to perform the fetch on its behalf and
  // return the bytes as a data URL (or ArrayBuffer).
  //
  // Inputs:
  //   payload.url         — absolute https://labs.google/... URL
  //                         (relative URLs are normalized here too).
  //   payload.maxBytes    — optional cap (default 25 MB). 0 = no cap.
  //   payload.asArrayBuffer — if true, return ArrayBuffer instead of
  //                            data URL. Used by the runner when
  //                            forwarding the bytes through
  //                            `mediaUploads` (which already carries
  //                            base64).
  //
  // Output:
  //   { success, dataUrl?, arrayBuffer?, mimeType, byteLength, error? }
  //
  // We never persist the bytes (chrome.storage is not involved). The
  // caller consumes the data URL / ArrayBuffer in-memory and lets it
  // be GC'd. This is safe because the caller's intent is to ship the
  // bytes onward (uploader / next-node), not to retain them.
  if (action === 'FLOW_FETCH_MEDIA_AS_DATA') {
    const fetchPayload = (message.payload || {}) as Record<string, unknown>
    const rawUrl = String(fetchPayload.url || '')
    const maxBytes = typeof fetchPayload.maxBytes === 'number' && fetchPayload.maxBytes > 0
      ? fetchPayload.maxBytes
      : 25 * 1024 * 1024
    const asArrayBuffer = fetchPayload.asArrayBuffer === true

    if (!rawUrl) {
      sendResponse({ success: false, error: 'url is required' })
      return true
    }

    const absoluteUrl = toAbsoluteFlowUrl(rawUrl, FLOW_PROVIDER_ORIGIN)

    // Reject obviously bad URLs (still relative after normalization, or
    // pointing at the extension origin). Defensive — the runner should
    // already have shipped absolute URLs.
    if (
      !absoluteUrl ||
      absoluteUrl.indexOf('http://') !== 0 &&
      absoluteUrl.indexOf('https://') !== 0 &&
      absoluteUrl.indexOf('blob:') !== 0 &&
      absoluteUrl.indexOf('data:') !== 0
    ) {
      sendResponse({
        success: false,
        error: 'url is not absolute: ' + absoluteUrl,
        url: absoluteUrl,
      })
      return true
    }

    ;(async () => {
      try {
        const res = await fetch(absoluteUrl, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
          referrerPolicy: 'no-referrer',
        })
        if (!res.ok) {
          sendResponse({
            success: false,
            error: 'fetch failed: HTTP ' + res.status,
            url: absoluteUrl,
            status: res.status,
          })
          return
        }
        const mimeType = (res.headers && res.headers.get && res.headers.get('content-type')) || 'application/octet-stream'
        const buf = await res.arrayBuffer()
        if (maxBytes > 0 && buf.byteLength > maxBytes) {
          sendResponse({
            success: false,
            error: 'response too large: ' + buf.byteLength + ' bytes (max=' + maxBytes + ')',
            url: absoluteUrl,
            byteLength: buf.byteLength,
          })
          return
        }
        if (asArrayBuffer) {
          // For ArrayBuffer mode we transfer ownership. Chrome's
          // structured-clone path can carry an ArrayBuffer across
          // chrome.runtime.sendMessage in a single hop.
          sendResponse({
            success: true,
            arrayBuffer: buf,
            mimeType: mimeType,
            byteLength: buf.byteLength,
            url: absoluteUrl,
          })
        } else {
          // Default: data URL. We assemble bytes → base64 in a
          // background-free loop so very large blobs do not freeze the
          // main thread for long.
          const bytes = new Uint8Array(buf)
          let binary = ''
          const chunkSize = 0x8000
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as number[])
          }
          const dataUrl = 'data:' + mimeType + ';base64,' + btoa(binary)
          sendResponse({
            success: true,
            dataUrl: dataUrl,
            mimeType: mimeType,
            byteLength: buf.byteLength,
            url: absoluteUrl,
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        sendResponse({
          success: false,
          error: 'fetch threw: ' + msg,
          url: absoluteUrl,
        })
      }
    })()
    return true
  }

  if (action === 'RUN_FLOW_PROMPT') {
    console.log('[FlowTrace][Content] RUN_FLOW_PROMPT_ENTERED', JSON.stringify({
      url: window.location.href,
      senderTabId: sender?.tab?.id,
      senderFrameId: sender?.frameId,
    }))

    let responded = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const responseTimeoutMs = 270000
    const safeRespondOnce = (payload: Record<string, unknown>) => {
      if (responded) return
      responded = true
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      try {
        console.log('[FlowTrace][Content] RUN_FLOW_PROMPT_SEND_RESPONSE', JSON.stringify({
          success: payload.success,
          status: payload.status,
          error: payload.error,
          hasAutoDownload: !!payload.autoDownload,
          responseTimeoutMs,
        }))
      } catch (_) {}
      try {
        sendResponse(payload)
      } catch (err) {
        console.error('[FlowTrace][Content] RUN_FLOW_PROMPT_SEND_RESPONSE_FAILED', err)
      }
    }

    timeoutId = setTimeout(() => {
      console.error('[FlowTrace][Content] RUN_FLOW_PROMPT_TIMEOUT', JSON.stringify({
        timeoutMs: responseTimeoutMs,
        url: window.location.href,
      }))
      safeRespondOnce({
        success: false,
        status: 'RUN_FLOW_PROMPT_TIMEOUT',
        error: 'RUN_FLOW_PROMPT did not respond within ' + Math.round(responseTimeoutMs / 1000) + 's',
        bridgeReady: isBridgeLoaded(),
      })
    }, responseTimeoutMs)

    try {
    const rawPayload = ((message as Record<string, unknown>).payload || {}) as Record<string, unknown>
    settingsDebug('[FlowContent][RUN_FLOW_PROMPT_PAYLOAD]', JSON.stringify(rawPayload, null, 2))

    const debugGenState = rawPayload.debugGenState as Record<string, unknown> | undefined
    if (debugGenState) {
      settingsDebug('[FlowContent][GEN_DEBUG_STATE_FROM_PAYLOAD]', JSON.stringify(debugGenState, null, 2))
    } else {
      settingsDebug('[FlowContent][GEN_DEBUG_STATE_FROM_PAYLOAD]', JSON.stringify(null, null, 2))
    }

    const normalizedMode = String(
      rawPayload.mode || rawPayload.genType || 'image'
    ).toLowerCase()
    const normalizedRatio = String(
      rawPayload.ratio ||
        rawPayload.aspectRatio ||
        rawPayload.selectedRatio ||
        (rawPayload.settings as Record<string, unknown>)?.ratio ||
        (rawPayload.settings as Record<string, unknown>)?.aspectRatio ||
        '16:9'
    )
    const normalizedQuantityRaw = (rawPayload.quantity as number) ??
      (rawPayload.count as number) ??
      (rawPayload.outputCount as number) ??
      ((rawPayload.settings as Record<string, unknown>)?.quantity as number) ??
      ((rawPayload.settings as Record<string, unknown>)?.count as number) ??
      1
    const normalizedQuantity = Math.max(1, Math.min(4, Number(normalizedQuantityRaw) || 1))
    const normalizedModel = String(
      rawPayload.model ||
        rawPayload.modelName ||
        ((rawPayload.settings as Record<string, unknown>)?.model as string) ||
        ((rawPayload.settings as Record<string, unknown>)?.modelName as string) ||
        ''
    )
    const normalizedDuration = String(
      rawPayload.duration ||
        rawPayload.flowVideoDuration ||
        ((rawPayload.settings as Record<string, unknown>)?.duration as string) ||
        ''
    )
    // Google Flow Video only — "Khung hình" / "Thành phần".
    // Read from payload.flowVideoMode (canonical) or settings.flowVideoMode
    // (legacy alias from older callers). Invalid values are dropped so the
    // bridge can detect "do not touch" via undefined. Setting flowVideoMode
    // does NOT toggle isFrames — isFrames is only true when frameFileIds
    // is present, per the legacy contract.
    var rawFlowVideoMode = rawPayload.flowVideoMode
    if (typeof rawFlowVideoMode !== 'string') {
      rawFlowVideoMode = (rawPayload.settings as Record<string, unknown>)?.flowVideoMode as string | undefined
    }
    var normalizedFlowVideoMode: 'frame' | 'ingredient' | undefined =
      rawFlowVideoMode === 'frame' || rawFlowVideoMode === 'ingredient'
        ? (rawFlowVideoMode as 'frame' | 'ingredient')
        : undefined
    // isFrames is ONLY true when frameFileIds is present.
    // NEVER infer from referenceImages.length or fileIds.length.
    const rawFrameFileIds = (rawPayload.frameFileIds as { frame1?: string; frame2?: string } | null | undefined)
    const hasFrameFileIds = rawFrameFileIds && (rawFrameFileIds.frame1 || rawFrameFileIds.frame2)
    const normalizedFrameFileIds = hasFrameFileIds ? rawFrameFileIds : undefined

    const settingsPayload = {
      mode: normalizedMode === 'video' ? 'video' : 'image',
      model: normalizedModel,
      ratio: normalizedRatio,
      quantity: normalizedQuantity,
      duration: normalizedMode === 'video' ? (normalizedDuration || '8s') : '',
      frameFileIds: normalizedFrameFileIds,
      // isFrames is derived from frameFileIds presence — the ONLY correct source of truth
      isFrames: !!normalizedFrameFileIds,
      // Google Flow Video only. Forward only when valid; the bridge treats
      // undefined as "do not touch the segmented control". Do NOT couple
      // this with isFrames — that would conflict with the legacy Frames path.
      flowVideoMode: normalizedFlowVideoMode,
    }
    settingsDebug('[FlowContent][REFS_NORMALIZED]', JSON.stringify({
      mode: settingsPayload.mode,
      duration: settingsPayload.duration,
      fileIds: (rawPayload.fileIds as string[]) || [],
      fileNameMapCount: Object.keys((rawPayload.fileNameMap as Record<string, string>) || {}).length,
      hasUploadKeys: ((rawPayload.fileIds as string[]) || []).some((id: string) => id.startsWith('upload_')),
      frameFileIds: normalizedFrameFileIds,
      isFrames: settingsPayload.isFrames,
      flowVideoMode: normalizedFlowVideoMode,
    }, null, 2))
    settingsDebug('[FlowContent][APPLY_SETTINGS_TARGET]', JSON.stringify(settingsPayload, null, 2))

    ;(window as unknown as Record<string, unknown>).__tabId = sender.tab?.id || (rawPayload.tabId as number)

    const fullPayload = {
      prompt: (rawPayload.prompt as string) || '',
      mode: settingsPayload.mode as 'image' | 'video',
      model: settingsPayload.model,
      aspectRatio: settingsPayload.ratio,
      quantity: settingsPayload.quantity,
      duration: settingsPayload.duration,
      style: (rawPayload.style as string | null) || null,
      // fileIds must be real Flow tile IDs — upload_xxx resolved before this point
      fileIds: (rawPayload.fileIds as string[]) || [],
      fileNameMap: (rawPayload.fileNameMap as Record<string, string>) || {},
      frameFileIds: settingsPayload.frameFileIds,
      // Google Flow Video only — "Khung hình" / "Thành phần". undefined means
      // "do not touch"; bridge skips the segmented-control click and Flow
      // keeps its current default (currently 'ingredient').
      flowVideoMode: settingsPayload.flowVideoMode,
      autoDownload: (rawPayload.autoDownload as boolean) ?? false,
      outputFolder: (rawPayload.outputFolder as string) || (rawPayload.subFolder as string) || '',
      resolution: (rawPayload.resolution as string) || (rawPayload.downloadRes as string) || '1k',
      videoResolution: (rawPayload.videoResolution as string) || (rawPayload.videoDownloadResolution as string) || '720p',
      focusTab: (rawPayload.focusTab as boolean) || false,
    }
    runFlowPrompt(fullPayload)
      .then((result) => {
        safeRespondOnce(result)
      })
      .catch((err) => {
        console.error('[FlowTrace][Content] RUN_FLOW_PROMPT_CAUGHT', err)
        safeRespondOnce({
          success: false,
          status: 'RUN_FLOW_PROMPT_EXCEPTION',
          error: (err as Error)?.message || String(err),
        })
      })
    } catch (err) {
      console.error('[FlowTrace][Content] RUN_FLOW_PROMPT_SYNC_THROW', err)
      safeRespondOnce({
        success: false,
        status: 'RUN_FLOW_PROMPT_SYNC_THROW',
        error: (err as Error)?.message || String(err),
      })
    }
    return true
  }

  if (action === 'FLOW_INJECT_BRIDGE') {
    console.log('[FlowTrace][Content] FLOW_INJECT_BRIDGE_ENTERED', JSON.stringify({
      url: window.location.href,
      bridgeLoadedByMarker: !!window.__flowSlateBridgeCleanup,
      bridgeBuildTime: window.__FLOW_BRIDGE_BUILD_TIME__ || null,
    }))
    flowDebug('[FlowContent] FLOW_INJECT_BRIDGE received')
    ;(async () => {
      const ready = await waitBridgeReady()
      flowDebug('[FlowContent] waitBridgeReady result:', ready)
      console.log('[FlowTrace][Content] FLOW_INJECT_BRIDGE_RESPOND', JSON.stringify({
        bridgeLoaded: true,
        bridgeReady: ready.ready,
        bridgeBuildTime: window.__FLOW_BRIDGE_BUILD_TIME__ || null,
      }))
      sendResponse({ ok: true, bridgeLoaded: true, bridgeReady: ready.ready })
    })()
    return true
  }

  if (action === 'FLOW_GET_TILES') {
    const tileEls = document.querySelectorAll('[data-tile-id], [data-gen-tile], [class*="tile"], [class*="result"]')
    const tileIds: string[] = []
    const thumbnailUrls: Record<string, string> = {}
    tileEls.forEach((el) => {
      const id = (el as HTMLElement).dataset.tileId || (el as HTMLElement).dataset.genTile || Math.random().toString(36).substring(7)
      tileIds.push(id)
      const img = el.querySelector('img')
      if (img?.src) thumbnailUrls[id] = img.src
    })
    sendResponse({ tileIds, thumbnailUrls })
    return true
  }

  if (action === 'FLOW_UPLOAD_IMAGES') {
    const filesData = ((message as Record<string, unknown>).filesData as Array<{
      key: string
      name: string
      type: string
      base64: string
    }>) || []
    flowDebug('[FlowContent] FLOW_UPLOAD_IMAGES: ' + filesData.length + ' files')
    ;(async () => {
      try {
        const uploadResult = await bridgeCall('uploadFiles', { filesData }, 90000)
        sendResponse(uploadResult)
      } catch (err) {
        console.error('[FlowContent] FLOW_UPLOAD_IMAGES error:', err)
        sendResponse({ success: false, error: (err as Error).message })
      }
    })()
    return true
  }

  return false
})
