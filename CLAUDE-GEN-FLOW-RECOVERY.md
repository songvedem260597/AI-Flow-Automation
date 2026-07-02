# CLAUDE Recovery Mode — Gen Tab Google Flow

## Current Goal

Restore the extension from the **Gen tab Google Flow path only**.

The app previously crashed after broad changes. The user reverted code, but the
build still fails with a `not defined` / undefined reference error and the
extension can no longer be clicked/opened reliably.

Do not continue feature work until the Gen tab path builds and opens again.

## Scope

Work only on the minimal path:

```text
GenPanel UI
  -> buildGenerationPayload()
  -> chrome.runtime.sendMessage()
  -> RUN_FLOW_PROMPT
  -> background/index.ts
  -> flow-content.ts
  -> flow-slate-bridge.ts
  -> Google Flow UI
```

Allowed files:

- `src/components/GenPanel.tsx`
- `src/background/index.ts`
- `src/contents/flow-content.ts`
- `src/contents/flow-slate-bridge.ts`
- small shared type/helper files only if the build error proves they are needed

Do not touch:

- Workflow Editor
- Workflow nodes/edges
- ChatGPT image pipeline
- auto-download pipeline unless the build error is directly inside imported code
- styling/design refactors
- project CRUD
- settings redesign

## First Priority: Fix Build

Before editing code:

1. Run the project build command.
2. Copy the exact error message, file, line, and identifier.
3. Search for the exact missing identifier.
4. Find whether it is:
  - a missing import
  - a renamed function/variable
  - a variable used before declaration
  - a function moved to another file
  - stale code left after revert
  - an export/import mismatch
5. Fix only the smallest cause.
6. Build again.

Do not guess. Do not rewrite files to “clean up”.

## `not defined` Debug Rules

For any `X is not defined` error:

```text
rg -n "X" src
rg -n "function X|const X|let X|var X|export .*X" src
rg -n "import .*X|X," src
```

Then inspect the surrounding code.

Common causes in this project:

- a helper was deleted during revert but callers remain
- a function was renamed in one file but old name remains elsewhere
- `const`/`let` is referenced before declaration inside a React component
- JSX references a variable declared inside a conditional block
- an import path points to a file that no longer exports that symbol
- a top-level object references a component before the component is declared

Never “fix” this by changing `const`/`let` to `var`.

## Gen Tab Minimal Acceptance

The first stable milestone is:

```text
Extension builds
Extension popup / tab opens
Gen tab renders
Prompt input accepts text
Provider is Google Flow
Generate button can send RUN_FLOW_PROMPT
Background receives RUN_FLOW_PROMPT
flow-content.ts receives the job
flow-slate-bridge.ts can insert prompt into Google Flow
submit works or fails with a clear logged reason
```

Anything beyond this is out of scope until this milestone passes.

## Google Flow Rules To Preserve

Generation settings must come from:

```text
GenPanel UI State
```

Not from:

```text
Settings Tab DOM
```

Apply settings in this order:

```text
1. Model
2. Mode
3. Aspect Ratio
4. Quantity
5. Duration (video only)
6. Final Model Verification
```

Never move Slate editor discovery out of the MAIN world bridge.

`flow-slate-bridge.ts` must remain responsible for:

- React Fiber inspection
- Slate editor discovery
- prompt insert / clear
- Flow settings automation
- submit click

`flow-content.ts` must remain responsible for:

- receiving background messages
- calling the bridge
- orchestration in the ISOLATED world

## Dangerous Files

`flow-slate-bridge.ts` is fragile. Do not rewrite it.

If a change is required there:

1. Modify one small function.
2. Preserve fallback logic.
3. Preserve retries.
4. Preserve verification.
5. Build immediately after the change.

## Recovery Work Order

Follow this order exactly:

1. Build and capture the first error.
2. Fix only the first build error.
3. Repeat until build passes.
4. Open the extension UI.
5. If UI cannot open, inspect the browser console error.
6. Fix only the UI-open error.
7. Confirm the Gen tab renders.
8. Test Google Flow generation with one simple prompt.
9. Only after that, test settings: model, mode, ratio, quantity, duration.
10. Only after that, test reference images and auto-download.

Do not fix multiple unrelated areas in one pass.

## Reporting Format

After each pass, report:

```text
What failed:
Root cause:
Files changed:
Why this is the smallest fix:
Build result:
Next exact test:
```

If the exact root cause is not known, say so and keep investigating.

## Hard Stop Rules

Stop and ask before:

- rewriting `flow-slate-bridge.ts`
- deleting fallback logic
- changing message names/contracts
- changing `RUN_FLOW_PROMPT`
- touching Workflow Editor
- touching ChatGPT image generation
- changing build config
- replacing the UI architecture

