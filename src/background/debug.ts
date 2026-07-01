// DEBUG — chạy trực tiếp trong service worker console
// Thay vì chrome.runtime.sendMessage, gọi:
// debugPingFlowTab().then(r => console.log(r))
// Hoặc test trong content script page:
// window.postMessage({ source: 'flow-auto-slate', action: 'verify' }, '*')
