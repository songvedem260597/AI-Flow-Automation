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

// ── Debug Run Flow Prompt ────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

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

  // Wait for bridge to be ready (polls every 500ms, up to 10s)
  const readyCheck = await waitBridgeReady()
  if (!readyCheck.ready) {
    return {
      success: false,
      status: 'BRIDGE_NOT_READY',
      bridgeReady: false,
      error: readyCheck.error,
      url: window.location.href,
      hint: 'Reload the Flow tab and try again.'
    }
  }

  // Step 1-2: Apply settings from Gen tab payload (NEVER skip in normal runs)
  let settingsResult: Record<string, unknown>
  try {
    settingsResult = await bridgeCall('applySettings', { payload })
  } catch (err) {
    console.error('[FlowContent] Step 1-2 apply settings THREW:', {
      message: (err as Error)?.message,
      stack: (err as Error)?.stack,
    })
    return {
      success: false,
      error: (err as Error)?.message || 'FLOW_APPLY_SETTINGS_FAILED',
      stage: 'applySettings',
    }
  }
  if (!settingsResult?.success) {
    console.error('[FlowContent] Step 1-2 apply settings FAILED:', JSON.stringify(settingsResult, null, 2))
    return {
      success: false,
      error: (settingsResult as Record<string, unknown>)?.error || 'FLOW_APPLY_SETTINGS_FAILED',
      stage: 'applySettings',
      details: settingsResult,
    }
  }
  settingsDebug('[FlowContent][settings result]', settingsResult)
  await new Promise(r => setTimeout(r, 400))

  // Step 3: Clear editor
  console.log('[FlowContent] Step 3: clearEditor')
  notifyStatus('FLOW_RUN_STARTED')
  const clearResult = await bridgeCall('clear')
  if (!clearResult.success) {
    return { success: false, status: 'FLOW_CLEAR_FAILED', error: (clearResult as Record<string, unknown>).error || 'clear failed' }
  }
  await new Promise(r => setTimeout(r, 300))

  // Step 4: Add reference images BEFORE text
  const isFrames = !!(payload.frameFileIds && (payload.frameFileIds.frame1 || payload.frameFileIds.frame2))

  // Gate: if fileIds contain upload_xxx, it means GenPanel failed to resolve — abort
  if (payload.fileIds && payload.fileIds.some(id => id.startsWith('upload_'))) {
    const unresolved = payload.fileIds.filter(id => id.startsWith('upload_'))
    console.error('[FlowContent] REF_UPLOAD_NOT_RESOLVED: ' + JSON.stringify(unresolved))
    return {
      success: false,
      status: 'REF_UPLOAD_NOT_RESOLVED',
      error: 'REF_UPLOAD_NOT_RESOLVED: some upload_xxx keys were not resolved before reaching FlowContent: ' + JSON.stringify(unresolved),
    }
  }

  if (payload.fileIds && payload.fileIds.length > 0 && !isFrames) {
    console.log('[FlowContent] Step 4: addRefImages, count=' + payload.fileIds.length)
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
        return {
          success: false,
          status: 'FLOW_ADD_REF_FAILED',
          error: 'Failed to add ref image: ' + fileId + ' — ' + addRefError,
          details: addRefResult,
        }
      }
    }
    await new Promise(r => setTimeout(r, 300))
  }

  // Step 5: Insert text
  console.log('[FlowContent] Step 5: insertText, len=', payload.prompt.length)
  const insertResult = await bridgeCall('insert', { text: payload.prompt })
  if (!insertResult.success) {
    return { success: false, status: 'FLOW_INSERT_FAILED', error: (insertResult as Record<string, unknown>).error || 'insert failed' }
  }
  notifyStatus('FLOW_INSERT_SUCCESS')
  await new Promise(r => setTimeout(r, 500))

  // Step 6: Verify
  const verifyResult = await bridgeCall('verify')
  if (!(verifyResult as Record<string, unknown>).hasContent) {
    const retryInsert = await bridgeCall('insert', { text: payload.prompt })
    if (!retryInsert.success) {
      return { success: false, status: 'FLOW_VERIFY_FAILED', error: 'Text not in Slate model after retry' }
    }
    await new Promise(r => setTimeout(r, 500))
  }

  // Step 7: Submit — capture baseline snapshot RIGHT BEFORE submit.
  // This is critical: if captured after submit, result tiles may already exist
  // and the diff will find 0 new tiles (download nothing).
  // Snapshot includes both tileIds AND fileNames for dual filtering.
  console.log('[FlowContent] Step 7: submit (capturing pre-submit baseline)')
  var preSubmitIds: string[] = []
  var preSubmitFileNames: string[] = []
  var preSubmitDetails: Array<{ id: string; fileName: string; status: string }> = []
  try {
    var preSubmitSnapshot = await bridgeCall('getTileSnapshot', {}, 5000)
    preSubmitIds = ((preSubmitSnapshot as Record<string, unknown>).ids as string[]) || []
    preSubmitFileNames = ((preSubmitSnapshot as Record<string, unknown>).fileNames as string[]) || []
    preSubmitDetails = ((preSubmitSnapshot as Record<string, unknown>).details as Array<{ id: string; fileName: string; status: string }>) || []
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
  } catch (_) {}

  console.log('[FlowContent] Step 7: submit')
  const submitResult = await bridgeCall('submit')
  if (!submitResult.success) {
    return { success: false, status: 'FLOW_SUBMIT_FAILED', error: (submitResult as Record<string, unknown>).error || 'submit failed' }
  }
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
    rawPayloadKeys: Object.keys(payload),
  }))

  var autoDownloadResult: Record<string, unknown> = { skipped: true }
  if (!normAutoDownload) {
    console.log('[FlowContent][AUTO_DOWNLOAD_SKIP] reason=autoDownload_disabled')
  } else {
    console.log('[FlowContent][AUTO_DOWNLOAD_START]', JSON.stringify({
      expectedCount: payload.quantity,
      baselineIds: preSubmitIds.length,
      baselineNonEmptyFileNames: preSubmitFileNames.filter(function (f) { return f.length > 0 }).length,
      downloadResolution: normDownloadResolution,
      videoDownloadResolution: normVideoResolution,
      outputFolder: normOutputFolder,
    }))

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
          console.warn('[FlowContent][AUTO_DOWNLOAD_PARTIAL_EARLY_EXIT]', JSON.stringify({
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
      // There is no point waiting further for the failed tiles — download
      // the confirmed tiles now. This replaces the old "wait 30s no
      // progress" rule for the common partial case.
      if (uniqueConfirmed.length > 0 && failed.length > 0) {
        console.warn('[FlowContent][AUTO_DOWNLOAD_PARTIAL_EARLY_EXIT]', JSON.stringify({
          reason: 'confirmed_and_stable_failed_coexist',
          expected: payload.quantity,
          confirmed: uniqueConfirmed.length,
          failed: failed.length,
          freshFailed: freshFailedIds.size,
          pending: uniquePending.length,
          waitedMs: waitedMs,
        }))
        cleanupObserver()
        // Mark newTilesFullData as the confirmed set so the post-loop branch
        // picks the partial path.
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
      autoDownloadResult = {
        successCount: 0,
        failCount: 0,
        error: 'AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS',
      }
      console.log('[FlowContent][AUTO_DOWNLOAD_DONE]', JSON.stringify(autoDownloadResult))
      return {
        success: false,
        status: 'AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS',
        error: 'No successful result tiles. expected=' + payload.quantity,
        bridgeReady: true,
        autoDownload: autoDownloadResult,
      }
    }

    // Case 2: partial — some confirmed but not enough → warn and download confirmed only.
    // If confirmed=0 but provisionalDone > 0, use provisional tiles as targets.
    var isPartialResult = afterLoopConfirmed.length < payload.quantity
    var finalTargets: Array<{ id: string; status: string; fileName: string }> = []
    if (afterLoopConfirmed.length === 0 && provisionalDone.length > 0) {
      // Use provisional tiles as download targets (no fileName → prompt/index/resolution filename).
      console.warn('[FlowContent][AUTO_DOWNLOAD_PARTIAL_EARLY_EXIT]', JSON.stringify({
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
      console.warn('[FlowContent][AUTO_DOWNLOAD_PARTIAL_RESULTS]', JSON.stringify({
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
      autoDownloadResult = {
        successCount: 0,
        failCount: 0,
        error: 'AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS',
      }
      console.log('[FlowContent][AUTO_DOWNLOAD_DONE]', JSON.stringify(autoDownloadResult))
      return {
        success: false,
        status: 'AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS',
        error: 'No successful result tiles after classification. expected=' + payload.quantity,
        bridgeReady: true,
        autoDownload: autoDownloadResult,
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
    var finalTileData: { id: string; fileName: string; status: string } | null = null
    var firstStatus = await bridgeCall('getTileSnapshot', {}, 5000)
    var firstSnapTiles = ((firstStatus as Record<string, unknown>).details as Array<{ id: string; fileName: string; status: string }>) || []
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
      var snapTiles = ((statusResult as Record<string, unknown>).details as Array<{ id: string; fileName: string; status: string }>) || []
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

      // Prepare rename in background
      try {
        await safeSendAwait({
          action: 'PREPARE_DOWNLOAD_RENAME',
          payload: {
            folder: normOutputFolder || 'tobyflow-01',
            filename: fileName,
            identifier: tileId,
            resolution: filenameResolution,
            mediaKind: normMode,
          }
        })
        console.log('[Background][DOWNLOAD_RENAME_PREPARED]', JSON.stringify({ folder: normOutputFolder || 'tobyflow-01', filename: fileName, identifier: tileId, resolution: filenameResolution, mode: normMode, mediaKind: normMode }))
      } catch (_) {}

      // Call bridge to download via native menu
      var dlResult = await bridgeCall('downloadTileMedia', {
        tileId: tileId,
        mode: normMode,
        resolution: normDownloadResolution,
        videoResolution: normVideoResolution,
        fileName: fileName,
        outputFolder: normOutputFolder,
        index: tileIndex,
        promptText: promptText,
      }, 60000)

      if ((dlResult as Record<string, unknown>).success) {
        successCount++
        console.log('[FlowContent][AUTO_DOWNLOAD] tile SUCCESS', tileId)
      } else {
        failCount++
        console.warn('[FlowContent][AUTO_DOWNLOAD] tile FAILED, continue next', JSON.stringify({
          tileId: tileId,
          error: (dlResult as Record<string, unknown>).error || 'unknown',
        }))
      }

      // Small delay between downloads
      await new Promise(r => setTimeout(r, 500))
    }

    console.log('[FlowContent][AUTO_DOWNLOAD_DONE]', JSON.stringify({ successCount: successCount, failCount: failCount }))
    autoDownloadResult = { successCount: successCount, failCount: failCount }
  }

// When autoDownload is OFF, default to success. When ON, three cases:
    // - all expected succeeded with no partial: FLOW_SUBMIT_SUCCESS
    // - partial (confirmed < expected): AUTO_DOWNLOAD_PARTIAL_SUCCESS
    // - everything else (should not reach here for partial/no-success paths
    //   which already returned early): AUTO_DOWNLOAD_PARTIAL_FAILURE
    var runSucceeded = true
    var finalStatus = 'FLOW_SUBMIT_SUCCESS'
    if (normAutoDownload) {
      var expectedQty = payload.quantity
      var allSucceeded = (autoDownloadResult.successCount === expectedQty) && (autoDownloadResult.failCount === 0)
      if (allSucceeded) {
        runSucceeded = true
        finalStatus = 'FLOW_SUBMIT_SUCCESS'
      } else {
        // Distinguish partial (downloaded something) from total failure (downloaded nothing)
        finalStatus = autoDownloadResult.successCount > 0
          ? 'AUTO_DOWNLOAD_PARTIAL_SUCCESS'
          : 'AUTO_DOWNLOAD_PARTIAL_FAILURE'
        // Partial: let GenPanel decide whether to alert or surface soft message
        // based on download counts. Return success:false so GenPanel's else fires.
        runSucceeded = false
      }
    }

    return {
      success: runSucceeded,
      status: finalStatus,
      bridgeReady: true,
      submitMethod: (submitResult as Record<string, unknown>).method as string || '',
      insertStrategy: (insertResult as Record<string, unknown>).strategy as string || '',
      clearMethod: (clearResult as Record<string, unknown>).method as string || '',
      autoDownload: autoDownloadResult,
      // Structured metadata for UI / caller
      downloadDetails: normAutoDownload ? {
        expected: payload.quantity,
        downloaded: autoDownloadResult.successCount,
        generationPartial: isPartialResult,
        generationFailedCount: isPartialResult ? (payload.quantity - (afterLoopConfirmed ? afterLoopConfirmed.length : 0)) : 0,
      } : undefined,
    }
  }

function notifyStatus(status: string, data: Record<string, unknown> = {}) {
  safeSendFireAndForget({
    action: 'FLOW_STATUS',
    payload: { status, timestamp: Date.now(), ...data }
  })
}

// ── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = (message as Record<string, unknown>).action as string

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

  if (action === 'RUN_FLOW_PROMPT') {
    const rawPayload = (message as Record<string, unknown>).payload as Record<string, unknown>
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
    }
    settingsDebug('[FlowContent][REFS_NORMALIZED]', JSON.stringify({
      mode: settingsPayload.mode,
      duration: settingsPayload.duration,
      fileIds: (rawPayload.fileIds as string[]) || [],
      fileNameMapCount: Object.keys((rawPayload.fileNameMap as Record<string, string>) || {}).length,
      hasUploadKeys: ((rawPayload.fileIds as string[]) || []).some((id: string) => id.startsWith('upload_')),
      frameFileIds: normalizedFrameFileIds,
      isFrames: settingsPayload.isFrames,
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
      autoDownload: (rawPayload.autoDownload as boolean) ?? false,
      outputFolder: (rawPayload.outputFolder as string) || (rawPayload.subFolder as string) || '',
      resolution: (rawPayload.resolution as string) || (rawPayload.downloadRes as string) || '1k',
      videoResolution: (rawPayload.videoResolution as string) || (rawPayload.videoDownloadResolution as string) || '720p',
      focusTab: (rawPayload.focusTab as boolean) || false,
    }
    runFlowPrompt(fullPayload)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: (err as Error).message }))
    return true
  }

  if (action === 'FLOW_INJECT_BRIDGE') {
    flowDebug('[FlowContent] FLOW_INJECT_BRIDGE received')
    ;(async () => {
      const ready = await waitBridgeReady()
      flowDebug('[FlowContent] waitBridgeReady result:', ready)
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
