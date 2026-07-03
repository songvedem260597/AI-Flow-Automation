/**
 * Extension context guard.
 *
 * After chrome.runtime.reload() (or after the extension is reloaded from
 * chrome://extensions), existing content scripts continue running with the
 * previous bundle. Any subsequent call to chrome.runtime.sendMessage /
 * chrome.runtime.connect / chrome.storage.* may throw:
 *
 *   Uncaught Error: Extension context invalidated.
 *
 * Once that happens the extension context is gone for the lifetime of the
 * page — the only remedy is reloading the tab. Until the user does so we
 * must stop touching chrome.* and stop polling/observing so we don't spam
 * the console with the same error.
 */

// Chrome error message thrown when the context is gone.
export const CONTEXT_INVALIDATED_MSG = 'Extension context invalidated'

/**
 * Returns true if any error in the chain is an "Extension context
 * invalidated" error. Safe to call with anything.
 */
export function isContextInvalidated(err: unknown): boolean {
  if (!err) return false
  if (typeof err === 'string') return err.includes(CONTEXT_INVALIDATED_MSG)
  if (err instanceof Error) return err.message.includes(CONTEXT_INVALIDATED_MSG)
  const msg = (err as { message?: string })?.message
  if (typeof msg === 'string') return msg.includes(CONTEXT_INVALIDATED_MSG)
  return false
}

/**
 * Returns true if the extension context for this content script is still
 * alive. Cross-references chrome.runtime.id (gone after invalidation) and
 * `chrome.runtime.connect` (one-shot probe — no message is sent).
 *
 * The connect probe is wrapped in try/catch and disconnected immediately so
 * no real port is held open. It exists because some Chrome builds clear
 * `chrome.runtime.id` lazily during page tears — the connect probe is a
 * fast, deterministic way to know "the next sendMessage will throw".
 */
export function hasExtensionContext(): boolean {
  try {
    if (!chrome?.runtime?.id) return false
    if (typeof chrome.runtime.connect !== 'function') return false
    const port = chrome.runtime.connect({ name: '__ai_flow_ctx_probe__' })
    try { port.disconnect() } catch {}
    return true
  } catch (err) {
    if (isContextInvalidated(err)) return false
    // Any other probe failure: assume context might still be alive.
    return Boolean(chrome?.runtime?.id)
  }
}

export type SafeSendResult =
  | { ok: true; response: unknown }
  | { ok: false; error: 'context_invalidated' }
  | { ok: false; error: string }

/**
 * Safe wrapper around `chrome.runtime.sendMessage` that:
 *   - swallows exceptions from a dead extension context
 *   - never resolves with a thrown error
 *   - tags errors as `'context_invalidated'` when the context is gone so
 *     callers can stop polling/observing instead of retrying forever
 *
 * Returns `{ ok: false, error: 'context_invalidated' }` when the context
 * is invalid. Other errors are stringified into `error`. The original
 * response (when one is received) is returned as-is on `response`.
 */
export function safeSendMessage(message: unknown): Promise<SafeSendResult> {
  return new Promise((resolve) => {
    // Probe first to skip the noisy thrown error path.
    if (!hasExtensionContext()) {
      resolve({ ok: false, error: 'context_invalidated' })
      return
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError
        if (err) {
          if (isContextInvalidated(err.message)) {
            resolve({ ok: false, error: 'context_invalidated' })
          } else {
            resolve({ ok: false, error: err.message || 'sendMessage error' })
          }
          return
        }
        resolve({ ok: true, response })
      })
    } catch (err) {
      if (isContextInvalidated(err)) {
        resolve({ ok: false, error: 'context_invalidated' })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        resolve({ ok: false, error: msg })
      }
    }
  })
}

/**
 * Fire-and-forget send. Returns nothing. Used for status notifications
 * where we don't care about the response but must not throw.
 */
export function safeSendMessageNoReply(message: unknown): void {
  try {
    if (!hasExtensionContext()) return
    chrome.runtime.sendMessage(message, () => {
      // Drain lastError so Chrome doesn't log a noisy "Unchecked runtime.error".
      const err = chrome.runtime.lastError
      if (err && isContextInvalidated(err.message)) {
        // Propagate as a silent no-op by removing any listeners the page
        // holds. We can't reach into call sites here — callers are
        // expected to call this from safe places.
      }
    })
  } catch {
    // Silently swallow — guaranteed safe path.
  }
}

/**
 * Safe wrapper around `chrome.storage.local.get` (and friends) that
 * returns `null` when the extension context is gone.
 */
export function safeStorageGet<T = unknown>(
  area: 'local' | 'session' | 'sync' = 'local',
  key: string | string[] | null
): Promise<T | null> {
  return new Promise((resolve) => {
    if (!hasExtensionContext()) {
      resolve(null)
      return
    }
    try {
      const store = chrome.storage?.[area]
      if (!store || typeof store.get !== 'function') {
        resolve(null)
        return
      }
      store.get(key as string | string[] | object | null | undefined, (result: Record<string, unknown>) => {
        const err = chrome.runtime.lastError
        if (err) {
          resolve(null)
          return
        }
        resolve((result || null) as unknown as T)
      })
    } catch {
      resolve(null)
    }
  })
}

/**
 * Safe wrapper around `chrome.storage.local.set` (and friends) that
 * silently returns when the extension context is gone.
 */
export function safeStorageSet(
  area: 'local' | 'session' | 'sync',
  payload: Record<string, unknown>
): void {
  try {
    if (!hasExtensionContext()) return
    const store = chrome.storage?.[area]
    if (!store || typeof store.set !== 'function') return
    store.set(payload, () => {
      // Drain lastError.
      void chrome.runtime.lastError
    })
  } catch {
    // Silently swallow.
  }
}
