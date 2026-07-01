import type { ChromeMessage } from '@/types'

console.log('[Background] index.ts loaded')

// Enable with: localStorage.setItem('AI_FLOW_DEBUG', '1') in the extension page/tab
// Guard: localStorage does not exist in service worker contexts.
function readBgDebugFlag(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('AI_FLOW_DEBUG') === '1') {
      return true
    }
  } catch {
    // localStorage access can throw in sandboxed/incognito contexts — ignore
  }
  return false
}
var BG_DEBUG = readBgDebugFlag()
var workflowEditorWindowId: number | null = null

chrome.windows.onRemoved.addListener((windowId) => {
  if (workflowEditorWindowId === windowId) {
    workflowEditorWindowId = null
    chrome.storage.session?.remove?.('workflowEditorWindowId').catch(() => {})
  }
})

chrome.runtime.onMessage.addListener((message: ChromeMessage, sender, sendResponse) => {
  if (BG_DEBUG) console.log('[Background] received action:', message?.action)
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ success: false, error: err.message })
  })
  return true
})

async function handleMessage(message: ChromeMessage, sender: chrome.runtime.MessageSender) {
  switch (message.action) {
    case 'PIPELINE_START':
      return { success: true, tabId: sender.tab?.id }

    case 'OPEN_TAB':
      return openProviderTab(message.payload as string)

    case 'OPEN_PROVIDER_TAB': {
      const payload = message.payload as { provider?: string } | undefined
      const provider = payload?.provider
      if (!provider) return { success: false, error: 'provider is required' }
      return openProviderTab(provider)
    }

    case 'INJECT_SCRIPT':
      if (message.tabId) {
        await chrome.scripting.executeScript({
          target: { tabId: message.tabId },
          files: ['content-scripts/content-script.js']
        })
        return { success: true }
      }
      break

    case 'GET_TAB_INFO':
      return getActiveTabInfo()

    case 'CHECK_FLOW_TAB':
      return checkFlowTab()

    case 'FOCUS_TAB':
      return focusTab(message.tabId!)

    case 'WAKE_LOCK_REQUEST':
      return requestWakeLock()

    case 'WAKE_LOCK_RELEASE':
      return releaseWakeLock()

    case 'DOWNLOAD_FILE':
      return downloadFile(message.payload as { data: string; filename: string; mimeType: string })

    case 'NOTIFICATION':
      return showNotification(message.payload as { title: string; message: string; type?: string })

    case 'OPEN_WORKFLOW_EDITOR_WINDOW':
      return openWorkflowEditorWindow(message.payload as { workflowId?: string } | undefined)

    case 'RUN_FLOW_PROMPT':
      return runFlowPrompt(message.payload as RunFlowPromptPayload, sender.tab?.id)

    case 'RUN_CHATGPT_PROMPT':
      return runChatGPTPrompt(message.payload as ChatGPTPromptPayload)

    case 'GET_CHATGPT_JOB_STATUS':
      return getChatGPTJobStatus(message.payload as { jobId?: string })

    case 'FLOW_STATUS':
      return handleFlowStatus(message.payload as FlowStatusPayload)

    case 'FLOW_START_TILE_MONITOR': {
      const tabId = (message as Record<string, unknown>).tabId as number
      return startTileMonitor(tabId)
    }

    case 'FLOW_GET_TILE_COUNTS': {
      const tabId = (message as Record<string, unknown>).tabId as number
      return getTileCounts(tabId)
    }

    case 'FLOW_STOP_TILE_MONITOR': {
      const tabId = (message as Record<string, unknown>).tabId as number
      return stopTileMonitor(tabId)
    }

    case 'FLOW_DEBUG_PING': {
      return await debugPingFlowTab()
    }

    case 'FLOW_UPLOAD_IMAGE': {
      return await uploadImageToFlow(message.payload as UploadImagePayload)
    }

    case 'STORAGE_GET':
      return chrome.storage.local.get(message.payload as string | string[])

    case 'STORAGE_SET':
      await chrome.storage.local.set(message.payload as Record<string, unknown>)
      return { success: true }

    case 'PREPARE_DOWNLOAD_RENAME': {
      const renamePayload = message.payload as RenameQueueEntry
      return handlePrepareDownloadRename(renamePayload)
    }
  }

  return { success: false }
}

