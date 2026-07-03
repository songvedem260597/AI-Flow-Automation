// E2E smoke test for AI Flow Automation extension on ChatGPT.
//
// Boots a real Chromium with the unpacked extension from
// build/chrome-mv3-prod/, waits for the user to log in to ChatGPT,
// then exercises the content script's CHATGPT_PING health check and
// UPLOAD_IMAGE attachment ladder against a 1x1 PNG.
//
// The browser is launched via `chromium.launchPersistentContext` so
// that MV3 extensions load — non-persistent launches do not honor
// --load-extension. The user-data-dir is .pw-chatgpt-profile so that
// the ChatGPT login session is preserved between runs.
//
// Usage:
//   npm run test:e2e:chatgpt                 # upload-only smoke
//   npm run test:e2e:chatgpt:interactive     # keep browser open on FAIL
//   FULL_SUBMIT=1 npm run test:e2e:chatgpt   # also click Send
//   EXT_PATH=build/chrome-mv3-prod npm run test:e2e:chatgpt
//                                            # override extension path
//
// Interactive mode (--interactive):
//   - Login prompt polls every 2s, up to 15 minutes.
//   - No Enter required.
//   - If the browser/page is closed before login, FAIL loudly.
//   - After composer mounts: hard-reload the page once so the content
//     script injects cleanly, then re-wait for the composer.
//   - On FAIL: keep the browser window open and the process alive so
//     you can inspect the page state. Press Ctrl+C to exit.
//   - On PASS: close the browser and exit 0.

import { chromium } from 'playwright'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

// ── flags ──────────────────────────────────────────────────────────────
// `--interactive` keeps the browser open when the test fails so the
// user can inspect the live page. Default behavior is also interactive
// for safety: only --non-interactive auto-closes on FAIL.
const INTERACTIVE = process.argv.includes('--interactive') ||
  !process.argv.includes('--non-interactive')

// 1x1 transparent PNG — minimum valid image so the upload ladder
// still parses payload and exercises the file-input dispatch.
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

// Resolve paths relative to the project root (one above scripts/).
const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const extensionPath = resolve(
  projectRoot,
  process.env.EXT_PATH || 'build/chrome-mv3-prod'
)
const userDataDir = resolve(projectRoot, '.pw-chatgpt-profile')
const artifactsDir = resolve(projectRoot, 'artifacts')

const FULL_SUBMIT = process.env.FULL_SUBMIT === '1'

const CHATGPT_URL = 'https://chatgpt.com/'

// How long to wait for manual login before giving up.
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000 // 15 minutes
const LOGIN_POLL_INTERVAL_MS = 2000 // 2s per requirement #5

// ── helpers ────────────────────────────────────────────────────────────
function ensureExtensionBuilt() {
  if (!existsSync(extensionPath)) {
    console.error(
      `[FAIL] Extension not found at: ${extensionPath}\n` +
        '       Run `npm run build` first.'
    )
    process.exit(1)
  }
  const manifestPath = join(extensionPath, 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.error(
      `[FAIL] manifest.json missing in extension dir: ${extensionPath}`
    )
    process.exit(1)
  }
}

function ensureArtifactsDir() {
  if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true })
}

