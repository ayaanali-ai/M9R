# M9R Multiplayer — Phase 4: A2A Coordination

Status: source implementation complete for Phase 4; validation tests remain deferred until the user-approved end-of-phases verification pass.

## What Phase 4 adds

Phase 1 already defined the bounded `A2AMessage` contract. This phase adds the provider-neutral runtime router in `src/lib/native/multiplayer-a2a.ts`.

The router:

- validates the sender, sender branch, run, and every recipient against the run roster;
- routes direct messages or group messages to the declared agents only;
- emits event-driven acceptance and per-recipient delivery events, so providers do not poll for teammate state;
- deduplicates retries by message ID and sender-scoped idempotency key;
- rejects conflicting reuse of either identity key;
- enforces message expiration and validates reply/supersede references;
- keeps only a bounded recent history, preventing an unbounded collaboration log from consuming memory or usage;
- keeps summaries and structured details as the compact user-facing/default exchange. Long-form transcript projection remains a later collaboration-view concern.

Supported message kinds remain the Phase 1 set: help request, result, delegation, blocker, surface handoff, edit confirmation, verification request, stop, and supersede. A `stop` message is an explicit coordination signal; Phase 2 remains the authority that cancels run/branch/agent operations, so A2A delivery cannot silently mutate cancellation state.

The native CLI build manifest now ships the Phase 1 contract, Phase 2 coordinator, and Phase 4 router together. The existing browser-control path is not replaced or modified by this phase.

## Verification boundary

- Added route, deduplication, expiry, correlation, recipient, and dangling-reference coverage.
- Typecheck and diff verification are performed before the Phase 4 commit.
- The new tests are intentionally not executed yet, per the owner’s instruction to run the complete validation pass after all approved phases are implemented.