async function openWorkflowEditorWindow(
  payload?: { workflowId?: string }
): Promise<{ success: boolean; windowId?: number; error?: string }> {
  const workflowId = payload?.workflowId || ''
  const query = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ''
  const url = chrome.runtime.getURL(`tabs/workflow-editor.html${query}`)

  const focusExisting = async (windowId: number) => {
    const win = await chrome.windows.get(windowId, { populate: true })
    const tab = win.tabs?.[0]
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { url, active: true }).catch(() => {})
    }
    await chrome.windows.update(windowId, { focused: true }).catch(() => {})
    workflowEditorWindowId = windowId
    await chrome.storage.session?.set?.({ workflowEditorWindowId: windowId }).catch(() => {})
    return { success: true, windowId }
  }

  if (workflowEditorWindowId !== null) {
    try {
      return await focusExisting(workflowEditorWindowId)
    } catch {
      workflowEditorWindowId = null
    }
  }

  try {
    const stored = await chrome.storage.session?.get?.('workflowEditorWindowId').catch(() => null)
    const storedWindowId = stored?.workflowEditorWindowId as number | undefined
    if (storedWindowId) {
      return await focusExisting(storedWindowId)
    }
  } catch {
    workflowEditorWindowId = null
  }

  try {
    const current = await chrome.windows.getLastFocused().catch(() => null)
    const width = Math.max(1180, Math.min(1500, Math.round((current?.width || 1440) * 0.92)))
    const height = Math.max(760, Math.min(980, Math.round((current?.height || 900) * 0.92)))
    const left = current?.left !== undefined && current?.width
      ? current.left + Math.max(0, Math.round((current.width - width) / 2))
      : undefined
    const top = current?.top !== undefined && current?.height
      ? current.top + Math.max(0, Math.round((current.height - height) / 2))
      : undefined

    const win = await chrome.windows.create({
      url,
      type: 'popup',
      width,
      height,
      left,
      top,
      focused: true
    })

    workflowEditorWindowId = win.id ?? null
    if (workflowEditorWindowId !== null) {
      await chrome.storage.session?.set?.({ workflowEditorWindowId }).catch(() => {})
    }

    return { success: true, windowId: workflowEditorWindowId ?? undefined }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Per-provider tab configuration.
//   queryUrl:  match pattern for chrome.tabs.query({ url }) — must end in '/*' for an origin
//   createUrl: navigable URL for chrome.tabs.create
// Bare origins like 'https://chatgpt.com' are invalid match patterns and would
// throw "Invalid url pattern" at query time.
const PROVIDER_TABS: Record<string, { queryUrl: string; createUrl: string }> = {
  'google-flow': {
    queryUrl: 'https://labs.google/fx/*',
    createUrl: 'https://labs.google/fx/tools/flow',
  },
  'chatgpt': {
    queryUrl: 'https://chatgpt.com/*',
    createUrl: 'https://chatgpt.com/',
  },
  'grok': {
    queryUrl: 'https://grok.com/*',
    createUrl: 'https://grok.com/',
  },
  'claude': {
    queryUrl: 'https://claude.ai/*',
    createUrl: 'https://claude.ai/',
  },
  'gemini': {
    queryUrl: 'https://gemini.google.com/*',
    createUrl: 'https://gemini.google.com/',
  },
}

async function openProviderTab(provider: string): Promise<{ success: boolean; tabId?: number; error?: string }> {
  const config = PROVIDER_TABS[provider]
  if (!config) {
    console.log(`[Provider][BG] openProviderTab provider=${provider} error=Unknown provider`)
    return { success: false, error: 'Unknown provider' }
  }
  console.log(`[Provider][BG] openProviderTab provider=${provider} queryUrl=${config.queryUrl}`)

  try {
    const existing = await chrome.tabs.query({ url: config.queryUrl })
    console.log(`[Provider][BG] found existing count=${existing.length}`)
    if (existing.length > 0 && existing[0].id) {
      const tabId = existing[0].id
      await chrome.tabs.update(tabId, { active: true }).catch(() => {})
      const winId = (existing[0] as { windowId?: number }).windowId
      if (winId !== undefined) {
        await chrome.windows.update(winId, { focused: true }).catch(() => {})
      }
      console.log(`[Provider][BG] focused existing tabId=${tabId}`)
      return { success: true, tabId }
    }

    const tab = await chrome.tabs.create({ url: config.createUrl, active: true })
    console.log(`[Provider][BG] created tabId=${tab.id}`)
    return { success: true, tabId: tab.id }
  } catch (err) {
    console.log(`[Provider][BG] openProviderTab provider=${provider} error=${(err as Error).message}`)
    return { success: false, error: (err as Error).message }
  }
}

// ── ChatGPT job state ───────────────────────────────────────────────────
//
// Job state lives in chrome.storage.session so it survives service-worker
// suspension. chrome.storage.session is MV3-only and bounded to the
// browser session; it does not persist across restarts, which is fine
// because the content-script job itself does not survive restarts.
//
// Shape:
//   chatgptJobs[jobId] = {
//     status: 'running' | 'done' | 'failed',
//     startedAt: number,
//     finishedAt?: number,
//     promptPreview: string,
//     autoDownload: boolean,
//     outputFolder?: string,
//     imageUrls: string[],
//     downloaded: number,
//     error: string,
//     message?: string,
//     tabId: number
//   }

const CHATGPT_JOB_STORAGE_KEY = 'chatgptJobs'
const CHATGPT_JOB_TTL_MS = 600000 // 10 minutes hard cap

interface ChatGPTJobState {
  status: 'running' | 'done' | 'failed'
  startedAt: number
  finishedAt?: number
  promptPreview: string
  autoDownload: boolean
  outputFolder?: string
  imageUrls: string[]
  downloaded: number
  error: string
  message?: string
  tabId?: number
}

interface ChatGPTPromptPayload {
  prompt: string
  ratio?: string
  autoDownload: boolean
  outputFolder?: string
  timeoutMs?: number
}

async function chatgptReadJobs(): Promise<Record<string, ChatGPTJobState>> {
  try {
    const result = await chrome.storage.session.get(CHATGPT_JOB_STORAGE_KEY)
    return (result?.[CHATGPT_JOB_STORAGE_KEY] as Record<string, ChatGPTJobState>) || {}
  } catch (e) {
    console.warn('[ChatGPT][Background] session storage read failed, falling back to local:', e)
    const local = await chrome.storage.local.get(CHATGPT_JOB_STORAGE_KEY)
    return (local?.[CHATGPT_JOB_STORAGE_KEY] as Record<string, ChatGPTJobState>) || {}
  }
}

async function chatgptWriteJobs(jobs: Record<string, ChatGPTJobState>): Promise<void> {
  try {
    await chrome.storage.session.set({ [CHATGPT_JOB_STORAGE_KEY]: jobs })
  } catch (e) {
    console.warn('[ChatGPT][Background] session storage write failed, falling back to local:', e)
    await chrome.storage.local.set({ [CHATGPT_JOB_STORAGE_KEY]: jobs })
  }
}

async function chatgptUpdateJob(jobId: string, patch: Partial<ChatGPTJobState>): Promise<ChatGPTJobState | null> {
  const jobs = await chatgptReadJobs()
  const existing = jobs[jobId]
  if (!existing) {
    console.log('[ChatGPT][Background] update on missing job:', jobId)
    return null
  }
  const merged: ChatGPTJobState = { ...existing, ...patch }
  jobs[jobId] = merged
  await chatgptWriteJobs(jobs)
  return merged
}

async function chatgptCleanupExpiredJobs(): Promise<void> {
  const jobs = await chatgptReadJobs()
  const now = Date.now()
  let mutated = false
  for (const [jobId, job] of Object.entries(jobs)) {
    const age = now - job.startedAt
    if (job.status === 'running' && age > CHATGPT_JOB_TTL_MS) {
      jobs[jobId] = {
        ...job,
        status: 'failed',
        error: 'Job hard timeout after ' + Math.round(CHATGPT_JOB_TTL_MS / 1000) + 's',
        finishedAt: now,
      }
      mutated = true
    } else if (job.status !== 'running' && job.finishedAt && now - job.finishedAt > 30 * 60 * 1000) {
      // Drop terminal jobs older than 30 minutes.
      delete jobs[jobId]
      mutated = true
    }
  }
  if (mutated) await chatgptWriteJobs(jobs)
}

// Cleanup expired jobs on every SW startup.
chatgptCleanupExpiredJobs().catch(() => {})

// Listen for results posted by the content script.
// Registered at module load so it survives long generations.
chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, _sender, sendResponse) => {
  if (!msg || (msg as { action?: string }).action !== 'CHATGPT_JOB_DONE') return
  const jobId = (msg as { jobId?: string }).jobId
  if (!jobId) return

  // Re-spawn-safe: even if SW was suspended mid-generation, this listener
  // will be re-invoked when CHATGPT_JOB_DONE arrives and the SW wakes.
  handleChatGPTJobDone(jobId, msg).catch((err) => {
    console.error('[ChatGPT][Background] handleChatGPTJobDone crashed:', err)
    chatgptUpdateJob(jobId, {
      status: 'failed',
      error: 'Background handler crashed: ' + (err as Error).message,
      finishedAt: Date.now(),
    }).catch(() => {})
  })

  // No reply needed; result is persisted in storage.
  return true
})

