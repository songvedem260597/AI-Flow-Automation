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

### 6a. Shell Command Syntax (Windows / PowerShell)

The default shell in this workspace is **PowerShell** (`Shell: powershell`).
PowerShell has different syntax from bash/zsh — chains and operators must
match the shell that's actually running.

Bad (bash syntax — fails in PowerShell with `ParserError`):

```bash
git status && echo "---" && git log --oneline -10
cmd1 ; cmd2 && cmd3 | grep foo
```

Good (PowerShell syntax):

```powershell
git status; if ($LASTEXITCODE -eq 0) { git log --oneline -10 }
# chain with `;` (no short-circuit) or use `if ($LASTEXITCODE) { ... }` for short-circuit
# pipe still works: cmd | Select-String foo
```

Required rules:

- **Chain separator**: use `;` between commands, NOT `&&` / `||`. PowerShell
 uses `;` for unconditional sequencing. For short-circuit-on-failure use
 `if ($LASTEXITCODE -ne 0) { throw }` or `cmd1; if ($LASTEXITCODE -eq 0) { cmd2 }`.
- **Redirect output**: `>` still works. To capture command output without
 echoing it back through the agent context, redirect to a file under
 `scripts/_artifacts/` (already gitignored) or `build/` (already gitignored),
 then read it via the Read tool. Example:
  ```powershell
  git --no-pager diff --no-color -U2 path/to/file.ts > scripts/_artifacts/diff.txt
  ```
- **Avoid `cat` / `head` / `tail` / `sed` / `awk`**: use the dedicated
 `Read`, `Grep`, `Glob`, and `StrReplace` tools instead. If a shell command
 is genuinely needed, prefer PowerShell built-ins (`Get-Content`, `Select-Object`,
 `ForEach-Object`, `[System.IO.File]::ReadAllBytes`).
- **No interactive commands**: PowerShell scripts run non-interactively;
 avoid `git rebase -i`, `git add -i`, prompts, `less`-style pagers, etc.
 Use `git --no-pager` to force non-paged output.
- **Bash-only flags break**: e.g. `grep --color`, `find ... -printf`,
 `xargs -I {}` may not exist. Prefer `rg` (ripgrep) via the `Grep` tool.
- **Multi-line scripts**: when several commands must run as one block
 (e.g. byte-level file inspection), wrap them in a single `Shell` call
 inside a script-block — splitting them across many small calls adds
 startup overhead and can race on intermediate files.
- **Encoding gotcha**: PowerShell's `Get-Content` + `Set-Content` defaults
 to UTF-16 LE with BOM for text files. When dumping raw git blobs via
 `git cat-file -p` or `git --no-pager show`, write the output to a file
 and read with `Read` (binary-safe), or pipe through `Out-File -Encoding utf8`
 to avoid the UTF-16 BOM issue that corrupts byte-equal comparisons.
- **Measure-Object output**: PowerShell pipelines through `Measure-Object`
 can drop empty results and confuse the `block_until_ms` reader. If a
 command seems to "return nothing", dump to a file and `Read` it instead
 of relying on stdout streaming.
- **Exit codes**: PowerShell does not exit non-zero on most pipeline
 errors. After any command that should fail-fast (build, lint), explicitly
 check `$LASTEXITCODE` and surface it to the agent context.

