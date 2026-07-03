# CLAUDE.md — AI Flow Automation

## Project Overview

This project is a Chrome Extension for automating AI generation on Google Flow (Veo / Imagen).
Core automation manipulates the Google Flow UI via:

- Content Scripts (ISOLATED world)
- MAIN World Bridge (via `chrome.scripting.executeScript`)
- React Fiber traversal
- Slate editor manipulation
- Cross-context messaging

Reliability is more important than code elegance. Google Flow changes frequently — the goal is reliable automation with clear debugging and safe fallbacks.

## Karpathy-Inspired Coding Agent Rules — Stable

These rules are adapted for this project from the behavior principles in `multica-ai/andrej-karpathy-skills`.

The goal is to prevent AI coding agents from making broad, speculative, or unverified changes.

### 1. Think Before Coding

Before editing any file, inspect the current implementation and identify the actual root cause.

Do not guess selectors, payload fields, message actions, state names, or runtime behavior.

For every non-trivial change, first determine:

- Which file owns the behavior.
- Which function owns the behavior.
- What the current data flow is.
- What evidence proves the bug or missing behavior.
- Whether the issue is UI state, background routing, content script orchestration, bridge behavior, or Flow DOM drift.

Never start by rewriting code.

### 2. Simplicity First

Prefer the smallest reliable fix.

Do not add new abstraction, global state, config layer, queue system, retry system, or fallback path unless the current task explicitly requires it.

For this project, reliability is more important than elegance, but reliability does not mean adding unnecessary complexity.

Use the existing architecture:

- GenPanel owns UI state and multi-prompt orchestration.
- background/index.ts owns service worker routing.
- flow-content.ts owns isolated-world orchestration.
- flow-slate-bridge.ts owns MAIN-world Flow DOM / React Fiber interaction.
- ChatGPT automation must stay separate from Flow automation.

Do not move responsibilities between layers unless explicitly requested.

### 3. Surgical Changes

Make precise edits only where needed.

Rules:

- Do not rewrite `flow-slate-bridge.ts` unless explicitly required.
- Do not delete fallback logic, retries, guards, or verification unless there is clear evidence they are obsolete.
- Do not touch ChatGPT files when fixing Flow behavior.
- Do not touch Flow files when fixing ChatGPT behavior.
- Do not change payload contracts unless all call sites are inspected and updated.
- Do not rename actions, fields, or functions casually.
- Do not introduce breaking changes to `RUN_FLOW_PROMPT`, `FLOW_UPLOAD_IMAGE`, `CHATGPT_SUBMIT_AND_WAIT`, or download pipeline contracts.

When editing, preserve existing behavior outside the target bug or feature.

### 4. Goal-Driven Execution

Every change must map directly to the user's requested goal.

Do not opportunistically refactor.
Do not clean unrelated code.
Do not improve style while fixing runtime behavior.
Do not change logs unless the task is about logging.
Do not change UI unless the task is about UI.

Before finishing, verify that the implemented change actually addresses the original request.

Build passing is not runtime verification.

For Flow runtime changes, runtime verification still requires:

- Reload unpacked extension in `chrome://extensions`.
- Hard reload Google Flow tab.
- Check `window.__FLOW_BRIDGE_BUILD_TIME__`.
- Run the affected browser flow.
- Confirm expected logs and behavior.

### 5. Anti-Assumption Rule

If the code does not prove something, do not treat it as true.

Bad behavior examples:

- Assuming Flow generated a tile just because submit was clicked.
- Assuming a reference image is attached without verifying attach count or prompt state.
- Assuming `upload_xxx` is valid inside the bridge.
- Assuming build success means browser runtime success.
- Assuming a selector still works because it worked before.
- Assuming partial auto-download is a hard failure.

When uncertain, inspect, log minimally, or return a clear diagnostic.

### 6. Required Agent Behavior

For each task, the coding agent must:

1. Inspect relevant files first.
2. State the root cause before editing if it is a bug fix.
3. Modify the smallest possible code surface.
4. Preserve stable rules already documented in CLAUDE.md.
5. Run `npm run build` only when source code changes.
6. For documentation-only edits, report that build was not run because no runtime source changed.
7. Provide the required completion report already defined in this CLAUDE.md.

### 7. Do Not Regress

Do not regress any existing stable behavior, especially:

- Reference image upload resolution before `RUN_FLOW_PROMPT`.
- `upload_xxx` defensive gates.
- Flow bridge build time verification.
- Multi-prompt queue ownership in GenPanel.
- Auto-download partial success handling.
- Duplicate download guards.
- Separate Flow and ChatGPT automation paths.
- Debug logs staying behind debug flags.
- Runtime verification requirements.

## Tech Stack

- **Plasmo** Framework (Chrome Extension SDK, v0.90.5)
- **React** 18 + **TypeScript**
- **Tailwind CSS** v3
- **Drawflow** canvas editor — for the Workflow Editor
- **Zustand** v4 / v5 (State Management)
- **Framer Motion** (Animations)
- **lucide-react** (Icons)
- **Chrome Extension APIs** — Side Panel, scripting, tabs, downloads
- **Manifest V3**

