# M9R Phase 0 runtime baseline — 2026-10-28

## Scope

This is a safety checkpoint, not a rollback or cleanup. The worktree was already substantially dirty before this pass. No reset, checkout, deletion, dependency reinstall, provider login, browser-route change, or machine-setting change was performed. Phase 0 is complete; later recovery changes are tracked separately in `M9R_RUNTIME_RECOVERY_PHASES_0_7.md`.

The only runtime change in this pass is diagnostic: CUA now emits a separate `cursor-visible` timing event for the bounded compositor poll. The event records `durationMs` plus `attempts`, `maxAttempts`, and `intervalMs`; the existing fail-closed behavior and error messages remain unchanged. The durable stage-timing validator now accepts that already-defined phase, and the task-stage bridge preserves its bounded detail.

## Baseline evidence

### Provider state

- **Codex T20**: persisted result was `Provider session failed: Codex worker exited with code 1`. The managed-provider diagnostic stream contains repeated `thread/start: the Codex app-server is not running`, `thread/resume: ... already has an active writer`, 60-second no-response timeouts, oversized app-server messages, and a separate Codex usage-limit response. This proves a runtime/app-server failure family with stale-writer and timeout contention; it does not prove which one was the final cause of T20 because the adapter did not retain that worker's stderr.
- **OpenCode T21**: persisted provider error is the exact `Free usage limit reached` response. This is provider quota state, not evidence of a worker crash. The task was nevertheless recorded as `done`/`completed`, which is a receipt-integrity defect for Phase 2.
- **Legacy Codex T1**: failed before provider work because no active M9R identity existed in the old `restore-managed-provider` worktree. This is stale legacy routing, not evidence that the current managed Codex runtime is healthy or unhealthy.
- **Claude T4**: remains in old `sending` state against a superseded identity. It is evidence for reconciliation/run-fencing work, not a task to replay.

### Desktop/CUA state

The existing `test:desktop-stage` baseline completed 84 tests with 65 passing and 19 failing. Many of the failures stop at exact cursor-position confirmation (for example, expected window-local coordinates versus a screen-space value); the overlay-absent test therefore cannot reach the compositor visibility assertion. This is why the historical red overlay notice cannot honestly be attributed to one lower-level cause from the old evidence alone.

Phase 0 now emits and persists a distinct `cursor-visible` event. A regression test proves that a six-attempt, 150 ms bounded miss records an error event with the configured attempt cost while still rejecting the action. That gives the next live reproduction enough evidence to distinguish:

1. position proof failed;
2. the compositor poll was attempted and became visible; or
3. the compositor poll exhausted its bounded 900 ms window.

## Verification performed

- `npm run typecheck` — passed before the Phase 0 diagnostic addition.
- Managed provider recovery/supervisor/Codex/OpenCode test group — 26/26 passed before the Phase 0 diagnostic addition.
- New focused Phase 0 test — passed: `records compositor visibility as a separate privacy-safe timing phase`.
- `npm run test:desktop-stage` — baseline remains 65/84 (19 failures) because the existing dirty CUA implementation and its fixtures are already out of contract. Phase 0 did not mask or rewrite those failures.

## Important conclusion

The evidence does not support one universal “broker is dead” explanation. There are at least four independent classes: Codex runtime/app-server failure, OpenCode provider quota, stale/incorrect receipt completion, and CUA position/visibility gates. Phase 0 is complete only as an evidence checkpoint; the actual provider, receipt, stop/fencing, and CUA repairs belong to Phases 1–4 and must be implemented and verified separately.
