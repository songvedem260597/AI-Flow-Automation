/**
 * SHARED BACKGROUND DISPATCHER
 *
 * WARNING:
 * This file routes multiple providers.
 * Do not reuse ChatGPT bridge logic for Google Flow.
 *
 * Google Flow route:
 *   background -> flow-content.ts (ISOLATED world) -> flow-slate-bridge.ts (MAIN world, postMessage bridge)
 *
 * ChatGPT route:
 *   background -> chatgpt-content.ts / chatgpt-bridge.ts via chrome.storage.session job state
 *
 * Any shared helper must be guarded by provider/action. Do not collapse Google
 * Flow's two-tier bridge into a single helper that ChatGPT might also call.
 * See CLAUDE.md → "Shared Files Guard — Provider Boundary Rules".
 */

import type { ChromeMessage } from '@/types'
import { PROVIDER_TABS } from '@/constants'
import { DEBUG_FLAGS, debugLog } from '@/lib/debug'

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
var workflowEditorTabId: number | null = null

const WORKFLOW_EDITOR_WINDOW_ID_KEY = 'workflowEditorWindowId'
const WORKFLOW_EDITOR_TAB_ID_KEY = 'workflowEditorTabId'

function toPositiveNumber(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

async function readStoredWorkflowEditorIds(): Promise<{ windowIds: Set<number>; tabIds: Set<number> }> {
  const windowIds = new Set<number>()
  const tabIds = new Set<number>()

  if (workflowEditorWindowId !== null) windowIds.add(workflowEditorWindowId)
  if (workflowEditorTabId !== null) tabIds.add(workflowEditorTabId)

  const readArea = async (area?: chrome.storage.StorageArea) => {
    if (!area?.get) return
    try {
      const stored = await area.get([WORKFLOW_EDITOR_WINDOW_ID_KEY, WORKFLOW_EDITOR_TAB_ID_KEY])
      const storedWindowId = toPositiveNumber(stored?.[WORKFLOW_EDITOR_WINDOW_ID_KEY])
      const storedTabId = toPositiveNumber(stored?.[WORKFLOW_EDITOR_TAB_ID_KEY])
      if (storedWindowId !== null) windowIds.add(storedWindowId)
      if (storedTabId !== null) tabIds.add(storedTabId)
    } catch {}
  }

  await readArea(chrome.storage.session)
  await readArea(chrome.storage.local)

  return { windowIds, tabIds }
}

async function rememberWorkflowEditorWindow(windowId?: number | null, tabId?: number | null): Promise<void> {
  const normalizedWindowId = toPositiveNumber(windowId)
  const normalizedTabId = toPositiveNumber(tabId)

  workflowEditorWindowId = normalizedWindowId
  workflowEditorTabId = normalizedTabId

  const payload: Record<string, number> = {}
  if (normalizedWindowId !== null) payload[WORKFLOW_EDITOR_WINDOW_ID_KEY] = normalizedWindowId
  if (normalizedTabId !== null) payload[WORKFLOW_EDITOR_TAB_ID_KEY] = normalizedTabId
  if (Object.keys(payload).length === 0) return

  await chrome.storage.session?.set?.(payload).catch(() => {})
  await chrome.storage.local?.set?.(payload).catch(() => {})
}

async function clearStoredWorkflowEditorIds(): Promise<void> {
  workflowEditorWindowId = null
  workflowEditorTabId = null
  const keys = [WORKFLOW_EDITOR_WINDOW_ID_KEY, WORKFLOW_EDITOR_TAB_ID_KEY]
  await chrome.storage.session?.remove?.(keys).catch(() => {})
  await chrome.storage.local?.remove?.(keys).catch(() => {})
}

async function closeWorkflowEditorTabsOnExtensionReload() {
  const editorUrl = chrome.runtime.getURL('tabs/workflow-editor.html')
  const { windowIds, tabIds } = await readStoredWorkflowEditorIds()
  try {
    const tabs = await chrome.tabs.query({})

    for (const tab of tabs) {
      const tabId = toPositiveNumber(tab.id)
      const tabUrl = typeof tab.url === 'string' ? tab.url : ''
      const pendingUrl = typeof tab.pendingUrl === 'string' ? tab.pendingUrl : ''

      if (tabUrl.startsWith(editorUrl) || pendingUrl.startsWith(editorUrl)) {
        if (tabId !== null) tabIds.add(tabId)
        if (toPositiveNumber(tab.windowId) !== null) windowIds.add(tab.windowId)
      }

      if (tabId !== null && tabIds.has(tabId) && toPositiveNumber(tab.windowId) !== null) {
        windowIds.add(tab.windowId)
      }
    }

    const closedWindowIds = new Set<number>()
    for (const windowId of windowIds) {
      try {
        const win = await chrome.windows.get(windowId, { populate: true })
        const winTabs = win.tabs || []
        const hasEditorUrl = winTabs.some((tab) => {
          const url = typeof tab.url === 'string' ? tab.url : ''
          const pendingUrl = typeof tab.pendingUrl === 'string' ? tab.pendingUrl : ''
          return url.startsWith(editorUrl) || pendingUrl.startsWith(editorUrl)
        })
        const hasStoredTab = winTabs.some((tab) => {
          const tabId = toPositiveNumber(tab.id)
          return tabId !== null && tabIds.has(tabId)
        })

        // The workflow editor is opened as a popup. After extension reload
        // Chrome can convert the invalid extension page into a blank/New Tab
        // page, so URL matching alone is too late. If this is the stored
        // popup window, close the whole popup instead of leaving a white tab.
        if (win.type === 'popup' && (hasEditorUrl || hasStoredTab || windowIds.has(windowId))) {
          await chrome.windows.remove(windowId).catch(() => {})
          closedWindowIds.add(windowId)
        }
      } catch {}
    }

    const remainingTabIds = Array.from(tabIds).filter((tabId) => {
      const tab = tabs.find((item) => item.id === tabId)
      return !tab || !closedWindowIds.has(tab.windowId)
    })

    if (remainingTabIds.length > 0) {
      await chrome.tabs.remove(remainingTabIds).catch(() => {})
    }
  } finally {
    await clearStoredWorkflowEditorIds()
  }
}

/**
 * Reload (do NOT remove) every open provider tab on extension install /
 * update / reload. After `chrome.runtime.reload()` (or after clicking
 * "Reload" in chrome://extensions), existing provider tabs
 * (chatgpt.com / grok.com / labs.google/fx/*) still hold the previous
 * bundle's content scripts. Those scripts subsequently throw
 * `Extension context invalidated` whenever they touch chrome.runtime or
 * chrome.storage. The only safe remedy is to reload the tab itself; this
 * function triggers that.
 *
 * Provider URLs come from the shared `PROVIDER_TABS` constant so the
 * pattern list stays in sync with the adapter implementations.
 *
 * IMPORTANT: this is ONLY called from real extension lifecycle events
 * (`onInstalled`, `onStartup`, gated version-mismatch check). Service
 * worker wake-ups alone do NOT call this — otherwise we'd reload tabs
 * during normal usage and disrupt in-flight generations.
 */
async function reloadProviderTabsOnExtensionReload() {
  // Query one provider at a time so an invalid URL pattern in one entry
  // can't take down the others. This is a defensive guard — today's
  // patterns are validated, but future additions may not be.
  const providerTabs = PROVIDER_TABS as unknown as Record<
    string,
    { queryUrl: string; createUrl: string } | undefined
  >
  const providerKeys = Object.keys(providerTabs).filter(
    (k) => k !== 'claude' && k !== 'gemini'
  )

  for (const key of providerKeys) {
    const cfg = providerTabs[key]
    if (!cfg) continue

    let tabs: chrome.tabs.Tab[] = []
    try {
      tabs = await chrome.tabs.query({ url: cfg.queryUrl })
    } catch (e) {
      // Invalid URL pattern (regression): log and skip this provider only.
      console.warn(
        `[Background] reloadProviderTabsOnExtensionReload: chrome.tabs.query failed for provider=${key}:`,
        e
      )
      continue
    }

    for (const tab of tabs) {
      if (!tab || tab.id === undefined) continue
      // Don't reload the editor / side panel / extension pages by accident.
      const url = typeof tab.url === 'string' ? tab.url : ''
      if (url.startsWith('chrome-extension://') || url.startsWith('chrome://')) continue
      chrome.tabs.reload(tab.id).catch((err) => {
        console.warn(
          `[Background] reloadProviderTabsOnExtensionReload: chrome.tabs.reload failed for tabId=${tab.id}:`,
          err
        )
      })
    }
  }
}

// ── Lifecycle-gated cleanup ──────────────────────────────────────────────
// Reloading provider tabs is potentially disruptive (any open ChatGPT /
// Flow page that is mid-generation will lose its state). It must only
// happen on REAL lifecycle events — never on ordinary SW wake-ups.
//
// We additionally gate the reload behind a stored version/build marker so
// the very first wake-up after an extension update gets exactly one clean
// reload pass, and subsequent wakes (no version change) don't touch tabs.

const VERSION_KEY = 'ai-flow-installed-version'
const BUILD_KEY = 'ai-flow-installed-build'

interface ManifestLike {
  version?: string
  version_name?: string
}

function readCurrentExtensionMarkers(): { version: string; buildId: string } {
  // Prefer fields that are actually unique across rebuilds: manifest
  // `version` + `version_name`. If a build pipeline sets `version_name`
  // (e.g. timestamps) we use it as the build id; otherwise we fall back
  // to `version`. Both come from chrome.runtime.getManifest() — they're
  // stable for the lifetime of the installed bundle.
  const manifest = (chrome.runtime.getManifest() as unknown as ManifestLike) || {}
  const version = String(manifest.version || '')
  const buildId = String(manifest.version_name || manifest.version || '')
  return { version, buildId }
}

async function readStoredExtensionMarkers(): Promise<{ version: string; buildId: string } | null> {
  try {
    // chrome.storage.session is wiped when Chrome exits, so a "missing"
    // entry means either a fresh install OR a different lifecycle path.
    // We also fall back to chrome.storage.local so the marker survives
    // a service-worker suspension / browser restart.
    const session = await chrome.storage.session?.get?.([VERSION_KEY, BUILD_KEY]).catch(() => null)
    const local = await chrome.storage.local?.get?.([VERSION_KEY, BUILD_KEY]).catch(() => null)
    const map = (session && typeof session === 'object' ? session : null) ||
      (local && typeof local === 'object' ? local : null) ||
      null
    if (!map) return null
    const version = typeof map[VERSION_KEY] === 'string' ? (map[VERSION_KEY] as string) : ''
    const buildId = typeof map[BUILD_KEY] === 'string' ? (map[BUILD_KEY] as string) : ''
    if (!version && !buildId) return null
    return { version, buildId }
  } catch {
    return null
  }
}

async function writeStoredExtensionMarkers(markers: { version: string; buildId: string }): Promise<void> {
  // Write to BOTH session and local. The local copy is the authoritative
  // one for "have we ever seen this version?" — session is just a fast
  // path for the common case where the SW didn't recycle.
  try {
    await chrome.storage.session?.set?.({ [VERSION_KEY]: markers.version, [BUILD_KEY]: markers.buildId })
  } catch {}
  try {
    await chrome.storage.local?.set?.({ [VERSION_KEY]: markers.version, [BUILD_KEY]: markers.buildId })
  } catch {}
}

/**
 * Returns true if the installed bundle's version/build differs from
 * what's stored. ALWAYS updates the stored value before returning, so
 * that subsequent SW wake-ups with the same bundle see "no mismatch" and
 * skip the cleanup pass.
 *
 * The "always update" semantic is what makes the version-gated reload
 * idempotent — by the time the SW calls `reloadProviderTabsOnExtensionReload`
 * a second time on the same bundle, the stored markers already match
 * the current ones.
 */
async function shouldRunLifecycleReload(): Promise<boolean> {
  const current = readCurrentExtensionMarkers()
  const stored = await readStoredExtensionMarkers()

  const sameVersion = !!stored && stored.version === current.version
  const sameBuild = !!stored && stored.buildId === current.buildId

  if (sameVersion && sameBuild) return false

  // Persist current markers regardless so subsequent wake-ups are clean.
  await writeStoredExtensionMarkers(current)
  return true
}

/**
 * The actual cleanup orchestrator. Differs from the previous version in
 * that the workflow-editor tab closing is unconditional (it can never
 * point to a real session ID because the previous SW is gone), but the
 * provider-tab reload is gated behind a version mismatch so it only
 * fires when the bundle has actually changed.
 *
 * Wrapped so a single failure never crashes the SW.
 */
async function runExtensionReloadCleanup(options: { closeEditorsImmediately?: boolean } = {}): Promise<void> {
  const closeEditorsImmediately = options.closeEditorsImmediately !== false

  // Workflow-editor cleanup is always safe — there's no in-flight state
  // to disrupt (the editor's persist layer uses chrome.storage which
  // survives a reload), and any open editor window is pointing at the
  // old bundle.
  if (closeEditorsImmediately) {
    try {
      await closeWorkflowEditorTabsOnExtensionReload()
    } catch (error) {
      console.warn('[Background] failed to close stale workflow editor tabs:', error)
    }
  }

  // Provider-tab reload is gated. If the stored version/build already
  // matches, this is just a regular SW wake (no reload happened) and we
  // skip the reload to avoid interrupting active generations.
  try {
    const should = await shouldRunLifecycleReload()
    if (!should) {
      console.log('[Background] provider-tab reload skipped (no version/build mismatch)')
      return
    }
    if (!closeEditorsImmediately) {
      await closeWorkflowEditorTabsOnExtensionReload()
    }
    await reloadProviderTabsOnExtensionReload()
  } catch (error) {
    // Defensive — never let SW crash because of cleanup issues.
    console.warn('[Background] failed to reload stale provider tabs:', error)
  }
}

// First listener: side panel behavior.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true })
})