## Key Commands

```bash
npm run dev      # Development: prebuild + plasmo dev (hot reload)
npm run build    # Production build: prebuild + plasmo build + postbuild
npm run package  # Package: prebuild + plasmo package + postbuild
```

After `npm run build`, the output is in `build/chrome-mv3-prod/`.

## Project Structure

```
ai-workflow-automation/
├── src/
│   ├── components/
│   │   ├── gen/GenPanel.tsx          # Google Flow Gen tab UI
│   │   ├── layout/TopNavigation.tsx   # Nav tabs
│   │   ├── workflow/WorkflowEditor.tsx # Workflow hub + Drawflow editor
│   │   ├── pipeline/PipelineProgress.tsx
│   │   ├── prompt/PromptManager.tsx
│   │   ├── queue/TaskQueue.tsx
│   │   ├── history/HistoryPanel.tsx
│   │   ├── presets/PresetsPanel.tsx
│   │   ├── settings/SettingsPanel.tsx
│   │   └── SidePanel.tsx              # Main container
│   ├── contents/
│   │   ├── flow-content.ts            # Flow content script (ISOLATED world)
│   │   ├── flow-slate-bridge.ts       # Flow bridge (MAIN world, critical)
│   │   ├── chatgpt-content.ts         # ChatGPT content script (ISOLATED world)
│   │   └── chatgpt-bridge.ts          # ChatGPT bridge (MAIN world)
│   ├── background/
│   │   ├── index.ts                   # Service worker, message routing
│   │   └── debug.ts
│   ├── stores/                        # Zustand stores
│   ├── providers/                     # AI provider adapters
│   ├── pipeline/runner.ts             # Sequential pipeline runner
│   ├── types/index.ts
│   ├── constants/index.ts
│   ├── lib/utils.ts
│   ├── sidepanel.tsx                  # Side Panel entry (Plasmo)
│   └── style.css                      # Global styles + Tailwind
├── content-scripts/content-script.ts   # Generic content script
├── assets/                            # Icon PNGs
├── plasmo.config.ts
├── package.json
├── tailwind.config.js
└── tsconfig.json
```

## Entry Points


| File                                | Type                      | Description                             |
| ----------------------------------- | ------------------------- | --------------------------------------- |
| `src/sidepanel.tsx`                 | Plasmo Side Panel         | Main UI entry, renders `<SidePanel />`  |
| `src/components/SidePanel.tsx`      | React Component           | Root layout: TopNavigation + active tab |
| `src/background/index.ts`           | Service Worker            | Message routing, action handlers        |
| `src/contents/flow-content.ts`      | Content Script (ISOLATED) | Flow tab orchestration                  |
| `src/contents/flow-slate-bridge.ts` | Bridge (MAIN)             | Flow automation in page context         |
| `src/contents/chatgpt-content.ts`   | Content Script (ISOLATED) | ChatGPT tab orchestration               |
| `src/contents/chatgpt-bridge.ts`    | Bridge (MAIN)             | ChatGPT automation in page context      |


## Important Conventions

- Generation settings come from **GenPanel UI state**, NOT from the Flow settings page DOM.
- **No `File` objects** cross the background/content runtime message boundary. Files are converted to base64 first.
- `upload_xxx` keys must be resolved to real `tileId` before `RUN_FLOW_PROMPT` fires.
- The bridge runs in the **MAIN world** via `chrome.scripting.executeScript`. The ISOLATED content script communicates with it via `window.postMessage`.
- **Build pass is NOT runtime verification.** After building, always reload the extension and verify `window.__FLOW_BRIDGE_BUILD_TIME__` in the Flow page console.
- Never rewrite `flow-slate-bridge.ts` unless explicitly required. Preserve all fallback logic, retries, and verification.

## Reloading After Changes

- Dev mode (`npm run dev`): Plasmo hot reloads most extension UI changes, but Flow page may still need reload for content scripts.
- Production build (`npm run build`): reload the unpacked extension in `chrome://extensions`.
- After reloading the extension, hard reload the Google Flow tab.
- For Flow runtime changes, verify in the Flow page console:

```js
window.__FLOW_BRIDGE_BUILD_TIME__
```

Expected value: matches `FLOW_BRIDGE_BUILD_TIME` in `flow-slate-bridge.ts`. Current build: `2026-06-26 01:15:00`.

---

## Orchestration Architecture

### Multi-prompt queue: GenPanel only

`**flow-content.ts` and `background/index.ts` do NOT implement multi-prompt queueing.**
Both handle exactly **one prompt per `RUN_FLOW_PROMPT` message**. The payload carries a single `prompt: string` field.

Multi-prompt orchestration lives **entirely in `GenPanel.tsx`**:

- `multiPrompt=true` + 2+ blank-line-separated blocks in textarea → `runPromptQueue(promptTexts)` called
- `multiPrompt=true` + 1 block → falls through to single-prompt path
- `multiPrompt=false` → single-prompt path always

Inside `runPromptQueue()`:

