# Flow Recovery Controller (Phase 3)

`FlowRecoveryController` is a Google Flow-only health gate. It never submits a
prompt and never calls a generation endpoint. The only generation dispatch
path remains `FlowAdmissionController` -> background `RUN_FLOW_PROMPT` ->
`flow-content.ts`.

## State and admission

Recovery state is persisted in `chrome.storage.session` under
`flowRecoveryV1`. Admission is allowed only when recovery is `healthy`.
`transient_failure`, `rate_limited`, and `cooldown` require their persisted
deadline to expire and a fully healthy probe. `session_suspect`, `recovering`,
and `blocked` fail closed. An unknown probe never opens admission.

An interrupted `recovering` snapshot is restored as `blocked` after a service
worker restart because the previous callback can no longer prove completion.
Persistence failures are surfaced and make the recovery admission gate fail
closed; an unpersisted transition is not emitted as a real state change.

## Policy summary

| Error | Recovery behavior |
| --- | --- |
| `session_expired` | One policy-gated session refresh, bridge reconnect, health probe; otherwise block. |
| `rate_limited` | Exponential cooldown and health probe; no refresh or reload. |
| `unusual_activity` | Block for user review; no refresh or reload loop. |
| `generation_failed` | Transient cooldown; no refresh and no retry submit. |
| `generation_timeout` | Preserve uncertain ownership when applicable; read-only reconciliation only. |
| `composer_missing` | Loading/route -> transient; bridge failure -> reconnect; high session evidence -> session recovery; stable unknown DOM -> block. |
| `bridge_unavailable` | Reconnect/reinject and probe; no first-failure page reload. |
| `flow_busy` | Admission-only refusal; not a recovery incident. |
| `download_failed` | Separate download outcome; not a recovery incident. |
| `submit_uncertain` | Keep lock, reconcile read-only, require user action if not proven terminal. |

## Session refresh and reload limits

- Session refresh: at most one attempt per incident.
- Session refresh cooldown: 5 minutes, persisted across restart and manual reset.
- Incident frequency: at most two incidents in 30 minutes before blocking.
- Transient delay: 5s exponential backoff, capped at 60s, with 0.8-1.2 jitter.
- Rate-limit delay: 60s exponential backoff, capped at 10 minutes, with 0.8-1.2 jitter.
- Controlled reload: at most once per eligible high-confidence session incident,
  only after read-only revalidation/reconnect fails and no active or uncertain
  admission exists.

The MAIN-world `sessionRevalidate` action is deliberately observational. No
stable Flow router revalidation API is proven, so it reports unsupported
instead of guessing. The fallback may reconnect extension scripts and perform
one controlled page reload under the guards above. It does not restore prompt
text or click Generate.

## Runtime verification status

Phase 3 uses deterministic controller, persistence, race, policy, Wait Node,
and regression tests. Authenticated Google Flow health/reload behavior and the
known P0 risk that a second job might still generate have not been exercised by
this phase. No real generation was run.