// Second listener: cleanup on install / update.
// `onInstalled` fires for `install`, `update`, and `chrome_update` —
// all three are real bundle changes where the old provider tabs hold
// stale scripts. The version-gated guard inside
// `runExtensionReloadCleanup` keeps this idempotent if a user
// double-taps the Reload button.
chrome.runtime.onInstalled.addListener(() => {
  runExtensionReloadCleanup().catch((error) => {
    console.warn('[Background] extension-reload cleanup failed:', error)
  })
})

// Third listener: cleanup on browser startup.
// `onStartup` fires once when the browser launches and the SW spins up.
// On a session where the user did not reload the extension, the stored
// markers already match — so the inner gate makes this a no-op.
chrome.runtime.onStartup?.addListener(() => {
  runExtensionReloadCleanup({ closeEditorsImmediately: false }).catch((error) => {
    console.warn('[Background] extension-reload cleanup failed:', error)
  })
})

chrome.windows.onRemoved.addListener((windowId) => {
  if (workflowEditorWindowId === windowId) {
    console.log('[Workflow][EditorFocus] cleared', JSON.stringify({
      reason: 'workflow-editor-window-closed',
      windowId,
    }))
    clearStoredWorkflowEditorIds().catch(() => {})
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
      const payload = message.payload as { provider?: string; focus?: boolean } | undefined
      const provider = payload?.provider
      if (!provider) return { success: false, error: 'provider is required' }
      // Default behavior: focus the provider tab so GenPanel users see
      // the active generation. Workflow-run callers pass focus:false
      // so their tab (Workflow Editor / Side Panel) stays on screen.
      const shouldFocus = payload?.focus !== false
      return openProviderTab(provider, shouldFocus)
    }

    case 'ENSURE_PROVIDER_TAB_FOR_WORKFLOW': {
      // Workflow-only entry point. Activates the provider tab +
      // window BEFORE the workflow runner submits the prompt so the
      // user does not have to manually switch tabs as the workflow
      // advances between providers. Unlike `OPEN_PROVIDER_TAB` (used
      // by GenPanel direct generation), this helper:
      //   - always activates the tab + window (focus: true is the
      //     workflow contract; GenPanel callers go through
      //     RUN_FLOW_PROMPT / RUN_CHATGPT_PROMPT directly);
      //   - emits [Workflow][ProviderRoute] trace logs at every
      //     state transition (start / existingTab / createdTab /
      //     focusedTab / ready / send);
      //   - optionally waits for content-script readiness via the
      //     already-existing chatgpt / flow readiness probes
      //     (CHATGPT_PING for chatgpt, FLOW_INJECT_BRIDGE for flow).
      //
      // Owner: shared (provider routing helper used by runner only —
      // GenPanel keeps its original focus:false contract for direct
      // submits unless the caller explicitly opts in).
      const payload = (message.payload || {}) as {
        provider?: string
        nodeId?: string
        waitReady?: boolean
        activate?: boolean
        focusWindow?: boolean
        preserveEditor?: boolean
      }
      const provider = String(payload.provider || '')
      const nodeId = String(payload.nodeId || '')
      if (!provider) {
        return { success: false, error: 'provider is required' }
      }
      return ensureProviderTabForWorkflow(provider, nodeId, {
        waitReady: payload.waitReady !== false,
        activate: payload.activate === true,
        focusWindow: payload.focusWindow === true,
        preserveEditor: payload.preserveEditor !== false,
      })
    }

    case 'INJECT_SCRIPT':
      if (message.tabId) {
        // Use the runtime-resolved content script file (matches
        // <all_urls>) instead of a hardcoded bundle path that may not
        // exist in the built extension.
        const scriptFile = resolveChatGPTContentScriptFile()
        if (!scriptFile) {
          return { success: false, error: 'No content script entry matches in manifest' }
        }
        try {
          await chrome.scripting.executeScript({
            target: { tabId: message.tabId },
            files: [scriptFile]
          })
        } catch (err) {
          const msg = (err as Error).message || ''
          if (msg.indexOf('already') !== -1 || msg.indexOf('specified') !== -1) {
            return { success: true }
          }
          return { success: false, error: msg }
        }
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

    case 'WORKFLOW_DOWNLOAD_OUTPUT':
      return downloadWorkflowOutput(message.payload as { url: string; filename?: string })

    case 'NOTIFICATION':
      return showNotification(message.payload as { title: string; message: string; type?: string })

    case 'OPEN_WORKFLOW_EDITOR_WINDOW':
      return openWorkflowEditorWindow(message.payload as { workflowId?: string } | undefined)

    case 'REGISTER_WORKFLOW_EDITOR_TAB': {
      const tab = sender.tab
      if (!tab?.id || tab.windowId === undefined) {
        return { success: false, error: 'Workflow editor tab sender is missing' }
      }
      await rememberWorkflowEditorWindow(tab.windowId, tab.id)
      // [Workflow][EditorFocus] captured — every workflow run
      // should preserve this origin so provider-tab focus operations
      // never navigate / close / minimize the editor popup.
      console.log('[Workflow][EditorFocus] captured', JSON.stringify({
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url || tab.pendingUrl || '',
        type: tab.windowType || '',
      }))
      return { success: true }
    }

    case 'RESTORE_EDITOR_FOCUS': {
      // Restore the workflow-editor tab/window to foreground after
      // a provider-tab submit fires. Called by the runner on the
      // opt-in `restore-editor-after-submit` policy; default
      // `provider-during-node` never reaches this code path. We
      // never close / navigate / minimize — only `tabs.update(active)`
      // + `windows.update(focused)` on the editor origin. Defensive
      // checks ensure we never restore a tab that has been closed
      // since capture.
      const payload = (message.payload || {}) as {
        nodeId?: string
        provider?: string
      }
      const nodeId = String(payload.nodeId || '')
      const provider = String(payload.provider || '')
      const editorRef = await readStoredWorkflowEditorIds()
      const editorTabId = Array.from(editorRef.tabIds)[0]
      const editorWindowId = Array.from(editorRef.windowIds)[0]
      console.log('[Workflow][EditorFocus] restoreStart', JSON.stringify({
        nodeId,
        provider,
        tabId: editorTabId ?? null,
        windowId: editorWindowId ?? null,
      }))
      if (editorTabId === undefined || editorWindowId === undefined) {
        console.log('[Workflow][EditorFocus] restoreSkipped', JSON.stringify({
          reason: 'no-stored-editor-origin',
          nodeId,
          provider,
        }))
        return { success: false, error: 'No stored workflow editor origin' }
      }
      // Confirm the tab + window still exist before restoring. The
      // user might have closed the editor while a workflow was
      // running; that's their right, but we MUST NOT attempt to
      // chrome.tabs.update a dead tabId (it throws).
      let liveTab: chrome.tabs.Tab | null = null
      try {
        liveTab = await chrome.tabs.get(editorTabId)
      } catch {
        liveTab = null
      }
      if (!liveTab) {
        console.log('[Workflow][EditorFocus] restoreSkipped', JSON.stringify({
          reason: 'editor-tab-no-longer-exists',
          nodeId,
          provider,
          tabId: editorTabId,
        }))
        // Stale storage — clear it so subsequent restores are quick.
        clearStoredWorkflowEditorIds().catch(() => {})
        return { success: false, error: 'Editor tab no longer exists' }
      }
      try {
        await chrome.tabs.update(editorTabId, { active: true })
        await chrome.windows.update(editorWindowId, { focused: true })
        console.log('[Workflow][EditorFocus] restored', JSON.stringify({
          nodeId,
          provider,
          tabId: editorTabId,
          windowId: editorWindowId,
          url: liveTab.url || '',
        }))
        return { success: true, tabId: editorTabId, windowId: editorWindowId }
      } catch (err) {
        console.log('[Workflow][EditorFocus] restoreSkipped', JSON.stringify({
          reason: 'tab-or-window-update-failed',
          nodeId,
          provider,
          tabId: editorTabId,
          windowId: editorWindowId,
          error: (err as Error).message,
        }))
        return { success: false, error: (err as Error).message }
      }
    }

    case 'RUN_FLOW_PROMPT':
      return runFlowPrompt(message.payload as RunFlowPromptPayload, sender.tab?.id)

    case 'RUN_CHATGPT_PROMPT':
      return runChatGPTPrompt(message.payload as ChatGPTPromptPayload)

    case 'GET_CHATGPT_JOB_STATUS':
      return getChatGPTJobStatus(message.payload as { jobId?: string })

    case 'CHATGPT_JOB_PROGRESS': {
      // Heartbeat from the content-script polling loop. We split:
      //   * `lastHeartbeatAt` — bumped on EVERY message (proves the
      //      content script is alive and the message channel works).
      //   * `lastProgressAt`  — bumped ONLY when the payload actually
      //      indicates a generation advance (phase change, spinner
      //      flip, image/turn/text count bump, or an explicit
      //      `progressChanged: true` from the content script).
      //
      // The runner's waitForChatGPTJob uses `lastProgressAt` for the
      // "progress stale" gate and `lastHeartbeatAt` for the dead-tab
      // gate.
      const payload = message.payload as ChatGPTJobProgress & { jobId?: string }
      const jobId = payload?.jobId
      if (!jobId) return { success: false, error: 'jobId required' }
      const now = Date.now()

      const jobs = await chatgptReadJobs()
      const existing = jobs[jobId]
      if (!existing) {
        console.warn('[ChatGPT][Background] job heartbeat for unknown jobId:', jobId)
        return { success: false, error: 'unknown jobId' }
      }

      const prevProgress = isRecordObject(existing.progress) ? existing.progress : null
      const progressChanged =
        payload.progressChanged === true ||
        progressAdvanced(payload, prevProgress)

      const progressPayload: ChatGPTJobProgress = {
        phase: payload.phase,
        generating: payload.generating,
        assistantTurns: payload.assistantTurns,
        candidateImages: payload.candidateImages,
        acceptedImages: payload.acceptedImages,
        hasPendingImage: payload.hasPendingImage,
        elapsedMs: payload.elapsedMs,
        lastAssistantTextLength: payload.lastAssistantTextLength,
        progressChanged,
        lastMessage: payload.lastMessage,
      }

      const patch: Partial<ChatGPTJobState> = {
        lastHeartbeatAt: now,
        progress: progressPayload,
        hasPendingImage: payload.hasPendingImage ? true : undefined,
      }
      // lastProgressAt bumps ONLY on real advance. A heartbeat that
      // carries the same counters / phase as the previous one does
      // not count.
      if (progressChanged) {
        patch.lastProgressAt = now
      }

      const merged = await chatgptUpdateJob(jobId, patch)
      // Per-poll heartbeat log is gated by DEBUG_FLAGS.chatgptHeartbeat.
      // The unconditional lifecycle logs above (job done, persisted,
      // submit sent, etc.) stay visible — only the per-poll heartbeat
      // dump is silenced in default mode to avoid console spam.
      debugLog('chatgptHeartbeat', '[ChatGPT][Background] job heartbeat', {
        jobId,
        phase: payload.phase,
        progressChanged,
        lastHeartbeatAt: now,
        lastProgressAt: progressChanged ? now : (existing.lastProgressAt || null),
        lastProgressDeltaMs: existing.lastProgressAt ? now - existing.lastProgressAt : null,
        generating: payload.generating,
        candidateImages: payload.candidateImages,
        acceptedImages: payload.acceptedImages,
        hasPendingImage: payload.hasPendingImage,
      })
      return { success: true }
    }

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

    case 'FLOW_FETCH_MEDIA_AS_DATA': {
      // Proxy: the runner cannot fetch labs.google URLs from the side
      // panel / service worker (cookie + same-origin context lives in
      // the Flow tab). Forward to flow-content which performs the
      // fetch with credentials and returns bytes (data URL or
      // ArrayBuffer) in-memory.
      return await fetchFlowMediaAsData(message.payload as FlowFetchMediaAsDataPayload)
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
    await rememberWorkflowEditorWindow(windowId, tab?.id ?? null)
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
    const stored = await readStoredWorkflowEditorIds()
    const storedWindowId = Array.from(stored.windowIds)[0]
    if (storedWindowId) {
      return await focusExisting(storedWindowId)
    }
  } catch {
    await clearStoredWorkflowEditorIds()
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
    workflowEditorTabId = win.tabs?.[0]?.id ?? null
    await rememberWorkflowEditorWindow(workflowEditorWindowId, workflowEditorTabId)

    return { success: true, windowId: workflowEditorWindowId ?? undefined }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Per-provider tab configuration lives in src/constants/providerTabs.ts so it
// can be shared with the provider adapters. See that file for the contract:
//   - queryUrl: Chrome match pattern for chrome.tabs.query({ url }) (must end in '/*' for origins)
//   - createUrl: navigable URL for chrome.tabs.create
// Bare origins like 'https://chatgpt.com' are invalid match patterns and would
// throw "Invalid url pattern" at query time.

async function openProviderTab(
  provider: string,
  shouldFocus: boolean = true
): Promise<{ success: boolean; tabId?: number; error?: string }> {
  const config = (PROVIDER_TABS as Record<string, { queryUrl: string; createUrl: string } | undefined>)[provider]
  if (!config) {
    console.log(`[Provider][BG] openProviderTab provider=${provider} error=Unknown provider`)
    return { success: false, error: 'Unknown provider' }
  }
  console.log(`[Provider][BG] openProviderTab provider=${provider} queryUrl=${config.queryUrl} shouldFocus=${shouldFocus}`)

  try {
    const existing = await chrome.tabs.query({ url: config.queryUrl })
    console.log(`[Provider][BG] found existing count=${existing.length}`)
    if (existing.length > 0 && existing[0].id) {
      const tabId = existing[0].id
      if (shouldFocus) {
        await chrome.tabs.update(tabId, { active: true }).catch(() => {})
        const winId = (existing[0] as { windowId?: number }).windowId
        if (winId !== undefined) {
          await chrome.windows.update(winId, { focused: true }).catch(() => {})
        }
        console.log(`[Provider][BG] focused existing tabId=${tabId}`)
      } else {
        console.log(`[Provider][BG] skip focus existing tabId=${tabId} (focus=false)`)
      }
      return { success: true, tabId }
    }

    // No existing provider tab — create one. active=false keeps the
    // user's current tab (Workflow Editor / Side Panel) visible.
    const tab = await chrome.tabs.create({ url: config.createUrl, active: shouldFocus })
    console.log(`[Provider][BG] created tabId=${tab.id} active=${shouldFocus}`)
    return { success: true, tabId: tab.id }
  } catch (err) {
    console.log(`[Provider][BG] openProviderTab provider=${provider} error=${(err as Error).message}`)
    return { success: false, error: (err as Error).message }
  }
}

async function getStoredWorkflowEditorState(): Promise<{
  tabId: number | null
  windowId: number | null
  tab: chrome.tabs.Tab | null
  window: chrome.windows.Window | null
  url: string
  isPopupWindow: boolean
}> {
  const editorRef = await readStoredWorkflowEditorIds()
  const editorTabId = Array.from(editorRef.tabIds)[0] ?? null
  const editorWindowId = Array.from(editorRef.windowIds)[0] ?? null

  let editorTab: chrome.tabs.Tab | null = null
  let editorWindow: chrome.windows.Window | null = null

  if (editorTabId !== null) {
    try {
      editorTab = await chrome.tabs.get(editorTabId)
    } catch {
      editorTab = null
    }
  }

  if (editorWindowId !== null) {
    try {
      editorWindow = await chrome.windows.get(editorWindowId, { populate: true })
    } catch {
      editorWindow = null
    }
  }

  if (!editorTab && editorWindow?.tabs?.length) {
    const editorUrl = chrome.runtime.getURL('tabs/workflow-editor.html')
    editorTab = editorWindow.tabs.find((tab) => {
      const url = String(tab.url || tab.pendingUrl || '')
      return url.startsWith(editorUrl)
    }) || editorWindow.tabs[0] || null
  }

  return {
    tabId: toPositiveNumber(editorTab?.id) ?? editorTabId,
    windowId: toPositiveNumber(editorTab?.windowId) ?? editorWindowId,
    tab: editorTab,
    window: editorWindow,
    url: String(editorTab?.url || editorTab?.pendingUrl || ''),
    isPopupWindow: editorWindow?.type === 'popup',
  }
}

async function logWorkflowEditorVisibility(
  event: 'beforeProviderFocus' | 'afterProviderFocus',
  provider: string,
  providerTabId?: number,
  providerWindowId?: number
): Promise<void> {
  const editor = await getStoredWorkflowEditorState().catch(() => null)
  let providerTab: chrome.tabs.Tab | null = null
  let providerWindow: chrome.windows.Window | null = null

  if (providerTabId !== undefined) {
    try {
      providerTab = await chrome.tabs.get(providerTabId)
    } catch {
      providerTab = null
    }
  }

  const resolvedProviderWindowId = toPositiveNumber(providerWindowId) ?? toPositiveNumber(providerTab?.windowId)
  if (resolvedProviderWindowId !== null) {
    try {
      providerWindow = await chrome.windows.get(resolvedProviderWindowId)
    } catch {
      providerWindow = null
    }
  }

  const editorWindowId = editor?.windowId ?? null
  const payload: Record<string, unknown> = {
    editorTabId: editor?.tabId ?? null,
    editorWindowId,
    editorTabActive: editor?.tab?.active ?? null,
    editorWindowFocused: editor?.window?.focused ?? null,
    editorWindowType: editor?.window?.type ?? null,
    editorUrl: editor?.url ?? '',
    provider,
    providerTabId: providerTabId ?? null,
    providerWindowId: resolvedProviderWindowId,
  }

  if (event === 'afterProviderFocus') {
    payload.providerTabActive = providerTab?.active ?? null
    payload.providerWindowFocused = providerWindow?.focused ?? null
  }

  console.log('[Workflow][EditorVisibility] ' + event, JSON.stringify(payload))

  if (
    editor?.tabId !== null &&
    editorWindowId !== null &&
    resolvedProviderWindowId !== null &&
    editorWindowId === resolvedProviderWindowId
  ) {
    console.warn('[Workflow][EditorVisibility] same_window_conflict', JSON.stringify({
      editorTabId: editor.tabId,
      editorWindowId,
      provider,
      providerTabId: providerTabId ?? null,
      providerWindowId: resolvedProviderWindowId,
      message: 'Workflow Editor is a normal tab in the same window. It cannot stay visible while provider tab is active. Open editor as popup window.',
    }))
  }
}

async function getNormalProviderWindowId(excludedWindowIds: Set<number>): Promise<number | undefined> {
  try {
    const windows = await chrome.windows.getAll()
    const normalWindows = windows.filter((win) => {
      const winId = toPositiveNumber(win.id)
      return win.type === 'normal' && winId !== null && !excludedWindowIds.has(winId)
    })
    const focused = normalWindows.find((win) => win.focused)
    return toPositiveNumber(focused?.id) ?? toPositiveNumber(normalWindows[0]?.id) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Workflow-only provider tab router. Always activates + focuses the
 * window; optionally waits for the per-provider readiness probe.
 *
 * Returns a structured payload so the runner can chain the next
 * action without re-querying chrome.tabs:
 *   {
 *     success: boolean
 *     provider: 'google-flow' | 'chatgpt'
 *     tabId: number
 *     windowId: number
 *     url: string  ← tabs.get(tabId).url AFTER activation
 *     ready: boolean  ← content script responded to provider ping,
 *                       or `true` when `waitReady=false`
 *     activated: boolean  ← whether this call moved the tab forward
 *   }
 *
 * Logging contract: every state transition emits one
 * `[Workflow][ProviderRoute] <event>` line so operators can confirm
 * the routing sequence by greping the BG console only. Event names
 * fixed: `start`, `existingTab`, `createdTab`, `focusedTab`,
 * `ready`. Defensive against unknown providers, missing tabs, and
 * the readiness probe failing — none of those block the rest of
 * the chain. `ready:false` is the signal that the next step
 * (RUN_CHATGPT_PROMPT / RUN_FLOW_PROMPT) must do its own readiness
 * wait.
 */
async function ensureProviderTabForWorkflow(
  provider: string,
  nodeId: string,
  options: {
    waitReady?: boolean
    activate?: boolean
    focusWindow?: boolean
    preserveEditor?: boolean
  } = {}
): Promise<{
  success: boolean
  provider?: string
  tabId?: number
  windowId?: number
  url?: string
  ready?: boolean
  activated?: boolean
  focused?: boolean
  error?: string
}> {
  const waitReady = options.waitReady !== false
  const activate = options.activate === true
  const focusWindow = options.focusWindow === true
  const preserveEditor = options.preserveEditor !== false
  const trace = (event: string, extra: Record<string, unknown> = {}) => {
    console.log('[Workflow][ProviderRoute]', event, JSON.stringify({
      nodeId: nodeId || '(none)',
      provider,
      activate,
      focusWindow,
      preserveEditor,
      tabId: extra.tabId ?? null,
      windowId: extra.windowId ?? null,
      url: extra.url ?? null,
      ready: extra.ready ?? null,
      ...extra,
    }))
  }

  trace('ensureTab')

  const config = (PROVIDER_TABS as Record<string, { queryUrl: string; createUrl: string } | undefined>)[provider]
  if (!config) {
    trace('error', { reason: 'unknown_provider' })
    return { success: false, error: 'Unknown provider: ' + provider }
  }

  // Step 1: find or create the provider tab.
  let tabId: number | undefined
  let windowId: number | undefined
  let url: string | undefined
  let createdNow = false
  try {
    const editorRef = await readStoredWorkflowEditorIds()
    const editorState = await getStoredWorkflowEditorState().catch(() => null)
    const editorTabIds = editorRef.tabIds
    const editorWindowIds = editorRef.windowIds
    const editorPopupWindowIds = new Set<number>()
    if (editorState?.isPopupWindow && editorState.windowId !== null) {
      editorPopupWindowIds.add(editorState.windowId)
    }
    const editorExtensionPrefix = chrome.runtime.getURL('')
    const rawMatches = await chrome.tabs.query({ url: config.queryUrl })
    // Defense-in-depth: filter out any tab whose id / windowId
    // matches the workflow editor origin, OR whose URL resolves to
    // the extension's own pages. In normal flows the URL match
    // pattern (e.g. https://labs.google/fx/*) cannot match the
    // extension URL — Chrome's `chrome.tabs.query` respects URL
    // patterns — but a future constant change, an open chatgpt tab
    // that's been navigated by the user to a debug URL, or a stale
    // popup could in theory collide. Filter rather than mutate so
    // the editor popup is never even touched.
    const candidates = rawMatches.filter((tab) => {
      const tabIdNum = toPositiveNumber(tab.id)
      const windowIdNum = toPositiveNumber(tab.windowId)
      const tabUrl = String(tab.url || tab.pendingUrl || '')
      if (tabIdNum !== null && editorTabIds.has(tabIdNum)) {
        console.log('[Workflow][EditorFocus] preserved', JSON.stringify({
          reason: 'tab-id-matches-editor',
          provider,
          candidateTabId: tabIdNum,
          candidateUrl: tabUrl,
          editorTabId: Array.from(editorTabIds)[0] ?? null,
        }))
        return false
      }
      if (windowIdNum !== null && editorPopupWindowIds.has(windowIdNum)) {
        console.log('[Workflow][EditorFocus] preserved', JSON.stringify({
          reason: 'window-id-matches-editor',
          provider,
          candidateTabId: tabIdNum,
          candidateWindowId: windowIdNum,
          editorWindowId: Array.from(editorWindowIds)[0] ?? null,
        }))
        return false
      }
      if (windowIdNum !== null && editorWindowIds.has(windowIdNum)) {
        console.warn('[Workflow][EditorVisibility] same_window_conflict', JSON.stringify({
          editorTabId: Array.from(editorTabIds)[0] ?? null,
          editorWindowId: windowIdNum,
          provider,
          providerTabId: tabIdNum,
          providerWindowId: windowIdNum,
          message: 'Workflow Editor is a normal tab in the same window. It cannot stay visible while provider tab is active. Open editor as popup window.',
        }))
      }
      if (tabUrl.startsWith(editorExtensionPrefix)) {
        console.log('[Workflow][EditorFocus] preserved', JSON.stringify({
          reason: 'extension-url-match',
          provider,
          candidateTabId: tabIdNum,
          candidateUrl: tabUrl,
        }))
        return false
      }
      return true
    })
    if (candidates.length > 0 && candidates[0].id) {
      tabId = candidates[0].id
      windowId = (candidates[0] as { windowId?: number }).windowId
      url = candidates[0].url || candidates[0].pendingUrl || ''
      trace('existingTab', {
        tabId,
        windowId,
        url,
        rejectedEditorMatches: rawMatches.length - candidates.length,
      })
    } else {
      const targetWindowId = await getNormalProviderWindowId(editorPopupWindowIds)
      let created: chrome.tabs.Tab
      if (targetWindowId !== undefined) {
        created = await chrome.tabs.create({
          url: config.createUrl,
          active: false,
          windowId: targetWindowId
        })
      } else {
        const createdWindow = await chrome.windows.create({
          url: config.createUrl,
          type: 'normal',
          focused: false
        })
        const firstTab = createdWindow.tabs?.[0]
        if (!firstTab) throw new Error('Provider window created without a tab')
        created = firstTab
      }
      tabId = created.id
      windowId = created.windowId
      url = created.url || created.pendingUrl || config.createUrl
      createdNow = true
      trace(activate ? 'createdTab' : 'createdBackgroundTab', { tabId, windowId, url })
    }
  } catch (err) {
    trace('error', { reason: 'tab_query_or_create_failed', error: (err as Error).message })
    return { success: false, error: (err as Error).message }
  }

  if (!tabId) {
    trace('error', { reason: 'tab_id_missing_after_query' })
    return { success: false, error: 'Failed to obtain tabId' }
  }

  // Step 2: re-fetch the tab to see the final URL and current active
  // state. Newly-created tabs can have `pendingUrl` while still
  // loading; this also catches the rare case the user closed the tab
  // between query and update.
  let finalTab: chrome.tabs.Tab | undefined
  try {
    finalTab = await chrome.tabs.get(tabId)
    url = finalTab.url || url || config.createUrl
    windowId = finalTab.windowId ?? windowId
  } catch (err) {
    trace('error', { reason: 'tab_get_failed', error: (err as Error).message })
    return { success: false, error: (err as Error).message }
  }

  await logWorkflowEditorVisibility('beforeProviderFocus', provider, tabId, windowId).catch(() => {})

  // Step 3: activate the tab + focus the window. Workflow contract
  // is "always focus" — the user's window otherwise stays on the
  // previous provider's tab (Flow tab during a Flow→ChatGPT chain,
  // ChatGPT tab during a ChatGPT→Flow chain), which is exactly the
  // bug this helper fixes.
  let activated = false
  if (activate || focusWindow) {
    try {
      if (activate) {
        await chrome.tabs.update(tabId, { active: true })
      }
      if (focusWindow && windowId !== undefined) {
        await chrome.windows.update(windowId, { focused: true })
      }
      activated = activate
      if (activate && !focusWindow) {
        trace('activatedTabNoWindowFocus', {
          tabId,
          windowId,
          reason: provider === 'chatgpt' && preserveEditor
            ? 'chatgpt-needs-active-tab-but-preserve-editor'
            : 'activate-without-window-focus',
        })
      } else {
        trace('focusedTab', { tabId, windowId })
      }
    } catch (err) {
    // Tabs in special windows (e.g. chrome://-only) cannot be
    // activated — log and continue. Subsequent RUN_*_PROMPT paths
    // will still send the message to the right tabId.
      trace('focusedTab', { tabId, windowId, warn: (err as Error).message })
    }

  } else {
    trace('noActivate', {
      tabId,
      windowId,
      reason: preserveEditor ? 'workflow-editor-preservation' : 'activate-false',
    })
  }

  await logWorkflowEditorVisibility('afterProviderFocus', provider, tabId, windowId).catch(() => {})

  // Step 4: optional readiness probe. Per-provider:
  //   - chatgpt → CHATGPT_PING via chrome.tabs.sendMessage (the
  //     listener comes from the generic content-script.ts).
  //   - google-flow → MAIN-world flow bridge probe via
  //     executeScript + BridgePingRaw probe (cheap, no extra
  //     injection). runFlowPrompt below will do its own
  //     waitBridgeReady anyway, so this is best-effort.
  // When `waitReady === false`, we skip the probe entirely.
  let ready = false
  if (waitReady) {
    try {
      if (provider === 'chatgpt') {
        // The generic content-script already exposes CHATGPT_PING
        // on chatgpt.com (verified at runtime via sendMessage).
        const ping = await chrome.tabs
          .sendMessage(tabId, { action: 'CHATGPT_PING' })
          .catch(() => null)
        ready = !!(ping && (ping as { success?: boolean }).success !== false)
        if (!ready && activate) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          try {
            await ensureChatGPTContentReady(tabId)
            ready = true
          } catch (readyErr) {
            ready = false
            trace('chatgptReadyAfterActivate', {
              ready,
              tabId,
              warn: (readyErr as Error).message,
            })
          }
        }
        if (activate) {
          trace('chatgptReadyAfterActivate', { ready, tabId })
        }
        // Treat absence-of-listener as "not ready" but do not fail.
      } else if (provider === 'google-flow') {
        const probe = await pingFlowBridgeViaMainWorld(tabId).catch(() => null)
        ready = !!(probe && (probe as { bridgeReady?: boolean }).bridgeReady === true)
      }
      trace('ready', { ready, tabId })
    } catch (err) {
      trace('ready', { ready: false, tabId, warn: (err as Error).message })
    }
  } else {
    ready = true
  }

  return {
    success: true,
    provider,
    tabId,
    windowId,
    url,
    ready,
    activated,
    focused: focusWindow,
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
const CHATGPT_JOB_TTL_MS = 30 * 60 * 1000 // Long ChatGPT jobs stay alive while heartbeat/progress is active
const CHATGPT_DEDUPE_FLIGHT_TTL_MS = 5 * 1000

type ChatGPTPromptStartResult = {
  success: boolean
  accepted?: boolean
  jobId?: string
  error?: string
  deduped?: boolean
}

const chatgptSubmitFlights = new Map<string, Promise<ChatGPTPromptStartResult>>()

interface ChatGPTJobState {
  status: 'running' | 'done' | 'failed'
  startedAt: number
  finishedAt?: number
  promptPreview: string
  autoDownload: boolean
  outputFolder?: string
  imageUrls: string[]
  images?: ChatGPTGeneratedImage[]
  downloaded: number
  error: string
  message?: string
  tabId?: number
  requestFingerprint?: string
  /** Wall-clock at the moment the most recent CHATGPT_JOB_PROGRESS
   *  message was received — set unconditionally on every heartbeat.
   *  Used by the runner to detect a dead content script (no
   *  heartbeats in 30-45s = extension context lost or tab crashed). */
  lastHeartbeatAt?: number
  /** Wall-clock at the moment the content script last reported a
   *  REAL generation advance (phase change, count change, spinner
   *  flip, etc.). Heartbeats alone do NOT bump this. Used by the
   *  runner to detect that the generation itself has stalled. */
  lastProgressAt?: number
  progress?: ChatGPTJobProgress
  /** Set true when content script detected a partial image render that
   *  never completed within the polling window. The runner reads this
   *  to skip node-level retry even when the error is "TIMEOUT" — uploading
   *  again would create duplicate attachments. */
  hasPendingImage?: boolean
}

interface ChatGPTGeneratedImage {
  mediaType?: 'image'
  data?: string
  url?: string
  name?: string
  mimeType?: string
  source?: string
  aspectRatio?: string
}

interface ChatGPTJobProgress {
  phase?: 'pre_upload' | 'uploading' | 'submitting' | 'waiting_result' | 'generating' | 'rendering' | 'done' | 'failed'
  generating?: boolean
  assistantTurns?: number
  candidateImages?: number
  acceptedImages?: number
  hasPendingImage?: boolean
  elapsedMs?: number
  lastAssistantTextLength?: number
  /** True when the content script considers this heartbeat to
   *  represent a real generation advance — phase change, spinner
   *  flip, count bump, etc. The runner's waitForChatGPTJob uses
   *  this to decide whether to bump `lastProgressAt`. */
  progressChanged?: boolean
  lastMessage?: string
}

interface ChatGPTPromptPayload {
  prompt: string
  ratio?: string
  fallbackPrefix?: string
  autoDownload: boolean
  outputFolder?: string
  timeoutMs?: number
  mediaUploads?: Array<{ name?: string; type?: string; base64?: string }>
  tabId?: number
  /** When false, do not focus the ChatGPT tab — keep the caller's tab visible. */
  focus?: boolean
  activateTab?: boolean
  focusWindow?: boolean
  /** Workflow runner sets this to avoid stealing focus from the editor. */
  preserveEditor?: boolean
  source?: string
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

function chatgptHashString(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x45d9f3b
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = (h1 ^ (h1 >>> 16)) >>> 0
  h2 = (h2 ^ (h2 >>> 16)) >>> 0
  return h1.toString(36) + h2.toString(36)
}

function chatgptBuildRequestFingerprint(payload: ChatGPTPromptPayload): string {
  const mediaUploads = Array.isArray(payload.mediaUploads) ? payload.mediaUploads : []
  const mediaSignatures = mediaUploads.map((media, index) => {
    const base64 = typeof media?.base64 === 'string' ? media.base64 : ''
    return {
      index,
      type: typeof media?.type === 'string' ? media.type : '',
      size: base64.length,
      head: base64.slice(0, 96),
      tail: base64.slice(-96),
    }
  })
  const signature = JSON.stringify({
    prompt: typeof payload.prompt === 'string' ? payload.prompt.trim() : '',
    ratio: payload.ratio || '',
    fallbackPrefix: payload.fallbackPrefix || '',
    autoDownload: !!payload.autoDownload,
    outputFolder: payload.outputFolder || '',
    mediaUploads: mediaSignatures,
  })
  return chatgptHashString(signature)
}

async function chatgptFindRunningJobByFingerprint(
  requestFingerprint: string
): Promise<{ jobId: string; job: ChatGPTJobState } | null> {
  const jobs = await chatgptReadJobs()
  const now = Date.now()
  for (const [jobId, job] of Object.entries(jobs)) {
    if (
      job.requestFingerprint === requestFingerprint &&
      job.status === 'running' &&
      now - job.startedAt < CHATGPT_JOB_TTL_MS
    ) {
      return { jobId, job }
    }
  }
  return null
}

function chatgptRememberSubmitFlight(
  requestFingerprint: string,
  promise: Promise<ChatGPTPromptStartResult>
): void {
  chatgptSubmitFlights.set(requestFingerprint, promise)
  promise.finally(() => {
    setTimeout(() => {
      if (chatgptSubmitFlights.get(requestFingerprint) === promise) {
        chatgptSubmitFlights.delete(requestFingerprint)
      }
    }, CHATGPT_DEDUPE_FLIGHT_TTL_MS)
  }).catch(() => {})
}

// Narrow a value to a plain object record. Used by the heartbeat
// path to compare current and previous progress payloads.
function isRecordObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object') return null
  return v as Record<string, unknown>
}

// Compare a fresh heartbeat to the previous one and decide whether
// the generation has actually advanced. A heartbeat that reports
// the same counters / phase / spinner state as the prior one does
// NOT bump lastProgressAt — heartbeats alone prove liveness, not
// advance. The function returns true if any of the watched fields
// changed in a direction that indicates progress.
function progressAdvanced(
  next: { phase?: string; generating?: boolean; assistantTurns?: number; candidateImages?: number; acceptedImages?: number; hasPendingImage?: boolean; lastAssistantTextLength?: number },
  prev: Record<string, unknown> | null
): boolean {
  if (!prev) {
    // First heartbeat — treat as a real advance so the runner can
    // transition out of the "no progress yet" gate as soon as the
    // content script registers that it has entered the polling
    // phase. This prevents the runner from failing a job whose only
    // heartbeat arrived after the initial no-progress budget had
    // already elapsed (storage write race).
    return true
  }
  const phaseNow = typeof next.phase === 'string' ? next.phase : null
  const phasePrev = typeof prev.phase === 'string' ? prev.phase : null
  if (phaseNow && phasePrev && phaseNow !== phasePrev) return true
  // Phase appeared for the first time (e.g. undefined → 'waiting_result').
  if (phaseNow && !phasePrev) return true
  const genNow = !!next.generating
  const genPrev = !!prev.generating
  // Spinner turning on is a real advance.
  if (genNow && !genPrev) return true
  const turnsNow = Number(next.assistantTurns) || 0
  const turnsPrev = Number(prev.assistantTurns) || 0
  if (turnsNow > turnsPrev) return true
  const candNow = Number(next.candidateImages) || 0
  const candPrev = Number(prev.candidateImages) || 0
  if (candNow > candPrev) return true
  const accNow = Number(next.acceptedImages) || 0
  const accPrev = Number(prev.acceptedImages) || 0
  if (accNow > accPrev) return true
  const pendNow = !!next.hasPendingImage
  const pendPrev = !!prev.hasPendingImage
  if (pendNow && !pendPrev) return true
  const textNow = Number(next.lastAssistantTextLength) || 0
  const textPrev = Number(prev.lastAssistantTextLength) || 0
  if (textNow > textPrev) return true
  return false
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
  const payload = (msg as {
    payload?: {
      success: boolean
      imageUrls?: string[]
      images?: ChatGPTGeneratedImage[]
      error?: string
      message?: string
    }
  }).payload
  const jobs = await chatgptReadJobs()
  const job = jobs[jobId]
  if (!job) {
    console.log('[ChatGPT][Background] CHATGPT_JOB_DONE for unknown/expired jobId:', jobId)
    return
  }

  if (!payload || !payload.success) {
    // [SeqDebug][BG] job done (failure path) — gated by DEBUG_FLAGS.seq.
    // Lets us see the exact error string (e.g. "CHATGPT_SUBMIT_FAILED:
    // duplicate attachments detected") reaching the BG so we can
    // correlate with content-script logs.
    try {
      debugLog('seq', '[SeqDebug][BG] job done (failure path)', {
        jobId,
        success: false,
        imageUrlsCount: 0,
        imagesCount: 0,
        error: payload?.error || 'ChatGPT job failed',
      })
    } catch (_) {}
    await chatgptUpdateJob(jobId, {
      status: 'failed',
      error: payload?.error || 'ChatGPT job failed',
      message: payload?.message,
      finishedAt: Date.now(),
    })
    return
  }

  const imageUrls = payload.imageUrls || []
  const images = Array.isArray(payload.images)
    ? payload.images.filter((image) => image && (image.data || image.url))
    : imageUrls.map((url) => ({
        mediaType: 'image' as const,
        url,
        source: 'chatgpt',
        mimeType: 'image/png',
      }))
  console.log('[ChatGPT][Background] job done — image count:', imageUrls.length)

  // [SeqDebug][BG] job done — gated by DEBUG_FLAGS.seq.
  // Captures the exact terminal state of the job (success/failure +
  // imageUrls count + error string) so we can correlate content-script
  // duplicate-detected failures back to the BG-side payload.
  try {
    debugLog('seq', '[SeqDebug][BG] job done', {
      jobId,
      success: !!(payload && payload.success),
      imageUrlsCount: imageUrls.length,
      imagesCount: images.length,
      error: payload?.error || '',
    })
  } catch (_) {}

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
    images,
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
// the path.
//
// IMPORTANT: We must pick the entry whose JS file starts with
// `content-script.` — NOT any <all_urls>-matching entry. Other <all_urls>
// entries exist in the manifest (debug-bridge.ed396080.js, flow-debug.*.js)
// and the previous resolver returned the FIRST match, which happened to be
// debug-bridge — the wrong bundle.
//
// Returns null if no entry matches — caller should treat that as a fatal
// configuration error.
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
      if (!covers) continue
      var js = entry.js || []
      for (var j = 0; j < js.length; j++) {
        // Pick the entry whose primary JS file is the generic content
        // script bundle. Excludes debug-bridge, flow-debug,
        // flow-content, and flow-slate-bridge.
        if (js[j].indexOf('content-script.') === 0) return js[j]
      }
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

  for (var prePingI = 0; prePingI < 3; prePingI++) {
    try {
      var existingPong = await chrome.tabs.sendMessage(tabId, { action: 'CHATGPT_PING' })
      if (existingPong && existingPong.success) {
        console.log('[ChatGPT][Background] content ping ok before inject provider=' + (existingPong.provider || 'unknown'))
        return
      }
    } catch (_) {
      // Listener is not attached yet. We will inject below.
    }
    await new Promise(function (r) { setTimeout(r, 200) })
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
): Promise<ChatGPTPromptStartResult> {
  const requestFingerprint = chatgptBuildRequestFingerprint(payload)
  const existingFlight = chatgptSubmitFlights.get(requestFingerprint)
  if (existingFlight) {
    const result = await existingFlight
    if (result.success && result.jobId) {
      console.warn('[ChatGPT][Background] duplicate submit coalesced to in-flight job:', result.jobId)
      return { ...result, deduped: true }
    }
    return result
  }

  const flight = runChatGPTPromptLocked(payload, requestFingerprint)
  chatgptRememberSubmitFlight(requestFingerprint, flight)
  return flight
}

async function runChatGPTPromptLocked(
  payload: ChatGPTPromptPayload,
  requestFingerprint: string
): Promise<ChatGPTPromptStartResult> {
  console.log('[ChatGPT][Background] runChatGPTPrompt called, prompt len:', payload.prompt?.length)

  // [SeqDebug][BG] chatgpt prompt payload — gated by DEBUG_FLAGS.seq.
  // Surfaces the count + fingerprints of mediaUploads at the BG
  // boundary, plus the set of already-stored jobIds, so we can verify
  // nothing leaks across jobs.
  try {
    const existingJobs = await chatgptReadJobs()
    const mediaUploads = Array.isArray(payload.mediaUploads) ? payload.mediaUploads : []
    const fingerprints = mediaUploads.map((m) => {
      const base64 = typeof m?.base64 === 'string' ? m.base64 : ''
      return 'd[' + base64.length + ']:' + base64.slice(0, 64)
    })
    debugLog('seq', '[SeqDebug][BG] chatgpt prompt payload', {
      requestFingerprint,
      mediaUploadsCount: mediaUploads.length,
      fingerprints,
      previousJobIdsInStore: Object.keys(existingJobs),
    })
  } catch (_) {}

  const runningDuplicate = await chatgptFindRunningJobByFingerprint(requestFingerprint)
  if (runningDuplicate) {
    console.warn('[ChatGPT][Background] duplicate submit reused running job:', runningDuplicate.jobId)
    return {
      success: true,
      accepted: true,
      jobId: runningDuplicate.jobId,
      deduped: true,
    }
  }

  // 1. Find or create ChatGPT tab (reuse existing helper).
  // Default behavior focuses the tab (GenPanel). Workflow-run
  // callers pass focus:false so the user's tab stays visible.
  const routedTabId = toPositiveNumber(payload.tabId)
  const shouldUseRoutedTab = payload.preserveEditor === true && routedTabId !== null
  const shouldFocusChatGPT = payload.preserveEditor === true ? false : payload.focus !== false
  let tabId: number

  if (shouldUseRoutedTab) {
    tabId = routedTabId
    if (payload.activateTab === true) {
      await chrome.tabs.update(tabId, { active: true }).catch(() => {})
    }
  } else {
    const opened = await openProviderTab('chatgpt', shouldFocusChatGPT)
    if (!opened.success || !opened.tabId) {
      return { success: false, error: opened.error || 'Failed to open ChatGPT tab' }
    }
    tabId = opened.tabId
  }

  if (payload.preserveEditor === true) {
    console.log('[Workflow][ProviderRoute] chatgptNoFocus', JSON.stringify({
      tabId,
      reusedRoutedTab: shouldUseRoutedTab,
      activateTab: payload.activateTab === true,
      reason: 'workflow-editor-preservation',
    }))
  }
  console.log('[ChatGPT][Background] tab resolved tabId=' + tabId + ' focused=' + shouldFocusChatGPT)

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
    images: [],
    downloaded: 0,
    error: '',
    tabId,
    requestFingerprint,
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
        fallbackPrefix: payload.fallbackPrefix,
        autoDownload: payload.autoDownload,
        timeoutMs,
        jobId,
        // mediaUploads is optional; workflow Generate Node sends it so the
        // content script can attach reference images before submitting the
        // prompt. The adapter path was removed because its manual
        // executeScript('content-scripts/content-script.js') referenced a
        // file that does not exist in the built extension.
        mediaUploads: Array.isArray(payload.mediaUploads) ? payload.mediaUploads : [],
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

// Workflow-output direct download. Routed through the SW so:
//   1. `chrome.downloads` only has to exist in one place.
//   2. The browser uses the extension's profile cookies (Flow
//      asset URLs are signed cookies that the sidepanel can fetch
//      via the same mechanism).
//   3. We can normalize a path-relative `/fx/...` URL against the
//      Flow origin before passing it to chrome.downloads.
// Owner: shared (Workflow UI only — not Flow or ChatGPT runtime).
async function downloadWorkflowOutput(
  payload: { url: string; filename?: string }
): Promise<{ success: boolean; downloadId?: number; error?: string; url?: string }> {
  const raw = String(payload?.url || '').trim()
  if (!raw) {
    return { success: false, error: 'OUTPUT_DOWNLOAD_URL_MISSING' }
  }
  let normalized = raw
  try {
    // Repair relative paths against the Flow origin so the SW hands
    // chrome.downloads an absolute https URL.
    if (/^\/(fx|tools)\//.test(normalized)) {
      normalized = 'https://labs.google' + normalized
    } else if (/^\/\//.test(normalized)) {
      normalized = 'https:' + normalized
    }
  } catch (_) {
    // ignore — chrome.downloads.download will surface the error.
  }
  if (!/^https?:\/\//i.test(normalized)) {
    return { success: false, error: 'OUTPUT_DOWNLOAD_URL_INVALID', url: normalized }
  }

  const suggestedFilename = String(payload?.filename || 'flow-output.png').replace(/[\\/:*?"<>|]/g, '_')
  try {
    const downloadId = await new Promise<number>((resolve, reject) => {
      chrome.downloads.download(
        {
          url: normalized,
          filename: suggestedFilename,
          saveAs: false,
          conflictAction: 'uniquify',
        },
        (id) => {
          const err = chrome.runtime.lastError
          if (err || !id) {
            reject(new Error(err?.message || 'chrome.downloads.download returned no id'))
          } else {
            resolve(id)
          }
        }
      )
    })
    return { success: true, downloadId, url: normalized }
  } catch (err) {
    return { success: false, error: (err as Error).message, url: normalized }
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
  preserveEditor?: boolean
  source?: string
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

interface FlowFetchMediaAsDataPayload {
  url: string
  maxBytes?: number
  asArrayBuffer?: boolean
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

  // FLOW_UPLOAD_IMAGES only requires the flow-content onMessage listener
  // to be attached — it does not need the bridge. The previous bridge
  // ping is not a reliable proxy for "content script listener is alive"
  // (the bridge handshake is async and can complete before or after
  // the listener registration). Add a direct content ping with retry
  // to avoid "Could not establish connection. Receiving end does not
  // exist." when the listener hasn't been wired yet.
  for (let pingI = 0; pingI < 10; pingI++) {
    let contentPong: Record<string, unknown> | null = null
    try {
      contentPong = await chrome.tabs.sendMessage(tabId, { action: 'FLOW_CONTENT_PING' })
    } catch (_) { /* not yet */ }
    if (contentPong && (contentPong as { success?: boolean }).success) {
      break
    }
    await new Promise(function (r) { setTimeout(r, 300) })
    if (pingI === 9) {
      const err = 'Flow content script not ready after FLOW_CONTENT_PING retry'
      console.error('[Background][FLOW_UPLOAD_IMAGE_RESULT]', JSON.stringify({ key: payload.key, success: false, error: err }))
      return { success: false, key: payload.key, error: err }
    }
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

// FLOW_FETCH_MEDIA_AS_DATA — proxy.
//
// Why this exists:
//   The runner (workflow pipeline) needs to forward Flow's output
//   media bytes to downstream Generate/Media nodes for re-upload.
//   Flow's CDN URLs (`https://labs.google/fx/api/trpc/...`) require
//   Flow's auth cookie + same-origin context, which only the Flow
//   tab has. From the side panel / service worker, fetch() reports
//   ERR_FILE_NOT_FOUND on a path-relative URL and is missing
//   credentials on a fully qualified URL.
//
//   This proxy asks the Flow tab's flow-content script to perform
//   the fetch on our behalf. The result is returned in-memory as a
//   data URL (default) or ArrayBuffer (`asArrayBuffer: true`). We
//   never persist the bytes to chrome.storage — the caller's intent
//   is to forward them to an uploader / next-node, not to retain
//   them across SW wake-ups.
//
// Inputs:
//   payload.url           — absolute https://labs.google/... URL.
//                           Relative URLs are rejected (the runner
//                           is expected to ship absolute URLs).
//   payload.maxBytes      — cap. Default 25 MB. 0 = no cap.
//   payload.asArrayBuffer — if true, return ArrayBuffer instead of
//                            data URL.
//
// Output:
//   { success, dataUrl?, arrayBuffer?, mimeType, byteLength, url, error? }
async function fetchFlowMediaAsData(payload: FlowFetchMediaAsDataPayload): Promise<Record<string, unknown>> {
  if (!payload || typeof payload.url !== 'string' || !payload.url) {
    return { success: false, error: 'FLOW_FETCH_MEDIA_AS_DATA: url is required' }
  }
  console.log('[FlowTrace][BG] FLOW_FETCH_MEDIA_AS_DATA_START', JSON.stringify({
    url: payload.url,
    maxBytes: payload.maxBytes || (25 * 1024 * 1024),
    asArrayBuffer: payload.asArrayBuffer === true,
  }))

  // Find the Flow tab. We do NOT auto-create one — the caller
  // (workflow runner) has already opened it as part of the Generate
  // node execution. If the tab is missing we surface a clear error.
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/fx/*' })
  const flowTab = tabs.find(t => typeof t.url === 'string' && t.url.indexOf('labs.google/fx') !== -1)
  if (!flowTab || !flowTab.id) {
    console.error('[FlowTrace][BG] FLOW_FETCH_MEDIA_AS_DATA_NO_TAB', JSON.stringify({ url: payload.url }))
    return { success: false, error: 'No Flow tab found for FLOW_FETCH_MEDIA_AS_DATA', url: payload.url }
  }
  const tabId = flowTab.id

  // Defensive ping to make sure the flow-content onMessage listener is
  // attached before we fire the request. Mirrors the FLOW_UPLOAD_IMAGE
  // path's pre-flight ping.
  try {
    let contentReady = false
    for (let attempt = 0; attempt < 5 && !contentReady; attempt++) {
      try {
        const ping = await chrome.tabs.sendMessage(tabId, { action: 'FLOW_CONTENT_PING' }) as { success?: boolean } | undefined
        if (ping && ping.success) { contentReady = true; break }
      } catch (_) {
        // Receiving end does not exist / context invalidated — wait and retry.
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    if (!contentReady) {
      return { success: false, error: 'FLOW_FETCH_MEDIA_AS_DATA: flow content script not ready', url: payload.url }
    }
  } catch (e) {
    return { success: false, error: 'FLOW_FETCH_MEDIA_AS_DATA ping failed: ' + ((e as Error).message || String(e)), url: payload.url }
  }

  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      action: 'FLOW_FETCH_MEDIA_AS_DATA',
      payload: {
        url: payload.url,
        maxBytes: typeof payload.maxBytes === 'number' ? payload.maxBytes : 25 * 1024 * 1024,
        asArrayBuffer: payload.asArrayBuffer === true,
      }
    }) as Record<string, unknown> | undefined
    if (!result || result.success !== true) {
      const err = (result && (result.error as string)) || 'unknown error'
      console.error('[FlowTrace][BG] FLOW_FETCH_MEDIA_AS_DATA_FAIL', JSON.stringify({ url: payload.url, error: err }))
      return {
        success: false,
        error: err,
        url: payload.url,
        byteLength: (result && (result.byteLength as number)) || 0,
      }
    }
    console.log('[FlowTrace][BG] FLOW_FETCH_MEDIA_AS_DATA_OK', JSON.stringify({
      url: payload.url,
      mimeType: result.mimeType,
      byteLength: result.byteLength,
    }))
    return result
  } catch (e) {
    const err = 'FLOW_FETCH_MEDIA_AS_DATA sendMessage failed: ' + ((e as Error).message || String(e))
    console.error('[FlowTrace][BG] FLOW_FETCH_MEDIA_AS_DATA_FAIL', JSON.stringify({ url: payload.url, error: err }))
    return { success: false, error: err, url: payload.url }
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

  // ── FlowTrace: BG entry ───────────────────────────────────────────────
  console.log('[FlowTrace][BG] RUN_FLOW_PROMPT_RECEIVED ' + JSON.stringify({
    mode: payload.mode,
    model: payload.model,
    ratio: payload.aspectRatio,
    quantity: payload.quantity,
    duration: payload.duration || '',
    autoDownload: payload.autoDownload,
    outputFolder: payload.outputFolder || '',
    fileIdsCount: (payload.fileIds || []).length,
    promptLen: payload.prompt?.length || 0,
    senderTabId: senderTabId,
    payloadTabId: payload.tabId,
  }))

  let tabId = payload.tabId || senderTabId
  if (!tabId) {
    tabId = await findOrOpenFlowTab()
    if (!tabId) {
      console.error('[FlowTrace][Fail] ' + JSON.stringify({
        step: 'BG.tabId',
        reason: 'FLOW_TAB_NOT_FOUND',
        rawResult: null,
        payloadSummary: { mode: payload.mode, model: payload.model, quantity: payload.quantity },
      }))
      return { success: false, error: 'Could not find or open Flow tab' }
    }
  }
  // Log tab URL so we can detect stale / wrong tab
  try {
    const tabInfo = await chrome.tabs.get(tabId).catch(() => null)
    console.log('[FlowTrace][BG] TAB_RESOLVED tabId=' + tabId + ' url=' + (tabInfo?.url || 'unknown') + ' title=' + (tabInfo?.title || 'unknown') + ' senderTabId=' + senderTabId + ' payloadTabId=' + payload.tabId)
  } catch (_) {
    console.log('[FlowTrace][BG] TAB_RESOLVED tabId=' + tabId + ' url=<unknown> senderTabId=' + senderTabId + ' payloadTabId=' + payload.tabId)
  }

  try {
    // ── Step 1: Multi-layer bridge readiness probe ───────────────────────
    // Layer A: MAIN-world probe (pingFlowBridgeViaMainWorld) reads markers
    //          and postMessage pings the bridge directly. Bypasses any
    //          content script listener race entirely.
    // Layer B: content-script ping (chrome.tabs.sendMessage FLOW_INJECT_BRIDGE)
    //          — now that content-script.ts defers FLOW_* actions, this
    //          listener-race winner is flow-content.ts. Used as a fallback
    //          if the MAIN-world probe times out (e.g. sandbox restriction
    //          on executeScript).
    // Layer C: send RUN_FLOW_PROMPT directly. flow-content.ts's
    //          runFlowPrompt internally calls waitBridgeReady (which polls
    //          bridgeCall('ping') up to 10s) — this can recover if the
    //          bridge is loading but not yet ready at probe time.
    //
    // Soft-fail: even if all three layers report not-ready, we DO NOT
    // abort here. Instead we log the failure and fall through to send
    // RUN_FLOW_PROMPT directly. The content script's own waitBridgeReady
    // (10s timeout, polls every 500ms) is the last line of defense.
    console.log('[FlowTrace][BG] PING_BRIDGE_START tabId=' + tabId)
    var pingResult = await pingFlowBridgeViaMainWorld(tabId)
    console.log('[FlowTrace][BG] PING_BRIDGE_RAW ' + JSON.stringify({
      tabId: tabId,
      pingResult: pingResult,
      responseRaw: pingResult,
      layer: 'MAIN_world_probe',
    }))
    if (BG_DEBUG) console.log('[Background] Bridge check response:', pingResult)
    var bridgeLoaded = pingResult?.bridgeLoaded === true && pingResult?.bridgeReady === true

    // Layer B: try content-script FLOW_INJECT_BRIDGE if MAIN probe reports
    // the bridge is loaded but not yet ready (timing race on first paint).
    if (pingResult?.bridgeLoaded === true && pingResult?.bridgeReady !== true) {
      console.log('[FlowTrace][BG] PING_BRIDGE_TRY_CONTENT_SCRIPT tabId=' + tabId)
      try {
        const csResult = await chrome.tabs.sendMessage(tabId, { action: 'FLOW_INJECT_BRIDGE' }).catch(function () { return null })
        console.log('[FlowTrace][BG] PING_BRIDGE_CONTENT_SCRIPT_RAW ' + JSON.stringify({
          tabId: tabId,
          csResult: csResult,
          responseRaw: csResult,
          layer: 'content_script_ping',
        }))
        if (csResult?.bridgeReady === true) {
          bridgeLoaded = true
          console.log('[FlowTrace][BG] BRIDGE_READY_VIA_CONTENT_SCRIPT_PING')
        }
      } catch (e) {
        console.log('[FlowTrace][BG] PING_BRIDGE_CONTENT_SCRIPT_ERROR error=' + (e as Error)?.message)
      }
    }

    if (!bridgeLoaded) {
      if (BG_DEBUG) console.log('[Background] Bridge not ready, injecting scripts...')
      const scripts = await getFlowScriptFiles()
      if (!scripts.content) {
        console.error('[FlowTrace][Fail] ' + JSON.stringify({
          step: 'BG.injectScripts',
          reason: 'FLOW_SCRIPTS_NOT_FOUND',
          rawResult: null,
        }))
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
        console.error('[FlowTrace][Fail] ' + JSON.stringify({
          step: 'BG.injectContent',
          reason: 'FLOW_CONTENT_INJECTION_FAILED',
          rawResult: { message: (e as Error).message },
        }))
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
          console.error('[FlowTrace][Fail] ' + JSON.stringify({
            step: 'BG.injectBridge',
            reason: 'FLOW_BRIDGE_INJECTION_FAILED',
            rawResult: { message: (e as Error).message },
          }))
          return { success: false, error: 'Bridge MAIN world injection failed: ' + (e as Error).message }
        }
      }

      // Wait for bridge to initialize
      await new Promise(r => setTimeout(r, 800))
      if (BG_DEBUG) console.log('[Background] Injection done, polling bridge ready...')

      // Poll using MAIN-world probe. BridgeReady can come from either
      //   (a) successful ping response with ready: true, OR
      //   (b) marker-based readiness (__FLOW_SLATE_BRIDGE_READY__ true
      //       or __FLOW_BRIDGE__ exists or __flowSlateBridgeCleanup set).
      // Soft-fail: after 10 attempts (5s) we do NOT abort. We log the
      // last probe and fall through to send RUN_FLOW_PROMPT. The content
      // script's own waitBridgeReady will continue polling for up to 10s.
      var bridgeReady = false
      var lastProbe: Record<string, unknown> = {}
      for (let i = 0; i < 10; i++) {
        try {
          lastProbe = (await pingFlowBridgeViaMainWorld(tabId)) || {}
          console.log('[FlowTrace][BG] BRIDGE_READY_POLL #' + (i + 1) + ' ' + JSON.stringify(lastProbe))
          if (lastProbe?.bridgeReady === true) {
            bridgeReady = true
            if (BG_DEBUG) console.log('[Background] Bridge ready after', (i + 1) * 500, 'ms')
            break
          }
        } catch (e) {
          console.log('[FlowTrace][BG] BRIDGE_READY_POLL #' + (i + 1) + ' error=' + (e as Error)?.message)
        }
        await new Promise(r => setTimeout(r, 500))
        if (i === 9) {
          // Layer B fallback: try content-script FLOW_INJECT_BRIDGE once
          // more (deferral guard means flow-content.ts will respond).
          console.warn('[FlowTrace][BG] BRIDGE_READY_POLL_EXHAUSTED — trying content-script ping as fallback')
          try {
            const csFallback = await chrome.tabs.sendMessage(tabId, { action: 'FLOW_INJECT_BRIDGE' }).catch(function () { return null })
            console.log('[FlowTrace][BG] BRIDGE_READY_CS_FALLBACK_RAW ' + JSON.stringify({
              csFallback: csFallback,
              responseRaw: csFallback,
            }))
            if (csFallback?.bridgeReady === true) {
              bridgeReady = true
              console.log('[FlowTrace][BG] BRIDGE_READY_VIA_CS_FALLBACK_AFTER_POLLS')
            }
          } catch (e) {
            console.log('[FlowTrace][BG] BRIDGE_READY_CS_FALLBACK_ERROR error=' + (e as Error)?.message)
          }
          if (!bridgeReady) {
            // Soft-fail: log the failure but DO NOT abort. Fall through
            // to send RUN_FLOW_PROMPT — flow-content.ts's runFlowPrompt
            // internally waits up to 10s via waitBridgeReady.
            console.warn('[FlowTrace][BG] BRIDGE_READY_POLL_TIMEOUT_SOFT_FAIL ' + JSON.stringify({
              attempts: 10,
              lastProbe: lastProbe,
              willFallThroughTo: 'SEND_RUN_FLOW_PROMPT with content-script waitBridgeReady as last line of defense',
            }))
            console.error('[FlowTrace][Fail] ' + JSON.stringify({
              step: 'BG.bridgeReadyPoll',
              reason: 'FLOW_BRIDGE_NOT_READY',
              rawResult: { attempts: 10, lastProbe: lastProbe },
              extra: { hint: 'Reload the Flow tab — content script may be stale or stale generic content-script.ts is interfering. Soft-failed to RUN_FLOW_PROMPT.', softFailed: true },
            }))
          }
          break
        }
      }

      if (!bridgeReady) {
        // Soft-fail: log but continue. SEND_RUN_FLOW_PROMPT below will
        // delegate the wait to flow-content.ts's runFlowPrompt which has
        // its own 10s waitBridgeReady poll loop.
        console.warn('[FlowTrace][BG] BRIDGE_NOT_READY_SOFT_FALLTHROUGH — sending RUN_FLOW_PROMPT and letting flow-content.ts waitBridgeReady take over')
        console.error('[FlowTrace][Fail] ' + JSON.stringify({
          step: 'BG.bridgeReady',
          reason: 'FLOW_BRIDGE_NOT_READY',
          rawResult: null,
          extra: { hint: 'Reload the Flow tab — content script may be stale. Soft-failed to RUN_FLOW_PROMPT.', softFailed: true },
        }))
      }
    }
    console.log('[FlowTrace][BG] BRIDGE_READY tabId=' + tabId)
  } catch (e) {
    if (BG_DEBUG) console.warn('[Background] Bridge check/injection error:', e)
    console.error('[FlowTrace][Fail] ' + JSON.stringify({
      step: 'BG.bridgeCheck',
      reason: 'FLOW_BRIDGE_CHECK_EXCEPTION',
      rawResult: { message: (e as Error).message },
    }))
  }

  if (payload.preserveEditor === true || payload.focusTab === false) {
    console.log('[Workflow][ProviderRoute] flowNoFocus', JSON.stringify({
      tabId,
      reason: 'workflow-editor-preservation',
    }))
  } else if (payload.focusTab) {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {})
  }

  try {
    console.log('[FlowTrace][BG] SEND_RUN_FLOW_PROMPT_START ' + JSON.stringify({
      tabId,
      mode: payload.mode,
      model: payload.model,
      ratio: payload.aspectRatio,
      quantity: payload.quantity,
      autoDownload: payload.autoDownload,
      fileIdsCount: (payload.fileIds || []).length,
      promptLen: payload.prompt?.length || 0,
    }))
    const result = await chrome.tabs.sendMessage(tabId, {
      action: 'RUN_FLOW_PROMPT',
      payload,
      tabId
    })
    console.log('[Background] runFlowPrompt result:', result)
    console.log('[FlowTrace][BG] SEND_RUN_FLOW_PROMPT_RESPONSE ' + JSON.stringify({
      tabId,
      success: result?.success,
      status: result?.status,
      error: result?.error,
      hasAutoDownload: !!(result?.autoDownload),
      outputsCount: Array.isArray(result?.outputs) ? (result?.outputs as unknown[]).length : 0,
      imagesCount: Array.isArray(result?.images) ? (result?.images as unknown[]).length : 0,
      imageUrlsCount: Array.isArray(result?.imageUrls) ? (result?.imageUrls as unknown[]).length : 0,
      responseRaw: result,
    }))
    return {
      success: result?.success ?? false,
      tabId,
      status: result?.status,
      tiles: result?.tiles,
      error: result?.error,
      autoDownload: result?.autoDownload,
      downloadDetails: result?.downloadDetails,
      // Output assets for workflow node preview + downstream media.
      // Forwarded as-is from flow-content.ts. The runner reads
      // `outputs` (rich descriptor) and `images` (MediaItem shape) to
      // populate node output + feed downstream nodes. The UI renderer
      // reads `imageUrls` (string[]) and walks `images[]` for the
      // preview thumbnail.
      outputs: Array.isArray(result?.outputs) ? result?.outputs : [],
      images: Array.isArray(result?.images) ? result?.images : [],
      imageUrls: Array.isArray(result?.imageUrls) ? result?.imageUrls : [],
    }
  } catch (e) {
    const message = (e as Error).message || String(e)
    const isContextInvalidated =
      /context invalidated/i.test(message) ||
      /message channel closed/i.test(message) ||
      /receiving end does not exist/i.test(message) ||
      /could not establish connection/i.test(message)
    const reason = isContextInvalidated ? 'FLOW_CONTENT_CONTEXT_INVALIDATED' : 'FLOW_MESSAGE_NOT_DELIVERED'
    console.error('[Background] sendMessage failed:', e)
    console.error('[FlowTrace][BG] SEND_RUN_FLOW_PROMPT_LAST_ERROR ' + JSON.stringify({
      tabId,
      reason,
      message,
      hint: isContextInvalidated ? 'Reload the Flow tab and retry. The content script context closed before replying.' : undefined,
    }))
    console.error('[FlowTrace][Fail] ' + JSON.stringify({
      step: 'BG.sendMessage',
      reason,
      rawResult: { message },
      extra: isContextInvalidated ? { hint: 'Reload the Flow tab and retry.', contextInvalidated: true } : undefined,
    }))
    return { success: false, status: reason, error: message }
  }
}

// ── pingFlowBridgeViaMainWorld ───────────────────────────────────────────────
// Bypasses the chrome.runtime.onMessage listener race by injecting a small
// async function directly into the page's MAIN world. The probe:
//   1. Reads bridge markers (window.__FLOW_BRIDGE_BUILD_TIME__,
//      __FLOW_SLATE_BRIDGE_READY__, __FLOW_BRIDGE__, __flowSlateBridgeCleanup).
//   2. Posts { source: 'flow-auto-slate', action: 'ping', requestId } to the
//      page so the bridge's handleMessage responds.
//   3. Awaits the response (chrome.scripting.executeScript supports async
//      Promises natively — Chrome waits for the promise to settle).
//
// Why this is needed:
//   - The generic src/contents/content-script.ts (matches <all_urls>) was
//     previously intercepting FLOW_INJECT_BRIDGE messages and winning the
//     listener race. That race is now fixed (content-script.ts defers
//     FLOW_* and RUN_FLOW_PROMPT to flow-content.ts), but a MAIN-world
//     probe is still more reliable and avoids content script overhead.
//   - Previous version used a busy-wait loop, which blocked the main
//     thread and prevented the message event from firing — bridgeReady
//     was always false. The probe is now async with a proper Promise
//     wait and a 1000ms timeout.
async function pingFlowBridgeViaMainWorld(tabId: number): Promise<Record<string, unknown> | null> {
  // Probe runs in MAIN world. It is an async function so Chrome waits for
  // its Promise to settle before returning the result. This allows the
  // postMessage listener to fire naturally between async ticks.
  const probeFunc = async function () {
    var w = window
    var buildTime = (w as unknown as Record<string, unknown>).__FLOW_BRIDGE_BUILD_TIME__ || null
    var slateReady = !!(w as unknown as Record<string, unknown>).__FLOW_SLATE_BRIDGE_READY__
    var bridgeApi = !!(w as unknown as Record<string, unknown>).__FLOW_BRIDGE__
    var cleanupMarker = !!(w as unknown as Record<string, unknown>).__flowSlateBridgeCleanup
    var markers = {
      bridgeBuildTime: buildTime,
      slateReady: slateReady,
      bridgeApi: bridgeApi,
      cleanupMarker: cleanupMarker,
    }
    // Trace: PROBE_MARKERS — log all four markers at probe entry.
    console.log('[FlowTrace][BG] PROBE_MARKERS ' + JSON.stringify({
      url: w.location ? w.location.href : '',
      markers: markers,
    }))
    var probeResult: Record<string, unknown> = {
      bridgeLoaded: cleanupMarker || slateReady || bridgeApi,
      bridgeReady: false,
      bridgeReadyByMarker: false,
      bridgeReadyByPing: false,
      bridgeBuildTime: buildTime,
      markers: markers,
      url: w.location ? w.location.href : '',
    }
    // Marker-based readiness: if __FLOW_SLATE_BRIDGE_READY__ is true OR
    // __FLOW_BRIDGE__ exists, the bridge has fully exposed its API and is
    // ready to handle requests. Skip the ping round-trip.
    if (slateReady || bridgeApi) {
      ;(probeResult as Record<string, unknown>).bridgeReady = true
      ;(probeResult as Record<string, unknown>).bridgeReadyByMarker = true
      console.log('[FlowTrace][BG] PROBE_READY_BY_MARKER ' + JSON.stringify({
        slateReady: slateReady,
        bridgeApi: bridgeApi,
      }))
      return probeResult
    }
    // Otherwise, ping the bridge via postMessage and wait up to 1000ms
    // for a { pong: true, ready: true, ... } response.
    if (buildTime || cleanupMarker) {
      try {
        var reqId = 'probe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
        var pingTimedOut = false
        var response: Record<string, unknown> | null = null
        var responsePromiseResolve: (v: Record<string, unknown>) => void = function () { /* will be set below */ } as unknown as (v: Record<string, unknown>) => void
        var responsePromise = new Promise<Record<string, unknown>>(function (resolve) {
          responsePromiseResolve = resolve
        })
        var onceHandler = function (e: MessageEvent) {
          try {
            if (e.source !== w) return
            var d = e.data as Record<string, unknown>
            if (!d) return
            if (d.source !== 'flow-auto-slate-result') return
            if (d.requestId !== reqId) return
            // Trace: PROBE_GOT_MESSAGE
            console.log('[FlowTrace][BG] PROBE_GOT_MESSAGE ' + JSON.stringify({
              reqId: reqId,
              d: d,
            }))
            responsePromiseResolve(d)
          } catch (err) {
            // ignore
          }
        }
        // CRITICAL: addEventListener MUST happen BEFORE postMessage so the
        // listener is registered to receive the bridge's response.
        w.addEventListener('message', onceHandler)
        // Trace: PROBE_POST_PING — log just before posting the ping.
        console.log('[FlowTrace][BG] PROBE_POST_PING ' + JSON.stringify({
          reqId: reqId,
          ping: { source: 'flow-auto-slate', action: 'ping', requestId: reqId },
        }))
        w.postMessage({
          source: 'flow-auto-slate',
          action: 'ping',
          requestId: reqId,
        }, w.location.origin)
        // Wait up to 1000ms for the bridge to respond. Using await lets
        // the message event fire on the event loop between ticks.
        var timeoutPromise = new Promise<null>(function (resolve) {
          setTimeout(function () {
            pingTimedOut = true
            console.log('[FlowTrace][BG] PROBE_TIMEOUT ' + JSON.stringify({
              reqId: reqId,
              timeoutMs: 1000,
            }))
            resolve(null)
          }, 1000)
        })
        response = await Promise.race([responsePromise, timeoutPromise])
        try { w.removeEventListener('message', onceHandler) } catch (_) {}
        if (response) {
          ;(probeResult as Record<string, unknown>).bridgeReadyByPing = true
          if (response.ready === true) {
            ;(probeResult as Record<string, unknown>).bridgeReady = true
          }
        } else if (pingTimedOut) {
          // Ping timed out. Fall back to markers — if cleanupMarker is true
          // (the bridge installed its teardown handler), the bridge IS
          // loaded even though it didn't respond to this particular ping.
          if (cleanupMarker) {
            ;(probeResult as Record<string, unknown>).bridgeReadyByMarker = true
            ;(probeResult as Record<string, unknown>).bridgeReady = true
            console.log('[FlowTrace][BG] BRIDGE_READY_BY_MARKER_PING_TIMEOUT ' + JSON.stringify({
              cleanupMarker: cleanupMarker,
              buildTime: buildTime,
              reqId: reqId,
            }))
          } else {
            ;(probeResult as Record<string, unknown>).bridgePingTimedOut = true
          }
        }
      } catch (e) {
        ;(probeResult as Record<string, unknown>).bridgePingError = (e as Error)?.message || String(e)
        console.log('[FlowTrace][BG] PROBE_ERROR ' + JSON.stringify({
          error: (e as Error)?.message || String(e),
        }))
      }
    } else {
      // No buildTime, no slateReady, no bridgeApi, no cleanupMarker —
      // the bridge is definitely not loaded.
      ;(probeResult as Record<string, unknown>).bridgeLoaded = false
      console.log('[FlowTrace][BG] PROBE_NO_MARKERS bridge not loaded')
    }
    return probeResult
  }
  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: probeFunc,
    })
    if (!injectionResults || injectionResults.length === 0) return null
    return (injectionResults[0].result as Record<string, unknown>) || null
  } catch (e) {
    return {
      bridgeLoaded: false,
      bridgeReady: false,
      probeError: (e as Error)?.message || String(e),
    }
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
