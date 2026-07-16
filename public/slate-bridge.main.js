import { classifyFlowErrorText } from '../lib/flow/resultContract'
import {
  classifyFlowAdmissionWarningContexts,
  countFlowTileActivity,
  isFlowQueueStatusText,
  type FlowWarningContext,
} from '../lib/flow/healthClassifier'
import { dedupeFlowTileObservations } from '../lib/flow/tileIdentity'
import { FLOW_BRIDGE_BUILD_MARKER } from '../lib/flow/runtimeDiagnostics'

type BridgeRuntimeInstance = {
  instanceId: string
  documentId: string
  messageListenerCount: number
  mutationObserverCount: number
  pollingLoopCount: number
  submitHandlerCount: number
}

type BridgeRuntimeRegistry = {
  documentId: string
  installCount: number
  instances: BridgeRuntimeInstance[]
}

/**
 * Flow Slate Bridge — MAIN world
 *
 * Strategy:
 * 1. Find editor DOM element via known selectors (already verified correct)
 * 2. Deep scan React fiber tree from element for Slate editor object
 * 3. Score each candidate — pick highest score (min 8 = Slate editor)
 * 4. Try Slate API first, fall back to DOM execCommand
 * 5. DOM fallback always runs to verify text appears in editor
 * 6. Expose __flowDebugScan() and __flowTestInsert() for testing
 *
 * SINGLETON GUARD: this script is loaded into the MAIN world via
 * chrome.scripting.executeScript. If executeScript is called twice on
 * the same page (e.g. extension reload races, or older dev-helper
 * bundles also registered a listener), the previous instance is torn
 * down via __flowSlateBridgeCleanup before this new IIFE installs its
 * postMessage listener. The bridge also marks `documentElement` with
 * `data-flow-bridge-real-installed` so dev console helpers can detect
 * the real bridge and back off instead of competing for the same
 * postMessage channel.
 */
