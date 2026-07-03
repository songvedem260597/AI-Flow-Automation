// ── Safe sendMessage helpers ─────────────────────────────────────────────────
// After extension reload, the previous content script bundle stays alive in
// the page; subsequent chrome.runtime.sendMessage / chrome.storage calls
// throw "Extension context invalidated". We swallow that here so the
// runChatGPTJob polling loop and beforeunload hook don't spam the console
// after context loss.

const CTX_INVALIDATED = 'Extension context invalidated'

function isContextInvalidated(err) {
  if (!err) return false
  const msg = err && (err.message || (typeof err === 'string' ? err : ''))
  return typeof msg === 'string' && msg.includes(CTX_INVALIDATED)
}

function safeRuntimeContext() {
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

function safeSendFireAndForget(message) {
  try {
    if (!safeRuntimeContext()) return
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError
    })
  } catch {
    // silently swallow — context is invalid or message channel gone
  }
}

function safeSendAwait(message) {
  return new Promise((resolve) => {
    if (!safeRuntimeContext()) {
      resolve({ ok: false, error: 'context_invalidated' })
      return
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError
        if (err) {
          if (isContextInvalidated(err)) {
            resolve({ ok: false, error: 'context_invalidated' })
          } else {
            resolve({ ok: false, error: err.message || 'sendMessage error' })
          }
          return
        }
        resolve({ ok: true, response })
      })
    } catch (e) {
      if (isContextInvalidated(e)) {
        resolve({ ok: false, error: 'context_invalidated' })
      } else {
        resolve({ ok: false, error: e && e.message ? e.message : String(e) })
      }
    }
  })
}

// Fire-and-forget heartbeat to the background. Used by the
// runChatGPTJob polling loop to signal that the job is alive and what
// state it is in. The background stores lastProgressAt + progress
// fields in chrome.storage.session so the runner's waitForChatGPTJob
// can decide between "still working" and "stuck".
function chatgptSendProgress(jobId, payload) {
  if (!jobId) return
  try {
    console.log('[ChatGPT][Progress] heartbeat', {
      jobId,
      phase: payload.phase,
      generating: payload.generating,
      candidateImages: payload.candidateImages,
      acceptedImages: payload.acceptedImages,
      hasPendingImage: payload.hasPendingImage,
      elapsedMs: payload.elapsedMs,
    })
  } catch (_) {}
  safeSendFireAndForget({
    action: 'CHATGPT_JOB_PROGRESS',
    payload: { jobId, ...payload },
  })
}

const AI_FLOW_CONTENT_STATE_KEY = '__AI_FLOW_AUTOMATION_CONTENT_STATE__'

function getAIFlowContentState() {
  try {
    const root = window
    if (!root[AI_FLOW_CONTENT_STATE_KEY]) {
      root[AI_FLOW_CONTENT_STATE_KEY] = {
        listenerAttached: false,
        chatgptJobs: {},
      }
    }
    if (!root[AI_FLOW_CONTENT_STATE_KEY].chatgptJobs) {
      root[AI_FLOW_CONTENT_STATE_KEY].chatgptJobs = {}
    }
    return root[AI_FLOW_CONTENT_STATE_KEY]
  } catch (_) {
    return {
      listenerAttached: false,
      chatgptJobs: {},
    }
  }
}