async function waitForUserLoginPrompt(page) {
  // Per requirements:
  //   2. browser stays open indefinitely (capped at LOGIN_TIMEOUT_MS)
  //   3. clear message in terminal
  //   4. NO Enter required
  //   5. poll composer every 2s, up to 15 minutes
  //   6. if browser/page closes → FAIL loudly
  console.log('')
  console.log('============================================================')
  console.log('  Please login to ChatGPT in the opened Playwright browser.')
  console.log('  The test will continue automatically after composer appears.')
  console.log('============================================================')
  console.log('  1. The browser window has opened at https://chatgpt.com/')
  console.log('  2. Log in to your account.')
  console.log('  3. Make sure the chat composer is visible (empty new chat).')
  console.log(`  4. Polling every ${LOGIN_POLL_INTERVAL_MS / 1000}s for up to ${LOGIN_TIMEOUT_MS / 60000} minutes.`)
  console.log('  5. Do NOT close the browser window — the test will fail if you do.')
  console.log('============================================================')
  console.log('')

  const loginDeadline = Date.now() + LOGIN_TIMEOUT_MS
  let lastUrl = ''
  while (Date.now() < loginDeadline) {
    // Requirement #6: detect closed browser/page and FAIL loudly
    // instead of silently crashing at waitForTimeout.
    if (page.isClosed()) {
      throw new Error(
        'FAIL: browser was closed before login completed.'
      )
    }

    let composerFound
    try {
      const url = page.url()
      if (url !== lastUrl) {
        console.log(`[wait] current URL: ${url}`)
        lastUrl = url
      }
      composerFound = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll(
            'div.ProseMirror, textarea, [contenteditable="true"]'
          )
        )
        for (const el of candidates) {
          const ph = (el.getAttribute && el.getAttribute('placeholder')) || ''
          if (
            /Message ChatGPT/i.test(ph) ||
            /Ask anything/i.test(ph) ||
            /Send a message/i.test(ph)
          ) {
            return { found: true, tag: el.tagName, ph, source: 'placeholder' }
          }
        }
        // Fallback: nav-based logged-in signal.
        const navLogged = !!document.querySelector(
          '[data-testid="profile-button"], button[aria-label*="Open menu"], a[href*="/account"]'
        )
        if (navLogged) return { found: true, tag: 'nav-fallback', ph: '', source: 'nav' }
        return { found: false, tag: '', ph: '', source: 'none' }
      })
    } catch (e) {
      // Page can be mid-navigation or briefly detached. Treat as
      // "not yet" and keep polling — but surface the error to terminal
      // so it's not completely silent.
      const msg = (e && e.message) || String(e)
      if (/Target|closed|Context|disconnected/i.test(msg)) {
        throw new Error('FAIL: browser was closed before login completed. (' + msg + ')')
      }
      composerFound = { found: false, tag: 'err', ph: '', source: 'eval-err' }
    }

    if (composerFound && composerFound.found) {
      console.log(
        `[wait] login detected via ${composerFound.tag} ` +
          `(source=${composerFound.source}, ph="${composerFound.ph}")`
      )
      // Brief settle delay so the composer finishes painting.
      await page.waitForTimeout(800)
      return
    }

    await page.waitForTimeout(LOGIN_POLL_INTERVAL_MS)
  }
  throw new Error(
    `FAIL: login timeout — composer never appeared within ${LOGIN_TIMEOUT_MS / 60000} minutes.`
  )
}

// Wait for an MV3 service worker scoped to a chrome-extension:// URL.
// Returns the first matching worker. We never call evaluate() on the
// page-level service workers (chatgpt.com, etc.) because they don't
// have access to chrome.tabs/extension APIs.
async function waitForExtensionServiceWorker(context, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const workers = context.serviceWorkers()
    for (const sw of workers) {
      const u = sw.url()
      if (u.startsWith('chrome-extension://')) return sw
    }
    // Listen for the next service worker to register, then re-scan.
    await Promise.race([
      context.waitForEvent('serviceworker', { timeout: 2000 }),
      new Promise((r) => setTimeout(r, 2000)),
    ])
  }
  throw new Error(
    `Timed out waiting for extension service worker. Found ${
      context.serviceWorkers().length
    } service worker(s):\n` +
      context
        .serviceWorkers()
        .map((w) => '  - ' + w.url())
        .join('\n')
  )
}

