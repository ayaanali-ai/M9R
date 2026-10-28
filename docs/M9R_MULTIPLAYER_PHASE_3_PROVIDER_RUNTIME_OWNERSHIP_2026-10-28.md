# M9R Multiplayer — Phase 3: Provider Runtime Ownership

Status: source implementation complete for Phase 3; validation tests remain deferred until the user-approved end-of-phases verification pass.

## Runtime ownership boundary

The production desktop route is the M9R-owned path in `scripts/m9r-web-broker.ts` → `createManagedProviderOwner(...)` → `createManagedProviderSupervisor(...)`. Provider UI sessions are not the source of truth for this route. The supervisor owns one logical connection per normalized provider profile and persists only private continuation metadata needed to resume that connection.

The provider-specific runtime contracts remain separated:

- Claude uses one M9R-owned persistent live session per profile.
- OpenCode uses one M9R-owned ACP runtime/session per profile.
- Codex uses one M9R-owned app-server process and resumable thread per profile. The older per-turn worker adapter remains only for compatibility fixtures; the production owner does not select it.
- MCP uses the existing supervised stdio worker boundary. A private worker is reused for the pipe lifetime, recovery is bounded, and in-flight requests are reported as uncertain rather than replayed.

## Phase 3 hardening

`managed-provider-supervisor.ts` now coalesces concurrent startup/recovery requests for the same logical connection. Startup reconciliation and a delivery racing at the same time share one promise, so they cannot launch duplicate provider runtimes. Drain/stop waits for pending starts before stopping the exact connections owned by that supervisor.

Each adapter still owns its own liveness check and generation fence. If a provider process or transport dies while idle, readiness fails; the next owner request starts a new generation and uses the private continuation record where supported. A stale or late completion cannot replace a newer generation.

The Codex session handle now carries the provider-reported current model/effort alongside its model catalog. This is an additive runtime-state correction, not a model-picker UI change.

## Verification boundary

- Added supervisor coverage for concurrent-start coalescing and dead-runtime recovery.
- Existing Codex app-server coverage already exercises one persistent process/session across turns and recovery after an idle process death.
- The repository typecheck was run after the Phase 3 edits. Phase 3 introduced no new diagnostics; the pre-existing runtime errors were corrected as part of this phase.
- The full test suite and live provider/browser tasks are intentionally deferred until all approved phases are implemented, per the owner’s instruction. No live provider, pill, browser-control, or desktop settings were changed in this phase.
