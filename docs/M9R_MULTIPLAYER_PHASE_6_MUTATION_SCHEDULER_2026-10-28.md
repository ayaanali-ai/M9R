# M9R Multiplayer — Phase 6: Mutation Scheduler

Status: source implementation complete for Phase 6; validation tests remain deferred until the user-approved end-of-phases verification pass.

## Scheduler boundary

`src/lib/native/multiplayer-mutation-scheduler.ts` is the provider-neutral mutation fence between multiplayer planning and the existing browser/desktop dispatchers. It never sends input itself. A caller acquires a short transaction, invokes the already-existing route, then commits or aborts the receipt.

The scheduler provides:

- surface-wide leases that conflict with every mutation on that surface;
- region leases that conflict only with the same region or a surface-wide lease;
- independent-region concurrency;
- a surface epoch plus independent region revisions, so one region’s edit does not falsely stale a different region while a surface-wide edit invalidates all older plans;
- a separate surface mutation revision required by whole-surface edits, so a broad edit planned before a region commit must rebase even though independent region work remains concurrent;
- short TTL-bounded transactions and expiry sweeping;
- commit-time revision fencing;
- deterministic retry/rebase decisions;
- idempotent operation receipts and terminal no-replay states.

This is the document example’s intended behavior: title/header and body regions can hold leases concurrently; overlapping edits wait or rebase; a whole-document mutation waits for all region work and advances the surface epoch.

## Existing route safety

The scheduler does not alter the current `computer-use-mcp`, browser broker, CUA driver, foreground-input lease, or desktop-stage implementations. Their existing target revision checks and durable operation receipts remain authoritative at dispatch time. Phase 6 adds the multiplayer lease/revision layer above them; it does not bypass their safety checks.

## Verification boundary

- Added coverage for independent regions, overlapping leases, stale-region rebase, surface-wide fencing, and expired late commits.
- Added the scheduler to the native CLI build manifest.
- Compile-only typecheck and diff verification are performed before the Phase 6 commit.
- Full tests and live tasks remain deferred until all approved phases are implemented, per the owner’s instruction.