function parseExtensionId(swUrl) {
  // chrome-extension://<id>/static/background/index.js
  const m = swUrl.match(/^chrome-extension:\/\/([a-z]+)\//)
  if (!m) throw new Error('Cannot parse extension id from SW URL: ' + swUrl)
  return m[1]
}

// Send a chrome.tabs.sendMessage via the extension service worker.
// We must run inside the SW context because that's where the
// extension's chrome.* APIs are bound. A page-level evaluate() would
// hit ChatGPT's window.chrome which is the host page, not the
// extension.
async function sendTabMessage(sw, tabId, message) {
  return await sw.evaluate(
    async ({ tabId, message }) => {
      try {
        const res = await chrome.tabs.sendMessage(tabId, message)
        const err = chrome.runtime.lastError
        return { ok: !err, response: res, lastError: err ? err.message : null }
      } catch (e) {
        return {
          ok: false,
          response: null,
          lastError: (e && e.message) || String(e),
        }
      }
    },
    { tabId, message }
  )
}

async function queryChatGPTTab(sw) {
  return await sw.evaluate(async () => {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' })
      return { ok: true, tabs }
    } catch (e) {
      return {
        ok: false,
        tabs: [],
        lastError: (e && e.message) || String(e),
      }
    }
  })
}

// ── main ───────────────────────────────────────────────────────────────
async function main() {
  ensureExtensionBuilt()
  ensureArtifactsDir()

  console.log(`[info] extension path: ${extensionPath}`)
  console.log(`[info] user-data-dir:  ${userDataDir}`)
  console.log(`[info] artifacts dir:  ${artifactsDir}`)
  console.log(`[info] FULL_SUBMIT:    ${FULL_SUBMIT ? 'enabled' : 'disabled'}`)
  console.log(`[info] mode:           ${INTERACTIVE ? 'interactive (browser stays open on FAIL)' : 'non-interactive (auto-close)'}`)

  // launchPersistentContext is required for MV3 extensions.
  // --load-extension + --disable-extensions-except are the only way
  // to inject an unpacked extension at launch time.
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    viewport: { width: 1280, height: 800 },
  })

  // Mark automation flag so ChatGPT doesn't reject us as a bot.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    // Enable extension verbose diag logs so the upload ladder prints
    // [ChatGPT][Upload] strategy=… lines we can correlate with
    // test-side state. The content script reads AI_FLOW_DEBUG at
    // top of file via `localStorage.getItem('AI_FLOW_DEBUG')`.
    try { localStorage.setItem('AI_FLOW_DEBUG', '1') } catch {}
    try { window.__AI_FLOW_DEBUG__ = true } catch {}
  })

  const results = {
    ping: { ok: false, payload: null, error: null },
    upload: { ok: false, strategy: null, payload: null, error: null },
  }
  let exitCode = 0

  try {
    // Open ChatGPT in the persistent context's first page.
    const page = context.pages()[0] || (await context.newPage())
    page.on('console', (msg) => {
      const t = msg.type()
      const text = msg.text()
      // Forward extension verbose logs verbatim so we can see the
      // strategy ladder in the test output.
      if (text.includes('[ChatGPT]') || text.includes('[Bridge]') || t === 'error' || t === 'warning') {
        console.log(`[page ${t}] ${text}`)
      }
    })
    try {
      await page.goto(CHATGPT_URL, { waitUntil: 'commit', timeout: 30000 })
    } catch (navErr) {
      // ERR_ABORTED happens when a service-worker-initiated redirect
      // races our navigation. The page usually still ends up on
      // chatgpt.com — wait for composer to confirm before bailing.
      console.log(
        '[warn] page.goto threw (likely extension-driven redirect): ' +
          (navErr && navErr.message ? navErr.message.split('\n')[0] : navErr)
      )
    }

    // Some extension service workers drop us back to about:blank. Retry
    // up to 3 times with a real navigation if URL is not chatgpt.com.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const cur = page.url()
      if (cur.startsWith('https://chatgpt.com/')) break
      console.log(
        `[warn] page ended up at "${cur}" — retrying goto (attempt ${attempt}/3)`
      )
      try {
        await page.goto(CHATGPT_URL, {
          waitUntil: 'commit',
          timeout: 15000,
        })
      } catch {
        /* ignore — we re-poll below */
      }
      await page.waitForTimeout(800)
    }
    console.log(`[info] post-goto URL: ${page.url()}`)

    // Wait for the composer to confirm we're past the login screen.
    // If the composer is missing after a short probe, auto-poll for login.
    const composerAppeared = await waitForComposer(page, 8000)
    if (!composerAppeared) {
      await waitForUserLoginPrompt(page)
      // Re-check after login.
      const ok = await waitForComposer(page, 60000)
      if (!ok) {
        throw new Error(
          'ChatGPT composer did not appear after login. ' +
            'Make sure you are on the main chat page (not the login screen or a settings page).'
        )
      }
    } else {
      console.log('[info] composer already visible — assuming session is logged in')
    }

    // Requirement #7: hard-reload the page ONCE so the content script
    // gets a clean injection. Without this the script may be running
    // on a page state captured before login and miss re-renders.
    console.log('[reload] hard-reloading page to inject content script cleanly...')
    try {
      await page.reload({ waitUntil: 'commit', timeout: 30000 })
    } catch (e) {
      console.log('[warn] reload failed: ' + (e && e.message ? e.message.split('\n')[0] : e))
    }
    const okAfterReload = await waitForComposer(page, 60000)
    if (!okAfterReload) {
      throw new Error('Composer did not re-appear after reload.')
    }
    console.log('[reload] composer re-mounted after reload')

    // Wait for the extension service worker.
    console.log('[info] waiting for extension service worker...')
    const sw = await waitForExtensionServiceWorker(context, 30000)
    const extensionId = parseExtensionId(sw.url())
    console.log(`[info] extension id: ${extensionId}`)
    console.log(`[info] sw url:       ${sw.url()}`)

    // Find the ChatGPT tab from the extension's perspective.
    console.log('[info] querying chatgpt.com tabs from extension...')
    const tabRes = await queryChatGPTTab(sw)
    if (!tabRes.ok || !tabRes.tabs || tabRes.tabs.length === 0) {
      throw new Error(
        'No chatgpt.com tab visible to extension. ' +
          'tabs=' +
          JSON.stringify(tabRes.tabs) +
          ' lastError=' +
          tabRes.lastError
      )
    }
    const tab = tabRes.tabs[0]
    console.log(`[info] found tab id=${tab.id} url=${tab.url}`)

    // Make sure the page object we hold IS the tab the extension sees.
    // If there are multiple chatgpt tabs, prefer the one with id === tab.id.
    let livePage = page
    for (const p of context.pages()) {
      try {
        if (p.url().includes('chatgpt.com')) {
          livePage = p
          break
        }
      } catch {}
    }
    await livePage.bringToFront()

    // ── Test 1: CHATGPT_PING ──────────────────────────────────────────
    console.log('[test] CHATGPT_PING...')
    const ping = await sendTabMessage(sw, tab.id, { action: 'CHATGPT_PING' })
    results.ping = {
      ok: ping.ok && ping.response && ping.response.success === true,
      payload: ping.response,
      error: ping.lastError,
    }
    if (!results.ping.ok) {
      throw new Error(
        'CHATGPT_PING failed: ' + JSON.stringify(ping, null, 2)
      )
    }
    console.log(`[ok]   CHATGPT_PING → ${JSON.stringify(results.ping.payload)}`)

    // ── Test 2: UPLOAD_IMAGE (tiny PNG via data URL) ──────────────────
    console.log('[test] UPLOAD_IMAGE (1x1 PNG)...')

    // Pre-flight: if a prior run left attachments in the composer,
    // click their remove buttons so the upload ladder starts from
    // a clean state. Without this, the count-polling gates in
    // `uploadImage` would see delta >= 2 → "duplicate" failure.
    const cleanRes = await livePage.evaluate(() => {
      const root =
        document.querySelector('#prompt-textarea')?.closest('form') ||
        document.body
      const removeBtns = Array.from(
        root.querySelectorAll(
          'button[aria-label*="Remove" i], button[aria-label*="Close" i], button[aria-label*="Xóa" i], button[aria-label*="Delete" i], button[data-testid*="attachment-remove" i]'
        )
      )
      let clicked = 0
      for (const b of removeBtns) {
        try {
          b.click()
          clicked++
        } catch {}
      }
      return { removeBtnsFound: removeBtns.length, clicked }
    })
    if (cleanRes.clicked > 0) {
      console.log(
        `[clean] clicked ${cleanRes.clicked} composer remove button(s) before upload`
      )
      // Allow ChatGPT to re-render the composer after removal.
      await livePage.waitForTimeout(500)
    } else {
      console.log('[clean] composer already clean')
    }

    const up = await sendTabMessage(sw, tab.id, {
      action: 'UPLOAD_IMAGE',
      payload: { imageData: TINY_PNG_DATA_URL },
    })
    results.upload = {
      ok: up.ok && up.response && up.response.success === true,
      strategy: up.response && up.response.strategy,
      payload: up.response,
      error: up.lastError,
    }

    // Verify DOM state regardless of strategy outcome so we can report.
    const dom = await livePage.evaluate(() => {
      const composer =
        document.querySelector('#prompt-textarea') ||
        document.querySelector('[data-testid="prompt-textarea"]') ||
        document.querySelector('form [contenteditable="true"]')
      const form = composer ? composer.closest('form') : null
      const root = form || composer || document.body
      const imgs = root
        ? Array.from(root.querySelectorAll('img[src]')).filter(
            (i) =>
              (i.src || '').startsWith('blob:') ||
              (i.src || '').startsWith('data:')
          )
        : []
      const removeBtns = root
        ? root.querySelectorAll(
            'button[aria-label*="Remove" i], button[aria-label*="Close" i], button[aria-label*="Xóa" i], button[aria-label*="Delete" i], button[data-testid*="attachment-remove" i]'
          ).length
        : 0
      const attachTiles = root
        ? root.querySelectorAll(
            '[data-testid*="attachment" i]:not([data-testid*="attachment-button"])'
          ).length
        : 0
      // Pull the last full diag from the content script's count
      // helper so we can see WHICH elements were counted as roots.
      // The content script publishes diag JSON into a hidden <script>
      // element on the composer root (ISOLATED-world `window` is
      // not visible from the page's main world, so DOM is the only
      // reliable bridge).
      let lastDiag = null
      try {
        const host = document.querySelector('#prompt-textarea')
          ? document.querySelector('#prompt-textarea').closest('form') || document.body
          : document.body
        const stash = host && host.querySelector('#__chatgpt_count_diag_stash__')
        if (stash && stash.textContent) {
          lastDiag = JSON.parse(stash.textContent)
        }
      } catch {}
      return {
        composerFound: !!composer,
        composerTag: composer && composer.tagName,
        composerTestId:
          composer && composer.getAttribute
            ? composer.getAttribute('data-testid')
            : null,
        composerId: composer && composer.id,
        inComposerBlobOrDataImgs: imgs.length,
        removeButtonCount: removeBtns,
        attachTileCount: attachTiles,
        lastCountDiag: lastDiag,
      }
    })
    results.upload.dom = dom

    const screenshotPath = join(artifactsDir, 'chatgpt-upload-smoke.png')
    await livePage.screenshot({ path: screenshotPath, fullPage: true })
    results.upload.screenshot = screenshotPath

    if (!results.upload.ok) {
      throw new Error(
        'UPLOAD_IMAGE failed.\n' +
          '  service worker response: ' +
          JSON.stringify(results.upload.payload, null, 2) +
          '\n  lastError: ' +
          results.upload.error +
          '\n  dom: ' +
          JSON.stringify(dom, null, 2)
      )
    }
    console.log(
      `[ok]   UPLOAD_IMAGE → strategy=${results.upload.strategy} ` +
        `dom imgs=${dom.inComposerBlobOrDataImgs} remove=${dom.removeButtonCount} tiles=${dom.attachTileCount}`
    )

    // ── Optional: click send ─────────────────────────────────────────
    if (FULL_SUBMIT) {
      console.log('[test] FULL_SUBMIT=1 → clicking send button...')
      // Just click the send button. We do NOT poll for images —
      // smoke test stops at "prompt went out" signal.
      const sendRes = await livePage.evaluate(() => {
        const sels = [
          'button[data-testid="send-button"]',
          'button[data-testid="composer-submit-button"]',
          'form button[type="submit"]',
        ]
        for (const s of sels) {
          const b = document.querySelector(s)
          if (b && !b.disabled) {
            b.click()
            return { ok: true, selector: s }
          }
        }
        return { ok: false, error: 'no usable send button' }
      })
      if (!sendRes.ok) {
        console.log('[warn] FULL_SUBMIT could not find send button: ' + sendRes.error)
      } else {
        console.log(`[ok]   FULL_SUBMIT clicked send via ${sendRes.selector}`)
        // Give ChatGPT a beat to start the submission animation.
        await livePage.waitForTimeout(2000)
        const submitShot = join(artifactsDir, 'chatgpt-after-submit.png')
        await livePage.screenshot({ path: submitShot, fullPage: true })
        console.log(`[info] after-submit screenshot: ${submitShot}`)
      }
    } else {
      console.log(
        '[info] FULL_SUBMIT not set — leaving composer with attachment. ' +
          'To send as well, re-run with FULL_SUBMIT=1.'
      )
    }

    // ── PASS banner ──────────────────────────────────────────────────
    console.log('')
    console.log('============================================================')
    console.log('  PASS')
    console.log('============================================================')
    console.log(`  PASS: ChatGPT content script ping ok`)
    console.log(
      `  PASS: ChatGPT media upload attached via strategy=${results.upload.strategy}`
    )
    console.log(`  PASS: screenshot saved → ${results.upload.screenshot}`)
    console.log('============================================================')
  } catch (err) {
    exitCode = 1
    console.log('')
    console.log('============================================================')
    console.log('  FAIL')
    console.log('============================================================')
    console.log(String(err && err.stack ? err.stack : err))
    console.log('  Results snapshot:')
    console.log('  ' + JSON.stringify(results, null, 2).replace(/\n/g, '\n  '))
    console.log('============================================================')
    console.log('')

    // Try to take a failure screenshot if the page is still alive.
    try {
      const failShot = join(artifactsDir, 'chatgpt-failure.png')
      const live = context.pages().find((p) => !p.isClosed())
      if (live) {
        await live.screenshot({ path: failShot, fullPage: true })
        console.log(`[info] failure screenshot: ${failShot}`)
      }
    } catch {}

    if (INTERACTIVE) {
      console.log('[interactive] keeping browser OPEN so you can inspect the page.')
      console.log('[interactive] Press Ctrl+C in this terminal to exit.')
      // Hold the process forever. The user is supposed to look at the
      // browser and decide what to do.
      await new Promise(() => {})
    } else {
      try {
        await context.close()
      } catch {}
    }
  } finally {
    // On the happy path, always close the browser. The catch block
    // above handles the FAIL path explicitly (interactive keeps it open).
    if (exitCode === 0) {
      try {
        await context.close()
      } catch {}
    }
  }
  process.exit(exitCode)
}

// Wait for ChatGPT composer to mount. The prompt-textarea is the
// reliable post-login signal. Returns true if found within maxMs.
async function waitForComposer(page, maxMs) {
  const deadline = Date.now() + maxMs
  const selectors = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    'form [contenteditable="true"]',
  ]
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const found = await page.locator(sel).first().isVisible({ timeout: 200 })
        if (found) return true
      } catch {}
    }
    await page.waitForTimeout(300)
  }
  return false
}

main()