const AIFlowContentScript = {
  currentProvider: null,

  init(provider) {
    this.currentProvider = provider
    this.setupMessageListener()
    console.log('[AI Flow] Content script initialized for', provider)
  },

  setupMessageListener() {
    const state = getAIFlowContentState()
    if (state.listenerAttached) {
      console.log('[AI Flow] Content script listener already attached; skipping duplicate listener')
      return
    }
    state.listenerAttached = true
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message).then(sendResponse).catch((err) => {
        sendResponse({ success: false, error: err.message })
      })
      return true
    })
  },

  async handleMessage(message) {
    switch (message.action) {
      case 'CHATGPT_PING':
        // Health check used by the background service worker before it
        // fires the real CHATGPT_SUBMIT_AND_WAIT. Returning success=true
        // is the green light that the content script listener is alive.
        return {
          success: true,
          provider: detectProvider(),
          url: location.href,
        }
      case 'INSERT_PROMPT':
        return this.insertPrompt(message.payload.prompt)
      case 'UPLOAD_IMAGE':
        return this.uploadImage(message.payload.imageData)
      case 'CLICK_GENERATE':
        return this.clickGenerate()
      case 'DOWNLOAD_RESULT':
        return this.downloadResult()
      case 'SET_MODEL':
        return this.setModel(message.payload.model)
      case 'SET_ASPECT_RATIO':
        return this.setAspectRatio(message.payload.ratio)
      case 'SET_MEDIA_TYPE':
        return this.setMediaType(message.payload.mediaType)
      case 'SET_DURATION':
        return this.setDuration(message.payload.duration)
      case 'GET_STATUS':
        return this.getStatus()
      case 'CHATGPT_SUBMIT_AND_WAIT':
        return this.chatgptSubmitAndWait(message.payload)
      default:
        throw new Error(`Unknown action: ${message.action}`)
    }
  },

  insertPrompt(prompt) {
    const selectors = this.getPromptSelectors()
    for (const selector of selectors) {
      const el = document.querySelector(selector)
      if (el) {
        const textarea = el.tagName === 'TEXTAREA' ? el : el.querySelector('textarea, [contenteditable], input')
        if (textarea) {
          this.setInputValue(textarea, prompt)
          this.dispatchInputEvent(textarea)
          return { success: true, selector }
        }
      }
    }
    throw new Error('Prompt input not found')
  },

  async uploadImage(imageData) {
    // Capture `this` once — the method body uses many arrow
    // functions and nested `new Promise((resolve) => { … })`
    // callbacks whose lexical `this` would otherwise resolve to
    // the enclosing `function`'s `this` (undefined in strict mode),
    // not the host object. We want to call `this.chatgptCountComposerAttachments`
    // and `this.chatgptSleep` reliably regardless of nesting depth.
    const self = this
    const diagLog = (label, extra) => {
      if (extra !== undefined) console.log('[ChatGPT][UploadDiag] ' + label, extra)
      else console.log('[ChatGPT][UploadDiag] ' + label)
    }
    const log = (label, extra) => {
      if (extra !== undefined) console.log('[ChatGPT][Upload] ' + label, extra)
      else console.log('[ChatGPT][Upload] ' + label)
    }
    diagLog('enter', {
      url: location.href,
      mediaStartsWithDataColon: typeof imageData === 'string' && imageData.indexOf('data:') === 0,
      mediaLength: typeof imageData === 'string' ? imageData.length : 0,
    })

    // ── Decode the media payload (data URL). Done synchronously and
    //    up-front so all three strategies reuse the same File object. ──
    let byteString, mimeType
    try {
      byteString = atob(imageData.split(',')[1])
      mimeType = imageData.match(/data:([^;]+)/)[1]
    } catch (e) {
      diagLog('payload decode failed', { message: (e && e.message) || String(e) })
      throw e
    }
    const ab = new ArrayBuffer(byteString.length)
    const ia = new Uint8Array(ab)
    for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i)
    const blob = new Blob([ab], { type: mimeType })
    const extension = mimeType.includes('mp4')
      ? 'mp4'
      : mimeType.includes('webm')
        ? 'webm'
        : mimeType.includes('quicktime')
          ? 'mov'
          : mimeType.includes('jpeg')
            ? 'jpg'
            : mimeType.split('/')[1] || 'png'
    const filePrefix = mimeType.startsWith('video/') ? 'video' : 'image'
    const fileName = `${filePrefix}.${extension}`
    const file = new File([blob], fileName, { type: mimeType })
    diagLog('payload decoded', {
      mimeType,
      extension,
      fileName,
      fileSize: file.size,
    })

    // ── Ranked file-input selection. The composer's real upload
    //    input sits inside the form and almost always has either a
    //    missing accept attribute (treated as *) or `multiple` enabled.
    //    Other inputs on the page (profile avatar, settings, profile
    //    picture, workspace avatar) have their own form context and are
    //    NOT what we want. The ladder ties a bunch of signals
    //    together. Returns the first match in priority order, or
    //    falls back to the first <input type="file"> on the page. ──
    const composer = document.querySelector(
      '#prompt-textarea, [data-testid="prompt-textarea"], form [contenteditable="true"], main [contenteditable="true"], textarea[data-id="root"]'
    )
    diagLog('composer probe', {
      found: !!composer,
      tagName: composer && composer.tagName,
      composerTestId: composer && composer.getAttribute && composer.getAttribute('data-testid'),
    })

    // Walk candidates and score them.
    const allFileInputs = Array.from(document.querySelectorAll('input[type="file"]'))
    diagLog('file input enumeration', { count: allFileInputs.length })

    const composerRoot = composer && composer.closest('form')
      ? composer.closest('form')
      : composer && composer.closest('[data-testid*="composer" i]')
        ? composer.closest('[data-testid*="composer" i]')
        : null
    const composerFormId = composerRoot ? composerRoot.dataset && composerRoot.dataset.formId : null

    function scoreInput(el) {
      if (!el) return -1
      const style = el.ownerDocument && el.ownerDocument.defaultView
        ? el.ownerDocument.defaultView.getComputedStyle(el)
        : null
      const inSameForm = composerRoot ? !!el.closest('form') && el.closest('form') === composerRoot : !!el.closest('form')
      const inComposer = !!(
        el.closest('#prompt-textarea') ||
        el.closest('[data-testid="prompt-textarea"]') ||
        el.closest('form [contenteditable="true"]') ||
        el.closest('[data-testid*="composer" i]')
      )
      const inMessage = !!el.closest('[data-message-author-role]')
      const accept = el.getAttribute('accept') || ''
      const multiple = !!el.multiple
      const visible = style && style.visibility !== 'hidden' && style.display !== 'none'
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null
      const zeroSized = !rect || rect.width <= 0 || rect.height <= 0

      let s = 0
      if (inMessage) s -= 100
      if (inComposer) s += 100
      else if (inSameForm) s += 40
      // Composer attachment inputs are usually `multiple` and either
      // accept="*" / missing accept or accept contains "image".
      if (multiple) s += 30
      if (accept === '' || accept === '*') s += 25
      else if (/image/i.test(accept)) s += 15
      // Hidden inputs are fine for the composer (it's intentionally
      // hidden), but a hidden input in an unrelated profile/settings
      // form is suspicious. Don't penalize; composer attachment
      // inputs are hidden by design.
      void visible; void zeroSized
      return s
    }

    let best = null
    let bestScore = -Infinity
    let chosenTier = null
    const rankedSelectors = [
      ['form input[type="file"]', 'form'],
      ['input[type="file"][multiple]', 'multi'],
      ['input[type="file"]:not([accept])', 'no-accept'],
      ['input[type="file"][accept*="image" i]', 'accept-image'],
      ['input[type="file"]', 'catchall'],
    ]
    for (let r = 0; r < rankedSelectors.length; r++) {
      const matches = document.querySelectorAll(rankedSelectors[r][0])
      for (let i = 0; i < matches.length; i++) {
        const s = scoreInput(matches[i])
        if (s > bestScore) {
          best = matches[i]
          bestScore = s
          chosenTier = rankedSelectors[r][1] + '#' + i
        }
      }
      // Stop early once we found a strong composer match (inComposer,
      // multiple, same form). Score threshold tuned from observation:
      //   inComposer=true + multiple=30 + noAccept=25 = 155+
      // Anything above that in the first round is very likely the
      // right input.
      if (bestScore >= 155) break
    }
    if (!best) best = allFileInputs[0] || null
    diagLog('selected file input', {
      tier: chosenTier,
      accept: best && best.getAttribute('accept'),
      multiple: best && best.multiple,
      disabled: best && best.disabled,
      dataTestId: best && best.getAttribute('data-testid'),
      score: bestScore,
      inComposer: !!(
        best &&
        (best.closest('#prompt-textarea') ||
          best.closest('[data-testid="prompt-textarea"]') ||
          best.closest('form [contenteditable="true"]') ||
          best.closest('[data-testid*="composer" i]'))
      ),
    })

    // ── Choose the drop target for Strategy B. Prefer the composer
    //    form, then the contenteditable box, then `#prompt-textarea`,
    //    then `<main>`. ──
    function pickDropTarget() {
      if (!composer) return null
      const insideForm = composer.closest('form')
      if (insideForm) return insideForm
      const container = composer.closest('[data-testid*="composer" i]') || composer.closest('main') || document.body
      return container || null
    }

    // ── Choose the paste target for Strategy P. Always the actual
    //    composer element itself (`#prompt-textarea` / contenteditable),
    //    not the form root — ChatGPT's paste handler listens directly
    //    on the contenteditable, and dispatching paste on the form
    //    root was observed to NOT trigger the attachment pipeline.
    //    Fallback order mirrors composer probe. ──
    function pickPasteTarget() {
      if (!composer) return null
      return composer
    }

    // ── Paste dispatch helper. Tries `ClipboardEvent` first (some
    //    browsers expose a real ClipboardEvent constructor; the
    //    `clipboardData` option is respected). Falls back to a
    //    plain `Event('paste')` with a `clipboardData` getter that
    //    returns our DataTransfer — this is the path the
    //    `[ChatGPT-Paste-Diag]` diagnostic used and confirmed
    //    works. Returns `true` if dispatched, `false` if both
    //    attempts failed. ──
    // Dispatch a paste event on `target` with `dt` as the clipboardData.
    // Mode controls which constructor path to use:
    //   mode === 'P1' → ClipboardEvent('paste', { clipboardData: dt })
    //                    only. Returns true on success, false on throw.
    //   mode === 'P2' → Event('paste') + clipboardData getter only.
    //                    Returns true on success, false on throw.
    //   mode === undefined → try P1 first; on throw, fall back to P2.
    //                        Returns true if either succeeds.
    function dispatchPasteOn(target, dt, mode) {
      if (!target) return false
      const tryP1 = () => {
        if (typeof ClipboardEvent !== 'function') {
          throw new Error('ClipboardEvent constructor not available')
        }
        const ev = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        })
        target.dispatchEvent(ev)
        diagLog('paste dispatched via ClipboardEvent', {
          targetTag: target.tagName,
          defaultPrevented: ev.defaultPrevented,
          isTrusted: ev.isTrusted,
          items: dt.items ? dt.items.length : 0,
          files: dt.files ? dt.files.length : 0,
        })
        return true
      }
      const tryP2 = () => {
        const ev = new Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(ev, 'clipboardData', {
          configurable: true,
          get: function () { return dt },
        })
        target.dispatchEvent(ev)
        diagLog('paste dispatched via Event + clipboardData getter', {
          targetTag: target.tagName,
          defaultPrevented: ev.defaultPrevented,
          isTrusted: ev.isTrusted,
          items: dt.items ? dt.items.length : 0,
          files: dt.files ? dt.files.length : 0,
        })
        return true
      }
      if (mode === 'P1') {
        try { return tryP1() } catch (e) {
          diagLog('P1 ClipboardEvent threw', { message: (e && e.message) || String(e) })
          return false
        }
      }
      if (mode === 'P2') {
        try { return tryP2() } catch (e) {
          diagLog('P2 Event getter threw', { message: (e && e.message) || String(e) })
          return false
        }
      }
      // Fallback mode (legacy): try P1, then P2.
      try { return tryP1() } catch (e) {
        diagLog('P1 threw, falling back to P2', { message: (e && e.message) || String(e) })
      }
      try { return tryP2() } catch (e) {
        diagLog('P2 fallback threw', { message: (e && e.message) || String(e) })
      }
      return false
    }

    // ── Strategy A: React-safe input assignment + dual events. ────────
    function assignment3Tier(input, dt) {
      let tier = null
      // Tier 1: native prototype setter.
      try {
        const proto = Object.getPrototypeOf(input)
        const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'files') : null
        if (desc && desc.set) {
          desc.set.call(input, dt.files)
          tier = 'tier1'
        }
      } catch (_) {}
      // Tier 2: defineProperty getter.
      if (!tier) {
        try {
          Object.defineProperty(input, 'files', { configurable: true, get: function () { return dt.files } })
          tier = 'tier2'
        } catch (_) {}
      }
      // Tier 3: direct fallback.
      if (!tier) {
        try {
          input.files = dt.files
          tier = 'tier3'
        } catch (_) { tier = null }
      }
      return { tier, fileCount: input.files && input.files.length }
    }

    function dispatchInputAndChange(input) {
      try {
        input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))
      } catch (_) {}
      try {
        input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }))
      } catch (_) {}
      // Some React internals listen on `input` for the synthetic event
      // system; dispatch an InputEvent too if available.
      try {
        if (typeof InputEvent === 'function') {
          input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }))
        }
      } catch (_) {}
    }

    function dispatchDropOn(target, dt) {
      if (!target) return false
      try { target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt })) } catch (_) {}
      try { target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })) } catch (_) {}
      try { target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })) } catch (_) {}
      return true
    }

    // ── Strategy C candidate buttons: only composer-scoped. The
    //    user explicitly required NO global `button[aria-label*="Upload"]`
    //    click — clicking a settings/profile/workspace upload button
    //    opens unrelated UI. We require the button to be inside the
    //    composer form AND not in a chat history message. ──
    function clickAttachButton() {
      const sels = [
        // Explicit attach/upload/composer-plus selectors. These
        // match the ChatGPT composer attach button semantics
        // (the actual click target for opening the file picker).
        'button[aria-label*="Attach" i]',
        'button[aria-label*="Upload file" i]',
        'button[aria-label*="Upload image" i]',
        'button[aria-label*="Add files" i]',
        'button[aria-label*="Add photos" i]',
        'button[aria-label*="Add images" i]',
        'button[data-testid*="composer-attach" i]',
        'button[data-testid*="attach-button" i]',
        'button[data-testid*="upload-button" i]',
        'button[data-testid*="composer-plus" i]',
        '[data-testid*="composer-plus" i]',
        // NOTE: we deliberately exclude the bare `aria-label*="Upload"`
        //       selector — it matches ChatGPT workspace settings
        //       "Upload custom GPT" buttons that have nothing to do
        //       with the composer attachment flow. Same for the
        //       generic `aria-label*="Add" i` and the catch-all
        //       `aria-label="Open"` — those are scoped out.
        // 'button[aria-label*="Upload" i]',
        // 'button[aria-label*="Add" i]',
        // 'button[aria-label="Open"]',
      ]
      // We refuse to click anything that isn't INSIDE the composer
      // root. `composerRoot` is captured at scope setup time.
      const inComposerScope = (b) => {
        if (!composerRoot) {
          // No composer root → can't verify scope → refuse.
          return false
        }
        if (composerRoot.contains && composerRoot.contains(b)) return true
        const closestForm = b.closest('form')
        return !!(closestForm && composerRoot.contains(closestForm))
      }
      for (let i = 0; i < sels.length; i++) {
        const candidates = document.querySelectorAll(sels[i])
        for (let j = 0; j < candidates.length; j++) {
          const b = candidates[j]
          if (!b) continue
          if (!inComposerScope(b)) {
            diagLog('strategy=C skipped outside-composer button', {
              selector: sels[i],
              reason: 'outside composer root',
            })
            continue
          }
          // Real attach buttons in ChatGPT may be visible (rect > 0)
          // OR zero-sized and inside the composer (the actual upload
          // trigger is often a hidden <input> proxied through a
          // sibling button).
          const rect = b.getBoundingClientRect ? b.getBoundingClientRect() : null
          const visible = rect && (rect.width > 0 || rect.height > 0)
          try { b.click() } catch (_) {}
          return { ok: true, selector: sels[i], inComposer: true, visible }
        }
      }
      return { ok: false }
    }

    async function reselectFileInput() {
      // After clicking the attach button, the input may have changed
      // identity (or a second input may now exist). Re-run the
      // selection.
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
      let best2 = null
      let bestScore2 = -Infinity
      for (let i = 0; i < inputs.length; i++) {
        const s = scoreInput(inputs[i])
        if (s > bestScore2) {
          best2 = inputs[i]
          bestScore2 = s
        }
      }
      if (!best2) best2 = inputs[0] || null
      return { input: best2, score: bestScore2 }
    }

    function pollOnce(beforeCount, maxMs, stepMs) {
      return new Promise((resolve) => {
        const start = Date.now()
        let lastCount = self.chatgptCountComposerAttachments()
        let highest = lastCount
        const tick = () => {
          if (highest > beforeCount) {
            return resolve({
              finalCount: lastCount,
              peak: highest,
              delta: highest - beforeCount,
              timedOut: false,
            })
          }
          if (Date.now() - start >= maxMs) {
            return resolve({
              finalCount: lastCount,
              peak: highest,
              delta: highest - beforeCount,
              timedOut: highest <= beforeCount,
            })
          }
          self.chatgptSleep(stepMs).then(() => {
            lastCount = self.chatgptCountComposerAttachments()
            if (lastCount > highest) highest = lastCount
            tick()
          })
        }
        tick()
      })
    }

    // ── Strategy execution with per-strategy polling. ─────────────────
    const maxStepMs = 100
    const pollMaxMs = 5000
    // Build a single DataTransfer that all strategies share. DragEvents
    // require a fresh DataTransfer on each dispatch (the browser mutates
    // it during drop handling), so we rebuild it per strategy.
    async function buildDT() {
      const dt = new DataTransfer()
      // Use a fresh File copy — same bytes, same name, same type. The
      // browser drops read the dt.files synchronously.
      const f2 = new File([blob], fileName, { type: mimeType })
      dt.items.add(f2)
      return dt
    }

    // Helper: extract an actionable outcome from a poll result.
    function classifyDelta(delta) {
      if (delta >= 2) return 'duplicate'
      if (delta === 1) return 'ok'
      return 'none'
    }

    // ── Strategy P: synthetic paste on the composer (primary path).
    //    Real browser diagnostics showed that ChatGPT accepts a
    //    `ClipboardEvent('paste', { clipboardData })` (P1) on the
    //    composer. If P1 fires but produces no attachment delta in
    //    the short poll window, we try the Event('paste') +
    //    clipboardData getter (P2). Only after P1 AND P2 both fail
    //    do we fall through to A/B/C. ──
    log('strategy=P paste start')
    {
      const pasteTarget = pickPasteTarget()
      if (!pasteTarget) {
        diagLog('strategy=P no paste target — skipping')
      } else {
        try { pasteTarget.focus && pasteTarget.focus() } catch (_) {}
        const dtP = await buildDT()
        const beforeP = self.chatgptCountComposerAttachments()
        diagLog('strategy=P before paste', {
          targetTag: pasteTarget.tagName,
          targetId: pasteTarget.id || null,
          targetTestId: pasteTarget.getAttribute && pasteTarget.getAttribute('data-testid'),
          rootTag: (pasteTarget.closest('form') || {}).tagName || null,
          fileName,
          fileType: mimeType,
          fileSize: file.size,
          before: beforeP,
        })

        // ── P1: ClipboardEvent constructor. ──
        log('strategy=P1 ClipboardEvent start')
        const dispatchedP1 = dispatchPasteOn(pasteTarget, dtP, 'P1')
        if (dispatchedP1) {
          // Short poll — 1.5s — for the typical ~500ms commit. If
          // delta > 0 here, we return success immediately without
          // touching A/B/C.
          const pollP1 = await pollOnce(beforeP, 1500, maxStepMs)
          const classP1 = classifyDelta(pollP1.delta)
          if (classP1 === 'duplicate') {
            log('strategy=P1 duplicate attachments detected', { before: beforeP, peak: pollP1.peak })
            return {
              success: false,
              error: 'CHATGPT_SUBMIT_FAILED: duplicate attachments detected',
            }
          }
          if (classP1 === 'ok') {
            log('attachment detected', { strategy: 'P1', before: beforeP, after: pollP1.peak })
            return { success: true, strategy: 'P1' }
          }
          log('strategy=P1 no attachment delta', { before: beforeP, after: pollP1.peak })
        } else {
          log('strategy=P1 dispatch failed (ClipboardEvent not available or threw)')
        }

        // ── P2: Event('paste') + clipboardData getter. ──
        log('strategy=P2 Event getter start')
        // Re-sample baseline in case the composer state changed.
        const beforeP2 = self.chatgptCountComposerAttachments()
        const dispatchedP2 = dispatchPasteOn(pasteTarget, dtP, 'P2')
        if (!dispatchedP2) {
          diagLog('strategy=P2 dispatch failed — Event constructor threw')
        }
        // Full poll window for P2 (since the diagnostic confirmed
        // ~500ms typical, 5s ceiling matches A/B/C).
        const pollP2 = await pollOnce(beforeP2, pollMaxMs, maxStepMs)
        const classP2 = classifyDelta(pollP2.delta)
        if (classP2 === 'duplicate') {
          log('strategy=P2 duplicate attachments detected', { before: beforeP2, peak: pollP2.peak })
          return {
            success: false,
            error: 'CHATGPT_SUBMIT_FAILED: duplicate attachments detected',
          }
        }
        if (classP2 === 'ok') {
          log('attachment detected', { strategy: 'P2', before: beforeP2, after: pollP2.peak })
          return { success: true, strategy: 'P2' }
        }
        log('strategy=P2 no attachment delta', { before: beforeP2, after: pollP2.peak })
      }
    }

    // ── Strategy A: 3-tier assignment + dual events. ──────────────────
    let input = best
    log('strategy=A assign+change start', {
      tagName: input && input.tagName,
      accept: input && input.getAttribute('accept'),
      multiple: input && input.multiple,
    })
    if (!input) {
      log('strategy=A no input available — skipping')
    } else {
      const dt = await buildDT()
      const beforeA = self.chatgptCountComposerAttachments()
      const { tier, fileCount } = assignment3Tier(input, dt)
      diagLog('strategy=A assignment result', { tier, fileCount })
      dispatchInputAndChange(input)
      const pollA = await pollOnce(beforeA, pollMaxMs, maxStepMs)
      const classA = classifyDelta(pollA.delta)
      if (classA === 'duplicate') {
        log('strategy=A duplicate attachments detected', { before: beforeA, peak: pollA.peak })
        return {
          success: false,
          error: 'CHATGPT_SUBMIT_FAILED: duplicate attachments detected',
        }
      }
      if (classA === 'ok') {
        log('attachment detected', { strategy: 'A', before: beforeA, after: pollA.peak, tier })
        return { success: true, strategy: 'A' }
      }
      log('strategy=A no attachment delta', { before: beforeA, after: pollA.peak, tier })
    }

    // ── Strategy B: drop event fallback. ──────────────────────────────
    log('strategy=B drop start')
    const dropTarget = pickDropTarget()
    if (dropTarget) {
      const dtB = await buildDT()
      const beforeB = self.chatgptCountComposerAttachments()
      dispatchDropOn(dropTarget, dtB)
      const pollB = await pollOnce(beforeB, pollMaxMs, maxStepMs)
      const classB = classifyDelta(pollB.delta)
      if (classB === 'duplicate') {
        log('strategy=B duplicate attachments detected', { before: beforeB, peak: pollB.peak })
        return {
          success: false,
          error: 'CHATGPT_SUBMIT_FAILED: duplicate attachments detected',
        }
      }
      if (classB === 'ok') {
        log('attachment detected', { strategy: 'B', before: beforeB, after: pollB.peak })
        return { success: true, strategy: 'B' }
      }
      log('strategy=B no attachment delta', { before: beforeB, after: pollB.peak })
    } else {
      log('strategy=B no drop target — skipping')
    }

    // ── Strategy C: click attach button + retry. ──────────────────────
    log('strategy=C attach button click start')
    const clickResult = clickAttachButton()
    diagLog('strategy=C click result', clickResult)
    // Settle wait 300-800ms.
    await self.chatgptSleep(500)
    const re = await reselectFileInput()
    const retryInput = re.input
    if (clickResult.ok && retryInput) {
      const dtC = await buildDT()
      const beforeC = self.chatgptCountComposerAttachments()
      const { tier: tierC, fileCount: fcC } = assignment3Tier(retryInput, dtC)
      diagLog('strategy=C assignment result', { tier: tierC, fileCount: fcC, score: re.score })
      dispatchInputAndChange(retryInput)
      const pollC = await pollOnce(beforeC, pollMaxMs, maxStepMs)
      const classC = classifyDelta(pollC.delta)
      if (classC === 'duplicate') {
        log('strategy=C duplicate attachments detected', { before: beforeC, peak: pollC.peak })
        return {
          success: false,
          error: 'CHATGPT_SUBMIT_FAILED: duplicate attachments detected',
        }
      }
      if (classC === 'ok') {
        log('attachment detected', { strategy: 'C', before: beforeC, after: pollC.peak, tier: tierC })
        return { success: true, strategy: 'C' }
      }
      log('strategy=C no attachment delta', { before: beforeC, after: pollC.peak, tier: tierC })
    } else {
      diagLog('strategy=C skipped', { clickResult, hasInput: !!retryInput })
    }

    log('all strategies failed')
    return {
      success: false,
      error: 'CHATGPT_SUBMIT_FAILED: media upload did not attach',
    }
  },

  clickGenerate() {
    const selectors = [
      'button[type="submit"]',
      'button:has-text("Generate")',
      '[data-testid="generate-button"]',
      'button[class*="generate"]',
      '[role="button"]:has-text("Generate")'
    ]

    for (const selector of selectors) {
      try {
        const btn = document.querySelector(selector)
        if (btn) {
          btn.click()
          return { success: true }
        }
      } catch {}
    }

    const buttons = document.querySelectorAll('button')
    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase() || ''
      if (text.includes('generate') || text.includes('create') || text.includes('submit')) {
        btn.click()
        return { success: true }
      }
    }

    throw new Error('Generate button not found')
  },

  downloadResult() {
    const img = document.querySelector('img[src*="generation"], img[class*="result"], img[class*="output"]')
    if (img) {
      return { success: true, data: img.src }
    }

    const canvas = document.querySelector('canvas')
    if (canvas) {
      return { success: true, data: canvas.toDataURL('image/png') }
    }

    throw new Error('Result not found')
  },

  setModel(model) {
    const modelSelectors = [
      'select[id*="model"]',
      '[data-testid="model-selector"]',
      '[role="combobox"]'
    ]
    for (const selector of modelSelectors) {
      const el = document.querySelector(selector)
      if (el) {
        if (el.tagName === 'SELECT') {
          el.value = model
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
        return { success: true }
      }
    }
    return { success: false, error: 'Model selector not found' }
  },

  setAspectRatio(ratio) {
    const ratioMap = { '1:1': 'square', '16:9': 'landscape', '9:16': 'portrait', '4:3': 'standard', '3:4': 'portrait-standard' }
    const value = ratioMap[ratio] || ratio

    const selectors = [
      `[data-aspect-ratio="${value}"]`,
      `[data-value="${ratio}"]`,
      `button[aria-label*="${ratio}"]`
    ]

    for (const selector of selectors) {
      const el = document.querySelector(selector)
      if (el) {
        el.click()
        return { success: true }
      }
    }

    return { success: false, error: 'Aspect ratio selector not found' }
  },

  setMediaType(mediaType) {
    const normalized = String(mediaType || 'image').toLowerCase() === 'video' ? 'video' : 'image'
    const labels = normalized === 'video' ? ['video'] : ['image', 'ảnh', 'hình']
    const selectors = [
      `[data-value="${normalized}"]`,
      `[data-media-type="${normalized}"]`,
      `button[aria-label*="${normalized}"]`
    ]

    for (const selector of selectors) {
      const el = document.querySelector(selector)
      if (el) {
        el.click()
        return { success: true }
      }
    }

    const controls = document.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"]')
    for (const control of controls) {
      const text = control.textContent?.trim().toLowerCase() || ''
      if (labels.some((label) => text === label || text.includes(label))) {
        control.click()
        return { success: true }
      }
    }

    return { success: false, error: 'Media type selector not found' }
  },

  setDuration(duration) {
    const value = String(duration || '').trim()
    if (!value) return { success: true, skipped: true }
    const numeric = value.replace(/s$/i, '')
    const selectors = [
      `[data-value="${value}"]`,
      `[data-duration="${value}"]`,
      `button[aria-label*="${value}"]`
    ]

    for (const selector of selectors) {
      const el = document.querySelector(selector)
      if (el) {
        el.click()
        return { success: true }
      }
    }

    const controls = document.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"]')
    for (const control of controls) {
      const text = control.textContent?.trim().toLowerCase() || ''
      if (text === value.toLowerCase() || text === numeric || text === `${numeric}s`) {
        control.click()
        return { success: true }
      }
    }

    return { success: false, error: 'Duration selector not found' }
  },

  getStatus() {
    const indicators = [
      { selector: '[class*="loading"]', status: 'loading' },
      { selector: '[class*="generating"]', status: 'generating' },
      { selector: '[class*="error"]', status: 'error' },
      { selector: '[class*="success"]', status: 'complete' }
    ]

    for (const { selector, status } of indicators) {
      if (document.querySelector(selector)) {
        return { status }
      }
    }

    return { status: 'idle' }
  },

  getPromptSelectors() {
    const providerSelectors = {
      'google-flow': ['textarea[name="prompt"]', '[data-testid="prompt-input"]', 'div[contenteditable="true"]', 'textarea.ql-textarea', 'div[contenteditable]'],
      'chatgpt': ['textarea[data-id="root"]', '[data-testid="prompt-textarea"]', '#prompt-textarea'],
      'grok': ['textarea[id*="prompt"]', '[data-testid="input-box"]']
    }
    return providerSelectors[this.currentProvider] || providerSelectors['chatgpt']
  },

  setInputValue(element, value) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    const nativeInputValueSetterInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set

    if (element.tagName === 'TEXTAREA' && nativeInputValueSetter) {
      nativeInputValueSetter.call(element, value)
    } else if (element.tagName === 'INPUT' && nativeInputValueSetterInput) {
      nativeInputValueSetterInput.call(element, value)
    } else {
      element.value = value
    }
  },

  dispatchInputEvent(element) {
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  },

  // ── ChatGPT submit + wait-for-images (fire-and-forget) ─────────────────
  // Called by background. We acknowledge synchronously with { accepted: true, jobId }
  // so the background doesn't hold a 300s tabs.sendMessage channel open.
  // The long poll runs here, then posts CHATGPT_JOB_DONE back to background.
  async chatgptSubmitAndWait(payload) {
    const prompt = payload?.prompt
    const ratio = payload?.ratio
    const timeoutMs = Number(payload?.timeoutMs) || 300000
    const jobId = payload?.jobId
    const mediaUploads = Array.isArray(payload?.mediaUploads) ? payload.mediaUploads : []

    if (!jobId || typeof jobId !== 'string') {
      return { accepted: false, error: 'jobId is required' }
    }
    if (!prompt || typeof prompt !== 'string') {
      // Still post a failure for the background to consume.
      safeSendFireAndForget({
        action: 'CHATGPT_JOB_DONE',
        jobId,
        payload: { success: false, error: 'Prompt is required' },
      })
      return { accepted: false, error: 'Prompt is required' }
    }

    const state = getAIFlowContentState()
    const jobMap = state.chatgptJobs || (state.chatgptJobs = {})
    const existingJob = jobMap[jobId]
    if (existingJob && existingJob.status === 'running') {
      console.log('[ChatGPT][Job] duplicate CHATGPT_SUBMIT_AND_WAIT ignored', {
        jobId,
        startedAt: existingJob.startedAt,
      })
      return { accepted: true, jobId, duplicate: true }
    }
    const activeDifferentJob = Object.entries(jobMap).find(([id, job]) => {
      return id !== jobId && job && job.status === 'running'
    })
    if (activeDifferentJob) {
      const activeJobId = activeDifferentJob[0]
      console.warn('[ChatGPT][Job] concurrent CHATGPT_SUBMIT_AND_WAIT rejected', {
        jobId,
        activeJobId,
      })
      safeSendFireAndForget({
        action: 'CHATGPT_JOB_DONE',
        jobId,
        payload: {
          success: false,
          error: 'CHATGPT_BUSY: another ChatGPT automation job is already running',
        },
      })
      return {
        accepted: false,
        jobId,
        error: 'CHATGPT_BUSY: another ChatGPT automation job is already running',
      }
    }
    jobMap[jobId] = { status: 'running', startedAt: Date.now() }

    // Acknowledge to background immediately so it can release the tabs.sendMessage
    // channel. The job continues running on this tab.
    // Use setTimeout(..., 0) so the synchronous ack can flush first.
    setTimeout(() => {
      this.runChatGPTJob({ jobId, prompt, ratio, timeoutMs, mediaUploads }).catch(async (err) => {
        console.error('[ChatGPT] job crashed:', err)
        safeSendFireAndForget({
          action: 'CHATGPT_JOB_DONE',
          jobId,
          payload: { success: false, error: (err && err.message) || String(err) },
        })
      }).finally(() => {
        const latestState = getAIFlowContentState()
        const latestJobMap = latestState.chatgptJobs || (latestState.chatgptJobs = {})
        latestJobMap[jobId] = { status: 'finished', finishedAt: Date.now() }
        setTimeout(() => {
          try {
            const cleanupState = getAIFlowContentState()
            if (cleanupState.chatgptJobs?.[jobId]?.status === 'finished') {
              delete cleanupState.chatgptJobs[jobId]
            }
          } catch (_) {}
        }, 30 * 60 * 1000)
      })
    }, 0)

    return { accepted: true, jobId }
  },

  // The actual long-running job. Posts CHATGPT_JOB_DONE when finished.
  //
  // Phase pipeline (each transition is logged with [ChatGPT][Job]):
  //   0. media upload (if any)
  //   1. image-mode + ratio (best-effort)
  //   2. wait for idle + capture PRE-SUBMIT baseline
  //   3. prompt insert + verify text in composer
  //   4. verify attachments present (if mediaUploads > 0)
  //   5. find send button + verify enabled
  //   6. click send ONCE + verify submit (composer cleared OR spinner OR
  //      new assistant turn OR send-button disabled)
  //   7. capture POST-SUBMIT baseline; only count images/results that
  //      appear after the new assistant response — uploaded reference
  //      previews are explicitly excluded.
  async runChatGPTJob({ jobId, prompt, ratio, timeoutMs, mediaUploads }) {
    const sendDone = (result) => {
      safeSendFireAndForget({ action: 'CHATGPT_JOB_DONE', jobId, payload: result })
    }
    const log = (msg, extra) => {
      if (extra !== undefined) console.log('[ChatGPT][Job] ' + msg, extra)
      else console.log('[ChatGPT][Job] ' + msg)
    }

    const mediaCount = Array.isArray(mediaUploads) ? mediaUploads.length : 0
    const POLL_INTERVAL_MS = 1000 // preserved verbatim by Plasmo minifier

    // 0. Pre-upload composer cleanup. If a previous attempt left
    //    attachments in the composer (e.g. submit failed and the
    //    runner is going to retry the Generate Node), we MUST remove
    //    them BEFORE we upload the next batch — otherwise the
    //    composer ends up with stale + new attachments duplicated
    //    (observed as 4 attachments when the workflow only has 1
    //    Media Node, after 3 retries).
    if (mediaCount > 0) {
      log('composer cleanup start')
      try {
        await this.chatgptWaitForIdle(30000)
      } catch (_) { /* best-effort */ }
      // Wait briefly for the composer DOM to settle after idle.
      await this.chatgptSleep(200)
      const beforeClear = this.chatgptCountComposerAttachments()
      if (beforeClear > 0) {
        log('stale attachments found', { count: beforeClear })
        const removed = this.chatgptRemoveAllComposerAttachments()
        await this.chatgptSleep(300)
        const afterClear = this.chatgptCountComposerAttachments()
        if (removed > 0) {
          log('stale attachments removed', {
            requested: beforeClear,
            remaining: afterClear,
          })
        }
        if (afterClear > 0) {
          return sendDone({
            success: false,
            error: 'CHATGPT_SUBMIT_FAILED: composer has stale attachments and could not be cleared',
          })
        }
      }
    }

    // 0a. Idempotent short-circuit: if the composer already shows
    //     exactly mediaCount attachment previews (e.g. a prior job
    //     left them there and we somehow got re-invoked), do NOT
    //     upload again. The post-submit verifier still confirms the
    //     count matches, so a stale-feeling match won't slip
    //     duplicates through — and the runner-side retry gate
    //     prevents this from being the typical path.
    if (mediaCount > 0) {
      const alreadyAttached = this.chatgptCountComposerAttachments()
      if (alreadyAttached === mediaCount) {
        log('media upload skipped/already present', { count: alreadyAttached })
        log('media upload done', { count: mediaCount })
        // Skip phases 0b and 0c — attachments are already in the
        // composer and a prior job placed them. We fall through to
        // the rest of the pipeline (text insert, send, etc.).
        return this.runChatGPTJobAfterUpload({
          jobId,
          prompt,
          ratio,
          timeoutMs,
          mediaCount,
          alreadyUploadedAttachments: true,
          sendDone,
          log,
        })
      }
    }

    // 0b. Upload reference images. Strategy escalation lives
    //     INSIDE `uploadImage` (A: 3-tier input assignment; B: drop
    //     event; C: click attach button + retry). The outer loop
    //     makes a single call per media item. Reasons:
    //
    //       * Each strategy has its own count-poll gate.
    //       * Each strategy itself can take ~5 s to settle.
    //       * Re-running `uploadImage` for the same media is a
    //         non-idempotent UI side effect — duplicates risk.
    //
    //     The outer loop's contract is: ONE call to uploadImage per
    //     media; if it returns success → done; if it returns a
    //     structured failure (duplicate / did-not-attach) → forward
    //     the error to the job. We do NOT retry the same media.
    log('media upload start', { count: mediaCount })
    if (mediaCount > 0) {
      for (let i = 0; i < mediaCount; i++) {
        const media = mediaUploads[i]
        if (!media || !media.base64 || !media.type) {
          return sendDone({
            success: false,
            error: 'ChatGPT media upload ' + (i + 1) + '/' + mediaCount +
              ' skipped: missing base64/type',
          })
        }
        const dataUrl = 'data:' + media.type + ';base64,' + media.base64

        let uploadResult = null
        try {
          uploadResult = await this.uploadImage(dataUrl)
        } catch (e) {
          // uploadImage is now an async operation that may either
          // throw synchronously (decode error) or return a structured
          // failure with { success: false, error }. Surface both.
          uploadResult = {
            success: false,
            error: 'uploadImage threw: ' + ((e && e.message) || String(e)),
          }
        }
        if (!uploadResult || uploadResult.success !== true) {
          const errMsg = (uploadResult && uploadResult.error)
            || 'CHATGPT_SUBMIT_FAILED: media upload did not attach'
          return sendDone({ success: false, error: errMsg })
        }
        log('media upload attached', {
          index: i + 1,
          strategy: uploadResult.strategy || 'unknown',
        })
        // Brief settle so the next upload sees a stable composer
        // DOM. With Strategy C, the click may have caused a
        // re-render; 200ms is generous.
        await this.chatgptSleep(200)
      }
    }
    log('media upload done', { count: mediaCount })

    // 0c. Post-upload verification. Composer attachment count MUST
    //     equal mediaCount. If the count is less, an upload silently
    //     failed; if greater, duplicates slipped in (e.g. ChatGPT
    //     accidentally attached the file twice to the same prompt).
    if (mediaCount > 0) {
      // Give ChatGPT a moment to render any straggler previews.
      await this.chatgptSleep(200)
      const attached = this.chatgptCountComposerAttachments()
      log('composer attachments counted', { attached, expected: mediaCount })
      if (attached > mediaCount) {
        log('duplicate attachments detected', { attached, expected: mediaCount })
        return sendDone({
          success: false,
          error: 'CHATGPT_SUBMIT_FAILED: duplicate attachments detected',
        })
      }
      if (attached < mediaCount) {
        return sendDone({
          success: false,
          error: 'CHATGPT_SUBMIT_FAILED: composer shows ' + attached +
            ' attachment(s), expected ' + mediaCount,
        })
      }
    }

    return this.runChatGPTJobAfterUpload({
      jobId,
      prompt,
      ratio,
      timeoutMs,
      mediaCount,
      alreadyUploadedAttachments: false,
      sendDone,
      log,
    })
  },

  // Continuation of runChatGPTJob after the upload phase. Pulled out
  // so the upload-skip branch (composer already shows the expected
  // attachments) does not duplicate the whole pipeline below.
  async runChatGPTJobAfterUpload({
    jobId,
    prompt,
    ratio,
    timeoutMs,
    mediaCount,
    alreadyUploadedAttachments,
    sendDone,
    log,
  }) {

    // 1. Image-mode + ratio (best-effort; failures are logged, not fatal)
    try {
      await this.chatgptEnableImageMode()
    } catch (e) {
      console.log('[ChatGPT] image-mode toggle skipped:', (e && e.message) || e)
    }
    if (ratio) {
      try {
        await this.chatgptSetRatio(ratio)
      } catch (e) {
        console.log('[ChatGPT] ratio setter skipped:', (e && e.message) || e)
      }
    }

    // 2. Wait for idle + capture pre-submit baseline of file_ids. The
    //    post-upload attachments are now in the DOM — their file_ids
    //    land in this baseline so they are not counted as new images.
    await this.chatgptWaitForIdle(30000)
    const preSubmitFileIds = this.chatgptCollectFileIds()
    const preSubmitAssistantTurnCount = this.chatgptCountAssistantTurns()
    log('pre-submit baseline', {
      fileIds: preSubmitFileIds.size,
      assistantTurns: preSubmitAssistantTurnCount,
    })

    // 3. Insert prompt and verify text is actually in the composer.
    //    The previous flow did not verify text length after insertion,
    //    so a silently-failed insert would proceed to submit.
    log('prompt insert start')
    const editor = await this.chatgptFindComposer(10000, 200)
    if (!editor) {
      return sendDone({
        success: false,
        error: 'CHATGPT_SUBMIT_FAILED: composer not found before insert',
      })
    }
    // Clear any leftover text from a previous attempt.
    this.chatgptClearEditor(editor)
    const inserted = this.chatgptInsertPrompt(editor, prompt)
    if (!inserted) {
      return sendDone({
        success: false,
        error: 'CHATGPT_SUBMIT_FAILED: prompt insert returned false',
      })
    }
    // Verify text actually landed in the composer.
    await this.chatgptSleep(150)
    const insertedText = (editor.textContent || editor.value || '')
    if (!insertedText.includes(prompt.slice(0, 20))) {
      return sendDone({
        success: false,
        error: 'CHATGPT_SUBMIT_FAILED: prompt text not visible in composer after insert',
      })
    }
    log('prompt insert verified', { textLength: insertedText.length })

    // 4. (Attachment count is verified right after upload at step 0c —
    //    before submit we only re-check the count to catch any
    //    duplications caused by ChatGPT rendering between upload and
    //    submit. Same `duplicate attachments detected` failure path.)
    if (mediaCount > 0) {
      const attachedBeforeSubmit = this.chatgptCountComposerAttachments()
      if (attachedBeforeSubmit > mediaCount) {
        log('duplicate attachments detected', {
          attached: attachedBeforeSubmit,
          expected: mediaCount,
          phase: 'pre-submit',
        })
        return sendDone({
          success: false,
          error: 'CHATGPT_SUBMIT_FAILED: duplicate attachments detected',
        })
      }
    }

    // 5. Find send button and verify it is enabled / not aria-disabled.
    log('send button lookup start')
    const sendButton = await this.chatgptFindSubmitButtonWithRetry(5000, 200)
    if (!sendButton) {
      log('send button not found; using keyboard/form fallback')
    } else if (!this.chatgptIsButtonUsable(sendButton)) {
      log('send button disabled/hidden; using keyboard/form fallback')
    } else {
      log('send button found/enabled')
    }

    // 6. Click Send ONCE (do not Enter + click). Then verify submit
    //    actually happened. We use the existing chatgptDidSubmit
    //    multi-signal check, which is the same logic the prior
    //    Enter-strategy used. The local baseline here is captured
    //    just before clicking, so a real submit will produce a
    //    genuine "new file_id / new assistant turn / spinner /
    //    button-disabled" signal — not a stale one.
    const baselineAssistantTurnCountForClick = this.chatgptCountAssistantTurns()
    const baselineUserTurnCountForClick = this.chatgptCountUserTurns()
    const baselineFileIdsForClick = this.chatgptCollectFileIds()
    const baselineImageSignaturesForClick = this.chatgptCollectImageSignatures()
    let submitted = false
    if (sendButton && this.chatgptIsButtonUsable(sendButton)) {
      log('send click attempted')
      this.chatgptPointerClickButton(sendButton)
      submitted = await this.chatgptWaitForSubmitSignal(
        editor,
        baselineAssistantTurnCountForClick,
        baselineFileIdsForClick,
        { allowFileIdSignal: false, baselineUserTurnCount: baselineUserTurnCountForClick },
        7000,
        250
      )
      if (!submitted) {
        log('send click not verified; skipping fallback to avoid duplicate submit')
        return sendDone({
          success: false,
          error: 'CHATGPT_SUBMIT_UNVERIFIED: send click did not produce a submit signal',
        })
      }
    } else {
      log('send fallback attempted')
      const fallbackResult = await this.chatgptSubmitExistingComposerFallbacks(
        editor,
        baselineAssistantTurnCountForClick,
        baselineFileIdsForClick,
        { allowFileIdSignal: false, baselineUserTurnCount: baselineUserTurnCountForClick }
      )
      submitted = !!(fallbackResult && fallbackResult.success)
      if (submitted) log('send fallback verified', { strategy: fallbackResult.strategy })
    }
    if (!submitted) {
      log('submit NOT verified — failing')
      return sendDone({
        success: false,
        error: 'ChatGPT submit failed: send button was not clicked or did not submit',
      })
    }
    log('submit verified')

    // 7. Capture POST-SUBMIT baseline for image counting. From this
    //    point on, anything rendered into the chat history by the new
    //    assistant turn counts as a generated image; anything in the
    //    composer attachment tray or in the pre-submit file_ids set
    //    does NOT count.
    // Use the PRE-click assistant-turn count as the result baseline.
    // A new assistant turn can mount during the 1.5s submit verification
    // window; if we baseline after that, the generated image in that turn
    // is incorrectly treated as an old result and never returned.
    const postSubmitAssistantTurnCount = baselineAssistantTurnCountForClick
    const postSubmitFileIds = new Set(preSubmitFileIds)
    const postSubmitImageSignatures = new Set(baselineImageSignaturesForClick)
    // Also include any file_ids that appeared during the click window.
    baselineFileIdsForClick.forEach((id) => postSubmitFileIds.add(id))
    log('waiting result', {
      timeoutMs,
      postSubmitAssistantTurnCount,
    })

    // Poll for new generated images. The loop is now progress-based
    // and respects active signals (generating, hasPendingImage,
    // candidateImages > 0). `timeoutMs` is the INITIAL no-progress
    // budget; once we see any progress, the loop continues up to
    // `maxWaitMs` as long as there is fresh activity.
    //
    // Three time budgets:
    //
    //   * initialNoProgressTimeoutMs = max(timeoutMs, 300000)
    //     We fail with "no generation progress" if we never see
    //     any real advance inside this window.
    //
    //   * staleMs = 90s.  When we have seen progress, we fail with
    //     "progress stale" if `now - lastProgressAt > staleMs` AND
    //     there is no active signal.
    //
    //   * activeGraceMs = 180s.  When we have an active signal, we
    //     extend grace to 2x staleMs before failing.
    //
    //   * renderGraceMs = 30s.  After spinner stops, we wait this
    //     long for the asset URL to wire up before declaring a
    //     hard failure.
    //
    //   * maxWaitMs = max(timeoutMs, 600000). Absolute cap. The
    //     error at the end of this cap is
    //     "ChatGPT generation max wait exceeded after Ns".
    //
    // IMPORTANT: we no longer use `timeoutMs` as a hard loop cap.
    // The previous implementation exited the while-loop as soon as
    // `elapsed >= timeoutMs` regardless of whether the image was
    // mid-render, which made the runner's heartbeat-based wait
    // useless: this script would post CHATGPT_JOB_DONE with
    // success:false 60s in, beating the runner to the punch.
    const effectiveTimeoutMs = Math.max(Number(timeoutMs) > 0 ? Number(timeoutMs) : 300000, 300000)
    const initialNoProgressTimeoutMs = Math.max(effectiveTimeoutMs, 300000)
    const maxWaitMs = Math.max(effectiveTimeoutMs, 600000)
    const staleMs = 90000
    const activeGraceMs = 180000
    const renderGraceMs = 30000
    const start = Date.now()
    const submittedAt = start
    let lastGenerating = false
    let noSpinnerSince = null
    let sawGenerating = false
    let sawAnyProgress = false
    let lastProgressAt = 0
    let pendingImageStartedAt = null
    let prevPhase = null
    let prevGenerating = null
    let prevAssistantTurns = null
    let prevCandidateImages = -1
    let prevAcceptedImages = -1
    let prevHasPendingImage = null

    const sendHeartbeat = (phase, extras) => {
      const now = Date.now()
      const candidateImages = (extras && Number(extras.candidateImages)) || 0
      const acceptedImages = (extras && Number(extras.acceptedImages)) || 0
      const hasPendingImage = !!(extras && extras.hasPendingImage)
      const generating = !!(extras && extras.generating)
      const assistantTurns = (extras && Number(extras.assistantTurns)) >= 0
        ? Number(extras.assistantTurns)
        : this.chatgptCountAssistantTurns()
      const lastAssistantTextLength = (extras && Number(extras.lastAssistantTextLength)) || 0

      // Did the generation actually advance since the previous
      // heartbeat? Heartbeats that observe no change carry
      // progressChanged:false so the background does NOT bump
      // lastProgressAt. We do however use the same comparison to
      // update THIS script's local `lastProgressAt` — that is the
      // primary signal for the loop's no-progress / stale gates.
      const phaseChanged = phase !== prevPhase
      const generatingFlippedOn = generating && prevGenerating === false
      const turnsBumped = assistantTurns > (prevAssistantTurns == null ? -1 : prevAssistantTurns)
      const candidatesBumped = candidateImages > (prevCandidateImages == null ? -1 : prevCandidateImages)
      const acceptedBumped = acceptedImages > (prevAcceptedImages == null ? -1 : prevAcceptedImages)
      const pendingFlippedOn = hasPendingImage && prevHasPendingImage === false
      const progressChanged =
        phaseChanged || generatingFlippedOn || turnsBumped || candidatesBumped || acceptedBumped || pendingFlippedOn ||
        (extras && extras.progressChanged === true)

      prevPhase = phase
      prevGenerating = generating
      prevAssistantTurns = assistantTurns
      prevCandidateImages = candidateImages
      prevAcceptedImages = acceptedImages
      prevHasPendingImage = hasPendingImage

      if (progressChanged) {
        lastProgressAt = now
        sawAnyProgress = true
      }

      chatgptSendProgress(jobId, {
        phase,
        generating,
        assistantTurns,
        candidateImages,
        acceptedImages,
        hasPendingImage,
        lastAssistantTextLength,
        elapsedMs: now - start,
        progressChanged,
        lastMessage: extras && extras.lastMessage,
      })
    }

    // Send an initial heartbeat so the runner knows we have entered
    // the polling phase.
    sendHeartbeat('waiting_result', {
      generating: false,
      assistantTurns: this.chatgptCountAssistantTurns(),
      lastMessage: 'poll loop entered',
    })

    while (Date.now() - start < maxWaitMs) {
      if (!safeRuntimeContext()) {
        return sendDone({
          success: false,
          error: 'ChatGPT job aborted: extension context invalidated. Reload the chatgpt.com tab and retry.',
        })
      }
      await this.chatgptSleep(1000)

      const generating = this.chatgptIsGenerating()
      if (generating) {
        sawGenerating = true
        noSpinnerSince = null
      } else if (noSpinnerSince === null) {
        noSpinnerSince = Date.now()
      }
      if (generating !== lastGenerating) {
        console.log('[ChatGPT] generating state ->', generating)
        lastGenerating = generating
        sendHeartbeat(generating ? 'generating' : 'rendering', {
          generating,
          lastMessage: generating ? 'spinner active' : 'spinner stopped',
        })
      } else {
        sendHeartbeat(generating ? 'generating' : 'waiting_result', { generating })
      }

      const textOnlyError = this.chatgptDetectTextOnlyError()
      if (textOnlyError) {
        sendHeartbeat('failed', { generating: false, lastMessage: 'text-only refusal' })
        return sendDone({
          success: false,
          error: 'ChatGPT returned text instead of image',
          message: textOnlyError,
        })
      }

      // Global image fallback comes BEFORE the assistant-turn gate.
      // ChatGPT's current DOM sometimes paints generated images outside
      // `[data-message-author-role="assistant"]`; if we wait for a new
      // assistant turn first, a finished image can be visible forever
      // while this job stays in `waiting_result`.
      const newImages = this.chatgptCollectGeneratedImages(
        postSubmitFileIds,
        postSubmitAssistantTurnCount,
        postSubmitImageSignatures
      )
      if (newImages.length > 0) {
        sendHeartbeat(generating ? 'rendering' : 'done', {
          generating,
          candidateImages: newImages.length,
          acceptedImages: generating ? 0 : newImages.length,
          lastMessage: generating ? 'images visible, waiting for spinner to stop' : 'images collected',
        })
        if (generating) continue
        log('result detected', { count: newImages.length })
        log('CHATGPT_JOB_DONE sent', { success: true, imageCount: newImages.length })
        return sendDone({ success: true, imageUrls: newImages })
      }

      // Pre-turn grace: we have not yet seen a new assistant turn.
      // Keep waiting without time-based failure as long as we are
      // still inside the initial budget. After that, fail with
      // "no generation progress" if we have not seen a new turn.
      const currentAssistantTurns = this.chatgptCountAssistantTurns()
      if (currentAssistantTurns <= postSubmitAssistantTurnCount) {
        if (generating) continue
        if (sawAnyProgress && Date.now() - start < maxWaitMs) continue
        if (Date.now() - start < initialNoProgressTimeoutMs) continue
        const stableNoSpinnerMs = noSpinnerSince ? Date.now() - noSpinnerSince : 0
        if (stableNoSpinnerMs < renderGraceMs) continue
        sendHeartbeat('failed', { generating: false, lastMessage: 'no new assistant turn' })
        return sendDone({
          success: false,
          error: 'ChatGPT no generation progress after ' +
            Math.round(initialNoProgressTimeoutMs / 1000) + 's: no new assistant turn',
        })
      }
      // No fully-rendered image yet. Check for a partial / pending
      // image marker. While present we keep waiting up to
      // activeGraceMs even past maxWaitMs-of-time-since-submit,
      // because the asset is in flight.
      const hasPendingImageMarker = this.chatgptHasPendingImageMarker()
      if (hasPendingImageMarker) {
        if (pendingImageStartedAt === null) pendingImageStartedAt = Date.now()
        sendHeartbeat('rendering', {
          generating,
          candidateImages: 0,
          acceptedImages: 0,
          hasPendingImage: true,
          lastMessage: 'pending image marker',
        })
        continue
      } else {
        pendingImageStartedAt = null
      }

      // While generating, keep waiting.
      if (generating) {
        sendHeartbeat('generating', { generating })
        continue
      }

      // No spinner, new turn present, no pending marker, no images.
      // Apply the render grace. We do NOT use a hard timeout here —
      // the runner's heartbeat-based wait decides when to fail. The
      // content script just keeps reporting state.
      const stableNoSpinnerMs = noSpinnerSince ? Date.now() - noSpinnerSince : 0
      if (stableNoSpinnerMs < renderGraceMs) {
        sendHeartbeat('rendering', {
          generating: false,
          candidateImages: 0,
          acceptedImages: 0,
          hasPendingImage: false,
          lastMessage: 'post-generation render grace ' + Math.round((renderGraceMs - stableNoSpinnerMs) / 1000) + 's left',
        })
        continue
      }

      // Past render grace. Decide: text-only refusal or stalled.
      const hasAssistantText = this.chatgptHasAssistantText()
      if (hasAssistantText) {
        sendHeartbeat('failed', { generating: false, lastMessage: 'text-only reply' })
        return sendDone({
          success: false,
          error: 'No image was generated. ChatGPT replied with text only.',
          message: this.chatgptLastAssistantTextSnippet(),
        })
      }

      // Stale: we have seen progress, but it's been a long time
      // since lastProgressAt and there is no active signal.
      const progressAge = lastProgressAt > 0 ? Date.now() - lastProgressAt : -1
      const stillActive = generating || hasPendingImageMarker
      if (sawAnyProgress && progressAge > staleMs && !stillActive) {
        sendHeartbeat('failed', { generating: false, lastMessage: 'progress stale' })
        return sendDone({
          success: false,
          error: 'ChatGPT generation progress stale after ' +
            Math.round(progressAge / 1000) + 's',
        })
      }
      if (sawAnyProgress && progressAge > activeGraceMs) {
        sendHeartbeat('failed', { generating: false, lastMessage: 'progress hard stale' })
        return sendDone({
          success: false,
          error: 'ChatGPT generation progress stale after ' +
            Math.round(progressAge / 1000) + 's despite heartbeat',
        })
      }

      // Otherwise keep waiting. The next iteration will tick again.
    }

    // Absolute cap reached. This is the only place the loop exits
    // via time. The error message explicitly says "max wait", not
    // "timed out after Ns", to distinguish from a hard-cap fail.
    sendHeartbeat('failed', { generating: false, lastMessage: 'max wait exceeded' })
    return sendDone({
      success: false,
      error: 'ChatGPT generation max wait exceeded after ' +
        Math.round(maxWaitMs / 1000) + 's',
    })
  },

  // Helpers below used only by chatgptSubmitAndWait

  chatgptSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  },

  async chatgptWaitForIdle(maxMs) {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      if (!this.chatgptIsGenerating()) return
      await this.chatgptSleep(500)
    }
  },

  // ── Multi-strategy submit (Enter first, button only as fallback) ──────────
  // Replaces the previous "find submit button or fail" path. ChatGPT rotates
  // button selectors frequently, so we MUST NOT fail when the button can't be
  // found — the user can still submit by pressing Enter on the composer.
  //
  // Strategy ladder:
  //   1. Locate the composer with retry (10s, 200ms).
  //   2. Clear existing text (only if non-empty).
  //   3. Insert prompt via paste / execCommand / innerHTML (multi-tier).
  //   4. Submit via Enter key dispatch (primary).
  //   5. Verify with multi-signal check (editor cleared | generating |
  //      stop button visible | send button disabled | new assistant turn).
  //   6. If Enter didn't submit, fall back to a pointer/React/form submit.
  //   7. Only after every strategy fails AND no submission signal is observed
  //      do we throw CHATGPT_SUBMIT_FAILED_AFTER_ALL_STRATEGIES.
  async chatgptSubmitExistingComposerFallbacks(editor, baselineAssistantTurnCount, baselineFileIds, options) {
    const verify = (strategy) => {
      const ok = this.chatgptDidSubmit(editor, baselineAssistantTurnCount, baselineFileIds, options)
      if (ok) return { success: true, strategy }
      return null
    }

    const tryWaitVerify = async (strategy, waitMs) => {
      const ok = await this.chatgptWaitForSubmitSignal(
        editor,
        baselineAssistantTurnCount,
        baselineFileIds,
        options,
        waitMs,
        250
      )
      if (ok) return { success: true, strategy }
      return null
    }

    try { editor && editor.focus && editor.focus() } catch (_) {}

    console.log('[ChatGPT-submit] workflow fallback try enterKey')
    this.chatgptDispatchEnter(editor)
    let result = await tryWaitVerify('enterKey', 4000)
    if (result) return result

    const button = await this.chatgptFindSubmitButtonWithRetry(3000, 200)
    if (button && this.chatgptIsButtonUsable(button)) {
      console.log('[ChatGPT-submit] workflow fallback try pointer click')
      this.chatgptPointerClickButton(button)
      result = await tryWaitVerify('pointerClick', 5000)
      if (result) return result
      return {
        success: false,
        error: 'CHATGPT_SUBMIT_UNVERIFIED: pointer click did not produce a submit signal',
      }
    } else {
      console.log('[ChatGPT-submit] workflow fallback no usable button')
    }

    const form = this.chatgptFindFormForEditor(editor) ||
      (button ? this.chatgptFindFormForButton(button) : null)
    if (form && typeof form.requestSubmit === 'function') {
      try {
        console.log('[ChatGPT-submit] workflow fallback try form.requestSubmit')
        form.requestSubmit(button || undefined)
        result = await tryWaitVerify('form.requestSubmit', 1200)
        if (result) return result
      } catch (e) {
        console.warn('[ChatGPT-submit] workflow fallback form.requestSubmit threw:', e)
      }
    }

    return {
      success: false,
      error: 'CHATGPT_SUBMIT_FAILED: all submit strategies failed',
    }
  },

  async chatgptInjectTextAndSubmit(prompt) {
    const submitted = await this.chatgptInjectTextAndSubmitInner(prompt)
    if (submitted) {
      console.log('[ChatGPT-submit] submitted ok')
      return true
    }
    console.warn('[ChatGPT-submit] submit failed after all strategies')
    return false
  },

  async chatgptInjectTextAndSubmitInner(prompt) {
    const editor = await this.chatgptFindComposer(10000, 200)
    if (!editor) {
      console.warn('[ChatGPT-submit] editor not found')
      throw new Error('EDITOR_NOT_FOUND')
    }
    console.log('[ChatGPT-submit] editor found tag=' + editor.tagName)

    // Capture baseline for the "new assistant turn" verification signal.
    const baselineAssistantTurnCount = this.chatgptCountAssistantTurns()
    const baselineFileIds = this.chatgptCollectFileIds()

    const cleared = this.chatgptClearEditor(editor)
    if (cleared) console.log('[ChatGPT-submit] clear ok')

    const inserted = this.chatgptInsertPrompt(editor, prompt)
    if (!inserted) {
      throw new Error('INSERT_PROMPT_FAILED')
    }
    console.log('[ChatGPT-submit] insert ok')

    // ── Primary: Enter key dispatch ───────────────────────────────────────
    console.log('[ChatGPT-submit] try enterKey')
    this.chatgptDispatchEnter(editor)
    if (await this.chatgptWaitForSubmitSignal(editor, baselineAssistantTurnCount, baselineFileIds, undefined, 4000, 250)) {
      console.log('[ChatGPT-submit] submitted via enterKey')
      return true
    }

    // ── Fallback: submit button via pointer events ────────────────────────
    console.log('[ChatGPT-submit] enterKey did not submit, trying button fallback')
    const button = await this.chatgptFindSubmitButtonWithRetry(3000, 200)
    if (button) {
      console.log('[ChatGPT-submit] submit button found')
      this.chatgptPointerClickButton(button)
      if (await this.chatgptWaitForSubmitSignal(editor, baselineAssistantTurnCount, baselineFileIds, undefined, 5000, 250)) {
        console.log('[ChatGPT-submit] submitted via pointer click')
        return true
      }
      console.warn('[ChatGPT-submit] pointer click not verified; skipping extra submit strategies')
      return false
    } else {
      console.log('[ChatGPT-submit] submit button not found, trying form.requestSubmit')
    }

    // ── Fallback: form.requestSubmit ───────────────────────────────────────
    const form = this.chatgptFindFormForEditor(editor) ||
      (button ? this.chatgptFindFormForButton(button) : null)
    if (form && typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit(button || undefined)
        if (await this.chatgptWaitForSubmitSignal(editor, baselineAssistantTurnCount, baselineFileIds, undefined, 3000, 250)) {
          console.log('[ChatGPT-submit] submitted via form.requestSubmit')
          return true
        }
      } catch (e) {
        console.warn('[ChatGPT-submit] form.requestSubmit threw:', e)
      }
    }

    return false
  },

  chatgptCountAssistantTurns() {
    const candidates = document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    )
    return candidates ? candidates.length : 0
  },

  chatgptCountUserTurns() {
    const candidates = document.querySelectorAll(
      '[data-message-author-role="user"]'
    )
    return candidates ? candidates.length : 0
  },

  // Counts pre-submit reference image attachment previews in the
  // composer. Used to verify that uploads actually landed before we
  // click Send. Mirrors the "isUpload" filter used by
  // chatgptCollectGeneratedImages so that only true attachment
  // previews are counted (not generated images in the chat history).
  // Counts pre-submit reference image attachment previews in the
  // composer. Used to verify that uploads actually landed before we
  // click Send, and as the polling signal in `uploadImage`'s Strategy
  // P/A/B/C ladder.
  //
  // IMPORTANT: this is the sole success signal for the upload ladder.
  // If it returns 0 even though the user can see attached thumbs in
  // the composer, every strategy will time out and we will report
  // "media upload did not attach" — even though the upload DID work.
  // Be BROAD in what you count, and CONFINE to the composer root.
  //
  // Composers count when they are NOT inside any
  // `[data-message-author-role]` ancestor (chat history).
  //
  // We accept any of these as a single attachment:
  //   1. <img src> in composer where src is blob: or data:
  //   2. <img src> in composer AND ANY ancestor matches:
  //        - [data-testid*="attachment" i]
  //        - [data-testid*="attachment-preview" i]
  //        - [data-testid*="attachment-button" i]
  //        - [class*="attachment" i]
  //        - [class*="upload" i]
  //      (catches tiles that swap the <img> for a CSS background)
  //   3. An element with a close/remove X button (button with
  //      aria-label containing remove / delete / close / xóa / remove /
  //      '-' / 'x') inside the composer attachment tray area.
  //   4. An element with a [data-testid*="attachment" i] or
  //      [data-testid*="attachment-remove" i] / upload / file directly.
  //   5. An element whose computed background-image is `url(blob:...)`.
  //
  // The categories are unioned (a single attachment is the same node,
  // not 5 different counts) and then de-duplicated by element identity.
  // Resolves the canonical attachment tile root for any element
  // inside the composer that looks like part of an attachment.
  // Used by `chatgptCountComposerAttachments`,
  // `chatgptRemoveAllComposerAttachments`, and the duplicate
  // detection gate so that the same DOM element always maps to the
  // same tile identity — a single attachment cannot be counted as
  // multiple attachments just because an `<img>`, a remove button,
  // and a classname all matched the same tile.
  //
  // Returns the element that should be added to the dedup Set, or
  // `null` if `el` is not a member of any attachment tile.
  _chatgptGetAttachmentRoot(el) {
    if (!el || !el.nodeType) return null
    // Walk up the ancestor chain looking for any attachment-shaped
    // marker. The first hit is the tile root.
    const root = el.closest(
      '[data-testid*="attachment" i]:not([data-testid*="attachment-button"]),' +
      '[data-testid*="upload-preview" i],' +
      '[data-testid*="attachment-preview" i],' +
      '[data-testid*="attachment-tile" i],' +
      '[class*="attachment-preview" i],' +
      '[class*="upload-preview" i]'
    )
    if (root) return root
    // No testid/class marker found — try to find a common ancestor
    // shared with a known tile element. The most reliable signal is
    // a sibling/cousin <img src="blob:..."> rendered by ChatGPT
    // inside the same tile container. We walk up to a depth of 6
    // levels and return the first ancestor that contains a blob/data
    // image OR a remove button (the two markers ChatGPT always
    // renders for a single tile).
    let cur = el
    for (let i = 0; i < 6 && cur && cur.parentElement; i++) {
      cur = cur.parentElement
      if (!cur) break
      const hasBlobImg = cur.querySelector('img[src^="blob:"], img[src^="data:"]')
      const hasRemoveBtn = cur.querySelector(
        'button[aria-label*="Remove" i], button[aria-label*="Delete" i], button[aria-label*="Close" i], button[aria-label*="Xóa" i], button[aria-label*="Remove file" i], button[data-testid*="attachment-remove" i]'
      )
      if (hasBlobImg || hasRemoveBtn) {
        // Stop at the first ancestor that itself contains BOTH
        // markers — that ancestor is the tile. Otherwise, keep
        // walking up.
        const hasBlobImgInside = hasBlobImg && cur.contains(hasBlobImg)
        const hasRemoveBtnInside = hasRemoveBtn && cur.contains(hasRemoveBtn)
        if (hasBlobImgInside && hasRemoveBtnInside) {
          return cur
        }
        // Only one marker present at this level — keep walking
        // until we find the level with both, or hit the depth cap.
      }
    }
    return null
  },

  // Returns a Set<HTMLElement> of unique attachment tile roots
  // currently rendered in the composer. Used by:
  //   - chatgptCountComposerAttachments (count = set.size)
  //   - chatgptRemoveAllComposerAttachments (iterate set, click remove)
  //   - duplicate detection gate (compare counts across calls)
  //   - pre-submit verification (sanity check before clicking send)
  //
  // All five detection categories union here:
  //   1. <img src> in composer (blob:/data: scheme OR tile-sized OR
  //      has an attachment-ancestor).
  //   2. Elements with [data-testid*="attachment" i] (excluding the
  //      attach-button variant).
  //   3. Remove/Close/Delete/Xóa buttons in the composer (one per
  //      tile).
  //   4. Class-only tiles ([class*="attachment" i] / [class*="upload-preview" i]).
  //   5. Background-blob painted tiles (scoped to composer roots —
  //      NOT `document.querySelectorAll('*')`).
  //
  // The matched nodes are normalized via `_chatgptGetAttachmentRoot`
  // so that any child element of the same tile resolves to the same
  // canonical root.
  chatgptFindComposerAttachmentRoots() {
    const composerRoots = this._chatgptFindComposerRoots()
    if (!composerRoots.length) return new Set()

    const inComposer = (el) => {
      for (let i = 0; i < composerRoots.length; i++) {
        const r = composerRoots[i]
        if (el === r) return true
        if (r && r.contains && r.contains(el)) return true
      }
      return false
    }
    const inMessage = (el) => !!el.closest('[data-message-author-role]')

    const isCountable = (el) => !!el && el.nodeType === 1 && inComposer(el) && !inMessage(el)
    const addRoot = (set, el) => {
      if (!isCountable(el)) return false
      const root = this._chatgptGetAttachmentRoot(el) || el
      if (!isCountable(root)) return false
      set.add(root)
      return true
    }

    const tiles = new Set()

    // After the union below, some matches will be ancestors of
    // others (e.g. a horizontal-scroll container that holds a
    // single file-tile inside it). Both are added by detection
    // categories 1 and 5 respectively, and the ancestor adds a
    // spurious second root to the Set. We filter the Set AFTER all
    // categories to keep only the leafmost per branch: an element
    // is "shadowed" if any of its descendants is also in the Set,
    // and shadowed elements are removed.
    //
    // This is cheaper than a pre-pass that requires a full
    // topological sort per tile.
    const shadow = (set) => {
      const arr = Array.from(set)
      const keep = []
      for (let i = 0; i < arr.length; i++) {
        let dominated = false
        for (let j = 0; j < arr.length; j++) {
          if (i === j) continue
          const candidate = arr[j]
          if (candidate && candidate.contains && candidate.contains(arr[i])) {
            dominated = true
            break
          }
        }
        if (!dominated) keep.push(arr[i])
      }
      set.clear()
      keep.forEach((el) => set.add(el))
    }

    // 1. <img src> in composer.
    composerRoots.forEach((root) => {
      const imgs = root.querySelectorAll('img[src]')
      imgs.forEach((img) => {
        if (!isCountable(img)) return
        const src = img.src || ''
        const hasAttachmentAncestor = !!this._chatgptGetAttachmentRoot(img)
        if (hasAttachmentAncestor) {
          addRoot(tiles, img)
          return
        }
        if (src.startsWith('blob:') || src.startsWith('data:')) {
          addRoot(tiles, img)
          return
        }
        // http(s) image — only count if it looks like a tile-sized
        // preview (>= 32x32). This catches ChatGPT builds that
        // render uploaded previews via signed CDN URLs instead of
        // blobs.
        const rect = img.getBoundingClientRect ? img.getBoundingClientRect() : null
        if (rect && rect.width >= 32 && rect.height >= 32) {
          addRoot(tiles, img)
        }
      })
    })

    // 2. Direct attachment testids.
    composerRoots.forEach((root) => {
      const direct = root.querySelectorAll(
        '[data-testid*="attachment" i]:not([data-testid*="attachment-button"])'
      )
      direct.forEach((el) => addRoot(tiles, el))
    })

    // 3. Remove buttons. We don't try to normalize via
    //    `_chatgptGetAttachmentRoot` here — buttons aren't
    //    descendants of a tile root in some ChatGPT builds (the
    //    remove button is a sibling of the tile body). Instead,
    //    accept the button itself as the tile identity IF no
    //    attachment-ancestor exists, OR the closest tile-ancestor
    //    if one exists.
    const removeSels = [
      'button[aria-label*="Remove" i]',
      'button[aria-label*="Delete" i]',
      'button[aria-label*="Close" i]',
      'button[aria-label*="Xóa" i]',
      'button[aria-label*="Remove file" i]',
      'button[data-testid*="attachment-remove" i]',
      'button[data-testid*="attachment-remove-button" i]',
    ]
    composerRoots.forEach((root) => {
      removeSels.forEach((sel) => {
        const btns = root.querySelectorAll(sel)
        btns.forEach((btn) => {
          if (!isCountable(btn)) return
          const tileAncestor = this._chatgptGetAttachmentRoot(btn)
          if (tileAncestor) {
            // Normalize through `addRoot` so the tile ancestor is
            // subject to the same `isCountable` / `inMessage` filter
            // as img-src roots. Without this, a remove button whose
            // tile ancestor is e.g. a `data-message-author-role`
            // descendant would still slip into the Set and inflate
            // the count.
            addRoot(tiles, tileAncestor)
          } else {
            // No attachment-ancestor — fall back to the closest
            // ancestor that is in-composer AND not inside a chat
            // message. We deliberately skip `btn.parentElement`
            // fallback: in ChatGPT builds where the remove button
            // lives outside the tile root, the parent is the
            // composer form itself, which would collapse N tiles
            // into 1.
            addRoot(tiles, btn)
          }
        })
      })
    })

    // 4. Class-only tiles.
    composerRoots.forEach((root) => {
      const direct = root.querySelectorAll(
        '[class*="attachment" i]:not([class*="attachment-button"]),' +
        '[class*="upload-preview" i]'
      )
      direct.forEach((el) => addRoot(tiles, el))
    })

    // 5. Background-blob painted tiles. SCOPED to composer roots —
    //    do NOT walk the whole document.
    const doc = (composerRoots[0] && composerRoots[0].ownerDocument) || document
    const view = doc.defaultView || window
    composerRoots.forEach((root) => {
      const all = root.querySelectorAll('*')
      all.forEach((el) => {
        if (tiles.has(el)) return
        if (!isCountable(el)) return
        const cs = view.getComputedStyle ? view.getComputedStyle(el) : null
        if (!cs) return
        const bg = cs.backgroundImage || ''
        if (bg.indexOf('blob:') !== -1) tiles.add(el)
      })
    })

    // Drop ancestors-of-tiles. See `shadow` for rationale. After
    // this call `tiles` contains only the leafmost root per branch,
    // which is what `chatgptCountComposerAttachments` reports.
    shadow(tiles)

    return tiles
  },

  // Resolves composer root candidates (forms, containers, the
  // contenteditable prompt-textarea itself). Shared between the
  // counter, the cleanup helper, and any future scope check.
  // Returns an empty array if no candidate is found.
  _chatgptFindComposerRoots() {
    const roots = []
    const txt = document.querySelector(
      '#prompt-textarea, [data-testid="prompt-textarea"], textarea[data-id="root"]'
    )
    if (txt) {
      roots.push(txt)
      const formRoot = txt.closest('form')
      if (formRoot && roots.indexOf(formRoot) === -1) roots.push(formRoot)
    }
    const composerContainers = document.querySelectorAll(
      '[data-testid*="composer" i]:not([data-testid="conversation"]):not([role="log"])'
    )
    composerContainers.forEach((el) => {
      if (roots.indexOf(el) === -1) roots.push(el)
    })
    return roots
  },

  // Counts pre-submit reference image attachment previews in the
  // composer. The sole success signal for the upload ladder — see
  // `chatgptFindComposerAttachmentRoots` for the full detection
  // algorithm. Returns `attachmentRoots.size`.
  chatgptCountComposerAttachments() {
    const tiles = this.chatgptFindComposerAttachmentRoots()
    const finalCount = tiles.size
    try {
      const win = typeof window !== 'undefined' ? window : null
      if (win) win.__CHATGPT_COUNTDIAG_LAST_TS = Date.now()
      const samples = Array.from(tiles).slice(0, 3).map((el) => {
        const ancestors = []
        let cur = el
        for (let i = 0; i < 6 && cur && cur.parentElement; i++) {
          cur = cur.parentElement
          if (!cur) break
          ancestors.push({
            tag: cur.tagName,
            testId: cur.getAttribute && cur.getAttribute('data-testid'),
            className: typeof cur.className === 'string' ? cur.className.slice(0, 80) : null,
            childCount: cur.children ? cur.children.length : 0,
          })
        }
        return {
          tag: el.tagName,
          testId: el.getAttribute && el.getAttribute('data-testid'),
          className: typeof el.className === 'string' ? el.className.slice(0, 80) : null,
          outerHTML: (el.outerHTML || '').slice(0, 250),
          ancestors,
        }
      })
      const summary = { finalCount, samples }
      console.log('[ChatGPT][CountDiag] composer attachment candidates', summary)
      // Persist the latest diag to a hidden DOM node on the
      // composer root so the test can read it via page.evaluate.
      // The content script runs in an ISOLATED world — its `window`
      // is not the same as the page's main-world `window` — so we
      // publish the diag onto a visible DOM element instead.
      try {
        const host = document.querySelector('#prompt-textarea')
          ? document.querySelector('#prompt-textarea').closest('form') || document.body
          : document.body
        let stash = host.querySelector('#__chatgpt_count_diag_stash__')
        if (!stash) {
          stash = document.createElement('script')
          stash.id = '__chatgpt_count_diag_stash__'
          stash.type = 'application/json'
          stash.style.display = 'none'
          host.appendChild(stash)
        }
        stash.textContent = JSON.stringify(summary)
      } catch {}
    } catch (_) {}
    return finalCount
  },

  // Polls composer attachment count until either it reaches `targetAtLeast`
  // or the timeout elapses. Returns:
  //   {
  //     finalCount: <last observed count>,
  //     reached:    <highest observed count>,
  //     timedOut:   <true if we exhausted the timeout without ever
  //                  seeing the targetAtLeast value>,
  //   }
  //
  // Used by the per-upload verification loop to wait for ChatGPT to
  // render the preview after a `change`-event dispatch. Polling, not
  // MutationObserver, because we only care about the snapshot total
  // and a MutationObserver would fire on every internal React
  // reconciliation step ChatGPT runs while processing the upload.
  async chatgptWaitForAttachmentDelta(targetAtLeast, maxMs, stepMs) {
    const start = Date.now()
    let lastCount = this.chatgptCountComposerAttachments()
    let highest = lastCount
    while (Date.now() - start < maxMs) {
      if (highest >= targetAtLeast) {
        return { finalCount: lastCount, reached: highest, timedOut: false }
      }
      await this.chatgptSleep(stepMs)
      lastCount = this.chatgptCountComposerAttachments()
      if (lastCount > highest) highest = lastCount
    }
    return { finalCount: lastCount, reached: highest, timedOut: highest < targetAtLeast }
  },

  // Walks every composer attachment preview and tries to click its
  // remove/close button. Returns the count of click attempts. This is
  // best-effort: if ChatGPT hides the remove button or if the markup
  // has rotated, the caller should re-check via
  // chatgptCountComposerAttachments and surface an explicit failure
  // if any previews are still present.
  //
  // Selector strategy:
  //   1. The attachment root element (data-testid matches *attachment*)
  //      is itself the candidate.
  //   2. Inside it, look for aria-label*="Remove" or "Close" buttons.
  //   3. If none found, look for a small button next to the preview
  //      whose aria-label contains a stop/upload verb — ChatGPT rotates
  //      the wording, so this is a fallback.
  chatgptRemoveAllComposerAttachments() {
    // Use the same root finder as `chatgptCountComposerAttachments`
    // so that what we count is what we remove. No more divergence
    // between the two definitions of "attachment".
    const tiles = this.chatgptFindComposerAttachmentRoots()
    let clicks = 0
    tiles.forEach((root) => {
      if (!root || !root.isConnected) return
      const removeBtns = root.querySelectorAll(
        'button[aria-label*="Remove" i], ' +
        'button[aria-label*="Close" i], ' +
        'button[aria-label*="Xóa" i], ' +
        'button[aria-label*="Delete" i], ' +
        'button[data-testid*="attachment-remove" i]'
      )
      removeBtns.forEach((btn) => {
        try { btn.click(); clicks++ } catch (_) {}
      })
      // Fallback: if no remove button found inside the tile, try
      // any small button (best-effort).
      if (clicks === 0) {
        const anyBtn = root.querySelector('button')
        if (anyBtn) {
          try { anyBtn.click(); clicks++ } catch (_) {}
        }
      }
    })
    return clicks
  },

  chatgptComposerHasMediaFingerprint(_fp) {
    // Placeholder kept for symmetry with the call site. The
    // authoritative dedup is the count-based pre-flight above
    // (alreadyAttached === mediaCount) and the post-upload count
    // check at 0c. Returning false here means "no pre-existing
    // match in current composer".
    return false
  },

  async chatgptFindComposer(maxMs, stepMs) {
    const start = Date.now()
    const selectors = [
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      'textarea[data-id="root"]',
      'div[contenteditable="true"][id="prompt-textarea"]',
      'div[contenteditable="true"][data-testid="prompt-textarea"]',
      'form div[contenteditable="true"]',
      'main div[contenteditable="true"]',
    ]
    while (Date.now() - start < maxMs) {
      for (let i = 0; i < selectors.length; i++) {
        let el = null
        try {
          el = document.querySelector(selectors[i])
        } catch (_) {
          continue
        }
        if (!el) continue
        if (this.chatgptIsComposerUsable(el)) return el
      }
      await this.chatgptSleep(stepMs)
    }
    return null
  },

  chatgptIsComposerUsable(el) {
    if (!el) return false
    if (el.disabled) return false
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null
    if (!rect || rect.width <= 0 || rect.height <= 0) return false
    // For contenteditable, also check that the element is editable.
    if (el.getAttribute && el.getAttribute('contenteditable') === 'false') return false
    return true
  },

  chatgptClearEditor(editor) {
    if (!editor) return false
    const before = (editor.textContent || editor.value || '').trim()
    if (!before) return true // already empty, nothing to clear

    try {
      editor.focus()
    } catch (_) {}

    try {
      // document.execCommand is deprecated but still works in Chromium for
      // contenteditable surfaces.
      document.execCommand('selectAll')
      document.execCommand('delete')
    } catch (_) {}

    let after = (editor.textContent || editor.value || '').trim()
    if (!after) {
      try {
        editor.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'deleteContent' })
        )
      } catch (_) {}
      return true
    }

    // Last-resort: blow away the innerHTML and dispatch an input event.
    try {
      editor.innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>'
      editor.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'deleteContent' })
      )
    } catch (_) {}
    return true
  },

  chatgptInsertPrompt(editor, prompt) {
    if (!editor || !prompt) return false

    // Strategy 1: paste event with a synthetic DataTransfer.
    try {
      const dt = new DataTransfer()
      dt.setData('text/plain', prompt)
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      })
      editor.dispatchEvent(pasteEvent)
      const afterPaste = (editor.textContent || editor.value || '')
      if (afterPaste.includes(prompt.slice(0, 20))) {
        this.chatgptDispatchInputFromPaste(editor, prompt)
        return true
      }
    } catch (_) {}

    // Strategy 2: document.execCommand('insertText').
    try {
      editor.focus()
      const ok = document.execCommand('insertText', false, prompt)
      if (ok) {
        const after = (editor.textContent || editor.value || '')
        if (after.includes(prompt.slice(0, 20))) {
          this.chatgptDispatchInputFromPaste(editor, prompt)
          return true
        }
      }
    } catch (_) {}

    // Strategy 3: innerHTML assignment + synthetic input event.
    try {
      const escaped = this.chatgptEscapeHtml(prompt)
      editor.focus()
      editor.innerHTML = '<p>' + escaped + '</p>'
      this.chatgptDispatchInputFromPaste(editor, prompt)
      const after = (editor.textContent || editor.value || '')
      if (after.includes(prompt.slice(0, 20))) return true
    } catch (_) {}

    return false
  },

  chatgptDispatchInputFromPaste(editor, prompt) {
    try {
      editor.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertFromPaste',
          data: prompt,
        })
      )
    } catch (_) {}
  },

  chatgptEscapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  },

  chatgptDispatchEnter(editor) {
    if (!editor) return
    try { editor.focus() } catch (_) {}
    const opts = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    }
    try {
      editor.dispatchEvent(new KeyboardEvent('keydown', opts))
    } catch (_) {}
    try {
      editor.dispatchEvent(new KeyboardEvent('keypress', opts))
    } catch (_) {}
    try {
      editor.dispatchEvent(new KeyboardEvent('keyup', opts))
    } catch (_) {}
  },

  async chatgptWaitForSubmitSignal(editor, baselineAssistantTurnCount, baselineFileIds, options, maxMs, stepMs) {
    const start = Date.now()
    const maxWait = Math.max(0, Number(maxMs) || 0)
    const interval = Math.max(100, Number(stepMs) || 250)
    while (Date.now() - start < maxWait) {
      if (this.chatgptDidSubmit(editor, baselineAssistantTurnCount, baselineFileIds, options)) {
        return true
      }
      await this.chatgptSleep(interval)
    }
    return this.chatgptDidSubmit(editor, baselineAssistantTurnCount, baselineFileIds, options)
  },

  chatgptDidSubmit(editor, baselineAssistantTurnCount, baselineFileIds, options) {
    // options = { allowFileIdSignal: boolean }
    //   - true (default): Signal 4 (new file_id) is treated as a
    //     valid submit indicator.
    //   - false: Signal 4 is ignored. Required when mediaCount > 0
    //     because the reference image's file_id is already in
    //     chat history and a "new" file_id may be ChatGPT registering
    //     the upload, not the submit click. Without this gate, the
    //     submit verification passes prematurely before the prompt
    //     actually went out.
    const allowFileIdSignal = !options || options.allowFileIdSignal !== false
    const baselineUserTurnCount = options && typeof options.baselineUserTurnCount === 'number'
      ? options.baselineUserTurnCount
      : null

    // Signal 1: editor cleared or text drastically reduced (the prompt was sent).
    try {
      const text = (editor && (editor.textContent || editor.value)) || ''
      if (text.trim().length < 5) return true
    } catch (_) {}

    // Signal 2: stop / streaming button visible.
    if (this.chatgptIsGenerating()) return true

    // Signal 3: a new assistant turn appeared.
    try {
      if (this.chatgptCountAssistantTurns() > (baselineAssistantTurnCount || 0)) return true
    } catch (_) {}

    // Signal 3b: a new user turn appeared. This prevents duplicate
    // submits when ChatGPT accepts the first click/Enter but the
    // assistant spinner has not appeared within the short verify window.
    try {
      if (baselineUserTurnCount !== null && this.chatgptCountUserTurns() > baselineUserTurnCount) return true
    } catch (_) {}

    // Signal 4: a new image file_id appeared (early signal that generation
    // is in flight, even if the assistant turn hasn't been inserted yet).
    // DISABLED when allowFileIdSignal === false — required for media
    // uploads where the reference file_id itself may register as "new".
    if (allowFileIdSignal) {
      try {
        const cur = this.chatgptCollectFileIds()
        for (const id of cur) {
          if (!baselineFileIds || !baselineFileIds.has(id)) return true
        }
      } catch (_) {}
    }

    // Signal 5: send button is now disabled (composition in flight).
    try {
      const sendSelectors = [
        'button[data-testid="send-button"]',
        'button[data-testid="composer-submit-button"]',
        'form button[type="submit"]',
      ]
      for (let i = 0; i < sendSelectors.length; i++) {
        const btn = document.querySelector(sendSelectors[i])
        if (btn && (btn.disabled || btn.getAttribute('aria-disabled') === 'true')) return true
      }
    } catch (_) {}

    return false
  },

  async chatgptFindSubmitButtonWithRetry(maxMs, stepMs) {
    const start = Date.now()
    const selectors = [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-submit-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Gửi" i]',
      'form button[type="submit"]',
      '#composer-submit-button',
    ]
    while (Date.now() - start < maxMs) {
      for (let i = 0; i < selectors.length; i++) {
        let btn = null
        try {
          btn = document.querySelector(selectors[i])
        } catch (_) {
          continue
        }
        if (btn && this.chatgptIsButtonUsable(btn)) return btn
      }
      await this.chatgptSleep(stepMs)
    }
    return null
  },

  chatgptIsButtonUsable(btn) {
    if (!btn) return false
    if (btn.disabled) return false
    if (btn.getAttribute && btn.getAttribute('aria-disabled') === 'true') return false
    const rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : null
    if (!rect || rect.width <= 0 || rect.height <= 0) return false
    // Send button can also be hidden via display:none — guard against that.
    const style = btn.ownerDocument && btn.ownerDocument.defaultView
      ? btn.ownerDocument.defaultView.getComputedStyle(btn)
      : null
    if (style && (style.visibility === 'hidden' || style.display === 'none')) return false
    return true
  },

  chatgptPointerClickButton(btn) {
    if (!btn) return
    const rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : null
    const cx = rect ? rect.left + rect.width / 2 : 0
    const cy = rect ? rect.top + rect.height / 2 : 0
    const baseInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      clientX: cx,
      clientY: cy,
    }
    try { btn.dispatchEvent(new PointerEvent('pointerdown', baseInit)) } catch (_) {}
    try { btn.dispatchEvent(new MouseEvent('mousedown', baseInit)) } catch (_) {}
    try { btn.dispatchEvent(new PointerEvent('pointerup', baseInit)) } catch (_) {}
    try { btn.dispatchEvent(new MouseEvent('mouseup', baseInit)) } catch (_) {}
    try { btn.dispatchEvent(new MouseEvent('click', baseInit)) } catch (_) {}
  },

  chatgptInvokeReactOnClick(btn) {
    if (!btn) return false
    try {
      const keys = Object.keys(btn)
      const reactKey = keys.find(function (k) {
        return typeof k === 'string' && k.indexOf('__reactProps$') === 0
      })
      if (!reactKey) return false
      const props = btn[reactKey]
      const onClick = props && props.onClick
      if (typeof onClick !== 'function') return false
      const fakeEvent = {
        preventDefault: function () {},
        stopPropagation: function () {},
        nativeEvent: new MouseEvent('click'),
        type: 'click',
        target: btn,
        currentTarget: btn,
      }
      onClick.call(btn, fakeEvent)
      return true
    } catch (_) {
      return false
    }
  },

  chatgptFindFormForEditor(editor) {
    if (!editor) return null
    try {
      const f = editor.closest && editor.closest('form')
      if (f) return f
    } catch (_) {}
    try {
      const f = document.querySelector('form')
      if (f) return f
    } catch (_) {}
    return null
  },

  chatgptFindFormForButton(btn) {
    if (!btn) return null
    try {
      const f = btn.closest && btn.closest('form')
      if (f) return f
    } catch (_) {}
    return null
  },

  chatgptIsGenerating() {
    const spinnerSelectors = [
      '[aria-label*="Stop" i]',
      '[aria-label*="Generating" i]',
      'button[aria-label*="Stop" i]',
      '[data-testid*="stop-button" i]',
      '[class*="result-streaming" i]',
      '[class*="streaming" i]',
      '[class*="generating" i]',
    ]
    for (const s of spinnerSelectors) {
      try {
        if (document.querySelector(s)) return true
      } catch {}
    }
    // Also check send button state — if send button is hidden and stop is present
    const stopBtn = document.querySelector('button[aria-label*="Stop" i]')
    if (stopBtn) return true
    return false
  },

  chatgptDetectTextOnlyError() {
    // Heuristic: last assistant message contains a refusal phrase and no images
    const candidates = document.querySelectorAll('[data-message-author-role="assistant"], .assistant-message, [data-testid*="conversation-turn"]:last-of-type')
    if (!candidates || candidates.length === 0) return null
    const last = candidates[candidates.length - 1]
    if (!last) return null
    const txt = (last.textContent || '').trim()
    if (!txt) return null
    if (txt.length > 400) return null
    const lower = txt.toLowerCase()
    const refusalPatterns = [
      "i can't create images",
      "i can't generate images",
      "i'm unable to create",
      "i'm not able to generate",
      'cannot create images',
      'cannot generate images',
      "i don't have the ability",
      "i'm just a text",
    ]
    for (const p of refusalPatterns) {
      if (lower.includes(p)) return txt
    }
    return null
  },

  chatgptHasAssistantText() {
    // Returns true if any assistant message currently has visible text content.
    const candidates = document.querySelectorAll(
      '[data-message-author-role="assistant"], .assistant-message, [data-testid*="conversation-turn"]:last-of-type'
    )
    if (!candidates || candidates.length === 0) return false
    for (const el of candidates) {
      const txt = (el.textContent || '').trim()
      if (txt.length > 0) return true
    }
    return false
  },

  // Heuristic: a new assistant turn is mounted but the image asset
  // is still rendering. ChatGPT typically paints:
  //   - an <img> with a blob:/data: src that has not finished loading,
  //   - an <img> with no naturalWidth yet,
  //   - a container that holds a skeleton/spinner with a "result"
  //     class hint.
  // We use this to keep the heartbeat in 'rendering' phase and to
  // tell the runner not to time out — the asset is on its way.
  chatgptHasPendingImageMarker() {
    const candidates = document.querySelectorAll(
      '[data-message-author-role="assistant"] img,' +
      '[data-message-author-role="assistant"] [class*="result" i],' +
      '[data-message-author-role="assistant"] [class*="image" i],' +
      '[data-message-author-role="assistant"] [class*="attachment" i]'
    )
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i]
      if (!el) continue
      if (el.tagName === 'IMG') {
        // Image tag — check if it is still being painted.
        const src = el.src || ''
        if (!src) continue
        // Already-loaded fully-rendered image — the collector
        // will pick it up next tick. Don't double-count.
        if (el.complete && el.naturalWidth > 0) continue
        return true
      }
      // Non-img element with a result/image/attachment class in an
      // assistant turn — ChatGPT skeleton placeholder.
      if (el.querySelector && el.querySelector('img:not([src]), img[src=""]')) {
        return true
      }
    }
    return false
  },

  chatgptLastAssistantTextSnippet() {
    const candidates = document.querySelectorAll(
      '[data-message-author-role="assistant"], .assistant-message, [data-testid*="conversation-turn"]:last-of-type'
    )
    if (!candidates || candidates.length === 0) return ''
    const last = candidates[candidates.length - 1]
    if (!last) return ''
    const txt = (last.textContent || '').trim()
    return txt.length > 200 ? txt.slice(0, 200) + '...' : txt
  },

  chatgptCollectFileIds() {
    const set = new Set()
    const imgs = document.querySelectorAll('img[src]')
    imgs.forEach((img) => {
      const id = this.chatgptExtractFileId(img.src)
      if (id) set.add(id)
    })
    return set
  },

  chatgptImageSignature(src) {
    if (!src) return ''
    const value = String(src)
    const fileId = this.chatgptExtractFileId(value)
    if (fileId) return 'file:' + fileId
    if (value.indexOf('blob:') === 0 || value.indexOf('data:image/') === 0) return value
    try {
      const url = new URL(value, location.href)
      return (url.origin + url.pathname).toLowerCase()
    } catch (_) {
      return value.split('?')[0].toLowerCase()
    }
  },

  chatgptCollectImageSignatures() {
    const set = new Set()
    const imgs = document.querySelectorAll('img[src]')
    imgs.forEach((img) => {
      const signature = this.chatgptImageSignature(img.src)
      if (signature) set.add(signature)
    })
    return set
  },

  chatgptExtractFileId(url) {
    if (!url) return null
    try {
      const m = String(url).match(/[?&]id=(file_[a-z0-9]+)/i) || String(url).match(/(file_[a-z0-9]+)/i)
      return m ? m[1] : null
    } catch {
      return null
    }
  },

  chatgptIsLikelyGeneratedCdn(src) {
    if (!src) return false
    const value = String(src).toLowerCase()
    return (
      value.includes('oaiusercontent.com') ||
      value.includes('oaidalleapiprodscus.blob.core.windows.net') ||
      value.includes('oaidalleapiprodscus') ||
      value.includes('estuary') ||
      value.includes('/backend-api/files/') ||
      value.includes('/files/file_') ||
      value.includes('chatgpt.com/backend-api/')
    )
  },

  chatgptCollectGeneratedImages(baselineFileIds, baselineAssistantTurnCount, baselineImageSignatures) {
    const seen = new Set()
    const out = []
    const rejected = []
    let scanned = 0
    let assistantTurns = 0
    let candidateCount = 0
    const imgs = document.querySelectorAll('img[src]')
    const assistantTurnEls = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'))
    const baselineTurnCount = Number(baselineAssistantTurnCount) || 0
    imgs.forEach((img) => {
      const src = img.src || ''
      if (!src) return
      // Accept http(s), blob:, data:image. ChatGPT may serve generated
      // images via blob: URLs created from downloaded / rendered data,
      // not just signed CDN URLs. We deliberately do NOT require
      // a chatgpt file_id query param — that filter was the root cause
      // of "image visible on UI but result not detected" — and we
      // dedupe by full src, which is stable for blob: URLs within
      // a page lifetime.
      const isAcceptableScheme = (
        src.indexOf('blob:') === 0 ||
        src.indexOf('data:image/') === 0 ||
        src.indexOf('http://') === 0 ||
        src.indexOf('https://') === 0
      )
      if (!isAcceptableScheme) return

      scanned += 1

      // Skip low-quality/blur/backdrop images
      const alt = (img.alt || '').toLowerCase()
      if (alt.includes('blur') || alt.includes('backdrop') || alt.includes('placeholder')) {
        rejected.push({ reason: 'alt-blur-or-placeholder', srcSnippet: src.slice(0, 80), alt })
        return
      }

      // Skip uploaded/reference images (alt text + DOM ancestors)
      const isUpload =
        alt.includes('uploaded') ||
        alt.includes('reference') ||
        /^attachment|^user[-_ ]?upload/i.test(alt) ||
        img.closest('[data-testid*="attachment" i]') ||
        img.closest('[class*="upload" i]')
      if (isUpload) {
        rejected.push({ reason: 'is-upload', srcSnippet: src.slice(0, 80), alt })
        return
      }

      // Skip composer attachment previews explicitly. After submit the
      // uploaded reference image may stay in the composer (ChatGPT
      // sometimes re-renders the attachment with a different src),
      // so we cannot rely on the file_id alone. If the image is in
      // the composer form but NOT inside a chat message turn, it is
      // still an attachment preview.
      const inComposer = !!(
        img.closest('form') ||
        img.closest('[data-testid*="composer" i]') ||
        img.closest('textarea')
      )
      const inMessage = !!img.closest('[data-message-author-role]')
      if (inComposer && !inMessage) {
        rejected.push({ reason: 'in-composer', srcSnippet: src.slice(0, 80), inComposer, inMessage })
        return
      }

      // Skip tiny icons / avatars. The naturalWidth check is
      // intentionally permissive: if the image has not finished
      // loading (naturalWidth === 0), we DO NOT reject based on
      // size — the size filter is only applied when the browser
      // has decoded the image and reported real dimensions.
      // This means a freshly painted (still decoding) generated
      // image is NOT lost just because the asset has not streamed
      // in yet. We track it as a candidate and only reject on
      // size when the dimensions are known to be tiny.
      const w = img.naturalWidth || img.width || 0
      const h = img.naturalHeight || img.height || 0
      const sizeKnown = w > 0 && h > 0
      if (sizeKnown && (w < 128 || h < 128)) {
        rejected.push({ reason: 'tiny-size', srcSnippet: src.slice(0, 80), w, h })
        return
      }

      const turnEl = img.closest('[data-message-author-role="assistant"]')
      const turnIndex = turnEl ? assistantTurnEls.indexOf(turnEl) : -1
      const fileId = this.chatgptExtractFileId(src)
      const isNewFileId = !!fileId && (!baselineFileIds || !baselineFileIds.has(fileId))
      const signature = this.chatgptImageSignature(src)
      const isKnownBaselineImage = !!(signature && baselineImageSignatures && baselineImageSignatures.has(signature))
      const isNewAssistantTurn = turnIndex >= baselineTurnCount
      const isLikelyGeneratedCdn = this.chatgptIsLikelyGeneratedCdn(src)
      const isGeneratedAlt = alt.startsWith('generated image')
      const isBlankAltCdn = alt === '' && isLikelyGeneratedCdn
      const isGlobalNewAsset = !inMessage && !isKnownBaselineImage && isLikelyGeneratedCdn

      if (isKnownBaselineImage) {
        rejected.push({ reason: 'baseline-src-hit', srcSnippet: src.slice(0, 80), signature })
        return
      }

      if (turnEl && !isNewAssistantTurn) {
        rejected.push({ reason: 'old-assistant-turn', srcSnippet: src.slice(0, 80), turnIndex, baselineTurnCount })
        return
      }
      if (!turnEl && !isGlobalNewAsset) {
        rejected.push({ reason: 'not-new-assistant-or-cdn', srcSnippet: src.slice(0, 80), hasFileId: !!fileId, signature })
        return
      }
      if (turnEl && !(isGeneratedAlt || isBlankAltCdn || isLikelyGeneratedCdn || isNewFileId)) {
        rejected.push({ reason: 'assistant-img-not-generated', srcSnippet: src.slice(0, 80), alt })
        return
      }

      // Count assistant turns and image candidates for diagnostics.
      if (turnEl) {
        assistantTurns = assistantTurnEls.length
        candidateCount += 1
      }

      // Generated images are accepted if they live in an assistant
      // message, even if there is no file_id. The previous
      // implementation required `chatgptExtractFileId(src) → non-null`
      // for proper dedup, but that filter dropped ChatGPT-generated
      // images served from `blob:` URLs that have no file_id query
      // param at all.
      const dedupeKey = signature || fileId || src
      if (fileId && baselineFileIds && baselineFileIds.has(fileId)) {
        rejected.push({ reason: 'baseline-hit', srcSnippet: src.slice(0, 80), fileId })
        return
      }
      if (seen.has(dedupeKey)) return
      seen.add(dedupeKey)
      out.push(src)
    })

    // Diagnostics: log the scan outcome so a human watching the
    // console can see why an image was or was not picked up.
    try {
      console.log('[ChatGPT][Collect] assistantTurns=' + assistantTurns +
        ' candidateImages=' + candidateCount +
        ' acceptedImages=' + out.length +
        ' scanned=' + scanned)
      if (out.length === 0 && rejected.length > 0) {
        const summary = {}
        for (const r of rejected) {
          summary[r.reason] = (summary[r.reason] || 0) + 1
        }
        console.log('[ChatGPT][Collect] rejected', summary)
        // Log the first 5 rejections with detail so the user can
        // diagnose what filter ate the image.
        rejected.slice(0, 5).forEach((r, i) => {
          console.log('[ChatGPT][Collect] rejected#' + i, r)
        })
      }
    } catch (_) {}

    return out
  },

  chatgptFindSubmitButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Submit" i]',
      'form button[type="submit"]',
    ]
    for (const s of selectors) {
      try {
        const btn = document.querySelector(s)
        if (btn && !btn.disabled) return btn
      } catch {}
    }
    // Fallback: composer form's submit button
    const composer = document.querySelector('form textarea, form [contenteditable="true"]')
    if (composer) {
      const form = composer.closest('form')
      if (form) {
        const btn = form.querySelector('button[type="submit"]')
        if (btn) return btn
      }
    }
    return null
  },

  async chatgptEnableImageMode() {
    // Click the "+" / tools button in composer to open the tools menu
    const triggerSelectors = [
      'button[aria-label*="tools" i]',
      'button[aria-label*="more" i]',
      'button[aria-label*="compose" i]',
      'button[data-testid="composer-plus-button"]',
      'button[aria-label*="Add" i][aria-label*="attachment" i]',
      'button[aria-label*="attachment" i]',
    ]
    let trigger = null
    for (const s of triggerSelectors) {
      try {
        const btn = document.querySelector(s)
        if (btn) { trigger = btn; break }
      } catch {}
    }
    if (!trigger) throw new Error('tools trigger not found')

    trigger.click()
    await this.chatgptSleep(400)

    // Look for "Create image" / "Create an image" item in any open menu
    const itemSelectors = [
      '[role="menuitem"]:has-text("Create image")',
      '[role="menuitem"]:has-text("Create an image")',
      'button:has-text("Create image")',
      'button:has-text("Create an image")',
    ]
    // querySelector doesn't support :has-text; use textContent filter
    const candidates = document.querySelectorAll('[role="menuitem"], button, [role="button"]')
    for (const el of candidates) {
      const txt = (el.textContent || '').trim().toLowerCase()
      if (txt === 'create image' || txt === 'create an image' || txt.startsWith('create image')) {
        el.click()
        await this.chatgptSleep(400)
        return true
      }
    }
    throw new Error('Create image menu item not found')
  },

  async chatgptSetRatio(ratio) {
    const ratioMap = {
      '1:1': 'square',
      '16:9': 'landscape',
      '9:16': 'portrait',
      '4:3': 'standard',
      '3:4': 'portrait-standard',
    }
    const value = ratioMap[ratio] || ratio
    const selectors = [
      `[data-aspect-ratio="${value}"]`,
      `[data-value="${ratio}"]`,
      `button[aria-label*="${ratio}"]`,
      `button[aria-label*="${value}" i]`,
    ]
    for (const s of selectors) {
      try {
        const el = document.querySelector(s)
        if (el) { el.click(); return true }
      } catch {}
    }
    // Text-based fallback
    const buttons = document.querySelectorAll('button')
    for (const b of buttons) {
      const t = (b.getAttribute('aria-label') || b.textContent || '').toLowerCase()
      if (t.includes(value) || t.includes(ratio.toLowerCase())) {
        b.click()
        return true
      }
    }
    throw new Error('ratio control not found: ' + ratio)
  }
}

function detectProvider() {
  const href = window.location.href
  const hostname = window.location.hostname
  if (
    href.includes('labs.google/fx/tools/flow') ||
    href.includes('labs.google/fx/vi/tools/flow') ||
    href.includes('flow.google.com') ||
    hostname.includes('labs.google')
  ) return 'google-flow'
  if (hostname.includes('chatgpt.com')) return 'chatgpt'
  if (hostname.includes('grok.com') || hostname.includes('x.com')) return 'grok'
  if (hostname.includes('claude.ai')) return 'claude'
  if (hostname.includes('gemini.google.com')) return 'gemini'
  return 'chatgpt'
}

const provider = detectProvider()
AIFlowContentScript.init(provider)

window.addEventListener('beforeunload', () => {
  safeSendFireAndForget({ action: 'TAB_CLOSED', provider })
})