When unsure which shell is active, check `<user_info>` at the start of
the conversation — `Shell:` field is authoritative.

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
- Workflow `runner.ts` lazy-dependency execution plan (see "Workflow runner
  execution order" below). Do NOT replace it with a fresh Kahn topological
  sort that pops every in-degree-zero node first — the bug it fixed was a
  downstream node "completing" before its upstream was actually done.
- ChatGPT provider contract: `RUN_CHATGPT_PROMPT` accepts `mediaUploads[]`,
  `focus: false` from workflow callers, `requestFingerprint`-based dedupe,
  and `CHATGPT_JOB_DONE` images array. Do NOT change these without
  inspecting all call sites in `runner.ts` and `GenPanel.tsx`.

### 7a. Do Not Regress — ChatGPT-specific invariants

These are the load-bearing invariants of the current ChatGPT pipeline. Any
change to `src/contents/content-script.ts`, `src/pipeline/runner.ts`,
`src/background/index.ts`, or `src/lib/debug.ts` MUST preserve them. If a
fix requires breaking one of these, surface it explicitly before doing so.

- Do not focus the ChatGPT tab during workflow runs unless explicitly
  requested. Workflow `runner.ts` passes `focus: false` to `RUN_CHATGPT_PROMPT`
  so the caller's tab (Workflow Editor / Side Panel) stays visible. Only
  GenPanel defaults to `focus: true`.
- Do not use per-image paste upload (P1/P2/A/B/C legacy ladder) for
  multi-image ChatGPT jobs. Multi-image MUST go through
  `uploadImagesBatchViaFileInput` (single `input[type=file]` + `DataTransfer`
  change event for N files). On failure, multi-image jobs fail hard.
  Re-running the Generate Node would re-upload refs and produce duplicate
  attachments — that is the failure mode this rule prevents.
- Do not re-enable P1/P2/A/B/C fallback for multi-image. The fallback is
  only legal as a single-image retry path AFTER batch upload fails and the
  composer is empty.
- Do not let `chatgptIsGenerating() === true` block result detection. As
  soon as `chatgptCollectGeneratedImages` returns ≥1 image not in the
  post-submit baseline, the content script posts `CHATGPT_JOB_DONE` with
  `success: true` — even if the spinner is still up.
- Do not update `lastProgressAt` on a plain heartbeat. Only phase changes,
  spinner-on flips, image/turn/text count bumps, and pending-image flips
  count as real progress. `progressAdvanced(next, prev)` in
  `background/index.ts` is the gate; the first heartbeat after entering
  `waiting_result` is treated as progress to prevent the
  "no-progress" race against the runner.
- Do not spam debug logs by default. All ChatGPT-side verbose logs
  (`[SeqDebug][ChatGPT]`, `[ChatGPT][UploadDiag]`, `[ChatGPT][CountDiag]`,
  `[ChatGPT][Collect] rejected/...`, `[ChatGPT][Background] job heartbeat`,
  `[Runner] wait chatgpt job` per-poll dump) are gated. They MUST stay
  gated. Use `AI_FLOW_DEBUG_SEQ`, `AI_FLOW_DEBUG_CHATGPT_HB`, or the
  master `AI_FLOW_DEBUG` to enable.
- Do not send `quantity` to ChatGPT. `quantity?: number` on
  `GenerateNodeData` is Google Flow only. The runner never serializes it
  into `RUN_CHATGPT_PROMPT` payloads.
- Do not change the ChatGPT upload / result / heartbeat flow while
  working on UI-only tasks (preview download button, sidebar styling,
  etc.). Those edits must not touch `runner.ts`, `background/index.ts`,
  `content-script.ts`, or `src/lib/debug.ts`.
- Do not hide execution-order bugs with CSS. If a node glows in the wrong
  state, fix the actual runtime state / order in `runner.ts` — never paper
  over it with a UI animation or a CSS class.
- Do not modify build artifacts (`build/**`, `plasmo.config.ts` caches)
  manually. Plasmo regenerates them on `npm run build`.
- Do not swap the composer-scoped visual counter
  (`chatgptCountVisualComposerAttachments`) for the broad composer
  counter (`chatgptCountComposerAttachments`). The broad counter leaks
  chat-history images and breaks the duplicate guard for legitimate
  uploads.

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
- **No `File` objects** cross the background/content runtime message boundary. Files are converted to base64 first. For ChatGPT, `RUN_CHATGPT_PROMPT` carries `mediaUploads: { base64, type, name }[]` and the content script rebuilds a `File` from base64 inside the page.
- `upload_xxx` keys must be resolved to real `tileId` before `RUN_FLOW_PROMPT` fires. ChatGPT has no `tileId` step — bytes are forwarded as `mediaUploads[]`.
- The bridge runs in the **MAIN world** via `chrome.scripting.executeScript`. The ISOLATED content script communicates with it via `window.postMessage`.
- **Build pass is NOT runtime verification.** After building, always reload the extension and verify `window.__FLOW_BRIDGE_BUILD_TIME__` in the Flow page console.
- Never rewrite `flow-slate-bridge.ts` unless explicitly required. Preserve all fallback logic, retries, and verification.
- **ChatGPT tab focus**: workflow callers (`runner.ts`) MUST pass `focus: false` to `RUN_CHATGPT_PROMPT`. GenPanel direct calls default to `focus: true`. The user's tab (Workflow Editor / Side Panel) stays visible during workflow runs.
- **ChatGPT quantity**: ChatGPT does not accept a quantity field. `quantity?: number` on `GenerateNodeData` is Google Flow only and is never sent via `RUN_CHATGPT_PROMPT`.

## Shared Files Guard — Provider Boundary Rules

Một số file đóng vai trò shared dispatcher / router. Sửa nhầm có thể làm hỏng provider khác mà không thấy triệu chứng ở provider đang fix. Phần này là Hard Rule bắt buộc tôn trọng khi chạm vào bất kỳ file nào dưới đây.

### High-risk shared files

- `src/background/index.ts` — router trung tâm: nhận message, route tới `RUN_FLOW_PROMPT` / `RUN_CHATGPT_PROMPT` / `INJECT_SCRIPT` / download pipeline, v.v.
- `src/contents/content-script.ts` — generic content script shared (`<all_urls>`), đăng ký `chrome.runtime.onMessage` listener trên MỌI page bao gồm `labs.google/*`, `chatgpt.com/*`, v.v.
- `src/components/gen/GenPanel.tsx` — UI trigger duy nhất gửi `RUN_FLOW_PROMPT` và `RUN_CHATGPT_PROMPT`, quản lý pendingUploads, ref resolution, auto-download đường dẫn cho cả 2 provider.

Các file này không thuộc riêng Google Flow hay ChatGPT. Trước khi sửa, bắt buộc xác định rõ action / provider nào bị ảnh hưởng.

### Provider-specific files

**Google Flow** (sửa thoải mái theo Flow logic, không ảnh hưởng ChatGPT):

- `src/contents/flow-content.ts` — ISOLATED-world orchestration cho Flow.
- `src/contents/flow-slate-bridge.ts` — MAIN-world bridge, React Fiber + Slate + DOM. **Không rewrite** trừ khi task yêu cầu rõ.
- `public/slate-bridge.main.js` — build artifact do `postbuild.js` copy từ `flow-slate-bridge.ts`. Đừng sửa tay; nếu thay đổi source, build sẽ tự refresh.

**ChatGPT** (sửa thoải mái theo ChatGPT logic, không ảnh hưởng Flow):

- `src/contents/chatgpt-content.ts`
- `src/contents/chatgpt-bridge.ts`

### Hard rules

1. **Fix Google Flow mà không có bằng chứng lỗi ở ChatGPT thì KHÔNG được sửa ChatGPT files.**
2. **Fix ChatGPT mà không có bằng chứng lỗi ở Google Flow thì KHÔNG được sửa Google Flow files.**
3. **Sửa shared files (`background/index.ts`, `content-script.ts`, `GenPanel.tsx`) bắt buộc phải guard theo `provider` hoặc `action` prefix.** Không làm một đoạn code ảnh hưởng cả 2 provider.
4. **Generic `content-script.ts` KHÔNG được trả `"Unknown action"` cho action không thuộc nó**, nếu action đó có thể thuộc provider khác.
   - Với `FLOW_*` và `RUN_FLOW_PROMPT`: phải `return false` để `flow-content.ts` xử lý. `flow-content.ts` được đăng ký sau trong manifest order nhưng sẽ là responder duy nhất cho các action này (vì content-script.ts đã thoát ra).
   - Với `CHATGPT_*` và `RUN_CHATGPT_PROMPT`: phải để ChatGPT-specific handler xử lý. Hiện tại ChatGPT logic nằm cùng file này, nhưng cần gate rõ ràng theo action prefix để không lan sang Flow.
5. **Không dùng helper chung nếu contract của từng provider khác nhau.**
   Google Flow có 2 tầng:
     `background` → `flow-content.ts` (ISOLATED world) → `flow-slate-bridge.ts` (MAIN world, postMessage bridge)
   ChatGPT có contract riêng dùng `jobId` với `chrome.storage.session` để sống sót qua MV3 SW suspension. Hai contract này không gom nhầm được.
6. **Mọi action mới phải được ghi rõ `owner` trong commit message và trong code gần switch/handler:**
   - `owner: google-flow`
   - `owner: chatgpt`
   - `owner: shared`
7. **Nếu chạm vào shared dispatcher, báo cáo phải có:**
   - Vì sao shared file cần sửa.
   - Action nào bị ảnh hưởng.
   - Guard provider/action nào đã thêm.
   - Test provider nào đã chạy (Flow Generate, ChatGPT Generate, hoặc cả 2).
8. **Không được `restore` / `push` / `git checkout` nhầm các file unrelated khi đang fix một provider.** Trước khi commit, chạy `git status` + `git diff --stat` và đối chiếu với danh sách provider-specific files ở trên.
9. **Listener race guard:** Nếu một listener không xử lý action, nó phải `return false` và không được `sendResponse` lỗi. Sendresponse lỗi với `{success:false, error: 'Unknown action: ...'}` từ listener đăng ký trước sẽ thắng race với listener provider-specific đăng ký sau, làm provider-specific handler không bao giờ được gọi.

### Known incident — `Unknown action: FLOW_INJECT_BRIDGE`

Google Flow từng fail với:

```
PING_BRIDGE_RAW {"success":false,"error":"Unknown action: FLOW_INJECT_BRIDGE"}
FLOW_BRIDGE_NOT_READY
```

**Root cause:**
`src/contents/content-script.ts` là generic listener (matches `<all_urls>`) và được đăng ký trước `flow-content.ts` trong manifest order. Nó nhận `FLOW_INJECT_BRIDGE` (và bất kỳ `FLOW_*` / `RUN_FLOW_PROMPT` nào) trước, không biết action → `throw new Error("Unknown action: FLOW_INJECT_BRIDGE")` → `.catch` handler gọi `sendResponse({success:false, error:"Unknown action: FLOW_INJECT_BRIDGE"})` ngay trong microtask.
Listener này luôn thắng race với `flow-content.ts`'s response (vì `flow-content.ts` await nội bộ rồi mới `sendResponse`), nên background thấy `success: false` mỗi lần ping, reinject 10 lần, abort.

**Fix:**
`content-script.ts` phải defer `FLOW_*` và `RUN_FLOW_PROMPT` cho `flow-content.ts`:

```ts
if (typeof msgAction === 'string' && (
  msgAction.indexOf('FLOW_') === 0 ||
  msgAction === 'RUN_FLOW_PROMPT'
)) {
  // Do not return true — this listener does not own the message channel.
  // The Flow-specific content script will respond.
  return false
}
```

`background/index.ts` không được ping Google Flow bridge bằng contract của ChatGPT. Google Flow bridge readiness phải dùng Flow-specific logic (MAIN-world probe qua `chrome.scripting.executeScript`, đọc `window.__FLOW_BRIDGE_BUILD_TIME__` / `window.__FLOW_SLATE_BRIDGE_READY__` / `window.__FLOW_BRIDGE__` / `window.__flowSlateBridgeCleanup`, hoặc ping qua `flow-content.ts` sau khi deferral guard đã chặn listener race).

### Required source-level comments

Ngoài CLAUDE.md, các file nguy hiểm **bắt buộc** có comment ngay đầu file:

`src/contents/content-script.ts` phải có block comment:

```js
/**
 * SHARED GENERIC CONTENT SCRIPT
 *
 * WARNING:
 * This file is loaded broadly and may run before provider-specific scripts.
 * Do NOT respond with "Unknown action" for provider-specific actions.
 *
 * Flow actions must be deferred to flow-content.ts:
 *   - FLOW_*
 *   - RUN_FLOW_PROMPT
 *
 * ChatGPT actions must be handled only by ChatGPT-specific logic.
 *
 * If this listener does not own an action, return false and do not call sendResponse.
 */
```

`src/background/index.ts` phải có block comment:

```js
/**
 * SHARED BACKGROUND DISPATCHER
 *
 * WARNING:
 * This file routes multiple providers.
 * Do not reuse ChatGPT bridge logic for Google Flow.
 *
 * Google Flow route:
 *   background -> flow-content.ts -> flow-slate-bridge.ts MAIN world
 *
 * ChatGPT route:
 *   background -> ChatGPT content/bridge contract
 *
 * Any shared helper must be guarded by provider/action.
 */
```

Nếu một trong hai block comment bị xoá / bị rewrite không giữ lại phần "WARNING", tác giả phải được ping trong PR review và phải khôi phục.

## Reloading After Changes

- Dev mode (`npm run dev`): Plasmo hot reloads most extension UI changes, but Flow page may still need reload for content scripts.
- Production build (`npm run build`): reload the unpacked extension in `chrome://extensions`.
- After reloading the extension, hard reload the Google Flow tab.
- For Flow runtime changes, verify in the Flow page console:

```js
window.__FLOW_BRIDGE_BUILD_TIME__
```

Expected value: matches `FLOW_BRIDGE_BUILD_TIME` in `flow-slate-bridge.ts`. Current build: `2026-07-17 21:30:00`.

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
var FLOW_BRIDGE_BUILD_TIME = "2026-07-17 21:30:00"
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

ChatGPT image generation runs independently from Flow automation and does not touch any Flow code. The architecture uses a **jobId model** with persistent state so it survives MV3 service worker suspension. Workflow (`runner.ts`) and GenPanel share the exact same `RUN_CHATGPT_PROMPT` entry point — only the caller's intent differs.

Two provider call sites:

- **Workflow runs** (`runner.ts → runChatGPTGenerate`): pass `focus: false` to `RUN_CHATGPT_PROMPT` so the caller's tab (Workflow Editor / Side Panel) stays visible. Awaits `CHATGPT_JOB_DONE` via `waitForChatGPTJob` before continuing the pipeline.
- **GenPanel direct run**: defaults `focus: true` so the user can see the ChatGPT tab flip active while a generation runs. Polls `GET_CHATGPT_JOB_STATUS` every 1.5s.

### Architecture

```
runner.ts (Workflow Generate Node, activeProvider='chatgpt')
  └─ chrome.runtime.sendMessage({ action: 'RUN_CHATGPT_PROMPT', payload })
        └─ background/index.ts — runChatGPTPrompt()
             ├─ openProviderTab('chatgpt', payload.focus !== false)
             │    ↑ defaults to focus=true; workflow callers pass focus:false
             ├─ ensureChatGPTContentReady(tabId)
             │    ├─ wait for tab.status === 'complete' (30s budget)
             │    ├─ CHATGPT_PING ×3 pre-inject; if no pong, resolve
             │    │   content script bundle via resolveChatGPTContentScriptFile
             │    │   (picks entry whose primary JS starts with `content-script.`,
             │    │   excludes debug-bridge / flow-content / flow-slate-bridge)
             │    ├─ chrome.scripting.executeScript({ tabId, files: [scriptFile] })
             │    └─ CHATGPT_PING ×10 (300ms each) until pong.success
             ├─ chatgptFindRunningJobByFingerprint() — reuse an in-flight
             │   job for the same (prompt, ratio, mediaUploads[], autoDownload,
             │   outputFolder) signature; chatgptSubmitFlights Map also
             │   coalesces concurrent submits.
             ├─ chrome.storage.session.set(jobs[jobId] = {
             │     status: 'running', startedAt, promptPreview,
             │     autoDownload, outputFolder, imageUrls: [],
             │     images: [], downloaded: 0, error: '', tabId,
             │     requestFingerprint,
             │   })
             ├─ chrome.tabs.sendMessage(tabId, {
             │     action: 'CHATGPT_SUBMIT_AND_WAIT',
             │     payload: {
             │       prompt, ratio, fallbackPrefix,
             │       autoDownload, timeoutMs = min(payload.timeoutMs, 30min),
             │       jobId,
             │       mediaUploads: Array.isArray(payload.mediaUploads)
             │         ? payload.mediaUploads
             │         : []
             │     }
             │   })
             └─ return { success: true, accepted: true, jobId }  [immediate]

content-script.ts (chatgpt.com tab, ISOLATED world)
  ├─ receives CHATGPT_SUBMIT_AND_WAIT
  ├─ chatgptSubmitAndWait returns { accepted: true, jobId } immediately
  ├─ dedupe: same jobId + status==='running' → ack as duplicate
  ├─ concurrency guard: different jobId but status==='running' →
  │   CHATGPT_JOB_DONE with success:false error='CHATGPT_BUSY…'
  └─ (long poll + upload runs in tab via runChatGPTJob)
       Phase 0  — pre-upload composer cleanup
                  chatgptWaitForIdle(30s)
                  if chatgptCountComposerAttachments() > 0:
                    chatgptRemoveAllComposerAttachments() — clear stale
                    if still >0 after cleanup: fail CHATGPT_SUBMIT_FAILED
       Phase 0a — idempotent short-circuit
                  if attached === mediaCount (per chatgptCountComposerAttachments):
                    skip upload, fall through to prompt + send
       Phase 0b — media upload
                  ┌──────── multi-image (mediaCount > 1) ───────┐
                  │ uploadImagesBatchViaFileInput(mediaUploads, jobId)
                  │   - chatgptRemoveComposerAttachmentsOnly (visual)
                  │   - decode all base64 → File[]
                  │   - find <input type=file>, dispatch input+change ONCE
                  │   - settle poll (≤10s, every 500ms):
                  │       visualCount === expected → ok
                  │       visualCount  >  expected → duplicate fail
                  │       visualCount  <  expected → incomplete fail
                  │ on failure: HARD fail. NO legacy P1/P2 fallback.
                  └─────────────────────────────────────────────┘
                  ┌──────── single-image (mediaCount === 1) ──────┐
                  │ primary: uploadImagesBatchViaFileInput (same path)
                  │ fallback: only when batch fails AND clean before
                  │   uploadImage(dataUrl, { beforeCount, expectedTotalCount:1 })
                  │   legacy per-item P1/P2/A/B/C strategies.
                  └─────────────────────────────────────────────────┘
       Phase 0c — post-upload visual verification (chatgptCountVisualComposerAttachments)
                  expected === mediaCount: pass
                  expected  >  mediaCount: CHATGPT_SUBMIT_FAILED: duplicate…
                  expected  <  mediaCount: CHATGPT_SUBMIT_FAILED: composer shows
                                                    N attachment(s), expected M
       Phase 1 — best-effort: chatgptEnableImageMode (false → prepend
                  fallbackPrefix to prompt); chatgptSetRatio(ratio) iff
                  image-mode actually engaged.
       Phase 2 — chatgptWaitForIdle(30s), preSubmitFileIds =
                  chatgptCollectFileIds(), preSubmitAssistantTurnCount =
                  chatgptCountAssistantTurns()  ← baseline locked here so
                  post-upload attachments are not counted as new results.
       Phase 3 — chatgptFindComposer(10s); chatgptClearEditor; insert via
                  paste / execCommand / innerHTML ladder; verify
                  textContent.includes(prompt.slice(0,20)) before submit.
       Phase 4 — pre-submit re-verify (visual counter): duplicate → fail.
       Phase 5 — chatgptFindSubmitButtonWithRetry(5s, 200ms);
                  chatgptIsButtonUsable. If usable, pointer-click. Else
                  chatgptSubmitExistingComposerFallbacks tries Enter →
                  pointerClick → form.requestSubmit.
       Phase 6 — verify submit via chatgptWaitForSubmitSignal(multi-signal):
                  editor cleared | spinner visible | stop-button visible |
                  send-button disabled | new assistant turn. If none of
                  those fire in 7s → CHATGPT_SUBMIT_UNVERIFIED.
       Phase 7 — POST-SUBMIT baseline: postSubmitAssistantTurnCount =
                  baselineAssistantTurnCountForClick; postSubmitFileIds =
                  preSubmitFileIds ∪ baselineFileIdsForClick;
                  postSubmitImageSignatures = baselineImageSignaturesForClick.

       Poll loop (~1s tick, sleep 1000ms each iteration; maxWaitMs cap):
         ─ entry heartbeat: phase='waiting_result', progressChanged=true
                          so background bumps lastProgressAt to start
                          (prevents "no-progress" false positive).
         ─ check extension context: if invalidated → fail CHATGPT.
         ─ chatgptIsGenerating → toggles phase 'generating'/'rendering';
           lastGenerating flip fires a phase-change heartbeat.
         ─ chatgptDetectTextOnlyError → CHATGPT returned text, not image.
         ─ chatgptCollectGeneratedImages(postSubmitFileIds,
           postSubmitAssistantTurnCount, postSubmitImageSignatures):
              if newImages.length > 0:
                if generating: heartbeat rendering, continue
                else: sendDone({ success: true, imageUrls, images })
                THIS is the result path. generating=true does NOT block
                result detection — image visibility wins.
         ─ pre-turn grace window: continue while we have not yet seen a
           new assistant turn (sawAnyProgress extends further).
         ─ pending-image marker: keep waiting (asset in flight).
         ─ no spinner + new turn + no pending + no images → render grace
           (30s) before "text-only reply" or "progress stale" verdict.
         ─ on hard fail: sendDone({ success: false, error, message }).

       On terminal state:
         safeSendFireAndForget({
           action: 'CHATGPT_JOB_DONE',
           jobId,
           payload: { success, imageUrls, images, error, message }
         })

background/index.ts — CHATGPT_JOB_DONE listener (registered at module load)
  ├─ payload.success && payload.images → store full ChatGPTGeneratedImage[]
  │  array. payload.imageUrls used as fallback when images[] is missing.
  ├─ on success + autoDownload: chrome.downloads.download one by one to
  │  `${outputFolder}/chatgpt-${timestamp}-${i}.png`, count `downloaded`.
  ├─ chrome.storage.session.set(jobs[jobId] = {
  │     status: 'done' | 'failed',
  │     imageUrls, images, downloaded, error, message, finishedAt
  │   })
  └─ persistent failure: error='Background handler crashed: …' is also
     persisted so retry-aware callers can show a real reason.

Meanwhile, the content script emits periodic CHATGPT_JOB_PROGRESS heartbeats.

background/index.ts — CHATGPT_JOB_PROGRESS listener
  ├─ lastHeartbeatAt = now (every heartbeat — proves script is alive)
  ├─ progressChanged? computed locally from prev vs new payload:
  │     phase string changed, generating flipped on, assistantTurns /
  │     candidateImages / acceptedImages bumped, hasPendingImage flipped
  │     on, lastAssistantTextLength grew, or payload.progressChanged.
  ├─ if progressChanged: lastProgressAt = now
  ├─ patch job.progress, persist.
  └─ debug log gated by DEBUG_FLAGS.chatgptHeartbeat ('AI_FLOW_DEBUG_CHATGPT_HB')

runner.ts — waitForChatGPTJob(jobId, timeoutMs)
  Polls GET_CHATGPT_JOB_STATUS every 1500ms. Three gates decide timeout:

  GATE A — heartbeat lost.
      lastHeartbeatAt>0 AND now - lastHeartbeatAt > 40s
      Throw "ChatGPT content script heartbeat lost: no update for Ns."

  GATE B — initial no-progress budget.
      !everSawProgress AND elapsedMs > max(payload.timeoutMs, 300s)
      Throw "Timeout waiting for ChatGPT result: no generation progress
             within Ns."

  GATE C — generation stalled after at least one advance.
      everSawProgress AND now - lastProgressAt > 90s (staleMs)
      AND !stillActive (not generating AND no hasPendingImage AND no candidates)
      Throw "Timeout waiting for ChatGPT result: progress stale for Ns."

  Hard-stale backstop.
      everSawProgress AND now - lastProgressAt > 180s (2×staleMs)
      — extends past any active signal, never wait forever despite heartbeats.
      Throw "…despite heartbeat."

  TIMEOUT edge case (from BG → content script reported 'failed' status).
      /timeout/i.test(errMsg) AND hasPendingImage → continue waiting.
      Re-running the Generate Node would re-upload refs → duplicates.
      Heartbeat-stale gate (A) is the real authority here.

  Termination.
      job.status === 'done' → return job (no hard timeout race for result).
      job.status === 'failed' → throw job.error.
  Phase-change logging (default-mode, debug off):
      Emits `[Runner] chatgpt phase: <phase> (Ns elapsed, job <id>)` ONLY
      when the phase string differs from the previous iteration. Verbose
      throttled dump of lastHeartbeatAgoMs / lastProgressAgoMs / candidate /
      accepted only fires under DEBUG_FLAGS.chatgptHeartbeat or
      DEBUG_FLAGS.runnerWait.
  Force in-flight job to fail on hard cap (maxWaitMs = max(timeoutMs, 600000)).

background/index.ts — chatgptCleanupExpiredJobs (SW startup)
  Running jobs older than CHATGPT_JOB_TTL_MS (30 min) → status='failed',
  error='Job hard timeout after 1800s'. Terminal jobs older than 30 min
  since finishedAt → deleted.

background/index.ts — extension reload cleanup
  reloadProviderTabsOnExtensionReload() reloads existing provider tabs on
  install / update / startup when stored version/build markers differ from
  the current manifest. This is gated — same bundle on later wake-ups
  are no-ops. Close-stale-workflow-editor runs unconditionally on install.
```

### Background actions


| Action                   | Behavior                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUN_CHATGPT_PROMPT`     | Open/inject ChatGPT tab, persist job state, kick off content script, return `{ success, accepted, jobId }` immediately. `payload.focus` defaults to `true` (GenPanel); pass `focus:false` from workflow callers. Reuses an in-flight job by `requestFingerprint` hash and dedupes via `chatgptSubmitFlights` Map while the submit is mid-flight. |
| `CHATGPT_JOB_DONE`       | Receive from content script: run auto-downloads, persist full `images[]` + `imageUrls[]` + `downloaded` + terminal status. Failure path also persists the message string for the runner.                                                                                                                                                                                |
| `CHATGPT_JOB_PROGRESS`   | Heartbeat. Always bumps `lastHeartbeatAt`. Bumps `lastProgressAt` ONLY when counters / phase / spinner actually advance. Per-poll debug dump gated by `DEBUG_FLAGS.chatgptHeartbeat`.                                                                                                                                                                                |
| `GET_CHATGPT_JOB_STATUS` | Read job state from `chrome.storage.session` (local fallback), return full `ChatGPTJobState`. Runner polls every 1500ms while waiting.                                                                                                                                                                                                                               |
| `CHATGPT_PING`           | Health check used by `ensureChatGPTContentReady` to verify the content script listener is alive before firing `CHATGPT_SUBMIT_AND_WAIT`. Returns `{ success, provider, url }`.                                                                                                                                                                                          |

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
  images?: ChatGPTGeneratedImage[]  // full payload from content script
  downloaded: number
  error: string
  message?: string
  tabId?: number
  requestFingerprint?: string  // dedupe: same (prompt, ratio, mediaUploads,
                              // autoDownload, outputFolder) within TTL
  /** Wall-clock of the latest CHATGPT_JOB_PROGRESS. Bumped on every
   *  heartbeat. Used by the runner to detect a dead content script
   *  (no updates for >40s = context invalidated or tab crashed). */
  lastHeartbeatAt?: number
  /** Wall-clock of the latest REAL generation advance (phase change,
   *  spinner flip, image / turn / text count bump). Plain heartbeats
   *  do NOT bump this — heartbeats alone prove liveness, not advance.
   *  Used by the runner to detect the generation itself has stalled. */
  lastProgressAt?: number
  /** Latest progress payload from the content script. See
   *  ChatGPTJobProgress below. */
  progress?: ChatGPTJobProgress
  /** True when content script detected a partial image render that
   *  never completed within the polling window. The runner reads
   *  this to skip node-level retry even when the error is "TIMEOUT"
   *  — re-running would create duplicate attachments. */
  hasPendingImage?: boolean
}

interface ChatGPTJobProgress {
  phase?: 'pre_upload' | 'uploading' | 'submitting'
        | 'waiting_result' | 'generating' | 'rendering' | 'done' | 'failed'
  generating?: boolean
  assistantTurns?: number
  candidateImages?: number   // candidate without spinner / full render
  acceptedImages?: number    // accepted (post-spinner, dedupe-clean)
  hasPendingImage?: boolean
  elapsedMs?: number
  lastAssistantTextLength?: number
  /** True when the heartbeat represents a real generation advance —
   *  phase change, spinner flip, count bump, etc. Background uses
   *  this to decide whether to bump `lastProgressAt`. */
  progressChanged?: boolean
  lastMessage?: string
}
```

Stored under key `chatgptJobs` in `chrome.storage.session` (Chrome 102+ MV3). Falls back to `chrome.storage.local` if session fails. Terminal jobs (done/failed) are dropped after 30 minutes by `chatgptCleanupExpiredJobs()` on SW startup. Running jobs older than `CHATGPT_JOB_TTL_MS` (30 min) are force-failed.

### Multi-image upload (composer-scoped batch)

Reference images for ChatGPT go through a **batch file input path** that
fires a single `input` + `change` event with N files at once. The legacy
per-item paste upload (P1/P2 via `ClipboardEvent` → `Event('paste')` with
`clipboardData` getter) is documented in `uploadImage(...)` and is invoked
**only** as a single-image fallback when the batch fails.

```
Multi-image rules (strict):
  mediaCount > 1:
    PRIMARY (and only) PATH    uploadImagesBatchViaFileInput
    Failure                   CHATGPT_SUBMIT_FAILED: batch upload failed: …
                              NO legacy P1/P2 fallback. Re-running the
                              Generate Node would re-upload refs and
                              produce duplicate attachments.

Single-image rules:
  mediaCount === 1:
    PRIMARY PATH              uploadImagesBatchViaFileInput
    Failure                   chatgptRemoveComposerAttachmentsOnly first,
                              then loop uploadImage(dataUrl, { beforeCount,
                              expectedTotalCount: 1 }).
    Reason for single-image fallback being safe:
                              P1's deferred commit never queues with a
                              sibling P2 (only one item is in flight).
```

Pre-upload cleanup runs unconditionally so a stale leftover from a prior
attempt cannot inflate the post-upload count and trip the duplicate
detector. After batch upload, `chatgptCountVisualComposerAttachments`
re-counts and re-applies the duplicate / incomplete guards:

- `actual === mediaCount`: ok, continue to Phase 1.
- `actual > mediaCount`: hard fail
  `CHATGPT_SUBMIT_FAILED: duplicate attachments detected`.
- `actual < mediaCount`: hard fail
  `CHATGPT_SUBMIT_FAILED: composer shows N attachment(s), expected M`.

`chatgptCountVisualComposerAttachments` (composer-scoped visual counter):

- Walks only the composer root (`chatgptGetComposerRoot`).
- Skips anything inside `[data-message-author-role]` (chat history).
- Counts:
  - buttons whose accessible name contains remove / delete / close /
    dismiss / xóa / xoá, OR
  - `<img>` whose src is `blob:` / `data:` OR ≥ 48px on either axis.
- Dedupes so a parent tile containing both kinds is counted once.

Pre-submit re-verification (Phase 4 above) applies the same guard again
so any ChatGPT-side rendering between upload and submit cannot inflate
the count and cause duplicate submit.

### Reference images for ChatGPT

GenPanel lets the user attach reference images to a ChatGPT run. The flow is
**different from Flow** — there is no intermediate tileId; the content script
uploads the bytes directly to the ChatGPT composer.

```
runner.ts → runChatGPTGenerate
  prepares mediaUploads[]: { name, type, base64 } after resolving URL inputs
  via resolveMediaUrlToData (data: pass-through; http(s) → fetch → FileReader)
  chrome.runtime.sendMessage({ action: 'RUN_CHATGPT_PROMPT', payload: {
      prompt, ratio, fallbackPrefix, autoDownload, timeoutMs, mediaUploads,
      focus: false
  } })

background/index.ts — runChatGPTPrompt()
  forwards payload.mediaUploads as-is in CHATGPT_SUBMIT_AND_WAIT

content-script.ts — runChatGPTJob()
  pre-upload composer cleanup (if mediaCount > 0)
  uploadImagesBatchViaFileInput(mediaUploads, jobId)
  visual count verify against mediaCount
  pre-submit visual count re-verify
  prompt insert + send + result detection
```

**`ChatGPTPromptPayload.mediaUploads`** is `{ base64: string; type: string; name?: string }[]`.
**Real tileIds (non-`upload_xxx` refs) are NOT forwarded** — the bytes are not
available on the runner side, so re-sending them is impossible. The Flow
`resolveReferenceImagesBeforeRun()` path must NOT be reused for ChatGPT.

**Reference Images UI in GenPanel** is shown for both providers. The
Flow-only sub-pieces (`refMode` select, "Drag to reorder" hint) are internally
gated by `activeProvider === 'flow'`. The upload bar, count, image grid, and
remove button work for both providers.

**Quantity and `Auto`/`Manual` mode are Google Flow only.** ChatGPT does NOT
accept a `quantity` field; the runner never forwards it via ChatGPT
`mediaUploads`. ChatGPT does not have an Auto/Manual toggle — submitting IS
the run, and the runner awaits `CHATGPT_JOB_DONE` before continuing.

### GenPanel polling contract (direct ChatGPT run)

```
1. RUN_CHATGPT_PROMPT → receives { jobId }
2. Poll GET_CHATGPT_JOB_STATUS every 1.5s while status === 'running'
3. Poll timeout: 600s (MAX_POLL_MS)
4. Progress text: '[ChatGPT] Generating... {elapsed}s' every ~3s
5. Terminal: status === 'done' → setGenStatus('done')
             status === 'failed' → setGenStatus('idle') + alert(error)
```

### Workflow runner wait contract

`waitForChatGPTJob(jobId, timeoutMs)` in `runner.ts` is the authoritative
waiting path for Workflow Generate Nodes. Polling cadence is 1.5s. The
runner never calls `uploadImage` directly for ChatGPT — it sends the full
`mediaUploads[]` over the boundary and lets the content-script runner own
the upload pipeline.

`timeoutMs` defaults to `max(payload.timeoutMs, 300000)` and the hard cap
is `max(timeoutMs, 600000)` (`maxWaitMs`). Plain phase-change logs are the
only debug-free output; only `DEBUG_FLAGS.chatgptHeartbeat` /
`DEBUG_FLAGS.runnerWait` produces the per-poll counter dump.

On `status === 'failed'` with `/timeout/i` AND `hasPendingImage === true`,
the runner **continues waiting** rather than letting the runner-level catch
block re-run the Generate Node (which would re-upload refs and create
duplicate attachments). The heartbeat-stale gate eventually takes over.

### Non-retryable Generate Nodes (chatgpt + google-flow)

`runner.isNonRetryableGenerateNode(node)` short-circuits the catch block's
node-level retry loop for **ANY** Generate Node (both ChatGPT and Google
Flow, regardless of whether it has reference-image uploads). The runner
logs the cause, marks the workflow failed with `recoverable: false`, and
breaks the pipeline. The user must explicitly click Run again on the
workflow to retry — the runner never silently re-dispatches
`RUN_FLOW_PROMPT` / `RUN_CHATGPT_PROMPT`.

Why ALL Generate Nodes (not just media-bearing ones):

- Google Flow: every `RUN_FLOW_PROMPT` creates new tiles in the Flow
 tab. Re-running the node produces ANOTHER set of tiles.
 `AUTO_DOWNLOAD_NO_SUCCESSFUL_RESULTS` on a bare Generate node
 (no refs, `quantity=1`) used to retry via `i--; continue`, each
 retry stamping a new tile. `baselineIds=4→5→6` was that symptom.
- ChatGPT: a retried Generate re-uploads any refs (N×attempts
 duplicates) AND submits the composer again, producing a second
 turn of images. Same hazard, different surface.

Per-step recovery (tab complete, content-script ping, find composer,
find send button) still happens INSIDE the provider path; the gate
here only closes the cross-node retry loop.

### Workflow runner execution order (lazy dependency plan)

`runner.run()` does NOT use a textbook Kahn topological sort that pops
every in-degree-zero node first. The legacy `getSortedNodes()` is computed
for logging comparison, but the **actual execution order** is built by
`buildLazyExecutionPlan(pickExecutionTargets())`:

1. `pickExecutionTargets()` returns the workflow's **terminal nodes** —
   nodes with no outgoing edges. If every node has outgoing edges (e.g. a
   feedback loop), fall back to using all enabled nodes as targets.
2. `buildLazyExecutionPlan()` does a **stack-based post-order DFS** from
   those terminals, walking each target's incoming edges in priority order:
   - `generate` nodes first, then `image` / `video` media nodes, then
     everything else.
   - Tie-break by canvas position `(x, y)` and original index.
3. The resulting plan executes a node's **direct upstream only when the
   downstream node is about to run**, so the lifecycle of a leaf source
   (e.g. an unrelated `Media Node`) does not visually "complete" before
   its real downstream chain finishes.

Why the lazy plan matters:

For the topology `M1 → G1`, `P1 → G1`, `G1 → G2`, `M2 → G2`, `P2 → G2`:

- Kahn legacy order: `[M1, P1, M2, P2, G1, G2]` — M2/P2 light up
  "completed" while G1 is still rendering.
- Lazy order: `[M1, P1, G1, M2, P2, G2]` — M2/P2 only run after G1
  finishes, so the visual lifecycle matches user intent.

Cycle handling: if the DFS stack revisits a node already in flight, the
edge is skipped with `[SchedulerDebug][Runner] cycle detected` rather than
looping forever. Kahn's strict cycle rejection is replaced by tolerant
skip; the workflow still completes its reachable subset.

The lazy plan replaces the legacy Kahn sort. Do not reintroduce a
fresh-Kahn-only execution path: that bug keeps coming back because the
"fire M2/P2 early" symptom is purely a UI timing issue, not a correctness
issue. The fix lives in scheduling, not in CSS.

### Lazy plan invariants (do not regress)

- Terminal-first DFS is the only execution order. The legacy Kahn order
  is logged (and visible under `[SchedulerDebug]`) but never executed.
- Incoming-edge priority is `generate > image/video > other`, tie-broken
  by `(x, y)` then original index. Do not re-sort to position-only.
- Cycle edges are skipped with a `[SchedulerDebug]` warning, not thrown.
  The runner-level catch still surfaces the failure if a downstream
  reads a missing context.
- `pickExecutionTargets()` returns terminals; if no terminal exists
  (closed feedback loop), fall back to ALL enabled nodes, NOT to a
  shuffled / position-sorted order.

### Known v1 limitations

- **Closing/reopening the panel does not resume running ChatGPT jobs.** GenPanel has no job recovery on mount. Jobs continue running in the chatgpt.com tab and write to storage, but no UI is watching to collect the result.
- **Image mode / aspect ratio**: `chatgptEnableImageMode()` and `chatgptSetRatio()` are best-effort. Failures are logged and do not abort the job.
- **DOM selector drift**: ChatGPT's React DOM changes frequently. The selectors in `chatgptFindSubmitButton`, `chatgptIsGenerating`, `chatgptEnableImageMode` are best-guess and may need updating.
- **Multi-image strict path**: if the batch file input fails for a multi-image job, the job fails hard rather than retrying through per-item paste. This is intentional (see above).
- **`generating=true` does NOT block result detection.** As soon as
  `chatgptCollectGeneratedImages` returns ≥1 image that is not in the
  post-submit baseline, the content script posts `CHATGPT_JOB_DONE` with
  `success: true`. We do not wait for the spinner to drop first.

### Files involved


| File                                       | Role                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `src/background/index.ts`                  | Job registry, storage, `RUN_CHATGPT_PROMPT` / `CHATGPT_JOB_DONE` / `CHATGPT_JOB_PROGRESS` / `GET_CHATGPT_JOB_STATUS`     |
| `src/contents/content-script.ts`           | `CHATGPT_SUBMIT_AND_WAIT` listener, `runChatGPTJob`, batch upload, visual counter, result detection, `CHATGPT_JOB_DONE` |
| `src/components/gen/GenPanel.tsx`          | Direct ChatGPT submission + polling loop (GenPanel-only)                                                                  |
| `src/pipeline/runner.ts`                   | Workflow Generate Node ChatGPT execution + heartbeat-based wait (`waitForChatGPTJob`)                                     |
| `src/lib/debug.ts`                         | Shared `DEBUG_FLAGS` for chatgptHeartbeat / runnerWait / seq / etc.                                                      |


### What NOT to touch (ChatGPT v1)

These are the load-bearing ChatGPT files. Touching them without explicit
instruction is the most common way ChatGPT regressions slip in.

- `src/contents/flow-content.ts` — Flow-only orchestration.
- `src/contents/flow-slate-bridge.ts` — Flow-only MAIN-world bridge.
- `src/contents/content-script.ts` — ChatGPT content script (the only
  ChatGPT content file; there is no separate `chatgpt-content.ts` or
  `chatgpt-bridge.ts` — the project collapsed them into one bundle).
- `src/background/index.ts` — ChatGPT job registry / heartbeat routing /
  download handler.
- `src/pipeline/runner.ts` — Workflow Generate Node ChatGPT execution
  + `waitForChatGPTJob` (heartbeat-driven, three-gate, non-retryable
  generate node logic).
- `src/lib/debug.ts` — Shared `DEBUG_FLAGS` (`seq`, `chatgptHeartbeat`,
  `runnerWait`, etc.). Changing the master / per-flag fan-out breaks
  every debug-gated log site.
- `FLOW_*` actions.
- `RUN_FLOW_PROMPT` from the ChatGPT path.
- `uploadImage(...)` legacy P1/P2/A/B/C ladder re-enabled for multi-image.
- Visual counter swapped for the broad composer counter (it leaks chat
 history and breaks the duplicate guard for legitimate uploads).

## Canvas Drag Investigation Flag (temporary)

Investigation-only flag store at `src/lib/canvasInvestigate.ts`. NOT
part of the master `AI_FLOW_DEBUG` fan-out. Used to diagnose the
canvas flicker / line jitter symptom during node drag.

Enable / disable:

```js
localStorage.setItem('AI_FLOW_DEBUG_CANVAS_INVESTIGATE', '1') // enable
localStorage.removeItem('AI_FLOW_DEBUG_CANVAS_INVESTIGATE')    // disable
```

When enabled, probes emit `[CanvasInvestigate][<event>]` lines
covering `hydrateDrawflow`, `nodeMoved`, `dragEnd`,
`updateNodePosition`, `updateNodePositions`, `dataSignatureEffect`,
`rerenderDrawflowNode`, and `connectionRefresh-schedule/execute`.
All probes are observation-only — no production behavior is changed.
Remove the flag store once the flicker investigation is closed.

## Debug Flags

All extension-side verbose logs route through `src/lib/debug.ts` and its
`debugLog(flag, …)` / `debugWarn(flag, …)` helpers. `DEBUG_FLAGS` is read
once at bundle evaluation time from `localStorage`, with a `refreshDebugFlags()`
re-read for hot-flips in long-running loops. There is **no master "all logs on"
switch per file** — there is one master (`AI_FLOW_DEBUG`) that fans out to
every per-flag key.

`src/lib/debug.ts` exposes these flags (default `false`):

| Flag (DEBUG_FLAGS key)  | localStorage key              | Default logs gated                                                                                                                  |
| ----------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `nodeState`             | `AI_FLOW_DEBUG_NODE_STATE`    | `[NodeStateDebug]` — node visual-state transitions.                                                                                  |
| `glow`                  | `AI_FLOW_DEBUG_GLOW`          | `[GlowDebug]` — node / edge glow lifecycle.                                                                                          |
| `edgeFlow`              | `AI_FLOW_DEBUG_EDGE_FLOW`     | `[EdgeFlowDebug]` — incoming/outgoing edge active / inactive events with reasons.                                                   |
| `scheduler`             | `AI_FLOW_DEBUG_SCHEDULER`     | `[SchedulerDebug]` — lazy-dependency execution plan and DFS dep list.                                                               |
| `seq`                   | `AI_FLOW_DEBUG_SEQ`           | `[SeqDebug]` — sequential-multi-generate duplicate-attachment diagnostics in runner / BG / content-script.                         |
| `chatgptHeartbeat`      | `AI_FLOW_DEBUG_CHATGPT_HB`    | Per-poll `[ChatGPT][Background] job heartbeat` and `[Runner] wait chatgpt job` dumps.                                                |
| `runnerWait`            | `AI_FLOW_DEBUG_RUNNER_WAIT`   | Per-poll `[Runner] wait chatgpt job` counter dumps (alias for `chatgptHeartbeat`).                                                   |

Enable / disable per flag:

```js
localStorage.setItem('AI_FLOW_DEBUG_NODE_STATE',  '1')  // enable one flag
localStorage.setItem('AI_FLOW_DEBUG_SEQ',         '1')  // enable another
localStorage.removeItem('AI_FLOW_DEBUG_NODE_STATE')    // disable that one

// Master switch — turns ALL flags on:
localStorage.setItem('AI_FLOW_DEBUG', '1')

// Master off — clear all AI_FLOW_DEBUG_* keys:
localStorage.removeItem('AI_FLOW_DEBUG')
for (const k of [...localStorage.keys()].filter(k => k.startsWith('AI_FLOW_DEBUG_'))) localStorage.removeItem(k)
```

### Per-file legacy flags (Flow only)

Two legacy flags still exist for Flow-specific verbose logs and are NOT
managed by `src/lib/debug.ts`:

| File                              | Flag                       | How to enable                                                                                                 |
| --------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `flow-slate-bridge.ts`            | `FLOW_DEBUG_VERBOSE`       | `localStorage.setItem('FLOW_DEBUG_VERBOSE', '1')` or `window.__FLOW_DEBUG_VERBOSE__ = true`                   |
| `flow-content.ts`                 | `FLOW_DEBUG_VERBOSE`       | same                                                                                                          |
| `flow-content.ts`                 | `FLOW_DEBUG_SETTINGS`      | same pattern — gates `[settings result]`, `[RUN_FLOW_PROMPT_PAYLOAD]`, `[REFS_NORMALIZED]`, etc.              |

`FLOW_DEBUG_VERBOSE` is also honored by `src/contents/content-script.ts`
(ChatGPT side) as a legacy alias for the `[SeqDebug]` gate, in addition to
the new `DEBUG_FLAGS.seq`. `src/contents/content-script.ts` reads:

```js
FLOW_DEBUG_VERBOSE     // legacy alias for [SeqDebug] / [UploadDiag] / [CountDiag] / [Collect]
window.__FLOW_DEBUG_VERBOSE__   // mirror flag for the page console
```

### Background debug flag

`background/index.ts` reads only `AI_FLOW_DEBUG` (no per-flag support there
because the SW has no `window`). `BG_DEBUG = (typeof localStorage !==
'undefined' && localStorage.getItem('AI_FLOW_DEBUG') === '1')`, evaluated
once at bundle load. `window.__AI_FLOW_DEBUG__` does NOT work in a service
worker.

### Default behavior (debug off)

Concise logs visible in console (lifecycle / sentinels only):

```
[Bridge] BUILD_TIME 2026-07-17 21:30:00
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
[Provider][BG] openProviderTab provider=chatgpt …
[ChatGPT][Background] tab opened/focused tabId=…
[ChatGPT][Background] ensuring content script tabId=… status=complete
[ChatGPT][Background] content ping ok provider=chatgpt
[ChatGPT][Background] job persisted: cgpt_…
[ChatGPT][Background] CHATGPT_SUBMIT_AND_WAIT sent tabId=… jobId=…
[ChatGPT][Background] job done — image count: N
[ChatGPT][Background] Downloaded N of M
[ChatGPT][Job] media batch upload start / result
[ChatGPT][Job] composer attachments counted / send button lookup start
[ChatGPT][Job] prompt insert verified / submit verified / result detected
[ChatGPT][Job] CHATGPT_JOB_DONE sent { success: true, imageCount: N }
[ChatGPT][BatchUpload] start / change dispatched / settle done
[Runner] start workflow: <name>
[Runner] chatgpt phase: <phase> (Ns elapsed, job <id>)   ← only on phase change
[Runner] chatgpt job done (Ns, N images, job <id>)
```

The following prefixes are **silent by default** and only appear when their
flag is enabled:

- `[NodeStateDebug]`
- `[GlowDebug]`
- `[EdgeFlowDebug]`
- `[SchedulerDebug]`
- `[SeqDebug]` (gated by `DEBUG_FLAGS.seq`; legacy alias `FLOW_DEBUG_VERBOSE`)
- `[ChatGPT][UploadDiag]`, `[ChatGPT][CountDiag]`, `[ChatGPT][Collect] rejected/...`
  (gated by `FLOW_DEBUG_VERBOSE` / `DEBUG_FLAGS.seq`)
- `[ChatGPT][Background] job heartbeat` (gated by `DEBUG_FLAGS.chatgptHeartbeat`)
- `[Runner] wait chatgpt job` per-poll counter dump (gated by
  `DEBUG_FLAGS.chatgptHeartbeat` or `DEBUG_FLAGS.runnerWait`)

### What is gated behind debug flags (canonical list)

`flow-slate-bridge.ts` (`FLOW_DEBUG_VERBOSE`) — via `bridgeDebug()`:

- `[Bridge] Message:` / INSERT/CLEAR/verify per-call details
- `[Bridge][tileIdentity] getTileSnapshot` — polling heartbeat
- `debugRunFlowPrompt` / submit-bearing `__flowTest*` helpers return
  `FLOW_ADMISSION_REQUIRED`; manual direct submit is disabled
- `__flowDebugSelectedStates` details
- `__flowTest*` (manual test helpers)
- `__flowDebugScan` verbose DOM dump
- Upload, addRef, download, settings panel verbose details

`flow-content.ts` (`FLOW_DEBUG_VERBOSE`) — via `flowDebug()`:

- `debugRunFlowPrompt` routes through background `RUN_FLOW_PROMPT` admission
- `[BASELINE]`, `[BASELINE_FILE_NAMES]` — pre-submit tile snapshot
- `[REF_IDENTITY]` — ref image set
- `[RESULT_DETECT]` — per-poll cycle diagnostics
- `[FAILED_SIGNAL_DEBUG]` / `[PENDING_SIGNAL_DEBUG]` / `[SUCCESS_SIGNAL_DEBUG]`
- `[RESULT_ORDER_DEBUG]` — candidate ordering
- `[VIDEO_RESULT_CLASSIFY]` — video classification
- `[AUTO_DOWNLOAD_VIDEO_PROVISIONAL_CONFIRMED]`
- `__flowDebugScan` verbose DOM dump (with short non-verbose fallback when debug off)

`flow-content.ts` (`FLOW_DEBUG_SETTINGS`) — via `settingsDebug()`:

- `[settings result]` — applySettings response
- `[RUN_FLOW_PROMPT_PAYLOAD]` — raw payload on receipt
- `[GEN_DEBUG_STATE_FROM_PAYLOAD]` — state parsed from payload
- `[REFS_NORMALIZED]` — ref normalization
- `[APPLY_SETTINGS_TARGET]` — settings being applied

`background/index.ts` (`BG_DEBUG` via `AI_FLOW_DEBUG`):

- Every `chrome.runtime.onMessage` received action
- Bridge ping response
- Script injection steps
- Bridge ready check poll

`runner.ts` (`DEBUG_FLAGS.scheduler` / `edgeFlow` / `glow`):

- `[EdgeFlowDebug][Runner] node start/complete/failure cleanup`
- `[GlowDebug][Runner] start/complete/fail/edgeActive/edgeInactive`
- `[SchedulerDebug][Runner] execution plan / execute deps / execute node /
  cycle detected`

`runner.ts` (`DEBUG_FLAGS.seq`):

- `[SeqDebug][Runner] resolved generate inputs / chatgpt payload`
  (sequential-multi-generate duplicate-attachment diagnostic)

`background/index.ts` ChatGPT paths (`DEBUG_FLAGS.seq`):

- `[SeqDebug][BG] chatgpt prompt payload / job done / job done (failure path)`
  (sequential-multi-generate duplicate-attachment diagnostic)

`background/index.ts` ChatGPT heartbeat (`DEBUG_FLAGS.chatgptHeartbeat`):

- `[ChatGPT][Background] job heartbeat` — per-poll counter dump (silent by default)

`runner.ts` `waitForChatGPTJob` (`DEBUG_FLAGS.chatgptHeartbeat` /
`DEBUG_FLAGS.runnerWait`):

- `[Runner] wait chatgpt job` per-poll counter dump (silent by default)
- `[Runner] chatgpt job done (verbose)`, `heartbeat lost (verbose)`,
  `no-progress timeout (verbose)`, `stale timeout (verbose)`,
  `hard-stale timeout (verbose)`

`content-script.ts` ChatGPT verbose (`FLOW_DEBUG_VERBOSE` /
`DEBUG_FLAGS.seq`):

- `[SeqDebug][ChatGPT] job start / cleanup / post-upload visual count /
  pre-submit visual count / duplicate detected`
- `[ChatGPT][UploadDiag]` per-strategy trace inside `uploadImage`
- `[ChatGPT][CountDiag]` broad counter dump
- `[ChatGPT][Collect] assistantTurns=… candidateImages=… acceptedImages=…
  scanned=…` + `rejected / rejected#…` per-reason dump

`GenPanel.tsx` (`GP_DEBUG` via `AI_FLOW_DEBUG`):

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

Expected: `2026-07-17 21:30:00` (matches `FLOW_BRIDGE_BUILD_TIME` in `flow-slate-bridge.ts`).

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