async function handleChatGPTJobDone(jobId: string, msg: Record<string, unknown>): Promise<void> {
  const payload = (msg as { payload?: { success: boolean; imageUrls?: string[]; error?: string; message?: string } }).payload
  const jobs = await chatgptReadJobs()
  const job = jobs[jobId]
  if (!job) {
    console.log('[ChatGPT][Background] CHATGPT_JOB_DONE for unknown/expired jobId:', jobId)
    return
  }

  if (!payload || !payload.success) {
    await chatgptUpdateJob(jobId, {
      status: 'failed',
      error: payload?.error || 'ChatGPT job failed',
      message: payload?.message,
      finishedAt: Date.now(),
    })
    return
  }

  const imageUrls = payload.imageUrls || []
  console.log('[ChatGPT][Background] job done — image count:', imageUrls.length)

  let downloaded = 0
  if (job.autoDownload && imageUrls.length > 0) {
    const folder = job.outputFolder || 'tobyflow-01'
    const timestamp = Date.now()
    for (let i = 0; i < imageUrls.length; i++) {
      try {
        await chrome.downloads.download({
          url: imageUrls[i],
          filename: `${folder}/chatgpt-${timestamp}-${i}.png`,
          saveAs: false,
        })
        downloaded++
      } catch (dlErr) {
        console.error('[ChatGPT][Background] download failed for index', i, dlErr)
      }
    }
    console.log('[ChatGPT][Background] Downloaded', downloaded, 'of', imageUrls.length)
  }

  await chatgptUpdateJob(jobId, {
    status: 'done',
    imageUrls,
    downloaded,
    finishedAt: Date.now(),
    error: '',
    message: undefined,
  })
}