;(function () {
  'use strict'

  var _sourceId = 'flow-auto-slate'
  var _resultId = _sourceId + '-result'
  var _pending = {}
  var _reqId = 0
  var bridgeGlobal = window as unknown as Record<string, unknown>
  var previousBridgeInstanceId = typeof bridgeGlobal.__FLOW_BRIDGE_INSTANCE_ID__ === 'string'
    ? String(bridgeGlobal.__FLOW_BRIDGE_INSTANCE_ID__)
    : ''
  var previousBridgeCleanupSucceeded = false

  // ── Singleton guard ───────────────────────────────────────────────────
  // If a previous instance of this bridge is still installed, tear it
  // down first. This MUST happen before we install our postMessage
  // listener so two instances never co-exist on the same channel.
  if (typeof window !== 'undefined' && bridgeGlobal.__flowSlateBridgeCleanup) {
    try {
      var existingCleanup = bridgeGlobal.__flowSlateBridgeCleanup as () => void
      existingCleanup()
      previousBridgeCleanupSucceeded = true
      bridgeLog('[Bridge] previous instance cleaned up')
    } catch (_: unknown) {
      // ignore — previous instance may already be partially torn down
    }
  }

  // Also remove any stray markers from a previous instance so we know
  // the page is now owned by THIS instance.
  try { document.documentElement.removeAttribute('data-flow-bridge-real-installed') } catch (_) {}

  // ── Bridge instance registry ──────────────────────────────────────────
  // Expose a registry on window so debug tooling (and the FlowTrace
  // grep pipeline) can confirm only one bridge is installed at a time.
  var BRIDGE_DOCUMENT_ID = typeof bridgeGlobal.__FLOW_BRIDGE_DOCUMENT_ID__ === 'string'
    ? String(bridgeGlobal.__FLOW_BRIDGE_DOCUMENT_ID__)
    : 'flow-main-document_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
  bridgeGlobal.__FLOW_BRIDGE_DOCUMENT_ID__ = BRIDGE_DOCUMENT_ID
  var existingBridgeRegistry = bridgeGlobal.__FLOW_BRIDGE_RUNTIME_REGISTRY__ as BridgeRuntimeRegistry | undefined
  var bridgeRuntimeRegistry: BridgeRuntimeRegistry = existingBridgeRegistry?.documentId === BRIDGE_DOCUMENT_ID
    ? existingBridgeRegistry
    : { documentId: BRIDGE_DOCUMENT_ID, installCount: 0, instances: [] }
  if (previousBridgeInstanceId && !previousBridgeCleanupSucceeded && !bridgeRuntimeRegistry.instances.some(function (instance) {
    return instance.instanceId === previousBridgeInstanceId
  })) {
    // A previous same-document marker survived but its cleanup failed. Keep a
    // conservative ghost record so the handshake reports a duplicate instead
    // of silently assuming the old listener/submit handler disappeared.
    bridgeRuntimeRegistry.instances.push({
      instanceId: previousBridgeInstanceId,
      documentId: BRIDGE_DOCUMENT_ID,
      messageListenerCount: 1,
      mutationObserverCount: 0,
      pollingLoopCount: 0,
      submitHandlerCount: 1,
    })
  }
  var BRIDGE_INSTANCE_ID = 'flow-slate-bridge_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
  var bridgeRuntimeInstance: BridgeRuntimeInstance = {
    instanceId: BRIDGE_INSTANCE_ID,
    documentId: BRIDGE_DOCUMENT_ID,
    messageListenerCount: 0,
    mutationObserverCount: 0,
    pollingLoopCount: 0,
    submitHandlerCount: 0,
  }
  bridgeRuntimeRegistry.installCount += 1
  bridgeRuntimeRegistry.instances.push(bridgeRuntimeInstance)
  bridgeGlobal.__FLOW_BRIDGE_RUNTIME_REGISTRY__ = bridgeRuntimeRegistry
  bridgeGlobal.__FLOW_BRIDGE_INSTANCE_ID__ = BRIDGE_INSTANCE_ID

  // Feature flag: disable settings automation until popup detection is stable
  var ENABLE_FLOW_SETTINGS_AUTOMATION = false

  // Build time marker — single source of truth for cache-busting verification
  // Bump this every time you make a runtime change so the Flow page console
  // verification (window.__FLOW_BRIDGE_BUILD_TIME__) matches the running bundle.
  // 2026-07-10 05:55:00 — added Flow Video input mode (Khung hình / Thành phần).
  var FLOW_BRIDGE_BUILD_TIME = "2026-07-17 04:20:56"
  bridgeLog('[Bridge] BUILD_TIME ' + FLOW_BRIDGE_BUILD_TIME + ' instance=' + BRIDGE_INSTANCE_ID)
  ;(window as Record<string, unknown>).__FLOW_BRIDGE_BUILD_TIME__ = FLOW_BRIDGE_BUILD_TIME
  bridgeGlobal.__FLOW_BRIDGE_BUILD_MARKER__ = FLOW_BRIDGE_BUILD_MARKER

  // ── Debug level helpers ──────────────────────────────────────────────────────
  var FLOW_DEBUG_VERBOSE =
    localStorage.getItem('FLOW_DEBUG_VERBOSE') === '1' ||
    (window as Record<string, unknown>).__FLOW_DEBUG_VERBOSE__ === true

  // Minimum time a tile must stay in 'failed' state before the orchestrator
  // treats it as a real failure. Flow occasionally paints a warning icon
  // during generation retries; this guard prevents false positives that
  // would otherwise trigger early partial exits.
  var MIN_FAIL_DETECT_MS = 15000

  // Reduced role: VIDEO_PARTIAL_GRACE_MS is now a fallback only when
  // no failed icon is detectable. The primary early-exit path is
  // confirmed + failed coexist (handled by AUTO_DOWNLOAD_PARTIAL_EARLY_EXIT).
  var VIDEO_PARTIAL_GRACE_MS = 8000

  function bridgeLog() {
    var args = []
    for (var _i = 0; _i < arguments.length; _i++) {
      args[_i] = arguments[_i]
    }
    console.log.apply(console, args)
  }

  function bridgeDebug() {
    var args = []
    for (var _i = 0; _i < arguments.length; _i++) {
      args[_i] = arguments[_i]
    }
    if (FLOW_DEBUG_VERBOSE) console.log.apply(console, args)
  }

  function bridgeWarn() {
    var args = []
    for (var _i = 0; _i < arguments.length; _i++) {
      args[_i] = arguments[_i]
    }
    console.warn.apply(console, args)
  }

  function bridgeError() {
    var args = []
    for (var _i = 0; _i < arguments.length; _i++) {
      args[_i] = arguments[_i]
    }
    console.error.apply(console, args)
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  function sleep(ms: number): Promise<void> {
    return new Promise(function (r) { setTimeout(r, ms) })
  }

  // ── Visibility helper ──────────────────────────────────────────────
  // Checks that an element is laid out with non-zero size, has computed
  // visibility, and is actually inside the viewport (or its ancestor
  // scroll container). Used by Google Flow editor / button discovery
  // so we never pick a hidden / zero-sized contenteditable or button.
  function isVisible(el: HTMLElement | null | undefined): boolean {
    if (!el || !(el instanceof Element)) return false
    try {
      var rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      var style = window.getComputedStyle(el)
      if (!style) return false
      if (style.display === 'none') return false
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
      if (style.opacity === '0') return false
      // connected to DOM
      if (!el.isConnected) return false
      return true
    } catch (_) {
      return false
    }
  }

  function closeFlowSettingsPanelWithEscape() {
    bridgeDebug('[Bridge][rs] close settings panel START')
    var escEventInit = {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
    }
    document.dispatchEvent(new KeyboardEvent('keydown', escEventInit))
    window.dispatchEvent(new KeyboardEvent('keydown', escEventInit))
    document.body?.dispatchEvent(new KeyboardEvent('keydown', escEventInit))
    bridgeDebug('[Bridge][rs] close settings panel ESC sent')
  }

  function ratioIconToRatio(icon: unknown): string {
    var value = String(icon ?? '').trim()
    if (value === 'crop_16_9') return '16:9'
    if (value === 'crop_landscape') return '4:3'
    if (value === 'crop_square') return '1:1'
    if (value === 'crop_portrait') return '3:4'
    if (value === 'crop_9_16') return '9:16'
    return ''
  }

  function normalizeSettingText(value: unknown): string {
    return String(value ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function parseDurationFromText(value: unknown): string {
    var text = String(value ?? '')
    var match = text.match(/\b(4s|6s|8s|10s)\b/i)
    return match ? match[1].toLowerCase() : ''
  }

  function compareFlowSettings(target: any, current: any) {
    var currentRatio = ratioIconToRatio(current?.ratioIcon)
    var isVideo = target.mode === 'video'
    var diff = {
      mode: {
        target: target.mode,
        actual: current?.mode || 'unknown',
        match: true,
      },
      model: {
        target: target.model,
        actual: isVideo ? '(not shown in video chip)' : (current?.model || ''),
        match: isVideo ? true : normalizeSettingText(target.model) === normalizeSettingText(current?.model),
      },
      ratio: {
        target: target.ratio,
        actual: currentRatio,
        icon: current?.ratioIcon || '',
        match: String(target.ratio) === currentRatio,
      },
      quantity: {
        target: target.quantity,
        actual: current?.quantity,
        match: Number(target.quantity) === Number(current?.quantity),
      },
      duration: {
        target: target.duration || '',
        actual: current?.duration || '',
        match: !isVideo || !target.duration || current?.duration === target.duration,
      },
      videoMode: {
        target: target.flowVideoMode || null,
        actual: current?.videoMode || null,
        // Only checked when the caller asked for a videoMode. When
        // target.flowVideoMode is undefined/empty, we don't fail the
        // verify — this preserves legacy behavior of "leave the tab
        // alone" without tripping the verify gate.
        match: !target.flowVideoMode
          || !isVideo
          || target.flowVideoMode === current?.videoMode,
      },
    }
    return {
      ok: diff.model.match && diff.ratio.match && diff.quantity.match && diff.duration.match && diff.videoMode.match,
      diff: diff,
    }
  }

  function readFlowSettingsSnapshot(settingsBtn?: Element | null | undefined, panel?: Element | null | undefined) {
    var btn = settingsBtn || (typeof getFlowSettingsButton === 'function' ? getFlowSettingsButton() : null)
    if (!btn) return null
    var allText = String(btn.textContent ?? '').trim()
    var iconTexts = Array.from(btn.querySelectorAll('*'))
      .map(function (el) { return String(el.textContent ?? '').trim() })
      .filter(Boolean)
    var ratioIcon = iconTexts.find(function (t) { return t.startsWith('crop_') }) || ''
    var quantity: number | null = null
    var model = ''
    var mode = 'unknown'
    var duration = ''
    for (var i = 0; i < btn.childNodes.length; i++) {
      var node = btn.childNodes[i]
      if (node.nodeType !== Node.TEXT_NODE) continue
      var text = String(node.textContent ?? '').trim()
      if (!text) continue
      var q = parseQuantityText(text)
      if (q) {
        quantity = q
        continue
      }
      // Detect video mode: "Video · 8s" or "Video" prefix
      if (/^video\b/i.test(text) || /^video\s*·/i.test(text)) {
        mode = 'video'
        duration = parseDurationFromText(text)
        continue
      }
      if (!model) {
        model = text.replace(/^[\u{1F000}-\u{1FFFF}]\s*/u, '').trim()
      }
    }
    // Video input mode (Khung hình / Thành phần) — only visible inside
    // the open settings popup. We accept an optional `panel` arg so
    // post-apply verify can capture the tab state when the popup is
    // still open. When the popup is closed or omitted, return null
    // and downstream compareFlowSettings treats this as a no-op (the
    // caller-specific VIDEO_REFERENCES / VIDEO_FRAMES tabs are never
    // visible from the summary button alone).
    var videoMode: 'frame' | 'ingredient' | null = null
    if (panel) {
      var activeMode = readActiveVideoMode(panel)
      videoMode = activeMode
    }
    return {
      mode: mode,
      model: model,
      duration: duration,
      ratioIcon: ratioIcon,
      quantity: quantity,
      videoMode: videoMode,
      rawText: allText,
    }
  }

  function getAllText(node: Record<string, unknown>): string {
    if (typeof node === 'string') return node as string
    if ((node as Record<string, unknown>).text !== undefined) return ((node as Record<string, unknown>).text as string) || ''
    if (Array.isArray((node as Record<string, unknown>).children)) {
      return ((node as Record<string, unknown>).children as Array<Record<string, unknown>>).map(getAllText).join('')
    }
    return ''
  }

  function getOwnEnumerableKeys(obj: unknown): string[] {
    try {
      return Object.keys(obj as object)
    } catch (_) {
      return []
    }
  }

  function safeGet(obj: unknown, key: string): unknown {
    try { return (obj as Record<string, unknown>)[key] } catch (_) { return undefined }
  }

  function hasKey(obj: unknown, key: string): boolean {
    try { return key in (obj as object) } catch (_) { return false }
  }

  // ── Safe string helpers ─────────────────────────────────────────────
  function safeText(value: unknown): string {
    return String(value ?? '').trim()
  }

  function safeLower(value: unknown): string {
    return safeText(value).toLowerCase()
  }

  function normalizeFlowModelText(value: unknown): string {
    return safeText(value)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  // ── Ratio helpers ────────────────────────────────────────────────────────
  function ratioToIconName(ratio: unknown): string {
    var r = safeLower(ratio)

    if (r.includes('16:9') || r === 'widescreen' || r === '16_9') return 'crop_16_9'
    if (r.includes('4:3') || r === 'landscape' || r === '4_3') return 'crop_landscape'
    if (r.includes('1:1') || r === 'square') return 'crop_square'
    if (r.includes('3:4') || r === 'portrait' || r === '3_4') return 'crop_portrait'
    if (r.includes('9:16') || r === 'story' || r === '9_16') return 'crop_9_16'

    return ''
  }

  function ratioToTriggerSuffix(ratio: unknown): string {
    var r = safeLower(ratio)

    if (r === '16:9' || r === 'widescreen') return 'LANDSCAPE'
    if (r === '4:3' || r === 'landscape') return 'LANDSCAPE_4_3'
    if (r === '1:1' || r === 'square') return 'SQUARE'
    if (r === '3:4' || r === 'portrait') return 'PORTRAIT_3_4'
    if (r === '9:16' || r === 'story') return 'PORTRAIT'

    return ''
  }

  // ── Read current settings from UI ─────────────────────────────────────────
  function readCurrentFlowSettings(): Record<string, unknown> | null {
    var settingsBtn = (getFlowSettingsButton as (s?: Element | null) => HTMLElement | null)()
    if (!settingsBtn) return null

    var ratioIcon = ''
    var quantity: number | null = null
    var model = ''

    var icons = Array.from(settingsBtn.querySelectorAll('*'))
      .map(function (el) { return safeText((el as HTMLElement).textContent) })
      .filter(function (t) { return t.startsWith('crop_') })

    ratioIcon = icons[0] || ''

    for (var ni = 0; ni < settingsBtn.childNodes.length; ni++) {
      var node = settingsBtn.childNodes[ni]
      if (node.nodeType !== Node.TEXT_NODE) continue
      var text = safeText(node.textContent)
      var m = text.match(/^(\d)x$|^x(\d)$/)
      if (m) {
        quantity = Number(m[1] || m[2])
        continue
      }

      if (!model && text && !/^(\d)x$|^x(\d)$/.test(text)) {
        model = text.replace(/^[\u{1F000}-\u{1FFFF}]\s*/u, '').trim()
      }
    }

    return {
      model: model,
      ratioIcon: ratioIcon,
      quantity: quantity,
      rawText: safeText(settingsBtn.textContent)
    }
  }


  // ═══════════════════════════════════════════════════════════════
  // DEEP SCAN FOR SLATE EDITOR
  // ═══════════════════════════════════════════════════════════════

  interface EditorCandidate {
    editor: Record<string, unknown>
    score: number
    path: string
    depth: number
    keys: string[]
    hasInsertText: boolean
    hasApply: boolean
    hasChildren: boolean
    hasSelection: boolean
    hasOnChange: boolean
    hasInsertData: boolean
    childrenPreview: string
  }

  function scoreObject(obj: Record<string, unknown>, path: string, depth: number): EditorCandidate | null {
    var keys = getOwnEnumerableKeys(obj)
    if (keys.length === 0) return null

    var hasInsertText = typeof obj.insertText === 'function'
    var hasApply = typeof obj.apply === 'function'
    var hasChildren = Array.isArray(obj.children)
    var hasSelection = 'selection' in obj
    var hasOnChange = typeof obj.onChange === 'function'
    var hasInsertData = typeof obj.insertData === 'function'

    var score = 0
    if (hasInsertText) score += 5
    if (hasApply) score += 5
    if (hasChildren) score += 4
    if (hasSelection) score += 3
    if (hasOnChange) score += 2
    if (hasInsertData) score += 2
    if (Array.isArray(obj.operations)) score += 1
    if ('marks' in obj) score += 1

    var childrenPreview = ''
    if (hasChildren) {
      try {
        childrenPreview = getAllText(obj).substring(0, 80).replace(/\n/g, ' ')
      } catch (_) {}
    }

    if (score > 0) {
      bridgeDebug('[Bridge] near editor candidate')
      bridgeDebug('[Bridge]   path=' + path)
      bridgeDebug('[Bridge]   depth=' + depth)
      bridgeDebug('[Bridge]   constructor=' + (obj.constructor ? obj.constructor.name : 'unknown'))
      bridgeDebug('[Bridge]   keys=[' + keys.slice(0, 30).join(', ') + ']')
      bridgeDebug('[Bridge]   hasInsertText=' + hasInsertText + ' hasApply=' + hasApply + ' hasChildren=' + hasChildren)
      bridgeDebug('[Bridge]   hasSelection=' + hasSelection + ' hasOnChange=' + hasOnChange + ' hasInsertData=' + hasInsertData)
      bridgeDebug('[Bridge]   childrenPreview="' + childrenPreview + '"')
      bridgeDebug('[Bridge]   SCORE=' + score)
    }

    if (score >= 4) {
      return {
        editor: obj,
        score: score,
        path: path,
        depth: depth,
        keys: keys,
        hasInsertText: hasInsertText,
        hasApply: hasApply,
        hasChildren: hasChildren,
        hasSelection: hasSelection,
        hasOnChange: hasOnChange,
        hasInsertData: hasInsertData,
        childrenPreview: childrenPreview
      }
    }

    return null
  }

  function deepScanForEditor(
    root: unknown,
    path: string,
    depth: number,
    visited: WeakSet<object>,
    results: EditorCandidate[],
    options: { maxDepth: number }
  ): void {
    if (!root || typeof root !== 'object') return
    if (depth > options.maxDepth) return

    var obj = root as Record<string, unknown>
    try {
      if (visited.has(obj)) return
    } catch (_) {}

    try { visited.add(obj) } catch (_) {}

    // Score this object
    var cand = scoreObject(obj, path, depth)
    if (cand) results.push(cand)

    // Priority scan these properties first
    var priorityKeys = [
      'editor', 'value', 'current', 'context', 'store',
      'memoizedState', 'memoizedProps', 'pendingProps',
      'stateNode', 'dependencies', 'alternate', 'child', 'sibling', 'return',
      'queue', 'baseState', 'next', 'ref', 'fn', 'callback'
    ]
    for (var pi = 0; pi < priorityKeys.length; pi++) {
      var pk = priorityKeys[pi]
      if (hasKey(obj, pk)) {
        var pv = safeGet(obj, pk)
        if (pv && typeof pv === 'object' && pv !== obj) {
          var childPath = path + '.' + pk
          var childDepth = depth + 1
          if (childDepth <= options.maxDepth) {
            deepScanForEditor(pv, childPath, childDepth, visited, results, options)
          }
        }
      }
    }

    // Then scan all own enumerable keys
    var allKeys = getOwnEnumerableKeys(obj)
    for (var ki = 0; ki < allKeys.length; ki++) {
      var key = allKeys[ki]
      if (priorityKeys.indexOf(key) >= 0) continue // already scanned
      var val = safeGet(obj, key)
      if (val && typeof val === 'object' && val !== obj) {
        deepScanForEditor(val, path + '.' + key, depth + 1, visited, results, options)
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FIND EDITOR DOM ELEMENT
  // ═══════════════════════════════════════════════════════════════

  function findEditorElement(): HTMLElement | null {
    var selectors = [
      '[data-slate-editor="true"][contenteditable="true"]',
      '[data-slate-editor="true"]',
      '[contenteditable="true"][role="textbox"]',
      'div[role="textbox"][contenteditable="true"]'
    ]

    for (var si = 0; si < selectors.length; si++) {
      try {
        var els = document.querySelectorAll(selectors[si])
        for (var ei = 0; ei < els.length; ei++) {
          var el = els[ei] as HTMLElement
          if (el.getAttribute('contenteditable') === 'true') {
            bridgeDebug('[Bridge] findEditorElement: found via "' + selectors[si] + '", el=' + el.tagName + ' id=' + el.id + ' class=' + ((el.className || '').toString().substring(0, 60)))
            return el
          }
        }
      } catch (_) {}
    }

    // Fallback: contenteditable
    try {
      var edits = document.querySelectorAll('[contenteditable="true"]')
      for (var i = 0; i < edits.length; i++) {
        var ed = edits[i] as HTMLElement
        var role = ed.getAttribute('role') || ''
        if (role === 'textbox' || role === 'combobox') {
          bridgeDebug('[Bridge] findEditorElement: fallback found el=' + ed.tagName + ' role=' + role)
          return ed
        }
      }
    } catch (_) {}

    bridgeDebug('[Bridge] findEditorElement: not found yet')
    return null
  }

  // ═══════════════════════════════════════════════════════════════
  // GET FIBER KEYS FROM ELEMENT
  // ═══════════════════════════════════════════════════════════════

  function getFiberKeys(el: HTMLElement): Array<{ key: string; fiber: unknown }> {
    var results: Array<{ key: string; fiber: unknown }> = []
    var allKeys = getOwnEnumerableKeys(el)
    for (var ki = 0; ki < allKeys.length; ki++) {
      var k = allKeys[ki]
      if (
        k.startsWith('__reactFiber$') ||
        k.startsWith('__reactInternalInstance$') ||
        k.startsWith('__reactProps$') ||
        k.startsWith('__reactContainer$')
      ) {
        var val = safeGet(el, k)
        if (val) {
          results.push({ key: k, fiber: val })
          bridgeDebug('[Bridge] fiber key: ' + k + ' type=' + typeof val)
        }
      }
    }
    return results
  }

  // ═══════════════════════════════════════════════════════════════
  // FIND SLATE EDITOR OBJECT
  // ═══════════════════════════════════════════════════════════════

  interface EditorResult {
    editor: Record<string, unknown>
    el: HTMLElement
    strategy: string
    isSlateObject: boolean
  }

  function findSlateEditor(el: HTMLElement): EditorResult | null {
    var keys = getFiberKeys(el)

    for (var ki = 0; ki < keys.length; ki++) {
      var fiber = keys[ki].fiber as Record<string, unknown>
      bridgeDebug('[Bridge] Scanning fiber "' + keys[ki].key + '", keys=' + getOwnEnumerableKeys(fiber).slice(0, 20).join(', '))

      var visited = new WeakSet()
      var results: EditorCandidate[] = []
      var options = { maxDepth: 12 }
      deepScanForEditor(fiber, keys[ki].key, 0, visited, results, options)

      if (results.length > 0) {
        // Pick highest score
        results.sort(function (a, b) { return b.score - a.score })
        var best = results[0]
        bridgeDebug('[Bridge] BEST editor candidate score=' + best.score + ' path=' + best.path + ' depth=' + best.depth)
        bridgeDebug('[Bridge]   keys=[' + best.keys.slice(0, 20).join(', ') + ']')
        bridgeDebug('[Bridge]   childrenPreview="' + best.childrenPreview + '"')

        return {
          editor: best.editor,
          el: el,
          strategy: 'deepScan(' + best.path + ')',
          isSlateObject: best.score >= 8
        }
      }
    }

    // Try direct properties on element
    var elObj = el as unknown as Record<string, unknown>
    var directResults: EditorCandidate[] = []
    deepScanForEditor(elObj, 'element', 0, new WeakSet(), directResults, { maxDepth: 6 })
    if (directResults.length > 0) {
      directResults.sort(function (a, b) { return b.score - a.score })
      var bestDirect = directResults[0]
      bridgeDebug('[Bridge] BEST direct element candidate score=' + bestDirect.score + ' path=' + bestDirect.path)
      return {
        editor: bestDirect.editor,
        el: el,
        strategy: 'directElement(' + bestDirect.path + ')',
        isSlateObject: bestDirect.score >= 8
      }
    }

    bridgeDebug('[Bridge] No Slate editor object found via deep scan')
    return null
  }

  // ═══════════════════════════════════════════════════════════════
  // TEXT VERIFICATION
  // ═══════════════════════════════════════════════════════════════

  function getEditorText(editor: Record<string, unknown>, el: HTMLElement): { slateText: string; domText: string; placeholderGone: boolean } {
    var slateText = ''
    try {
      if (editor.children) slateText = getAllText(editor)
    } catch (_) {}

    var domText = ''
    try { domText = (el.textContent || '').trim() } catch (_) {}

    var placeholderGone = false
    try {
      var ph = el.querySelector('[data-slate-placeholder]')
      placeholderGone = !ph
      if (!ph) {
        var phSibling = el.parentElement ? el.parentElement.querySelector('[data-slate-placeholder]') : null
        placeholderGone = !phSibling
      }
    } catch (_) {}

    return { slateText, domText, placeholderGone }
  }

  function verifyText(editor: Record<string, unknown>, el: HTMLElement, text: string): boolean {
    var sample = text.length > 20 ? text.substring(0, 20) : text
    var info = getEditorText(editor, el)
    var inSlate = info.slateText.indexOf(sample) >= 0
    var inDom = info.domText.indexOf(sample) >= 0
    bridgeDebug('[Bridge] verifyText sample="' + sample + '"')
    bridgeDebug('[Bridge]   slateText="' + info.slateText.substring(0, 80) + '" matched=' + inSlate)
    bridgeDebug('[Bridge]   domText="' + info.domText.substring(0, 80) + '" matched=' + inDom)
    bridgeDebug('[Bridge]   placeholderGone=' + info.placeholderGone)
    return inSlate || inDom || info.placeholderGone
  }

  // ═══════════════════════════════════════════════════════════════
  // DOM FALLBACK INSERT
  // ═══════════════════════════════════════════════════════════════

  function insertTextDomFallback(el: HTMLElement, text: string): boolean {
    bridgeDebug('[Bridge] insertTextDomFallback start')
    try { el.focus() } catch (e) { bridgeWarn('[Bridge] focus failed:', e) }

    var success = false

    // Strategy A: execCommand
    try {
      var selBefore = document.getSelection() ? document.getSelection()!.toString().length : 0
      var result = document.execCommand('insertText', false, text)
      var selAfter = document.getSelection() ? document.getSelection()!.toString().length : 0
      success = selAfter > selBefore || result === true
      bridgeDebug('[Bridge] INSERT[dom.execCommand] ' + (success ? 'success' : 'fail') + ' selBefore=' + selBefore + ' selAfter=' + selAfter)
    } catch (e) {
      bridgeWarn('[Bridge] INSERT[dom.execCommand] error:', e)
    }

    // Strategy B: InputEvent beforeinput
    if (!success) {
      try {
        el.focus()
        el.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: text,
          bubbles: true,
          cancelable: true,
          composed: true
        }))
        el.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText',
          data: text,
          bubbles: true,
          cancelable: true,
          composed: true
        }))
        var t1 = (el.textContent || '').trim()
        success = t1.indexOf(text.substring(0, 15)) >= 0
        bridgeDebug('[Bridge] INSERT[dom.inputEvent] ' + (success ? 'success' : 'fail') + ' textLen=' + t1.length)
      } catch (e) {
        bridgeWarn('[Bridge] INSERT[dom.inputEvent] error:', e)
      }
    }

    // Strategy C: textContent direct set
    if (!success) {
      try {
        var oldText = el.textContent || ''
        var curText = oldText + text
        el.textContent = curText
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, composed: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        el.dispatchEvent(new Event('compositionend', { bubbles: true }))
        var t2 = (el.textContent || '').trim()
        success = t2.indexOf(text.substring(0, 15)) >= 0
        bridgeDebug('[Bridge] INSERT[dom.textContent] ' + (success ? 'success' : 'fail') + ' text="' + t2.substring(0, 60) + '"')
      } catch (e) {
        bridgeWarn('[Bridge] INSERT[dom.textContent] error:', e)
      }
    }

    // Strategy D: selection + Range insert
    if (!success) {
      try {
        el.focus()
        var sel = window.getSelection()
        if (sel) {
          sel.selectAllChildren(el)
          sel.collapseToEnd()
        }
        el.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertText', data: text, bubbles: true, cancelable: true
        }))
        el.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText', data: text, bubbles: true, cancelable: true
        }))
        var range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        var node = document.createTextNode(text)
        range.insertNode(node)
        range.setStartAfter(node)
        range.setEndAfter(node)
        sel && sel.removeAllRanges()
        sel && sel.addRange(range)
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }))
        var t3 = (el.textContent || '').trim()
        success = t3.indexOf(text.substring(0, 15)) >= 0
        bridgeDebug('[Bridge] INSERT[dom.range] ' + (success ? 'success' : 'fail') + ' text="' + t3.substring(0, 60) + '"')
      } catch (e) {
        bridgeWarn('[Bridge] INSERT[dom.range] error:', e)
      }
    }

    try { el.blur() } catch (_) {}
    return success
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEAR DOM FALLBACK
  // ═══════════════════════════════════════════════════════════════

  function clearDomFallback(el: HTMLElement): boolean {
    bridgeDebug('[Bridge] clearDomFallback')
    try {
      el.focus()
      var success = false

      // Ctrl+A then delete
      try {
        document.execCommand('selectAll', false, undefined)
        document.execCommand('delete', false, undefined)
        success = (el.textContent || '').trim().length === 0
        bridgeDebug('[Bridge] CLEAR[dom.selectAll+delete] ' + (success ? 'success' : 'fail'))
      } catch (_) {}

      if (!success) {
        el.textContent = ''
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        success = (el.textContent || '').trim().length === 0
        bridgeDebug('[Bridge] CLEAR[dom.textContent] ' + (success ? 'success' : 'fail'))
      }

      return success
    } catch (e) {
      bridgeWarn('[Bridge] clearDomFallback error:', e)
      return false
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SLATE INSERT
  // ═══════════════════════════════════════════════════════════════

  function getEndPoint(editor: Record<string, unknown>): { path: number[]; offset: number } {
    try {
      if (editor.children && Array.isArray(editor.children) && editor.children.length > 0) {
        var firstChild = editor.children[0] as Record<string, unknown>
        if (firstChild && Array.isArray(firstChild.children)) {
          var firstTextNode = firstChild.children[0] as Record<string, unknown>
          if (typeof firstTextNode === 'object' && firstTextNode.text !== undefined) {
            return { path: [0, 0], offset: (firstTextNode.text as string).length }
          }
        }
        return { path: [0, 0], offset: 0 }
      }
    } catch (_) {}
    return { path: [0], offset: 0 }
  }

  function trySlateInsert(editor: Record<string, unknown>, text: string): string | null {
    var methods = [
      {
        name: 'editor.insertText',
        fn: function () {
          var ep = getEndPoint(editor)
          ;(editor as Record<string, unknown>).selection = { anchor: ep, focus: ep }
          ;(editor as Record<string, unknown>).insertText(text)
          if (typeof (editor as Record<string, unknown>).onChange === 'function') {
            ((editor as Record<string, unknown>).onChange as () => void)()
          }
        }
      },
      {
        name: 'editor.apply(insert_text)',
        fn: function () {
          var ep = getEndPoint(editor)
          ;(editor as Record<string, unknown>).selection = { anchor: ep, focus: ep }
          ;(editor as Record<string, unknown>).apply({
            type: 'insert_text',
            path: ep.path,
            offset: ep.offset,
            text: text
          })
          if (typeof (editor as Record<string, unknown>).onChange === 'function') {
            ((editor as Record<string, unknown>).onChange as () => void)()
          }
        }
      },
      {
        name: 'editor.insertData',
        fn: function () {
          if (typeof (editor as Record<string, unknown>).insertData !== 'function') return
          var ep = getEndPoint(editor)
          ;(editor as Record<string, unknown>).selection = { anchor: ep, focus: ep }
          var dt = new DataTransfer()
          dt.setData('text/plain', text)
          ;(editor as Record<string, unknown>).insertData(dt)
          if (typeof (editor as Record<string, unknown>).onChange === 'function') {
            ((editor as Record<string, unknown>).onChange as () => void)()
          }
        }
      }
    ]

    for (var mi = 0; mi < methods.length; mi++) {
      var m = methods[mi]
      bridgeDebug('[Bridge] INSERT[' + m.name + '] try')
      try {
        m.fn()
        bridgeDebug('[Bridge] INSERT[' + m.name + '] OK')
        return m.name
      } catch (e) {
        bridgeWarn('[Bridge] INSERT[' + m.name + '] error:', e)
      }
    }

    return null
  }

  // ═══════════════════════════════════════════════════════════════
  // MASTER INSERT
  // ═══════════════════════════════════════════════════════════════

  // Compare the editor's current text against an expected prompt. Returns
  // a structured payload so the content script can log expected vs actual
  // and surface a `duplicate` flag when the prompt text appears more than
  // once.
  //
  // Why we strip whitespace + chip/placeholder text:
  //   Flow's composer renders reference-image chips inline; their caption
  //   text mixes into textContent. We must NOT count chip captions as
  //   "duplicate prompt". The strip path:
  //   1. Take DOM textContent
  //   2. Trim
  //   3. Collapse internal whitespace
  //   4. Strip any visible [data-slate-placeholder] sibling (rarely present
  //      once text exists)
  // For the actual match we ALSO check the Slate model text — that path
  // is chip-free because chips live in the DOM only.
  function compareEditorText(editor: Record<string, unknown> | null, el: HTMLElement, expected: string): {
    expected: string
    slateText: string
    domText: string
    slateMatch: boolean
    domMatch: boolean
    duplicate: boolean
    exactMatch: boolean
  } {
    var expectedNorm = String(expected || '').trim()
    var slateText = ''
    var domText = ''
    try {
      if (editor && editor.children) slateText = getAllText(editor).trim()
    } catch (_) {}
    try {
      domText = (el.textContent || '').trim()
    } catch (_) {}

    // Collapse internal whitespace so multi-space insertion still matches.
    var slateNorm = slateText.replace(/\s+/g, ' ').trim()
    var domNorm = domText.replace(/\s+/g, ' ').trim()
    var expectedN = expectedNorm.replace(/\s+/g, ' ').trim()

    var slateMatch = expectedN.length > 0 && slateNorm === expectedN
    var domMatch = expectedN.length > 0 && domNorm === expectedN

    // Duplicate detection: count occurrences of expected in normalized
    // dom text. If >1 the prompt was inserted twice.
    var duplicate = false
    if (expectedN.length >= 2) {
      var escaped = expectedN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      var occurrences = (domNorm.match(new RegExp(escaped, 'g')) || []).length
      if (occurrences > 1) duplicate = true
      // Also detect via slate model — the model is the source of truth.
      if (!duplicate && slateNorm.length > 0) {
        var slateOccurrences = (slateNorm.match(new RegExp(escaped, 'g')) || []).length
        if (slateOccurrences > 1) duplicate = true
      }
    }

    return {
      expected: expectedN,
      slateText: slateText,
      domText: domText,
      slateMatch: slateMatch,
      domMatch: domMatch,
      duplicate: duplicate,
      exactMatch: slateMatch || domMatch,
    }
  }

  function insertText(text: string): { success: boolean; method: string; verified: boolean; strategy: string; skipped?: boolean; compare?: ReturnType<typeof compareEditorText> } {
    var el = findEditorElement()
    if (!el) return { success: false, method: 'noElement', verified: false, strategy: '' }

    var editorResult = findSlateEditor(el)
    var editor = editorResult ? editorResult.editor : null
    var isSlate = editorResult ? editorResult.isSlateObject : false

    bridgeDebug('[Bridge] insertText: el found=' + !!el + ' editor found=' + !!editor + ' isSlate=' + isSlate)
    bridgeDebug('[Bridge] insertText: strategy=' + (editorResult ? editorResult.strategy : 'DOM_FALLBACK'))

    // Focus the element
    try { el.focus() } catch (_) {}

    // ── IDEMPOTENCY GUARD ─────────────────────────────────────────────
    // Before any Slate / DOM insert, check whether the editor ALREADY
    // contains the expected prompt. If yes, no-op — we MUST NOT call
    // editor.insertText a second time. The previous version did
    // `trySlateInsert → verify (failed) → retry trySlateInsert`, which
    // produced a duplicate prompt when the first insert succeeded but
    // Slate hadn't reconciled by the time verify ran.
    var preCompare = compareEditorText(editor, el, text)
    if (preCompare.exactMatch) {
      bridgeLog('[Bridge][INSERT_SKIP_ALREADY_PRESENT] expected="' + preCompare.expected + '" domText="' + preCompare.domText.substring(0, 60) + '" slateText="' + preCompare.slateText.substring(0, 60) + '"')
      return {
        success: true,
        method: 'idempotent_skip',
        verified: true,
        strategy: editorResult ? editorResult.strategy : '',
        skipped: true,
        compare: preCompare,
      }
    }
    if (preCompare.duplicate) {
      bridgeError('[Bridge][INSERT_PRE_DUPLICATE_DETECTED] expected="' + preCompare.expected + '" domText="' + preCompare.domText.substring(0, 120) + '" slateText="' + preCompare.slateText.substring(0, 120) + '"')
      // Duplicate is already present — return success without inserting
      // again. Caller (flow-content.ts) will see exactMatch=true and the
      // downstream verify step will pass. We DO NOT attempt to clean
      // up the duplicate here; that's a state-flow concern, not a bridge
      // concern. A duplicate is the right state for "the text we wanted
      // IS there, just doubled" — better to ship it than to wipe a clean
      // slate and re-insert into a possibly stale editor reference.
      return {
        success: true,
        method: 'idempotent_skip_duplicate',
        verified: false,
        strategy: editorResult ? editorResult.strategy : '',
        skipped: true,
        compare: preCompare,
      }
    }

    // Try Slate API first if we have a Slate object
    var slateMethod: string | null = null
    if (editor) {
      slateMethod = trySlateInsert(editor, text)
      if (slateMethod) {
        // ── POST-INSERT IDEMPOTENCY CHECK ─────────────────────────────
        // Slate's `insertText` is asynchronous w.r.t. its reconciliation
        // pipeline. Wait a microtask then compare BEFORE calling verifyText,
        // because verifyText's placeholderGone fallback can pass even on
        // empty text. If the prompt is now present exactly, return success
        // immediately. If it's duplicate, we still return success (the
        // text IS there) but flag `verified: false` and `compare.duplicate`
        // so flow-content.ts's strict verify can fail the run rather than
        // re-inserting a third time.
        var postCompare = compareEditorText(editor, el, text)
        if (postCompare.exactMatch && !postCompare.duplicate) {
          bridgeLog('[Bridge] insertText SUCCESS via Slate (post-compare): ' + slateMethod)
          return {
            success: true,
            method: slateMethod,
            verified: true,
            strategy: editorResult!.strategy,
            compare: postCompare,
          }
        }
        if (postCompare.duplicate) {
          bridgeError('[Bridge][INSERT_DUPLICATE_DETECTED] expected="' + postCompare.expected + '" domText="' + postCompare.domText.substring(0, 120) + '"')
          return {
            success: true,
            method: slateMethod,
            verified: false,
            strategy: editorResult!.strategy,
            compare: postCompare,
          }
        }
        // Not present yet — fall back to verifyText for the old sample
        // check; if that fails, retry Slate.
        var verified = verifyText(editor, el, text)
        if (verified) {
          bridgeDebug('[Bridge] insertText SUCCESS via Slate: ' + slateMethod)
          return {
            success: true,
            method: slateMethod,
            verified: true,
            strategy: editorResult!.strategy,
            compare: postCompare,
          }
        }
        bridgeWarn('[Bridge] Slate insert returned but verify failed — re-check before retry')
        // ── PRE-RETRY IDEMPOTENCY CHECK ──────────────────────────────
        // Slate reconciliation may have completed after verify failed.
        // Compare again before retrying to avoid a second insert.
        var preRetryCompare = compareEditorText(editor, el, text)
        if (preRetryCompare.exactMatch && !preRetryCompare.duplicate) {
          bridgeLog('[Bridge] insertText SUCCESS via Slate (delayed reconciliation): ' + slateMethod)
          return {
            success: true,
            method: slateMethod,
            verified: true,
            strategy: editorResult!.strategy,
            compare: preRetryCompare,
          }
        }
        if (preRetryCompare.duplicate) {
          bridgeError('[Bridge][INSERT_DUPLICATE_DETECTED_BEFORE_RETRY] expected="' + preRetryCompare.expected + '"')
          return {
            success: true,
            method: slateMethod,
            verified: false,
            strategy: editorResult!.strategy,
            compare: preRetryCompare,
          }
        }
        // Safe to retry Slate — text truly is missing.
        slateMethod = trySlateInsert(editor, text)
        if (slateMethod) {
          var postRetryCompare = compareEditorText(editor, el, text)
          if (postRetryCompare.exactMatch) {
            bridgeDebug('[Bridge] insertText SUCCESS via Slate retry: ' + slateMethod)
            return {
              success: true,
              method: slateMethod,
              verified: true,
              strategy: editorResult!.strategy,
              compare: postRetryCompare,
            }
          }
          if (postRetryCompare.duplicate) {
            bridgeError('[Bridge][INSERT_DUPLICATE_AFTER_RETRY] expected="' + postRetryCompare.expected + '"')
            return {
              success: true,
              method: slateMethod,
              verified: false,
              strategy: editorResult!.strategy,
              compare: postRetryCompare,
            }
          }
          // Final sample-match check — keep legacy behavior for cases
          // where exactMatch fails but partial sample matches (e.g.
          // Flow inserted a trailing space).
          var verified2 = verifyText(editor, el, text)
          if (verified2) {
            bridgeDebug('[Bridge] insertText SUCCESS via Slate retry (sample-match): ' + slateMethod)
            return {
              success: true,
              method: slateMethod,
              verified: true,
              strategy: editorResult!.strategy,
              compare: postRetryCompare,
            }
          }
        }
      }
    }

    // DOM fallback: only when NO Slate editor found
    if (!editor) {
      bridgeDebug('[Bridge] Falling back to DOM insert (no Slate editor)')
      var domOk = insertTextDomFallback(el, text)
      var domCompare = compareEditorText(null, el, text)
      if (domCompare.exactMatch) {
        bridgeLog('[Bridge] insertText SUCCESS via DOM (post-compare)')
        return {
          success: true,
          method: 'DOM_FALLBACK',
          verified: true,
          strategy: 'DOM_ONLY',
          compare: domCompare,
        }
      }
      if (domOk) {
        // DOM_OK with no exact match is the legacy sample-match path.
        // Still return success but flag verified=false so strict verify
        // can fail downstream.
        bridgeDebug('[Bridge] insertText SUCCESS via DOM (legacy sample-match)')
        return {
          success: true,
          method: 'DOM_FALLBACK',
          verified: false,
          strategy: 'DOM_ONLY',
          compare: domCompare,
        }
      }
    }

    bridgeDebug('[Bridge] insertText FAILED')
    var finalCompare = compareEditorText(editor, el, text)
    return {
      success: false,
      method: slateMethod || 'none',
      verified: false,
      strategy: editorResult ? editorResult.strategy : '',
      compare: finalCompare,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MASTER CLEAR
  // ═══════════════════════════════════════════════════════════════

  function clearEditor(): { success: boolean; method: string; strategy: string } {
    var el = findEditorElement()
    if (!el) return { success: false, method: 'noElement', strategy: '' }

    var editorResult = findSlateEditor(el)
    var editor = editorResult ? editorResult.editor : null
    var hasSlateEditor = !!(editor && editorResult && editorResult.isSlateObject)

    bridgeDebug('[Bridge] clearEditor: el found=' + !!el + ' editor found=' + !!editor + ' isSlate=' + hasSlateEditor)

    // ── Slate path: NEVER touch DOM ─────────────────────────────────
    if (hasSlateEditor) {
      var slateMethod: string | null = null

      // Tier A: editor.deleteFragment()
      try {
        if (typeof (editor as Record<string, unknown>).deleteFragment === 'function') {
          bridgeDebug('[Bridge] CLEAR[editor.deleteFragment] try')
          ;(editor as Record<string, unknown>).deleteFragment()
          if (typeof (editor as Record<string, unknown>).onChange === 'function') {
            ((editor as Record<string, unknown>).onChange as () => void)()
          }
          slateMethod = 'editor.deleteFragment'
          bridgeDebug('[Bridge] CLEAR[editor.deleteFragment] OK')
        }
      } catch (e) {
        bridgeWarn('[Bridge] CLEAR[editor.deleteFragment] error:', e)
      }

      // Tier B: editor.apply(remove_text) — loop all children
      if (!slateMethod) {
        try {
          if (typeof (editor as Record<string, unknown>).apply === 'function' && Array.isArray(editor.children) && editor.children.length > 0) {
            bridgeDebug('[Bridge] CLEAR[editor.apply(remove_text)] try, children=' + editor.children.length)
            while (editor.children.length > 0) {
              var node = editor.children[editor.children.length - 1]
              ;(editor as Record<string, unknown>).apply({
                type: 'remove_node',
                path: [editor.children.length - 1],
                node: node
              })
            }
            if (typeof (editor as Record<string, unknown>).onChange === 'function') {
              ((editor as Record<string, unknown>).onChange as () => void)()
            }
            slateMethod = 'editor.apply(remove_text)'
            bridgeDebug('[Bridge] CLEAR[editor.apply(remove_text)] OK')
          }
        } catch (e) {
          bridgeWarn('[Bridge] CLEAR[editor.apply(remove_text)] error:', e)
        }
      }

      // Tier C: slate-reset via set_node
      if (!slateMethod) {
        try {
          if (typeof (editor as Record<string, unknown>).apply === 'function') {
            bridgeDebug('[Bridge] CLEAR[slate-reset] try')
            if (editor.children.length > 0) {
              ;(editor as Record<string, unknown>).apply({
                type: 'set_node',
                path: [0],
                node: { type: 'paragraph', children: [{ text: '' }] }
              })
              for (var ri = editor.children.length - 1; ri >= 1; ri--) {
                ;(editor as Record<string, unknown>).apply({
                  type: 'remove_node',
                  path: [ri],
                  node: editor.children[ri]
                })
              }
            }
            if (typeof (editor as Record<string, unknown>).onChange === 'function') {
              ((editor as Record<string, unknown>).onChange as () => void)()
            }
            slateMethod = 'slate-reset'
            bridgeDebug('[Bridge] CLEAR[slate-reset] OK')
          }
        } catch (e) {
          bridgeWarn('[Bridge] CLEAR[slate-reset] error:', e)
        }
      }

      // Verify via Slate model
      var slateText = ''
      try { slateText = getAllText(editor) } catch (_) {}
      var isEmpty = slateText.trim().length === 0

      bridgeDebug('[Bridge] clearEditor Slate: method=' + slateMethod + ' isEmpty=' + isEmpty + ' text="' + slateText + '"')

      if (slateMethod) {
        bridgeDebug('[Bridge] clearEditor SUCCESS via Slate (' + slateMethod + ')')
        return { success: true, method: slateMethod, strategy: editorResult!.strategy }
      }

      bridgeDebug('[Bridge] clearEditor Slate failed — no DOM fallback for Slate editors')
      return { success: false, method: 'none', strategy: editorResult!.strategy }
    }

    // ── DOM fallback: only when no Slate editor found ───────────────
    bridgeDebug('[Bridge] clearEditor: no Slate editor, using DOM fallback')
    var domOk = clearDomFallback(el)
    var isEmpty = (el.textContent || '').trim().length === 0

    if (isEmpty || domOk) {
      bridgeDebug('[Bridge] clearEditor SUCCESS via DOM')
      return { success: true, method: 'DOM_FALLBACK', strategy: 'DOM_ONLY' }
    }

    return { success: false, method: 'DOM_FALLBACK', strategy: 'DOM_ONLY' }
  }

  // ═══════════════════════════════════════════════════════════════
  // VERIFY
  // ═══════════════════════════════════════════════════════════════

  function verifyEditor(): Record<string, unknown> {
    var el = findEditorElement()
    if (!el) {
      return {
        slateEditorFound: false,
        slateEditorObjectFound: false,
        editableText: '',
        placeholderVisible: true,
        candidateScore: 0,
        candidatePath: '',
        url: window.location.href
      }
    }

    var editorResult = findSlateEditor(el)
    var editor = editorResult ? editorResult.editor : null
    var info = getEditorText(editor || {}, el)

    var phVisible = true
    try {
      var ph = el.querySelector('[data-slate-placeholder]')
      phVisible = !!ph
      if (!ph && el.parentElement) {
        var phSib = el.parentElement.querySelector('[data-slate-placeholder]')
        phVisible = !!phSib
      }
    } catch (_) {}

    return {
      slateEditorFound: true,
      slateEditorObjectFound: !!(editorResult && editorResult.isSlateObject),
      editableText: info.domText.substring(0, 200),
      placeholderVisible: phVisible,
      placeholderGone: !phVisible,
      candidateScore: editorResult ? editorResult.editor.score : 0,
      candidatePath: editorResult ? editorResult.strategy : '',
      hasContent: info.domText.trim().length > 0,
      url: window.location.href
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // DOM SCAN REPORT
  // ═══════════════════════════════════════════════════════════════

  function scanDOMReport(): Record<string, unknown> {
    var report: Record<string, unknown> = {
      url: window.location.href,
      timestamp: Date.now(),
      editableCandidates: [],
      buttons: [],
      svgs: [],
      foundElement: null
    }

    // Editor element
    var el = findEditorElement()
    if (el) {
      var rfKeys: string[] = []
      getOwnEnumerableKeys(el).forEach(function (k) {
        if (k.startsWith('__react')) rfKeys.push(k)
      })
      ;(report as Record<string, unknown>).foundElement = {
        tag: el.tagName,
        id: el.id,
        className: (el.className || '').toString().substring(0, 120),
        role: el.getAttribute('role') || '',
        contenteditable: el.getAttribute('contenteditable'),
        'data-slate-editor': el.getAttribute('data-slate-editor'),
        textContent: (el.textContent || '').trim().substring(0, 80),
        reactFiberKeys: rfKeys,
        outerHTML: el.outerHTML.substring(0, 400)
      }

      // Run deep scan and include results
      var keys = getFiberKeys(el)
      var visited = new WeakSet()
      var results: EditorCandidate[] = []
      for (var ki = 0; ki < keys.length; ki++) {
        deepScanForEditor(keys[ki].fiber, keys[ki].key, 0, visited, results, { maxDepth: 12 })
      }
      if (results.length > 0) {
        results.sort(function (a, b) { return b.score - a.score })
        ;(report as Record<string, unknown>).scanResults = results.map(function (r) {
          return {
            score: r.score,
            path: r.path,
            depth: r.depth,
            hasInsertText: r.hasInsertText,
            hasApply: r.hasApply,
            hasChildren: r.hasChildren,
            hasSelection: r.hasSelection,
            hasOnChange: r.hasOnChange,
            childrenPreview: r.childrenPreview,
            keys: r.keys.slice(0, 30)
          }
        })
      }
    }

    // Buttons
    try {
      var btns = document.querySelectorAll('button, [role="button"]')
      var btnList: Record<string, unknown>[] = []
      btns.forEach(function (b, i) {
        var rect = (() => { try { return b.getBoundingClientRect() } catch (_) { return null } })()
        var svg = b.querySelector('svg')
        var pathD = svg ? (svg.querySelector('path') ? (svg.querySelector('path') as HTMLElement).getAttribute('d') || '' : '') : ''
        btnList.push({
          index: i,
          tag: b.tagName,
          text: (b.textContent || '').trim().substring(0, 80),
          'aria-label': b.getAttribute('aria-label') || '',
          'data-testid': b.getAttribute('data-testid') || '',
          disabled: (b as HTMLButtonElement).disabled,
          svgPath: pathD.substring(0, 80),
          rect: rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right), bottomDist: Math.round(window.innerHeight - rect.bottom) } : null,
          outerHTML: b.outerHTML.substring(0, 200)
        })
      })
      ;(report as Record<string, unknown>).buttons = btnList
    } catch (_) {}

    return report
  }

  // ═══════════════════════════════════════════════════════════════
  // SUBMIT
  // ═══════════════════════════════════════════════════════════════

  function getReactPropsKeys(el: HTMLElement): string[] {
    var keys: string[] = []
    try {
      var allKeys = Object.keys(el)
      for (var ki = 0; ki < allKeys.length; ki++) {
        var k = allKeys[ki]
        if (k.startsWith('__reactProps$')) keys.push(k)
      }
    } catch (_) {}
    return keys
  }

  function getReactFiberPropsKeys(el: HTMLElement): string[] {
    var keys: string[] = []
    try {
      var allKeys = Object.keys(el)
      for (var ki = 0; ki < allKeys.length; ki++) {
        var k = allKeys[ki]
        if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) keys.push(k)
      }
    } catch (_) {}
    return keys
  }

  function findSubmitButton(el: HTMLElement): { btn: HTMLElement | null; reason: string } {
    var editorRect: DOMRect | null = null
    try { editorRect = el.getBoundingClientRect() } catch (_) {}

    interface Candidate {
      el: HTMLElement
      score: number
      method: string
      rejectReason: string
      rect: DOMRect
      txt: string
      dt: string
    }
    var candidates: Candidate[] = []

    var allBtns = document.querySelectorAll('button:not([disabled]), [role="button"]:not([disabled])')
    allBtns.forEach(function (btn) {
      var b = btn as HTMLElement
      var txt = (b.textContent || '').trim()
      var txtL = safeLower(txt)
      var al = safeLower(b.getAttribute('aria-label'))
      var dt = safeLower(b.getAttribute('data-testid'))
      var rejectReason = ''

      // ── Hard reject ──────────────────────────────────────────────
      // Exclude menus, dialogs, sidebars
      var negTexts = [
        'tác nhân', 'bắt đầu', 'kết thúc', 'gần đây', 'thành phần',
        'hành động', 'trigger', 'agent', 'gợi ý', 'mẫu', 'gần đây',
        'menu', 'settings', 'cài đặt', 'tùy chọn', 'option'
      ]
      for (var ni = 0; ni < negTexts.length; ni++) {
        if (txtL.includes(negTexts[ni])) {
          rejectReason = 'neg-text:' + negTexts[ni]
          return
        }
      }
      // Exclude add/plus buttons
      if (txtL === '+' || txtL === 'add' || txtL === 'thêm' || dt.includes('add') || dt.includes('plus')) {
        rejectReason = 'neg-text:add/plus'
        return
      }
      // Exclude media type buttons
      var mediaTypes = ['image', 'video', 'ảnh', 'video', 'hình']
      for (var mi = 0; mi < mediaTypes.length; mi++) {
        if (txtL === mediaTypes[mi] || al === mediaTypes[mi]) {
          rejectReason = 'neg-text:media-type:' + mediaTypes[mi]
          return
        }
      }

      // ── Score ───────────────────────────────────────────────────
      var score = 0
      var method = ''

      // Circular icon button with arrow_forward SVG
      var svg = b.querySelector('svg')
      if (svg) {
        var allPaths = svg.querySelectorAll('path[d]')
        var pathStr = Array.from(allPaths).map(function (p) { return p.getAttribute('d') || '' }).join(' ').toLowerCase()
        // arrow_forward SVG path: M19 12H5M12 5l7 7-7 7 (roughly)
        if (pathStr.includes('m19') && pathStr.includes('m12')) {
          score += 50
          method = 'arrow-forward-svg'
        }
      }

      // "arrow_forward" in text or aria-label (the Material Icon ligature)
      if (txtL.includes('arrow_forward') || al.includes('arrow_forward')) {
        score += 60
        method = 'arrow-forward-text'
      }

      // "Tạo" keyword — the main generate button text
      var createKw = ['tạo', 'generate', 'create']
      for (var ki = 0; ki < createKw.length; ki++) {
        if (txtL.includes(createKw[ki]) || al.includes(createKw[ki]) || dt.includes(createKw[ki])) {
          score += 40
          method = method || ('keyword:' + createKw[ki])
        }
      }

      // Position: right of editor, same vertical band
      var rect: DOMRect | null = null
      if (editorRect) {
        try {
          rect = b.getBoundingClientRect()
          var vertOverlap = rect.top >= editorRect.top - 50 && rect.top <= editorRect.bottom + 50
          var hGap = rect.left - editorRect.right
          if (hGap > 0 && hGap < 300 && vertOverlap) {
            score += 30
            method = method || 'position-right'
          }
          // Below editor, close to bottom
          if (rect.top > editorRect.top && rect.top < editorRect.bottom + 150 && Math.abs(rect.left - editorRect.left) < 100) {
            score += 15
            method = method || 'position-below'
          }
        } catch (_) {}
      }

      // Circular shape (small width/height, roughly square)
      if (rect) {
        var sizeRatio = Math.min(rect.width, rect.height) / Math.max(rect.width, rect.height, 1)
        if (sizeRatio > 0.6 && rect.width < 48 && rect.height < 48) {
          score += 20
          method = method || 'circular'
        }
      }

      // data-testid with submit/generate/create
      if (dt.includes('submit') || dt.includes('generate') || dt.includes('create') || dt.includes('run')) {
        score += 45
        method = 'data-testid:' + dt
      }

      if (score > 0 && !b.disabled) {
        if (!rect) {
          try { rect = b.getBoundingClientRect() } catch (_) {}
        }
        candidates.push({
          el: b,
          score: score,
          method: method,
          rejectReason: rejectReason,
          rect: rect!,
          txt: txt.substring(0, 60),
          dt: dt
        })
        bridgeDebug('[Bridge] submit candidate: "' + txt.substring(0, 30) + '" score=' + score + ' method=' + method + ' rect=(' + (rect ? Math.round(rect.left) + ',' + Math.round(rect.top) : 'null') + ') rejected=' + (rejectReason ? 'YES:' + rejectReason : 'no'))
      }
    })

    if (candidates.length === 0) {
      bridgeDebug('[Bridge] No submit button candidates found')
      return { btn: null, reason: 'no_candidates' }
    }

    candidates.sort(function (a, b) { return b.score - a.score })
    var best = candidates[0]

    bridgeDebug('[Bridge] BEST submit button: text="' + best.txt + '" score=' + best.score + ' method=' + best.method + ' rect=(' + Math.round(best.rect.left) + ',' + Math.round(best.rect.top) + ' ' + Math.round(best.rect.width) + 'x' + Math.round(best.rect.height) + ')')

    // Confidence gate: must contain arrow_forward or Tạo/create keyword
    var bestTxtL = safeLower(best.txt)
    var hasConfidence = bestTxtL.includes('arrow_forward') || bestTxtL.includes('tạo') || bestTxtL.includes('generate') || bestTxtL.includes('create')
    var bestAl = safeLower(best.el.getAttribute('aria-label'))
    if (bestAl.includes('arrow_forward') || bestAl.includes('tạo') || bestAl.includes('generate') || bestAl.includes('create')) {
      hasConfidence = true
    }

    if (!hasConfidence) {
      bridgeDebug('[Bridge] Best candidate lacks confidence keywords: "' + best.txt + '"')
      return { btn: null, reason: 'submit_button_not_confident' }
    }

    return { btn: best.el, reason: 'ok' }
  }

  function clickSubmitButton(btn: HTMLElement): string | null {
    bridgeDebug('[Bridge] clickSubmitButton, el=' + btn.tagName + ' text="' + (btn.textContent || '').trim().substring(0, 30) + '"')

    // Strategy 1: React onClick via __reactProps$
    var propsKeys = getReactPropsKeys(btn)
    for (var pi = 0; pi < propsKeys.length; pi++) {
      var pk = propsKeys[pi]
      try {
        var props = (btn as Record<string, unknown>)[pk] as Record<string, unknown>
        if (props && typeof props.onClick === 'function') {
          bridgeDebug('[Bridge] CLICK[__reactProps$.onClick] try')
          var rect = btn.getBoundingClientRect()
          var fakeEvent: Record<string, unknown> = {
            preventDefault: function () {},
            stopPropagation: function () {},
            persist: function () {},
            nativeEvent: { isTrusted: true },
            isTrusted: true,
            target: btn,
            currentTarget: btn,
            bubbles: true,
            cancelable: true,
            defaultPrevented: false,
            eventPhase: 3,
            timeStamp: Date.now(),
            type: 'click',
            button: 0,
            buttons: 1,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2
          }
          try { (props.onClick as (e: unknown) => void)(fakeEvent) } catch (_) {}
          bridgeDebug('[Bridge] CLICK[__reactProps$.onClick] OK')
          return '__reactProps.onClick'
        }
      } catch (_) {}
    }

    // Strategy 2: React onClick via fiber (memoizedProps / pendingProps)
    var fiberKeys = getReactFiberPropsKeys(btn)
    for (var fi = 0; fi < fiberKeys.length; fi++) {
      var fk = fiberKeys[fi]
      try {
        var fiber = (btn as Record<string, unknown>)[fk] as Record<string, unknown>
        var depth = 0
        var cur = fiber
        while (cur && depth < 60) {
          // memoizedProps.onClick
          if ((cur.memoizedProps as Record<string, unknown>) && typeof (cur.memoizedProps as Record<string, unknown>).onClick === 'function') {
            bridgeDebug('[Bridge] CLICK[memoizedProps.onClick] try')
            try { ((cur.memoizedProps as Record<string, unknown>).onClick as (e: unknown) => void)({}) } catch (_) {}
            bridgeDebug('[Bridge] CLICK[memoizedProps.onClick] OK')
            return 'memoizedProps.onClick'
          }
          // pendingProps.onClick
          if ((cur.pendingProps as Record<string, unknown>) && typeof (cur.pendingProps as Record<string, unknown>).onClick === 'function') {
            bridgeDebug('[Bridge] CLICK[pendingProps.onClick] try')
            try { ((cur.pendingProps as Record<string, unknown>).onClick as (e: unknown) => void)({}) } catch (_) {}
            bridgeDebug('[Bridge] CLICK[pendingProps.onClick] OK')
            return 'pendingProps.onClick'
          }
          // stateNode.onClick
          if ((cur.stateNode as Record<string, unknown>) && typeof (cur.stateNode as Record<string, unknown>).onClick === 'function') {
            bridgeDebug('[Bridge] CLICK[stateNode.onClick] try')
            try { ((cur.stateNode as Record<string, unknown>).onClick as (e: unknown) => void)({}) } catch (_) {}
            bridgeDebug('[Bridge] CLICK[stateNode.onClick] OK')
            return 'stateNode.onClick'
          }
          cur = cur.return as Record<string, unknown>
          depth++
        }
      } catch (_) {}
    }

    // Strategy 3: button.click()
    bridgeDebug('[Bridge] CLICK[button.click()] fallback')
    try {
      btn.click()
      bridgeDebug('[Bridge] CLICK[button.click()] OK')
      return 'button.click'
    } catch (e) {
      bridgeWarn('[Bridge] CLICK[button.click()] error:', e)
    }

    // Strategy 4: dispatchEvent mouseclick
    try {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }))
      bridgeDebug('[Bridge] CLICK[dispatchEvent] OK')
      return 'dispatchEvent'
    } catch (e) {
      bridgeWarn('[Bridge] CLICK[dispatchEvent] error:', e)
    }

    return null
  }

  function submit(): { success: boolean; method: string | null; buttonText: string; error: string } {
    bridgeLog('[Bridge] submit START')

    var el = findEditorElement()
    if (!el) return { success: false, method: null, buttonText: '', error: 'Editor element not found' }

    var editorResult = findSlateEditor(el)
    var editor = editorResult ? editorResult.editor : null

    // Verify content exists
    var info = getEditorText(editor || {}, el)
    var hasContent = info.domText.trim().length > 0 || info.slateText.trim().length > 0
    bridgeLog('[Bridge] submit: hasContent=' + hasContent + ' domText len=' + info.domText.length)

    if (!hasContent) {
      bridgeDebug('[Bridge] submit: editor empty, cannot submit')
      return { success: false, method: null, buttonText: '', error: 'Editor empty — insert text first' }
    }

    // Scan for submit button (re-scan after insert — it may have become enabled)
    var btnResult = findSubmitButton(el)
    if (!btnResult.btn) {
      bridgeDebug('[Bridge] submit: no button found, reason=' + btnResult.reason)
      if (btnResult.reason === 'submit_button_not_confident') {
        return { success: false, method: null, buttonText: '', error: 'submit_button_not_confident' }
      }
      return { success: false, method: null, buttonText: '', error: 'Submit button not found' }
    }

    var btn = btnResult.btn
    var btnText = (btn.textContent || '').trim().substring(0, 40)
    bridgeLog('[Bridge] submit: button found, text="' + btnText + '" disabled=' + btn.disabled)

    var method = clickSubmitButton(btn)
    if (method) {
      bridgeLog('[Bridge] submit SUCCESS via ' + method)
      return { success: true, method: method, buttonText: btnText, error: '' }
    }

    bridgeWarn('[Bridge] submit FAILED — all click methods failed')
    return { success: false, method: null, buttonText: btnText, error: 'All click methods failed' }
  }

  // ═══════════════════════════════════════════════════════════════
  // GOOGLE FLOW — DOM-first editor + submit button discovery
  // ═══════════════════════════════════════════════════════════════
  //
  // The existing findEditorElement() / insertText() / submit() helpers
  // rely on Slate's React Fiber being reachable. On the current Google
  // Flow composer the Slate instance is not always reachable through the
  // editor element's fiber chain — but the DOM contenteditable is
  // mounted, the Tạo button is rendered, and `document.execCommand(
  // 'insertText', false, prompt)` correctly drives Flow's onChange.
  //
  // These helpers are a DOM-first, selector-first fallback path that
  // only uses Flow's native DOM API + execCommand. They are wired up via
  // a NEW bridge action (`submitGoogleFlow`) so we do NOT touch the
  // existing Slate / submit pipeline that other flows depend on.

  function findGoogleFlowEditor(): HTMLElement | null {
    var selectors = [
      '[data-slate-editor="true"][contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
      '[aria-multiline="true"][contenteditable="true"]',
      '[contenteditable="true"]',
    ]

    for (var si = 0; si < selectors.length; si++) {
      try {
        var found = Array.from(document.querySelectorAll(selectors[si]))
          .find(function (el) { return isVisible(el as HTMLElement) }) as HTMLElement | undefined
        if (found) return found
      } catch (_) {}
    }

    return null
  }

  async function insertGoogleFlowPrompt(prompt: string): Promise<boolean> {
    var editor = findGoogleFlowEditor()

    if (!editor) {
      console.warn('[Flow][GFlow] FLOW_EDITOR_NOT_FOUND')
      return false
    }

    try { editor.scrollIntoView({ block: 'center', inline: 'center' }) } catch (_) {}
    try { editor.click() } catch (_) {}
    try { editor.focus() } catch (_) {}

    await sleep(100)

    var selection = window.getSelection()
    var range = document.createRange()
    range.selectNodeContents(editor)
    selection?.removeAllRanges()
    selection?.addRange(range)

    try { document.execCommand('delete', false) } catch (_) {}

    await sleep(80)

    var range2 = document.createRange()
    range2.selectNodeContents(editor)
    range2.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range2)

    var ok = false
    try {
      ok = document.execCommand('insertText', false, prompt)
    } catch (_) {
      ok = false
    }

    try {
      editor.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: prompt,
      }))
    } catch (_) {}

    try {
      editor.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: prompt,
      }))
    } catch (_) {
      try {
        editor.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))
      } catch (_) {}
    }

    await sleep(300)

    var text = normalizeText(editor.innerText || editor.textContent || '')
    if (!text.includes(normalizeText(prompt))) {
      console.warn('[Flow][GFlow] FLOW_PROMPT_INSERT_FAILED', JSON.stringify({
        ok: ok,
        expected: prompt,
        actual: text,
      }))
      return false
    }

    console.log('[Flow][GFlow] prompt inserted verified')
    return true
  }

  function findGoogleFlowCreateButton(): HTMLElement | null {
    var candidates: HTMLElement[] = []
    try {
      candidates = Array.from(document.querySelectorAll('button,[role="button"]'))
        .filter(function (el) { return isVisible(el as HTMLElement) }) as HTMLElement[]
    } catch (_) {
      return null
    }

    for (var ci = 0; ci < candidates.length; ci++) {
      var el = candidates[ci]
      var text = normalizeText(el.innerText || el.textContent || '')
      var aria = normalizeText(el.getAttribute('aria-label') || '')
      if (/arrow_forward\s*Tạo|^Tạo$|Create|Generate/i.test(text + ' ' + aria)) {
        return el
      }
    }
    return null
  }

  async function waitGoogleFlowCreateButtonEnabled(timeoutMs = 5000): Promise<HTMLElement | null> {
    var start = Date.now()
    while (Date.now() - start < timeoutMs) {
      var btn = findGoogleFlowCreateButton()
      if (btn && !(btn as HTMLButtonElement).disabled && btn.getAttribute('aria-disabled') !== 'true') {
        return btn
      }
      await sleep(100)
    }
    return null
  }

  // DOM-first submit pipeline for the current Google Flow composer.
  // Inserts the prompt via execCommand, then clicks the visible Tạo button.
  // This is independent from the existing submit() / insertText() Slate
  // path and exists ONLY for the case where the Slate editor object is
  // not reachable through React fiber.
  //
  // Production code MUST NOT use this combined path: it bypasses the
  // pre-submit tile snapshot boundary and breaks the auto-download loop.
  // Production fallbacks call `insertGoogleFlowPromptOnly` (insert step)
  // and `submitGoogleFlowButtonOnly` (submit step) separately so that
  // the pre-submit baseline is still captured before the Tạo button is
  // clicked. This combined helper exists ONLY for manual smoke testing
  // via `window.__flowTestSubmitGoogleFlow(text)` in the Flow page console.
  async function submitGoogleFlow(prompt: string): Promise<{ ok: boolean; reason?: string; method?: string }> {
    var inserted = await insertGoogleFlowPrompt(prompt)
    if (!inserted) {
      return { ok: false, reason: 'FLOW_PROMPT_INSERT_FAILED' }
    }

    var createButton = await waitGoogleFlowCreateButtonEnabled(5000)
    if (!createButton) {
      return { ok: false, reason: 'FLOW_SUBMIT_BUTTON_NOT_FOUND_OR_DISABLED' }
    }

    try { createButton.scrollIntoView({ block: 'center', inline: 'center' }) } catch (_) {}
    await sleep(100)
    try { createButton.click() } catch (_) {}

    console.log('[Flow][GFlow] submitted')
    return { ok: true, method: 'gflow-dom-submit' }
  }

  // Insert-only DOM fallback for the current Google Flow composer.
  // Returns success/failure with a `method` field so the caller can
  // synthesize a normal insertResult and continue the standard pipeline
  // (verify → pre-submit baseline → submit → auto-download).
  //
  // This helper does NOT click Tạo. The submit step remains a separate
  // boundary so the auto-download polling loop can still capture a
  // pre-submit tile snapshot.
  async function insertGoogleFlowPromptOnly(prompt: string): Promise<{ success: boolean; method?: string; error?: string }> {
    var ok = await insertGoogleFlowPrompt(prompt)
    if (!ok) {
      return { success: false, error: 'FLOW_PROMPT_INSERT_FAILED' }
    }
    return { success: true, method: 'gflow-dom-insert' }
  }

  // Submit-only DOM fallback for the current Google Flow composer.
  // Locates the Tạo button and clicks it. Does NOT touch the editor.
  //
  // Production usage: when the standard `submit` Slate path fails,
  // flow-content calls this as a last-resort click while still passing
  // the post-submit baseline to the auto-download loop.
  async function submitGoogleFlowButtonOnly(): Promise<{ success: boolean; method?: string; error?: string }> {
    var createButton = await waitGoogleFlowCreateButtonEnabled(5000)
    if (!createButton) {
      return { success: false, error: 'FLOW_SUBMIT_BUTTON_NOT_FOUND_OR_DISABLED' }
    }
    try { createButton.scrollIntoView({ block: 'center', inline: 'center' }) } catch (_) {}
    await sleep(100)
    try { createButton.click() } catch (_) {}
    console.log('[Flow][GFlow] submitted')
    return { success: true, method: 'gflow-dom-click' }
  }

  // ═══════════════════════════════════════════════════════════════
  // ADD FILE TO PROMPT (right-click tile → "Add to prompt")
  // ═══════════════════════════════════════════════════════════════

  async function addFileToPrompt(fileId: string, fileName: string): Promise<{ success: boolean; method: string; error: string }> {
    bridgeLog('[Bridge][ADD_REF_LOOKUP] id=' + fileId + ' fileName="' + fileName + '"')

    // REJECT upload_xxx — these must be resolved to real tileIds before reaching bridge
    if (fileId.startsWith('upload_')) {
      bridgeWarn('[Bridge] addFileToPrompt: REJECTED upload_xxx key="' + fileId + '" — must be resolved before FlowContent')
      return { success: false, method: 'upload_xxx_rejected', error: 'UNRESOLVED_UPLOAD_KEY: ' + fileId }
    }

    // ── Step 1: Find tile by fileName FIRST (identity-based lookup) ─────
    // This is the ONLY safe way. The id can be stale (re-mounted by Flow)
    // while the fileName stays stable.
    var tile: HTMLElement | null = null
    var lookupMethod = ''
    if (fileName && fileName.length >= 4 && fileName !== 'media.getMediaUrlRedirect') {
      tile = findTileElementByFileName(fileName)
      if (tile) {
        lookupMethod = 'fileName'
        bridgeLog('[Bridge][ADD_REF_SELECTED] tileId=' + (tile.dataset.tileId || '') + ' fileName=' + fileName + ' method=fileName')
      }
    }

    // ── Step 2: Fallback to id lookup, but VALIDATE the id actually maps
    //    to a tile whose fileName matches what we expect. If the id's
    //    fileName doesn't match, the id is stale — search by fileName.
    if (!tile) {
      var idCandidate = document.querySelector('[data-tile-id="' + CSS.escape(fileId) + '"]') as HTMLElement | null
      if (idCandidate) {
        var validation = validateTileFileName(idCandidate, fileName)
        if (validation.ok) {
          tile = idCandidate
          lookupMethod = 'validatedId'
          bridgeLog('[Bridge][ADD_REF_SELECTED] tileId=' + fileId + ' fileName=' + (validation.actualFileName || fileName) + ' method=validatedId')
        } else {
          // id maps to a tile with a DIFFERENT fileName → id collision /
          // stale id. Re-search by fileName as a final attempt.
          bridgeWarn('[Bridge][ADD_REF_REJECT_ID_MISMATCH] fileId=' + fileId + ' expectedFileName=' + fileName + ' actualFileName=' + (validation.actualFileName || '(empty)'))
          if (fileName && fileName.length >= 4) {
            tile = findTileElementByFileName(fileName)
            if (tile) {
              lookupMethod = 'fileName'
              bridgeLog('[Bridge][ADD_REF_SELECTED] tileId=' + (tile.dataset.tileId || '') + ' fileName=' + fileName + ' method=fileName-after-rejected-id')
            }
          }
        }
      }
    }

    if (!tile) {
      bridgeWarn('[Bridge] addFileToPrompt: FLOW_REF_TILE_NOT_FOUND_BY_IDENTITY — fileId=' + fileId + ' fileName="' + fileName + '"')
      return { success: false, method: 'tile_not_found_by_identity', error: 'FLOW_REF_TILE_NOT_FOUND_BY_IDENTITY: ' + fileName }
    }

    // Scroll tile into view
    tile.scrollIntoView({ behavior: 'smooth', block: 'center' })
    await sleep(300)

    // Find the image inside the tile for right-click
    var tileImg: HTMLElement | null = (tile.tagName === 'IMG' ? tile : tile.querySelector('img')) as HTMLElement | null
    if (!tileImg) {
      bridgeWarn('[Bridge] addFileToPrompt: no img found in tile')
      return { success: false, method: 'no_img_in_tile', error: 'No image element found inside tile' }
    }

    var rect = tileImg.getBoundingClientRect()
    var x = rect.left + rect.width / 2
    var y = rect.top + rect.height / 2

    // Strategy A: contextmenu event
    var ctxResult = await tryAddRefViaContextMenu(tileImg, x, y)
    if (ctxResult.success) {
      bridgeLog('[Bridge][ADD_REF_DONE] success=true method=contextmenu lookupMethod=' + lookupMethod)
      return { success: true, method: 'contextmenu', error: '' }
    }

    // Strategy B: drag-and-drop image to editor
    var dragResult = await tryAddRefViaDrag(tileImg, x, y)
    if (dragResult.success) {
      bridgeLog('[Bridge][ADD_REF_DONE] success=true method=drag lookupMethod=' + lookupMethod)
      return { success: true, method: 'drag', error: '' }
    }

    // All strategies exhausted
    bridgeWarn('[Bridge] addFileToPrompt: all strategies failed for id=' + fileId)
    return { success: false, method: 'all_strategies_failed', error: 'Could not add file to prompt' }
  }

  async function tryAddRefViaContextMenu(imgEl: HTMLElement, x: number, y: number): Promise<{ success: boolean; method: string; error: string }> {
    bridgeDebug('[Bridge][addRef] context menu opened false')

    // Dispatch contextmenu on the image
    var ctxEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 2,
    })
    imgEl.dispatchEvent(ctxEvent)
    bridgeDebug('[Bridge][addRef] contextmenu dispatched at (' + x.toFixed(0) + ',' + y.toFixed(0) + ')')

    // Wait for menu to appear (Flow uses Radix popover/menu)
    var menuItemFound = false
    var matchedItem: HTMLElement | null = null
    var retries = 10
    for (var ri = 0; ri < retries; ri++) {
      await sleep(200)
      var menu = document.querySelector('[role="menu"], [role="menuitem"], [class*="menu"], [class*="popover"]') as HTMLElement | null
      if (menu) {
        var items = menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], button')
        for (var mi = 0; mi < items.length; mi++) {
          var itemText = safeText(items[mi].textContent).toLowerCase()
          if (
            itemText.includes('add to prompt') ||
            itemText.includes('thêm vào') ||
            itemText.includes('add to') ||
            itemText.includes('insert into') ||
            itemText.includes('dùng làm')
          ) {
            bridgeLog('[Bridge][addRef] menu item found "' + itemText + '"')
            matchedItem = items[mi] as HTMLElement
            menuItemFound = true
            break
          }
        }
        if (menuItemFound) break
      }
    }

    if (menuItemFound && matchedItem) {
      bridgeDebug('[Bridge][addRef] menu item clicked false')
      // Full event chain: pointerdown → mousedown → pointerup → mouseup → click
      dispatchFullClick(matchedItem)
      // Wait for Flow to process the click and attach the ref
      await sleep(500)
      bridgeDebug('[Bridge][addRef] menu item clicked true')

      // Safe verify: check if ref was attached (log only, never fail the click)
      var refCountBefore = editorRefAttachmentCount()
      await sleep(300)
      var refCountAfter = editorRefAttachmentCount()
      if (refCountAfter <= refCountBefore) {
        bridgeDebug('[Bridge][addRef] verify: ref count did not increase (before=' + refCountBefore + ' after=' + refCountAfter + ') — click was dispatched, continuing')
      } else {
        bridgeDebug('[Bridge][addRef] verify: ref attached, count ' + refCountBefore + ' -> ' + refCountAfter)
      }

      // Close context menu if still open
      var escEv = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true })
      document.dispatchEvent(escEv)

      return { success: true, method: 'contextmenu', error: '' }
    }

    // Menu not found or item not matched — close any open menu
    try {
      var escEv2 = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true })
      document.dispatchEvent(escEv2)
    } catch (_) {}

    return { success: false, method: 'contextmenu', error: 'Menu item not found in context menu' }
  }

  function editorRefAttachmentCount(): number {
    var ed = findEditorElement()
    if (!ed) return 0
    var count = 0
    // Count elements that look like ref attachments/chips in the editor
    var selectors = [
      '[data-slate-node="image"]',
      '[class*="reference"]',
      '[class*="attachment"]',
      '[class*="ref-chip"]',
      'img[src]:not([src^="data:"]):not([src^="blob:"])',
    ]
    for (var si = 0; si < selectors.length; si++) {
      try {
        count += ed.querySelectorAll(selectors[si]).length
      } catch (_) {}
    }
    return count
  }

  async function tryAddRefViaDrag(imgEl: HTMLElement, x: number, y: number): Promise<{ success: boolean; method: string; error: string }> {
    bridgeDebug('[Bridge][addRef] drag strategy')
    var ed = findEditorElement()
    if (!ed) return { success: false, method: 'drag', error: 'No editor found for drag target' }

    var edRect = ed.getBoundingClientRect()
    var edX = edRect.left + edRect.width / 2
    var edY = edRect.top + edRect.height / 2

    imgEl.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, cancelable: true }))
    await sleep(50)
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: edX, clientY: edY, bubbles: true, cancelable: true }))
    await sleep(50)
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: edX, clientY: edY, bubbles: true, cancelable: true }))
    await sleep(500)

    return { success: false, method: 'drag', error: 'Drag strategy not confirmed' }
  }

  // ═══════════════════════════════════════════════════════════════
  // REMOVE EXISTING REF IMAGES FROM EDITOR
  // ═══════════════════════════════════════════════════════════════

  function removeExistingRefImages(): { success: boolean; removed: number; error: string } {
    bridgeDebug('[Bridge] removeExistingRefImages: start')
    var ed = findEditorElement()
    if (!ed) return { success: false, removed: 0, error: 'Editor not found' }

    var removed = 0

    // Safe selectors: only target elements that are clearly ref chips/attachments in Slate.
    // DO NOT use broad selectors like 'img' or 'figure' alone — they may remove
    // legitimate UI elements or the editor itself.
    var safeSelectors = [
      // Slate image nodes
      '[data-slate-node="image"]',
      // Explicit reference/attachment wrappers
      '[class*="reference"]',
      '[class*="attachment"]',
      '[class*="ref-chip"]',
      '[class*="image-attachment"]',
      // Figure with data-type attribute
      'figure[data-type]',
      'figure[data-slate-type]',
    ]

    var toRemove: Element[] = []
    for (var si = 0; si < safeSelectors.length; si++) {
      var els = ed.querySelectorAll(safeSelectors[si])
      for (var ei = 0; ei < els.length; ei++) {
        toRemove.push(els[ei])
      }
    }

    bridgeDebug('[Bridge] removeExistingRefImages: found ' + toRemove.length + ' candidate elements')
    for (var ri = 0; ri < toRemove.length; ri++) {
      var el = toRemove[ri]
      bridgeDebug('[Bridge] removeExistingRefImages: removing "' + el.tagName + '" class="' + ((el.className || '').toString().substring(0, 60)) + '"')
      try {
        el.remove()
        removed++
      } catch (e) {
        bridgeDebug('[Bridge] removeExistingRefImages: remove failed for "' + el.tagName + '": ' + String(e))
      }
    }

    // If nothing was removed, log diagnostics to help identify the actual ref element structure
    if (removed === 0) {
      var allChildren = ed.querySelectorAll('*')
      bridgeDebug('[Bridge] removeExistingRefImages: no elements removed. Editor child count=' + allChildren.length + '. Dumping first 10 child tags:')
      var tags: string[] = []
      for (var ci = 0; ci < Math.min(10, allChildren.length); ci++) {
        var child = allChildren[ci]
        tags.push(child.tagName + ' class="' + ((child.className || '').toString().substring(0, 40)) + '"')
      }
      bridgeDebug('[Bridge] removeExistingRefImages: ' + JSON.stringify(tags))
    }

    bridgeDebug('[Bridge] removeExistingRefImages: done, removed=' + removed)
    return { success: true, removed: removed, error: '' }
  }

  // ═══════════════════════════════════════════════════════════════
  // UPLOAD FILES TO FLOW
  // Reuses Flow's real input[type=file] for images; DragEvent for video.
  // ═══════════════════════════════════════════════════════════════

  interface UploadFileEntry {
    key: string
    name: string
    type: string
    base64: string
  }

  // ── Helpers ───────────────────────────────────────────────────

  function getUniqueTileIds(onlyDone = false): string[] {
    var tiles = scanTiles()
    if (!onlyDone) return tiles.map(function (t) { return t.id }).filter(function (id) { return id && id !== 'unknown' })
    return tiles.filter(function (t) { return t.status === 'done' }).map(function (t) { return t.id }).filter(function (id) { return id && id !== 'unknown' })
  }

  function findRetryButtonForTile(tileId: string): HTMLElement | null {
    var tile = document.querySelector('[data-tile-id="' + CSS.escape(tileId) + '"]')
    if (!tile) return null
    var btns = tile.querySelectorAll('button')
    for (var bi = 0; bi < btns.length; bi++) {
      var t = safeLower(btns[bi].textContent || '')
      if (t.includes('retry') || t.includes('thử') || t.includes('regenerate') || t.includes('tạo lại')) {
        return btns[bi]
      }
    }
    return null
  }

  function extractFileNameFromUrl(rawUrl: string): string {
    if (!rawUrl || rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return ''

    // Explicit reject: any segment of the URL that IS the endpoint name
    // (the URL itself routes through /media.getMediaUrlRedirect which is the
    // proxy — not an identity). Returning it would poison the fileNameMap.
    try {
      var protoCheck = String(rawUrl)
      if (
        protoCheck.includes('media.getMediaUrlRedirect') ||
        /\/media(?:UrlRedirect)?(?:\.|$|\?)/.test(protoCheck) ||
        /\/upload(?:\.|$|\?)/.test(protoCheck) ||
        /\/v1\/files(?:\.|$|\?)/.test(protoCheck)
      ) {
        // Continue — the URL may still carry a real fileName in ?name=
        // or ?input=. We only return an extracted value if we can find a
        // concrete UUID/identifier, never the endpoint name itself.
      }
    } catch (_) {}

    try {
      // Strategy 1: URL has ?name=<uuid> — extract directly
      var urlObj = new URL(rawUrl)
      var nameParam = urlObj.searchParams.get('name')
      if (nameParam && nameParam.length > 4 && nameParam.length < 256) {
        // Reject if nameParam itself is the endpoint name (rare but possible)
        if (
          nameParam === 'media.getMediaUrlRedirect' ||
          /^[a-z]+\.[a-z]+$/.test(nameParam) // e.g. "media.redirect"
        ) {
          // skip
        } else {
          return nameParam
        }
      }

      // Strategy 2: URL has ?input=... (URL-encoded JSON) — decode and extract "name" field
      var inputParam = urlObj.searchParams.get('input')
      if (inputParam) {
        try {
          var decoded = decodeURIComponent(inputParam)
          var json = JSON.parse(decoded)
          // Navigate through tRPC batching envelope: [[{json:{name:...}}]]
          var inner = json
          if (Array.isArray(inner)) inner = inner[0]
          if (Array.isArray(inner)) inner = inner[0]
          if (inner && typeof inner === 'object') inner = (inner as Record<string, unknown>).json || inner
          if (inner && typeof inner === 'object' && (inner as Record<string, unknown>).name) {
            var n = String((inner as Record<string, unknown>).name)
            // Reject endpoint names / placeholder values
            if (
              n.length > 4 &&
              n.length < 256 &&
              n !== 'media.getMediaUrlRedirect' &&
              !/^[a-z]+\.[a-z]+$/.test(n)
            ) {
              return n
            }
          }
        } catch (_) {}
      }

      // Strategy 3: URL has path segment that looks like a UUID or media identity
      var pathname = urlObj.pathname
      var segments = pathname.split('/').filter(function (s) { return s.length > 0 })
      if (segments.length > 0) {
        var lastSeg = segments[segments.length - 1]
        // Strip query string
        var q = lastSeg.indexOf('?')
        if (q >= 0) lastSeg = lastSeg.substring(0, q)
        // Accept if it looks like a UUID or media ID (not an endpoint name)
        // Endpoint names contain dots (e.g. "media.getMediaUrlRedirect").
        // We already filter that with `!includes('.')` but add an explicit
        // denylist as a safety net.
        if (
          lastSeg.length > 8 &&
          lastSeg.length < 256 &&
          !lastSeg.includes('.') &&
          lastSeg !== 'media.getMediaUrlRedirect'
        ) {
          return lastSeg
        }
      }
    } catch (_) {}

    return ''
  }

  function extractFileName(tileId: string): string {
    var tile = document.querySelector('[data-tile-id="' + CSS.escape(tileId) + '"]')
    if (!tile) return ''

    // Try <img> src
    var img = tile.querySelector('img') as HTMLImageElement | null
    if (img && img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) {
      var fn = extractFileNameFromUrl(img.src)
      if (fn) return fn
    }

    // Try <video> src
    var vid = tile.querySelector('video') as HTMLVideoElement | null
    if (vid && vid.src && !vid.src.startsWith('data:') && !vid.src.startsWith('blob:')) {
      var vfn = extractFileNameFromUrl(vid.src)
      if (vfn) return vfn
    }

    // Try <source> inside <video>
    var sources = tile.querySelectorAll('source')
    for (var si = 0; si < sources.length; si++) {
      var src = sources[si].src
      if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
        var sfn = extractFileNameFromUrl(src)
        if (sfn) return sfn
      }
    }

    // Fallback: scan all attributes on the tile for URLs
    var allEls = tile.querySelectorAll('*')
    for (var ei = 0; ei < allEls.length; ei++) {
      var attrs = ['src', 'href', 'data-src', 'data-url', 'data-media']
      for (var ai = 0; ai < attrs.length; ai++) {
        var val = allEls[ei].getAttribute(attrs[ai])
        if (val && !val.startsWith('data:') && !val.startsWith('blob:')) {
          var efn = extractFileNameFromUrl(val)
          if (efn) return efn
        }
      }
    }

    return ''
  }

  // Normalize a Flow-side URL to an absolute https://labs.google/...
  // (or origin-appropriate) URL. Flow's <img> / <video> elements
  // frequently expose `src="/fx/api/trpc/media.getMediaUrlRedirect?name=..."`
  // — a path-relative URL that ONLY resolves inside the Flow tab's
  // origin. Outside that context (extension sidepanel, service worker,
  // downstream node fetch) the URL resolves to `chrome-extension://...`
  // or `file://...` and fails with ERR_FILE_NOT_FOUND.
  //
  // Rules:
  //   blob:           — keep as-is (already absolute within the page)
  //   data:           — keep as-is (data URL is self-contained)
  //   http(s)://      — keep as-is (already absolute)
  //   protocol-relative `//foo` — prepend `https:` to match Flow origin
  //   path-relative `/foo`       — resolve against `location.origin`
  //   anything else  — keep as-is (best-effort)
  //
  // Used by captureTileSnapshot so every URL the bridge reports to
  // flow-content is already an absolute URL the runner can fetch.
  function toAbsoluteFlowUrl(value: unknown): string {
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
        return new URL(v, location.origin).href
      } catch (_) {
        return v
      }
    }
    return v
  }

  // Capture the current tile state in the same shape the getTileSnapshot
  // action returns. Used inside uploadFilesToPrompt to build per-file
  // baselines without going through the action handler.
  //
  // Rich payload: each detail entry now exposes the tile's thumbnail
  // (`thumbnail`) and underlying media URLs (`imgSrc`, `videoSrc`,
  // `videoPoster`) plus `hasImg` / `hasVideo`. The flow-content auto-
  // download loop uses these to surface output assets to the workflow
  // runner even before the right-click → menu → download completes. If
  // `direct_src_available` fires, the asset list is what the BG needs to
  // fallback-download directly. The Workflow UI uses `thumbnail` to
  // render the preview thumbnail in the Generate-node card.
  //
  // All URL fields pass through toAbsoluteFlowUrl so downstream nodes
  // can fetch the asset from any context (extension, side panel,
  // service worker) without hitting ERR_FILE_NOT_FOUND on
  // `chrome-extension://.../fx/api/...` or `file://.../fx/api/...`.
  // providerOrigin / sourcePageUrl are recorded so the runner can
  // reconstruct the URL if a legacy caller ships a relative path back.
  function captureTileSnapshot(): {
    ids: string[]
    fileNames: string[]
    details: Array<Tile & { fileName: string; providerOrigin?: string; sourcePageUrl?: string }>
  } {
    var tiles = scanTiles()
    var snapIds: string[] = []
    var snapFileNames: string[] = []
    var snapDetails: Array<Tile & { fileName: string; providerOrigin?: string; sourcePageUrl?: string }> = []
    var providerOrigin = (typeof location !== 'undefined' && location && location.origin) || ''
    var sourcePageUrl = (typeof location !== 'undefined' && location && location.href) || ''
    for (var ci = 0; ci < tiles.length; ci++) {
      var t = tiles[ci]
      snapIds.push(t.id)
      snapFileNames.push(t.fileName || '')
      var detail: Tile & { fileName: string; providerOrigin?: string; sourcePageUrl?: string } = {
        id: t.id,
        fileName: t.fileName || '',
        status: t.status,
        progress: t.progress,
        thumbnail: toAbsoluteFlowUrl(t.thumbnail || ''),
        createdAt: t.createdAt,
        hasImg: !!t.hasImg,
        hasVideo: !!t.hasVideo,
        imgSrc: toAbsoluteFlowUrl(t.imgSrc || ''),
        imgAlt: t.imgAlt || '',
        videoSrc: toAbsoluteFlowUrl(t.videoSrc || ''),
        videoCurrentSrc: toAbsoluteFlowUrl(t.videoCurrentSrc || ''),
        videoPoster: toAbsoluteFlowUrl(t.videoPoster || ''),
        providerOrigin: providerOrigin,
        sourcePageUrl: sourcePageUrl,
        rect: t.rect ? { top: t.rect.top, bottom: t.rect.bottom, left: t.rect.left, right: t.rect.right } : undefined,
      }
      // Optional diagnostic fields — only included when set so we don't
      // ship a giant blob to the BG with empty strings.
      if (t.failedFirstSeenAt) detail.failedFirstSeenAt = t.failedFirstSeenAt
      if (t.statusReason) detail.statusReason = t.statusReason
      if (t.textPreview) detail.textPreview = t.textPreview
      if (t.iconTexts && t.iconTexts.length) detail.iconTexts = t.iconTexts
      if (t.buttonTexts && t.buttonTexts.length) detail.buttonTexts = t.buttonTexts
      if (t.className) detail.className = t.className
      if (t.mediaReadyReason) detail.mediaReadyReason = t.mediaReadyReason
      snapDetails.push(detail)
    }
    return { ids: snapIds, fileNames: snapFileNames, details: snapDetails }
  }

  // Find a tile element whose extracted fileName equals `expectedFileName`.
  // This is the IDENTITY lookup — the ONLY safe way to find an uploaded
  // tile. Never call this to find "the last visible tile" or any position-
  // based fallback.
  function findTileElementByFileName(expectedFileName: string): HTMLElement | null {
    if (!expectedFileName || expectedFileName.length < 4) return null
    var containers = document.querySelectorAll('[data-tile-id]')
    for (var fi = 0; fi < containers.length; fi++) {
      var el = containers[fi] as HTMLElement
      var fn = extractFileName(el.dataset.tileId || '')
      if (fn && fn === expectedFileName) return el
    }
    return null
  }

  // Validate that a tile element's identity matches the expected fileName.
  // Used by addFileToPrompt to reject stale-id collisions.
  function validateTileFileName(tileEl: HTMLElement | null, expectedFileName: string): { ok: boolean; actualFileName: string } {
    if (!tileEl) return { ok: false, actualFileName: '' }
    var id = tileEl.dataset.tileId || ''
    var actual = extractFileName(id)
    if (!expectedFileName || expectedFileName.length < 4) return { ok: true, actualFileName: actual }
    if (actual === expectedFileName) return { ok: true, actualFileName: actual }
    return { ok: false, actualFileName: actual }
  }

  function detectTileStatus(tileId: string): 'done' | 'failed' | 'processing' | 'unknown' {
    var tiles = scanTiles()
    var tile = tiles.find(function (t) { return t.id === tileId })
    if (!tile) return 'unknown'
    if (tile.status === 'done') return 'done'
    if (tile.status === 'failed') return 'failed'
    return 'processing'
  }

  function findAcceptableImageInput(): HTMLInputElement | null {
    var inputs = Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[]
    bridgeDebug('[Bridge] findAcceptableImageInput: total file inputs=' + inputs.length)
    if (inputs.length > 0) {
      var logInputs = inputs.map(function (inp) {
        return 'accept="' + (inp.accept || '') + '" hidden=' + (inp.offsetWidth <= 0 && inp.offsetHeight <= 0) + ' inDOM=' + document.contains(inp)
      })
      bridgeDebug('[Bridge] file inputs: ' + JSON.stringify(logInputs))
    }
    for (var ii = 0; ii < inputs.length; ii++) {
      var inp = inputs[ii]
      var accept = (inp.accept || '').toLowerCase()
      // Accept if: no accept attr, image/*, or specific image types
      // Reject if: only video/* (no image support)
      if (!accept || accept.includes('image') || accept.includes('png') || accept.includes('jpg') || accept.includes('jpeg') || accept.includes('webp') || accept.includes('gif')) {
        bridgeDebug('[Bridge] findAcceptableImageInput: ACCEPTING accept="' + inp.accept + '"')
        return inp
      }
    }
    // Fallback: return first input with no accept attr (neutral — might handle both)
    for (var fi = 0; fi < inputs.length; fi++) {
      if (!inputs[fi].accept) return inputs[fi]
    }
    return null
  }

  function ensureFlowTabActive(): void {
    try {
      var ed = findEditorElement()
      if (ed) ed.focus()
      // Scroll editor into view
      ed && ed.scrollIntoView && ed.scrollIntoView({ behavior: 'instant', block: 'center' })
    } catch (_) {}
  }

  function clickIAgreeButton(): boolean {
    var allBtns = document.querySelectorAll('button, [role="button"]')
    for (var bi = 0; bi < allBtns.length; bi++) {
      var txt = safeLower(allBtns[bi].textContent || '')
      if (txt === 'i agree' || txt === 'đồng ý' || txt === 'agree' || txt.includes('i agree')) {
        bridgeLog('[Bridge] clickIAgreeButton: clicking "' + txt + '"')
        ;(allBtns[bi] as HTMLElement).click()
        return true
      }
    }
    return false
  }

  // ── Main upload function ───────────────────────────────────────

  async function uploadFilesToPrompt(
    filesData: UploadFileEntry[]
  ): Promise<{
    success: boolean
    error?: string
    tileIds?: string[]
    orderedTileIds?: string[]
    tileDetails?: Array<{ id: string; thumbnailUrl?: string; file_name?: string; originalName?: string; originalKey?: string }>
    keyMapping?: Record<string, string>
    diagnostics?: Record<string, unknown>
  }> {
    if (!filesData || filesData.length === 0) {
      return { success: true, tileIds: [], orderedTileIds: [], tileDetails: [], keyMapping: {} }
    }

    var editor = findEditorElement()
    var diagnostics: Record<string, unknown> = {}

    // Collect baseline tile IDs before any upload
    var existingTileIds = getUniqueTileIds(true)
    var orderedTileIds: string[] = []
    var tileDetails: Array<{ id: string; thumbnailUrl?: string; file_name?: string; originalName?: string; originalKey?: string }> = []
    var keyMapping: Record<string, string> = {}
    var errors: string[] = []

    bridgeLog('[Bridge] uploadFilesToPrompt: START, files=' + filesData.length + ', existingTileIds=' + existingTileIds.length)

    for (var fi = 0; fi < filesData.length; fi++) {
      var fd = filesData[fi]
      bridgeLog('[Bridge] uploadFilesToPrompt: processing key=' + fd.key + ' name=' + fd.name + ' type=' + fd.type)

      // Decode base64 → Blob → File
      var binaryStr = ''
      try {
        binaryStr = atob(fd.base64)
      } catch (e) {
        var decodeErr = 'base64 decode failed for key=' + fd.key + ': ' + String(e)
        bridgeWarn('[Bridge] uploadFilesToPrompt: ' + decodeErr)
        errors.push(decodeErr)
        continue
      }
      var byteArr = new Uint8Array(binaryStr.length)
      for (var bi = 0; bi < binaryStr.length; bi++) {
        byteArr[bi] = binaryStr.charCodeAt(bi)
      }
      var blob = new Blob([byteArr], { type: fd.type || 'image/png' })
      var uploadFile = new File([blob], fd.name || 'upload.png', { type: fd.type || 'image/png' })
      var isVideo = fd.type.startsWith('video/')

      // ── Image: use real Flow file input ──────────────────────
      if (!isVideo) {
        var imgInput = findAcceptableImageInput()

        if (!imgInput) {
          // Collect diagnostics
          var fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map(function (inp) {
            return { accept: inp.accept, visible: inp.offsetWidth > 0 && inp.offsetHeight > 0 }
          })
          var dropTargets = Array.from(document.querySelectorAll('[class*="drop"], [class*="upload"], [class*="drag"], [data-drop]')).length
          var policyBtns = Array.from(document.querySelectorAll('button')).filter(function (b) {
            return safeLower((b.textContent || '')).includes('agree')
          }).length
          diagnostics[fd.key] = { fileInputs: fileInputs, dropTargets: dropTargets, policyButtons: policyBtns }

          var noInputErr = 'NO_FLOW_FILE_INPUT for key=' + fd.key
          bridgeWarn('[Bridge] uploadFilesToPrompt: ' + noInputErr + ' — diagnostics: ' + JSON.stringify(diagnostics[fd.key]))
          errors.push(noInputErr)
          continue
        }

        bridgeLog('[Bridge] uploadFilesToPrompt: using real input accept="' + imgInput.accept + '"')

        var dataTransfer = new DataTransfer()
        dataTransfer.items.add(uploadFile)
        imgInput.files = dataTransfer.files

        // ── Per-file baseline: capture BEFORE dispatching the change event.
        // Using a single shared baseline for sequential uploads is unsafe —
        // a previous upload's tile would not be in this baseline, so a stale
        // id from the previous upload could be picked instead of THIS file's
        // new tile.
        var baselineSnap = captureTileSnapshot()
        var beforeIds = new Set<string>()
        var beforeFileNames = new Set<string>()
        for (var bsi = 0; bsi < (baselineSnap.ids as string[]).length; bsi++) {
          beforeIds.add((baselineSnap.ids as string[])[bsi])
        }
        var bsFns = (baselineSnap.fileNames as string[]).filter(function (f) { return f.length > 0 })
        for (var bfi = 0; bfi < bsFns.length; bfi++) {
          beforeFileNames.add(bsFns[bfi])
        }
        // Always include existingTileIds + already-uploaded this-batch ids
        // as a safety net in case scanTiles returns stale data.
        for (var exi = 0; exi < existingTileIds.length; exi++) beforeIds.add(existingTileIds[exi])
        for (var oti = 0; oti < orderedTileIds.length; oti++) beforeIds.add(orderedTileIds[oti])

        bridgeDebug('[Bridge] uploadFilesToPrompt: dispatching change event on input')
        imgInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }))

        // Dispatch Escape to close picker/modal after upload trigger
        await sleep(200)
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }))

        // Poll for new tile -- by IDENTITY, not DOM position
        var newTileId = ''
        var newTileFileName = ''
        var pollTimeout = 90000 // 90s total
        var pollInterval = 500
        var maxAttempts = Math.floor(pollTimeout / pollInterval)
        var initialWait = 800
        var lastAmbiguousErr = ''
        var tileAccepted = false

        bridgeLog('[Bridge][UPLOAD_BASELINE] key=' + fd.key + ' beforeIds=' + beforeIds.size + ' beforeFileNames=' + beforeFileNames.size)

        await sleep(initialWait)

        for (var ai = 0; ai < maxAttempts; ai++) {
          await sleep(pollInterval)

          // Re-poll the current tile snapshot (already deduped by scanTiles).
          var currentSnap = captureTileSnapshot()
          var allTiles = (currentSnap.details as Array<{ id: string; fileName: string; status: string }>) || []

          // Build identity-validated candidates:
          // - new id (not in beforeIds)
          // - new fileName (not in beforeFileNames)
          // - fileName is a real identity (not endpoint name, not originalName)
          // - status === done
          var identityCandidates: Array<{ id: string; fileName: string; status: string }> = []
          for (var ici = 0; ici < allTiles.length; ici++) {
            var cand = allTiles[ici]
            if (!cand.id || beforeIds.has(cand.id)) continue
            if (!cand.fileName || cand.fileName.length < 4) continue
            if (beforeFileNames.has(cand.fileName)) continue
            if (cand.fileName === 'media.getMediaUrlRedirect') continue
            if (cand.fileName === fd.name) continue
            if (cand.status !== 'done' && cand.status !== 'success') continue
            identityCandidates.push(cand)
          }

          if (identityCandidates.length === 0) {
            // No candidates yet -- keep polling
            if (ai > 0 && ai % 30 === 0) {
              bridgeDebug('[Bridge] uploadFilesToPrompt: still waiting at ' + ((ai + 1) * pollInterval + initialWait) + 'ms for key=' + fd.key)
              ensureFlowTabActive()
              await sleep(2000)
            }
            continue
          }

          // ONE candidate: unambiguous, accept it.
          if (identityCandidates.length === 1) {
            newTileId = identityCandidates[0].id
            newTileFileName = identityCandidates[0].fileName
            tileAccepted = true
            bridgeLog('[Bridge][UPLOAD_CANDIDATES] key=' + fd.key + ' count=1 tileId=' + newTileId + ' fileName=' + newTileFileName + ' status=' + identityCandidates[0].status)
            break
          }

          // MULTIPLE candidates -- ambiguous. Do NOT push error immediately.
          // This may be transient (Flow paints multiple tiles before stabilizing).
          // Keep the last ambiguity and only commit it on timeout if tile never
          // gets accepted. If a later poll narrows to exactly 1 candidate, that
          // wins and the transient ambiguity is discarded.
          lastAmbiguousErr = 'FLOW_UPLOAD_TILE_IDENTITY_AMBIGUOUS for key=' + fd.key + ' name=' + fd.name + ' ' + identityCandidates.length + ' tiles matched identity; refusing to auto-pick'
          var candIds = identityCandidates.map(function (c) { return c.id }).join(',')
          bridgeWarn('[Bridge][UPLOAD_IDENTITY_AMBIGUOUS_TRANSIENT] key=' + fd.key + ' count=' + identityCandidates.length + '/5 candIds=' + candIds)
          continue
        }

        if (!tileAccepted || !newTileId) {
          // Only push an error if the tile was never accepted. If we saw
          // transient ambiguity but the tile eventually resolved, ambiguity
          // errors are discarded (they were noise, not a real failure).
          if (lastAmbiguousErr) {
            errors.push(lastAmbiguousErr)
            bridgeWarn('[Bridge] uploadFilesToPrompt: ' + lastAmbiguousErr)
          } else {
            var timeoutErr = 'FLOW_UPLOAD_TILE_IDENTITY_TIMEOUT for key=' + fd.key + ' name=' + fd.name + ' no identity-matched tile found within 90s'
            bridgeWarn('[Bridge] uploadFilesToPrompt: ' + timeoutErr)
            errors.push(timeoutErr)
          }
          continue
        }

        // Re-validate the fileName we extracted during polling. The poll
        // loop already validated identity, but if extraction was wrong, we
        // catch it here before storing.
        var validatedTile = scanTiles().find(function (t) { return t.id === newTileId })
        var thumbUrl = validatedTile?.thumbnail || ''
        var finalFileName = newTileFileName

        if (!finalFileName || finalFileName.length < 4 || finalFileName === 'media.getMediaUrlRedirect' || finalFileName === fd.name) {
          var identityErr = 'FLOW_UPLOAD_TILE_IDENTITY_INVALID for key=' + fd.key + ' name=' + fd.name + ' — finalFileName="' + (finalFileName || '(empty)') + '"'
          bridgeWarn('[Bridge] uploadFilesToPrompt: ' + identityErr)
          errors.push(identityErr)
          continue
        }

        orderedTileIds.push(newTileId)
        tileDetails.push({
          id: newTileId,
          thumbnailUrl: thumbUrl,
          file_name: finalFileName,
          originalName: fd.name,
          originalKey: fd.key,
        })
        keyMapping[fd.key] = newTileId
        bridgeLog('[Bridge][UPLOAD_ACCEPTED] key=' + fd.key + ' tileId=' + newTileId + ' fileName=' + finalFileName + ' status=done')
        bridgeLog('[Bridge][UPLOAD_KEY_MAPPING] key=' + fd.key + ' -> tileId=' + newTileId + ' fileName=' + finalFileName)

      } else {
        // ── Video: use DragEvent ─────────────────────────────────
        bridgeLog('[Bridge] uploadFilesToPrompt: VIDEO path for key=' + fd.key)

        var beforeIdsVideo = getUniqueTileIds(true)
        var target = editor || document.querySelector('main') || document.body
        var dataTransferVideo = new DataTransfer()
        dataTransferVideo.items.add(uploadFile)

        var dragEvents = [
          new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dataTransferVideo }),
          new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dataTransferVideo }),
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dataTransferVideo }),
        ]
        for (var di = 0; di < dragEvents.length; di++) {
          target.dispatchEvent(dragEvents[di])
          await sleep(100)
        }

        // Check for policy modal
        await sleep(1000)
        var policyClicked = clickIAgreeButton()
        if (policyClicked) {
          await sleep(1000)
        }

        // Poll for video tile (similar to image path)
        var newVideoTileId = ''
        var videoAccepted = false

        await sleep(initialWait)
        for (var vai = 0; vai < maxAttempts; vai++) {
          await sleep(pollInterval)
          var currentVideoIds = getUniqueTileIds(true)
          var newVideoIds = currentVideoIds.filter(function (id) {
            return !existingTileIds.includes(id) && !orderedTileIds.includes(id)
          })
          if (newVideoIds.length > 0) {
            var vCandId = newVideoIds[newVideoIds.length - 1]
            var vStatus = detectTileStatus(vCandId)
            if (vStatus === 'done') {
              newVideoTileId = vCandId
              videoAccepted = true
              bridgeLog('[Bridge] uploadFilesToPrompt: VIDEO tile ACCEPTED id=' + newVideoTileId)
              break
            }
            if (vStatus === 'failed') {
              var vRetry = findRetryButtonForTile(vCandId)
              if (vRetry) {
                vRetry.click()
                await sleep(2000)
              }
            }
          }
        }

        if (!videoAccepted || !newVideoTileId) {
          var vTimeoutErr = 'Video tile not accepted within 90s for key=' + fd.key
          bridgeWarn('[Bridge] uploadFilesToPrompt: ' + vTimeoutErr)
          errors.push(vTimeoutErr)
          continue
        }

        await sleep(500)
        var vExtractedName = extractFileName(newVideoTileId)
        var vTiles = scanTiles()
        var vAcceptedTile = vTiles.find(function (t) { return t.id === newVideoTileId })

        // IDENTITY GUARD for video path
        if (!vExtractedName || vExtractedName.length < 4 || vExtractedName === 'media.getMediaUrlRedirect' || vExtractedName === fd.name) {
          var vIdentityErr = 'FLOW_UPLOAD_TILE_IDENTITY_INVALID for video key=' + fd.key + ' name=' + fd.name + ' — extracted="' + (vExtractedName || '(empty)') + '"'
          bridgeWarn('[Bridge] uploadFilesToPrompt: ' + vIdentityErr)
          errors.push(vIdentityErr)
          continue
        }

        orderedTileIds.push(newVideoTileId)
        tileDetails.push({
          id: newVideoTileId,
          thumbnailUrl: vAcceptedTile?.thumbnail || '',
          file_name: vExtractedName,
          originalName: fd.name,
          originalKey: fd.key,
        })
        keyMapping[fd.key] = newVideoTileId
        bridgeLog('[Bridge][tileIdentity] uploadFilesToPrompt: VIDEO SUCCESS key=' + fd.key + ' -> tileId=' + newVideoTileId + ' fileName=' + vExtractedName)
      }
    }

    if (errors.length > 0) {
      return {
        success: false,
        error: 'FLOW_UPLOAD_IMAGE_FAILED: ' + errors.join('; '),
        tileIds: orderedTileIds,
        orderedTileIds: orderedTileIds,
        tileDetails: tileDetails,
        keyMapping: keyMapping,
        diagnostics: Object.keys(diagnostics).length > 0 ? diagnostics : undefined,
      }
    }

    bridgeLog('[Bridge] uploadFilesToPrompt: ALL SUCCESS, ' + orderedTileIds.length + ' tiles, keyMapping=' + JSON.stringify(keyMapping))
    return {
      success: true,
      tileIds: orderedTileIds,
      orderedTileIds: orderedTileIds,
      tileDetails: tileDetails,
      keyMapping: keyMapping,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // DEBUG RUN FLOW PROMPT (exposed to page console in MAIN world)
  // ═══════════════════════════════════════════════════════════════

  ;(window as Record<string, unknown>).debugRunFlowPrompt = async function (prompt: string): Promise<Record<string, unknown>> {
    return {
      success: false,
      error: 'FLOW_ADMISSION_REQUIRED',
      statusReason: 'Use the extension RUN_FLOW_PROMPT route; MAIN-world direct submit is disabled',
      promptLength: prompt.length,
    }
  }

  bridgeLog('[Bridge] debugRunFlowPrompt direct submit disabled; use background admission route')

  // ── Bridge API object (accessible from content script via postMessage) ─────────

  ;(window as Record<string, unknown>).__FLOW_BRIDGE__ = {
    clear: clearEditor,
    insertText: insertText,
    submit: function () { return { success: false, method: null, buttonText: '', error: 'FLOW_ADMISSION_REQUIRED' } },
    verify: verifyEditor,
    submitGoogleFlow: async function () { return { ok: false, reason: 'FLOW_ADMISSION_REQUIRED', method: 'blocked-direct-submit' } },
    submitGoogleFlowButtonOnly: function () { return { success: false, method: 'blocked-direct-submit', error: 'FLOW_ADMISSION_REQUIRED' } },
    insertGoogleFlowPromptOnly: insertGoogleFlowPromptOnly,
    findGoogleFlowEditor: findGoogleFlowEditor,
    findGoogleFlowCreateButton: findGoogleFlowCreateButton,
    debugRunFlowPrompt: (window as Record<string, unknown>).debugRunFlowPrompt as (prompt: string) => Promise<Record<string, unknown>>,
  }
  ;(window as Record<string, unknown>).__FLOW_SLATE_BRIDGE_READY__ = true
  bridgeLog('[Bridge] __FLOW_BRIDGE__ exposed, __FLOW_SLATE_BRIDGE_READY__ = true')

  // ═══════════════════════════════════════════════════════════════
  // POST MESSAGE INFRASTRUCTURE
  // ═══════════════════════════════════════════════════════════════

  function postResult(rid: number, data: Record<string, unknown>) {
    var payload = Object.assign({ source: _resultId, requestId: rid }, data)
    window.postMessage(payload, window.location.origin)
  }

  function getBridgeRuntimeInjectionCounts(): Record<string, unknown> {
    var currentDocumentInstances = bridgeRuntimeRegistry.instances.filter(function (instance) {
      return instance.documentId === BRIDGE_DOCUMENT_ID
    })
    var messageListenerCount = currentDocumentInstances.reduce(function (sum, instance) { return sum + instance.messageListenerCount }, 0)
    var mutationObserverCount = currentDocumentInstances.reduce(function (sum, instance) { return sum + instance.mutationObserverCount }, 0)
    var pollingLoopCount = currentDocumentInstances.reduce(function (sum, instance) { return sum + instance.pollingLoopCount }, 0)
    var submitHandlerCount = currentDocumentInstances.reduce(function (sum, instance) { return sum + instance.submitHandlerCount }, 0)
    var activeInstanceIds = currentDocumentInstances.filter(function (instance) {
      return instance.messageListenerCount + instance.mutationObserverCount + instance.pollingLoopCount > 0
    }).map(function (instance) { return instance.instanceId })
    return {
      documentId: BRIDGE_DOCUMENT_ID,
      installCount: bridgeRuntimeRegistry.installCount,
      activeInstanceIds: activeInstanceIds,
      messageListenerCount: messageListenerCount,
      mutationObserverCount: mutationObserverCount,
      pollingLoopCount: pollingLoopCount,
      submitHandlerCount: submitHandlerCount,
      duplicateBridgeDetected: activeInstanceIds.length > 1,
      duplicateListenerDetected: messageListenerCount > 1,
      duplicateObserverDetected: mutationObserverCount > 1,
      duplicatePollingLoopDetected: pollingLoopCount > 1,
      duplicateSubmitHandlerDetected: submitHandlerCount > 1,
    }
  }

  async function handleMessage(e: MessageEvent) {
    if (e.source !== window) return
    var d = e.data as Record<string, unknown>
    if (!d || d.source !== _sourceId) return

    var action = d.action as string
    var rid = (d.requestId as number) || (d.id as number) || 0

    if (FLOW_DEBUG_VERBOSE) bridgeDebug('[Bridge] Message:', action, 'rid:', rid)

    if (action === 'runtimeHandshake') {
      // Read-only by contract. This only checks the currently authenticated
      // page DOM and bridge ownership; it does not insert text, click, reload,
      // alter Flow settings, or start/stop a monitor.
      var runtimeComposer = findEditorElement() || findGoogleFlowEditor()
      var runtimeInjectionCounts = getBridgeRuntimeInjectionCounts()
      postResult(rid, {
        success: true,
        ready: true,
        bridgeMarker: FLOW_BRIDGE_BUILD_MARKER,
        bridgeInstanceId: BRIDGE_INSTANCE_ID,
        bridgeLocation: { origin: window.location.origin, pathname: window.location.pathname },
        composerDetected: !!runtimeComposer,
        duplicateBridgeDetected: runtimeInjectionCounts.duplicateBridgeDetected === true,
        duplicateListenerDetected: runtimeInjectionCounts.duplicateListenerDetected === true,
        injectionCounts: runtimeInjectionCounts,
      })

    } else if (action === 'sessionRevalidate') {
      // Read-only, conservative contract. No stable Flow router/session
      // revalidation API is proven in this repository, so do not guess one.
      // This action never reads credentials, navigates, reloads, edits the
      // composer, changes settings, or submits generation.
      var sessionHealth = getFlowAdmissionHealth()
      postResult(rid, {
        success: false,
        supported: false,
        attempted: false,
        statusReason: 'no_stable_flow_router_revalidation_api',
        documentReadyState: document.readyState,
        route: { origin: window.location.origin, pathname: window.location.pathname },
        bridgeReady: sessionHealth.bridgeReady === true,
        composerPresent: sessionHealth.composerPresent === true,
        errorCode: sessionHealth.errorCode || '',
      })

    } else if (action === 'insert') {
      var text = (d.text as string) || ''
      if (FLOW_DEBUG_VERBOSE) bridgeDebug('[Bridge] === INSERT START, text len=' + text.length + ' ===')
      var result = insertText(text)
      if (FLOW_DEBUG_VERBOSE) bridgeDebug('[Bridge] === INSERT END, success=' + result.success + ' method=' + result.method + ' ===')
      postResult(rid, result)

    } else if (action === 'clear') {
      if (FLOW_DEBUG_VERBOSE) bridgeDebug('[Bridge] === CLEAR START ===')
      var clearResult = clearEditor()
      if (FLOW_DEBUG_VERBOSE) bridgeDebug('[Bridge] === CLEAR END, success=' + clearResult.success + ' method=' + clearResult.method + ' ===')
      postResult(rid, clearResult)

    } else if (action === 'verify') {
      var v = verifyEditor()
      if (FLOW_DEBUG_VERBOSE) bridgeDebug('[Bridge] verify:', JSON.stringify(v, null, 2))
      postResult(rid, v)

    } else if (action === 'verifyPrompt') {
      // Strict compare: returns whether the editor's current text
      // exactly matches the supplied expected prompt. Used by
      // flow-content.ts's Step 5 verify path to fail the run when
      // the bridge reports success but the actual DOM/Slate text is
      // missing or duplicated.
      var vpEl = findEditorElement()
      var vpEditorResult = vpEl ? findSlateEditor(vpEl) : null
      var vpEditor = vpEditorResult ? vpEditorResult.editor : null
      var vpExpected = (d.text as string) || (d.prompt as string) || ''
      var vpCompare = compareEditorText(vpEditor, vpEl || document.body, vpExpected)
      bridgeLog('[Bridge][VERIFY_PROMPT] expected="' + vpCompare.expected + '" exactMatch=' + vpCompare.exactMatch + ' duplicate=' + vpCompare.duplicate + ' domText="' + vpCompare.domText.substring(0, 80) + '" slateText="' + vpCompare.slateText.substring(0, 80) + '"')
      postResult(rid, {
        success: vpCompare.exactMatch && !vpCompare.duplicate,
        exactMatch: vpCompare.exactMatch,
        duplicate: vpCompare.duplicate,
        slateMatch: vpCompare.slateMatch,
        domMatch: vpCompare.domMatch,
        expected: vpCompare.expected,
        domText: vpCompare.domText.substring(0, 200),
        slateText: vpCompare.slateText.substring(0, 200),
        url: window.location.href,
      })

    } else if (action === 'debug' || action === 'scan') {
      var report = scanDOMReport()
      bridgeLog('[Bridge] DOM scan:', JSON.stringify({
        foundElement: (report.foundElement as Record<string, unknown>) ? 'YES' : 'NO',
        buttons: (report.buttons as unknown[]).length,
        scanResults: (report.scanResults as unknown[]).length
      }, null, 2))
      postResult(rid, { success: true, report: report })

    } else if (action === 'getState') {
      var state = verifyEditor()
      postResult(rid, state)

    } else if (action === 'ping') {
      postResult(rid, { pong: true, ready: true, url: window.location.href, bridgeMarker: FLOW_BRIDGE_BUILD_MARKER })

    } else if (action === 'submit') {
      if (!safeText(d.jobId)) {
        postResult(rid, { success: false, method: null, buttonText: '', error: 'FLOW_ADMISSION_REQUIRED' })
        return
      }
      bridgeLog('[Bridge] === SUBMIT START ===')
      var submitResult = submit()
      bridgeLog('[Bridge] === SUBMIT END, success=' + submitResult.success + ' method=' + submitResult.method + ' ===')
      postResult(rid, submitResult)

    } else if (action === 'submitGoogleFlow') {
      if (!safeText(d.jobId)) {
        postResult(rid, { success: false, method: 'blocked-direct-submit', error: 'FLOW_ADMISSION_REQUIRED', buttonText: '' })
        return
      }
      // DOM-first submit path for the current Google Flow composer.
      // Used when the Slate editor object is not reachable via React
      // fiber. See submitGoogleFlow() + insertGoogleFlowPrompt() in
      // the GOOGLE FLOW section above.
      //
      // NOTE: This combined insert+click action is exposed for manual
      // testing only. The production fallback in flow-content.ts calls
      // `insertGoogleFlowPromptOnly` and `submitGoogleFlowButtonOnly`
      // separately to preserve the pre-submit tile snapshot boundary.
      bridgeLog('[Bridge] === SUBMIT GOOGLE FLOW START ===')
      var gflowText = (d.text as string) || (d.prompt as string) || ''
      ;(async () => {
        try {
          var gflowResult = await submitGoogleFlow(gflowText)
          bridgeLog('[Bridge] === SUBMIT GOOGLE FLOW END, ok=' + gflowResult.ok + ' reason=' + (gflowResult.reason || '') + ' ===')
          postResult(rid, {
            success: !!gflowResult.ok,
            method: gflowResult.method || 'gflow-dom-submit',
            error: gflowResult.ok ? '' : (gflowResult.reason || 'FLOW_SUBMIT_FAILED'),
            buttonText: '',
          })
        } catch (err) {
          bridgeError('[Bridge] submitGoogleFlow error:', (err as Error)?.message || String(err))
          postResult(rid, {
            success: false,
            method: 'gflow-dom-submit',
            error: (err as Error)?.message || 'FLOW_SUBMIT_FAILED',
            buttonText: '',
          })
        }
      })()

    } else if (action === 'insertGoogleFlowPromptOnly') {
      // Insert-only DOM fallback. Does NOT click Tạo — the submit step
      // is a separate boundary so the auto-download loop can capture
      // a pre-submit tile snapshot.
      bridgeLog('[Bridge] === INSERT GOOGLE FLOW PROMPT START ===')
      var gflowInsertText = (d.text as string) || (d.prompt as string) || ''
      ;(async () => {
        try {
          var gflowInsertResult = await insertGoogleFlowPromptOnly(gflowInsertText)
          bridgeLog('[Bridge] === INSERT GOOGLE FLOW PROMPT END, success=' + gflowInsertResult.success + ' ===')
          postResult(rid, {
            success: gflowInsertResult.success,
            method: gflowInsertResult.method || 'gflow-dom-insert',
            error: gflowInsertResult.success ? '' : (gflowInsertResult.error || 'FLOW_PROMPT_INSERT_FAILED'),
          })
        } catch (err) {
          bridgeError('[Bridge] insertGoogleFlowPromptOnly error:', (err as Error)?.message || String(err))
          postResult(rid, {
            success: false,
            method: 'gflow-dom-insert',
            error: (err as Error)?.message || 'FLOW_PROMPT_INSERT_FAILED',
          })
        }
      })()

    } else if (action === 'submitGoogleFlowButtonOnly') {
      if (!safeText(d.jobId)) {
        postResult(rid, { success: false, method: 'blocked-direct-submit', error: 'FLOW_ADMISSION_REQUIRED', buttonText: '' })
        return
      }
      // Click-only DOM fallback. Used when the standard `submit` Slate
      // path fails. The prompt is assumed to already be inserted.
      bridgeLog('[Bridge] === SUBMIT GOOGLE FLOW BUTTON START ===')
      ;(async () => {
        try {
          var gflowButtonResult = await submitGoogleFlowButtonOnly()
          bridgeLog('[Bridge] === SUBMIT GOOGLE FLOW BUTTON END, success=' + gflowButtonResult.success + ' ===')
          postResult(rid, {
            success: gflowButtonResult.success,
            method: gflowButtonResult.method || 'gflow-dom-click',
            error: gflowButtonResult.success ? '' : (gflowButtonResult.error || 'FLOW_SUBMIT_BUTTON_NOT_FOUND_OR_DISABLED'),
            buttonText: '',
          })
        } catch (err) {
          bridgeError('[Bridge] submitGoogleFlowButtonOnly error:', (err as Error)?.message || String(err))
          postResult(rid, {
            success: false,
            method: 'gflow-dom-click',
            error: (err as Error)?.message || 'FLOW_SUBMIT_BUTTON_NOT_FOUND_OR_DISABLED',
            buttonText: '',
          })
        }
      })()

    } else if (action === 'addRef') {
      var addRefFileId = safeText(d.fileId)
      var addRefFileName = safeText(d.fileName)
      bridgeLog('[Bridge][rs] addRef START', addRefFileId, addRefFileName ? '(' + addRefFileName + ')' : '')
      ;(async () => {
        var result = await addFileToPrompt(addRefFileId, addRefFileName)
        bridgeLog('[Bridge][rs] addRef END', addRefFileId, 'success=' + result.success, 'method=' + result.method)
        postResult(rid, {
          success: result.success,
          method: result.method || 'unknown',
          error: result.error || '',
          fileId: addRefFileId,
        })
      })()

    } else if (action === 'removeExistingRefImages') {
      bridgeLog('[Bridge][rs] removeExistingRefImages START')
      var removeResult = removeExistingRefImages()
      bridgeLog('[Bridge][rs] removeExistingRefImages END', 'removed=' + removeResult.removed)
      postResult(rid, removeResult)

    } else if (action === 'uploadFiles') {
      var uploadFilesData = d.filesData as Array<{ key: string; name: string; type: string; base64: string }> || []
      bridgeLog('[Bridge] uploadFiles START, count=' + uploadFilesData.length)
      ;(async () => {
        var result = await uploadFilesToPrompt(uploadFilesData)
        bridgeLog('[Bridge] uploadFiles END', JSON.stringify(result))
        postResult(rid, result)
      })()

    } else if (action === 'getTiles') {
      var tiles = scanTiles()
      var counts = getTileCounts(tiles)
      bridgeLog('[Bridge] getTiles:', counts)
      postResult(rid, { tiles: tiles, counts: counts })

    } else if (action === 'getTileSnapshot') {
      // Returns a snapshot of all current tile IDs and fileNames.
      // Used by FlowContent for baseline capture before submit.
      // scanTiles() now returns a deduped list (fileName > id).
      var rawTiles = scanTiles()
      var snapIds: string[] = []
      var snapFileNames: string[] = []
      var snapDetails: Array<{
        id: string
        fileName: string
        status: string
        failedFirstSeenAt?: number
        statusReason?: string
        errorCode?: string
        evidence?: Array<Record<string, unknown>>
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
      }> = []
      for (var si = 0; si < rawTiles.length; si++) {
        snapIds.push(rawTiles[si].id)
        snapFileNames.push(rawTiles[si].fileName || '')
        snapDetails.push({
          id: rawTiles[si].id,
          fileName: rawTiles[si].fileName || '',
          status: rawTiles[si].status,
          failedFirstSeenAt: rawTiles[si].failedFirstSeenAt || 0,
          statusReason: rawTiles[si].statusReason || '',
          errorCode: rawTiles[si].errorCode || '',
          evidence: rawTiles[si].evidence || [],
          textPreview: rawTiles[si].textPreview || '',
          iconTexts: rawTiles[si].iconTexts || [],
          buttonTexts: rawTiles[si].buttonTexts || [],
          className: rawTiles[si].className || '',
          hasVideo: rawTiles[si].hasVideo || false,
          hasImg: rawTiles[si].hasImg || false,
          videoSrc: rawTiles[si].videoSrc || '',
          videoCurrentSrc: rawTiles[si].videoCurrentSrc || '',
          videoPoster: rawTiles[si].videoPoster || '',
          imgSrc: rawTiles[si].imgSrc || '',
          imgAlt: rawTiles[si].imgAlt || '',
          mediaReadyReason: rawTiles[si].mediaReadyReason || '',
        })
      }
      var nonEmptyFns = snapFileNames.filter(function (f) { return f.length > 0 }).length
      if (FLOW_DEBUG_VERBOSE) bridgeDebug('[Bridge][tileIdentity] getTileSnapshot: ids=' + snapIds.length + ' fileNames=' + nonEmptyFns)
      postResult(rid, {
        ids: snapIds,
        fileNames: snapFileNames,
        details: snapDetails,
        counts: getTileCounts(rawTiles),
        rawCount: snapIds.length, // already unique after scanTiles dedupe
      })

    } else if (action === 'getAdmissionHealth') {
      postResult(rid, getFlowAdmissionHealth())

    } else if (action === 'startTileMonitor') {
      var intervalMs = (d.intervalMs as number) || 1000
      var callbackId = 'tile-monitor-' + rid
      startTileMonitor(function (allTiles) {
        // When monitor fires, post a message to any listener
        // The callback is captured at monitor start time
        var counts = getTileCounts(allTiles)
        postResult(0, {
          type: 'tileUpdate',
          tiles: allTiles,
          counts: counts,
          newTiles: detectNewTiles(allTiles)
        })
      }, intervalMs)
      postResult(rid, { started: true, intervalMs: intervalMs })

    } else if (action === 'stopTileMonitor') {
      stopTileMonitor()
      postResult(rid, { stopped: true })

    } else if (action === 'openSettings') {
      var settingsPayload = d.payload as FlowSettingsPayload | undefined
      if (!settingsPayload) {
        postResult(rid, { success: false, error: 'no_payload' })
      } else {
        var openResult = openComposerSettings(settingsPayload)
        postResult(rid, openResult)
      }

    } else if (action === 'applySettings') {
      // FlowTrace: explicit bridge-side APPLY_SETTINGS_ACTION_START (predictable grep key)
      var applyRawPayload = d.payload || {}
      console.log('[FlowTrace][Bridge] APPLY_SETTINGS_ACTION_START', JSON.stringify({
        mode: (applyRawPayload as Record<string, unknown>).mode,
        model: (applyRawPayload as Record<string, unknown>).model,
        ratio: (applyRawPayload as Record<string, unknown>).ratio || (applyRawPayload as Record<string, unknown>).aspectRatio,
        quantity: (applyRawPayload as Record<string, unknown>).quantity,
        duration: (applyRawPayload as Record<string, unknown>).duration || '',
        url: window.location.href,
        flag_ENABLE_FLOW_SETTINGS_AUTOMATION: ENABLE_FLOW_SETTINGS_AUTOMATION,
      }))
      var rawPayload = d.payload
      if (!rawPayload) {
        console.error('[FlowTrace][Fail]', JSON.stringify({
          step: 'bridge.applySettings',
          reason: 'FLOW_BRIDGE_NO_PAYLOAD',
          rawResult: null,
        }))
        postResult(rid, { success: false, error: 'no_payload' })
      } else {
        var applyResult = await applyFlowSettings(rawPayload)
        // FlowTrace: explicit bridge-side APPLY_SETTINGS_ACTION_RESULT (predictable grep key)
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_ACTION_RESULT', JSON.stringify({
          success: !!(applyResult as Record<string, unknown>).success,
          error: (applyResult as Record<string, unknown>).error || '',
          method: (applyResult as Record<string, unknown>).method || '',
          current: (applyResult as Record<string, unknown>).current || null,
          hasDetails: !!(applyResult as Record<string, unknown>).details,
          detailsKeys: Object.keys(((applyResult as Record<string, unknown>).details as Record<string, unknown>) || {}),
        }))
        postResult(rid, applyResult)
      }

    } else if (action === 'downloadTileMedia') {
      ;(async () => {
        bridgeLog('[Bridge][download] START', JSON.stringify({
          tileId: d.tileId,
          mode: d.mode,
          resolution: d.resolution,
          videoResolution: d.videoResolution,
          fileName: d.fileName,
          taskName: d.taskName,
          index: d.index,
        }))
        var downloadResult = await downloadTileMediaFromBridge({
          tileId: d.tileId as string || '',
          mode: ((d.mode as string) || 'image') as 'image' | 'video',
          resolution: d.resolution as string || '1k',
          videoResolution: d.videoResolution as string || '720p',
          fileName: d.fileName as string || '',
          taskName: d.taskName as string || '',
          index: d.index as number || 1,
          promptText: d.promptText as string || 'flow',
        })
        bridgeLog('[Bridge][download] RESULT', JSON.stringify(downloadResult))
        postResult(rid, downloadResult)
      })()
    }
  }

  window.addEventListener('message', handleMessage)
  bridgeRuntimeInstance.messageListenerCount = 1
  bridgeRuntimeInstance.submitHandlerCount = 1

  // Mark the page so dev console helpers can detect the real bridge
  // and back off. Without this, a stale dev-helper bundle injected as
  // a content script could register a competing listener on the same
  // postMessage channel.
  try { document.documentElement.setAttribute('data-flow-bridge-real-installed', BRIDGE_INSTANCE_ID) } catch (_) {}

  ;(window as Record<string, unknown>).__flowSlateBridgeCleanup = function () {
    window.removeEventListener('message', handleMessage)
    bridgeRuntimeInstance.messageListenerCount = 0
    bridgeRuntimeInstance.submitHandlerCount = 0
    if (_tileMonitorInterval) {
      clearInterval(_tileMonitorInterval)
      _tileMonitorInterval = null
    }
    bridgeRuntimeInstance.pollingLoopCount = 0
    // Drop instance markers so the next bridge load is a clean slate.
    try { delete (window as Record<string, unknown>).__FLOW_BRIDGE_INSTANCE_ID__ } catch (_) {}
    try { document.documentElement.removeAttribute('data-flow-bridge-real-installed') } catch (_) {}
    bridgeLog('[Bridge] cleanup done instance=' + BRIDGE_INSTANCE_ID)
  }

  // ═══════════════════════════════════════════════════════════════
  // SETTINGS AUTOMATION
  // ═══════════════════════════════════════════════════════════════

  // Normalize incoming payload — single source of truth for format
  function normalizeFlowSettingsPayload(payload: any): Record<string, unknown> {
    var rawMode = safeLower(payload?.mode || payload?.genType || 'image')
    var mode = rawMode === 'video' ? 'video' : 'image'

    var quantityRaw = Number(payload?.quantity)
    var quantity = Math.max(1, Math.min(4, Number.isFinite(quantityRaw) ? quantityRaw : 1))

    // frameFileIds: only present in Video Frames mode. isFrames is derived from it.
    var rawFrameFileIds = payload?.frameFileIds as { frame1?: string; frame2?: string } | null | undefined
    var hasFrameFileIds = rawFrameFileIds && (rawFrameFileIds.frame1 || rawFrameFileIds.frame2)

    // Google Flow Video only — "Khung hình" / "Thành phần" segmented
    // control inside the settings popup. undefined means "do not
    // touch" (legacy workflows rely on Flow's current default which
    // is 'ingredient'). Invalid values are dropped.
    var rawFlowVideoMode = payload?.flowVideoMode
    var flowVideoMode: 'frame' | 'ingredient' | undefined =
      rawFlowVideoMode === 'frame' || rawFlowVideoMode === 'ingredient'
        ? (rawFlowVideoMode as 'frame' | 'ingredient')
        : undefined

    return {
      mode: mode,
      model: safeText(payload?.model || payload?.modelName),
      ratio: safeText(payload?.ratio || payload?.aspectRatio || '16:9'),
      quantity: quantity,
      duration: safeText(payload?.duration || payload?.flowVideoDuration),
      // fileIds: stable reference IDs — NO upload_xxx (validated in GenPanel + FlowContent)
      fileIds: (payload?.fileIds as string[]) || [],
      fileNameMap: (payload?.fileNameMap as Record<string, string>) || {},
      // frameFileIds: only present in Video Frames mode
      frameFileIds: hasFrameFileIds ? rawFrameFileIds : undefined,
      // isFrames is ONLY true when frameFileIds is present — never from ref count
      isFrames: !!hasFrameFileIds,
      // Google Flow Video input mode (Khung hình / Thành phần)
      flowVideoMode: flowVideoMode,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // NEW SETTINGS AUTOMATION HELPERS
  // ═══════════════════════════════════════════════════════════════

  // Full event chain for reliable React/Radix clicks
  function dispatchFullClick(el: Element): void {
    var rect = el.getBoundingClientRect()
    var x = rect.left + rect.width / 2
    var y = rect.top + rect.height / 2
    var mouse = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0 as 0,
      buttons: 1 as 1,
    }
    el.dispatchEvent(new PointerEvent('pointerdown', { ...mouse, pointerType: 'mouse' }))
    el.dispatchEvent(new MouseEvent('mousedown', mouse))
    el.dispatchEvent(new PointerEvent('pointerup', { ...mouse, pointerType: 'mouse' }))
    el.dispatchEvent(new MouseEvent('mouseup', mouse))
    el.dispatchEvent(new MouseEvent('click', mouse))
  }

  // Check if an element is a visible panel (not a trigger/button, visible dimensions)
  function isVisiblePanel(el: Element | typeof document): boolean {
    if (!el || el === document || !(el instanceof Element)) return false
    if (el.tagName === 'BUTTON') return false
    if (el.hasAttribute('aria-haspopup')) return false
    try {
      var rect = el.getBoundingClientRect()
      var style = window.getComputedStyle(el as Element)
      return (
        rect.width > 20 &&
        rect.height > 20 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      )
    } catch (_) {
      return false
    }
  }

  // Check if element has >= 2 groups of settings controls (mode + quantity, or mode + ratio, etc.)
  function hasSettingsPanelControls(el: Element): boolean {
    // Reject trigger/button elements — they have aria-haspopup but are not containers
    if (el.tagName === 'BUTTON') return false
    if (el.hasAttribute('aria-haspopup')) return false

    var text = el.textContent || ''

    var hasMode = !!(
      el.querySelector('button[id$="-trigger-IMAGE"], button[id$="-trigger-VIDEO"]') ||
      /\b(Image|Video|\u1ea2nh|H\u00ecnh)\b/i.test(text)
    )

    var hasQuantity = !!(
      el.querySelector('button[id$="-trigger-1"], button[id$="-trigger-2"], button[id$="-trigger-3"], button[id$="-trigger-4"]') ||
      /\b(x1|x2|x3|x4|1x|2x|3x|4x)\b/i.test(text)
    )

    var hasRatio = !!(
      el.querySelector('button[id*="-trigger-LANDSCAPE"], button[id*="-trigger-PORTRAIT"], button[id*="-trigger-SQUARE"]') ||
      /crop_(16_9|9_16|square|portrait|landscape)/.test(text)
    )

    var groups = [hasMode, hasQuantity, hasRatio].filter(Boolean).length
    return groups >= 2
  }

  // Iterate popup candidates newest-first, only return a real settings panel
  function getActiveFlowSettingsPanel(): Element | typeof document {
    var selectors = [
      '[data-radix-popper-content-wrapper]',
      '[data-radix-menu-content]',
      '[data-radix-dialog-content]',
      '[data-side]',
      '[data-align]',
      '[id^="radix-"][role="menu"]',
      '[id^="radix-"][role="dialog"]',
      '[id^="radix-"][role="listbox"]',
      '[role="dialog"]',
      '[role="menu"]',
      '[role="listbox"]',
    ]
    var candidates = Array.from(document.querySelectorAll(selectors.join(',')))
    for (var i = candidates.length - 1; i >= 0; i--) {
      var el = candidates[i] as Element
      if (isVisiblePanel(el) && hasSettingsPanelControls(el)) {
        return el
      }
    }
    return document
  }

  // Poll until a real settings panel is detected
  async function waitForFlowSettingsPanel(timeoutMs: number = 5000): Promise<Element | null> {
    var start = Date.now()
    while (Date.now() - start < timeoutMs) {
      var panel = getActiveFlowSettingsPanel()
      if (panel && panel !== document) {
        bridgeLog('[Bridge][rs] settings panel found=true')
        return panel
      }
      await sleep(100)
    }
    bridgeWarn('[Bridge][rs] settings panel found=false')
    return null
  }

// Collect every viable VIDEO/IMG candidate inside the tile in priority
  // order. Used for the per-candidate retry loop so a failed first
  // attempt falls through to the next candidate instead of failing the
  // whole tile.
  function collectDownloadMediaCandidates(
    tileEl: HTMLElement,
    preferVideo: boolean
  ): Array<HTMLVideoElement | HTMLImageElement> {
    var candidates: Array<HTMLVideoElement | HTMLImageElement> = []
    var seen = new Set<Element>()
    var tileTextLower = (tileEl.textContent || '').toLowerCase()

    var videos = Array.from(tileEl.querySelectorAll('video')) as HTMLVideoElement[]
    videos = videos.filter(function (v) { return hasValidVideoSrc(v) })

    var imgs = Array.from(tileEl.querySelectorAll('img')) as HTMLImageElement[]
    imgs = imgs.filter(function (img) { return hasValidImageSrc(img) })

    function pushIfNew(el: Element | null) {
      if (el && !seen.has(el)) {
        seen.add(el)
        candidates.push(el as HTMLVideoElement | HTMLImageElement)
      }
    }

    if (preferVideo) {
      // Priority 1: <video> elements
      videos.forEach(pushIfNew)
      // Priority 2: <img> with "video" alt / tile text contains "video"
      var videoImgs = imgs.filter(function (img) {
        var alt = (img.alt || '').toLowerCase()
        return alt.indexOf('video') >= 0 || tileTextLower.indexOf('video') >= 0
      })
      videoImgs.forEach(pushIfNew)
      // Priority 3: any remaining valid <img>
      imgs.forEach(pushIfNew)
    } else {
      imgs.forEach(pushIfNew)
      videos.forEach(pushIfNew)
    }

    return candidates
  }

  // ── Media element validation ───────────────────────────────────────────
  // A valid <video> src must be one of: blob:, /fx/api/trkc/..., or https://...
  // Reject media.html / .html extension, empty src, chrome-extension://
  function hasValidVideoSrc(el: HTMLVideoElement | null): boolean {
    if (!el) return false
    var src = el.src || ''
    var current = el.currentSrc || ''
    var test = src || current
    if (!test) return false
    if (test === window.location.href) return false
    if (test.startsWith('chrome-extension://')) return false
    if (test.endsWith('.html') || test.includes('media.html')) return false
    if (test.length < 8) return false
    return test.startsWith('blob:') ||
           test.startsWith('/fx/api/') ||
           test.startsWith('https://') ||
           test.startsWith('http://')
  }

  function hasValidImageSrc(el: HTMLImageElement | null): boolean {
    if (!el) return false
    var src = el.src || ''
    var current = el.currentSrc || ''
    var test = src || current
    if (!test) return false
    if (test === window.location.href) return false
    if (test.startsWith('chrome-extension://')) return false
    if (test.startsWith('data:')) return false
    if (test.endsWith('.html') || test.includes('media.html')) return false
    if (test.length < 8) return false
    return test.startsWith('blob:') ||
           test.startsWith('/fx/api/') ||
           test.startsWith('https://') ||
           test.startsWith('http://')
  }

  // Strictly normalize a candidate to either HTMLVideoElement or
  // HTMLImageElement. NEVER returns a wrapper/container DIV. If the input
  // is a DIV, walks DOWN to find a child VIDEO or IMG.
  function normalizeMediaElement(el: Element | null): HTMLVideoElement | HTMLImageElement | null {
    if (!el) return null
    if (el instanceof HTMLVideoElement) return el
    if (el instanceof HTMLImageElement) return el
    if (typeof el.querySelector !== 'function') return null
    var v = el.querySelector('video')
    if (v instanceof HTMLVideoElement) return v
    var i = el.querySelector('img')
    if (i instanceof HTMLImageElement) return i
    return null
  }

  // Wait for the tile's media element to be ready for download. Returns the
  // resolved HTMLVideoElement or HTMLImageElement (NEVER a DIV, NEVER null
  // unless timeout). preferVideo=true → poll <video> first then <img>;
  // preferVideo=false → poll <img> first.
  async function waitForTileMediaReady(
    tileEl: HTMLElement,
    timeoutMs: number,
    preferVideo: boolean
  ): Promise<HTMLVideoElement | HTMLImageElement | null> {
    var start = Date.now()
    var lastLog = 0
    while (Date.now() - start < timeoutMs) {
      var raw: Element | null = null
      if (preferVideo) {
        raw = tileEl.querySelector('video')
        if (!raw) {
          var vImgs = tileEl.querySelectorAll('img')
          for (var vwi = 0; vwi < vImgs.length; vwi++) {
            var vImg = vImgs[vwi]
            var vAlt = (vImg.alt || '').toLowerCase()
            var vTc = (tileEl.textContent || '').toLowerCase()
            if (vAlt.indexOf('video') >= 0 || vTc.indexOf('video') >= 0) {
              raw = vImg
              break
            }
          }
        }
      } else {
        raw = tileEl.querySelector('img') || tileEl.querySelector('video')
      }

      var mediaEl = normalizeMediaElement(raw)

      // Strict gate: only resolve when we have a VIDEO or IMG AND its src
      // passes hasValidVideoSrc / hasValidImageSrc.
      if (mediaEl instanceof HTMLVideoElement && hasValidVideoSrc(mediaEl)) {
        return mediaEl
      }
      if (mediaEl instanceof HTMLImageElement && hasValidImageSrc(mediaEl)) {
        return mediaEl
      }

      if (Date.now() - lastLog > 2000) {
        lastLog = Date.now()
        bridgeLog('[Bridge][download] waiting for media ready preferVideo=' + preferVideo)
      }
      await sleep(200)
    }
    bridgeWarn('[Bridge][download] waitForTileMediaReady TIMEOUT preferVideo=' + preferVideo)
    return null
  }

  // Open settings panel — click only if real panel is not already open
  async function openFlowSettingsPanel(settingsBtn: Element): Promise<Element | null> {
    var existing = getActiveFlowSettingsPanel()

    if (existing && existing !== document && hasSettingsPanelControls(existing)) {
      bridgeLog('[Bridge][rs] settings panel already open \u2014 skip toggle')
      return existing
    }

    bridgeLog('[Bridge][rs] settings panel not open \u2014 clicking settings button')
    dispatchFullClick(settingsBtn)
    return await waitForFlowSettingsPanel(5000)
  }

  // Find settings button by 4-tier fallback
  function getFlowSettingsButton(submitBtn: Element | null = null): HTMLElement | null {
    var buttons = Array.from(document.querySelectorAll('button')) as HTMLElement[]

    // Tier 1: aria-haspopup="menu" + crop_ icon/text
    for (var bi = 0; bi < buttons.length; bi++) {
      var btn = buttons[bi]
      var text = btn.textContent || ''
      if (btn.getAttribute('aria-haspopup') === 'menu' && text.includes('crop_')) {
        return btn
      }
    }

    // Tier 2: id starts with "radix-" + crop_ icon/text
    for (var bi2 = 0; bi2 < buttons.length; bi2++) {
      var btn2 = buttons[bi2]
      var text2 = btn2.textContent || ''
      if ((btn2.id || '').startsWith('radix-') && text2.includes('crop_')) {
        return btn2
      }
    }

    // Tier 3: sibling immediately before submit button
    if (submitBtn && submitBtn.previousElementSibling) {
      if (submitBtn.previousElementSibling.tagName === 'BUTTON') {
        return submitBtn.previousElementSibling as HTMLElement
      }
    }

    // Tier 4: any button with crop_ icon/text
    for (var bi3 = 0; bi3 < buttons.length; bi3++) {
      var btn3 = buttons[bi3]
      if ((btn3.textContent || '').includes('crop_')) {
        return btn3
      }
    }

    return null
  }

  // Dump diagnostics for debugging settings panel issues
  function collectSettingsPanelDiagnostics(settingsBtn: HTMLElement | null): Record<string, unknown> {
    var diag: Record<string, unknown> = {}
    try {
      var selList = [
        '[data-radix-popper-content-wrapper]',
        '[data-radix-menu-content]',
        '[data-radix-dialog-content]',
        '[data-side]',
        '[data-align]',
        '[role="dialog"]',
        '[role="menu"]',
        '[role="listbox"]',
      ]
      var allCands = Array.from(document.querySelectorAll(selList.join(',')))
      diag.candidateCount = allCands.length
      var candBtns: Array<{ tag: string; text: string; id: string; visible: boolean }> = []
      for (var ci = 0; ci < allCands.length; ci++) {
        var c = allCands[ci]
        try {
          candBtns.push({
            tag: c.tagName,
            text: (c.textContent || '').trim().slice(0, 60),
            id: c.id,
            visible: isVisiblePanel(c),
          })
        } catch (_) {}
      }
      diag.candidates = candBtns.slice(0, 10)
      var allBtns: string[] = []
      var allEls = Array.from(document.querySelectorAll('button'))
      for (var i = 0; i < Math.min(20, allEls.length); i++) {
        allBtns.push((allEls[i].textContent || '').trim().slice(0, 60))
      }
      diag.topButtonTexts = allBtns
      diag.settingsBtnText = settingsBtn ? (settingsBtn.textContent || '').trim().slice(0, 120) : null
      diag.settingsBtnId = settingsBtn ? settingsBtn.id : null
      diag.settingsBtnAriaHaspopup = settingsBtn ? settingsBtn.getAttribute('aria-haspopup') : null
      diag.settingsBtnRect = settingsBtn ? JSON.parse(JSON.stringify(settingsBtn.getBoundingClientRect())) : null
      var ae = document.activeElement
      diag.activeElement = ae ? { tag: ae.tagName, text: (ae.textContent || '').trim().slice(0, 60) } : null
    } catch (_) {}
    return diag
  }

  // ── Quantity helpers ──────────────────────────────────────────────────────
  function buildRadixTriggerSelector(suffix: string | number): string {
    return 'button[id$="-trigger-' + String(suffix) + '"]'
  }

  function parseQuantityText(value: unknown): number | null {
    var text = String(value ?? '').trim()
    var match = text.match(/^(\d)x$|^x(\d)$/i)
    if (!match) return null
    var qty = Number(match[1] || match[2])
    if (qty < 1 || qty > 4) return null
    return qty
  }

  // Read current settings from the settings button chip (NOT panel active tabs)
  function readCurrentSettingsFromSettingsButton(settingsBtn?: Element | null): Record<string, unknown> | null {
    var btn = settingsBtn || (getFlowSettingsButton as (s?: Element | null) => HTMLElement | null)()

    if (!btn) return null

    var quantity: number | null = null
    var model = ''
    var ratioIcon = ''

    var iconTexts = Array.from(btn.querySelectorAll('*'))
      .map(function (el) { return safeText((el as HTMLElement).textContent) })
      .filter(Boolean)

    ratioIcon = iconTexts.find(function (t) { return t.startsWith('crop_') }) || ''

    for (var ni = 0; ni < btn.childNodes.length; ni++) {
      var node = btn.childNodes[ni]
      if (node.nodeType !== Node.TEXT_NODE) continue

      var text = safeText(node.textContent)
      if (!text) continue

      var qty = parseQuantityText(text)
      if (qty) {
        quantity = qty
        continue
      }

      if (!model) {
        model = text.replace(/^[\u{1F000}-\u{1FFFF}]\s*/u, '').trim()
      }
    }

    return {
      model: model,
      ratioIcon: ratioIcon,
      quantity: quantity,
      rawText: safeText(btn.textContent)
    }
  }

  // Select quantity: radix ID first, text fallback, verify via settings button chip
  async function selectFlowQuantity(targetQuantity: number, settingsBtn: Element | null): Promise<Record<string, unknown>> {
    var q = Math.max(1, Math.min(4, Number(targetQuantity) || 1))

    var before = readCurrentSettingsFromSettingsButton(settingsBtn)
    if (before?.quantity === q) {
        bridgeLog('[Bridge][rs] select quantity SKIPPED — already matched', q)
      return { success: true, quantity: q, skipped: true }
    }

    bridgeLog('[Bridge][rs] select quantity START', q)
    bridgeDebug('[Bridge][rs] quantity before:', before)

    // ID-based: button[id$="-trigger-2"]
    var quantityBtn = document.querySelector(buildRadixTriggerSelector(q)) as HTMLElement | null

    // Text fallback: "x2" or "2x"
    if (!quantityBtn) {
      var allButtons = Array.from(document.querySelectorAll('button')) as HTMLElement[]
      for (var bi = 0; bi < allButtons.length; bi++) {
        var btn = allButtons[bi]
        var text = String(btn.textContent ?? '').trim()
        if (text === 'x' + q || text === q + 'x') {
          quantityBtn = btn
          break
        }
      }
    }

    if (!quantityBtn) {
      return {
        success: false,
        error: 'FLOW_QUANTITY_BUTTON_NOT_FOUND',
        details: {
          quantity: q,
          available: Array.from(document.querySelectorAll('button'))
            .map(function (btn) {
              return {
                id: (btn as HTMLElement).id,
                text: String((btn as HTMLElement).textContent ?? '').trim()
              }
            })
            .filter(function (x) {
              return /-trigger-[1-4]$/.test(x.id) || /^x[1-4]$|^[1-4]x$/i.test(x.text)
            })
        }
      }
    }

    dispatchFullClick(quantityBtn)
    await sleep(250)

    var after = readCurrentSettingsFromSettingsButton(settingsBtn)
    bridgeDebug('[Bridge][rs] quantity after click:', after)

    // Retry via settings button chip (NOT panel active tabs)
    for (var i = 0; i < 5 && (after === null || (after as Record<string, unknown>).quantity !== q); i++) {
      await sleep(150)
      after = readCurrentSettingsFromSettingsButton(settingsBtn)
      if ((after as Record<string, unknown>)?.quantity === q) {
        bridgeLog('[Bridge][rs] quantity matched/applied:', q)
        return { success: true, quantity: q }
      }
    }

    var finalState = readCurrentSettingsFromSettingsButton(settingsBtn)

    if ((finalState as Record<string, unknown>)?.quantity !== q) {
      return {
        success: false,
        error: 'FLOW_QUANTITY_VERIFY_FAILED',
        details: {
          expected: q,
          actual: (finalState as Record<string, unknown>)?.quantity ?? null,
          rawText: (finalState as Record<string, unknown>)?.rawText ?? ''
        }
      }
    }

    bridgeLog('[Bridge][rs] quantity matched/applied:', q)
    return { success: true, quantity: q }
  }

  // ═══════════════════════════════════════════════════════════════
  // MODEL CONSTANTS & NORMALIZATION
  // ═══════════════════════════════════════════════════════════════

  // Model aliases for matching Flow UI button text
  var FLOW_MODEL_ALIASES: Record<string, string[]> = {
    'nano banana pro':                        ['nano-banana-pro', 'banana-pro'],
    'nano banana 2':                          ['nano-banana-2', 'banana-2'],
    'imagen 3':                               ['imagen-3'],

    'omni flash':                             ['omni-flash'],
    'veo 3.1 - lite':                        ['veo 3.1 lite', 'veo-3.1-lite', 'veo-lite'],
    'veo 3.1 - fast':                        ['veo 3.1 fast', 'veo-3.1-fast', 'veo-fast'],
    'veo 3.1 - quality':                      ['veo 3.1 quality', 'veo-3.1-quality', 'veo-quality'],
    'veo 3.1 - lite [lower priority]':       ['veo 3.1 lite lower priority', 'veo 3.1 - lite lower priority', 'veo-3.1-lite-lower-priority'],
  }

  function matchModelOption(targetModel: string, buttonText: string): boolean {
    var normTarget = normalizeFlowModelText(targetModel)
    var normBtn = normalizeFlowModelText(buttonText)
    if (normTarget === normBtn) return true
    var aliases = FLOW_MODEL_ALIASES[normTarget] || []
    for (var ai = 0; ai < aliases.length; ai++) {
      if (normBtn.includes(aliases[ai]) || aliases[ai].includes(normBtn)) return true
    }
    // Partial fuzzy match: target words must all appear in button text
    var words = normTarget.split(' ')
    if (words.length >= 2) {
      var allFound = true
      for (var wi = 0; wi < words.length; wi++) {
        if (!normBtn.includes(words[wi])) { allFound = false; break }
      }
      if (allFound) return true
    }
    return false
  }

  // Select model in the settings panel — normalize + alias match, structured error
  async function selectFlowModel(panel: Element, targetModel: string): Promise<Record<string, unknown>> {
    var allBtns = Array.from((panel as Element).querySelectorAll('button, [role="menuitem"], [role="option"]')) as HTMLElement[]
    var matchedBtn: HTMLElement | null = null

    for (var bi = 0; bi < allBtns.length; bi++) {
      var b = allBtns[bi]
      var bText = (b.textContent || '').trim()
      if (matchModelOption(targetModel, bText)) {
        matchedBtn = b
        break
      }
    }

    if (!matchedBtn) {
      return {
        success: false,
        error: 'FLOW_MODEL_OPTION_NOT_FOUND',
        details: {
          model: targetModel,
          normalizedModel: normalizeFlowModelText(targetModel),
          availableButtons: allBtns.slice(0, 10).map(function (b2) { return (b2.textContent || '').trim().slice(0, 60) }),
        }
      }
    }

    dispatchFullClick(matchedBtn)
    await sleep(300)
    var clickedText = (matchedBtn.textContent || '').trim()
    bridgeLog('[Bridge][rs] select model matched ' + clickedText)
    bridgeLog('[Bridge][rs] select model SUCCESS ' + clickedText)
    return { success: true, clickedText: clickedText }
  }

  interface FlowSettingsPayload {
    prompt: string
    mode: 'image' | 'video'
    model: string
    aspectRatio: string
    quantity: number
    duration?: string
    style: string | null
    // fileIds: stable reference IDs (tileId from existing Flow images). NO upload_xxx.
    fileIds: string[]
    // fileNameMap: maps fileId → display name
    fileNameMap: Record<string, string>
    // pendingFiles: REMOVED — resolved to tileIds in GenPanel before RUN_FLOW_PROMPT
    autoDownload: boolean
    outputFolder: string
    resolution: string
  }

  // ── Text normalization ───────────────────────────────────────────

  // Global popup container (reused by both openComposerSettings and applyFlowSettings)
  var currentPopupContainer: HTMLElement | null = null

  function normalizeText(text: string): string {
    return safeLower(text)
  }

  function textMatches(haystack: string, needles: string[]): boolean {
    var norm = normalizeText(haystack)
    for (var ni = 0; ni < needles.length; ni++) {
      if (norm.includes(normalizeText(needles[ni]))) return true
    }
    return false
  }

  // ── Popup container detection ───────────────────────────────────

  function findPopupContainer(): HTMLElement | null {
    // Check cached ref first
    if (currentPopupContainer) {
      try {
        if (currentPopupContainer.offsetWidth > 100 && currentPopupContainer.offsetHeight > 80) {
          return currentPopupContainer
        }
      } catch (_) {}
    }

    // Header/page reject list — full-page wrappers only
    // close/đóng/left_panel_close exist INSIDE real popups — do NOT reject by these
    var headerRejects = [
      'arrow_back', 'quay lại', 'back', 'more_vert', 'search',
      'filter_list', 'filter', 'add', 'thêm nội dung nghe nhìn',
      'help', 'settings', 'ultra'
    ]

    function isHeaderContainer(text: string): boolean {
      var t = normalizeText(text)
      for (var ri = 0; ri < headerRejects.length; ri++) {
        if (t.includes(headerRejects[ri])) return true
      }
      return false
    }

    // Try role-based selectors first
    var selectors = [
      '[role="dialog"]', '[role="menu"]',
      '[class*="popover"]', '[class*="dropdown"]',
      '[class*="dialog"]', '[class*="settings-panel"]',
      '[class*="sheet"]', '[class*="modal"]',
    ]
    for (var si = 0; si < selectors.length; si++) {
      try {
        var el = document.querySelector(selectors[si]) as HTMLElement | null
        if (el && el.offsetWidth > 100 && el.offsetHeight > 80) {
          var txt = (el.textContent || '').trim()
          if (isHeaderContainer(txt)) {
            bridgeDebug('[Bridge] findPopupContainer: rejecting header container from selector: ' + selectors[si])
            continue
          }
          currentPopupContainer = el
          return el
        }
      } catch (_) {}
    }

    // Visual scoring fallback: scan all div/section
    var allEls = document.querySelectorAll('div, section')
    var bestEl: HTMLElement | null = null
    var bestScore = 0
    for (var ai = 0; ai < allEls.length; ai++) {
      try {
        var el2 = allEls[ai] as HTMLElement
        if (el2.offsetWidth < 180 || el2.offsetHeight < 120) continue
        if (el2.offsetWidth > 500 || el2.offsetHeight > 600) continue // too large = page
        var txt = (el2.textContent || '').trim()
        if (isHeaderContainer(txt)) continue
        var style = window.getComputedStyle(el2)
        var zIdx = parseInt(style.zIndex || '0', 10)
        var textL = normalizeText(txt)
        var score = 0
        if (style.position === 'fixed' || style.position === 'absolute') score += 10
        if (zIdx > 10) score += 15
        if (textL.includes('hình ảnh') || textL.includes('video')) score += 20
        if (textL.includes('9:16') || textL.includes('16:9') || textL.includes('1x') || textL.includes('2x')) score += 15
        if (textL.includes('nano banana') || textL.includes('veo')) score += 15
        if (score > bestScore && score >= 30) {
          bestScore = score
          bestEl = el2
        }
      } catch (_) {}
    }
    if (bestEl) {
      currentPopupContainer = bestEl
      return bestEl
    }
    return null
  }

  // ── React-aware click ─────────────────────────────────────────

  function clickReactFirst(el: HTMLElement): string | null {
    // Try React props chain (__reactProps$, __reactFiber$, etc.)
    var propsKeys = getReactPropsKeys(el)
    for (var pi = 0; pi < propsKeys.length; pi++) {
      try {
        var props = (el as Record<string, unknown>)[propsKeys[pi]] as Record<string, unknown>
        if (props && typeof props.onClick === 'function') {
          var fakeEvent: Record<string, unknown> = {
            preventDefault: function () {}, stopPropagation: function () {}, persist: function () {},
            nativeEvent: { isTrusted: true }, isTrusted: true,
            target: el, currentTarget: el, bubbles: true, cancelable: true,
            defaultPrevented: false, eventPhase: 3, timeStamp: Date.now(),
            type: 'click', button: 0, buttons: 1,
            clientX: 0, clientY: 0
          }
          ;(props.onClick as (e: unknown) => void)(fakeEvent)
          return '__reactProps$.onClick'
        }
      } catch (_) {}
    }

    // Try fiber memoizedProps
    var fiberKeys = getReactFiberPropsKeys(el)
    for (var fi = 0; fi < fiberKeys.length; fi++) {
      try {
        var fiber = (el as Record<string, unknown>)[fiberKeys[fi]] as Record<string, unknown>
        var depth = 0
        while (fiber && depth < 20) {
          try {
            var mp = (fiber as Record<string, unknown>).memoizedProps as Record<string, unknown> | null
            if (mp && typeof mp.onClick === 'function') {
              var fakeEvt: Record<string, unknown> = {
                preventDefault: function () {}, stopPropagation: function () {}, persist: function () {},
                nativeEvent: { isTrusted: true }, isTrusted: true,
                target: el, currentTarget: el, bubbles: true, cancelable: true,
                defaultPrevented: false, eventPhase: 3, timeStamp: Date.now(),
                type: 'click', button: 0, buttons: 1,
                clientX: 0, clientY: 0
              }
              ;(mp.onClick as (e: unknown) => void)(fakeEvt)
              return 'fiber.memoizedProps.onClick'
            }
          } catch (_) {}
          fiber = (fiber as Record<string, unknown>).return as Record<string, unknown> | null
          depth++
        }
      } catch (_) {}
    }

    // Direct click as last resort
    el.click()
    return 'element.click()'
  }

  // ── Open composer settings popup ───────────────────────────────

  // ── Find composer container (parent chain walk) ──────────────────

  function findComposerContainer(el: HTMLElement): HTMLElement | null {
    var editorRect: DOMRect | null = null
    try { editorRect = el.getBoundingClientRect() } catch (_) {}

    var parent = el.parentElement
    var depth = 0
    var bestCandidate: HTMLElement | null = null
    var bestScore = 0
    var chainInfo: Array<Record<string, unknown>> = []

    while (parent && depth < 12) {
      var p = parent as HTMLElement
      var pRect: DOMRect | null = null
      try { pRect = p.getBoundingClientRect() } catch (_) {}
      var pText = (p.textContent || '').trim().substring(0, 100)
      var pClass = (p.className || '').substring(0, 80)
      var pTag = p.tagName

      // Check for composer indicators
      var hasSubmitBtn = p.querySelector('button:not([disabled]), [role="button"]:not([disabled])') !== null
      var chipKeywords = ['video', 'nano banana', 'nano-banana', '8s', '6s', '4s', 'x1', 'x2', 'x3', 'x4', 'tác nhân', 'veo', 'banana', 'flux']
      var hasChipKeyword = textMatches(pText, chipKeywords)
      var hasEditor = p.contains(el)

      // Scoring
      var score = 0
      if (hasEditor) score += 20
      if (hasChipKeyword) score += 15
      if (hasSubmitBtn) score += 10

      if (pRect && editorRect) {
        // Must be in lower half of screen
        if (pRect.top > window.innerHeight * 0.45) score += 15
        // Width should be reasonable
        if (pRect.width > 300) score += 5
        // Should contain editor vertically
        if (pRect.top <= editorRect.top && pRect.bottom >= editorRect.bottom) score += 10
      }

      chainInfo.push({
        depth: depth,
        tag: pTag,
        class: pClass.substring(0, 60),
        text: pText.substring(0, 60),
        rect: pRect ? { top: Math.round(pRect.top), bottom: Math.round(pRect.bottom), left: Math.round(pRect.left), right: Math.round(pRect.right), width: Math.round(pRect.width) } : null,
        hasSubmitBtn: hasSubmitBtn,
        hasChipKeyword: hasChipKeyword,
        score: score
      })

      if (score > bestScore && hasEditor) {
        bestScore = score
        bestCandidate = p
      }

      parent = parent.parentElement as HTMLElement | null
      depth++
    }

    // Log the chain for debugging
    bridgeDebug('[Bridge] findComposerContainer chain (' + chainInfo.length + ' levels):')
    chainInfo.forEach(function (info) {
      bridgeDebug('  [' + info.depth + '] ' + info.tag + ' class="' + info.class + '" score=' + info.score + ' rect=' + (info.rect ? JSON.stringify(info.rect) : 'null') + ' chip=' + info.hasChipKeyword + ' submit=' + info.hasSubmitBtn)
    })

    if (bestCandidate) {
      bridgeDebug('[Bridge] findComposerContainer: best candidate depth=' + (chainInfo.length > 0 ? chainInfo[chainInfo.length - 1] : null) + ' score=' + bestScore)
    }

    return bestCandidate
  }

  // ── Get buttons near editor (returns live DOM refs, not clones) ──────

  function getButtonsNearEditor(el: HTMLElement): HTMLElement[] {
    var editorRect: DOMRect | null = null
    try { editorRect = el.getBoundingClientRect() } catch (_) {}
    if (!editorRect) return []

    var result: HTMLElement[] = []
    var allBtns = document.querySelectorAll('button:not([disabled]), [role="button"]:not([disabled])')
    allBtns.forEach(function (btn) {
      var b = btn as HTMLElement
      try {
        var r = b.getBoundingClientRect()
        var centerY = r.top + r.height / 2
        var editorCenterY = editorRect!.top + editorRect!.height / 2
        var vDist = Math.abs(centerY - editorCenterY)
        // Wide horizontal band: buttons within 300px of editor center vertically
        if (vDist < 300) {
          result.push(b)
        }
      } catch (_) {}
    })
    return result
  }

  // ── Build virtual scope around editor (for debug) ───────────────

  function buildEditorVirtualScope(el: HTMLElement): HTMLElement | null {
    var editorRect: DOMRect | null = null
    try { editorRect = el.getBoundingClientRect() } catch (_) {}
    if (!editorRect) return null

    var nearBtns = getButtonsNearEditor(el)
    if (nearBtns.length === 0) return null

    var virtualScope = document.createElement('div')
    virtualScope.setAttribute('data-virtual-scope', 'true')
    nearBtns.forEach(function (b) {
      virtualScope.appendChild(b.cloneNode(true))
    })

    bridgeDebug('[Bridge] buildEditorVirtualScope: ' + nearBtns.length + ' buttons near editor')
    nearBtns.slice(0, 5).forEach(function (b) {
      var r = b.getBoundingClientRect()
      bridgeDebug('  near btn: "' + (b.textContent || '').trim().substring(0, 30) + '" rect=(' + Math.round(r.left) + ',' + Math.round(r.top) + ')')
    })

    return virtualScope
  }

  // ── Open composer settings popup ────────────────────────────────

  function openComposerSettings(payload: FlowSettingsPayload): Record<string, unknown> {
    bridgeDebug('[Bridge] openComposerSettings START, mode=' + payload.mode + ' model=' + payload.model)

    var el = findEditorElement()
    if (!el) {
      bridgeDebug('[Bridge] openComposerSettings: editor not found')
      return { success: false, error: 'editor_not_found' }
    }

    // ── 1. If popup already open, skip chip click ─────────────────
    var existingPopup = findPopupContainer()
    if (existingPopup) {
      bridgeDebug('[Bridge] popup already open, skip chip click')
      ;(window as Record<string, unknown>).__FLOW_LAST_POPUP__ = existingPopup
      return {
        success: true,
        popupDetected: true,
        alreadyOpen: true,
        popupRect: {
          x: Math.round(existingPopup.getBoundingClientRect().left),
          y: Math.round(existingPopup.getBoundingClientRect().top),
          w: Math.round(existingPopup.getBoundingClientRect().width),
          h: Math.round(existingPopup.getBoundingClientRect().height)
        }
      }
    }

    // ── 2. Find composer container & bounds ──────────────────────
    var composerContainer = findComposerContainer(el)
    var composerRect: DOMRect | null = null
    if (composerContainer) {
      try { composerRect = composerContainer.getBoundingClientRect() } catch (_) {}
    }

    // ── 3. Scan composer buttons ONLY (not popup) ─────────────────
    interface Candidate {
      el: HTMLElement
      txt: string
      txtL: string
      al: string
      score: number
      accepted: boolean
      rejectReason: string
    }
    var candidates: Candidate[] = []

    function scanComposerButtons(btns: NodeListOf<Element> | HTMLElement[]) {
      for (var bi = 0; bi < btns.length; bi++) {
        var b = btns[bi] as HTMLElement
        var rawTxt = (b.textContent || '').trim()
        if (rawTxt.length < 2) continue

        var txtL = normalizeText(rawTxt)
        var al = normalizeText(b.getAttribute('aria-label') || '')
        var rejectReason = ''

        // ── Hard reject ────────────────────────────────────────────
        var hardRejects = [
          'tác nhân', 'arrow_forward', 'tạo', 'swap_horiz',
          'play_circle', 'favorite', 'redo', 'more_vert',
          'delete', 'left_panel_close', 'arrow_back', 'quay lại',
          'back', 'search', 'filter', 'help', 'ultra',
          'close', 'đóng', 'toggle', 'hamburger', 'chevron', 'expand',
          'bắt đầu', 'kết thúc', 'gần đây', 'thành phần', 'hành động',
          'add', 'thêm', 'plus', 'play', 'pause', 'stop', 'remove'
        ]
        for (var ri = 0; ri < hardRejects.length; ri++) {
          if (txtL.includes(hardRejects[ri]) || al.includes(hardRejects[ri])) {
            bridgeDebug('[Bridge] reject settings candidate: text="' + rawTxt.substring(0, 40) + '" reason="' + hardRejects[ri] + '"')
            continue
          }
        }

        // ── Reject if inside popup ─────────────────────────────────
        // (even though we checked above, catch via rect check too)
        var bRect: DOMRect | null = null
        try { bRect = b.getBoundingClientRect() } catch (_) {}
        var insidePopup = false
        for (var pi = 0; pi < 10; pi++) {
          var parent = b.parentElement
          while (parent && parent !== document.body) {
            if (parent === existingPopup) { insidePopup = true; break }
            parent = parent.parentElement
          }
          if (insidePopup) break
        }
        if (insidePopup) {
          bridgeDebug('[Bridge] reject settings candidate: text="' + rawTxt.substring(0, 40) + '" reason="inside_popup"')
          continue
        }

        // ── Reject quantity buttons x2/x3/x4 ───────────────────────
        // Only ratio/model/mode chips are composer chips, NOT popup options
        if (txtL === 'x2' || txtL === 'x3' || txtL === 'x4' || txtL === '1x') {
          bridgeDebug('[Bridge] reject settings candidate: text="' + rawTxt + '" reason="popup_quantity_option"')
          continue
        }

        // ── Score: composer chip only (NO x1/x2/x3/x4) ───────────
        var score = 0
        var accepted = false

        // Normalize chip text: EXACT crop replacements FIRST
        var chipNorm = txtL
          .replace(/crop_9_16/g, '9:16')
          .replace(/crop_16_9/g, '16:9')
          .replace(/crop_square/g, '1:1')
          .replace(/crop_portrait/g, '3:4')
          .replace(/crop_landscape/g, '4:3')
          .replace(/crop_/g, '')
          .replace(/🍌|🥕|🎬|🖼|🖥|🎥/g, '')
          .replace(/play_circle/g, '')
          .replace(/image/g, '')
          .replace(/_/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        bridgeDebug('[Bridge] normalized settings chip: raw="' + rawTxt.substring(0, 50) + '" normalized="' + chipNorm + '"')

        // Accept ONLY composer main chip: nano banana, veo, video, duration
        if (chipNorm.includes('nano banana')) { score += 120; accepted = true }
        if (chipNorm.includes('veo')) { score += 120; accepted = true }
        if (chipNorm.includes('video')) { score += 100; accepted = true }
        if (chipNorm.includes('8s') || chipNorm.includes('6s') || chipNorm.includes('4s')) { score += 80; accepted = true }
        // NOTE: x1/x2/x3/x4 intentionally excluded — those are popup quantity options, NOT composer chips

        bridgeDebug('[Bridge] current composer chip accepted: normalized="' + chipNorm + '" score=' + score + ' accepted=' + accepted)

        if (accepted && score >= 100) {
          candidates.push({ el: b, txt: rawTxt, txtL: txtL, al: al, score: score, accepted: accepted, rejectReason: '' })
        }
      }
    }

    // Scan composer container
    if (composerContainer) {
      scanComposerButtons(composerContainer.querySelectorAll('button, [role="button"]'))
    }

    // Supplement with virtual scope (buttons near editor)
    var vsBtns = getButtonsNearEditor(el)
    if (vsBtns.length > 0) {
      var vsTexts = candidates.map(function (c) { return c.txt })
      for (var vi = 0; vi < vsBtns.length; vi++) {
        var rawTxt = (vsBtns[vi].textContent || '').trim()
        if (!vsTexts.includes(rawTxt)) {
          // Run same checks as scanComposerButtons inline
          var txtL = normalizeText(rawTxt)
          var al = normalizeText(vsBtns[vi].getAttribute('aria-label') || '')
          var hardRejects = [
            'tác nhân', 'arrow_forward', 'tạo', 'swap_horiz',
            'play_circle', 'favorite', 'redo', 'more_vert',
            'delete', 'left_panel_close', 'arrow_back', 'quay lại',
            'back', 'search', 'filter', 'help', 'ultra',
            'close', 'đóng', 'toggle', 'hamburger', 'chevron', 'expand',
            'bắt đầu', 'kết thúc', 'gần đây', 'thành phần', 'hành động',
            'add', 'thêm', 'plus', 'play', 'pause', 'stop', 'remove'
          ]
          var skip = false
          for (var ri = 0; ri < hardRejects.length; ri++) {
            if (txtL.includes(hardRejects[ri]) || al.includes(hardRejects[ri])) { skip = true; break }
          }
          if (skip) continue
          if (txtL === 'x2' || txtL === 'x3' || txtL === 'x4' || txtL === '1x') continue
          if (existingPopup && existingPopup.contains(vsBtns[vi])) continue

          var chipNorm = txtL
            .replace(/crop_9_16/g, '9:16')
            .replace(/crop_16_9/g, '16:9')
            .replace(/crop_square/g, '1:1')
            .replace(/crop_portrait/g, '3:4')
            .replace(/crop_landscape/g, '4:3')
            .replace(/crop_/g, '')
            .replace(/🍌|🥕|🎬|🖼|🖥|🎥/g, '')
            .replace(/play_circle/g, '')
            .replace(/image/g, '')
            .replace(/_/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
          var score = 0
          var accepted = false
          if (chipNorm.includes('nano banana')) { score += 120; accepted = true }
          if (chipNorm.includes('veo')) { score += 120; accepted = true }
          if (chipNorm.includes('video')) { score += 100; accepted = true }
          if (chipNorm.includes('8s') || chipNorm.includes('6s') || chipNorm.includes('4s')) { score += 80; accepted = true }
          if (accepted && score >= 100) {
            candidates.push({ el: vsBtns[vi], txt: rawTxt, txtL: txtL, al: al, score: score, accepted: accepted, rejectReason: '' })
          }
        }
      }
    }

    if (candidates.length === 0) {
      bridgeDebug('[Bridge] openComposerSettings: no settings chip found')
      return { success: false, error: 'settings_chip_not_found' }
    }

    // Sort by score descending
    candidates.sort(function (a, b) { return b.score - a.score })
    var best = candidates[0]

    bridgeDebug('[Bridge] clicking settings chip text="' + best.txt.substring(0, 50) + '" score=' + best.score)
    var clickMethod = clickReactFirst(best.el)
    best.el.click()

    // Fallback click chain if React click didn't work
    var clickFallback = false
    try {
      best.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      clickFallback = true
    } catch (_) {}
    try {
      best.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }))
      best.el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }))
    } catch (_) {}

    // Visual popup detection (scoring approach)
    var waitedMs = 0
    var stepMs = 100
    var popupOpened = false
    var popupTextPreview = ''
    var bestScore = 0
    var bestPopupInfo = ''
    var chipRect: DOMRect | null = null
    try { chipRect = best.el.getBoundingClientRect() } catch (_) {}

    // Header/page reject list — ONLY full-page wrappers
    // close/đóng/left_panel_close exist INSIDE real popups — do NOT reject by these
    var headerRejects = [
      'arrow_back', 'quay lại', 'back', 'more_vert', 'search',
      'filter_list', 'filter', 'add', 'thêm nội dung nghe nhìn',
      'help', 'settings', 'ultra'
    ]

    // Fast popup validation: check if ANY container has flow settings content
    function isFlowSettingsPopup(): HTMLElement | null {
      var candidates = document.querySelectorAll('div, section, span')
      for (var ci = 0; ci < candidates.length; ci++) {
        var el = candidates[ci] as HTMLElement
        try {
          if (el.offsetWidth < 180 || el.offsetHeight < 120) continue
          if (el.offsetWidth > 500 || el.offsetHeight > 600) continue
          var txt = normalizeText(el.textContent || '')
          // Must have at least one of these to be a settings popup
          if (txt.includes('hình ảnh') || txt.includes('video') ||
              txt.includes('16:9') || txt.includes('9:16') ||
              txt.includes('x2') || txt.includes('x3') || txt.includes('x4') ||
              txt.includes('nano banana') || txt.includes('veo')) {
            return el
          }
        } catch (_) {}
      }
      return null
    }

    while (waitedMs < 1000) {
      waitedMs += stepMs
      bridgeDebug('[Bridge] popup verify after click: waited=' + waitedMs + 'ms...')

      // Fast check: look for any container with settings content
      var fastPopup = isFlowSettingsPopup()
      if (fastPopup) {
        popupOpened = true
        popupTextPreview = (fastPopup.textContent || '').substring(0, 100).replace(/\s+/g, ' ')
        currentPopupContainer = fastPopup
        var fpRect = fastPopup.getBoundingClientRect()
        bridgeDebug('[Bridge] popup DETECTED (fast): rect=(' + Math.round(fpRect.left) + ',' + Math.round(fpRect.top) + ' ' + Math.round(fpRect.width) + 'x' + Math.round(fpRect.height) + ') textPreview="' + popupTextPreview + '"')
        break
      }

      var candidates: Array<{ el: HTMLElement; score: number; text: string; keywordCount: number; containsMode: boolean; containsRatio: boolean; containsQty: boolean; containsModel: boolean }> = []

      try {
        // Scan ALL div/section/span containers
        var allContainers = document.querySelectorAll('div, section, span')
        for (var ci = 0; ci < allContainers.length; ci++) {
          var container = allContainers[ci] as HTMLElement
          try {
            if (container.offsetWidth < 180 || container.offsetHeight < 120) continue
            if (container.offsetWidth > 500 || container.offsetHeight > 600) continue

            var rect = container.getBoundingClientRect()
            var style = window.getComputedStyle(container)
            var pos = style.position
            var zIdx = parseInt(style.zIndex || '0', 10)
            var text = (container.textContent || '').trim()
            var textL = normalizeText(text)

            // Hard reject: full-page wrappers (>90% viewport)
            var winW = window.innerWidth
            var winH = window.innerHeight
            if (container.offsetWidth > winW * 0.9 && container.offsetHeight > winH * 0.9) {
              bridgeDebug('[Bridge] popup candidate reject: full-page wrapper size=' + container.offsetWidth + 'x' + container.offsetHeight)
              continue
            }

            // Hard reject: nav/page containers containing nav text
            for (var hi = 0; hi < headerRejects.length; hi++) {
              if (textL.includes(headerRejects[hi])) {
                bridgeDebug('[Bridge] popup candidate reject: header/container (contains="' + headerRejects[hi] + '")')
                continue
              }
            }

            // Proximity check: must be near the clicked chip
            if (chipRect) {
              var vDist = Math.abs(rect.top - chipRect.top)
              var hDist = Math.abs(rect.left - chipRect.left)
              var nearChip = (rect.top >= chipRect.top - 400 && rect.top <= chipRect.bottom + 300) &&
                             (Math.abs(rect.left - chipRect.left) < 300)
              if (!nearChip) continue
            }

            var score = 0
            var containsMode = textL.includes('hình ảnh') || textL.includes('video')
            var containsRatio = textL.includes('16:9') || textL.includes('9:16') || textL.includes('1:1') || textL.includes('4:3')
            var containsQty = textL.includes('1x') || textL.includes('x2') || textL.includes('x3') || textL.includes('x4')
            var containsModel = textL.includes('nano banana') || textL.includes('veo')

            // Scoring: category-based
            if (containsMode) score += 100
            if (containsRatio) score += 80
            if (containsQty) score += 80
            if (containsModel) score += 80
            if (pos === 'fixed' || pos === 'absolute') score += 10
            if (zIdx > 10) score += 15
            if (textL.includes('4s') || textL.includes('6s') || textL.includes('8s')) score += 10

            if (score > 0) {
              var size = container.offsetWidth + 'x' + container.offsetHeight
              bridgeDebug('[Bridge] popup candidate: score=' + score + ' size=' + size + ' containsModeTabs=' + containsMode + ' containsRatios=' + containsRatio + ' containsQuantities=' + containsQty + ' containsModels=' + containsModel + ' textPreview="' + text.substring(0, 80).replace(/\s+/g, ' ') + '"')
              candidates.push({ el: container, score: score, text: text.substring(0, 100).replace(/\s+/g, ' '), keywordCount: 0, containsMode: containsMode, containsRatio: containsRatio, containsQty: containsQty, containsModel: containsModel })
            }
          } catch (_) {}
        }

        // Sort by score descending
        candidates.sort(function (a, b) { return b.score - a.score })
        if (candidates.length > 0) {
          var top = candidates[0]
          bridgeDebug('[Bridge] popup candidates: ' + candidates.length + ' found, best score=' + top.score + ' size=' + top.el.offsetWidth + 'x' + top.el.offsetHeight)
          bestScore = top.score
          bestPopupInfo = top.text.substring(0, 100).replace(/\s+/g, ' ')

          if (top.score >= 40) {
            popupOpened = true
            popupTextPreview = bestPopupInfo
            currentPopupContainer = top.el
            var topRect = top.el.getBoundingClientRect()
            bridgeDebug('[Bridge] popup DETECTED: score=' + top.score + ' rect=(' + Math.round(topRect.left) + ',' + Math.round(topRect.top) + ' ' + Math.round(topRect.width) + 'x' + Math.round(topRect.height) + ')')
            break
          } else {
            for (var di = 0; di < Math.min(3, candidates.length); di++) {
              var c = candidates[di]
              bridgeDebug('[Bridge] popup candidate #' + (di + 1) + ': score=' + c.score + ' size=' + c.el.offsetWidth + 'x' + c.el.offsetHeight + ' textPreview="' + c.text.substring(0, 60) + '"')
            }
          }
        }
      } catch (_) {}

      if (popupOpened) break
      // Busy-wait
      var start = Date.now()
      while (Date.now() - start < stepMs) { /* spin */ }
    }

    if (!popupOpened) {
      // Click succeeded — popup may have opened but not detected yet.
      // applyFlowSettings will find it via currentPopupContainer.
      // Return success so the pipeline continues.
      bridgeDebug('[Bridge] openComposerSettings: click succeeded, popup detection deferred to applyFlowSettings')
      ;(window as Record<string, unknown>).__FLOW_LAST_POPUP__ = currentPopupContainer
      return {
        success: true,
        clickedText: best.txt,
        clickMethod: clickMethod || (clickFallback ? 'dispatchEvent' : 'element.click()'),
        popupDetected: false, // applyFlowSettings will confirm
        bestScore: bestScore,
      }
    }

    ;(window as Record<string, unknown>).__FLOW_LAST_POPUP__ = currentPopupContainer
    return {
      success: true,
      clickedText: best.txt,
      clickMethod: clickMethod || (clickFallback ? 'dispatchEvent' : 'element.click()'),
      popupDetected: popupOpened,
      popupTextPreview: popupTextPreview,
      bestScore: bestScore,
      bestPopupInfo: bestPopupInfo,
    }
  }

  // ── Debug helpers ────────────────────────────────────────────

  ;(window as Record<string, unknown>).__flowDebugComposer = function () {
    var el = findEditorElement()
    if (!el) {
      bridgeDebug('[Bridge] __flowDebugComposer: no editor found')
      return { editorFound: false }
    }
    var editorRect: DOMRect | null = null
    try { editorRect = el.getBoundingClientRect() } catch (_) {}
    var container = findComposerContainer(el)
    var virtualScope = buildEditorVirtualScope(el)

    bridgeDebug('[Bridge] __flowDebugComposer report:')
    bridgeDebug('Editor rect:', editorRect ? { top: Math.round(editorRect.top), left: Math.round(editorRect.left), right: Math.round(editorRect.right), bottom: Math.round(editorRect.bottom), w: Math.round(editorRect.width), h: Math.round(editorRect.height) } : null)
    bridgeDebug('Composer container found:', !!container, container ? container.tagName + ' class="' + (container.className || '').substring(0, 80) + '"' : 'null')
    bridgeDebug('Virtual scope found:', !!virtualScope)

    // List all buttons near editor
    if (editorRect) {
      var allBtns = document.querySelectorAll('button:not([disabled]), [role="button"]:not([disabled])')
      bridgeDebug('Buttons near editor:')
      allBtns.forEach(function (btn) {
        var b = btn as HTMLElement
        try {
          var r = b.getBoundingClientRect()
          var centerY = r.top + r.height / 2
          var editorCenterY = editorRect!.top + editorRect!.height / 2
          var vDist = Math.abs(centerY - editorCenterY)
          var hInRange = r.left >= editorRect!.left - 80 && r.right <= editorRect!.right + 80
          if (vDist < 200) {
            bridgeDebug('  "' + (b.textContent || '').trim().substring(0, 40) + '" rect=(' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ') vDist=' + Math.round(vDist) + ' inRange=' + hInRange)
          }
        } catch (_) {}
      })
    }

    return {
      editorRect: editorRect ? { top: Math.round(editorRect.top), left: Math.round(editorRect.left), right: Math.round(editorRect.right), bottom: Math.round(editorRect.bottom) } : null,
      containerFound: !!container,
      virtualScopeFound: !!virtualScope,
    }
  }

  // ── Apply settings in popup ───────────────────────────────────────────────

  async function selectMode(panel: Element, targetMode: string): Promise<Record<string, unknown>> {
    bridgeLog('[Bridge][rs] select mode START', targetMode)

    // ID-based: button[id$="-trigger-IMAGE"] or button[id$="-trigger-VIDEO"]
    var modeId = targetMode === 'image' ? 'IMAGE' : 'VIDEO'
    var idBtn = panel.querySelector('button[id$="-trigger-' + modeId + '"]') as HTMLElement | null
    if (idBtn) {
      dispatchFullClick(idBtn)
      await sleep(400)
      bridgeLog('[Bridge][rs] select mode SUCCESS (id)', modeId)
      return { success: true }
    }

    // Text fallback
    var fallbacks = targetMode === 'image'
      ? ['image', '\u1ea2nh', 'h\u00ecnh \u1ea2nh', 'hình \u1ea3nh']
      : ['video']
    var btns = Array.from(panel.querySelectorAll('button, [role="tab"]')) as HTMLElement[]
    for (var mi = 0; mi < btns.length; mi++) {
      var mb = btns[mi]
      var mt = safeLower(mb.textContent)
      for (var fi = 0; fi < fallbacks.length; fi++) {
        if (mt === fallbacks[fi] || mt.includes(fallbacks[fi])) {
          dispatchFullClick(mb)
          await sleep(400)
          bridgeLog('[Bridge][rs] select mode SUCCESS (text)', mb.textContent)
          return { success: true }
        }
      }
    }

    bridgeLog('[Bridge][rs] select mode SKIPPED (no button found)')
    return { success: true }
  }

  // ────────────────────────────────────────────────────────────────────
  // selectVideoMode — Google Flow Video input mode
  // ("Khung hình" / "Thành phần") segmented control.
  //
  // DOM probe 2026-07-10 confirmed:
  //   - frame      → button[role="tab"][id$="-trigger-VIDEO_FRAMES"]
  //   - ingredient → button[role="tab"][id$="-trigger-VIDEO_REFERENCES"]
  //   - active state: data-state="active" on the chosen tab
  //
  // Only call this when the caller passed a non-undefined
  // flowVideoMode. When the field is undefined, callers MUST skip
  // this entirely (legacy behavior: do not touch the tab).
  // ────────────────────────────────────────────────────────────────────
  var VIDEO_MODE_TRIGGER_SUFFIX: Record<string, string> = {
    frame: 'VIDEO_FRAMES',
    ingredient: 'VIDEO_REFERENCES',
  }
  // Text-only fallback needles, ordered by reliability (VN > EN UI).
  var VIDEO_MODE_TEXT_NEEDLES: Record<string, RegExp[]> = {
    frame: [
      /khung\s*h[ìi]nh/i,
      /\bvideo\s*frames?\b/i,
      /\bfirst\s*frame\b/i,
      /\bkey\s*frame\b/i,
      /\bframe\b/i,
    ],
    ingredient: [
      /th[àa]nh\s*ph[ầa]n/i,
      /\bvideo\s*references?\b/i,
      /\bingredients?\b/i,
      /\bcomponents?\b/i,
      /\breferences?\b/i,
    ],
  }

  function readActiveVideoMode(panel: Element | null | undefined): 'frame' | 'ingredient' | null {
    if (!panel) return null
    try {
      var frameBtn = panel.querySelector('button[role="tab"][id$="-trigger-VIDEO_FRAMES"]') as HTMLElement | null
      if (frameBtn && frameBtn.getAttribute('data-state') === 'active') return 'frame'
      var ingBtn = panel.querySelector('button[role="tab"][id$="-trigger-VIDEO_REFERENCES"]') as HTMLElement | null
      if (ingBtn && ingBtn.getAttribute('data-state') === 'active') return 'ingredient'
    } catch (_) {}
    return null
  }

  async function selectVideoMode(panel: Element, targetVideoMode: 'frame' | 'ingredient'): Promise<Record<string, unknown>> {
    bridgeLog('[Bridge][rs] select video mode START', targetVideoMode)

    // Already-active short-circuit. Don't click (clicking an active tab
    // sometimes toggles off in Radix implementations, which would
    // collapse the panel — never worth the risk).
    var currentActive = readActiveVideoMode(panel)
    if (currentActive === targetVideoMode) {
      bridgeLog('[Bridge][rs] select video mode ALREADY_ACTIVE', targetVideoMode)
      return { success: true, method: 'alreadyActive', clickedText: targetVideoMode }
    }

    var targetBtn: HTMLElement | null = null
    var clickedText = ''
    var method = ''

    // Strategy A — primary selector (id suffix from upstream probe).
    var suffix = VIDEO_MODE_TRIGGER_SUFFIX[targetVideoMode]
    if (suffix) {
      targetBtn = panel.querySelector(
        'button[role="tab"][id$="-trigger-' + suffix + '"]'
      ) as HTMLElement | null
      if (targetBtn) {
        clickedText = safeText(targetBtn.textContent)
        method = 'id:' + suffix
      }
    }

    // Strategy B — text-fallback within the panel's role=tab buttons.
    // Some Flow builds expose the same control without a deterministic
    // id suffix; locate by accessible name text. We restrict the
    // search to role="tab" so we don't accidentally click an unrelated
    // "thành phần" sidebar token (negTexts in findSubmitButton).
    if (!targetBtn) {
      var needles = VIDEO_MODE_TEXT_NEEDLES[targetVideoMode] || []
      var tabBtns = Array.from(
        panel.querySelectorAll('button[role="tab"], button[role="button"], button')
      ) as HTMLElement[]
      for (var tbi = 0; tbi < tabBtns.length && !targetBtn; tbi++) {
        var tb = tabBtns[tbi]
        var ariaName = safeLower(tb.getAttribute('aria-label') || tb.getAttribute('title') || '')
        var tbText = safeLower(tb.textContent || '')
        for (var ni = 0; ni < needles.length; ni++) {
          var needle = needles[ni]
          if (needle.test(tbText) || needle.test(ariaName)) {
            // Exclude the *other* mode's id to avoid picking the
            // wrong chip when text is shared.
            var otherSuffix = targetVideoMode === 'frame' ? 'VIDEO_REFERENCES' : 'VIDEO_FRAMES'
            if (tb.id && tb.id.indexOf(otherSuffix) !== -1) continue
            // Skip buttons already covered by primary strategy (avoid
            // double-pick in mixed-id builds).
            targetBtn = tb
            clickedText = safeText(tb.textContent)
            method = 'text-fallback'
            break
          }
        }
      }
    }

    if (!targetBtn) {
      bridgeLog('[Bridge][rs] select video mode TAB_NOT_FOUND', targetVideoMode)
      return {
        success: false,
        error: 'FLOW_VIDEO_MODE_TAB_NOT_FOUND',
        details: { target: targetVideoMode, panelTag: (panel as HTMLElement).tagName || '' },
      }
    }

    dispatchFullClick(targetBtn)
    // Give Flow a beat to flip data-state="active" — observed settle
    // window 60-220ms in lab probe; sleep(350) keeps us safely past
    // the worst observed latency without making apply() feel sluggish.
    await sleep(350)

    // Verify activation immediately to avoid stacking a click that
    // silently no-op'd. Active check uses the same selectors
    // (data-state="active" on the chosen tab).
    var afterActive = readActiveVideoMode(panel)
    if (afterActive !== targetVideoMode) {
      bridgeWarn('[Bridge][rs] select video mode ACTIVE_CHECK_FAILED', {
        target: targetVideoMode,
        actual: afterActive,
        method: method,
        clickedText: clickedText,
      })
      return {
        success: false,
        error: 'FLOW_VIDEO_MODE_NOT_ACTIVE_AFTER_CLICK',
        details: { target: targetVideoMode, actual: afterActive, method: method, clickedText: clickedText },
      }
    }

    bridgeLog('[Bridge][rs] select video mode SUCCESS', { target: targetVideoMode, method: method, clickedText: clickedText })
    return { success: true, method: method, clickedText: clickedText, current: afterActive }
  }

  async function selectRatio(panel: Element, targetRatio: string): Promise<Record<string, unknown>> {
    bridgeLog('[Bridge][rs] select ratio START', targetRatio)

    // ID-based: button[id$="-trigger-LANDSCAPE"], etc.
    var suffix = ratioToTriggerSuffix(targetRatio)
    if (suffix) {
      var idBtn = panel.querySelector('button[id$="-trigger-' + suffix + '"]') as HTMLElement | null
      if (idBtn) {
        dispatchFullClick(idBtn)
        await sleep(300)
        bridgeLog('[Bridge][rs] select ratio SUCCESS (id)', suffix)
        return { success: true }
      }
    }

    // Icon/text-based: button with crop_xxx text
    var iconName = ratioToIconName(targetRatio)
    if (iconName) {
      var iconBtns = Array.from(panel.querySelectorAll('button')) as HTMLElement[]
      for (var ri = 0; ri < iconBtns.length; ri++) {
        var rb = iconBtns[ri]
        var rbText = safeText(rb.textContent)
        if (rbText.includes(iconName) || rbText.replace(/_/g, ':').includes(targetRatio)) {
          dispatchFullClick(rb)
          await sleep(300)
          bridgeLog('[Bridge][rs] select ratio SUCCESS (icon)', rbText)
          return { success: true }
        }
      }
    }

    bridgeLog('[Bridge][rs] select ratio SKIPPED (no button found)')
    return { success: true }
  }

  async function selectModelDropdown(panel: Element, targetModel: string): Promise<Record<string, unknown>> {
    bridgeLog('[Bridge][rs] select model dropdown START', targetModel)

    // Find model dropdown button inside panel
    // Prefer: button that contains current model text, or any known model text
    var modelBtns = Array.from(panel.querySelectorAll('button')) as HTMLElement[]
    var dropdownBtn: HTMLElement | null = null

    // Known model keywords
    var modelKeywords = [
      'nano banana', 'imagen', 'omni flash', 'veo',
      'banana', 'nano-banana'
    ]

    // Look for a button that looks like a model selector (contains model text)
    for (var di = 0; di < modelBtns.length; di++) {
      var db = modelBtns[di]
      var dbText = safeText(db.textContent).toLowerCase()
      // Skip mode/ratio/quantity buttons
      if (dbText === 'image' || dbText === 'video') continue
      if (/^x?\d+$/.test(dbText)) continue
      if (dbText.includes('crop_')) continue

      for (var ki = 0; ki < modelKeywords.length; ki++) {
        if (dbText.includes(modelKeywords[ki])) {
          dropdownBtn = db
          break
        }
      }
      if (dropdownBtn) break
    }

    // Fallback: click the last non-mode, non-ratio button (likely model dropdown)
    if (!dropdownBtn) {
      for (var fi = modelBtns.length - 1; fi >= 0; fi--) {
        var fb = modelBtns[fi]
        var fbText = safeText(fb.textContent).toLowerCase()
        if (fbText === 'image' || fbText === 'video') continue
        if (/^x?\d+$/.test(fbText)) continue
        if (fbText.includes('crop_')) continue
        if (!fbText) continue
        dropdownBtn = fb
        break
      }
    }

    if (!dropdownBtn) {
      return { success: false, error: 'FLOW_MODEL_DROPDOWN_NOT_FOUND', details: { targetModel: targetModel } }
    }

    dispatchFullClick(dropdownBtn)
    await sleep(300)

    // After clicking dropdown, find the popup/menu
    var menuSelectors = [
      '[data-radix-popper-content-wrapper]',
      '[data-radix-menu-content]',
      '[role="menu"]',
      '[role="listbox"]',
      '[id^="radix-"]',
    ]
    var menuEl: Element | null = null
    for (var si = 0; si < menuSelectors.length; si++) {
      var candidates = Array.from(document.querySelectorAll(menuSelectors[si]))
      for (var ci = candidates.length - 1; ci >= 0; ci--) {
        var c = candidates[ci] as HTMLElement
        if (c.offsetWidth > 50 && c.offsetHeight > 50) {
          menuEl = c
          break
        }
      }
      if (menuEl) break
    }

    if (!menuEl) {
      return { success: false, error: 'FLOW_MODEL_MENU_NOT_FOUND', details: { targetModel: targetModel } }
    }

    // Find model item in menu
    var menuItems = Array.from(menuEl.querySelectorAll('button, [role="menuitem"], [role="option"]')) as HTMLElement[]
    var matchedItem: HTMLElement | null = null

    for (var mi2 = 0; mi2 < menuItems.length; mi2++) {
      var item = menuItems[mi2]
      var itemText = safeText(item.textContent)
      if (matchModelOption(targetModel, itemText)) {
        matchedItem = item
        break
      }
    }

    if (!matchedItem) {
      return {
        success: false,
        error: 'FLOW_MODEL_OPTION_NOT_FOUND',
        details: {
          model: targetModel,
          normalizedModel: normalizeFlowModelText(targetModel),
          availableModels: menuItems.slice(0, 15).map(function (it) { return safeText(it.textContent) }),
        }
      }
    }

    dispatchFullClick(matchedItem)
    await sleep(200)
    bridgeLog('[Bridge][rs] select model SUCCESS', targetModel)
    return { success: true, clickedText: safeText(matchedItem.textContent) }
  }

  async function selectDuration(
    targetDuration: string,
    panel?: Element | null
  ): Promise<Record<string, unknown>> {
    bridgeLog('[Bridge][rs] select duration START', targetDuration)

    if (!targetDuration) {
      return { success: false, error: 'FLOW_DURATION_MISSING', details: { targetDuration: targetDuration } }
    }

    var rawTarget = safeText(targetDuration)
    var lowerTarget = rawTarget.toLowerCase()
    // [Bridge][rs][duration] Normalize target to one of {4s,6s,8s,10s}.
    // Bare numeric like "4" is explicitly rejected: it is ambiguous with
    // the quantity row (x4 / 4x). The duration chip must always carry "s".
    var normalizedTarget = ''
    var candidates4 = ['10s', '8s', '6s', '4s']
    for (var ci = 0; ci < candidates4.length; ci++) {
      if (
        lowerTarget === candidates4[ci].toLowerCase() ||
        lowerTarget === candidates4[ci].toLowerCase().replace(/s$/, '')
      ) {
        normalizedTarget = candidates4[ci]
        break
      }
    }
    if (!normalizedTarget) {
      return {
        success: false,
        error: 'FLOW_DURATION_UNSUPPORTED',
        details: { targetDuration: rawTarget, supported: candidates4 },
      }
    }

    // [Bridge][rs][duration] Resolve panel scope. We must NEVER query
    // document-wide — quantity buttons live on the same DOM and use
    // numeric triggers (e.g. "-trigger-4") that would clash with the
    // duration row's id pattern.
    var activePanel = (panel && panel !== document) ? panel : getActiveFlowSettingsPanel()
    var scope: ParentNode = (activePanel && activePanel !== document) ? activePanel : document

    // [Bridge][rs][duration] Reject any candidate whose accessible text
    // matches a quantity shape. Quantity chips render as "x4", "4x", or
    // bare "4" alongside "<something> ratio" / "Image" / "Video" labels.
    // The duration row is the only place a button with text exactly
    // "4s" / "6s" / "8s" / "10s" exists in this settings panel.
    var isQuantityShape = function (txt: string): boolean {
      var t = safeLower(txt).replace(/\s+/g, '')
      if (!t) return false
      if (/^x\d+$/i.test(t)) return true
      if (/^\d+x$/i.test(t)) return true
      if (/^\d+$/.test(t)) return true
      return false
    }

    var buildCandidate = function (el: HTMLElement): {
      text: string
      ariaLabel: string
      id: string
      visible: boolean
      disabled: boolean
      rejectedReason: string
    } {
      var txt = safeText(el.textContent)
      var ariaLabel = el.getAttribute('aria-label') || ''
      var id = el.id || ''
      var visible = isVisible(el)
      var disabled = !!(el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'
      var rejectedReason = ''
      if (!visible) rejectedReason = 'not_visible'
      else if (disabled) rejectedReason = 'disabled'
      else if (isQuantityShape(txt)) rejectedReason = 'quantity_shape_text'
      else if (isQuantityShape(ariaLabel)) rejectedReason = 'quantity_shape_aria'
      return { text: txt, ariaLabel, id, visible, disabled, rejectedReason }
    }

    var findDurationOption = function (scopeEl: ParentNode): {
      el: HTMLElement
      info: { text: string; ariaLabel: string; id: string; visible: boolean; disabled: boolean; rejectedReason: string }
    } | null {
      var btns = Array.from(scopeEl.querySelectorAll('button, [role="radio"], [role="option"], [role="menuitem"]')) as HTMLElement[]
      for (var bi = 0; bi < btns.length; bi++) {
        var b = btns[bi]
        if (!isVisible(b)) continue
        if ((b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true') continue
        var t = safeText(b.textContent)
        if (!t) continue
        // Strict text match: exact "4s" / "6s" / "8s" / "10s".
        if (safeLower(t) === normalizedTarget.toLowerCase()) {
          return { el: b, info: buildCandidate(b) }
        }
        // aria-label fallback (Radix sometimes omits text when chosen).
        var aria = b.getAttribute('aria-label') || ''
        if (aria && safeLower(aria) === normalizedTarget.toLowerCase()) {
          if (!isQuantityShape(aria)) {
            return { el: b, info: buildCandidate(b) }
          }
        }
        // data-value fallback (Radix select uses data-value="4s")
        var dv = b.getAttribute('data-value') || ''
        if (dv && safeLower(dv) === normalizedTarget.toLowerCase()) {
          if (!isQuantityShape(dv)) {
            return { el: b, info: buildCandidate(b) }
          }
        }
      }
      return null
    }

    var dumpDurationOptions = function (reasonLabel: string): void {
      try {
        var allBtns = Array.from(scope.querySelectorAll('button, [role="radio"], [role="option"], [role="menuitem"]')) as HTMLElement[]
        var dump: Array<Record<string, unknown>> = []
        for (var di = 0; di < allBtns.length; di++) {
          var info = buildCandidate(allBtns[di])
          // Only emit candidates whose accessible text even mentions a digit,
          // so the dump is readable in the console.
          if (!/\d/.test(info.text) && !/\d/.test(info.ariaLabel)) continue
          dump.push({
            text: info.text,
            ariaLabel: info.ariaLabel,
            id: info.id,
            visible: info.visible,
            disabled: info.disabled,
            rejectedReason: info.rejectedReason,
          })
        }
        console.log('[Bridge][DURATION_OPTIONS_DUMP]', JSON.stringify({
          targetDuration: normalizedTarget,
          reason: reasonLabel,
          scopeTag: (scope as Element).tagName || '#document',
          options: dump,
        }))
      } catch (e) {
        // never let logging crash the pipeline
      }
    }

    // Up to 2 attempts — Radix sometimes re-renders the chip list after
    // a sibling (ratio / quantity) change. NEVER click an ambiguous match.
    var clicked = false
    var clickedInfo: { text: string; ariaLabel: string; id: string } | null = null
    for (var attempt = 0; attempt < 2 && !clicked; attempt++) {
      // Re-rescope panel in case Radix re-mounted it.
      if (attempt > 0) {
        activePanel = (panel && panel !== document) ? panel : getActiveFlowSettingsPanel()
        scope = (activePanel && activePanel !== document) ? activePanel : document
      }
      var found = findDurationOption(scope)
      if (found) {
        dispatchFullClick(found.el)
        await sleep(220)
        clicked = true
        clickedInfo = { text: found.info.text, ariaLabel: found.info.ariaLabel, id: found.info.id }
        bridgeLog('[Bridge][rs] select duration CLICKED ' + normalizedTarget, {
          attempt: attempt + 1,
          text: found.info.text,
          id: found.info.id,
          ariaLabel: found.info.ariaLabel,
          scope: (activePanel && activePanel !== document) ? 'panel' : 'document',
        })
        break
      }
      if (attempt === 0) await sleep(280)
    }

    if (!clicked) {
      dumpDurationOptions('not_found_in_scope')
      return {
        success: false,
        error: 'FLOW_DURATION_UNSUPPORTED_FOR_CURRENT_COMBO',
        details: { targetDuration: normalizedTarget, attemptedInScope: (activePanel && activePanel !== document) ? 'panel' : 'document' },
      }
    }

    // [Bridge][rs][duration] VERIFIED gate: success only when the
    // post-click snapshot actually shows the target duration. We poll
    // for 1500–2500ms because Flow UI applies settings asynchronously
    // and can briefly show the new value before normalizing it back
    // (e.g. 4s → 8s when the model doesn't actually support 4s).
    var settingsBtnForVerify = (typeof getFlowSettingsButton === 'function' ? getFlowSettingsButton() : null)
    var sawTargetTransiently = false
    var finalActual = ''
    var verdict: 'VERIFIED' | 'NOT_APPLIED' | 'NORMALIZED' = 'NOT_APPLIED'

    // Capture the very first poll so we can compare against the eventual
    // settled value. If the first read is target (or transitions through
    // target on its way back to model-default), that's "NORMALIZED".
    for (var pollI = 0; pollI < 10; pollI++) {
      await sleep(220)
      var snap = readFlowSettingsSnapshot(settingsBtnForVerify) as Record<string, unknown> | null
      var cur = snap ? String(snap.duration || '') : ''
      finalActual = cur

      if (pollI === 0) {
        // First post-click read. If it's already not-target but is a
        // different value, we still want to see whether it transitions
        // through target on a later poll (Radix can be slow).
        if (cur.length > 0 && cur !== normalizedTarget) {
          initialOther = cur
        }
      }

      if (cur === normalizedTarget) {
        // Keep polling — Flow can show 4s and then snap back to 8s
        // when the active model doesn't actually support 4s. We
        // only declare VERIFIED if the target is still present at
        // the last poll tick.
        sawTargetTransiently = true
        if (pollI >= 5) {
          verdict = 'VERIFIED'
        }
        continue
      }

      // We saw the target on a prior poll AND it has now changed to
      // some other value (model-default normalize-back) → NORMALIZED.
      if (sawTargetTransiently && cur.length > 0) {
        verdict = 'NORMALIZED'
        // one more tick to capture the post-normalize actual
        await sleep(220)
        var snap2 = readFlowSettingsSnapshot(settingsBtnForVerify) as Record<string, unknown> | null
        if (snap2) finalActual = String(snap2.duration || '')
        break
      }
    }

    if (verdict === 'VERIFIED') {
      bridgeLog('[Bridge][rs] select duration VERIFIED ' + normalizedTarget, {
        clicked: clickedInfo,
        actual: finalActual,
      })
      return {
        success: true,
        targetDuration: normalizedTarget,
        actualDuration: finalActual,
        verified: true,
      }
    }

    if (verdict === 'NORMALIZED' || sawTargetTransiently) {
      bridgeWarn('[Bridge][rs] select duration NORMALIZED_BY_UI', {
        target: normalizedTarget,
        actual: finalActual,
        transientlyMatched: true,
        clicked: clickedInfo,
      })
      dumpDurationOptions('normalized_after_click')
      return {
        success: false,
        error: 'FLOW_DURATION_NORMALIZED_BY_UI',
        targetDuration: normalizedTarget,
        actualDuration: finalActual,
        wasTemporarilySelected: true,
        details: { clicked: clickedInfo },
      }
    }

    // Never saw the target at all → click did not register.
    dumpDurationOptions('click_did_not_apply')
    bridgeWarn('[Bridge][rs] select duration NOT_APPLIED', {
      target: normalizedTarget,
      actual: finalActual,
      clicked: clickedInfo,
    })
    return {
      success: false,
      error: 'FLOW_DURATION_CLICK_DID_NOT_APPLY',
      targetDuration: normalizedTarget,
      actualDuration: finalActual,
      details: { clicked: clickedInfo },
    }
  }

  async function applyFlowSettings(rawPayload: any): Promise<Record<string, unknown>> {
    try {
      var target = normalizeFlowSettingsPayload(rawPayload)
      var isVideo = target.mode === 'video'

      bridgeLog('[Bridge] Target: MODEL=' + target.model + ' MODE=' + target.mode + ' RATIO=' + target.ratio + ' QTY=' + target.quantity + ' DURATION=' + (target.duration as string || '') + ' IS_FRAMES=' + target.isFrames + ' REFS=' + ((target.fileIds as string[])?.length || 0))

      if (!target.model) {
        return { success: false, error: 'FLOW_MODEL_MISSING', details: { payload: rawPayload } }
      }

      // ── Step 1: Find submit button ───────────────────────────────
      bridgeLog('[Bridge][rs] find editor START')
      var ed = findEditorElement()
      if (!ed) {
        return { success: false, error: 'FLOW_EDITOR_NOT_FOUND' }
      }

      var submitBtn: HTMLElement | null = null
      try {
        var sr = findSubmitButton(ed)
        submitBtn = sr ? sr.btn : null
      } catch (_) {}

      // ── Step 2: Find settings button ─────────────────────────────
      bridgeLog('[Bridge][rs] find settings button START')
      var settingsBtn = getFlowSettingsButton(submitBtn)

      if (!settingsBtn) {
        return {
          success: false,
          error: 'FLOW_SETTINGS_BUTTON_NOT_FOUND',
          details: collectSettingsPanelDiagnostics(null),
        }
      }

      bridgeLog('[Bridge][rs] find settings button found', {
        text: safeText(settingsBtn.textContent).slice(0, 120),
        id: settingsBtn.id || null,
      })

      // ── Step 2b: Snapshot BEFORE apply ────────────────────────────
      var beforeSnapshot = readFlowSettingsSnapshot(settingsBtn)
      if (FLOW_DEBUG_VERBOSE) {
        bridgeDebug('[Bridge][settings compare BEFORE]', {
          target: target,
          current: beforeSnapshot,
          compare: compareFlowSettings(target, beforeSnapshot),
        })
      }

      // ── Step 3: Open panel if not already open ──────────────────
      var existingPanel = getActiveFlowSettingsPanel()
      if (!existingPanel || existingPanel === document || !hasSettingsPanelControls(existingPanel)) {
        bridgeLog('[Bridge][rs] open settings panel START')
        dispatchFullClick(settingsBtn)
        var panel = await waitForFlowSettingsPanel(5000)
        if (!panel) {
          return {
            success: false,
            error: 'FLOW_SETTINGS_PANEL_NOT_FOUND',
            details: collectSettingsPanelDiagnostics(settingsBtn),
          }
        }
        bridgeLog('[Bridge][rs] open settings panel SUCCESS')
      } else {
        bridgeLog('[Bridge][rs] settings panel already open — skip toggle')
      }

      // Rescope panel after any interaction
      var activePanel = getActiveFlowSettingsPanel()
      if (!activePanel || activePanel === document) {
        return { success: false, error: 'FLOW_SETTINGS_PANEL_NOT_FOUND' }
      }

      // ── Step 4: Select mode (always first — sets the layout) ─────
      console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_MODE_RESULT', JSON.stringify({
        targetMode: target.mode,
        beforeSettings: beforeSnapshot ? { mode: (beforeSnapshot as Record<string, unknown>).mode } : null,
      }))
      var modeResult = await selectMode(activePanel, target.mode as string)
      console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_MODE_DONE', JSON.stringify({
        success: !!modeResult.success,
        method: modeResult.method || '',
        error: modeResult.error || '',
        clickedText: modeResult.clickedText || '',
      }))
      if (!modeResult.success) {
        return modeResult
      }

      // Rescope panel after mode click (Radix may re-render)
      activePanel = getActiveFlowSettingsPanel()
      if (!activePanel || activePanel === document) {
        return { success: false, error: 'FLOW_SETTINGS_PANEL_NOT_FOUND' }
      }

      // ── Step 4b: Google Flow Video input mode (only when caller
      //    asked). Selects Khung hình (VIDEO_FRAMES) or Thành phần
      //    (VIDEO_REFERENCES) before model/ratio/qty/duration so the
      //    panel settles on the right input mode and the model chip
      //    list reflects the correct set of allowed options.
      //    Legacy workflows that omit flowVideoMode take the existing
      //    path (Flow keeps its current default).
      if (isVideo && (target.flowVideoMode === 'frame' || target.flowVideoMode === 'ingredient')) {
        bridgeLog('[Bridge][rs] select video mode START', target.flowVideoMode)
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_VIDEO_MODE_RESULT', JSON.stringify({
          targetVideoMode: target.flowVideoMode,
        }))
        var videoModeResult = await selectVideoMode(activePanel, target.flowVideoMode)
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_VIDEO_MODE_DONE', JSON.stringify({
          targetVideoMode: target.flowVideoMode,
          success: !!videoModeResult.success,
          method: (videoModeResult as Record<string, unknown>).method || '',
          error: (videoModeResult as Record<string, unknown>).error || '',
          clickedText: (videoModeResult as Record<string, unknown>).clickedText || '',
        }))
        if (!videoModeResult.success) {
          return videoModeResult
        }

        // Rescope after videoMode click — switching segmented control
        // can re-mount the chip rows for ratio/qty/duration in some
        // Flow builds.
        activePanel = getActiveFlowSettingsPanel()
        if (!activePanel || activePanel === document) {
          return { success: false, error: 'FLOW_SETTINGS_PANEL_NOT_FOUND' }
        }
      }

      // ── Steps 5-8: Branch on mode ─────────────────────────────────
      // VIDEO order: mode → [videoMode] → model → ratio → quantity → duration
      //   videoMode only appears when caller passed a non-undefined
      //   flowVideoMode. Legacy workflows (undefined) use the prior
      //   5-step chain; behavior is unchanged for them.
      //
      //   Rationale: duration was previously placed after model, but in
      //   practice ratio/quantity changes can re-render the duration row
      //   and Flow can normalize duration back to the model default. By
      //   placing duration LAST we guarantee the final click writes into
      //   a settled chip list, and the verify gate catches any subsequent
      //   normalize-back so we surface
      //   FLOW_DURATION_NORMALIZED_BY_UI rather than silently submit.
      //
      // IMAGE order: ratio → quantity → model (unchanged — image
      //   models don't reset duration/quantity the same way).
      var videoHasVideoMode = isVideo && (target.flowVideoMode === 'frame' || target.flowVideoMode === 'ingredient')
      console.log('[FlowTrace][Bridge] APPLY_SETTINGS_ORDER', JSON.stringify({
        mode: target.mode,
        order: isVideo
          ? (videoHasVideoMode
              ? ['mode', 'videoMode', 'model', 'ratio', 'quantity', 'duration']
              : ['mode', 'model', 'ratio', 'quantity', 'duration'])
          : ['mode', 'ratio', 'quantity', 'model'],
      }))

      if (isVideo) {
        // ── Video branch ──────────────────────────────────────────
        // ── Step 5v: Select model FIRST ────────────────────────────
        bridgeLog('[Bridge][rs] select model START', target.model)
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_MODEL_RESULT', JSON.stringify({
          targetModel: target.model,
        }))
        var videoModelResult = await selectModelDropdown(activePanel, target.model as string)
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_MODEL_DONE', JSON.stringify({
          success: !!videoModelResult.success,
          method: videoModelResult.method || '',
          error: videoModelResult.error || '',
          clickedText: videoModelResult.clickedText || '',
          detailsKeys: Object.keys((videoModelResult as Record<string, unknown>).details as Record<string, unknown> || {}),
        }))
        if (!videoModelResult.success) {
          return videoModelResult
        }

        activePanel = getActiveFlowSettingsPanel()
        if (!activePanel || activePanel === document) {
          return { success: false, error: 'FLOW_SETTINGS_PANEL_NOT_FOUND' }
        }

        // ── Step 6v: Select ratio (was Step 7v) ───────────────────
        // Ratio goes before quantity because changing ratio can re-mount
        // the quantity chip row on some builds; we want quantity to land
        // last (alongside duration) in a fully settled panel.
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_RATIO_RESULT', JSON.stringify({
          targetRatio: target.ratio,
          order: 'after model selection',
        }))
        var videoRatioResult = await selectRatio(activePanel, target.ratio as string)
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_RATIO_DONE', JSON.stringify({
          success: !!videoRatioResult.success,
          method: videoRatioResult.method || '',
          error: videoRatioResult.error || '',
        }))
        if (!videoRatioResult.success) {
          return videoRatioResult
        }
        await sleep(250)

        activePanel = getActiveFlowSettingsPanel()
        if (!activePanel || activePanel === document) {
          return { success: false, error: 'FLOW_SETTINGS_PANEL_NOT_FOUND' }
        }

        // ── Step 7v: Select quantity (was Step 8v) ────────────────
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_QTY_RESULT', JSON.stringify({
          targetQuantity: target.quantity,
          order: 'before duration (so duration lands last)',
        }))
        var videoQtyResult = await selectFlowQuantity(target.quantity as number, settingsBtn)
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_QTY_DONE', JSON.stringify({
          success: !!videoQtyResult.success,
          method: videoQtyResult.method || '',
          error: videoQtyResult.error || '',
        }))
        if (!videoQtyResult.success) {
          return videoQtyResult
        }
        await sleep(250)

        activePanel = getActiveFlowSettingsPanel()
        if (!activePanel || activePanel === document) {
          return { success: false, error: 'FLOW_SETTINGS_PANEL_NOT_FOUND' }
        }

        // ── Step 8v: Select duration LAST (was Step 6v) ───────────
        // Duration is now last so its final click lands in a settled
        // chip list and the post-click snapshot verify below catches
        // any normalize-back (Flow "freezing" 4s back to 8s when the
        // active model doesn't actually support 4s). Failures here
        // are HARD — the verify step in __flowContent__ won't paper
        // over a duration normalize-by-UI.
        if (target.duration) {
          await sleep(450)
          console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_DURATION_RESULT', JSON.stringify({
            targetDuration: target.duration,
            order: 'last (after model + ratio + quantity)',
          }))
          var durResult = await selectDuration(target.duration as string, activePanel)
          console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_DURATION_DONE', JSON.stringify({
            targetDuration: target.duration,
            success: !!durResult.success,
            method: durResult.method || '',
            error: durResult.error || '',
            actualDuration: durResult.actualDuration || '',
            verified: durResult.verified === true,
          }))
          if (!durResult.success) {
            // HARD-FAIL: don't proceed to submit with a missing/wrong duration.
            // The user's video will not match the requested setting and we
            // would otherwise report a fake "SUCCESS".
            return durResult
          }
          await sleep(200)
        }
      } else {
        // ── Image branch (unchanged order) ────────────────────────
        // ── Step 5i: Select ratio ─────────────────────────────────
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_RATIO_RESULT', JSON.stringify({
          targetRatio: target.ratio,
        }))
        var ratioResult = await selectRatio(activePanel, target.ratio as string)
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_RATIO_DONE', JSON.stringify({
          success: !!ratioResult.success,
          method: ratioResult.method || '',
          error: ratioResult.error || '',
        }))
        if (!ratioResult.success) {
          return ratioResult
        }

        // ── Step 6i: Select quantity ──────────────────────────────
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_QTY_RESULT', JSON.stringify({
          targetQuantity: target.quantity,
        }))
        var qtyResult = await selectFlowQuantity(target.quantity as number, settingsBtn)
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_QTY_DONE', JSON.stringify({
          success: !!qtyResult.success,
          method: qtyResult.method || '',
          error: qtyResult.error || '',
        }))
        if (!qtyResult.success) {
          return qtyResult
        }

        // ── Step 7i: Select model ─────────────────────────────────
        bridgeLog('[Bridge][rs] select model START', target.model)
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_MODEL_RESULT', JSON.stringify({
          targetModel: target.model,
        }))
        var modelResult = await selectModelDropdown(activePanel, target.model as string)
        console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_MODEL_DONE', JSON.stringify({
          success: !!modelResult.success,
          method: modelResult.method || '',
          error: modelResult.error || '',
          clickedText: modelResult.clickedText || '',
          detailsKeys: Object.keys((modelResult as Record<string, unknown>).details as Record<string, unknown> || {}),
        }))
        if (!modelResult.success) {
          return modelResult
        }
      }

      // ── Step 9: Verify current settings ──────────────────────────
      var current = readCurrentFlowSettings()
      bridgeDebug('[Bridge][rs] verify settings', current)
      console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_VERIFY_CURRENT', JSON.stringify({
        current: current || null,
      }))

      // ── Step 10: Close settings panel before returning ─────────
      var freshSettingsBtn = (typeof getFlowSettingsButton === 'function' ? getFlowSettingsButton() : null) || settingsBtn
      // Capture videoMode from the still-open panel (popup is closed
      // AFTER this snapshot — see closeFlowSettingsPanelWithEscape()).
      // For legacy callers where flowVideoMode was undefined, this
      // snapshot still records the current state but compare
      // ignores it (no mismatch gate).
      var verifyPanel = getActiveFlowSettingsPanel()
      var afterSnapshot = readFlowSettingsSnapshot(freshSettingsBtn, verifyPanel)
      var afterCompare = compareFlowSettings(target, afterSnapshot)
      console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_VERIFY_1', JSON.stringify({
        mode: target.mode,
        targetDuration: target.duration || '',
        actualDuration: (afterSnapshot as Record<string, unknown>)?.duration || '',
        targetQuantity: target.quantity,
        actualQuantity: (afterSnapshot as Record<string, unknown>)?.quantity ?? null,
        targetVideoMode: target.flowVideoMode || null,
        actualVideoMode: (afterSnapshot as Record<string, unknown>)?.videoMode || null,
        ok: afterCompare.ok,
      }))
      if (afterCompare.ok) {
        bridgeLog('[Bridge][settings verify] OK')
      } else {
        bridgeWarn('[Bridge][settings verify] MISMATCH (initial)', {
          target: target,
          current: afterSnapshot,
          compare: afterCompare,
        })
      }

      // ── Step 10a: Targeted retry for VIDEO mode mismatch ──────────
      // If duration or quantity don't match after the first verify,
      // re-open the panel (Escape closed it above if we reached this
      // path) and retry just the failing fields. The applied model
      // already has the correct duration list and quantity chips,
      // so re-clicking should land cleanly. Duration click is now
      // last (after quantity) to match the new primary path; some
      // builds re-render the duration row when quantity changes,
      // so quantity goes first in the retry order only when it was
      // the failing field — when duration alone fails we just
      // re-click duration.
      //
      // videoMode mismatch is NOT retried here — it would require
      // clicking the segmented control again and Flow's chip-row
      // re-render semantics for the inputs are risky enough that
      // we hard-stop below (same class as mode/ratio mismatch).
      var videoMismatchFixed = false
      if (isVideo && !afterCompare.ok) {
        var diffDuration = !(afterCompare.diff as Record<string, unknown>).duration
          || (afterCompare.diff as Record<string, { match: boolean }>).duration.match === false
        var diffQuantity = !(afterCompare.diff as Record<string, unknown>).quantity
          || (afterCompare.diff as Record<string, { match: boolean }>).quantity.match === false
        var diffMode = !(afterCompare.diff as Record<string, unknown>).mode
          || (afterCompare.diff as Record<string, { match: boolean }>).mode.match === false
        var diffRatio = !(afterCompare.diff as Record<string, unknown>).ratio
          || (afterCompare.diff as Record<string, { match: boolean }>).ratio.match === false
        // videoMode mismatch is HARD when the caller asked for a
        // specific value. When target.flowVideoMode is undefined
        // (legacy), diffVideoMode stays false and the verify gate
        // skipped it via compareFlowSettings.match=true.
        var diffVideoMode = target.flowVideoMode === 'frame' || target.flowVideoMode === 'ingredient'
          ? (!(afterCompare.diff as Record<string, unknown>).videoMode
              || (afterCompare.diff as Record<string, { match: boolean }>).videoMode.match === false)
          : false

        // Mode / ratio / videoMode mismatches are HARD — no retry can
        // fix them. Re-clicking the segmented control can re-mount
        // chip rows in unpredictable ways; safer to surface the
        // mismatch to the user than silently flip into the wrong mode.
        if (diffMode || diffRatio || diffVideoMode) {
          bridgeWarn('[Bridge][settings verify] mode/ratio/videoMode mismatch — NO retry (hard stop)', {
            diffMode: diffMode,
            diffRatio: diffRatio,
            diffVideoMode: diffVideoMode,
            targetVideoMode: target.flowVideoMode || null,
            actualVideoMode: (afterSnapshot as Record<string, unknown>)?.videoMode || null,
          })
        } else if (diffDuration || diffQuantity) {
          console.log('[FlowTrace][Bridge] APPLY_SETTINGS_RETRY', JSON.stringify({
            retryDuration: diffDuration,
            retryQuantity: diffQuantity,
            targetDuration: target.duration || '',
            targetQuantity: target.quantity,
          }))
          bridgeLog('[Bridge][settings verify] VIDEO retry START', {
            diffDuration: diffDuration,
            diffQuantity: diffQuantity,
          })

          // Re-open panel if closed (verify path closes it on mismatch)
          var retryPanel = getActiveFlowSettingsPanel()
          if (!retryPanel || retryPanel === document || !hasSettingsPanelControls(retryPanel)) {
            var retryBtn = (typeof getFlowSettingsButton === 'function' ? getFlowSettingsButton() : null) || settingsBtn
            dispatchFullClick(retryBtn)
            retryPanel = await waitForFlowSettingsPanel(5000)
          }

          if (!retryPanel || retryPanel === document || !hasSettingsPanelControls(retryPanel)) {
            bridgeWarn('[Bridge][settings verify] VIDEO retry — settings panel not available, cannot fix')
          } else {
            // Duration retry — quantity is now ordered LAST in the
            // primary path, so on a mismatch we re-apply quantity
            // before duration (some builds re-render the duration
            // row when quantity changes mid-retry).
            if (diffQuantity && target.quantity) {
              await sleep(300)
              var retryQty = await selectFlowQuantity(target.quantity as number, settingsBtn)
              bridgeLog('[Bridge][rs] VIDEO retry quantity', retryQty)
              await sleep(300)
            }
            if (diffDuration && target.duration) {
              await sleep(400)
              var retryDur = await selectDuration(target.duration as string, retryPanel)
              bridgeLog('[Bridge][rs] VIDEO retry duration', retryDur)
              await sleep(300)
            }

            // Re-verify
            var retrySettingsBtn = (typeof getFlowSettingsButton === 'function' ? getFlowSettingsButton() : null) || settingsBtn
            var retrySnapshot = readFlowSettingsSnapshot(retrySettingsBtn)
            var retryCompare = compareFlowSettings(target, retrySnapshot)
            console.log('[FlowTrace][Bridge] APPLY_SETTINGS_STEP_VERIFY_2', JSON.stringify({
              mode: target.mode,
              targetDuration: target.duration || '',
              actualDuration: (retrySnapshot as Record<string, unknown>)?.duration || '',
              targetQuantity: target.quantity,
              actualQuantity: (retrySnapshot as Record<string, unknown>)?.quantity ?? null,
              ok: retryCompare.ok,
            }))
            if (retryCompare.ok) {
              videoMismatchFixed = true
              afterSnapshot = retrySnapshot
              afterCompare = retryCompare
              bridgeLog('[Bridge][settings verify] VIDEO retry — FIXED')
            } else {
              bridgeWarn('[Bridge][settings verify] VIDEO retry — STILL MISMATCH', {
                retryCompare: retryCompare,
                retrySnapshot: retrySnapshot,
              })
            }
          }
        }
      }

      if (FLOW_DEBUG_VERBOSE) {
        bridgeDebug('[Bridge][settings compare AFTER]', {
          target: target,
          current: afterSnapshot,
          compare: afterCompare,
        })
      }

      if (!afterCompare.ok) {
        closeFlowSettingsPanelWithEscape()
        await sleep(150)
        return {
          success: false,
          error: 'FLOW_SETTINGS_VERIFY_MISMATCH',
          details: {
            target: target,
            current: afterSnapshot,
            compare: afterCompare,
            videoRetryApplied: isVideo && (afterCompare.diff as Record<string, { match: boolean }>).duration.match === false
              || (afterCompare.diff as Record<string, { match: boolean }>).quantity.match === false,
            videoMismatchFixed: videoMismatchFixed,
          },
        }
      }

      closeFlowSettingsPanelWithEscape()
      await sleep(150)

      return {
        success: true,
        current: current,
        target: target,
      }
    } catch (error) {
      bridgeError('[Bridge] applyFlowSettings EXCEPTION', error)
      return {
        success: false,
        error: 'FLOW_APPLY_SETTINGS_EXCEPTION',
        details: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }
      }
    }
  }

  // ── Debug helpers ────────────────────────────────────────────

  ;(window as Record<string, unknown>).__flowOpenSettings = function (payload: FlowSettingsPayload) {
    if (!ENABLE_FLOW_SETTINGS_AUTOMATION) {
      bridgeLog('[Bridge] __flowOpenSettings: DISABLED (ENABLE_FLOW_SETTINGS_AUTOMATION=false)')
      return { success: false, skipped: true, reason: 'settings_automation_disabled' }
    }
    return openComposerSettings(payload)
  }

  ;(window as Record<string, unknown>).__flowApplySettings = function (payload: any) {
    if (!ENABLE_FLOW_SETTINGS_AUTOMATION) {
      bridgeLog('[Bridge] __flowApplySettings: DISABLED (ENABLE_FLOW_SETTINGS_AUTOMATION=false)')
      return { success: false, skipped: true, reason: 'settings_automation_disabled' }
    }
    return applyFlowSettings(payload)
  }

  ;(window as Record<string, unknown>).__flowDebugSettings = function (payload: FlowSettingsPayload) {
    if (!ENABLE_FLOW_SETTINGS_AUTOMATION) {
      bridgeLog('[Bridge] __flowDebugSettings: DISABLED (ENABLE_FLOW_SETTINGS_AUTOMATION=false)')
      return { skipped: true, reason: 'settings_automation_disabled' }
    }
    var el = findEditorElement()
    var result = {
      editorFound: !!el,
      popupFound: !!findPopupContainer(),
      openResult: openComposerSettings(payload),
    }
    ;(function () {
      setTimeout(function () {
        var popup = findPopupContainer()
        if (popup) {
          (result as Record<string, unknown>).applyResult = applyFlowSettings(payload)
        }
      }, 500)
    })()
    return result
  }

  ;(window as Record<string, unknown>).__flowDebugSelectedStates = function () {
    var popup = findPopupContainer()
    if (!popup) return { popupFound: false }
    var report: Record<string, unknown> = { popupFound: true }
    var items = popup.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"], [role="option"]')
    var activeButtons: Record<string, unknown>[] = []
    items.forEach(function (item) {
      var el = item as HTMLElement
      var ariaPressed = el.getAttribute('aria-pressed')
      var ariaSelected = el.getAttribute('aria-selected')
      var cls = safeLower(el.className)
      var isActive = ariaPressed === 'true' || ariaSelected === 'true' ||
        cls.includes('active') || cls.includes('selected') || cls.includes('current')
      if (isActive) {
        activeButtons.push({
          text: (el.textContent || '').trim().substring(0, 50),
          ariaPressed: ariaPressed,
          ariaSelected: ariaSelected,
          className: cls.substring(0, 80),
        })
      }
    })
    report.activeButtons = activeButtons
    bridgeDebug('[Bridge] __flowDebugSelectedStates:', JSON.stringify(report, null, 2))
    return report
  }

  // ═══════════════════════════════════════════════════════════════
  // TILE MONITOR
  // ═══════════════════════════════════════════════════════════════

  interface Tile {
    id: string
    status: 'generating' | 'done' | 'failed' | 'unknown'
    progress: number
    thumbnail: string
    fileName: string
    createdAt: number
    // When the tile was first observed in 'failed' state. The orchestrator
    // uses this together with MIN_FAIL_DETECT_MS to confirm a real fail
    // (avoid transient false positives during generation retries).
    failedFirstSeenAt?: number
    // Diagnostic: which detection rule matched for the current status.
    statusReason?: string
    errorCode?: string
    evidence?: Array<Record<string, unknown>>
    // Rich diagnostics for PENDING_SIGNAL_DEBUG.
    textPreview?: string       // tile.textContent.slice(0, 300)
    iconTexts?: string[]       // visible icon texts: ["warning", "refresh", ...]
    buttonTexts?: string[]     // visible button texts
    className?: string         // uniqueEl.className slice
    // Media details for SUCCESS_SIGNAL_DEBUG and provisionalDone logic.
    hasVideo?: boolean
    hasImg?: boolean
    videoSrc?: string         // video.getAttribute('src')
    videoCurrentSrc?: string  // video.currentSrc
    videoPoster?: string      // video.poster
    imgSrc?: string           // img.getAttribute('src')
    imgAlt?: string           // img.getAttribute('alt')
    mediaReadyReason?: string // which signal made the tile media-ready
    rect?: { top: number; bottom: number; left: number; right: number }
  }

  var _tileMonitorInterval: ReturnType<typeof setInterval> | null = null
  var _knownTileIds = new Set<string>()
  var _tileMonitorCallback: ((tiles: Tile[]) => void) | null = null

  // Dedupe nested DOM observations by composite identity. Different IDs are
  // never collapsed solely because Flow reused a filename.
  function dedupeTilesByIdentity(tileList): any[] {
    return dedupeFlowTileObservations(tileList || [])
  }

  // Detect the status of a tile using priority order:
  // A. success → B. processing → C. warning icon → D. text fallback → E. retry/delete
  // Returns the final status AND emits diagnostic info (iconTexts, buttonTexts)
  // that get packed into the snapshot for PENDING_SIGNAL_DEBUG in content.
  function detectTileStatus(
    tileEl: HTMLElement,
    extra: {
      hasMediaSuccess: boolean
      progressPercent: number
    }
  ): {
    status: Tile['status']
    reason: string
    iconTexts: string[]
    buttonTexts: string[]
    errorCode?: string
    evidence?: Array<Record<string, unknown>>
  } {
    var iconTexts: string[] = []
    var buttonTexts: string[] = []

    // ── A. SUCCESS ───────────────────────────────────────────────────────────
    // Tile has a valid video/img with a real CDN URL — no retry needed.
    // BUT: if progressPercent > 0 the media is still downloading, treat as processing.
    if (extra.hasMediaSuccess && extra.progressPercent === 0) {
      return { status: 'done', reason: 'media_success', iconTexts: [], buttonTexts: [] }
    }

    // ── B. PROCESSING ────────────────────────────────────────────────────────
    // Flow paints "N%" in a leaf div/span when generation is in progress.
    // We already extracted progressPercent; if it exists the tile is processing.
    // Check BEFORE failed so that a tile mid-transition with a hidden warning
    // icon visible does not get misclassified.
    if (extra.progressPercent > 0) {
      return { status: 'generating', reason: 'progress_percent', iconTexts: [], buttonTexts: [] }
    }

    // Flow can keep a freshly submitted tile in a provider queue before it
    // starts painting a percentage. Match only exact status-label text from
    // leaf/status elements so prompt text cannot create a false busy signal.
    try {
      var queueStatusEls = tileEl.querySelectorAll('[role="status"], [aria-live], div, span')
      for (var qsi = 0; qsi < queueStatusEls.length; qsi++) {
        var queueStatusEl = queueStatusEls[qsi] as HTMLElement
        var isExplicitStatus = queueStatusEl.getAttribute('role') === 'status' || queueStatusEl.hasAttribute('aria-live')
        if (!isExplicitStatus && queueStatusEl.childElementCount > 0) continue
        var queueStatusText = (queueStatusEl.innerText || queueStatusEl.textContent || '').trim()
        if (isFlowQueueStatusText(queueStatusText)) {
          return { status: 'unknown', reason: 'queued_pending', iconTexts: [], buttonTexts: [] }
        }
      }
    } catch (_) {}

    // Collect all visible icons and buttons for C/D/E below (single DOM pass).
    try {
      // i.google-symbols, span.google-symbols, [class*="google-symbols"],
      // [class*="material-symbol"], [class*="material-icons"],
      // [aria-label*="warning" i], [data-icon*="warning" i], svg
      var iconEls = tileEl.querySelectorAll(
        'i.google-symbols, span.google-symbols, ' +
        '[class*="google-symbols"], [class*="material-symbol"], ' +
        '[class*="material-icons"], [aria-label*="warning" i], ' +
        '[data-icon*="warning" i], svg'
      )
      for (var ii = 0; ii < iconEls.length; ii++) {
        var icon = iconEls[ii]
        var txt = (icon.textContent || '').trim()
        var aria = (icon.getAttribute('aria-label') || '').trim()
        var dataIcon = (icon.getAttribute('data-icon') || '').trim()
        if (txt) iconTexts.push(txt)
        if (aria && !iconTexts.includes(aria)) iconTexts.push(aria)
        if (dataIcon && !iconTexts.includes(dataIcon)) iconTexts.push(dataIcon)
      }

      // Collect button texts for E.
      var btnEls = tileEl.querySelectorAll('button, [role="button"]')
      for (var bi = 0; bi < btnEls.length; bi++) {
        var btnTxt = (btnEls[bi].textContent || '').trim()
        var btnAria = (btnEls[bi].getAttribute('aria-label') || '').trim()
        if (btnTxt) buttonTexts.push(btnTxt)
        if (btnAria && !buttonTexts.includes(btnAria)) buttonTexts.push(btnAria)
      }
    } catch (_) {}

    // ── C. WARNING ICON VISIBLE ───────────────────────────────────────────────
    // Account/session/rate evidence is stronger than a generic warning icon.
    // Evaluate only those specific classes here; ordinary generation failure
    // still follows the established warning/text/retry priority below.
    var accountTextClassification = classifyFlowErrorText((tileEl.textContent || '').toLowerCase())
    if (accountTextClassification && accountTextClassification.errorCode !== 'generation_failed') {
      return {
        status: 'failed',
        reason: accountTextClassification.statusReason,
        iconTexts: iconTexts,
        buttonTexts: buttonTexts,
        errorCode: accountTextClassification.errorCode,
        evidence: [{
          source: 'dom',
          detectedAt: Date.now(),
          confidence: accountTextClassification.confidence,
          statusReason: accountTextClassification.statusReason,
          matchedText: accountTextClassification.matchedText,
        }],
      }
    }

    // Match: text === "warning" / includes "warning" / aria-label contains warning /
    // icon inside a visible failed card.  Strict visibility check:
    // - icon display != none, visibility != hidden, opacity != 0
    // - all ancestors up to tileEl are visible
    try {
      var allIconEls = tileEl.querySelectorAll(
        'i, span, div, svg, [class*="material"], [class*="google-symbols"]'
      )
      for (var wi = 0; wi < allIconEls.length; wi++) {
        var wIcon = allIconEls[wi] as HTMLElement
        var wStyle = window.getComputedStyle(wIcon)
        // Skip hidden icons
        if (
          wStyle.display === 'none' ||
          wStyle.visibility === 'hidden' ||
          parseFloat(wStyle.opacity || '1') === 0
        ) continue
        // Check ancestors up to tileEl
        var wAncestor: HTMLElement | null = wIcon
        var wAncestorHidden = false
        while (wAncestor && wAncestor !== tileEl) {
          var wAStyle = window.getComputedStyle(wAncestor)
          if (
            wAStyle.display === 'none' ||
            wAStyle.visibility === 'hidden' ||
            parseFloat(wAStyle.opacity || '1') === 0
          ) { wAncestorHidden = true; break }
          wAncestor = wAncestor.parentElement
        }
        if (wAncestorHidden) continue
        // Check rect
        var wRect = wIcon.getBoundingClientRect()
        if (wRect.width <= 0 || wRect.height <= 0) continue
        // Match warning patterns
        var wTxt = (wIcon.textContent || '').trim().toLowerCase()
        var wAria = (wIcon.getAttribute('aria-label') || '').toLowerCase()
        var wDataIcon = (wIcon.getAttribute('data-icon') || '').toLowerCase()
        var wClass = (wIcon.className || '').toString().toLowerCase()
        var wTag = wIcon.tagName.toLowerCase()
        var isWarningIcon =
          wTxt === 'warning' ||
          wTxt.includes('warning') ||
          wAria.includes('warning') ||
          wDataIcon.includes('warning') ||
          wClass.includes('warning') ||
          wClass.includes('error')
        if (!isWarningIcon) continue
        // Additional signal: icon should be a leaf (no child elements with text)
        // or appear in a known failure card container.
        var hasTextChild = false
        for (var ci = 0; ci < wIcon.children.length; ci++) {
          if ((wIcon.children[ci].textContent || '').trim().length > 0) {
            hasTextChild = true
            break
          }
        }
        if (!hasTextChild) {
          return {
            status: 'failed',
            reason: 'warning_icon_visible',
            iconTexts: iconTexts,
            buttonTexts: buttonTexts,
          }
        }
      }
    } catch (_) {}

    // ── D. TEXT FALLBACK ──────────────────────────────────────────────────────
    // Match failure card text (multi-language).
    // "trung tâm trợ giúp" only counts as a failure signal when it co-occurs
    // with an explicit failure phrase — the help link can appear elsewhere on
    // Flow's UI and would otherwise false-positive.
    var tileText = (tileEl.textContent || '').toLowerCase()
    var textClassification = classifyFlowErrorText(tileText)
    if (textClassification) {
      return {
        status: 'failed',
        reason: textClassification.statusReason,
        iconTexts: iconTexts,
        buttonTexts: buttonTexts,
        errorCode: textClassification.errorCode,
        evidence: [{
          source: 'dom',
          detectedAt: Date.now(),
          confidence: textClassification.confidence,
          statusReason: textClassification.statusReason,
          matchedText: textClassification.matchedText,
        }],
      }
    }
    var hasExplicitFailurePhrase =
      tileText.includes('không thành công') ||
      tileText.includes('chúng tôi nhận thấy') ||
      tileText.includes('hoạt động bất thường') ||
      tileText.includes('generation failed') ||
      tileText.includes('unable to generate') ||
      tileText.includes('an error occurred')
    if (hasExplicitFailurePhrase) {
      return { status: 'failed', reason: 'failure_card_text', iconTexts: iconTexts, buttonTexts: buttonTexts }
    }
    // "trung tâm trợ giúp" alone is not a reliable failure indicator.
    // Only trigger when paired with an explicit failure phrase above.

    // ── E. RETRY / DELETE FALLBACK ────────────────────────────────────────────
    // If tile has no successful media and shows a retry/delete affordance,
    // treat as retryable_failed.
    if (!extra.hasMediaSuccess) {
      for (var rti = 0; rti < buttonTexts.length; rti++) {
        var rtLower = buttonTexts[rti].toLowerCase()
        if (
          rtLower === 'refresh' ||
          rtLower === 'retry' ||
          rtLower === 'thử lại' ||
          rtLower === 'tạo lại' ||
          rtLower.includes('refresh') ||
          rtLower.includes('retry')
        ) {
          return { status: 'failed', reason: 'retry_button', iconTexts: iconTexts, buttonTexts: buttonTexts }
        }
      }
      for (var rii = 0; rii < iconTexts.length; rii++) {
        var riLower = iconTexts[rii].toLowerCase()
        if (
          riLower.includes('delete_forever') ||
          riLower.includes('refresh') ||
          riLower.includes('retry')
        ) {
          return { status: 'failed', reason: 'retry_button', iconTexts: iconTexts, buttonTexts: buttonTexts }
        }
      }
    }

    return { status: 'unknown', reason: 'none', iconTexts: iconTexts, buttonTexts: buttonTexts }
  }

  // Thin wrapper: tileHasFailureSignals calls detectTileStatus with the
  // extra context extracted here.  This keeps the API compatible with the
  // scanTiles call site while delegating to the detectTileStatus logic.
  function tileHasFailureSignals(el: HTMLElement): { failed: boolean; reason: string } {
    try {
      var playBtn = el.querySelector(
        'button[aria-label*="play" i], button[aria-label*="Play"], ' +
        '[data-testid*="play" i], [class*="play" i], svg path[d*="8 5"], svg path[d*="M8 5"]'
      )
      var img = el.querySelector('img[src]:not([src=""]):not([class*="placeholder"])')
      var video = el.querySelector('video')
      var hasMediaSuccess = !!(
        playBtn ||
        (img && img.getAttribute('src') && !img.getAttribute('src')!.includes('data:') &&
         !img.getAttribute('src')!.includes('placeholder') &&
         !img.getAttribute('src')!.includes('media.html')) ||
        video
      )
      var progressPercent = 0
      try {
        var percentEl = el.querySelector('div, span')
        var percentText = (percentEl && percentEl.textContent || '').trim()
        if (/^\d{1,3}%$/.test(percentText)) {
          progressPercent = parseInt(percentText, 10)
        }
      } catch (_) {}
      var result = detectTileStatus(el, { hasMediaSuccess: hasMediaSuccess, progressPercent: progressPercent })
      return { failed: result.status === 'failed', reason: result.reason }
    } catch (_) {
      return { failed: false, reason: 'none' }
    }
  }

  // Persisted failed-observation timestamps so MIN_FAIL_DETECT_MS can
  // confirm a real fail across multiple scanTiles() calls.
  var _failedFirstSeenAtByTile: Record<string, number> = {}

  function scanTiles(): Tile[] {
    var tiles: Tile[] = []
    try {
      // Find all tile containers — try multiple selectors
      var containers = document.querySelectorAll(
        '[data-tile-id], [class*="tile"], [class*="result"], [class*="generation"]'
      )

      // Track containers already processed so a nested element with both
      // [data-tile-id] and [class*="tile"] does not emit twice.
      var processedElements = new Set<HTMLElement>()
      // Track first-occurrence DOM order so dedupe preserves order
      var orderedUnique: Array<{ el: HTMLElement; id: string }> = []
      var seenIds = new Set<string>()
      var rawCount = 0

      containers.forEach(function (container) {
        rawCount++
        var el = container as HTMLElement

        // Find the outermost ancestor that already matches our tile selectors.
        // If `el` is nested inside an already-seen tile ancestor, skip.
        var ancestor: HTMLElement | null = el
        var nestedInKnownTile = false
        while (ancestor && ancestor !== document.body) {
          if (processedElements.has(ancestor) && ancestor !== el) {
            nestedInKnownTile = true
            break
          }
          ancestor = ancestor.parentElement
        }
        if (nestedInKnownTile) return
        processedElements.add(el)

        var id = ''
        try {
          id = el.dataset.tileId || el.dataset.genTile || ''
        } catch (_) {}

        if (!id) {
          try {
            var path = window.location.pathname
            var rect = el.getBoundingClientRect()
            var key = el.tagName + '-' + Math.round(rect.top) + '-' + Math.round(rect.left)
            id = btoa(key).substring(0, 20)
          } catch (_) {
            return
          }
        }

        if (seenIds.has(id)) return
        seenIds.add(id)
        orderedUnique.push({ el: el, id: id })
      })

      // Now process each unique element exactly once
      for (var uoi = 0; uoi < orderedUnique.length; uoi++) {
        var uniqueEl = orderedUnique[uoi].el
        var uniqueId = orderedUnique[uoi].id

        // Extract media + progress context before calling detectTileStatus.
        // These are used both for success detection and for the
        // priority order: success > processing > failed.
        var playBtn: Element | null = null
        var img: HTMLImageElement | null = null
        var video: HTMLVideoElement | null = null
        var progressPercent = 0
        var hasMediaSuccess = false
        try {
          playBtn = uniqueEl.querySelector(
            'button[aria-label*="play" i], button[aria-label*="Play"], ' +
            '[data-testid*="play" i], [class*="play" i], svg path[d*="8 5"], svg path[d*="M8 5"]'
          )
          img = uniqueEl.querySelector(
            'img[src]:not([src=""]):not([class*="placeholder"])'
          ) as HTMLImageElement | null
          video = uniqueEl.querySelector('video') as HTMLVideoElement | null
          var src = img ? img.getAttribute('src') || '' : ''
          hasMediaSuccess = !!(
            playBtn ||
            (src && !src.includes('data:') && !src.includes('placeholder') &&
             !src.includes('media.html') && !src.includes('chrome-extension'))
          )
          // Extract progress percent: Flow paints "N%" in a leaf div/span.
          var textEls = uniqueEl.querySelectorAll('div, span')
          for (var ppi = 0; ppi < textEls.length; ppi++) {
            var pt = (textEls[ppi].textContent || '').trim()
            if (/^\d{1,3}%$/.test(pt)) {
              progressPercent = parseInt(pt, 10)
              break
            }
          }
        } catch (_) {}

        // Call detectTileStatus with the priority order A→B→C→D→E.
        var detectResult = detectTileStatus(uniqueEl, {
          hasMediaSuccess: hasMediaSuccess,
          progressPercent: progressPercent,
        })
        var status: Tile['status'] = detectResult.status
        var statusReason = detectResult.reason
        var tileIconTexts = detectResult.iconTexts
        var tileButtonTexts = detectResult.buttonTexts
        var tileErrorCode = detectResult.errorCode || ''
        var tileEvidence = detectResult.evidence || []

        // Extract textPreview and className for PENDING_SIGNAL_DEBUG.
        var textPreview = ''
        try {
          textPreview = (uniqueEl.textContent || '').slice(0, 300).trim()
        } catch (_) {}
        var tileClassName = ''
        try {
          tileClassName = uniqueEl.className.slice(0, 200)
        } catch (_) {}

        // Extract thumbnail and all media details for SUCCESS_SIGNAL_DEBUG.
        var thumbnail = ''
        var hasVideo = false
        var hasImg = false
        var videoSrc = ''
        var videoCurrentSrc = ''
        var videoPoster = ''
        var imgSrc = ''
        var imgAlt = ''
        var mediaReadyReason = ''
        try {
          if (video) {
            hasVideo = true
            videoSrc = (video as HTMLVideoElement).src || ''
            videoCurrentSrc = (video as HTMLVideoElement).currentSrc || ''
            videoPoster = (video as HTMLVideoElement).poster || ''
            if (videoSrc || videoCurrentSrc || videoPoster) {
              thumbnail = videoCurrentSrc || videoSrc || videoPoster
              mediaReadyReason = 'video_src'
            }
          }
          if (img && img.getAttribute('src')) {
            var imgSrcAttr = img.getAttribute('src') || ''
            if (
              !imgSrcAttr.includes('data:') &&
              !imgSrcAttr.includes('placeholder') &&
              !imgSrcAttr.includes('media.html') &&
              !imgSrcAttr.includes('chrome-extension')
            ) {
              hasImg = true
              imgSrc = imgSrcAttr
              imgAlt = img.getAttribute('alt') || ''
              if (!thumbnail) {
                thumbnail = imgSrcAttr
                mediaReadyReason = 'img_src'
              }
            }
          }
        } catch (_) {}

        // Extract fileName for identity tracking
        var tileFileName = ''
        try {
          tileFileName = extractFileName(uniqueId)
        } catch (_) {}

        try {
          var tileRect = uniqueEl.getBoundingClientRect()
          // Track failedFirstSeenAt for MIN_FAIL_DETECT_MS.
          // IMPORTANT: do NOT cache status='failed' — a tile can flip back
          // to processing/success when Flow retries. We always re-check.
          if (status === 'failed') {
            if (!_failedFirstSeenAtByTile[uniqueId]) {
              _failedFirstSeenAtByTile[uniqueId] = Date.now()
            }
          } else {
            // Any non-failed state clears the failed observation.
            // If a tile transitions failed → processing → done, the next
            // scan will not treat it as failed.
            delete _failedFirstSeenAtByTile[uniqueId]
          }
          tiles.push({
            id: uniqueId,
            status: status,
            progress: progressPercent,
            thumbnail: thumbnail,
            fileName: tileFileName,
            createdAt: 0,
            failedFirstSeenAt: _failedFirstSeenAtByTile[uniqueId] || 0,
            statusReason: statusReason,
            errorCode: tileErrorCode,
            evidence: tileEvidence,
            // Rich diagnostic fields.
            textPreview: textPreview,
            iconTexts: tileIconTexts,
            buttonTexts: tileButtonTexts,
            className: tileClassName,
            // Media details for SUCCESS_SIGNAL_DEBUG and provisionalDone.
            hasVideo: hasVideo,
            hasImg: hasImg,
            videoSrc: videoSrc,
            videoCurrentSrc: videoCurrentSrc,
            videoPoster: videoPoster,
            imgSrc: imgSrc,
            imgAlt: imgAlt,
            mediaReadyReason: mediaReadyReason,
            rect: {
              top: Math.round(tileRect.top),
              bottom: Math.round(tileRect.bottom),
              left: Math.round(tileRect.left),
              right: Math.round(tileRect.right)
            }
          })
        } catch (_) {}
      }
    } catch (e) {
      bridgeDebug('[Bridge] scanTiles error:', e)
    }

    // Final safety net: dedupe by fileName > id at the source.
    // If two passes still produced a duplicate (e.g. same fileName on
    // different DOM nodes), drop the duplicate.
    var deduped = dedupeTilesByIdentity(tiles)
    return deduped
  }

  function detectNewTiles(tiles: Tile[]): Tile[] {
    return tiles.filter(function (t) { return !_knownTileIds.has(t.id) })
  }

  function startTileMonitor(callback: (tiles: Tile[]) => void, intervalMs = 1000): void {
    if (_tileMonitorInterval) {
      clearInterval(_tileMonitorInterval)
    }
    _tileMonitorCallback = callback
    _knownTileIds.clear()

    // Capture baseline
    var baseline = scanTiles()
    baseline.forEach(function (t) { _knownTileIds.add(t.id) })
    bridgeLog('[Bridge] TileMonitor baseline:', baseline.length, 'tiles')

    _tileMonitorInterval = setInterval(function () {
      var tiles = scanTiles()
      var newTiles = detectNewTiles(tiles)
      newTiles.forEach(function (t) {
        _knownTileIds.add(t.id)
        bridgeLog('[Bridge] New tile detected:', t.id, 'status:', t.status)
      })
      if (_tileMonitorCallback) {
        _tileMonitorCallback(tiles)
      }
    }, intervalMs)
    bridgeRuntimeInstance.pollingLoopCount = 1

    bridgeLog('[Bridge] TileMonitor started, interval=' + intervalMs + 'ms')
  }

  function stopTileMonitor(): void {
    if (_tileMonitorInterval) {
      clearInterval(_tileMonitorInterval)
      _tileMonitorInterval = null
    }
    bridgeRuntimeInstance.pollingLoopCount = 0
    _tileMonitorCallback = null
    _knownTileIds.clear()
    bridgeLog('[Bridge] TileMonitor stopped')
  }

  function getTileCounts(tiles: Tile[]): { generating: number; done: number; failed: number; total: number } {
    var counts = { generating: 0, done: 0, failed: 0, total: tiles.length }
    tiles.forEach(function (t) {
      if (t.status === 'generating') counts.generating++
      else if (t.status === 'done') counts.done++
      else if (t.status === 'failed') counts.failed++
    })
    return counts
  }

  // Non-generating health probe used by the background admission gate.
  // It never inserts text, clicks Generate, reads cookies, or calls a Flow API.
  function getFlowAdmissionHealth(): Record<string, unknown> {
    var tiles = scanTiles()
    var counts = getTileCounts(tiles)
    var activityCounts = countFlowTileActivity(tiles)
    var composer = findEditorElement() || findGoogleFlowEditor()
    var warningContexts: FlowWarningContext[] = []
    var warningElements = new Set<HTMLElement>()

    // Account/session/rate warnings are classified only from explicit visible
    // warning surfaces. Never scan document.body, the composer, or old tiles:
    // all three may contain user prompt text or historical generation errors.
    var warningSelectors: Array<{ selector: string; kind: FlowWarningContext['kind'] }> = [
      { selector: '[role="dialog"]', kind: 'dialog' },
      { selector: '[aria-modal="true"]', kind: 'dialog' },
      { selector: '[role="alert"]', kind: 'alert' },
      { selector: '[data-sonner-toast]', kind: 'toast' },
      { selector: '[data-toast-root]', kind: 'toast' },
      { selector: '[aria-live="assertive"]', kind: 'status' },
      { selector: '[aria-live="polite"]', kind: 'status' },
      { selector: '[role="status"]', kind: 'status' },
    ]
    try {
      for (var wsi = 0; wsi < warningSelectors.length; wsi++) {
        var warningRule = warningSelectors[wsi]
        var matches = Array.from(document.querySelectorAll(warningRule.selector)) as HTMLElement[]
        for (var wei = 0; wei < matches.length; wei++) {
          var warningElement = matches[wei]
          if (warningElements.has(warningElement) || !isVisible(warningElement)) continue
          if (composer && (
            warningElement === composer ||
            warningElement.contains(composer) ||
            composer.contains(warningElement)
          )) continue
          warningElements.add(warningElement)
          var warningKind = warningElement.closest('[data-tile-id], [data-gen-tile]')
            ? 'tile'
            : warningRule.kind
          warningContexts.push({
            kind: warningKind,
            selector: warningRule.selector,
            text: (warningElement.innerText || warningElement.textContent || '').slice(0, 4_000),
          })
        }
      }
    } catch (_) {}
    var pageClassification = classifyFlowAdmissionWarningContexts(warningContexts)

    var blockingDialog = false
    var blockingSelector = ''
    try {
      var dialogSelectors = ['[role="dialog"]', '[aria-modal="true"]']
      for (var dsi = 0; dsi < dialogSelectors.length && !blockingDialog; dsi++) {
        var dialogs = Array.from(document.querySelectorAll(dialogSelectors[dsi])) as HTMLElement[]
        for (var di = 0; di < dialogs.length; di++) {
          if (isVisible(dialogs[di])) {
            blockingDialog = true
            blockingSelector = dialogSelectors[dsi]
            break
          }
        }
      }
    } catch (_) {}

    var errorCode = pageClassification?.errorCode || ''
    var statusReason = pageClassification?.statusReason || ''
    var evidence: Array<Record<string, unknown>> = []
    if (pageClassification) {
      evidence.push({
        source: 'dom',
        detectedAt: Date.now(),
        confidence: pageClassification.confidence,
        statusReason: pageClassification.statusReason,
        matchedText: pageClassification.matchedText,
        selector: pageClassification.selector,
      })
    } else if (!composer) {
      errorCode = 'composer_missing'
      statusReason = 'flow_composer_not_found'
      evidence.push({ source: 'dom', detectedAt: Date.now(), confidence: 'high', statusReason: statusReason })
    } else if (blockingDialog) {
      errorCode = 'flow_busy'
      statusReason = 'blocking_dialog_visible'
      evidence.push({ source: 'dom', detectedAt: Date.now(), confidence: 'high', statusReason: statusReason, selector: blockingSelector })
    } else if (activityCounts.generating > 0 || activityCounts.processing > 0 || activityCounts.pending > 0) {
      errorCode = 'flow_busy'
      statusReason = activityCounts.pending > 0 ? 'provider_has_pending_tiles' : 'provider_has_generating_tiles'
      evidence.push({ source: 'dom', detectedAt: Date.now(), confidence: 'high', statusReason: statusReason })
    }

    return {
      success: true,
      healthy: !errorCode,
      bridgeReady: true,
      composerPresent: !!composer,
      processing: activityCounts.processing,
      pending: activityCounts.pending,
      generating: activityCounts.generating,
      counts: counts,
      blockingDialog: blockingDialog,
      errorCode: errorCode || undefined,
      statusReason: statusReason || 'flow_provider_idle',
      evidence: evidence,
      url: window.location.href,
    }
  }

  ;(window as Record<string, unknown>).__flowGetTiles = function (): Tile[] {
    return scanTiles()
  }

  ;(window as Record<string, unknown>).__flowGetTileCounts = function (): { generating: number; done: number; failed: number; total: number } {
    return getTileCounts(scanTiles())
  }

  ;(window as Record<string, unknown>).__flowStartTileMonitor = function (callback: (tiles: Tile[]) => void, intervalMs?: number): void {
    startTileMonitor(callback, intervalMs || 1000)
  }

  ;(window as Record<string, unknown>).__flowStopTileMonitor = function (): void {
    stopTileMonitor()
  }

  // ═══════════════════════════════════════════════════════════════
  // AUTO DOWNLOAD — Flow native menu path
  // ═══════════════════════════════════════════════════════════════

  // Download deduplication lock per tile
  var _downloadLocks: Record<string, boolean> = {}
  // Single-fire guard: prevents the same tile+resolution from being clicked twice.
  // Key format: "tileId:resolution". Set at the TOP of the bridge module
  // so it is accessible to all download functions at runtime.
  var clickedResolutionTokens = new Set<string>()

  interface DownloadTileMediaOptions {
    tileId: string
    // Explicit media kind from caller (flow-content.ts). This is the
    // authoritative signal — we MUST NOT guess from `resolution` because
    // a video request with `videoResolution='720p'` should still be a
    // video tile even when the thumbnail IMG fallback is used.
    mode: 'image' | 'video'
    resolution: string
    videoResolution: string
    fileName: string
    taskName: string
    index: number
    promptText: string
  }

  function downloadTileMediaFromBridge(opts: DownloadTileMediaOptions): Promise<Record<string, unknown>> {
    // Try every viable media candidate inside the tile in priority order.
    // If one candidate fails (right-click miss, menu not found, no download
    // item, no resolution match), fall through to the next. The tile as
    // a whole only fails when ALL candidates fail.
    return new Promise(async function (resolve) {
      var tileId = opts.tileId
      var resolution = opts.resolution || '1k'
      var videoResolution = opts.videoResolution || '720p'
      var fileName = opts.fileName || ''
      var taskName = opts.taskName || ''
      var index = opts.index || 1
      var promptText = opts.promptText || 'flow'

      // AUTHORITATIVE mediaKind from caller. Never inferred from
      // `videoResolution` because that field defaults to '720p' and
      // would otherwise make every request look like a video.
      var mode = String(opts.mode || '').toLowerCase()
      var mediaKind: 'video' | 'image' = mode === 'video' ? 'video' : 'image'
      var isVideo = mediaKind === 'video'
      // Resolution token to click in the menu.
      var chosenRes = isVideo ? videoResolution : resolution

      bridgeLog('[Bridge][download] Starting', JSON.stringify({
        tileId: tileId,
        mode: mode,
        mediaKind: mediaKind,
        resolution: resolution,
        videoResolution: videoResolution,
        chosenRes: chosenRes,
      }))

      // Lock check
      if (_downloadLocks[tileId]) {
        bridgeLog('[Bridge][download] SKIPPED — lock held for tile:', tileId)
        resolve({ success: false, error: 'download_already_in_progress', tileId: tileId })
        return
      }
      _downloadLocks[tileId] = true

      try {
        // Step 1: Find tile by data-tile-id
        var tileEl = document.querySelector('[data-tile-id="' + tileId + '"]') as HTMLElement | null
        if (!tileEl) {
          bridgeLog('[Bridge][download] tile not found by data-tile-id:', tileId)
          resolve({ success: false, error: 'tile_not_found', tileId: tileId })
          return
        }

        // Step 1.5: Wait for at least one valid media candidate to mount.
        await waitForAnyMediaCandidate(tileEl, isVideo, 15000)

        // Step 2: Build candidate list. For video we prefer <video> then
        // video-flavored <img>. For image we prefer <img>.
        var candidates = collectDownloadMediaCandidates(tileEl, isVideo)
        if (candidates.length === 0) {
          // Diagnostic dump.
          try {
            var allVids = tileEl.querySelectorAll('video')
            var allImgs2 = tileEl.querySelectorAll('img')
            bridgeWarn('[Bridge][download] media candidates', JSON.stringify({
              tileId: tileId,
              videos: Array.from(allVids).map(function (v: HTMLVideoElement) {
                return {
                  src: v.src, currentSrc: v.currentSrc, poster: v.poster,
                  rect: { w: v.getBoundingClientRect().width, h: v.getBoundingClientRect().height },
                }
              }),
              imgs: Array.from(allImgs2).map(function (img: HTMLImageElement) {
                return {
                  src: img.src, alt: img.alt, complete: img.complete,
                  rect: { w: img.getBoundingClientRect().width, h: img.getBoundingClientRect().height },
                }
              }),
            }))
          } catch (_) {}
          resolve({ success: false, error: 'no_media_element', tileId: tileId })
          return
        }

        // Iterate candidates. mediaKind is locked PER-TILE from the caller's
        // `mode` argument. We do NOT re-derive mediaKind per-candidate from
        // the element type — a video request that falls back to a
        // thumbnail <img> MUST still be treated as a video tile (target
        // resolution = videoResolution, menu = video resolution list).
        var lastAttemptErr: string | null = null
        for (var candIdx = 0; candIdx < candidates.length; candIdx++) {
          var candidate = candidates[candIdx]
          // Lock per-tile: do NOT flip mediaType based on element type.
          var mediaType: 'video' | 'image' = mediaKind
          var res = chosenRes

          bridgeLog('[VIDEO_DOWNLOAD_TARGET]', JSON.stringify({
            tileId: tileId,
            fileName: fileName,
            mediaType: mediaType,
            videoResolution: videoResolution,
            resolution: resolution,
            chosenRes: res,
            attemptIndex: candIdx + 1,
            totalCandidates: candidates.length,
            tag: candidate.tagName,
          }))
          bridgeLog('[Bridge][download] candidate ' + (candIdx + 1) + '/' + candidates.length + ' target ' + candidate.tagName, JSON.stringify({ tileId: tileId }))

          var attempt = await tryDownloadFromMediaElement({
            tileEl: tileEl,
            mediaEl: candidate,
            tileId: tileId,
            resolution: resolution,
            videoResolution: videoResolution,
            fileName: fileName,
            taskName: taskName,
            index: index,
            promptText: promptText,
            mediaType: mediaType,
            chosenRes: res,
            attemptIndex: candIdx + 1,
            totalAttempts: candidates.length,
          })

          if (attempt.success) {
            resolve(attempt.result || { success: true, tileId: tileId })
            return
          }

          lastAttemptErr = (attempt.result && (attempt.result.error as string)) || 'unknown'
          bridgeWarn('[Bridge][download] media candidate failed, trying next', JSON.stringify({
            tileId: tileId,
            attemptIndex: candIdx + 1,
            totalCandidates: candidates.length,
            tag: candidate.tagName,
            error: lastAttemptErr,
          }))
        }

        bridgeError('[Bridge][download] all_media_candidates_failed', JSON.stringify({
          tileId: tileId,
          totalCandidates: candidates.length,
          lastError: lastAttemptErr,
        }))
        resolve({ success: false, error: 'all_media_candidates_failed', tileId: tileId, lastError: lastAttemptErr })

      } catch (err) {
        bridgeError('[Bridge][download] ERROR:', (err as Error).message)
        resolve({ success: false, error: String((err as Error)?.message || 'unknown'), tileId: tileId })
      } finally {
        _downloadLocks[tileId] = false
      }
    })
  }

  // Wait for at least one valid media candidate to mount inside the tile.
  // Returns true if found, false on timeout.
  async function waitForAnyMediaCandidate(
    tileEl: HTMLElement,
    preferVideo: boolean,
    timeoutMs: number
  ): Promise<boolean> {
    var start = Date.now()
    var lastLog = 0
    while (Date.now() - start < timeoutMs) {
      var cands = collectDownloadMediaCandidates(tileEl, preferVideo)
      if (cands.length > 0) return true
      if (Date.now() - lastLog > 2000) {
        lastLog = Date.now()
        bridgeLog('[Bridge][download] waiting for media candidate preferVideo=' + preferVideo)
      }
      await sleep(200)
    }
    return false
  }

  // Attempt the right-click → menu → resolution flow on a single media
  // candidate. Returns { success, result } — result is the structured
  // payload to resolve() with.
  async function tryDownloadFromMediaElement(opts: {
    tileEl: HTMLElement
    mediaEl: HTMLVideoElement | HTMLImageElement
    tileId: string
    resolution: string
    videoResolution: string
    fileName: string
    taskName: string
    index: number
    promptText: string
    mediaType: 'video' | 'image'
    chosenRes: string
    attemptIndex: number
    totalAttempts: number
  }): Promise<{ success: boolean; result: Record<string, unknown> | null }> {
    var tileEl = opts.tileEl
    var mediaEl = opts.mediaEl
    var tileId = opts.tileId
    var resolution = opts.resolution
    var videoResolution = opts.videoResolution
    var fileName = opts.fileName
    var taskName = opts.taskName
    var index = opts.index
    var promptText = opts.promptText
    var mediaType = opts.mediaType
    var targetResolution = opts.chosenRes

    // ── HARD GUARD: candidate must be VIDEO or IMG ─────────────────────
    if (!(mediaEl instanceof HTMLVideoElement) && !(mediaEl instanceof HTMLImageElement)) {
      bridgeError('[Bridge][download] INVALID_MEDIA_TARGET', JSON.stringify({
        tileId: tileId,
        mediaType: mediaType,
        tag: (mediaEl && (mediaEl as HTMLElement).tagName) || 'null',
      }))
      return { success: false, result: { success: false, error: 'invalid_media_target', tileId: tileId, tag: (mediaEl && (mediaEl as HTMLElement).tagName) || 'null' } }
    }

    // Scroll into view + wait. Use 'auto' (instead of 'instant') so
    // the browser actually paints after the scroll, then wait for the
    // element to settle. Without this settle wait the elementFromPoint
    // query runs before the layout has recomputed and returns a stale
    // element outside the tile.
    try { tileEl.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' }) } catch (_) {}
    await sleep(500)
    // Second pass: re-read the rect AFTER the scroll settled. The previous
    // version used a single rect read — that broke when the tile was off-
    // screen at the moment of capture.
    var clickTarget: HTMLElement = mediaEl as HTMLElement
    var targetRect = clickTarget.getBoundingClientRect()
    if (targetRect.width < 10 || targetRect.height < 10) {
      return {
        success: false,
        result: { success: false, error: 'invalid_media_target_rect', tileId: tileId, rect: { w: targetRect.width, h: targetRect.height } },
      }
    }
    if (targetRect.top < 0 || targetRect.bottom > window.innerHeight) {
      bridgeWarn('[Bridge][download] tile rect outside viewport, retrying scroll', JSON.stringify({
        tileId: tileId,
        rect: { top: targetRect.top, bottom: targetRect.bottom, w: targetRect.width, h: targetRect.height },
        viewport: { h: window.innerHeight },
      }))
      try { mediaEl.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' }) } catch (_) {}
      await sleep(400)
      targetRect = clickTarget.getBoundingClientRect()
    }

    // ── Multi-point elementFromPoint probe ─────────────────────────────
    // The previous version only tried the center point. That was fragile:
    // a Radix overlay, the prompt-chip, a result badge, or even a fresh
    // Flow overlay could intercept the center hit. We now probe 5 candidate
    // points across the media rect in priority order. As soon as one of
    // them lands INSIDE the tile (or on the media itself), we use it.
    function probePoints(): Array<{ name: string; x: number; y: number }> {
      var r = clickTarget.getBoundingClientRect()
      var cx = r.left + r.width / 2
      var cy = r.top + r.height / 2
      var left = r.left + r.width * 0.25
      var right = r.left + r.width * 0.75
      var top = r.top + r.height * 0.30
      var bottom = r.top + r.height * 0.70
      return [
        { name: 'center', x: cx, y: cy },
        { name: 'top-center', x: (r.left + r.right) / 2, y: top },
        { name: 'bottom-center', x: (r.left + r.right) / 2, y: bottom },
        { name: 'left-quarter', x: left, y: cy },
        { name: 'right-quarter', x: right, y: cy },
      ]
    }

    var probeResults: Array<{ name: string; tag: string; insideTile: boolean; isMedia: boolean; closestTileId: string | null }> = []
    var chosen: { x: number; y: number; name: string } | null = null
    var probePointsArr = probePoints()
    for (var pi = 0; pi < probePointsArr.length; pi++) {
      var p = probePointsArr[pi]
      try {
        var hitEl = document.elementFromPoint(p.x, p.y) as HTMLElement | null
        if (!hitEl) {
          probeResults.push({ name: p.name, tag: 'null', insideTile: false, isMedia: false, closestTileId: null })
          continue
        }
        var isMedia = hitEl === mediaEl || (hitEl as Node).contains(mediaEl) || (mediaEl as Node).contains(hitEl)
        var insideTile = !!(tileEl.contains(hitEl) || hitEl === tileEl)
        // Also accept if the hit's closest [data-tile-id] matches our
        // tile id (covers cases where the hit is in a nested overlay).
        var closest = hitEl.closest('[data-tile-id]') as HTMLElement | null
        var closestTileId = closest ? closest.getAttribute('data-tile-id') : null
        var tileMatch = closestTileId === tileId
        probeResults.push({
          name: p.name,
          tag: hitEl.tagName + (hitEl.className ? '.' + String(hitEl.className).split(' ')[0].substring(0, 30) : ''),
          insideTile: insideTile,
          isMedia: isMedia,
          closestTileId: closestTileId,
        })
        if (isMedia || insideTile || tileMatch) {
          chosen = { x: p.x, y: p.y, name: p.name }
          break
        }
      } catch (_) {}
    }

    // Diagnostic dump so we can see exactly why elementFromPoint failed.
    if (!chosen) {
      var mediaSrc = ''
      var mediaCurrentSrc = ''
      var mediaNatural = { w: 0, h: 0 }
      try {
        if (mediaEl instanceof HTMLImageElement) {
          mediaSrc = mediaEl.src || ''
          mediaCurrentSrc = mediaEl.currentSrc || ''
          mediaNatural = { w: mediaEl.naturalWidth || 0, h: mediaEl.naturalHeight || 0 }
        } else if (mediaEl instanceof HTMLVideoElement) {
          mediaSrc = mediaEl.src || mediaEl.currentSrc || ''
          mediaNatural = { w: mediaEl.videoWidth || 0, h: mediaEl.videoHeight || 0 }
        }
      } catch (_) {}
      bridgeError('[Bridge][download] ELEMENT_FROM_POINT_INVALID', JSON.stringify({
        tileId: tileId,
        tag: clickTarget.tagName,
        mediaSrc: mediaSrc.substring(0, 200),
        mediaCurrentSrc: mediaCurrentSrc.substring(0, 200),
        mediaNatural: mediaNatural,
        rect: { x: Math.round(targetRect.left), y: Math.round(targetRect.top), w: Math.round(targetRect.width), h: Math.round(targetRect.height) },
        visible: !!document.body.contains(mediaEl),
        naturalWidth: mediaNatural.w,
        naturalHeight: mediaNatural.h,
        probeResults: probeResults,
      }))
      // Direct src fallback: if the media src is a Flow API URL
      // (/fx/api/trkc/...) or https URL we can hand it to the background
      // download path. This bypasses the right-click menu entirely so
      // elementFromPoint is no longer a hard requirement.
      var directSrc = ''
      try {
        directSrc = (mediaEl instanceof HTMLImageElement ? (mediaEl.src || mediaEl.currentSrc) : (mediaEl instanceof HTMLVideoElement ? (mediaEl.src || mediaEl.currentSrc) : ''))
      } catch (_) {}
      if (directSrc && (directSrc.startsWith('blob:') || directSrc.startsWith('https://') || directSrc.startsWith('http://') || directSrc.startsWith('/fx/api/'))) {
        bridgeWarn('[Bridge][download] attempting directSrc fallback', JSON.stringify({
          tileId: tileId,
          directSrcPrefix: directSrc.substring(0, 60),
        }))
        // Stash the resolved direct URL via postMessage so flow-content.ts
        // can hand it to the background DOWNLOAD_FILE action. Returning a
        // dedicated error code lets flow-content.ts recognise this and
        // route to the direct path.
        return { success: false, result: { success: false, error: 'direct_src_available', tileId: tileId, directSrc: directSrc, fileName: fileName, promptText: promptText, mediaType: mediaType } }
      }
      return { success: false, result: { success: false, error: 'invalid_media_target', tileId: tileId, tag: clickTarget.tagName, probeResults: probeResults } }
    }

    var cx = chosen.x
    var cy = chosen.y

    bridgeLog('[Bridge][download] Right-clicking target', clickTarget.tagName, cx + ',' + cy, 'via', chosen.name)
    dispatchContextClick(clickTarget, cx, cy)

    // ── Poll for menu ──────────────────────────────────────────────────
    var menuOpened = false
    var menuEl: HTMLElement | null = null
    for (var mi = 0; mi < 25; mi++) {
      await sleep(100)
      var menus = getVisibleMenuContainers()
      if (menus.length > 0) {
        var visibleMenus = menus.filter(function (m) {
          var txt = (m.textContent || '').toLowerCase()
          return !txt.includes('glasp')
        })
        if (visibleMenus.length > 0) {
          menuEl = visibleMenus[0] as HTMLElement
          menuOpened = true
          break
        }
      }
    }
    if (!menuOpened || !menuEl) {
      return { success: false, result: { success: false, error: 'menu_not_found', tileId: tileId } }
    }

    bridgeLog('[Bridge][download] menu opened')

    // ── Find download menu item ────────────────────────────────────────
    var allItems = menuEl.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], button, div[tabindex]')
    var downloadItem: HTMLElement | null = null
    for (var ki = 0; ki < allItems.length; ki++) {
      var item = allItems[ki]
      var itemText = (item.textContent || '').toLowerCase()
      if (itemText.includes('tải xuống') || itemText.includes('download')) {
        downloadItem = item as HTMLElement
        break
      }
    }
    if (!downloadItem) {
      try {
        var itemsDebug = Array.from(allItems).map(function (it: Element) {
          return {
            text: (it.textContent || '').trim().slice(0, 80),
            role: it.getAttribute('role'),
            ariaDisabled: it.getAttribute('aria-disabled'),
            tag: (it as HTMLElement).tagName,
          }
        })
        bridgeWarn('[Bridge][download] menu items available', JSON.stringify({
          tileId: tileId,
          mediaType: mediaType,
          count: itemsDebug.length,
          items: itemsDebug,
        }))
      } catch (_) {}
      // Return fail-attempt so the outer candidate loop tries the next
      // media element. This is the key fix: a single candidate's missing
      // download item must NOT abort the whole tile.
      return { success: false, result: { success: false, error: 'download_item_not_found', tileId: tileId } }
    }

    bridgeLog('[Bridge][download] opening download submenu')
    openDownloadSubmenu(downloadItem, menuEl)
    await sleep(800)

    // ── Wait for resolution submenu ─────────────────────────────────────
    // Flow's Radix submenus open on hover/focus transitions, not on
    // click. After openDownloadSubmenu(), the resolution submenu
    // may not have mounted yet — so we need an explicit wait that:
    // 1) Resolves `downloadItem.getAttribute('aria-controls')` to the
    //    submenu id and checks document.getElementById.
    // 2) Falls back to `getVisibleMenuContainers()` excluding the parent
    //    menu.
    // 3) If still missing, re-dispatches the hover/focus sequence and
    //    fires KeyboardEvent ArrowRight to nudge Radix into opening the
    //    submenu.
    var submenuOpened = false
    var submenuEl: HTMLElement | null = null
    var ariaControlsId = downloadItem.getAttribute('aria-controls')
    if (ariaControlsId) {
      var ariaEl = document.getElementById(ariaControlsId) as HTMLElement | null
      if (ariaEl && ariaEl !== menuEl) {
        submenuEl = ariaEl
        submenuOpened = true
        bridgeLog('[Bridge][download] submenu resolved via aria-controls', JSON.stringify({
          tileId: tileId,
          ariaControlsId: ariaControlsId,
          submenuTag: ariaEl.tagName,
        }))
      }
    }
    if (!submenuOpened || !submenuEl) {
      for (var si = 0; si < 20; si++) {
        await sleep(100)
        // Re-check aria-controls on each poll (Radix may have populated it).
        if (!ariaControlsId) ariaControlsId = downloadItem.getAttribute('aria-controls')
        if (ariaControlsId) {
          var ariaEl2 = document.getElementById(ariaControlsId) as HTMLElement | null
          if (ariaEl2 && ariaEl2 !== menuEl) {
            submenuEl = ariaEl2
            submenuOpened = true
            bridgeLog('[Bridge][download] submenu resolved via aria-controls on poll', JSON.stringify({ tileId: tileId, ariaControlsId: ariaControlsId, pollIndex: si }))
            break
          }
        }
        var allMenus = getVisibleMenuContainers()
        if (allMenus.length > 1) {
          var subCands = allMenus.filter(function (m) { return m !== menuEl })
          if (subCands.length > 0) {
            submenuEl = subCands[0] as HTMLElement
            submenuOpened = true
            bridgeLog('[Bridge][download] submenu resolved via visible-menus fallback', JSON.stringify({ tileId: tileId, pollIndex: si, candidates: subCands.length }))
            break
          }
        }
      }
    }
    if (!submenuOpened || !submenuEl) {
      // Re-dispatch hover/focus + ArrowRight to nudge Radix into opening
      // the submenu. Retry up to 6 times with a 150ms gap.
      for (var hi = 0; hi < 6; hi++) {
        var hRect = downloadItem.getBoundingClientRect()
        var hx = hRect.left + hRect.width / 2
        var hy = hRect.top + hRect.height / 2
        var hInit: MouseEventInit = { view: window, bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: hx, clientY: hy }
        try { downloadItem.dispatchEvent(new PointerEvent('pointerenter', { ...hInit, pointerType: 'mouse' } as PointerEventInit)) } catch (_) {}
        try { downloadItem.dispatchEvent(new MouseEvent('mouseenter', hInit)) } catch (_) {}
        try { downloadItem.dispatchEvent(new PointerEvent('pointermove', { ...hInit, pointerType: 'mouse' } as PointerEventInit)) } catch (_) {}
        downloadItem.dispatchEvent(new MouseEvent('mousemove', hInit))
        try { (downloadItem as HTMLElement).focus({ preventScroll: true }) } catch (_) {}
        // ArrowRight opens Radix submenu when the trigger is focused.
        downloadItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true }))
        downloadItem.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true }))
        await sleep(150)
        // Re-check aria-controls + visible menus after the nudge.
        var nudgeAriaId = downloadItem.getAttribute('aria-controls')
        if (nudgeAriaId) {
          var nudgeEl = document.getElementById(nudgeAriaId) as HTMLElement | null
          if (nudgeEl && nudgeEl !== menuEl) {
            submenuEl = nudgeEl
            submenuOpened = true
            bridgeLog('[Bridge][download] submenu opened after hover+ArrowRight nudge', JSON.stringify({ tileId: tileId, nudgeAttempt: hi + 1, ariaControlsId: nudgeAriaId }))
            break
          }
        }
        var nudgeMenus = getVisibleMenuContainers()
        var nudgeCands = nudgeMenus.filter(function (m) { return m !== menuEl })
        if (nudgeCands.length > 0) {
          submenuEl = nudgeCands[0] as HTMLElement
          submenuOpened = true
          bridgeLog('[Bridge][download] submenu opened after hover+ArrowRight nudge (visible-menus)', JSON.stringify({ tileId: tileId, nudgeAttempt: hi + 1 }))
          break
        }
      }
    }
    if (!submenuOpened || !submenuEl) {
      var resItems = findResolutionItemsInMenu(menuEl as HTMLElement, mediaType, resolution, videoResolution)
      if (resItems.length > 0) {
        submenuEl = menuEl
        submenuOpened = true
        bridgeLog('[Bridge][download] using main menu for resolution items')
      } else {
        bridgeWarn('[Bridge][download] resolution submenu not found after hover+ArrowRight retries', JSON.stringify({
          tileId: tileId,
          ariaControlsId: ariaControlsId,
          downloadItemTag: downloadItem.tagName,
        }))
        return { success: false, result: { success: false, error: 'resolution_submenu_not_found', tileId: tileId } }
      }
    }

    bridgeLog('[Bridge][download] submenu opened, finding resolution')

    var resolutionItems = findResolutionItemsInMenu(submenuEl as HTMLElement, mediaType, resolution, videoResolution)
    var selectedItem: HTMLElement | null = null
    if (resolutionItems.length > 0) {
      selectedItem = resolutionItems.find(function (item) {
        var text = (item.textContent || '').toLowerCase()
        return text.includes(targetResolution.toLowerCase())
      }) || null
      if (!selectedItem) selectedItem = resolutionItems[0]
    }
    if (!selectedItem) {
      bridgeWarn('[Bridge][download] no resolution item found, returning fail-attempt', JSON.stringify({
        tileId: tileId,
        mediaType: mediaType,
        targetResolution: targetResolution,
        submenuTag: submenuEl && (submenuEl as HTMLElement).tagName,
      }))
      // Return fail-attempt so the outer candidate loop falls through to
      // the next media element. A fake success here would have caused
      // the bridge to resolve success with NO resolution clicked — which
      // would have skipped the actual download.
      return { success: false, result: { success: false, error: 'no_resolution_item', tileId: tileId, targetResolution: targetResolution } }
    }

    bridgeLog('[Bridge][download] prepare rename before resolution click')
    // Resolution is clicked ONCE only — this is the ONLY place a download action fires.
    var clickResult = clickResolutionItemOnce(selectedItem, tileId, targetResolution)

    bridgeLog('[Bridge][download] SUCCESS', tileId)
    return {
      success: true,
      result: {
        success: true,
        tileId: tileId,
        method: 'native_menu',
        resolution: targetResolution,
        attemptIndex: opts.attemptIndex,
        totalAttempts: opts.totalAttempts,
        clickMethod: clickResult.clickMethod,
      },
    }
  }

  // (Stale comment removed; the rewrite above is the canonical implementation.)

  function getVisibleMenuContainers(): HTMLElement[] {
    var menus: HTMLElement[] = []
    var containers = document.querySelectorAll('[role="menu"], [aria-label*="menu" i], [data-radix-popper-content]')
    containers.forEach(function (el) {
      var htmlEl = el as HTMLElement
      try {
        var style = window.getComputedStyle(htmlEl)
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
          var rect = htmlEl.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            menus.push(htmlEl)
          }
        }
      } catch (_) {}
    })
    return menus
  }

  function dispatchContextClick(target: HTMLElement, x: number, y: number): void {
    var chain = [
      { type: 'pointerover', x: x, y: y, btn: 0, buttons: 1 },
      { type: 'mouseover', x: x, y: y, btn: 0, buttons: 1 },
      { type: 'pointermove', x: x, y: y, btn: 0, buttons: 1 },
      { type: 'mousemove', x: x, y: y, btn: 0, buttons: 1 },
      { type: 'pointerdown', x: x, y: y, btn: 2, buttons: 2 },
      { type: 'mousedown', x: x, y: y, btn: 2, buttons: 2 },
      { type: 'pointerup', x: x, y: y, btn: 2, buttons: 0 },
      { type: 'mouseup', x: x, y: y, btn: 2, buttons: 0 },
      { type: 'contextmenu', x: x, y: y, btn: 2, buttons: 0 },
    ]
    for (var ci = 0; ci < chain.length; ci++) {
      var ev = chain[ci]
      var init: MouseEventInit = {
        view: window,
        bubbles: true,
        cancelable: true,
        button: ev.btn,
        buttons: ev.buttons,
        clientX: ev.x,
        clientY: ev.y,
      }
      var event = new MouseEvent(ev.type, init)
      target.dispatchEvent(event)
    }
    // Extra events for Flow's listener
    target.dispatchEvent(new MouseEvent('mousedown', { view: window, bubbles: true, cancelable: true, button: 2, buttons: 2 }))
    target.dispatchEvent(new MouseEvent('mouseup', { view: window, bubbles: true, cancelable: true, button: 2, buttons: 0 }))
    target.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true, button: 2, buttons: 0 }))
  }

  function safeClickElement(el: HTMLElement): void {
    try {
      el.click()
    } catch (_) {
      el.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true, button: 0, buttons: 1 }))
    }
  }

  // Opens the download submenu by dispatching pointer/keyboard events only.
  // This intentionally does NOT fire mousedown/mouseup/click on the parent
  // menu item — clicking it would trigger a download at the default resolution.
  // Radix submenus open on hover/focus transitions or ArrowRight when focused.
  function openDownloadSubmenu(downloadItem: HTMLElement, menuEl: HTMLElement): { success: boolean; submenuEl?: HTMLElement | null; submenuOpened?: boolean } {
    // (Log "[Bridge][download] opening download submenu" is emitted by the caller.)
    // Step through the open sequence. Each nudge is independent — if one
    // dispatches the aria-controls attribute, the caller will resolve via it.
    var nudgeSequence = [
      // pointerover
      function () { try { downloadItem.dispatchEvent(new PointerEvent('pointerover', { view: window, bubbles: true, cancelable: true, button: 0, buttons: 1 })) } catch (_) {} },
      // pointerenter
      function () { try { downloadItem.dispatchEvent(new PointerEvent('pointerenter', { view: window, bubbles: false, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse' })) } catch (_) {} },
      // pointermove
      function () { try { downloadItem.dispatchEvent(new PointerEvent('pointermove', { view: window, bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse' })) } catch (_) {} },
      // mouseover
      function () { try { downloadItem.dispatchEvent(new MouseEvent('mouseover', { view: window, bubbles: true, cancelable: true, button: 0, buttons: 1 })) } catch (_) {} },
      // mouseenter
      function () { try { downloadItem.dispatchEvent(new MouseEvent('mouseenter', { view: window, bubbles: false, cancelable: true, button: 0, buttons: 1 })) } catch (_) {} },
      // mousemove
      function () { downloadItem.dispatchEvent(new MouseEvent('mousemove', { view: window, bubbles: true, cancelable: true, button: 0, buttons: 1 })) },
      // focus
      function () { try { (downloadItem as HTMLElement).focus({ preventScroll: true }) } catch (_) {} },
      // ArrowRight opens Radix submenu when the trigger is focused.
      function () { downloadItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true })) },
      function () { downloadItem.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true })) },
    ]
    for (var ni = 0; ni < nudgeSequence.length; ni++) {
      nudgeSequence[ni]()
    }
    // Check aria-controls immediately after the sequence.
    var ariaControlsId = downloadItem.getAttribute('aria-controls')
    if (ariaControlsId) {
      var ariaEl = document.getElementById(ariaControlsId) as HTMLElement | null
      if (ariaEl && ariaEl !== menuEl) {
        return { success: true, submenuEl: ariaEl, submenuOpened: true }
      }
    }
    // aria-controls not yet populated — the caller will poll.
    return { success: true, submenuEl: null, submenuOpened: false }
  }

  // Radix-safe click: dispatches the full hover/pointer/focus sequence
  // before the synthetic click. Flow's menus are built on Radix, and
  // Radix submenu items require hover/focus transitions to open their
  // submenu. A bare `el.click()` skips those transitions and either
  // closes the parent menu or fires no action.
  function safeRadixClick(el: HTMLElement): void {
    try {
      var rect = el.getBoundingClientRect()
      var cx = rect.left + rect.width / 2
      var cy = rect.top + rect.height / 2
      var common: MouseEventInit = {
        view: window, bubbles: true, cancelable: true, button: 0, buttons: 1,
        clientX: cx, clientY: cy,
      }
      // 1) pointerover + mouseover (Radix listens on both)
      try { el.dispatchEvent(new PointerEvent('pointerover', { ...common, pointerType: 'mouse' })) } catch (_) {}
      el.dispatchEvent(new MouseEvent('mouseover', common))
      // 2) pointerenter + mouseenter (non-bubbling — fire if supported)
      try { el.dispatchEvent(new PointerEvent('pointerenter', { ...common, pointerType: 'mouse' })) } catch (_) {}
      try { el.dispatchEvent(new MouseEvent('mouseenter', common)) } catch (_) {}
      // 3) pointermove + mousemove
      try { el.dispatchEvent(new PointerEvent('pointermove', { ...common, pointerType: 'mouse' })) } catch (_) {}
      el.dispatchEvent(new MouseEvent('mousemove', common))
      // 4) focus
      try { (el as HTMLElement).focus({ preventScroll: true }) } catch (_) {}
      // 5) pointerdown + mousedown
      try { el.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerType: 'mouse' })) } catch (_) {}
      el.dispatchEvent(new MouseEvent('mousedown', common))
      // 6) pointerup + mouseup + click
      try { el.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerType: 'mouse' })) } catch (_) {}
      el.dispatchEvent(new MouseEvent('mouseup', common))
      el.dispatchEvent(new MouseEvent('click', common))
      // 7) native click as a final fallback
      try { el.click() } catch (_) {}
    } catch (e) {
      bridgeWarn('[Bridge][download] safeRadixClick threw, falling back to safeClickElement', String((e as Error)?.message || 'unknown'))
      safeClickElement(el)
    }
  }

  // Clicks a resolution menu item exactly once. This is the ONLY place a
  // download action is dispatched. Never fires pointerdown+click combo or
  // retries. Returns immediately after the single click dispatch.
  function clickResolutionItemOnce(itemEl: HTMLElement, tileId: string, resolution: string): { success: boolean; clickMethod: string; skippedDuplicateClick: boolean } {
    var key = tileId + ':' + resolution
    if (clickedResolutionTokens.has(key)) {
      bridgeLog('[Bridge][download] resolution click skipped duplicate', JSON.stringify({ tileId: tileId, resolution: resolution, key: key }))
      return { success: true, clickMethod: 'duplicate_guard', skippedDuplicateClick: true }
    }
    clickedResolutionTokens.add(key)
    bridgeLog('[Bridge][download] clicking resolution item ONCE:', resolution, JSON.stringify({ tileId: tileId, resolution: resolution }))
    try {
      itemEl.click()
      bridgeLog('[Bridge][download] resolution click fired once clickMethod=native tileId=' + tileId + ' resolution=' + resolution)
      return { success: true, clickMethod: 'native', skippedDuplicateClick: false }
    } catch (e) {
      itemEl.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true, button: 0, buttons: 1 }))
      bridgeLog('[Bridge][download] resolution click fired once clickMethod=mouseevent tileId=' + tileId + ' resolution=' + resolution)
      return { success: true, clickMethod: 'mouseevent', skippedDuplicateClick: false }
    }
  }

  function findResolutionItemsInMenu(
    menuEl: HTMLElement,
    mediaType: string,
    imageRes: string,
    videoRes: string
  ): HTMLElement[] {
    var allItems = menuEl.querySelectorAll('[role="menuitem"], [role="menuitemradio"], button, div[tabindex]')
    var results: HTMLElement[] = []
    var imageResList = ['4k', '2k', '1k']
    var videoResList = ['1080p', '720p', '4k']

    for (var ri = 0; ri < allItems.length; ri++) {
      var item = allItems[ri]
      var text = (item.textContent || '').toLowerCase()

      // Match image resolution patterns
      if (mediaType === 'image') {
        if (text.includes('4k') || text.includes('2k') || text.includes('1k') ||
          text.includes('4096') || text.includes('2048') || text.includes('1024') ||
          text.includes('ultra')) {
          results.push(item as HTMLElement)
        }
      } else {
        // Video
        if (text.includes('1080p') || text.includes('720p') || text.includes('hd') || text.includes('full hd')) {
          results.push(item as HTMLElement)
        }
      }
    }
    return results
  }

  // ═══════════════════════════════════════════════════════════════
  // GLOBAL TEST HELPERS
  // ═══════════════════════════════════════════════════════════════

  ;(window as Record<string, unknown>).__flowDebugScan = function () {
    var report = scanDOMReport()
    bridgeLog('=== __flowDebugScan ===')
    bridgeLog('URL:', report.url)
    var el = (report.foundElement as Record<string, unknown>)
    if (el) {
      bridgeDebug('Editor found:', el.tag, 'role=' + el.role, 'contenteditable=' + el['contenteditable'], 'data-slate-editor=' + el['data-slate-editor'])
      bridgeDebug('  class:', (el.className as string).substring(0, 100))
      bridgeDebug('  text:', (el.textContent as string).substring(0, 80))
      bridgeDebug('  reactFiberKeys:', el.reactFiberKeys)
      bridgeDebug('  outerHTML:', (el.outerHTML as string).substring(0, 200))
    } else {
      bridgeDebug('Editor NOT FOUND')
    }
    var scanResults = report.scanResults as EditorCandidate[]
    if (scanResults && scanResults.length > 0) {
      bridgeDebug('Scan results (' + scanResults.length + ' candidates):')
      scanResults.slice(0, 5).forEach(function (r, i) {
        bridgeDebug('  [' + i + '] score=' + r.score + ' path=' + r.path + ' depth=' + r.depth)
        bridgeDebug('       keys=[' + r.keys.slice(0, 20).join(', ') + ']')
        bridgeDebug('       hasInsert=' + r.hasInsertText + ' hasApply=' + r.hasApply + ' hasChildren=' + r.hasChildren)
      })
    }
    var buttons = report.buttons as Record<string, unknown>[]
    bridgeDebug('Buttons (' + buttons.length + '):')
    buttons.slice(0, 15).forEach(function (b, i) {
      bridgeDebug('  [' + i + '] ' + b.tag + ' text="' + b.text + '" dt=' + b['data-testid'] + ' disabled=' + b.disabled + ' bottomDist=' + ((b.rect as Record<string, number>) ? (b.rect as Record<string, number>).bottomDist : '?'))
    })
    bridgeDebug('=== END ===')
    return report
  }

  ;(window as Record<string, unknown>).__flowTestInsert = function (text?: string) {
    var t = text || 'FLOW TEST PROMPT'
    bridgeDebug('[Bridge] __flowTestInsert("' + t + '")')
    var result = insertText(t)
    bridgeDebug('[Bridge] __flowTestInsert result:', JSON.stringify(result, null, 2))
    return result
  }

  ;(window as Record<string, unknown>).__flowTestClear = function () {
    bridgeDebug('[Bridge] __flowTestClear()')
    return clearEditor()
  }

  ;(window as Record<string, unknown>).__flowTestVerify = function () {
    bridgeDebug('[Bridge] __flowTestVerify()')
    return verifyEditor()
  }

  ;(window as Record<string, unknown>).__flowTestSubmit = function () {
    return { success: false, method: null, buttonText: '', error: 'FLOW_ADMISSION_REQUIRED' }
  }

  // Manual test helper for the DOM-first Google Flow submit path.
  // Usage from the Flow page console:
  //   window.__flowTestSubmitGoogleFlow('rô bot chiến đấu')
  ;(window as Record<string, unknown>).__flowTestSubmitGoogleFlow = async function (text?: string) {
    return { ok: false, reason: 'FLOW_ADMISSION_REQUIRED', promptLength: (text || '').length }
  }

  bridgeLog('[Bridge] Flow Slate Bridge loaded (MAIN world, deepScan + DOM fallback + submit + tileMonitor)')
})()
