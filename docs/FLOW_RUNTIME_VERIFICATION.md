# Google Flow Manual Runtime Verification

This checklist verifies the Phase 2.6 diagnostics harness on a real, authenticated Google Flow project. The harness is observational: handshake, health probe, admission snapshot, admission dry-run, log reset, and report export do not generate media.

Do not use the public Flow landing page as evidence for project-composer or tile selectors. Composer results are meaningful only on an authenticated project page.

## Safety and data handling

Runtime diagnostics are off by default. In GenPanel, select **Google Flow**, open **Runtime Verification**, and switch **Runtime Diagnostics** to **ON**. Turning it on starts a new `runtimeSessionId`; every log in that test session uses the same ID.

Collected metadata may include timestamps, event names, session/job/tab IDs, source, admission transitions, build markers, URL origin and pathname, bridge/composer readiness, tile counts, warning categories, instance counts, and admission ownership. Tile IDs, filenames, media URL pathnames, and DOM fingerprints are hashed before export.

The report must not include prompt/editor text, cookies, authorization headers, tokens, request or response bodies, full media URLs, media query strings, email addresses, or full filenames. Export runs the sanitizer even when the in-memory records were already sanitized.

`Reset Diagnostic Logs` only clears the diagnostic session's logs, test results, captured errors, last handshake, and last health report. It does not reset or release Flow admission. The admission manual-reset control is separate and requires explicit acknowledgement.

## Reading results

The handshake reports independent background, ISOLATED content-script, and MAIN bridge markers. Each marker is `MATCH`, `MISSING`, or `MISMATCH`. A missing or stale layer is never reported as a successful handshake.

Health signals are reported individually as `pass`, `fail`, or `unknown`, with a reason, evidence source, and confidence. `unknown` means the signal could not be observed; it is never equivalent to `pass`.

The instance report is scoped to the current document. An old instance from an unloaded document is not a duplicate. Counts cover runtime message listeners, bridge-result listeners, the primary generation MutationObserver, active polling loops/tile monitor, and submit-capable handlers.

## A. Load the production extension

1. From the repository root, run `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Remove or disable any older AI Flow Automation unpacked entry that points to another build directory.
5. Click **Load unpacked** and select `build/chrome-mv3-prod` from this repository.
6. Record the extension ID shown by Chrome.
7. Open the extension's **service worker** inspector.
8. Confirm there is no startup exception. Do not dismiss an exception without recording it.
9. Open GenPanel, select **Google Flow**, switch **Runtime Diagnostics** to **ON**, and record the displayed `runtimeSessionId`.

Expected: diagnostics are on, a session ID is visible, and no Flow tab is created or focused by enabling the mode.

## B. Open an authenticated Flow project

1. Sign in with an authorized test account.
2. Open one existing Flow project that visibly has its composer.
3. Hard reload the project tab once.
4. Do not enter a prompt and do not click **Create** or **Generate**.
5. In the Flow page console, evaluate `window.__FLOW_BRIDGE_BUILD_TIME__`, `window.__FLOW_BRIDGE_BUILD_MARKER__`, and `window.__FLOW_BRIDGE_INSTANCE_ID__`. Record the values; do not edit them.
6. In GenPanel, click **Run Handshake**.
7. Confirm `backgroundReady`, `contentReady`, and `bridgeReady` are true.
8. Confirm all three marker statuses are `MATCH`.
9. Confirm `flowUrlValid` and `composerDetected` are true.
10. Confirm `duplicateBridgeDetected` and `duplicateListenerDetected` are false.
11. Click **Run Health Probe**. Review every signal; record every `fail` or `unknown` exactly as reported.
12. Click **Show Admission State** and record the state and owner, if any.
13. Click **Export Diagnostic Report** and keep this first JSON file unchanged.

Expected: no prompt is inserted, no settings are changed, no tile is created, and the page is not reloaded by the checks.

## C. Reload matrix without generation

Perform the following one at a time. After every step, reopen GenPanel if needed, run **Run Handshake**, run **Show Admission State**, and export or note the result before proceeding.

1. Normal page reload.
2. Hard reload.
3. Close the Flow tab and reopen the same project.
4. Duplicate the Flow tab; run the checks against the active duplicate, then close it.
5. Navigate to another route inside Flow and return to the project composer.
6. Reload the extension from `chrome://extensions`, reopen GenPanel, and ensure diagnostics are on. A new session ID after extension reload is expected.
7. Leave the service worker idle long enough for Chrome to suspend it, if Chrome permits, then reopen GenPanel.
8. Run the handshake again after the service worker wakes.