1. Ref images are resolved **once** before the loop (shared across all prompts in the queue)
2. Each prompt calls `RUN_FLOW_PROMPT` sequentially — next prompt only starts after `AUTO_DOWNLOAD_DONE` of the previous
3. Each prompt is classified independently via `classifyResult()` → stored as `PromptRun` with status `success | partial | failed`
4. `handleRetryAll()` calls `runPromptQueue(failedPrompts)` — does NOT mutate the textarea
5. Cancel (`handleCancel`) calls `AbortController.abort()` — stops before the next prompt, does NOT abort a prompt already running

---

## GenPanel (`GenPanel.tsx`)

### State and lifecycle

```ts
interface RefImage { id: string; name?: string; thumbnail?: string; type?: 'image' | 'video' }
interface PromptRun { id: string; index: number; text: string; status: PromptRunStatus; startedAt?: number; finishedAt?: number; result?: { successCount: number; failCount: number } }
type PromptRunStatus = 'pending' | 'running' | 'success' | 'partial' | 'failed'
```

Key state:

- `refImages: RefImage[]` — reference images (mix of real tileIds and `upload_xxx` keys)
- `pendingUploads: Record<string, File>` — maps `upload_xxx` key → real File awaiting upload
- `failedPrompts: string[]` — texts of failed prompts (survives across renders)
- `promptQueue: PromptRun[]` — multi-prompt queue state (only populated when `runPromptQueue()` is running)
- `runAbortController: AbortController | null` — abort signal for cancel

### `resolveReferenceImagesBeforeRun()`

Resolves all `upload_xxx` keys to real Flow `tileId` before `RUN_FLOW_PROMPT` fires.

- `tileId` keys: kept as-is
- `upload_xxx` keys: uploaded to Flow, replaced with real `tileId`
- **Aborts the entire generation** if any upload fails — no broken prompt sent to Flow
- Returns `{ resolvedRefImages, resolvedFileIds, resolvedFileNameMap }`

### `buildGenerationPayload()`

Validates and assembles the `FlowPayload` sent to background:

- Throws `REF_UPLOAD_NOT_RESOLVED` if any `upload_xxx` key remains in `fileIds`
- `pendingFiles` field: **REMOVED** — files are resolved to tileIds before this function is called
- `isFrames`: `true` **ONLY** when `frameFileIds` is present (never inferred from `fileIds.length`)
- Video model constraint: Veo 3.1 Lite/Fast + refs → force 8s duration

### `classifyResult(result, autoDownload)`

Classifies a single prompt result for queue display:

```ts
if (autoDownload) {
  const sc = autoDl.successCount ?? 0
  const fc = autoDl.failCount ?? 0
  if (sc > 0 && fc > 0) return 'partial'
  if (sc > 0 && fc === 0) return 'success'
  return 'failed'
}
return result?.success ? 'success' : 'failed'
```

### `runPromptQueue(promptTexts)`

Sequential multi-prompt orchestration:

1. Create `AbortController`, set `runAbortController` (for cancel)
2. Resolve ref images **once** (shared across all prompts)
3. For each prompt in queue:
  - Check `controller.signal.aborted` before starting → mark remaining `pending`/`running` as `failed`, break
  - Build payload via `buildGenerationPayload()` (shares resolved refs)
  - Set `payload.promptIndex`, `payload.promptTotal`
  - Call `runFlowGeneration(payload)` → await result
  - Classify via `classifyResult()` → update `promptQueue`
  - Accumulate `successTotal`, `partialTotal`, `failedTotal`
4. On completion: `setGenStatus(okTotal > 0 ? 'done' : 'idle')`, `setFailedPrompts(failedRuns)`

### `handleRetryAll()`

```ts
await runPromptQueue([...failedPrompts])
```

Calls `runPromptQueue` with the stored failed texts. Does NOT touch the textarea. The textarea retains whatever the user typed.

### Partial success in single-prompt path (GenPanel)

When `result.success === false` (partial — Flow generated but fewer than expected):

```ts
const downloaded = dl?.downloaded ?? autoDownload?.successCount ?? 0
const failed = expected - downloaded
setFlowStep(downloaded > 0
  ? `Partial success: downloaded ${downloaded}${failed > 0 ? `, ${failed} failed in Flow` : ''}`
  : `Flow partial: ${expected} expected, downloaded 0`
)
setGenStatus('idle')
```

- `downloaded > 0`: soft message, no alert, return to idle
- `downloaded === 0`: `alert(msg)` fires

### Ref limits enforced in GenPanel

```
Image mode:         max 10 refs
Video Ingredients:  max 3 refs, isFrames=false
Video Frames:       0 refs (uses frameFileIds instead)
```

---

## Background Service Worker (`background/index.ts`)

`background/index.ts` runs in the **service worker context** — no `window`, no `localStorage` at top level.

### Key actions