// Wait for tab to reach `status === 'complete'` before injecting script
// or sending messages. Resolves immediately if already complete.
function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise(function (resolve, reject) {
    var settled = false
    var timer: ReturnType<typeof setTimeout> | null = null

    function cleanup() {
      try { chrome.tabs.onUpdated.removeListener(onUpdated) } catch (_) {}
      if (timer) { clearTimeout(timer); timer = null }
    }

    function finishOk() {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    function finishErr(err: Error) {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    function onUpdated(updatedTabId: number, changeInfo: { status?: string }) {
      if (updatedTabId !== tabId) return
      if (changeInfo.status === 'complete') finishOk()
    }

    chrome.tabs.onUpdated.addListener(onUpdated)

    // Race the timeout.
    timer = setTimeout(function () {
      finishErr(new Error('ChatGPT tab did not finish loading within ' + timeoutMs + 'ms'))
    }, timeoutMs)

    // Pre-check: if already complete, resolve immediately and unbind.
    chrome.tabs
      .get(tabId)
      .then(function (tab) {
        if (settled) return
        if (tab && tab.status === 'complete') finishOk()
      })
      .catch(function (err) {
        finishErr(err instanceof Error ? err : new Error(String(err)))
      })
  })
}

// Make sure the ChatGPT content script is alive in `tabId` before we
// send CHATGPT_SUBMIT_AND_WAIT. Two failure modes this guards against:
//
// 1. The ChatGPT tab was opened BEFORE the extension was reloaded (or
//    chrome://extensions was used to reload), so the manifest-driven
//    content_scripts never got a chance to attach to that tab. The
//    existing tab is alive but has no listener for our messages.
// 2. The tab navigated from a non-chatgpt page to chatgpt.com while the
//    extension was suspended, and chrome.tabs.sendMessage would target
//    a frame that does not yet have the content script.
//
// The fix is: (a) wait for the tab to reach status='complete', (b)
// explicitly inject the content script (idempotent), (c) send a ping
// action and wait for a real response (10x300ms = up to 3s budget)
// before firing the real submit.
// Resolve the actual hashed file name of the ChatGPT content script at
// runtime by inspecting the live manifest. Plasmo emits bundles with
// content hashes (e.g. `content-script.aabbccdd.js`) so we cannot hard-code
// the path. We pick the content_scripts entry whose matches cover
// https://chatgpt.com/* and return its first JS file. Returns null if
// no entry matches — caller should treat that as a fatal configuration error.
function resolveChatGPTContentScriptFile(): string | null {
  try {
    var manifest = chrome.runtime.getManifest()
    var scripts = (manifest.content_scripts as Array<{ matches?: string[]; js?: string[] }>) || []
    for (var i = 0; i < scripts.length; i++) {
      var entry = scripts[i]
      var matches = entry.matches || []
      var covers = matches.some(function (m) {
        return m === '<all_urls>' || m === '*://*/*' || m.indexOf('chatgpt.com') !== -1
      })
      if (covers && entry.js && entry.js.length > 0) return entry.js[0]
    }
  } catch (err) {
    console.warn('[ChatGPT][Background] resolveChatGPTContentScriptFile error: ' + (err as Error).message)
  }
  return null
}

async function ensureChatGPTContentReady(tabId: number): Promise<void> {
  var tab = await chrome.tabs.get(tabId)
  if (!tab || !tab.url || !tab.url.startsWith('https://chatgpt.com/')) {
    throw new Error('ChatGPT tab url mismatch: ' + (tab && tab.url ? tab.url : '(no url)'))
  }

  console.log('[ChatGPT][Background] ensuring content script tabId=' + tabId + ' status=' + tab.status)

  if (tab.status !== 'complete') {
    await waitForTabComplete(tabId, 30000)
  }

  var scriptFile = resolveChatGPTContentScriptFile()
  if (!scriptFile) {
    throw new Error(
      'ChatGPT content script not declared in manifest. ' +
      'Check plasmo.config.ts — src/contents/content-script.ts must be bundled.',
    )
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: [scriptFile],
    })
    console.log('[ChatGPT][Background] content script injected file=' + scriptFile)
  } catch (err) {
    // Script may already be injected, or the tab URL may no longer match
    // the manifest pattern. Log and continue — the ping below will tell
    // us whether the listener is actually live.
    console.warn('[ChatGPT][Background] inject content script warning: ' + (err as Error).message)
  }

  for (var i = 0; i < 10; i++) {
    try {
      var pong = await chrome.tabs.sendMessage(tabId, { action: 'CHATGPT_PING' })
      if (pong && pong.success) {
        console.log('[ChatGPT][Background] content ping ok provider=' + (pong.provider || 'unknown'))
        return
      }
    } catch (_) {
      // Ping threw — listener not attached yet. Retry.
    }
    await new Promise(function (r) { setTimeout(r, 300) })
  }

  throw new Error('ChatGPT content script not ready after injection')
}

async function runChatGPTPrompt(
  payload: ChatGPTPromptPayload
): Promise<{ success: boolean; accepted?: boolean; jobId?: string; error?: string }> {
  console.log('[ChatGPT][Background] runChatGPTPrompt called, prompt len:', payload.prompt?.length)

  // 1. Find or create ChatGPT tab (reuse existing helper)
  const opened = await openProviderTab('chatgpt')
  if (!opened.success || !opened.tabId) {
    return { success: false, error: opened.error || 'Failed to open ChatGPT tab' }
  }
  const tabId = opened.tabId
  console.log('[ChatGPT][Background] tab opened/focused tabId=' + tabId)

  // 2. Ensure content script is injected AND responsive. This is the
  // critical guard against "Receiving end does not exist" — the prior
  // implementation sent CHATGPT_SUBMIT_AND_WAIT immediately after a
  // blind executeScript, which fails when the tab was opened before the
  // extension was reloaded (no manifest-driven content script attached).
  try {
    await ensureChatGPTContentReady(tabId)
  } catch (ensureErr) {
    return { success: false, error: (ensureErr as Error).message }
  }

  const timeoutMs = Math.min(payload.timeoutMs ?? 300000, CHATGPT_JOB_TTL_MS)
  const jobId = 'cgpt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)

  // 3. Persist initial job state BEFORE kicking off the work.
  const jobs = await chatgptReadJobs()
  jobs[jobId] = {
    status: 'running',
    startedAt: Date.now(),
    promptPreview: (payload.prompt || '').slice(0, 120),
    autoDownload: !!payload.autoDownload,
    outputFolder: payload.outputFolder,
    imageUrls: [],
    downloaded: 0,
    error: '',
    tabId,
  }
  await chatgptWriteJobs(jobs)
  console.log('[ChatGPT][Background] job persisted:', jobId)

  // 4. Fire-and-forget kickoff: send CHATGPT_SUBMIT_AND_WAIT with the jobId.
  //    Content script will poll, then post CHATGPT_JOB_DONE which writes back.
  //    Because ensureChatGPTContentReady above has already confirmed the
  //    listener is live (via CHATGPT_PING), the sendMessage below should
  //    not throw "Receiving end does not exist" anymore.
  chrome.tabs
    .sendMessage(tabId, {
      action: 'CHATGPT_SUBMIT_AND_WAIT',
      payload: {
        prompt: payload.prompt,
        ratio: payload.ratio,
        autoDownload: payload.autoDownload,
        timeoutMs,
        jobId,
      },
    })
    .then(() => {
      console.log('[ChatGPT][Background] CHATGPT_SUBMIT_AND_WAIT sent tabId=' + tabId + ' jobId=' + jobId)
    })
    .catch((kickErr) => {
      console.error('[ChatGPT][Background] failed to kick off ChatGPT job:', kickErr)
      chatgptUpdateJob(jobId, {
        status: 'failed',
        error: 'Failed to kick off ChatGPT job: ' + (kickErr as Error).message,
        finishedAt: Date.now(),
      }).catch(() => {})
    })

  // 5. Return immediately. Final result is read via GET_CHATGPT_JOB_STATUS.
  return { success: true, accepted: true, jobId }
}

