// Chạy trong DevTools console CỦA TAB FLOW (không phải service worker)
const SOURCE = 'flow-auto-slate'
const RESULT_SOURCE = SOURCE + '-result'
let _reqId = 0
const _pending = {}

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data?.source?.startsWith(RESULT_SOURCE)) return
  const { requestId, ...rest } = e.data
  if (_pending[requestId]) { _pending[requestId](rest); delete _pending[requestId] }
})

function bridgeCall(action, data = {}) {
  return new Promise((resolve) => {
    const id = ++_reqId
    _pending[id] = resolve
    window.postMessage({ source: SOURCE, action, requestId: id, ...data }, '*')
    setTimeout(() => { if (_pending[id]) { delete _pending[id]; resolve({ success: false, error: 'timeout' }) } }, 8000)
  })
}

async function testBridge() {
  console.log('--- Bridge Test ---')
  console.log('window.__flowSlateBridgeCleanup:', !!window.__flowSlateBridgeCleanup)

  const editor = document.querySelector('[data-slate-editor="true"]')
  console.log('Slate editor:', editor ? 'FOUND' : 'NOT FOUND')
  console.log('URL:', window.location.href)

  const btns = [...document.querySelectorAll('button')]
  console.log('Buttons count:', btns.length)
  btns.forEach((b, i) => console.log(`  [${i}] ${b.textContent?.trim().substring(0, 40)} | ${b.getAttribute('data-testid') || 'no-dt'} | disabled=${b.disabled}`))

  const result = await bridgeCall('verify')
  console.log('verify:', result)

  if (editor) {
    const fiberKey = Object.keys(editor).find(k => k.startsWith('__react'))
    console.log('Fiber key:', fiberKey)
    const fiber = fiberKey ? editor[fiberKey] : null
    let depth = 0, f = fiber
    while (f && depth < 10) {
      const state = f.memoizedState
      if (state?.memoizedState) {
        const ms = state.memoizedState
        if (ms?.children || ms?.insertText || ms?.apply) {
          console.log('Editor at depth', depth, ':', { children: ms.children?.length, hasInsertText: !!ms.insertText, hasApply: !!ms.apply })
        }
      }
      f = f.return; depth++
    }
  }

  console.log('--- End ---')
}

testBridge()