| Action                    | Behavior                                                          |
| ------------------------- | ----------------------------------------------------------------- |
| `RUN_FLOW_PROMPT`         | Find/inject bridge → poll ready → forward to flow-content         |
| `FLOW_UPLOAD_IMAGE`       | Route upload to flow-content via `FLOW_UPLOAD_IMAGES`             |
| `FLOW_START_TILE_MONITOR` | Forward to bridge monitor                                         |
| `FLOW_GET_TILE_COUNTS`    | Forward to bridge                                                 |
| `FLOW_STOP_TILE_MONITOR`  | Forward to bridge                                                 |
| `FLOW_DEBUG_PING`         | Ping bridge, inject if needed                                     |
| `PREPARE_DOWNLOAD_RENAME` | Enqueue rename entry for `chrome.downloads.onDeterminingFilename` |
| `DOWNLOAD_FILE`           | Decode base64 → Blob → `chrome.downloads.download`                |


### `runFlowPrompt()` — background side

1. Find or open Flow tab (`labs.google/fx/`*)
2. Check if bridge is already loaded via `FLOW_INJECT_BRIDGE` ping
3. If not loaded: inject `flow-content.js` (ISOLATED) + `flow-slate-bridge.js` (MAIN world)
4. Poll bridge ready up to 10 times (500ms each)
5. Forward `RUN_FLOW_PROMPT` with full payload to flow-content
6. Return `{ success, tabId, status, autoDownload, downloadDetails, error }`

### Download rename queue

`PREPARE_DOWNLOAD_RENAME` creates a queue entry. `chrome.downloads.onDeterminingFilename` matches by `identifier` (tileId) or filename, then calls `suggest({ filename: 'folder/file.ext' })`.

Extension priority for file extension:

1. URL-derived extension from download URL
2. `mediaKind` hint (`mp4` for video, `png` for image)
3. `png` fallback (defensive default)

---

## Flow Content Script (`flow-content.ts`)

Runs in the **ISOLATED world**. Communicates with the bridge via `window.postMessage`.

### `RUN_FLOW_PROMPT` handler (message receiver)

Receives the full `FlowPayload`, normalizes field names (handles aliases), then calls `runFlowPrompt()`.

### `runFlowPrompt()` — ISOLATED world pipeline

```
1. waitBridgeReady()    — poll bridge ping every 500ms, up to 10s → 'BRIDGE_NOT_READY'
2. applySettings        — bridgeCall('applySettings', { payload }) → 'FLOW_APPLY_SETTINGS_FAILED'
3. clear                — bridgeCall('clear') → 'FLOW_CLEAR_FAILED'
4. addRefImages         — bridgeCall('addRef', { fileId, fileName }) per fileId
                         SKIP if fileIds empty OR isFrames=true → 'FLOW_ADD_REF_FAILED'
5. insertText           — bridgeCall('insert', { text: prompt }) → 'FLOW_INSERT_FAILED'
6. verify               — bridgeCall('verify'); retry insert once if hasContent=false
                         → 'FLOW_VERIFY_FAILED'
7. submit               — getTileSnapshot baseline → bridgeCall('submit') → 'FLOW_SUBMIT_FAILED'
8. autoDownload         — polling loop → per-tile sequential download
```

**Critical ordering:**