async function getChatGPTJobStatus(
  payload: { jobId?: string }
): Promise<{ success: boolean; job?: ChatGPTJobState; error?: string }> {
  const jobId = payload?.jobId
  if (!jobId) return { success: false, error: 'jobId is required' }
  const jobs = await chatgptReadJobs()
  const job = jobs[jobId]
  if (!job) return { success: false, error: 'Job not found' }
  return { success: true, job }
}

async function checkFlowTab(): Promise<{ success: boolean; isFlow: boolean; url?: string }> {
  const flowPatterns = [
    'labs.google/fx/tools/flow',
    'labs.google/fx/vi/tools/flow',
    'ai.google.dev/labs/gemini-flow',
    'aistudio.google.com/labs/gemini-flow'
  ]
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) return { success: false, isFlow: false }
  const url = tab.url || ''
  const found = flowPatterns.some((p) => url.includes(p))
  const result = { success: true, isFlow: found, url }
  return result
}

async function getActiveTabInfo(): Promise<{ success: boolean; url?: string; title?: string; id?: number }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) return { success: false }

  return {
    success: true,
    url: tab.url,
    title: tab.title,
    id: tab.id
  }
}

async function focusTab(tabId: number): Promise<{ success: boolean }> {
  try {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {})
    await chrome.windows.update(tabId, { focused: true })
    return { success: true }
  } catch {
    return { success: false }
  }
}

let wakeLock: WakeLockSentinel | null = null

