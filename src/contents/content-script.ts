const AIFlowContentScript = {
  currentProvider: null,

  init(provider) {
    this.currentProvider = provider
    this.setupMessageListener()
    console.log('[AI Flow] Content script initialized for', provider)
  },

  setupMessageListener() {
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

  uploadImage(imageData) {
    const fileInput = document.querySelector('input[type="file"]')
    if (!fileInput) throw new Error('File input not found')

    const byteString = atob(imageData.split(',')[1])
    const mimeType = imageData.match(/data:([^;]+)/)[1]
    const ab = new ArrayBuffer(byteString.length)
    const ia = new Uint8Array(ab)
    for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i)
    const blob = new Blob([ab], { type: mimeType })

    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File([blob], 'image.png', { type: mimeType }))
    fileInput.files = dataTransfer.files
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))

    return { success: true }
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

    if (!jobId || typeof jobId !== 'string') {
      return { accepted: false, error: 'jobId is required' }
    }
    if (!prompt || typeof prompt !== 'string') {
      // Still post a failure for the background to consume.
      try {
        chrome.runtime.sendMessage({
          action: 'CHATGPT_JOB_DONE',
          jobId,
          payload: { success: false, error: 'Prompt is required' },
        })
      } catch {}
      return { accepted: false, error: 'Prompt is required' }
    }

    // Acknowledge to background immediately so it can release the tabs.sendMessage
    // channel. The job continues running on this tab.
    // Use setTimeout(..., 0) so the synchronous ack can flush first.
    setTimeout(() => {
      this.runChatGPTJob({ jobId, prompt, ratio, timeoutMs }).catch(async (err) => {
        console.error('[ChatGPT] job crashed:', err)
        try {
          chrome.runtime.sendMessage({
            action: 'CHATGPT_JOB_DONE',
            jobId,
            payload: { success: false, error: (err && err.message) || String(err) },
          })
        } catch {}
      })
    }, 0)

    return { accepted: true, jobId }
  },

  // The actual long-running job. Posts CHATGPT_JOB_DONE when finished.
  async runChatGPTJob({ jobId, prompt, ratio, timeoutMs }) {
    const sendDone = (result) => {
      try {
        chrome.runtime.sendMessage({ action: 'CHATGPT_JOB_DONE', jobId, payload: result })
      } catch (e) {
        console.error('[ChatGPT] failed to post CHATGPT_JOB_DONE:', e)
      }
    }

    const pollIntervalMs = 1000

    // 1. (editor detection moved into chatgptInjectTextAndSubmit below —
    //    it has its own 10s retry loop, so we no longer bail here.)

    // 2. Try to enable image-generation mode (best-effort)
    try {
      await this.chatgptEnableImageMode()
    } catch (e) {
      console.log('[ChatGPT] image-mode toggle skipped:', (e && e.message) || e)
    }

    // 3. Try to set aspect ratio (best-effort)
    if (ratio) {
      try {
        await this.chatgptSetRatio(ratio)
      } catch (e) {
        console.log('[ChatGPT] ratio setter skipped:', (e && e.message) || e)
      }
    }

    // 4. Wait for any previous generation to finish before capturing baseline
    await this.chatgptWaitForIdle(30000)

    // 5. Capture baseline: collect existing file_ids from chat history
    const baselineFileIds = this.chatgptCollectFileIds()
    console.log('[ChatGPT] baseline file_ids count:', baselineFileIds.size)

    // 6. Insert prompt and submit. The submit helper now uses an Enter-first
    // strategy ladder; button click is only a fallback when Enter fails to
    // submit. We do NOT bail out if no submit button is found.
    const submitOk = await this.chatgptInjectTextAndSubmit(prompt)
    if (!submitOk) {
      return sendDone({
        success: false,
        error: 'CHATGPT_SUBMIT_FAILED_AFTER_ALL_STRATEGIES',
      })
    }

    // 7. Poll DOM for new generated images
    const start = Date.now()
    let lastGenerating = false
    // noSpinnerSince: timestamp when !generating became true (null while generating)
    let noSpinnerSince = null
    // submittedAt: when we clicked submit, used as the "first 30s grace" floor
    const submittedAt = Date.now()
    // MIN_GRACE_MS: never declare "no image" within the first 30s of submit
    const MIN_GRACE_MS = 30000

    while (Date.now() - start < timeoutMs) {
      await this.chatgptSleep(pollIntervalMs)

      const generating = this.chatgptIsGenerating()
      if (generating !== lastGenerating) {
        console.log('[ChatGPT] generating state ->', generating)
        lastGenerating = generating
      }
      if (generating) {
        noSpinnerSince = null
      } else if (noSpinnerSince === null) {
        noSpinnerSince = Date.now()
      }

      // Generation may be a text-only reply; detect early
      const textOnlyError = this.chatgptDetectTextOnlyError()
      if (textOnlyError) {
        return sendDone({
          success: false,
          error: 'ChatGPT returned text instead of image',
          message: textOnlyError,
        })
      }

      // While generating, keep waiting
      if (generating) continue

      // !generating. Check if a new image appeared.
      const newImages = this.chatgptCollectGeneratedImages(baselineFileIds)
      if (newImages.length > 0) {
        console.log('[ChatGPT] collected', newImages.length, 'new image(s)')
        return sendDone({ success: true, imageUrls: newImages })
      }

      // No spinner, no image yet. We must not bail prematurely.
      // Rules:
      //  - within the first 30s of submit, keep waiting (ChatGPT delay before spinner/image)
      //  - after 30s, only declare "No image" if either:
      //      (a) we have not seen a spinner at all in 60s AND an assistant reply exists
      //          (model replied with text instead of generating an image)
      //      (b) the no-spinner state has been stable for 30s AND we are 60s+ past submit
      const elapsedSinceSubmit = Date.now() - submittedAt
      if (elapsedSinceSubmit < MIN_GRACE_MS) {
        // Still inside minimum grace window — keep waiting.
        continue
      }

      const stableNoSpinnerMs = noSpinnerSince ? Date.now() - noSpinnerSince : 0
      const hasAssistantText = this.chatgptHasAssistantText()
      const noSpinnerLongEnough = stableNoSpinnerMs >= MIN_GRACE_MS
      const pastExtendedGrace = elapsedSinceSubmit >= 60000

      if (hasAssistantText && noSpinnerLongEnough) {
        // Model replied with text only.
        return sendDone({
          success: false,
          error: 'No image was generated. ChatGPT replied with text only.',
          message: this.chatgptLastAssistantTextSnippet(),
        })
      }
      if (noSpinnerLongEnough && pastExtendedGrace) {
        // No spinner for 30s and 60s elapsed without an image — give up.
        return sendDone({
          success: false,
          error: 'No image was generated within ' + Math.round(MIN_GRACE_MS / 1000) + 's of no-spinner state.',
        })
      }
    }

    return sendDone({
      success: false,
      error: 'ChatGPT generation timed out after ' + Math.round(timeoutMs / 1000) + 's',
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
    await this.chatgptSleep(1500)

    if (this.chatgptDidSubmit(editor, baselineAssistantTurnCount, baselineFileIds)) {
      console.log('[ChatGPT-submit] submitted via enterKey')
      return true
    }

    // ── Fallback: submit button via pointer events ────────────────────────
    console.log('[ChatGPT-submit] enterKey did not submit, trying button fallback')
    const button = await this.chatgptFindSubmitButtonWithRetry(3000, 200)
    if (button) {
      console.log('[ChatGPT-submit] submit button found')
      this.chatgptPointerClickButton(button)
      await this.chatgptSleep(1500)
      if (this.chatgptDidSubmit(editor, baselineAssistantTurnCount, baselineFileIds)) {
        console.log('[ChatGPT-submit] submitted via pointer click')
        return true
      }

      // React onClick fallback. React 18 stores props on a key starting with
      // __reactProps$<id> on the DOM node.
      const reactInvoked = this.chatgptInvokeReactOnClick(button)
      if (reactInvoked) {
        await this.chatgptSleep(1500)
        if (this.chatgptDidSubmit(editor, baselineAssistantTurnCount, baselineFileIds)) {
          console.log('[ChatGPT-submit] submitted via react onClick')
          return true
        }
      }
    } else {
      console.log('[ChatGPT-submit] submit button not found, trying form.requestSubmit')
    }

    // ── Fallback: form.requestSubmit ───────────────────────────────────────
    const form = this.chatgptFindFormForEditor(editor) ||
      (button ? this.chatgptFindFormForButton(button) : null)
    if (form && typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit(button || undefined)
        await this.chatgptSleep(1000)
        if (this.chatgptDidSubmit(editor, baselineAssistantTurnCount, baselineFileIds)) {
          console.log('[ChatGPT-submit] submitted via form.requestSubmit')
          return true
        }
      } catch (e) {
        console.warn('[ChatGPT-submit] form.requestSubmit threw:', e)
      }
    }

    // Final attempt: re-Enter after button click — sometimes the focus moves
    // away from the editor when the button click is dispatched.
    this.chatgptDispatchEnter(editor)
    await this.chatgptSleep(1500)
    if (this.chatgptDidSubmit(editor, baselineAssistantTurnCount, baselineFileIds)) {
      console.log('[ChatGPT-submit] submitted via enterKey (post-button retry)')
      return true
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

  chatgptDidSubmit(editor, baselineAssistantTurnCount, baselineFileIds) {
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

    // Signal 4: a new image file_id appeared (early signal that generation
    // is in flight, even if the assistant turn hasn't been inserted yet).
    try {
      const cur = this.chatgptCollectFileIds()
      for (const id of cur) {
        if (!baselineFileIds || !baselineFileIds.has(id)) return true
      }
    } catch (_) {}

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
    // Native .click() as last resort inside this branch — does NOT raise
    // synthetic pointer events but is universally accepted.
    try { btn.click() } catch (_) {}
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

  chatgptExtractFileId(url) {
    if (!url) return null
    try {
      const m = String(url).match(/[?&]id=(file_[a-z0-9]+)/i)
      return m ? m[1] : null
    } catch {
      return null
    }
  },

  chatgptCollectGeneratedImages(baselineFileIds) {
    const seen = new Set()
    const out = []
    const imgs = document.querySelectorAll('img[src]')
    imgs.forEach((img) => {
      const src = img.src || ''
      if (!src) return
      if (!/^https?:|^data:image\//i.test(src)) return

      // Skip low-quality/blur/backdrop images
      const alt = (img.alt || '').toLowerCase()
      if (alt.includes('blur') || alt.includes('backdrop') || alt.includes('placeholder')) return

      // Skip uploaded/reference images
      const isUpload =
        alt.includes('uploaded') ||
        alt.includes('reference') ||
        /^attachment|^user[-_ ]?upload/i.test(alt) ||
        img.closest('[data-testid*="attachment" i]') ||
        img.closest('[class*="upload" i]')
      if (isUpload) return

      // Skip tiny icons / avatars
      const w = img.naturalWidth || img.width || 0
      const h = img.naturalHeight || img.height || 0
      if (w > 0 && h > 0 && (w < 128 || h < 128)) return

      const fileId = this.chatgptExtractFileId(src)
      const dedupeKey = fileId || src
      if (fileId && baselineFileIds && baselineFileIds.has(fileId)) return
      if (seen.has(dedupeKey)) return
      seen.add(dedupeKey)
      out.push(src)
    })
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
  chrome.runtime.sendMessage({ action: 'TAB_CLOSED', provider })
})