- `addRefImages` runs after `clear`, before `insertText`
- `applySettings` failure → abort (don't clear/insert/submit with wrong settings)
- `addRefImages` failure → abort (don't submit missing refs)

Defensive gate: if `fileIds` contains `upload_xxx` (GenPanel failed to resolve), returns `REF_UPLOAD_NOT_RESOLVED` immediately.

### Auto-download pipeline

```
submit
  → getTileSnapshot (pre-submit baseline, deduplicate with preSubmitIds + preSubmitFileNames)
  → waitForGeneratedTiles() — polls every ~700ms (18×200ms base, adaptive fast-path via MutationObserver)
    → dual filter: id NOT in baseline AND fileName NOT in baselineFileNames
    → classify tiles: confirmed / pending / failed
  → waitForMediaReady() — per tile, polls CDN URL (up to 60s per tile)
  → downloadTileMedia() — resolution menu → PREPARE_DOWNLOAD_RENAME → chrome.downloads
  → return { successCount, failCount }
```

**Tile classification:**

```
done + valid fileName → confirmed
failed + stable (>= MIN_FAIL_DETECT_MS=15000) → failed
failed + fresh (< 15s) → pending (retry)
processing + media ready → pending (wait)
```

**Early exit conditions during polling:**

- `confirmed >= quantity` → break, full success
- `confirmed > 0 AND stableFailed > 0` → break, partial (confirmed + stableFailed coexist)
- `confirmed = 0 AND stableFailed > 0 AND media ready` → provisional_grace, partial
- `video mode, no failed icon, no progress for 8s` → VIDEO_PARTIAL_GRACE, partial

**Per-tile download:**

- Poll tile status for up to 60s (30 × 2000ms)
- Skip if first poll shows `status=failed`
- Skip if tile flips to `failed` during polling
- Skip if `fileName` is still placeholder (`media.getMediaUrlRedirect`)
- Download via Flow native resolution menu (right-click → More options → resolution)
- Guard: `clickedResolutionTokens: Set<string>` prevents duplicate resolution clicks
- Guard: `inProgressTileIds: Set<string>` prevents concurrent processing of same tile
- 403 from download URL → `warning: 'download_forbidden_403'`, tile marked done, no retry

### Auto-download return object

**Normal:** `{ successCount: number, failCount: number }`

**Error:** `{ successCount: 0, failCount: number, error: string }`

Error values:

- `'AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS'` — zero confirmed tiles after full polling
- `'AUTO_DOWNLOAD_DUPLICATE_TARGETS_BLOCKED'` — dedupe invariant violated

### Partial success vs hard failure


| Condition                              | Status       | Behavior                                    |
| -------------------------------------- | ------------ | ------------------------------------------- |
| `successCount > 0 AND failCount === 0` | full success | `result.success = true`                     |
| `successCount > 0 AND failCount > 0`   | partial      | `result.success = false`, soft message only |
| `successCount === 0 AND failCount > 0` | hard failure | `result.success = false`, alert fires       |


**Key: partial success is NOT a failed prompt.** `downloaded > 0` → soft message, no alert, idle state.

---

## Flow Slate Bridge (`flow-slate-bridge.ts`)

Runs in the **MAIN world** (via `chrome.scripting.executeScript` with `world: 'MAIN'`). Only file with React Fiber access (`__reactFiber$`, `__reactProps$`, `__reactContainer$`).

### BUILD_TIME marker

```ts
var FLOW_BRIDGE_BUILD_TIME = "2026-06-26 01:15:00"
;(window as Record<string, unknown>).__FLOW_BRIDGE_BUILD_TIME__ = FLOW_BRIDGE_BUILD_TIME
```

Exposed on `window` for runtime verification.

### Bridge actions


| Action             | Function                | Description                                                    |
| ------------------ | ----------------------- | -------------------------------------------------------------- |
| `applySettings`    | `rsApplySettings()`     | Open settings panel, set model/mode/ratio/qty/duration/style   |
| `clear`            | `clearEditor()`         | Clear Slate editor (Slate fiber → DOM fallback)                |
| `insert`           | `insertText()`          | Insert text into Slate (Slate fiber → DOM fallback)            |
| `verify`           | `verifyEditor()`        | Check editor has content                                       |
| `submit`           | `submit()`              | Click submit button                                            |
| `addRef`           | `addFileToPrompt()`     | Right-click tile → context menu → "Add to prompt"              |
| `uploadFiles`      | `uploadFilesToPrompt()` | Decode base64 → Blob → `<input[type=file]>` → poll tile status |
| `getTileSnapshot`  | tile monitor / snapshot | Poll all tiles, return ids, fileNames, details, counts         |
| `startTileMonitor` | `startTileMonitor()`    | Poll tiles, post tile counts to background                     |
| `downloadTile`     | `downloadTileMedia()`   | Right-click tile → resolution menu → trigger download          |
| `ping`             | —                       | Health check, returns `__FLOW_SLATE_BRIDGE_READY__`            |
| `openSettings`     | —                       | Toggle settings panel open/close                               |


### `addFileToPrompt()` — add existing tile to composer

```
1. Reject upload_xxx keys (must be resolved before reaching bridge)
2. Find tile by [data-tile-id="<fileId>"]
3. Right-click → dispatch full contextmenu event chain
4. Poll visible menus for "Thêm vào câu lệnh" / "Add to prompt"
5. Click the menu item
6. Return { success, method, error, fileId }
```

### `uploadFilesToPrompt()` — upload local file

```
1. Decode base64 → Blob → File
2. Snapshot beforeIds / beforeFileNames
3. Dispatch change event on real <input[type=file]>
4. Poll tiles for candidates matching:
   - id NOT in beforeIds
   - fileName NOT in beforeFileNames
   - fileName !== fd.name (original local name, not Flow-assigned name)
   - status === 'done' || 'success'
5. If 1 candidate: accept → return { keyMapping, tileDetails }
6. If multiple: hold lastAmbiguousErr, keep polling
7. If poll times out (90s) with ambiguity: fail
8. If poll times out cleanly: fail
```

### `getTileSnapshot` — tile status detection

Returns `{ ids, fileNames, details, counts, rawCount }` for all visible tiles on the Flow page. Used by both the main polling loop (ISOLATED world) and tile monitors.

### Download flow (`downloadTileMedia`)

```
1. Find tile [data-tile-id="<id>"]
2. Hover → reveal download button
3. Click → open context/resolution menu
4. Hover "More options" → open submenu
5. Find target resolution (1K/2K/4K/720p/1080p)
6. Click resolution item ONCE (clickedResolutionTokens guard)
7. chrome.downloads.onDeterminingFilename fires → rename via queue
```

### Duplicate download guard

- `clickedResolutionTokens: Set<string>` — tracks `{tileId}:{resolution}` already clicked this session
- `inProgressTileIds: Set<string>` — prevents concurrent processing of same tile

---

## ChatGPT Automation (v1)

### Overview

ChatGPT image generation runs independently from Flow automation and does not touch any Flow code. The architecture uses a **jobId model** with persistent state so it survives MV3 service worker suspension.

### Architecture

```
GenPanel (activeProvider='chatgpt')
  └─ chrome.runtime.sendMessage({ action: 'RUN_CHATGPT_PROMPT', payload })
        └─ background/index.ts — runChatGPTPrompt()
             ├─ openProviderTab('chatgpt')                    [existing helper]
             ├─ chrome.scripting.executeScript(...)            [inject content-script]
             ├─ chrome.storage.session.set(jobs[jobId]={status:'running', ...})
             ├─ chrome.tabs.sendMessage(tabId, {
             │     action: 'CHATGPT_SUBMIT_AND_WAIT',
             │     payload: { prompt, ratio, autoDownload, timeoutMs, jobId }
             │  })
             └─ return { success: true, accepted: true, jobId }   [immediate]
                   └─ GenPanel polls GET_CHATGPT_JOB_STATUS every 1.5s

content-script.ts (chatgpt.com tab, isolated world)
  ├─ receives CHATGPT_SUBMIT_AND_WAIT
  ├─ returns { accepted: true, jobId } immediately
  └─ (long poll runs in tab via runChatGPTJob())
       ├─ verify composer exists
       ├─ chatgptEnableImageMode() (best-effort)
       ├─ chatgptSetRatio(ratio) (best-effort)
       ├─ chatgptWaitForIdle(30s) — wait previous generation
       ├─ baseline = chatgptCollectFileIds() — file_ids from chat history
       ├─ setInputValue + dispatchInputEvent on composer
       ├─ chatgptFindSubmitButton() + click
       ├─ poll every 1s (default 300s timeout):
       │     ├─ chatgptIsGenerating() — spinner/stop-button detection
       │     ├─ chatgptDetectTextOnlyError() — refusal text detection
       │     └─ chatgptCollectGeneratedImages(baselineFileIds)
       │           ├─ skip blur/backdrop/placeholder (alt text)
       │           ├─ skip uploaded/reference images (alt + DOM ancestors)
       │           ├─ skip icons (w/h < 128)
       │           ├─ skip file_ids in baseline
       │           └─ dedupe by file_id (?id=file_xxx) or src fallback
       └─ chrome.runtime.sendMessage({
              action: 'CHATGPT_JOB_DONE',
              jobId,
              payload: { success, imageUrls, error, message }
            })

background/index.ts — CHATGPT_JOB_DONE listener
  ├─ receive CHATGPT_JOB_DONE from content-script
  ├─ if success && autoDownload: chrome.downloads.download(...) per imageUrl
  ├─ chrome.storage.session.set(jobs[jobId] = {
  │     status: 'done' | 'failed',
  │     imageUrls, downloaded, error, finishedAt
  │   })
  └─ (GenPanel poll picks up the updated state)
```

### Background actions


| Action                   | Behavior                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `RUN_CHATGPT_PROMPT`     | Open/inject ChatGPT tab, persist job state, kick off content script, return `{ success, accepted, jobId }` immediately |
| `CHATGPT_JOB_DONE`       | Receive from content script: run downloads, update job in storage                                                      |
| `GET_CHATGPT_JOB_STATUS` | Read job state from `chrome.storage.session` (local fallback), return full `ChatGPTJobState`                           |


### Job state shape

```ts
interface ChatGPTJobState {
  status: 'running' | 'done' | 'failed'
  startedAt: number
  finishedAt?: number
  promptPreview: string        // first 120 chars only
  autoDownload: boolean
  outputFolder?: string
  imageUrls: string[]
  downloaded: number
  error: string
  message?: string
  tabId?: number
}
```

Stored under key `chatgptJobs` in `chrome.storage.session` (Chrome 102+ MV3). Falls back to `chrome.storage.local` if session fails. Terminal jobs (done/failed) are dropped after 30 minutes by `chatgptCleanupExpiredJobs()` on SW startup.

### Reference images for ChatGPT

GenPanel lets the user attach reference images to a ChatGPT run. The flow is
**different from Flow** — there is no intermediate tileId; the content script
uploads the bytes directly to the ChatGPT composer.

```
GenPanel (activeProvider='chatgpt', refImages.length > 0)
 └─ For each refImage with id === 'upload_xxx':
    └─ fileToBase64Payload(pendingUploads[id]) → { base64, type }
 └─ chrome.runtime.sendMessage({ action: 'RUN_CHATGPT_PROMPT', payload: { ... , mediaUploads } })
 └─ background/index.ts — runChatGPTPrompt()
    └─ forward payload.mediaUploads as-is in CHATGPT_SUBMIT_AND_WAIT
 └─ content-script.ts — runChatGPTJob()
    ├─ chatgptWaitForIdle(30s)
    ├─ chatgptRemoveComposerAttachments() — clear stale attachments
    ├─ uploadImage(dataUrl) per mediaUploads[i]
    ├─ post-upload verify: attached === expected
    ├─ continue with prompt insert + submit + image collection
```

**`ChatGPTPromptPayload.mediaUploads`** is `{ base64: string; type: string }[]`.
**Real tileIds (non-`upload_xxx` refs) are NOT forwarded** — the bytes are not
available on the GenPanel side, so re-sending them is impossible. The Flow
`resolveReferenceImagesBeforeRun()` path must NOT be reused for ChatGPT.

**Reference Images UI in GenPanel** is now shown for both providers. The
Flow-only sub-pieces (`refMode` select, "Drag to reorder" hint) are internally
gated by `activeProvider === 'flow'`. The upload bar, count, image grid, and
remove button work for both providers.

### GenPanel polling contract

```
1. RUN_CHATGPT_PROMPT → receives { jobId }
2. Poll GET_CHATGPT_JOB_STATUS every 1.5s while status === 'running'
3. Poll timeout: 600s (MAX_POLL_MS)
4. Progress text: '[ChatGPT] Generating... {elapsed}s' every ~3s
5. Terminal: status === 'done' → setGenStatus('done')
             status === 'failed' → setGenStatus('idle') + alert(error)
```

### Known v1 limitations

- **Closing/reopening the panel does not resume running ChatGPT jobs.** GenPanel has no job recovery on mount. Jobs continue running in the chatgpt.com tab and write to storage, but no UI is watching to collect the result.
- **Image mode / aspect ratio**: `chatgptEnableImageMode()` and `chatgptSetRatio()` are best-effort. Failures are logged and do not abort the job.
- **DOM selector drift**: ChatGPT's React DOM changes frequently. The selectors in `chatgptFindSubmitButton`, `chatgptIsGenerating`, `chatgptEnableImageMode` are best-guess and may need updating.

### Files involved


| File                                    | Role                                                        |
| --------------------------------------- | ----------------------------------------------------------- |
| `src/background/index.ts`               | Job registry, storage, routing, `CHATGPT_JOB_DONE` listener |
| `src/content-scripts/content-script.ts` | `CHATGPT_SUBMIT_AND_WAIT` + `runChatGPTJob()` + helpers     |
| `src/components/gen/GenPanel.tsx`       | Job submission + polling loop                               |


### What NOT to touch (ChatGPT v1)

- `src/contents/flow-content.ts`
- `src/contents/flow-slate-bridge.ts`
- `src/contents/chatgpt-content.ts`
- `src/contents/chatgpt-bridge.ts`
- `FLOW_*` actions
- `RUN_FLOW_PROMPT` from ChatGPT path

---

## Debug Flags

### Enabling verbose logs

All three files support a debug flag. When enabled, additional diagnostic logs are emitted.

`**flow-slate-bridge.ts`** and `**flow-content.ts**` (`FLOW_DEBUG_VERBOSE`):

```js
localStorage.setItem('FLOW_DEBUG_VERBOSE', '1')
// or
window.__FLOW_DEBUG_VERBOSE__ = true
```

`**background/index.ts**` (`BG_DEBUG`):

```js
// localStorage from extension page/tab:
localStorage.setItem('AI_FLOW_DEBUG', '1')
// NOTE: window.__AI_FLOW_DEBUG__ does NOT work in service worker (no window).
// BG_DEBUG is read once at bundle evaluation time.
```

`**GenPanel.tsx**` (`GP_DEBUG`):

```js
localStorage.setItem('AI_FLOW_DEBUG', '1')
// or
window.__AI_FLOW_DEBUG__ = true
```

### Default behavior (debug off)

Concise logs visible in console:

```
[Bridge] BUILD_TIME 2026-06-26 01:15:00
[FlowContent] Loaded on ...
[FlowContent] runFlowPrompt START, mode=...
[FlowContent] Step 3: clearEditor
[FlowContent] Step 4: addRefImages, count=...
[FlowContent] Step 5: insertText, len=...
[FlowContent] Step 7: submit
[FlowContent][AUTO_DOWNLOAD_START] ...
[FlowContent][AUTO_DOWNLOAD_TARGETS_FINAL] ...
[FlowContent][AUTO_DOWNLOAD_DONE] ...
[FlowContent][RESULT_TILE] ...
[FlowContent][AUTO_DOWNLOAD] tile SUCCESS ...
[Bridge] submit SUCCESS via ...
[Background] runFlowPrompt result: ...
```

### What is gated behind debug flags

`**flow-slate-bridge.ts**` (`FLOW_DEBUG_VERBOSE`) — via `bridgeDebug()`:

- `[Bridge] Message:` / INSERT/CLEAR/verify per-call details
- `[Bridge][tileIdentity] getTileSnapshot` — polling heartbeat
- `[Bridge] debugRunFlowPrompt` [1-4/4] steps
- `__flowDebugSelectedStates` details
- `__flowTest*` (manual test helpers)
- `__flowDebugScan` verbose DOM dump
- Upload, addRef, download, settings panel verbose details

`**flow-content.ts**` (`FLOW_DEBUG_VERBOSE`) — via `flowDebug()`:

- `debugRunFlowPrompt` [1-4/4] steps
- `[BASELINE]`, `[BASELINE_FILE_NAMES]` — pre-submit tile snapshot
- `[REF_IDENTITY]` — ref image set
- `[RESULT_DETECT]` — per-poll cycle diagnostics
- `[FAILED_SIGNAL_DEBUG]` / `[PENDING_SIGNAL_DEBUG]` / `[SUCCESS_SIGNAL_DEBUG]`
- `[RESULT_ORDER_DEBUG]` — candidate ordering
- `[VIDEO_RESULT_CLASSIFY]` — video classification
- `[AUTO_DOWNLOAD_VIDEO_PROVISIONAL_CONFIRMED]`
- `__flowDebugScan` verbose DOM dump (with short non-verbose fallback when debug off)

`**flow-content.ts**` (`FLOW_DEBUG_SETTINGS`) — via `settingsDebug()`:

- `[settings result]` — applySettings response
- `[RUN_FLOW_PROMPT_PAYLOAD]` — raw payload on receipt
- `[GEN_DEBUG_STATE_FROM_PAYLOAD]` — state parsed from payload
- `[REFS_NORMALIZED]` — ref normalization
- `[APPLY_SETTINGS_TARGET]` — settings being applied

`**background/index.ts**` (`BG_DEBUG`):

- Every `chrome.runtime.onMessage` received action
- Bridge ping response
- Script injection steps
- Bridge ready check poll

`**GenPanel.tsx**` (`GP_DEBUG`):

- `[MODE_CHANGE]` — on mode switch (throttled, fires max once per 500ms)
- `[RENDER_STATE]` — on key state changes (throttled)
- `[AUTO_DOWNLOAD_UI_STATE]` — when building generation payload
- `[REF_PAYLOAD]` — ref resolution state
- `[RUN_CLICK_STATE]` — on generate button click

---

## Normal Behaviors That Are Not Bugs

These scenarios are expected and do NOT indicate failures:

1. **Reference image uploads show ambiguous candidates**: Flow may paint multiple tiles during processing. The polling loop handles this — if candidates later narrow to 1, the upload succeeds. Only a timeout with persistent ambiguity is a failure.
2. **Auto-download partial**: `expected=4 confirmed=1 failed=3` with `successCount=1` is normal. Flow sometimes fails individual tiles. The extension downloaded the 1 successful tile. Show soft message, not an error.
3. **Result detect pulse**: `[RESULT_DETECT]` fires during the polling wait. With debug off, this is silent. With debug on, this is the expected heartbeat.
4. **Video tile pending**: Video tiles often stay `status=processing` with `hasVideo=true` and no `fileName` until the CDN URL is ready. The orchestrator waits up to 60s per tile. This is normal — Flow generates the video first, then exposes the download URL.
5. **AddRef menu not found**: The context menu on the Flow tile may close between right-click and menu poll. The addRef function retries with backoff. If the menu never opens after 3 attempts, it fails.
6. **Resolution menu 403**: If the signed download URL expires or Flow rejects the authorization, the extension returns `warning: 'download_forbidden_403'` but marks the tile as done. The 403 is a server decision, not an automation bug.
7. **Bridge ready check poll**: On cold start, the background service worker polls up to 10 times (5s total) waiting for the bridge to initialize. With debug off, this is silent.
8. `**[FlowContent][AUTO_DOWNLOAD_PARTIAL_EARLY_EXIT]`**: Normal when Flow produces both confirmed and failed tiles. Not an error.
9. `**[FlowContent][PENDING_PROMOTED_TO_FAILED]**`: Normal when a pending tile's failure icon has been stable for 15s.

---

## Required Completion Report

After every coding task, report the following:

**Files changed:**

- List each file modified.

**Functions changed:**

- List each function modified and its location.

**Root cause** (for bug fixes):

- State the root cause with evidence from code or console logs.

**What changed:**

- Before vs after, clearly stated.

**Build:**

- command: `npm run build`
- exit code
- duration in ms or seconds
- build timestamp in format `YYYY-MM-DD HH:mm:ss`
- warning summary, if any

**Build result:** pass / fail

**Build time marker:**

Run in the Flow page console after reload:

```js
window.__FLOW_BRIDGE_BUILD_TIME__
```

Expected: `2026-06-26 01:15:00` (matches `FLOW_BRIDGE_BUILD_TIME` in `flow-slate-bridge.ts`).

> Note: When only documentation (`CLAUDE.md`) was modified and no source files were changed, the build time marker remains unchanged. Build pass is still valid — verify the marker in the Flow page console after reloading the extension.

**Build pass is not runtime verification.** Never claim a runtime fix is verified only because `npm run build` passed. For content scripts, bridge, background, or GenPanel runtime flow, runtime verification requires:

1. Reload unpacked extension in `chrome://extensions`
2. Hard reload Google Flow tab
3. Check `window.__FLOW_BRIDGE_BUILD_TIME__` in the Flow page console
4. Confirm the marker matches the latest build timestamp
5. Run the affected browser flow and check the expected logs

**Residual risks:**

- `FLOW_DEBUG_VERBOSE` and `FLOW_DEBUG_SETTINGS` in `flow-content.ts` use top-level `var` declarations that read `localStorage`/`window` at bundle evaluation time. This is not a service worker risk (flow-content runs in the extension content script context, not SW), but if flow-content were ever loaded in an environment without `window`, evaluation would throw. The current usage in the Flow page (ISOLATED world) is safe.
- `GenPanel.tsx` has a `localStorage` guard (`typeof localStorage !== 'undefined'`) at top level, so it handles missing `localStorage` gracefully. No action needed.

**Manual test steps:**

- Exact steps to reproduce and verify the change in the browser.

