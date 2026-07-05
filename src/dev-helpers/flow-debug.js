// flow-debug.js — chạy trong DevTools console CỦA TAB FLOW
// Copy toàn bộ code này và paste vào console của tab Flow.
//
// This file lives in src/dev-helpers/ (NOT src/contents/) so Plasmo does
// NOT auto-package it as a content script. Do NOT move it back into
// src/contents/ — if it ends up injected automatically, it will compete
// with the real flow-slate-bridge on the `flow-auto-slate` postMessage
// channel and cause double-insert / response race bugs.
//
// If this file is ever loaded as a content script by mistake, it must
// no-op immediately — that guard is the very first thing in the IIFE.

// Guard against accidental content-script injection: only run if
// the script is invoked manually from devtools console.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && document.documentElement.hasAttribute('data-flow-bridge-real-installed')) {
  // Real bridge has already loaded. Do nothing.
} else if (typeof window === 'undefined' || (window.__FLOW_BRIDGE_BUILD_TIME__ && document.documentElement.hasAttribute('data-flow-bridge-real-installed'))) {
  // Real bridge is present. Do nothing.
} else {

(function () {
  const SOURCE = 'flow-auto-slate'
  const RESULT_SOURCE = SOURCE + '-result'
  let _reqId = 0
  const _pending = {}

  window.addEventListener('message', function (e) {
    if (e.source !== window) return
    var d = e.data
    if (!d || !d.source || !d.source.startsWith(RESULT_SOURCE)) return
    var rid = d.requestId
    if (rid != null && _pending[rid]) {
      _pending[rid](d)
      delete _pending[rid]
    }
  })

  function bridgeCall(action, data) {
    data = data || {}
    return new Promise(function (resolve) {
      var id = ++_reqId
      _pending[id] = resolve
      window.postMessage({ source: SOURCE, action: action, requestId: id }, '*')
      setTimeout(function () {
        if (_pending[id]) {
          delete _pending[id]
          resolve({ success: false, error: 'timeout 5s' })
        }
      }, 5000)
    })
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms) })
  }

  function findFiber(el) {
    var fiberKey = null
    for (var k in el) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
        fiberKey = k; break
      }
    }
    return fiberKey ? el[fiberKey] : null
  }

  function findEditorInFiber(fiber) {
    var depth = 0
    while (fiber && depth < 60) {
      var state = fiber.memoizedState
      while (state) {
        var ms = state.memoizedState
        if (ms && typeof ms === 'object') {
          if (ms.children && ms.insertText && ms.apply) return ms
          if (ms.current && ms.current.children && ms.current.apply) return ms.current
        }
        state = state.next
      }
      fiber = fiber.return
      depth++
    }
    return null
  }

  function getAllText(node) {
    if (node.text !== undefined) return node.text
    if (node.children) return node.children.map(getAllText).join('')
    return ''
  }

  // === REPORT ===
  var slateEl = document.querySelector('[data-slate-editor="true"]')
  var fiber = slateEl ? findFiber(slateEl) : null
  var editor = fiber ? findEditorInFiber(fiber) : null

  console.log('=== FLOW DEBUG REPORT ===')
  console.log('URL:', window.location.href)
  console.log('Bridge loaded:', !!(window.__flowSlateBridgeCleanup))
  console.log('Slate editor:', slateEl ? 'FOUND' : 'NOT FOUND')
  console.log('Fiber key:', fiber ? 'FOUND (depth=' + (function(){
    var d=0, f=fiber
    while(f && d<10){f=f.return;d++} return d
  })() + ')' : 'NOT FOUND')
  console.log('Editor model:', editor ? 'FOUND (children=' + editor.children.length + ')' : 'NOT FOUND')

  var modelText = editor ? getAllText({children: editor.children}) : ''
  console.log('Model text preview:', modelText.substring(0, 80).replace(/\n/g, ' '))

  var placeholderEl = slateEl ? slateEl.querySelector('[data-slate-placeholder]') : null
  console.log('Placeholder visible:', placeholderEl ? 'YES (' + placeholderEl.textContent + ')' : 'NO')

  var btns = Array.from(document.querySelectorAll('button'))
  console.log('Total buttons:', btns.length)
  btns.slice(0, 20).forEach(function (b, i) {
    var txt = (b.textContent || '').trim().substring(0, 40)
    var dt = b.getAttribute('data-testid') || ''
    var dis = b.disabled
    console.log('  B[' + i + '] ' + txt + ' | dt=' + dt + ' | dis=' + dis)
  })

  console.log('=== BRIDGE CALLS ===')

  bridgeCall('verify').then(function (r) {
    console.log('verify result:', JSON.stringify(r, null, 2))
    console.log('=== DONE ===')
  })
})()

} // end guard against accidental content-script injection
