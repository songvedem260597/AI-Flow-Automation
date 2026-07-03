// ── Centralised debug flag store ─────────────────────────────────────────
//
// All verbose console.log/console.warn calls in the extension route
// through `debugLog` / `debugWarn`. Flags are read from localStorage
// at module-evaluation time so the very first log call already sees
// the latest value.
//
// Default behaviour: every flag is `false`. Console stays quiet.
//
// Enable individual flags from the side-panel DevTools console (or
// any extension page with access to localStorage):
//
//   localStorage.setItem('AI_FLOW_DEBUG_NODE_STATE',   '1')  // [NodeStateDebug]
//   localStorage.setItem('AI_FLOW_DEBUG_GLOW',         '1')  // [GlowDebug]
//   localStorage.setItem('AI_FLOW_DEBUG_EDGE_FLOW',    '1')  // [EdgeFlowDebug]
//   localStorage.setItem('AI_FLOW_DEBUG_SCHEDULER',    '1')  // [SchedulerDebug]
//   localStorage.setItem('AI_FLOW_DEBUG_SEQ',          '1')  // [SeqDebug]
//   localStorage.setItem('AI_FLOW_DEBUG_CHATGPT_HB',   '1')  // ChatGPT heartbeat
//   localStorage.setItem('AI_FLOW_DEBUG_RUNNER_WAIT',  '1')  // Runner wait loop
//
// Master switch — set this to enable ALL flags at once:
//
//   localStorage.setItem('AI_FLOW_DEBUG', '1')
//
// To turn everything back off:
//
//   localStorage.removeItem('AI_FLOW_DEBUG')
//   for (const k of [...localStorage.keys()].filter(k => k.startsWith('AI_FLOW_DEBUG_'))) localStorage.removeItem(k)

type Flag = boolean

interface DebugFlags {
  nodeState: Flag
  glow: Flag
  edgeFlow: Flag
  scheduler: Flag
  seq: Flag
  chatgptHeartbeat: Flag
  runnerWait: Flag
}

// Read a single localStorage key safely. localStorage may not exist
// in service-worker contexts or in environments where storage APIs
// are blocked; return `false` in those cases.
function readFlag(key: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    if (localStorage.getItem(key) === '1') return true
  } catch {
    // SecurityError, etc — fall through
  }
  return false
}

function readDebugFlags(): DebugFlags {
  const master = readFlag('AI_FLOW_DEBUG')
  return {
    nodeState:      master || readFlag('AI_FLOW_DEBUG_NODE_STATE'),
    glow:           master || readFlag('AI_FLOW_DEBUG_GLOW'),
    edgeFlow:       master || readFlag('AI_FLOW_DEBUG_EDGE_FLOW'),
    scheduler:      master || readFlag('AI_FLOW_DEBUG_SCHEDULER'),
    seq:            master || readFlag('AI_FLOW_DEBUG_SEQ'),
    chatgptHeartbeat: master || readFlag('AI_FLOW_DEBUG_CHATGPT_HB'),
    runnerWait:     master || readFlag('AI_FLOW_DEBUG_RUNNER_WAIT'),
  }
}

export const DEBUG_FLAGS: DebugFlags = readDebugFlags()

// Convenience re-read — used by the heartbeat throttler when the
// operator flips a flag mid-run and wants immediate effect.
export function refreshDebugFlags(): DebugFlags {
  const fresh = readDebugFlags()
  DEBUG_FLAGS.nodeState = fresh.nodeState
  DEBUG_FLAGS.glow = fresh.glow
  DEBUG_FLAGS.edgeFlow = fresh.edgeFlow
  DEBUG_FLAGS.scheduler = fresh.scheduler
  DEBUG_FLAGS.seq = fresh.seq
  DEBUG_FLAGS.chatgptHeartbeat = fresh.chatgptHeartbeat
  DEBUG_FLAGS.runnerWait = fresh.runnerWait
  return DEBUG_FLAGS
}

// Forward-console methods. Console.error / console.warn for real
// failures should NOT route through here — call them directly so
// they stay visible at all times.
export type DebugFlag = keyof DebugFlags

export function debugLog(flag: DebugFlag, ...args: unknown[]): void {
  if (DEBUG_FLAGS[flag]) {
    // Use console.log directly (NOT console.debug) so the message
    // shows up in default-sidepanel/extension-page consoles without
    // requiring "Verbose" filter level.
    // eslint-disable-next-line no-console
    console.log(...args)
  }
}

export function debugWarn(flag: DebugFlag, ...args: unknown[]): void {
  if (DEBUG_FLAGS[flag]) {
    // eslint-disable-next-line no-console
    console.warn(...args)
  }
}