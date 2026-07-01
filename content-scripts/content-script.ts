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
      'google-flow': ['textarea[name="prompt"]', '[data-testid="prompt-input"]', 'div[contenteditable="true"]'],
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
  }
}

function detectProvider() {
  const hostname = window.location.hostname
  if (hostname.includes('flow.google.com')) return 'google-flow'
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