async function requestWakeLock(): Promise<{ success: boolean; error?: string }> {
  if (!('wakeLock' in navigator)) {
    return { success: false, error: 'Wake Lock API not supported' }
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen')
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

async function releaseWakeLock(): Promise<{ success: boolean }> {
  if (wakeLock) {
    await wakeLock.release()
    wakeLock = null
  }
  return { success: true }
}

async function downloadFile(payload: { data: string; filename: string; mimeType: string }): Promise<{ success: boolean; error?: string }> {
  try {
    const base64Data = payload.data.replace(/^data:[^;]+;base64,/, '')
    const binaryString = atob(base64Data)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    const blob = new Blob([bytes], { type: payload.mimeType })
    const url = URL.createObjectURL(blob)

    await chrome.downloads.download({
      url,
      filename: payload.filename,
      saveAs: true
    })

    setTimeout(() => URL.revokeObjectURL(url), 10000)
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

async function showNotification(payload: { title: string; message: string; type?: string }): Promise<{ success: boolean }> {
  await chrome.notifications.create({
    type: 'basic',
    iconUrl: 'assets/icon.png',
    title: payload.title,
    message: payload.message
  })
  return { success: true }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true })
})

// ── Flow Integration ────────────────────────────────────────────────────────────

interface RunFlowPromptPayload {
  prompt: string
  provider?: string
  mode: 'image' | 'video'
  model: string
  aspectRatio: string
  quantity: number
  duration?: string
  style: string | null
  referenceImages: string[]
  autoDownload: boolean
  outputFolder: string
  resolution: string
  videoResolution?: string
  focusTab?: boolean
}

interface FlowStatusPayload {
  status: string
  timestamp: number
  tiles?: string[]
  error?: string
}

interface UploadImagePayload {
  key: string
  name: string
  type: string
  base64: string
}

const FLOW_URL = 'https://labs.google/fx/tools/flow'

async function getFlowScriptFiles(): Promise<{ content: string | null; bridge: string | null }> {
  try {
    const manifest = chrome.runtime.getManifest() as {
      content_scripts?: Array<{ js?: string[]; world?: string }>
    }
    const allJs = manifest.content_scripts?.flatMap(cs => cs.js || []) || []
    const content = allJs.find(f => f.includes('flow-content.')) ?? null
    const bridge = allJs.find(f => f.includes('flow-slate-bridge.')) ?? null
    return { content, bridge }
  } catch {
    return { content: null, bridge: null }
  }
}

async function debugPingFlowTab() {
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/fx/*' })
  if (!tabs.length || !tabs[0].id) {
    return { ok: false, error: 'No Flow tab found' }
  }
  const tabId = tabs[0].id
  console.log('[Background] Flow tab found, tabId:', tabId)

  try {
    const result = await chrome.tabs.sendMessage(tabId, { action: 'FLOW_DEBUG_PING' })
    console.log('[Background] Ping success')
    return result
  } catch (e) {
    const err = e as Error
    console.warn('[Background] Ping content failed, injecting fallback:', err.message)

    const scripts = await getFlowScriptFiles()
    if (!scripts.content) {
      return { ok: false, error: 'Could not find flow-content script in manifest' }
    }

    try {
      console.log('[Background] Injecting flow content:', scripts.content)
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [scripts.content]
      })
      console.log('[Background] Injected flow content')

      if (scripts.bridge) {
        console.log('[Background] Injecting flow bridge (MAIN world):', scripts.bridge)
        await chrome.scripting.executeScript({
          target: { tabId },
          files: [scripts.bridge],
          world: 'MAIN'
        })
        console.log('[Background] Injected flow bridge')
      }

      await new Promise(r => setTimeout(r, 500))

      const result = await chrome.tabs.sendMessage(tabId, { action: 'FLOW_DEBUG_PING' })
      console.log('[Background] Ping success after injection')
      return result
    } catch (injectErr) {
      return { ok: false, error: 'Injection failed: ' + (injectErr as Error).message }
    }
  }
}

async function uploadImageToFlow(
  payload: UploadImagePayload
): Promise<{ success: boolean; key?: string; tileId?: string; fileName?: string; thumbnail?: string; error?: string; details?: Record<string, unknown> }> {
  console.log('[Background][FLOW_UPLOAD_IMAGE_START]', JSON.stringify({
    key: payload.key,
    name: payload.name,
    type: payload.type,
    base64Length: payload.base64.length,
  }))

  // Find Flow tab
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/fx/*' })
  const flowTab = tabs.find(t => t.url?.includes('labs.google/fx'))
  if (!flowTab?.id) {
    const err = 'No Flow tab found'
    console.error('[Background][FLOW_UPLOAD_IMAGE_RESULT]', JSON.stringify({ key: payload.key, success: false, error: err }))
    return { success: false, key: payload.key, error: err }
  }
  const tabId = flowTab.id

  // Ensure bridge is ready
  try {
    const pingResult = await chrome.tabs.sendMessage(tabId, { action: 'FLOW_INJECT_BRIDGE' }).catch(() => null)
    if (!pingResult?.bridgeReady) {
      await ensureBridgeReady(tabId)
    }
  } catch {
    // Continue — bridge may still work
  }

  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      action: 'FLOW_UPLOAD_IMAGES',
      filesData: [{
        key: payload.key,
        name: payload.name,
        type: payload.type,
        base64: payload.base64,
      }],
    })

    const uploadSuccess = !!(result as Record<string, unknown>).success
    const uploadError = String((result as Record<string, unknown>).error || '')
    const keyMapping = (result as Record<string, unknown>).keyMapping as Record<string, string> | undefined
    const tileDetails = (result as Record<string, unknown>).tileDetails as Array<Record<string, unknown>> | undefined
    const diagnostics = (result as Record<string, unknown>).diagnostics as Record<string, unknown> | undefined

    if (!uploadSuccess) {
      console.error('[Background][FLOW_UPLOAD_IMAGE_RESULT]', JSON.stringify({
        key: payload.key,
        success: false,
        error: uploadError || 'Upload failed',
      }))
      return {
        success: false,
        key: payload.key,
        error: uploadError || 'FLOW_UPLOAD_IMAGE_FAILED',
        details: { diagnostics },
      }
    }

    if (!keyMapping || !tileDetails || tileDetails.length === 0) {
      console.error('[Background][FLOW_UPLOAD_IMAGE_RESULT]', JSON.stringify({
        key: payload.key,
        success: false,
        error: 'Upload returned empty tileDetails/keyMapping',
      }))
      return {
        success: false,
        key: payload.key,
        error: 'FLOW_UPLOAD_IMAGE_FAILED: empty response',
        details: { diagnostics },
      }
    }

    // Resolve this key → tileId from keyMapping
    const tileId = keyMapping[payload.key] || ''
    const tileDetail = tileDetails.find(function (t) { return t.id === tileId })
    const fileName = tileDetail ? String(tileDetail.file_name || payload.name) : String(payload.name)
    const thumbnail = tileDetail?.thumbnailUrl ? String(tileDetail.thumbnailUrl) : undefined

    console.log('[Background][FLOW_UPLOAD_IMAGE_RESULT]', JSON.stringify({
      key: payload.key,
      success: true,
      tileId,
      fileName,
    }))

    return {
      success: true,
      key: payload.key,
      tileId,
      fileName,
      thumbnail,
    }
  } catch (e) {
    const err = 'chrome.tabs.sendMessage failed: ' + ((e as Error).message || String(e))
    console.error('[Background][FLOW_UPLOAD_IMAGE_RESULT]', JSON.stringify({ key: payload.key, success: false, error: err }))
    return { success: false, key: payload.key, error: err }
  }
}

async function ensureBridgeReady(tabId: number): Promise<void> {
  const scripts = await getFlowScriptFiles()
  if (!scripts.content) return

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [scripts.content] })
  } catch { /* already injected */ }

  if (scripts.bridge) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [scripts.bridge], world: 'MAIN' })
    } catch { /* already injected */ }
  }

  for (let i = 0; i < 10; i++) {
    try {
      const ready = await chrome.tabs.sendMessage(tabId, { action: 'FLOW_INJECT_BRIDGE' }).catch(() => null)
      if (ready?.bridgeReady) return
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
}

async function findOrOpenFlowTab(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/fx/*' })
  if (tabs.length > 0 && tabs[0].id) return tabs[0].id
  try {
    const tab = await chrome.tabs.create({ url: FLOW_URL, active: false })
    return tab.id ?? null
  } catch {
    return null
  }
}

async function runFlowPrompt(
  payload: RunFlowPromptPayload,
  senderTabId?: number
): Promise<{ success: boolean; tabId?: number; status?: string; error?: string; tiles?: string[] }> {
  console.log('[Background] runFlowPrompt called, prompt len:', payload.prompt?.length)
  console.log('[Background][RUN_FLOW_PROMPT_PAYLOAD]', JSON.stringify({
    mode: payload.mode,
    model: payload.model,
    ratio: payload.aspectRatio,
    quantity: payload.quantity,
    duration: payload.duration,
  }, null, 2))

  let tabId = payload.tabId || senderTabId
  if (!tabId) {
    tabId = await findOrOpenFlowTab()
    if (!tabId) return { success: false, error: 'Could not find or open Flow tab' }
  }

  try {
    // Step 1: Check if bridge is already loaded via content script
    const pingResult = await chrome.tabs.sendMessage(tabId, { action: 'FLOW_INJECT_BRIDGE' }).catch(() => null)
    if (BG_DEBUG) console.log('[Background] Bridge check response:', pingResult)
    const bridgeLoaded = pingResult?.bridgeLoaded === true && pingResult?.bridgeReady === true

    if (!bridgeLoaded) {
      if (BG_DEBUG) console.log('[Background] Bridge not ready, injecting scripts...')
      const scripts = await getFlowScriptFiles()
      if (!scripts.content) {
        return { success: false, error: 'Could not find flow-content script in manifest' }
      }

      // Inject content script (ISOLATED world)
      if (BG_DEBUG) console.log('[Background] Injecting content script...')
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: [scripts.content]
        })
      } catch (e) {
        console.warn('[Background] Content injection failed:', e)
        return { success: false, error: 'Content script injection failed: ' + (e as Error).message }
      }

      // Inject bridge (MAIN world)
      if (scripts.bridge) {
        if (BG_DEBUG) console.log('[Background] Injecting bridge MAIN world...')
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: [scripts.bridge],
            world: 'MAIN'
          })
        } catch (e) {
          console.warn('[Background] Bridge injection failed:', e)
          return { success: false, error: 'Bridge MAIN world injection failed: ' + (e as Error).message }
        }
      }

      // Wait for bridge to initialize
      await new Promise(r => setTimeout(r, 800))
      if (BG_DEBUG) console.log('[Background] Injection done, polling bridge ready...')

      // Poll until bridge is ready (via content script postMessage)
      var bridgeReady = false
      for (let i = 0; i < 10; i++) {
        try {
          const readyCheck = await chrome.tabs.sendMessage(tabId, { action: 'FLOW_INJECT_BRIDGE' }).catch(() => null)
          if (BG_DEBUG) console.log('[Background] Bridge ready check #' + (i + 1) + ':', readyCheck)
          if (readyCheck?.bridgeReady === true) {
            bridgeReady = true
            if (BG_DEBUG) console.log('[Background] Bridge ready after', (i + 1) * 500, 'ms')
            break
          }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 500))
        if (i === 9) {
          return { success: false, error: 'Bridge failed to initialize. Try reloading the Flow tab.' }
        }
      }

      if (!bridgeReady) {
        return { success: false, error: 'Bridge not ready after injection. Try reloading the Flow tab.' }
      }
    }
  } catch (e) {
    if (BG_DEBUG) console.warn('[Background] Bridge check/injection error:', e)
  }

  if (payload.focusTab) {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {})
  }

  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      action: 'RUN_FLOW_PROMPT',
      payload,
      tabId
    })
    console.log('[Background] runFlowPrompt result:', result)
    return {
      success: result?.success ?? false,
      tabId,
      status: result?.status,
      tiles: result?.tiles,
      error: result?.error,
      autoDownload: result?.autoDownload,
      downloadDetails: result?.downloadDetails,
    }
  } catch (e) {
    console.error('[Background] sendMessage failed:', e)
    return { success: false, error: (e as Error).message }
  }
}

function handleFlowStatus(payload: FlowStatusPayload) {
  console.log('[Background] Flow status:', payload.status, 'timestamp:', payload.timestamp)
  return { received: true, status: payload.status }
}

// ── Tile Monitor ─────────────────────────────────────────────────────────────

async function startTileMonitor(tabId: number): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { action: 'startTileMonitor' })
    return { success: true }
  } catch (e) {
    return { success: false, error: 'Failed to start tile monitor: ' + (e as Error).message }
  }
}

async function stopTileMonitor(tabId: number): Promise<{ success: boolean; error?: string }> {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'stopTileMonitor' })
    return { success: true }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

async function getTileCounts(tabId: number): Promise<{ generating: number; done: number; failed: number; total: number }> {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { action: 'getTiles' })
    return (result as Record<string, unknown>).counts as { generating: number; done: number; failed: number; total: number }
  } catch (e) {
    return { generating: 0, done: 0, failed: 0, total: 0 }
  }
}

interface TileCounts {
  generating: number
  done: number
  failed: number
  total: number
}

interface RenameQueueEntry {
  folder: string
  filename: string
  identifier: string
  resolution?: string
  // Media kind: 'image' | 'video'. Used by onDeterminingFilename to
  // pick the right file extension when the download URL doesn't expose
  // one (some Flow CDN URLs are extension-less). Without this hint a
  // video download would silently default to .png.
  mediaKind?: 'image' | 'video'
}

// ── Download Rename Queue ────────────────────────────────────────────────────────

interface PendingRename {
  folder: string
  filename: string
  identifier: string
  mediaKind: 'image' | 'video'
  addedAt: number
}

var _pendingRenameQueue: PendingRename[] = []
var _downloadRenameListenerAdded = false

function addDownloadRenameListener(): void {
  if (_downloadRenameListenerAdded) return
  _downloadRenameListenerAdded = true
  chrome.downloads.onDeterminingFilename.addListener(function (item, suggest) {
    var url = item.url || ''
    // Only handle Flow-initiated downloads (skip non-HTTP like blob:)
    if (!url.startsWith('http')) return

    // Match by identifier (tileId) in url or by filename hint
    var matched: PendingRename | null = null
    if (_pendingRenameQueue.length === 1) {
      // FIFO when only one entry
      matched = _pendingRenameQueue[0]
    } else {
      // Match by identifier
      var id = item.filename || ''
      matched = _pendingRenameQueue.find(function (e) {
        return id.includes(e.identifier) || e.filename.includes(item.filename || '')
      }) || null
    }

    if (matched) {
      // Pick the file extension. Priority:
      // 1. URL-derived extension (most reliable).
      // 2. mediaKind hint from the caller (video → mp4, image → png).
      // 3. Final fallback → png (defensive default).
      var urlExt = getExtensionFromUrl(url)
      var ext: string
      if (urlExt) {
        ext = urlExt
      } else if (matched.mediaKind === 'video') {
        ext = 'mp4'
      } else {
        ext = 'png'
      }
      var fullPath = matched.folder + '/' + matched.filename + '.' + ext
      // Remove from queue
      _pendingRenameQueue = _pendingRenameQueue.filter(function (e) { return e !== matched })
      console.log('[Background] Download rename:', item.filename || '', '→ folder=' + matched.folder, 'file=' + matched.filename + '.' + ext, 'mediaKind=' + matched.mediaKind, 'urlExt=' + (urlExt || 'none'))
      suggest({ filename: fullPath })
    } else {
      console.log('[Background] Download rename: no match for', item.filename || '', 'queue size:', _pendingRenameQueue.length)
    }
  })
  console.log('[Background] Download rename listener added')
}

function getExtensionFromUrl(url: string): string {
  try {
    var u = new URL(url)
    var path = u.pathname
    var lastDot = path.lastIndexOf('.')
    if (lastDot >= 0) {
      var ext = path.substring(lastDot + 1).toLowerCase()
      if (ext === 'jpg') return 'jpg'
      if (ext === 'jpeg') return 'jpg'
      if (ext === 'png') return 'png'
      if (ext === 'mp4') return 'mp4'
      if (ext === 'webm') return 'webm'
    }
  } catch (_) {}
  return 'png'
}

async function handlePrepareDownloadRename(entry: RenameQueueEntry): Promise<{ success: boolean }> {
  // Ensure the download rename listener is registered
  addDownloadRenameListener()

  // Clean up old entries (> 5 min)
  var now = Date.now()
  _pendingRenameQueue = _pendingRenameQueue.filter(function (e) {
    return now - e.addedAt < 5 * 60 * 1000
  })

  // Sanitize folder: trim, block path traversal, replace invalid chars with _
  var rawFolder = String(entry.folder || '').trim()
  // Block ../ path traversal
  rawFolder = rawFolder.replace(/\.\./g, '')
  // Block leading/trailing slashes
  rawFolder = rawFolder.replace(/^\/+|\/+$/g, '')
  // Replace any remaining dangerous chars with underscore
  rawFolder = rawFolder.replace(/[<>:"|?*]/g, '_')
  // Collapse multiple underscores
  rawFolder = rawFolder.replace(/_+/g, '_')

  // Default to tobyflow-01 only when folder is empty after sanitization
  var folderUsed = rawFolder || 'tobyflow-01'

  _pendingRenameQueue.push({
    folder: folderUsed,
    filename: entry.filename || 'flow',
    identifier: entry.identifier || '',
    mediaKind: entry.mediaKind === 'video' ? 'video' : 'image',
    addedAt: now,
  })

  console.log('[Background][DOWNLOAD_RENAME_PREPARED]', JSON.stringify({
    rawFolder: entry.folder,
    folderUsed: folderUsed,
    filename: entry.filename,
    identifier: entry.identifier,
    mediaKind: entry.mediaKind || 'image',
    queueSize: _pendingRenameQueue.length,
  }))

  return { success: true }
}

// ── DEBUG GLOBALS — call directly from service worker DevTools console ──────────
;(globalThis as unknown as Record<string, unknown>).debugPing = debugPingFlowTab
;(globalThis as unknown as Record<string, unknown>).findFlowTab = async () => {
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' })
  console.log('[Debug] Flow tabs:', tabs.map(t => ({ id: t.id, url: t.url, title: t.title })))
  return tabs
}
;(globalThis as unknown as Record<string, unknown>).getManifest = () => chrome.runtime.getManifest()

export {}
