# M9R canonical Phase 2 — run coordinator and stop behavior

Status: implemented on the Phase 0–1 checkpoint branch. This phase adds one
provider-neutral cancellation authority for a run. It does not replace the
existing provider adapters or browser-control route yet; later phases consume
the action signals at those boundaries.

## What is implemented

`src/lib/native/multiplayer-run-coordinator.ts` provides:

- one bounded coordinator for a 1–16-agent roster;
- queued, running, completed, and canceled operation state;
- stop-agent, stop-branch, and stop-run requests;
- cancellation of queued actions and AbortSignal cancellation of running
  actions, including desktop mutations represented as `mutate` operations;
- event-driven cancellation propagation to the affected agent set;
- a late-result fence: canceled operations cannot start or complete afterward;
- idempotent cancellation IDs and a read-only snapshot for diagnostics;
- no resume operation yet; resume is deliberately a later phase so a stopped
  run cannot be silently reactivated by stale provider traffic.

## Safety boundary

The coordinator validates run, branch, and agent ownership against the Phase 1
roster. It does not kill processes, move the owner cursor, touch provider
authentication, or mutate the current browser route. Provider and surface
adapters must consume the returned `AbortSignal` and re-check `isCurrent()`
before publishing a result; that is the mechanism that prevents late wakeups.

## Verification boundary

The Phase 2 regression cases cover isolated agent stop, whole-run stop, branch
isolation, sibling continuation, duplicate cancellation, queued-action fencing,
and late completion rejection. They are recorded in
`scripts/multiplayer-run-coordinator.test.ts` and intentionally remain
unexecuted until the final all-phase test pass, per the ordered implementation
instruction.