Record after every step:

- `runtimeSessionId`
- `bridgeReady`
- `duplicateBridgeDetected`
- `duplicateListenerDetected`
- all injection counts and duplicate flags
- admission state and owner
- background/content/bridge marker status

Expected: one active listener/submit handler per layer, no duplicate primary observer or polling loop, and old unloaded documents are absent from current-document counts. A missing layer must be `MISSING`, not `MATCH`.

## D. Busy detection without creating a new job

Only use this case if the project already has a processing/pending/generating tile that the authorized tester created independently before this check. Do not create media just to set up this case.

1. With the existing tile active, click **Run Health Probe**.
2. Confirm the corresponding processing, pending, or generating count is greater than zero.
3. Click **Admission Dry-Run**.
4. Confirm `dryRun` is true, `dispatched` is false, and `wouldAdmit` is false.
5. Confirm `statusReason` is `provider_busy_before_dispatch`, or an existing admission owner is reported.
6. Click **Show Admission State** and confirm the dry-run did not change its state or owner.
7. Export the report.

Expected: the request is rejected in the diagnostic decision before dispatch, with no prompt insertion and no new tile.

## E. Minimal image generation — only with explicit user permission

Do not perform this section unless the user explicitly authorizes one real image generation.

1. Confirm **Show Admission State** reports `idle`.
2. Use one harmless test prompt that contains no personal or confidential data.
3. Submit exactly one image job from GenPanel.
4. Do not retry and do not submit another image manually.
5. While the first job is active, send one different Google Flow Workflow request.
6. Confirm the second request is blocked before content dispatch with `flow_busy` or the existing owner.
7. Wait for the first job to reach a terminal result.
8. Confirm **Show Admission State** eventually reports `idle` after the terminal evidence and safety cooldown.
9. Export the report immediately.

Record the first owner job ID, second caller/source, admission transitions, dispatch count, terminal evidence, and release event. Do not paste the test prompt into the report or notes.

## F. Minimal video generation — only with explicit user permission

Do not perform this section unless the user explicitly authorizes one real video generation. Run it separately from the image case.

1. Confirm admission is `idle` and there is no active image job.
2. Submit exactly one harmless video job.
3. Do not retry and do not run an image job concurrently.
4. While it is active, send one different Google Flow Workflow request.
5. Confirm the second request is blocked before dispatch.
6. Wait for terminal evidence and confirm the mutex releases only afterward.
7. Export the report immediately.

## G. `stopPipeline` runtime cases

These cases can involve real media generation. Run each only with explicit permission and export a separate report per case. Start each case with a new diagnostic session by switching diagnostics off and back on.

### G1. Stop before submit

1. Start a workflow that has not yet crossed the Flow submit boundary.
2. Stop the pipeline before submit.
3. Confirm the admission becomes cancelled/terminal and releases without a Flow dispatch.
4. Export the report.

### G2. Stop immediately after submit starts

1. Start exactly one authorized job.
2. Stop immediately after submit starts but before confirmation.
3. Confirm the state remains conservatively `submit_uncertain`; it must not silently return to idle.
4. Export the report.

### G3. Stop while generation is processing

1. Start exactly one authorized job and wait until Flow visibly processes it.
2. Stop the pipeline.
3. Confirm caller cancellation does not claim that Flow generation was cancelled and does not release the mutex before terminal evidence/manual acknowledgement.
4. Export the report.

## Deliver the evidence

Provide the unchanged exported JSON file for each completed section, plus Chrome version, extension ID, the checklist steps actually run, and any visible error timestamp. Do not paste prompts, cookies, tokens, signed media URLs, or account email addresses into the message.

Phase 2.6 only prepares and collects evidence. It does not establish readiness for a recovery phase, and it does not implement a Recovery Controller, session refresh, network instrumentation, automatic reload, automatic resubmission, or anti-bot behavior.
