# M9R Phase 9 — latency, readiness, and quiet updates

Phase 9 makes the existing runtime and pill paths more measurable and less
chatty without changing provider routing, browser-control identity, or the pill
layout.

## Runtime proof cache

`runtime-readiness.ts` stores a bounded proof of a live logical connection. A
proof is bound to the connection ID, handle, provider, project folder, runtime
generation, build fingerprint, and broker epoch. A status string alone never
qualifies as proof. On a cache miss the supervisor still asks the adapter for a
live readiness result; only a healthy result is cached. Transport failures,
health failures, stop/drain boundaries, build changes, and broker replacement
invalidate the proof. No process ID, token, continuation, prompt, or provider
payload is cached.

## Quiet UI delivery

The web UI bridge still uses the existing 100 ms newest-state debounce, but it
now suppresses a frame when its bounded state fingerprint is unchanged. Session
rows are read once per snapshot instead of repeatedly. Identical streamed
fragments are ignored during the merge window, while the existing final-result
replacement behavior remains intact. `uiMetrics()` exposes only counters for
diagnostics (`changeSignals`, `deliveredStates`, `coalescedStates`).

## Latency measurement

`latency-telemetry.ts` keeps a bounded rolling sample set and reports p50/p95
for dispatch-to-first-action and action completion, split into cold and warm
turns. The owner records these samples alongside its existing durable stage
timings. It stores durations and statuses only; task text and provider data are
never included. The owner exposes `latencySnapshot()` for later diagnostics.

## Lease notifications

The multiplayer mutation scheduler now supports subscriptions and
`waitForAvailability()`. Existing synchronous `begin()`/commit/abort semantics
are unchanged. A caller that receives `lease-unavailable` can wait for a lease
release or expiry notification rather than polling, with an optional abort
signal.

## Explicit non-goals

This phase does not start Codex or OpenCode, change the browser route, change
the CUA coordinate contract, remove legacy files, or redesign the pill. Full
provider/live-task testing remains the final verification phase after all
planned phases are source-implemented.

