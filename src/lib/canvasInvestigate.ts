// Investigation-only flag store.
// NOT a debug log in the AI_FLOW_DEBUG family — this is a
// temporary probe only enabled while diagnosing the canvas
// drag-flicker bug. Remove after the investigation is closed.
//
// Enable (default off):
//   localStorage.setItem('AI_FLOW_DEBUG_CANVAS_INVESTIGATE', '1')
//   localStorage.removeItem('AI_FLOW_DEBUG_CANVAS_INVESTIGATE')
//
// Master switch 'AI_FLOW_DEBUG' does NOT auto-fan this — kept
// independent so it does not pollute every other debug-gated site.

export const CANVAS_INVESTIGATE_FLAG = 'AI_FLOW_DEBUG_CANVAS_INVESTIGATE'

export function canvasInvestigateEnabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(CANVAS_INVESTIGATE_FLAG) === '1'
    }
  } catch (_) {
    // localStorage may be unavailable (e.g. SW); default off.
  }
  return false
}

export function canvasLog(event: string, payload: Record<string, unknown>): void {
  if (!canvasInvestigateEnabled()) return
  try {
    console.log('[CanvasInvestigate][' + event + '] ' + JSON.stringify(payload))
  } catch (_) {
    // ignore JSON.stringify failures (circular refs etc.)
  }
}
