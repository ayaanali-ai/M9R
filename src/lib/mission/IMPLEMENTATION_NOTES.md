# Mission domain — Phase 1 implementation notes

Scope: pure domain only. No schema, RLS, API routes, orchestrator, dispatch
leases, planner, agent messaging, UI, or voice. No existing Run behavior
changed.

## Deviations from `oathlock-specs/`

### 1. "Objective" → "Mission"
Per `oathlock-specs/NAMING_DECISION.md`. 28 files already use `objective` to
mean *impartial/measurable* (`objective signals`, `objectiveChecksPassed`,
`objectiveSuccessCriteria`). Everything else in the specs applies verbatim.

### 2. `Mission.resumeTo` added — the spec's transition is otherwise unimplementable
`STATE_MODEL §3` says `needs_input → previous_active_state`. Nothing in the
spec records what the previous active state *was*, so the transition cannot be
validated. Added `resumeTo: ActiveMissionState | null`, required when entering
`needs_input` / `blocked` / `paused`, and enforced on the way out: a Mission
interrupted from `reviewing` may only resume into `reviewing`.

### 3. Evidence modelled as two independent axes
`PRODUCT.md §14` and `PASSPORT_EVIDENCE.md §3` both define "evidence states",
differently. Implemented as two enums that share no values (asserted by test):

- `EvidenceLifecycle`: `captured | validated | attached | attested | accepted`
- `EvidenceAvailability`: `available | invalid | redacted | unavailable`

Deliberately orthogonal — evidence can be `attached` and `redacted` at once.

### 4. `blocked` and `paused` also require a resume target
The spec only implies this for `needs_input`. All three are interruptions of
active work and have the same resumption problem, so all three are treated
alike.

### 5. Terminal immutability is checked before transition legality
`STATE_MODEL §16` is enforced as the first rule in `validateTransition`, so a
terminal Mission cannot be moved by an otherwise well-formed request. Refusal
message points at creating a successor Mission.

### 6. Damaged event streams project rather than throw
A stream with a version gap still produces a projection, marked
`complete: false` with `integrityIssues`. Rationale: `PASSPORT_EVIDENCE §9`
forbids claiming "complete history" when records are missing — but a damaged
history should stay inspectable, not become unopenable.

## Reused rather than duplicated

- `AgentKindKey` (`agent-workspace-data.ts`) — participant provider identity.
- `RunMode` (`run-mode.ts`) — Mission execution mode and coordination budget.
- `RunStatus` (`agent-run-core.ts`) — source enum for the legacy mapping.
- The existing `{ ok, errors, … }` validation convention.

**Not reused:** `AssignmentState` (`assignment.ts`). The existing machine
(`requested → accepted → …`) is incompatible with the spec's
(`draft → queued → working → under_review → …`). Assignments are Phase 2+
scope; the existing type is untouched.

## Deliberately not built (Phase 1 boundary)

- Database-backed idempotency store — interface only. `InMemoryIdempotencyStore`
  is a test double: no durability, no atomicity with the aggregate write, no
  eviction. Not for production.
- Command handlers — the state machine validates transitions; nothing applies
  them to storage yet.
- `mission-events.ts` defines eight event types covering Phase 1 needs.
  Assignment, message, finding, and verification events arrive with their
  phases.

## Known ambiguities — resolved in Phase 2A

1. ~~Assignment state reconciliation.~~ Resolved as a compatibility boundary
   only, per instruction: `legacy-observation-mapping.ts` translates both
   `RunStatus` and the existing `AssignmentState` into one shared
   `NormalizedOrchestrationPhase`, with every lossy mapping recorded on the
   observation (`lossy: true`, `lossNotes`). Neither legacy machine is
   replaced or modified.
4. ~~Correlation id source.~~ Resolved: `CommandContext` carries a resolved
   `correlationId`; `mintCorrelationId()` mints one at the outer boundary when
   absent. `applyMissionCommand` never mints one itself — it only consumes
   what the context supplies, which is asserted by test.

## Still open before Phase 2B (scheduler / dispatch leases)

2. **`mission-projection.ts` vs. `run-passport-service.ts`.** Both project a
   record. The spec makes the Passport a projection over Mission events; the
   existing service builds it from rows. They must converge in Phase 6.
3. **`evidence-submission.ts` lifecycle vocabulary.** Its
   `EvidenceAttachmentStatus` (`draft | validated | attached | rejected`)
   predates the canonical `EvidenceLifecycle` here. Not yet wired to anything,
   so no behavior depends on it; unify when evidence attaches to Missions.

## Phase 2B — mission store + runtime adapter

### New files
- `mission-store.ts` — `MissionStore` interface (`loadEvents`/`append`, event-log
  based, no separate projection storage), `loadMissionProjection` helper,
  `InMemoryMissionStore` reference implementation.
- `mission-runtime.ts` — `runMissionCommand`, the first impure layer: idempotency
  lookup → load → apply (pure, via Phase 2A's `applyMissionCommand`) → persist.

### Scope held: interface + rigorous in-memory reference, not a database

Flagged to the user before starting: the Phase 2A report recommended
"durable idempotency + command store," but every phase to this point held a
hard "no schema" line. Interpreted "durable" as an abstraction with real
atomicity semantics — an interface a real database can later back with zero
caller changes — not an actual Postgres-backed store. No objection received.
`InMemoryMissionStore`'s atomicity holds because JavaScript never interleaves
within a synchronous block: `append`'s version check and its mutation have no
`await` between them, so even two calls raced via `Promise.all` serialize
correctly. A real backing store must provide the same guarantee (e.g. a single
`UPDATE ... WHERE version = $expected`), not merely approximate it.

### The interesting case: losing the append race

`runMissionCommand` can lose its `append` after already computing a valid
result from `applyMissionCommand`. Two things can have happened between load
and write, and they must be told apart rather than guessed at:

1. Another caller was processing the *exact same* command concurrently
   (racing on the same idempotency key) — its outcome is now recorded, and
   the loser must **replay it**, not report a conflict for work that isn't
   actually new.
2. Another caller did something *else* to the Mission — a genuine conflict,
   reported as `version_conflict`.

The idempotency store, not the mission store, is what tells these apart: on a
lost race, `runMissionCommand` rechecks idempotency before concluding
anything. Verified by test with real `Promise.all` interleaving (not a
simulated race): two concurrent calls with the same key both resolve to the
identical winning event and the log holds it exactly once; two concurrent
calls with genuinely different commands produce exactly one success and one
real `version_conflict`, including at 10-way concurrency.

### Tests

`mission-store.test.ts` (7 tests): empty-mission load, successful append,
stale-version refusal (log left untouched), `loadEvents` returns a defensive
copy, 2-way and 10-way concurrent races on the same version (exactly one
winner), and appends to different missions never conflicting.

`mission-runtime.test.ts` (7 tests): sequential command chaining through the
runtime with projection/version checks; sequential replay not re-appending;
an invalid transition surfacing unchanged and not appending; the two
concurrent-race scenarios above; 10-way same-key concurrency; the lost-race
replay path specifically.

Full suite: 1096 passing (up from 1082), 0 failures. Lint: 0 errors (17
pre-existing warnings, none in new files). Typecheck: clean.

### Remaining ambiguity

`runMissionCommand` returns exactly `ApplyCommandResult` — no wrapping error
type of its own. This keeps the seam thin, but means a caller cannot
distinguish "the pure handler refused this" from "the store lost a race and
is reporting a conflict" without inspecting `error.code` values that
originate from two different layers. Not resolved here since no caller exists
yet to reveal whether that distinction actually matters in practice.

## Phase 2C — real database-backed MissionStore + IdempotencyStore

Per explicit instruction: build the real Postgres-backed stores now, before
the Orchestrator, rather than continuing to defer persistence.

**This section was corrected mid-phase by a completion audit before human
review.** The first draft split persistence across two independent RPCs
(`append_mission_events_atomic`, `remember_mission_command_outcome_atomic`) —
two separate transactions, not one. The audit below documents the finding and
the fix. What's described here is the CORRECTED design; the two-RPC draft was
never applied anywhere and left no trace beyond git history.

### Audit finding: the original two-RPC draft was not atomic

**Which RPC was called first:** `SupabaseMissionStore.append` →
`append_mission_events_atomic` (mutates `missions`, `mission_events`), THEN —
only if that succeeded — `SupabaseIdempotencyStore.remember` →
`remember_mission_command_outcome_atomic` (mutates `mission_command_outcomes`).

**Transaction boundaries:** each RPC is its own implicit Postgres transaction.
Nothing spanned both.

**Could `runMissionCommand` make multiple network calls for one command?**
Yes — up to four: an idempotency lookup (select), an events load (select),
the append RPC, and conditionally the remember RPC.

**What happens if the second call fails after the first succeeds:** exactly
failure mode #1 from the audit request. `missions`/`mission_events` commit;
`mission_command_outcomes` never receives the row. A process crash or network
drop between the two calls is all it takes. Concretely: a retried command
would fail the idempotency lookup (the record was never written), reload the
now-already-advanced event stream, and re-run `applyMissionCommand` against
state that already reflects the first attempt — at best a spurious
`invalid_transition` refusal for a legitimate retry, at worst silent
double-application. Failure modes #2-#4 did not independently reproduce (the
app-level code always called `remember` after a successful `append`, and
`missions.current_version` was already updated inside the same function as
the event inserts, so there was never a separate "projection" table to drift
from the event stream) but resting that guarantee on call-ordering discipline
in application code, rather than on a database transaction, was exactly the
fragility the audit was checking for.

**Note on invariants #3/#4 (projection vs. event stream):** there is no
separate "Mission projection" table in this design — `projectMission` folds
`mission_events` at read time (Phase 1's deliberate choice: "no separate
projection storage that could drift"). `missions.current_version` is a
lock/version cache, not a projection, and it was already updated in the same
function invocation as the event inserts in the original draft. The fix below
keeps it that way and additionally folds the idempotency-outcome write into
the same transaction.

### Fix: one command, one RPC, one transaction

Replaced both functions with a single `apply_mission_command_atomic`, called
from a single `SupabaseMissionCommandPersistence.applyCommand`. One
invocation now performs, inside one implicit transaction:

```
BEGIN
  check mission_command_outcomes for idempotency_key (unlocked fast path)
    -> found, digest matches: RETURN 'replayed', stored result
    -> found, digest differs: RETURN 'idempotency_conflict'
  INSERT missions (genesis) ON CONFLICT DO NOTHING
  SELECT current_version FROM missions WHERE id = mission_id FOR UPDATE   -- lock
  IF current_version <> expected_version:
    recheck mission_command_outcomes (a concurrent duplicate may have
      committed between the unlocked check above and acquiring this lock)
      -> found now: RETURN 'replayed' or 'idempotency_conflict'
      -> not found: RETURN 'version_conflict', real current_version
  FOR EACH event: assert event.aggregateVersion matches the computed next
    version, INSERT INTO mission_events
  UPDATE missions SET current_version = next_version
  INSERT INTO mission_command_outcomes (idempotency_key, ..., result)
  RETURN 'applied', next_version, result
COMMIT
```

Domain transition legality is NOT reimplemented in SQL — `applyMissionCommand`
(pure, in TypeScript) still decides what's legal and computes the events and
the result; the RPC only receives already-computed `p_events`/`p_result` and
enforces idempotency-key resolution, the version lock, contiguous sequencing,
and atomicity of the write across all three tables.

### New / changed files
- `supabase/migrations/20260725120000_mission_event_log.sql` — rewritten in
  place (never applied anywhere, so no down-migration was needed): `missions`,
  `mission_events`, `mission_command_outcomes` unchanged; the two split RPCs
  replaced by `apply_mission_command_atomic`.
- `src/lib/mission/mission-command-persistence.ts` (new) —
  `MissionCommandPersistence` interface (`lookupOutcome` read, `applyCommand`
  the one durable write) and `SupabaseMissionCommandPersistence`.
- `src/lib/mission/mission-store-supabase.ts` — cut down to
  `SupabaseMissionEventReader` (read-only `loadEvents`; the `append` method
  and the `MissionStore` implementation were removed — keeping an independent
  `append` on this class would have re-opened exactly the split-transaction
  hole this phase exists to close).
- `src/lib/mission/mission-idempotency-supabase.ts` — deleted (called the
  now-removed `remember_mission_command_outcome_atomic`).
- `src/lib/mission/mission-runtime-durable.ts` (new) —
  `runMissionCommandDurable`, the durable-path equivalent of
  `runMissionCommand` (`mission-runtime.ts`, unchanged, still correct for the
  in-memory reference path). Does a read-only idempotency pre-check
  (`persistence.lookupOutcome`) before calling `applyMissionCommand`, because
  the pure handler's idempotency check runs before its existence check — a
  genuine CreateMission replay must be told about the prior outcome or it is
  wrongly rejected as `mission_already_exists`. The pre-check is read-only and
  provably cannot cause a correctness problem on a miss (a miss just falls
  through to the RPC's own authoritative recheck under lock) — verified by a
  dedicated test where both racers' pre-checks miss and the RPC-level recheck
  still prevents a double append.
- `scripts/mission-store-supabase.test.ts` — rewritten for the new classes;
  12 tests total across both files (was 7).
- `scripts/mission-runtime-durable.test.ts` (new) — 6 tests: apply, sequential
  replay (asserts `applyCommand` is NOT called on a lookup hit), concurrent
  same-key race (both pre-checks miss, RPC-level recheck still yields exactly
  one append), invalid transition never reaching persistence, and a
  genuinely-different-commands version conflict.
- `scripts/mission-atomicity-integration-test.sh` (new) — see "database-
  verified" section below.

### House style followed exactly, not invented

Surveyed the three most recent migrations before writing anything (see
`20260721010000_atomic_agent_claim_lifecycle.sql` in particular):
- `create table if not exists public.<snake_case>`, `timestamptz` columns,
  `jsonb` payload columns constrained with `jsonb_typeof(...) = 'object'` and
  an `octet_length` cap (131072 bytes, same limit as `launch_events`).
- The atomic-check-and-write idiom used everywhere else in this schema is a
  `security definer` `plpgsql` function that does `select ... for update` to
  lock a row, checks state, writes, and returns a result row — not a
  client-side `UPDATE ... WHERE version = $expected`.
- No RLS policy on any of the three tables, matching precedent
  (`agent_claims`, `launch_events`): backend-only event-log tables here are
  gated by table grants (`revoke ... from public, anon, authenticated; grant
  ... to service_role`) and function grants, not RLS.
- `missions.id` is `text`, not `uuid`: `MissionId` is `string` in the domain
  layer with no guarantee of UUID shape (tests use ids like `"m-1"`).

### Security-grant audit (against the final migration)

| Check | Status |
|---|---|
| Explicit `SET search_path` | PASS — `set search_path = ''` on `apply_mission_command_atomic` |
| Execution revoked from `public`, `anon`, `authenticated` | PASS — explicit `revoke all on function ... from public, anon, authenticated` |
| Execution granted only to `service_role` | PASS — single `grant execute ... to service_role` |
| Schema-qualified table/function references | PASS — every reference is `public.*` throughout |
| No caller-controlled tenant scope accepted without verification | **FINDING, not fixed here** — see below |
| Immutable event rows via permissions/constraints | PASS — `mission_events` grants are `select, insert` only (no `update`/`delete` granted to any role) |
| No direct table mutation grants to application-facing roles | PASS — `anon`/`authenticated` have `revoke all`; only `service_role` holds table grants, and even those are the minimum needed (`missions`: select/insert/update; `mission_events`/`mission_command_outcomes`: select/insert only) |

**Tenant-scope finding, left open on purpose:** none of `missions`,
`mission_events`, or `mission_command_outcomes` carry a `workspace_id` column.
`Mission.workspaceId` exists in the domain type (`mission-domain.ts:194`) and
`CreateMission` accepts a `workspaceId` field (`mission-commands.ts:73`), but
it is currently **dropped** — `MissionCreatedPayload` never carries it, so it
never reaches the event stream, the projection, or (now) the table. There is
no database-level tenant isolation for Mission data today; unlike
`agent_claims`/`launch_grants`, a compromised or misconfigured service-role
caller has no schema-enforced boundary preventing it from reading or writing
across workspaces. This is a real gap, not a caller-input-validation
question — there's no workspace parameter to validate, because it's absent
entirely. Fixing it means adding `workspace_id` to the event payload/schema,
a domain-model change, not persistence plumbing — out of the bounded scope of
this atomicity audit/fix. Flagging for an explicit human decision rather than
silently patching it in.

### Atomicity verdict

**Fixed, and re-tested.** The original two-RPC split was confirmed unsafe
(failure mode #1 above reproduces on paper) and has been replaced with
`apply_mission_command_atomic`, a single function/transaction covering
idempotency resolution, the version lock, the event insert, and the outcome
record. `runMissionCommandDurable` now makes exactly one durable write call
per command attempt — verified by test (`mission-runtime-durable.test.ts`,
"one command must produce exactly one durable write call" and the
concurrent-race test).

### What "implementation-complete" means here, and what it does not

- **Implementation-complete:** yes. The single-transaction design is written,
  matches house SQL style, and the JS layer that calls it is fully tested
  against fakes.
- **Database-verified: no.** This environment has no live Postgres and no
  Supabase CLI link (`supabase/` has no `config.toml`), so
  `apply_mission_command_atomic`'s actual row-lock behavior — the thing that
  makes the "recheck idempotency after losing the lock" branch meaningful —
  has never executed against a real database. `scripts/mission-atomicity-
  integration-test.sh` is a runnable (not yet run) local test plan covering
  what the audit asked for: `supabase start`, migration application,
  permission checks under anon/authenticated/service_role, concurrent RPC
  execution from two separate `psql` clients racing the same idempotency key,
  a transaction-rollback fault injection (a deliberately invalid
  `aggregateVersion` trips the function's own assertion; the script confirms
  nothing partial landed across all three tables), and a compensating down
  procedure (no paired down-migration exists, matching every other migration
  in this repo — the script documents the manual drop sequence instead).
- **Deployment-complete: no.** The migration has not been applied to any
  Supabase project. `runMissionCommandDurable` is not wired to any real
  caller yet — that belongs with Phase 3 (the Orchestrator).

### Verification actually run

Full suite: **1108 passing** (up from 1096 before this phase), 0 failures.
Typecheck clean. Lint: 0 errors (17 pre-existing warnings, none in new files).
Build: succeeds. `git status` confirms only the new migration file (rewritten
in place) and files under `src/lib/mission/`/`scripts/` changed — no existing
schema, API route, or UI touched.

## Phase 2D — scheduler / dispatch leases + Mission genesis identity

Two pieces of work, done in parallel per instruction.

### 1. `mission-scheduler.ts` — dispatch leases (pure domain, in-memory only)

Scope held to the same line every prior phase held: pure types, a pure lease
state machine, pure candidate selection. No database, no orchestrator wiring,
no real provider dispatch — explicitly deferred until tenant-scope tests pass
against the persisted layer (see part 2).

A `DispatchLease` answers "who currently owns the right to act on this
Mission on the scheduler's behalf, and until when?" — a different question
from `Mission.state`, which is why it is not modelled as a Mission state or
event. A Mission can be `executing` with a silently-expired lease (the worker
crashed); the Mission isn't wrong about itself, the scheduler's bookkeeping
about who's driving is just stale.

States: `leased | released | expired | revoked`. Transitions: `acquireLease`
(refuses only when a DIFFERENT, still-live holder has it — the same holder
may always re-acquire, and a lease past its own `expiresAt` is treated as
available regardless of its stored state), `renewLease` (holder-checked,
window-checked — only honored within `renewalWindowMs` of the current
expiry, so a holder can't extend its grip indefinitely by renewing early and
often instead of on a real cadence), `releaseLease` (holder-checked,
voluntary), `revokeLease` (NOT holder-checked — the scheduler/reconciler's
forced-override escape hatch), `evaluateLeaseExpiry` (pure check, returns
null when there's nothing to write back), `isFencingTokenCurrent` (lets a
caller refuse a stale worker's write even if that worker doesn't yet know it
lost the lease).

`selectDispatchCandidates` filters a batch of Mission projections down to
what the scheduler may dispatch right now: state must be one of `ready |
initializing | executing | reviewing | verifying` (never an interruption
state, never terminal), no live competing lease, and still within
`maxConcurrentLeasesPerWorkspace`. Order-sensitive by design — which Missions
win a scarce budget is a property of caller-supplied ordering, never
iteration happenstance.

Tests (`mission-scheduler.test.ts`, 22): every acquire/renew/release/revoke
branch above, expiry evaluation, fencing-token currency, and three
selection scenarios (state filtering, live-lease exclusion, per-workspace
budget enforcement with deterministic ordering).

### 2. Mission genesis identity + workspace-scoped command outcomes

Closes the tenant-scope finding flagged at the end of Phase 2C: `workspaceId`
existed on `Mission` and `CreateMission` but was dropped before it ever
reached the event stream, the projection, or the table, and
`mission_command_outcomes.idempotency_key` was a GLOBAL primary key — any
two workspaces reusing the same caller-supplied key would have collided.

- `Mission.repositoryId: string | null` added — genesis identity alongside
  `workspaceId`, optional, immutable after creation. `CreateMission` gained
  an optional `repositoryId` field.
- `MissionCreatedPayload` now carries `workspaceId` and `repositoryId`; the
  command handler writes both onto the `mission.created` event instead of
  dropping them; `MissionProjection` gained matching fields folded by
  `applyMissionEvent`.
- `missions` table gained `workspace_id text not null` and `repository_id
  text`, written ONLY on the genesis insert (`on conflict (id) do nothing`
  means a later command's params for these two columns are silently
  ignored — that's what makes them immutable in practice). No column-level
  revoke enforces this in SQL; it's a property of what the function chooses
  to write, tracked as the same class of gap as the original tenant-scope
  finding, not closed here.
- `mission_command_outcomes`'s primary key changed from `idempotency_key`
  alone to `(workspace_id, idempotency_key)` — idempotency keys are now
  scoped per workspace, not global.
- `apply_mission_command_atomic` gained `p_workspace_id` (required) and
  `p_repository_id` (optional, defaults null); every idempotency lookup
  inside the function (the fast path and the recheck-under-lock after a
  version conflict) is now scoped by `workspace_id`.
- `MissionCommandPersistence.lookupOutcome` now takes `(workspaceId,
  idempotencyKey)`; `ApplyCommandPersistenceInput` gained `workspaceId`
  (required) and `repositoryId` (optional). `runMissionCommandDurable` gained
  a required `workspaceId` input, threaded to both calls — there is no way to
  derive it from an existing Mission's id alone without an extra read this
  function's single-write design deliberately avoids, so callers acting on
  an existing Mission must supply the same workspaceId it was created with.

Not touched: `mission_events` still carries no `workspace_id` column — that
table is reached only through a `mission_id` that now resolves to exactly
one workspace via the `missions` row, so the tenant boundary holds at the
`missions`/`mission_command_outcomes` layer without duplicating the column
onto every event row. Flagging this as the scoped interpretation, not an
oversight, should a future phase need workspace-filtered event queries
directly.

### Verification actually run

Full suite: **1130 passing** (up from 1108 before this phase — 22 new
scheduler tests plus the updated genesis-identity assertions across the
existing Mission test files), 0 failures. Typecheck clean (the only
`tsc --noEmit` output without `--allowImportingTsExtensions` is the
pre-existing, unrelated TS5097 noise on `.ts`-suffixed test imports; the
project's actual `npm run typecheck` script passes that flag and is clean).
Lint: 0 errors, 17 pre-existing warnings, none in new files. Build: succeeds.
Database-verified: no — same as Phase 2C, this environment has no live
Postgres; the schema/RPC changes are implementation-complete and covered by
fakes, not executed against a real database.

## Phase 2D.1 — durable scheduler and dispatch leases

Scope: the persistence boundary that lets MULTIPLE scheduler workers run
Phase 2D's pure lease state machine and candidate-selection policy safely
against shared state. No provider adapters, no Runtime process supervision,
no Planner, no agent messaging, no Mission UI, no voice — all explicitly
deferred, per instruction.

### Architectural correction made before implementing: the uniqueness boundary

Flagged before writing any persistence code: a lease must protect
`workspaceId + missionId + dispatchKey`, not `missionId` alone. One Mission
will eventually run several concurrent assignments (an implementation
assignment, a security-review assignment, a verification assignment) that
need independent leases; a mission-wide lock would force them to serialize
for no domain reason. Phase 2D's pure `mission-scheduler.ts` was amended
in place — `DispatchKey`, `DEFAULT_DISPATCH_KEY = "primary"` (this vertical
slice's single execution slot), and a `dispatchKey` field added to
`DispatchLease`, `AcquireLeaseInput`, `DispatchCandidateInput`, and the
`eligible`/`refused` shapes `selectDispatchCandidates` returns (now
`{missionId, dispatchKey}` pairs, not bare `MissionId`s). Nothing about the
transition legality rules themselves changed. 24 existing scheduler tests
updated; one new test (`selectDispatchCandidates treats different
dispatchKeys on the same Mission as independent slots`) added.

### A real bug found while designing the durable layer: fencing was not monotonic

`acquireLease` (Phase 2D) reset `fencingToken` to 1 on every successful
acquire, including a reacquire after expiry. That breaks the monotonic-
fencing requirement this phase was explicitly asked to prove: two
non-overlapping lease generations on the same slot could both present token
`1`, making a long-dead generation-N worker's write indistinguishable from a
live generation-(N+2) worker's. Fixed at the pure layer, not papered over in
the store: `acquireLease` now continues the PREVIOUS record's sequence
(`current ? current.fencingToken + 1 : 1`) whenever any prior record exists
for the slot, terminal or expired, and only a truly fresh slot starts at 1.
Guarded by a new test, `acquireLease's fencing token is monotonic across
generations, never resets to 1 on reacquire`, and by the durable-layer test
`an expired lease may be replaced, and the replacement receives a strictly
higher fencing token`.

### New files

- `mission-scheduler-store.ts` — `MissionSchedulerStore` (the durable
  boundary: `claimCandidates`, `renewLease`, `releaseLease`, `revokeLease`,
  `validateFence`, `listOutstandingDispatchIntents`,
  `markDispatchIntentDelivered`), `DispatchInstruction` (the durable outbox
  row), and `InMemoryMissionSchedulerStore` — the rigorous reference
  implementation, following the exact precedent `InMemoryMissionStore` set:
  every method is synchronous internally end-to-end (no `await` between
  reading a slot's state and committing its mutation), so two concurrent
  calls raced via `Promise.all` cannot interleave mid-decision. This is what
  makes the concurrency tests a real proof, not a simulated lock.
- `mission-scheduler-store-supabase.ts` — `SupabaseMissionSchedulerStore`,
  calling the five atomic RPCs below.
- `supabase/migrations/20260726010000_mission_dispatch_leases.sql` — two
  tables and five security-definer functions (schema below).
- `scripts/mission-scheduler-store.test.ts` (17 tests) — the full
  concurrency-invariant suite, run against `InMemoryMissionSchedulerStore`.
- `scripts/mission-scheduler-store-supabase.test.ts` (6 tests) — RPC
  argument-shape verification against a fake `SupabaseClient`.

### Schema

`mission_dispatch_leases` — ONE row per slot (`primary key (workspace_id,
mission_id, dispatch_key)`), reused across generations rather than an
append-only log: `lease_id`, `lease_owner` (jsonb), `fencing_token`
(monotonic across the row's whole life, never reset), `status`
(`leased | released | expired | revoked`), `attempt`, `version`
(optimistic-lock cache; not read by any caller today since every mutation
already takes its own `for update` row lock inside a security-definer
function — kept because it was explicitly requested and costs nothing),
`acquired_at`/`renewed_at`/`expires_at`/`released_at`/`revoked_at`/
`revoked_reason`. `repository_id` is denormalized from `missions` at claim
time for observability only — the RPC's authoritative repository check
always reads `missions.repository_id` directly, never this column.

`mission_dispatch_intents` — the outbox: one row per successful claim,
carrying everything a future Runtime needs (`adapter_requirement`,
`execution_constraints`, the lease's `lease_id`/`fencing_token`/`attempt`)
without ever calling a provider. `delivered_at`/`superseded_at` mark an
intent closed; `listOutstandingDispatchIntents` is exactly "delivered_at is
null and superseded_at is null."

No RLS on either table, matching every other Mission-domain table and the
`agent_claims`/`launch_events` precedent — access is gated by table grants
(`service_role` only) and the security-definer functions.

### RPC transaction design

Five functions, following the house idiom (`security definer`,
`set search_path = ''`, `select ... for update` to lock, explicit
`revoke`/`grant` to `service_role` only):

- **`claim_mission_dispatch_candidates_atomic`** — the one that does the
  most work. Takes a JSONB array of candidates and processes them in ONE
  transaction, locked in `(workspace_id, mission_id, dispatch_key)` order
  regardless of caller-supplied order (required so two concurrent calls
  claiming overlapping candidate sets can never deadlock by locking the same
  two rows in opposite sequences). For each candidate: locks the `missions`
  row and verifies workspace match, repository match (when supplied), and
  `mission_state = any(dispatchable_states)` — where `dispatchable_states`
  is a PARAMETER on every call, sourced by the application from
  `mission-scheduler.ts`'s `DISPATCHABLE_MISSION_STATES`, never hardcoded in
  SQL; then locks the slot's lease row (if any) and either upserts a claim
  (continuing the fencing sequence) or refuses `already_leased`. A claimed
  candidate ALWAYS gets exactly one lease upsert and exactly one dispatch-
  intent insert, in the same transaction — never one without the other.
  Because the whole loop runs inside one function invocation, an uncaught
  exception partway through rolls back EVERY candidate processed so far in
  that call, not just the one that failed — real Postgres gets this for
  free from the implicit transaction; `InMemoryMissionSchedulerStore` earns
  the same guarantee explicitly, via a snapshot-and-restore-on-throw wrapper
  around the whole call, proven by
  `a fault mid-batch rolls back the ENTIRE claim call, not just the failing
  candidate`.
- **`renew_mission_dispatch_lease_atomic`** / **`release_...`** — take the
  slot's own row lock, verify `(lease_id, fencing_token)` match exactly
  before anything else (a mismatch on EITHER is `stale_fencing_token`, not a
  more specific/lenient error — a superseded generation's own leaseId never
  matches, and a stale token within the RIGHT generation is still refused),
  then delegate the actual legality decision (holder match, terminal state,
  expiry, renewal window) to the pure functions the store also calls.
- **`revoke_mission_dispatch_lease_atomic`** — deliberately NOT fencing- or
  holder-checked: the scheduler/reconciler's override for a cancelled
  Mission or an unreachable holder, exercised precisely when the current
  holder cannot be trusted to cooperate.
- **`validate_mission_dispatch_fence_atomic`** — read-only, no row lock (a
  plain `stable` SQL function): "is this exact `(lease_id, fencing_token)`
  still the live one for this slot?" Exists for a FUTURE write path (e.g.
  attaching execution results, Phase 2D.2+) to check before doing its own
  work; a write path that needs fencing enforced atomically WITH its own
  mutation must take its own lock in its own function, this is the
  pre-check, not a substitute for that.

### Fencing behavior

Monotonic per slot for the slot's entire lifetime (see the bug fix above),
enforced twice: once implicitly (claim always continues the sequence, never
resets), and once explicitly at every mutation boundary — `renewLease` and
`releaseLease` both require the caller's presented `(leaseId, fencingToken)`
to match the row's CURRENT values before anything else runs, refusing
`stale_fencing_token` otherwise. `validateFence` exposes the same check
read-only for a future write path. Tested: stale worker cannot renew, stale
worker cannot release, stale worker's fencing token no longer validates
after a reclaim, revoked lease cannot be renewed.

### Tenant checks

`claimCandidates` (both the RPC and `InMemoryMissionSchedulerStore`, which
consults an equivalent in-memory `missions` registry standing in for the
same source of truth) verifies, per candidate, before anything else:
Mission exists; the Mission's OWN `workspace_id` (read fresh from
`missions`, never trusted from the caller) matches the requested
`workspaceId`; when a `repositoryId` was supplied, it matches the Mission's
own `repository_id`. Tested: cross-workspace claim rejected even though the
Mission exists; repository mismatch rejected; unknown Mission rejected.

### Recovery behavior

A claim's lease upsert and its dispatch-intent insert commit in the SAME
transaction — never one without the other — which is the fix for "lease
committed, then the process crashes before Runtime receives the dispatch."
No external queue was introduced; recovery is a plain query,
`listOutstandingDispatchIntents(workspaceId)` (`delivered_at is null and
superseded_at is null`), that a restarted scheduler calls to pick back up
where it left off. Reclaiming an expired slot supersedes its prior
outstanding intent (a crashed worker's stale instruction reads as dead, not
merely undelivered) — tested by both `scheduler restart can recover an
outstanding dispatch intent, and delivery clears it` and `reclaiming an
expired slot supersedes its prior outstanding intent`.

### Concurrency tests actually run (23 total across the two new files)

Two-way and ten-way races for one slot (exactly one winner each time,
against `InMemoryMissionSchedulerStore`'s real `Promise.all` interleaving,
not a simulated lock); different Missions claimed concurrently; different
`dispatchKey`s on the SAME Mission claimed concurrently (proving the
uniqueness-boundary fix actually works); expired-lease replacement with a
strictly higher fencing token; stale-fencing refusal on renew, release, and
`validateFence`; revoked-lease renewal refusal; cross-workspace rejection;
repository-mismatch rejection; unknown-Mission rejection; dispatchable-state
whitelist rejection; all-or-nothing batch rollback on a mid-batch fault;
outbox recovery and delivery; supersession of a stale outbox row on reclaim;
an integration-shape test proving the store claims exactly what the pure
`selectDispatchCandidates` handed it, never re-deriving the workspace
budget itself (that policy remains exhaustively tested in
`mission-scheduler.test.ts`, unchanged by this phase).

### What "implementation-complete" means here, and what it does not

- **Implementation-complete:** yes. Schema, five RPCs, both store
  implementations, and the full required test list are written and passing.
- **Database-verified: no.** Same limitation every prior phase's persistence
  work has carried — this environment has no live Postgres and no Supabase
  CLI link. The row-lock behavior that makes `claim_mission_dispatch_
  candidates_atomic`'s concurrency guarantees real — deadlock-free ordered
  locking across candidates, the all-or-nothing rollback on exception, the
  `for update` serialization between `claim`/`renew`/`release`/`revoke`
  racing the same slot — has never executed against an actual database.
  `InMemoryMissionSchedulerStore` is where those invariants are genuinely
  proven, with real (not simulated) concurrent interleaving; the Supabase
  class is verified only at the RPC-argument-shape level. Requirement #15
  ("pure in-memory and durable lease behavior satisfy the same contract
  tests") is met in the sense every prior phase has drawn that line: one
  rigorous reference implementation, one shape-verified real-database
  adapter calling the same interface — not two independently-proven
  concurrent implementations, which is not achievable without a live
  Postgres instance to test against.
- **Deployment-complete: no.** The migration has not been applied to any
  Supabase project. Nothing in `mission-scheduler-store*.ts` is wired to any
  real caller yet.

### Verification actually run

Full suite: **1155 passing** (up from 1130 before this phase — 24
(23 prior + 1 new) scheduler tests, 17 new scheduler-store tests, 6 new
scheduler-store-Supabase-shape tests), 0 failures. Typecheck clean. Lint: 0
errors, 17 pre-existing warnings, none in new files. Build: succeeds.

### Recommended Runtime entry point (Phase 2D.2, not built here)

A single `pollAndDispatch(workspaceId)` loop the scheduler runs periodically:
(1) load dispatchable Mission projections for the workspace; (2) run the
pure `selectDispatchCandidates` (unchanged) to get the policy-eligible
`{missionId, dispatchKey}` list; (3) call `MissionSchedulerStore.
claimCandidates` with exactly that list; (4) for each claimed candidate,
hand its `DispatchInstruction` to the (not-yet-built) Runtime, which owns
process lifecycle, cancellation, telemetry, and — critically — checking
`validateFence` before it lets any provider adapter's result reach the
Mission's own command handler. On worker startup, before polling for new
work, call `listOutstandingDispatchIntents(workspaceId)` first, so a
restarted worker resumes undelivered instructions from its own prior
generation rather than only ever discovering new ones. This ordering is why
Phase 3 (Provider Adapter SDK) belongs after Phase 2D.2, not before: an
adapter needs a stable Runtime host enforcing fencing at its boundary,
not a bespoke enforcement path per adapter.

## Phase 2D.2 — Runtime execution boundary, supervision, and recovery

Scope: the layer that turns a claimed `DispatchInstruction` (Phase 2D.1) into
locally supervised work — heartbeat/renewal, fencing enforced at the result
boundary, cancellation of a stale worker, and startup recovery of intents a
crashed process left behind. No provider adapters, no Planner, no agent
messaging, no Mission UI, no voice. `ExecutionHost` is the seam Phase 3 will
implement for real; this phase ships only an in-memory fake used to test
supervision behavior, and never calls Codex, Claude Code, Devin, or any
provider.

### A third state machine, deliberately not merged with the other two

`ExecutionState` (`mission-execution.ts`) tracks what ONE Runtime's local
supervision of one claimed instruction is doing right now:
`starting -> running -> {completed | failed | cancelled | lease_lost}`.
This is independent of `Mission.state` (what's true about the work) and
`DispatchLeaseState` (who owns the right to act, and until when) — a Mission
can be `executing` with a live lease while its `ExecutionState` is
`lease_lost` (this worker discovered, via a failed renewal, that someone
else now owns the slot). Collapsing these three would have hidden exactly
the failure mode this phase exists to detect.

### New files

- `mission-execution.ts` — the pure `ExecutionRecord` state machine
  (`beginExecution`, `markRunning`, `recordHeartbeat`, `completeExecution`,
  `cancelExecution`, `markLeaseLost`, all guarded against re-transitioning a
  terminal record) plus `classifyOutstandingIntentForRecovery` — the pure
  decision a restarted Runtime consults for every intent it did not itself
  create.
- `mission-dispatch-runtime.ts` — `ExecutionHost` (the provider seam),
  `InMemoryExecutionHost` (a scriptable test double, explicitly NOT an
  adapter), and `MissionDispatchRuntime`: `adopt` (start local supervision
  of a just-claimed instruction), `tick` (one supervision pass), and
  `recoverOnStartup`.
- `scripts/mission-execution.test.ts` (10 tests) — the pure state machine.
- `scripts/mission-dispatch-runtime.test.ts` (7 tests) — the impure Runtime
  against `InMemoryMissionSchedulerStore` + `InMemoryExecutionHost`.

### Fencing enforced at the result boundary, not just at the mutation boundary

Phase 2D.1 enforced fencing on `renewLease`/`releaseLease` (the caller's
presented `(leaseId, fencingToken)` must match the row's current values).
This phase adds the boundary that actually matters for correctness end to
end: `tick` calls `store.validateFence` BEFORE accepting a finished host
outcome as a real result. A stale worker's outcome — one that finished after
its lease was reclaimed by someone else — is discarded (`markLeaseLost`,
`terminationReason` explains why) and never reaches `completeExecution`, so
it can never flow on to the Mission's own command handler. Tested:
`tick discards a finished outcome when the fence is no longer valid, and
never releases someone else's lease` — which also asserts the RECLAIMING
holder's lease is untouched by the stale worker's tick, not just that the
stale worker was refused.

### Renewal failure cancels the local process — no zombie writers

When `tick` finds no outcome yet, it attempts `renewLease`. Any refusal —
stale token, terminal (e.g. revoked out from under it), expired, outside the
renewal window — triggers `host.cancel(handle)` before marking the execution
`lease_lost`. This is the "stale worker must not keep running unfenced"
guarantee: a Runtime never keeps supervising work it can no longer prove it
still owns. Tested: `tick cancels the local process and marks lease_lost
when renewal fails`, asserting `host.wasCancelled(...)` directly.

### Recovery: revoke, don't pretend to resume

A restarted Runtime process has zero memory of what a previous instance was
supervising — that instance's local process (and, in a real Phase 3 world,
its actual subprocess or provider session) died with it. There is no
"reattach to the still-running work" option here; attempting one would
require Phase 3's real process handles. `recoverOnStartup` instead, for
every outstanding intent in a workspace: checks `validateFence`; if the fence
is already invalid, the intent is simply stale (someone else reclaimed the
slot) and is closed; if the fence is STILL valid, this Runtime's own crashed
process was the last thing holding the slot and nothing is actually running
— the lease is actively revoked (freeing the slot for a clean re-claim
immediately, rather than waiting out its full TTL) and the intent is closed
either way. Tested: revoke-and-close when still valid (and the slot is
immediately re-claimable afterward), close-as-stale when a later claim
already superseded it before the restart.

### Verification actually run

Full suite: **1172 passing** (up from 1155 before this phase — 10 new
execution-state-machine tests, 7 new Runtime tests), 0 failures. Typecheck
clean. Lint: 0 errors, 17 pre-existing warnings, none in new files. Build:
succeeds. No database work in this phase — `MissionDispatchRuntime` and
`ExecutionHost` are pure TypeScript/in-memory, so there is no
database-verified/deployment-complete distinction to draw here; the only
prior-phase persistence (Phase 2D.1's migration) is unchanged and remains
undeployed.

### Recommended next entry point (Phase 3 — Provider Adapter SDK, not built here)

Implement `ExecutionHost` for real: `start` spawns/invokes the actual
provider (Codex, Claude Code, Devin, a browser-verifier) using the
`DispatchInstruction`'s `adapterRequirement`/`executionConstraints`, `poll`
surfaces real progress/completion, `cancel` performs a real best-effort
termination. Nothing in `MissionDispatchRuntime` needs to change for this —
that is the point of the seam. The one thing a real adapter must never do is
bypass `tick`'s fencing check by reporting completion through some other
path; any result-delivery mechanism a real adapter adds must still route
through `MissionDispatchRuntime.tick` (or an equivalent fencing-gated call),
not report directly to the Mission's command handler.

## Phase 3A — real ExecutionHost boundary and Provider Adapter SDK contract

Scope: define the interfaces a real process host and real provider adapters
must satisfy, correct a real recovery bug Phase 2D.2 shipped with, and prove
both against fakes. No real Codex/Claude Code dispatch, no Devin, no
Planner, no agent messaging, no Mission UI voice, no trajectory analysis —
all explicitly deferred.

### 1. Existing execution-stack audit (delegated, then verified)

An Explore-agent audit of the repo found, with file:line precision:

- **Codex / Claude Code "adapters"**: `src/lib/resident-provider-adapters.ts`
  — `buildCodexLaunchSpec`/`parseCodexResult` and
  `buildClaudeCodeLaunchSpec`/`parseClaudeCodeResult`. Pure build/parse
  functions only — no adapter object, no poll-based lifecycle.
- **Process supervisor**: same file — `runProviderProcess` (real
  `child_process.spawn`, bounded output capture, `setTimeout` hard timeout,
  `AbortSignal` cancellation, `child.kill()`) and `executeProviderLaunch`
  (one-shot request/response orchestration: build spec → run → redact →
  record lifecycle events). Genuinely real, but request/response, not
  poll-based, and holds no durable state across a restart.
- **Worktree isolation**: `src/lib/resident-write-isolation.ts` —
  `createGrantWorktree`/`worktreeSpecForGrant`/`validateWriteIsolation`. Real
  `git worktree add` per grant, one worktree per grant, git-only.
- **Controlled-run lifecycle**: `agent-run-core.ts`/`agent-run-service.ts`/
  `oathlock-cli-core.ts` — a status/evidence ledger (run id, status enum,
  rules-loaded count, review decisions). Tracks no OS process, host, or
  execution handle.
- **Cancellation**: `AbortSignal` into `runProviderProcess`
  (real process kill); `cancelAgentRun` (DB status flip only, no signal).
- **Timeout**: `runProviderProcess`'s `setTimeout` is the only real enforced
  process timeout in the repo.
- **Output capture**: `runProviderProcess`'s bounded stdout/stderr buffers.
- **Evidence capture**: `src/lib/evidence-submission.ts` —
  `classifySubmission`/`decideAttachment`, a real classify-then-attach
  pipeline.
- **Redaction**: `src/lib/session-redaction.ts`'s `redactSession` — pattern-
  based secret scrubbing, confidence-scored.
- **Process-handle persistence**: real and durable for CONNECTIONS
  (`record_agent_heartbeat_atomic`, `agent_connections`/
  `agent_presence_leases` — migration `20260713043000_gate9_atomic_
  heartbeat.sql`), but nothing anywhere persists an OS PID/host binding
  across a restart. The closest in-memory analog
  (`local-terminal-session-manager.ts`'s `TerminalSession.pid`) is lost on
  restart and belongs to an unrelated interactive-PTY subsystem.

**Reused, not duplicated**: `redactSession` (directly, in
`mission-provider-adapter.test.ts`'s redaction test — proving the
integration point works against the REAL utility, not a stand-in).
`runProviderProcess`/`executeProviderLaunch` and the Codex/Claude Code
build/parse functions are NOT duplicated here — they remain the reuse target
for the real `ProcessExecutionHost` implementation Phase 3B will build (see
the file plan below); nothing in this phase reimplements process spawning,
timeout enforcement, or output capture, because a correct, tested version of
all three already exists in `resident-provider-adapters.ts`.

**Genuinely missing, and built in this phase as interfaces + fakes**: a
poll-based (`start`/`inspect`/`collect`, not request/response)
process-host contract; ANY durable PID/host/session binding a restarted
process can inspect; a provider-neutral adapter contract; a capability
model; a normalized event model; and the recovery logic that actually
inspects a real process before deciding what to do with its lease.

### 2. Critical recovery correction

Phase 2D.2's `MissionDispatchRuntime.recoverOnStartup` always revoked a
still-valid lease on restart — it had no way to ask "is the process still
alive?", only whether the fencing token was current. That's the right
answer when nothing better is available, but wrong once a real host CAN
answer the liveness question: revoking a lease whose process is actually
still running correctly (and reattachable) would abandon good work and
create exactly the double-execution risk fencing exists to prevent.

`mission-process-recovery.ts`'s `determineRecoveryAction` (pure) implements
the five rules verbatim:

1. `process_confirmed_dead` → `revoke_and_allow_redispatch`.
2. `process_alive_reattachable` → `restore_supervision` (lease and execution
   identity RETAINED — the intent is deliberately left outstanding and the
   slot NOT freed, proven by
   `rule 2 — reattachable: restores supervision and retains the existing
   lease, never redispatching`, which also asserts a second holder's claim
   attempt fails).
3. `process_alive_not_reattachable` → `terminate_then_revoke`, and the
   revoke only happens after `TerminationResult.terminated ||
   .alreadyGone` is confirmed — a termination that neither confirms nor
   reports "already gone" leaves the lease untouched.
4. `process_status_unknown` + `environmentKind: "disposable"` →
   `quarantine_and_allow_redispatch`.
5. `process_status_unknown` + `environmentKind: "shared"` →
   `block_redispatch_requires_review` — the lease and the outstanding intent
   are BOTH left untouched.

A sixth, undocumented-by-the-user-but-necessary case: no process handle was
ever persisted at all (e.g. a crash between `claimCandidates` and
`attachProcessHandle`). Treated exactly as conservatively as rule 5 —
`requiresHumanReview: true`, nothing touched — rather than assumed
disposable, since the environment kind itself is unknowable without a
handle.

`MissionDispatchRuntime.recoverOnStartup` (Phase 2D.2) is UNCHANGED and
remains correct for its documented case: a caller with no
`ProcessExecutionHost` configured (e.g. still using the 2D.2 in-memory fake)
has no way to determine liveness at all, and always-revoke is the best
available conservative default there. `recoverOutstandingIntentsWithProcess
Host` is the corrected path a real deployment must use instead — this is a
new, additive function, not a breaking change to the 2D.2 contract 11 tests
already depend on.

### 3. Process identity: never a bare PID

`PersistableProcessHandle` (`mission-process-host.ts`) carries
`processId` AND a separate `processStartIdentity` — a value (OS-reported
start time, or a supervisor generation counter) that changes if the OS
reuses the PID for an unrelated process. `inspect` MUST compare
`processStartIdentity`, not just `processId`; a mismatch is
`process_confirmed_dead`, never treated as "found something, must be it."
Tested directly: `a processStartIdentity mismatch is treated as
process_confirmed_dead, never reattached`. The handle also carries
`hostIdentity` (a PID is only meaningful relative to one machine),
`environmentId`/`environmentKind` (so recovery can pick rule 4 vs. 5 without
a separate environment lookup), `adapterId`, and `providerSessionRef` — no
secret material, matching the "durable, non-secret information" requirement.

### 4. Adapter contract and the "no direct Mission mutation" boundary

`ProviderAdapter` (`mission-provider-adapter.ts`) has exactly the five
methods requested (`discoverCapabilities`, `prepareInvocation`, `parseEvent`,
`collectResult`, optional `requestCancellation`) — none of them accept a
Mission, a `MissionCommand`, or a `MissionSchedulerStore`. This is enforced
structurally: there is no parameter type an adapter implementation could
even attempt to mutate domain state through.
`adapter methods never touch a Mission or scheduler store` proves this at
runtime too, via a `Proxy` that throws on any property access, passed to
every adapter call and never touched. The layering is:
`MissionDispatchRuntime` (fencing, lease renewal, authoritative completion)
→ `ProcessExecutionHost` (process/environment lifecycle) →
`ProviderAdapter` (protocol translation only) — and the boundary only runs
one direction: an adapter's `ProviderResult` becomes an `ExecutionOutcome`
ONLY by passing back through `MissionDispatchRuntime.tick`'s existing
fencing check (Phase 2D.2), never directly.
`stale execution cannot commit through an adapter` proves this specifically:
a `FakeProviderAdapter` reports a genuine success, but the outcome is still
discarded once the fence has moved on — the adapter's own view of "I
succeeded" carries no special authority.

### 5. Capability model

Eleven capabilities (`PROVIDER_CAPABILITIES`), each required present as an
explicit boolean (`ProviderCapabilities = Record<ProviderCapability,
boolean>`) — `allCapabilitiesFalse()` is the honest default, never an
implicit "unspecified means maybe." `ProviderAdapterRegistry.
assertCapabilities` is the pre-launch gate: looks up the adapter, calls
`discoverCapabilities` fresh (never cached from an earlier call — discovery
may depend on the environment), and refuses with the SPECIFIC missing
capabilities. `assertCapabilities rejects, before launch, when a required
capability is not supported` proves the rejection identifies exactly
`["session_resume"]`, not just "something's missing."

### 6. Normalized event/result model

Eleven `provider.*` event types (`PROVIDER_EVENT_TYPES`), every normalized
event carrying `executionId`, `adapterId`, `providerSessionRef`,
`correlationId`, `causationId`, `timestamp`, `rawEventRef`, and
`redactionStatus` — the same envelope discipline `MissionEventEnvelope`
(mission-events.ts) applies to domain events, extended with the one field a
provider event needs that a domain event doesn't: `redactionStatus`, so an
event carrying unredacted content is required to SAY SO rather than default
to looking safe. `parseEvent` is pure (no I/O), proven deterministic by
`parseEvent normalizes deterministically`. `raw provider output is redacted
before durable exposure` proves the redaction integration point using
`redactSession` DIRECTLY (not a stand-in), the reuse this phase's audit
found already exists and correctly works for this purpose.

### 7. New files

- `mission-process-host.ts` — `ProcessExecutionHost` (prepare/launch/
  inspect/reattach/terminate/quarantine/collect/cleanup, exactly the
  requested shape), `PersistableProcessHandle`, `HostProcessStatus`
  (4 raw kinds `inspect` can report — see the note in the file on why
  these differ from the 5 named recovery OUTCOMES), `HostOutput`/
  `HostOutputEvent`, and `InMemoryProcessExecutionHost` (a scriptable fake,
  not a real host).
- `mission-provider-adapter.ts` — `ProviderAdapter`, the capability model,
  the normalized event/result model, `FakeProviderAdapter` (a test double,
  not Codex or Claude Code).
- `mission-provider-registry.ts` — `ProviderAdapterRegistry`,
  `assertCapabilities`.
- `mission-process-recovery.ts` — `determineRecoveryAction` (pure),
  `recoverOutstandingIntentsWithProcessHost` (impure coordinator).
- `mission-scheduler-store.ts`/`-supabase.ts` — extended:
  `DispatchInstruction.processHandle` (nullable), `MissionSchedulerStore.
  attachProcessHandle`. Migration `20260726010000_mission_dispatch_
  leases.sql` — added `mission_dispatch_intents.process_handle jsonb`
  (edited in place, consistent with this repo's existing convention for a
  migration that has never been applied anywhere), and the RPC's returned
  instruction jsonb now includes `processHandle: null` for a fresh claim.
- Five new test files, 32 new tests total:
  `mission-process-host.test.ts` (6), `mission-provider-adapter.test.ts`
  (8), `mission-provider-registry.test.ts` (4), `mission-process-
  recovery.test.ts` (10, including all 5 rules, duplicate-dispatch-after-
  recovery, stale-execution-through-an-adapter, and terminal-execution-
  immutability). (mission-scheduler-store.ts's existing tests needed no new
  file — `processHandle: null` slotted into the existing construction path
  without changing behavior.)

### What this phase deliberately did NOT build

`RealExecutionHost` — a class implementing the SIMPLE `ExecutionHost`
(`start`/`poll`/`cancel`, Phase 2D.2) by composing a real
`ProcessExecutionHost` + `ProviderAdapterRegistry` — is integration glue,
not a new contract, and is exactly the seam the file plan below describes
concretely rather than builds. Building it now, without a real
`ProcessExecutionHost` behind it, would only wrap one fake in another.

### 8. Concrete file plan: Codex and Claude Code adapters (Phase 3B, not built here)

1. **`src/lib/mission/mission-process-host-node.ts`** (new) — the first
   REAL `ProcessExecutionHost`. `prepare` wraps `createGrantWorktree`/
   `worktreeSpecForGrant` (`resident-write-isolation.ts`) to get a real
   isolated git worktree per instruction; `launch` wraps
   `runProviderProcess` (`resident-provider-adapters.ts`) but adapted to
   the poll shape — spawn in the background, store the child's `pid` +
   `process.hrtime`-derived or `/proc`-read start-time as
   `processStartIdentity`, resolve `inspect`/`collect` against that stored
   state rather than blocking on the promise `runProviderProcess` normally
   returns; `terminate` calls the same `child.kill()` path;
   `quarantine`/`cleanup` extend `resident-write-isolation.ts` with a
   "move aside, don't delete yet" step for the quarantine case specifically
   (currently that module only ever creates worktrees, never quarantines
   one).
2. **`src/lib/mission/mission-provider-adapter-codex.ts`** (new) —
   `CodexProviderAdapter implements ProviderAdapter`. `prepareInvocation`
   wraps `buildCodexLaunchSpec`; `parseEvent` wraps the SAME stream-json
   event parsing `parseCodexResult` already does, refactored to emit
   incrementally (one `ProviderEvent` per line) rather than only at the
   end; `collectResult` wraps `parseCodexResult`'s final-state extraction
   directly, then runs `redactSession` (`session-redaction.ts`) over the
   summary before returning it — reusing `executeProviderLaunch`'s existing
   token-budget-ceiling and redaction wiring rather than reimplementing
   either. `discoverCapabilities` starts as a static declaration
   (`non_interactive_execution: true`, `structured_output: true`,
   `tool_event_reporting: true`, `usage_reporting: true`,
   `repository_editing: true`; `interactive_session`/`session_resume`/
   `image_input`/`approval_requests` false until verified) — a later pass
   can make it probe-based once there's a reason to distrust the static
   claim.
3. **`src/lib/mission/mission-provider-adapter-claude-code.ts`** (new) —
   `ClaudeCodeProviderAdapter implements ProviderAdapter`, same shape,
   wrapping `buildClaudeCodeLaunchSpec`/`parseClaudeCodeResult`.
4. **`src/lib/mission/mission-real-execution-host.ts`** (new) — the
   `ExecutionHost` (Phase 2D.2's simple interface) that
   `MissionDispatchRuntime` actually takes in production: composes
   `mission-process-host-node.ts` + `ProviderAdapterRegistry` (registered
   with both adapters above) + `MissionSchedulerStore.attachProcessHandle`
   (called right after `launch`, closing the exact gap this phase's
   recovery correction depends on). `start` = registry.assertCapabilities →
   adapter.prepareInvocation → host.prepare → host.launch →
   store.attachProcessHandle; `poll` = host.inspect + host.collect →
   adapter.collectResult when finished; `cancel` = host.terminate.
5. Contract tests for 1–4 run against the SAME fakes this phase already
   built (`InMemoryProcessExecutionHost`, `FakeProviderAdapter`) plus new
   tests specific to the Node wrapper (real worktree creation, real
   `child_process` timeout/cancel) — no network calls to a real Codex/
   Claude Code binary in CI, matching this repo's existing test posture for
   `resident-provider-adapters.ts` itself.

### Verification actually run

Full suite: **1200 passing** (up from 1172 before this phase — 32 new
tests across 4 new test files), 0 failures. Typecheck clean. Lint: 0
errors, 17 pre-existing warnings, none in new files (two lint issues
introduced mid-phase — a literal-type annotation ESLint prefers as `as
const`, and two unused interface-mandated parameters — were both found and
fixed before this report, not left for a human to catch). Build: succeeds.
No database-verified/deployment-complete distinction beyond what Phase
2D.1 already carries — the one schema change (`process_handle` column) is
part of that same still-unapplied migration.

## Phase 3B — Codex ProviderAdapter through the real ProcessExecutionHost

Scope: the first REAL implementations behind Phase 3A's interfaces —
`NodeProcessExecutionHost`, `CodexProviderAdapter`, and `RealExecutionHost`
(the composition that becomes `MissionDispatchRuntime`'s production
`ExecutionHost`) — following exactly the file plan Phase 3A's notes laid
out. Claude Code's adapter, Devin, and everything else Phase 3A deferred
remain deferred.

### Reused, not duplicated

- `runProviderProcess` (`resident-provider-adapters.ts`) — the actual
  spawn/timeout/cancel/output-capture. `NodeProcessExecutionHost.launch`
  calls it directly; nothing here re-spawns a process a second way.
- `createGrantWorktree`/`worktreeSpecForGrant` (`resident-write-
  isolation.ts`) — real git-worktree isolation, reused for `prepare`.
- `buildCodexLaunchSpec`/`parseCodexResult`/`jsonLines` (`resident-provider-
  adapters.ts`) — `CodexProviderAdapter` wraps all three rather than
  reimplementing Codex's stream-json protocol.
- `redactSession` (`session-redaction.ts`) — every text `CodexProviderAdapter`
  emits (in `parseEvent`'s `provider.output` events and in `collectResult`'s
  summary) goes through it first.

### Two small, additive changes to shared production code — not duplication

Both were the minimum needed to make wrapping possible without
reimplementing anything:

1. `runProviderProcess` gained an optional 6th parameter, `onProcessId?:
   (pid: number | undefined) => void`, called immediately after `spawn`
   returns. Every existing call site omits it; `resident-provider-
   adapters.test.ts`'s full 23-test suite still passes unchanged. Without
   this, there was no way for a poll-based caller to learn the OS pid at
   all — `runProviderProcess` only ever returns a `ProviderProcessOutcome`
   once the process has already exited.
2. `jsonLines` changed from a private helper to an exported one — the exact
   line-delimited-JSON parsing `parseCodexResult` uses internally, now
   reused by `CodexProviderAdapter.parseEvent` for incremental (per-line)
   normalization instead of only the final-state extraction
   `parseCodexResult` does. No behavior changed, only visibility.

### An honest limitation this phase surfaces, not papers over

A Node `child_process` cannot be reattached to by a different process
instance — there is no OS/runtime primitive `NodeProcessExecutionHost` uses
that lets a restarted supervisor resume a piped child's stdio. This is a
genuine constraint of "a plain child_process," not an implementation gap:
`NodeProcessExecutionHost.reattach` always refuses, and its `inspect` never
reports `process_alive_reattachable` — only `process_alive_not_reattachable`
(tracked in memory, this instance's own bookkeeping) or
`process_status_unknown` (no in-memory record — the realistic restart case).
Consequence for `mission-process-recovery.ts`'s five rules: rule 2
(`restore_supervision`) simply never fires for this host; a still-alive
process this host tracked is always rule 3 (terminate, confirm, revoke), and
anything from a restarted instance is always rule 4 or 5 depending on
`environmentKind`. A future host backed by a real supervisor daemon or
container runtime COULD support real reattachment — this one honestly
can't, and its capability profile says so rather than claiming otherwise.

### Process identity, concretely

`NodeProcessExecutionHost.launch` captures the real OS `pid` via the new
`onProcessId` callback and pairs it with a `processStartIdentity` derived
from `${pid}-${Date.now()}` — sufficient to detect "this isn't the process I
launched" WITHIN one host instance's lifetime (a second `launch` call never
reuses the same identity string), though not a true OS-level start-time
comparison across a full host-process restart, since (per the limitation
above) a restarted instance has no in-memory record to compare against at
all and reports `process_status_unknown` regardless of what
`processStartIdentity` a caller presents.

### `CodexProviderAdapter`

Statically declares `non_interactive_execution`, `structured_output`,
`tool_event_reporting`, `usage_reporting`, `repository_editing` as
supported and everything else as NOT supported — an honest reflection of
what `buildCodexLaunchSpec`/`parseCodexResult` actually do today, not a
probed capability set (there's no Codex CLI handshake to probe). `parseEvent`
normalizes `thread.started` → `provider.session_started`, `item.completed`
with an `agent_message` → `provider.output` (redacted via `redactSession`
before the event is even constructed), `error`/`turn.failed` →
`provider.failed`. `collectResult` wraps `parseCodexResult` directly and
redacts its `resultText` before returning it as the normalized result's
summary — verified with a real Anthropic-shaped API key and a real Bearer
token in `mission-provider-adapter-codex.test.ts`, proving the redaction
integration actually removes the secret, not just that a flag is set.

### `RealExecutionHost`

The `ExecutionHost` (Phase 2D.2's simple `start/poll/cancel`)
`MissionDispatchRuntime` takes in production: `start` = capability-check
(`ProviderAdapterRegistry.assertCapabilities`, refusing BEFORE anything is
prepared or launched — proven by
`start rejects before launching anything when the adapter lacks a required
capability`, which also asserts nothing was persisted) → `processHost.
prepare` → `adapter.prepareInvocation` → `processHost.launch` →
`schedulerStore.attachProcessHandle` (closing Phase 3A's recovery gap —
proven by `start persists the launched process handle via
attachProcessHandle`). `poll` = `processHost.collect` (null while
`exitCode` is null) → `adapter.collectResult` once finished. `cancel` =
`processHost.terminate`. Contains no domain logic of its own — it only
sequences calls into the layers that already own each decision.

### New files

- `mission-process-host-node.ts` — `NodeProcessExecutionHost`.
- `mission-provider-adapter-codex.ts` — `CodexProviderAdapter`.
- `mission-real-execution-host.ts` — `RealExecutionHost`.
- Three new test files, 20 new tests: `mission-process-host-node.test.ts`
  (7 — including two REAL spawned/killed `node -e` child processes, and
  git-worktree operations verified via an injected fake executor, same
  pattern `resident-write-isolation.test.ts` uses for `createGrantWorktree`
  itself), `mission-provider-adapter-codex.test.ts` (9), `mission-real-
  execution-host.test.ts` (4).
- `InMemoryProcessExecutionHost` (Phase 3A) gained one new test-control
  method, `setExitCode`, needed to script a completed outcome through
  `RealExecutionHost.poll` in `mission-real-execution-host.test.ts` — no
  behavior change to the fake's actual contract methods.

### What this phase deliberately did NOT build

`ClaudeCodeProviderAdapter` (file plan item 3 from Phase 3A) — same shape as
`CodexProviderAdapter`, wrapping `buildClaudeCodeLaunchSpec`/
`parseClaudeCodeResult`, not built here per the instruction's explicit scope
("Codex ProviderAdapter"). Devin, Planner, agent messaging, Mission UI, and
voice remain out of scope, unchanged from Phase 3A.

### Verification actually run

Full suite: **1220 passing** (up from 1200 before this phase — 20 new
tests across 3 new test files), 0 failures. Typecheck clean. Lint: 0
errors, 17 pre-existing warnings, none in new files. Build: succeeds. No new
database work — this phase is entirely process/adapter wiring; the schema
gap Phase 3A already documented is unchanged. Two REAL child processes are
spawned and killed in `mission-process-host-node.test.ts` (a `node -e` echo
and a `node -e` sleep) — no Codex or Claude Code binary is ever invoked in
any test.

## Phase 3C — Claude Code ProviderAdapter through the existing RealExecutionHost

Scope: the second real `ProviderAdapter`, running through the EXACT same
path Codex does — no `ClaudeProcessExecutionHost`, no Claude-specific lease
logic, no second worktree system. Also: a fencing gap found and fixed in
`RealExecutionHost` itself (provider-agnostic, so it benefits Codex too),
and a capability-accuracy correction to `CodexProviderAdapter` found while
auditing Claude's for the same mistake.

### Execution call path (unchanged from Codex, confirmed identical)

```
MissionDispatchRuntime → RealExecutionHost → NodeProcessExecutionHost
  → ClaudeCodeProviderAdapter → buildClaudeCodeLaunchSpec /
    parseClaudeCodeResult / runProviderProcess
```

Proven, not assumed: `mission-provider-adapter-contract.test.ts` runs the
IDENTICAL `RealExecutionHost`/`InMemoryProcessExecutionHost` composition for
both `CodexProviderAdapter` and `ClaudeCodeProviderAdapter` and asserts the
same things happen either way (capability gating before launch, a process
handle persisted via `attachProcessHandle`, fencing enforced before launch
and before completion, lease-loss cancellation, duplicate-dispatch
resolving to one winner).

### Reused Claude components (per the audit requirement)

- `buildClaudeCodeLaunchSpec` — `ClaudeCodeProviderAdapter.prepareInvocation`
  calls it directly.
- `parseClaudeCodeResult` — `collectResult` wraps it directly.
- `jsonLines` (exported additively in Phase 3B) — `parseEvent`'s
  incremental line-splitting.
- `runProviderProcess`/`executeProviderLaunch` — via
  `NodeProcessExecutionHost`, unchanged from Phase 3B; no Claude-specific
  process spawning exists anywhere.
- Worktree isolation (`createGrantWorktree`) — via
  `NodeProcessExecutionHost.prepare`, unchanged; no second worktree system.
- `redactSession` — every text this adapter emits (in `parseEvent`'s
  `provider.completed` events and in `collectResult`'s summary) is redacted
  through it, never a Claude-specific scrubber.
- Environment allowlisting — inherited for free: `buildClaudeCodeLaunchSpec`
  already calls a curated env allowlist internally
  (`selectedEnvironment("claude-code")`, PATH/HOME/`ANTHROPIC_API_KEY`/
  `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`/`CLAUDE_CODE_GIT_BASH_PATH`
  only). This adapter does not maintain a second allowlist. Tested directly:
  a synthetic `SOME_UNRELATED_SECRET` env var set in the test process never
  appears in the produced spec's `env`.
- Cancellation/timeout — `ProcessExecutionHost.terminate`/
  `runProviderProcess`'s own `setTimeout`, unchanged; no
  `requestCancellation` implemented (Claude Code has no cooperative
  cancellation protocol beyond a process kill, same as Codex).

### Wrapper changes

None to `ClaudeCodeProviderAdapter` requiring changes elsewhere — it's a
pure consumer of what Phase 3B already exported (`jsonLines`,
`buildClaudeCodeLaunchSpec`, `parseClaudeCodeResult`). Two changes were made
to shared code, both applying to BOTH providers, not Claude-specific:

1. **`RealExecutionHost.start` now validates the fence BEFORE preparing or
   launching anything.** This was a real gap: nothing previously stopped
   `start` from calling `processHost.prepare`/`launch` for an instruction
   whose lease had already been superseded by a later claim. Fixed by
   calling `schedulerStore.validateFence` first and throwing before any
   side effect if it's no longer current. Provider-agnostic — the fix lives
   in `RealExecutionHost`, used by both adapters, and is proven for both in
   `mission-provider-adapter-contract.test.ts`'s `start refuses to launch
   anything when the fence is already stale`.
2. **`CodexProviderAdapter`'s declared `tool_event_reporting: true` was
   wrong and is now `false`.** Found while auditing Claude's capabilities
   for the same mistake (item 3's explicit "audit specifically... tool
   events" requirement): `parseCodexResult` never distinguished a tool call
   from a plain `agent_message`, so `parseEvent` never actually emitted
   `provider.tool_requested`/`provider.tool_completed` — the capability was
   fabricated. No test had asserted the true value, so nothing broke;
   corrected as part of this phase's capability-accuracy audit rather than
   left for a later pass to discover.

### Capability declaration

`ClaudeCodeProviderAdapter` declares true: `non_interactive_execution`
(`--print`), `structured_output` (`--output-format stream-json` +
`--json-schema`), `streaming_output` (incremental `parseEvent` per
`onOutput` chunk, matching Codex's treatment), `usage_reporting`
(`extractProviderUsage`, reused), `repository_editing` (`--tools
Read,Edit,Write,Grep,Glob` in `workspace_write` mode). Declares false,
audited explicitly per item 3: `interactive_session`/`session_resume`
(`--no-session-persistence` rules out both), `tool_event_reporting`
(`parseClaudeCodeResult` never distinguishes a tool call — same honesty
correction as Codex's), `approval_requests` (`--permission-mode
dontAsk`/`acceptEdits` — neither ever asks), `image_input` (never
exercised), `cancellation` (no cooperative adapter-level protocol).

### Event normalization — the one deliberate difference from Codex

Claude's `parseEvent` never emits `provider.session_started`, unlike
Codex's (which has a genuine one-shot `thread.started` marker). Claude
Code's stream-json (as reused via `parseClaudeCodeResult`) carries
`session_id` on many lines, not one distinct "start" marker — and
`parseEvent` must stay stateless (the SAME input event must always produce
the SAME output, proven by `parseEvent is deterministic` for both
adapters), which rules out session-tracking state across calls to dedupe a
synthetic start event. Every event this adapter DOES emit still carries
`providerSessionRef` when the line exposes one — "preserve safe session
references where available" is satisfied without fabricating an event the
reused parser gives no reliable signal for. Only a terminal `result` line
maps to `provider.completed`/`provider.failed` (redacted); everything else
becomes `provider.progress` — never inferred as a tool call from
natural-language content, tested directly with a message that literally
says "I will now run the tests using the test runner tool," which still
normalizes to `provider.progress`, not a fabricated `provider.tool_requested`.

### Fencing points verified (identical mechanism to Codex, both proven)

- Before launch: `RealExecutionHost.start`'s new `validateFence` call.
- Before completion becomes authoritative: `MissionDispatchRuntime.tick`'s
  existing (Phase 2D.2) `validateFence` check, unchanged — proven here with
  a Claude-produced `ProviderResult` fed through it and discarded once
  stale, with the REPLACEMENT holder's lease confirmed untouched.
- Lease loss cancels the local process: `tick`'s renewal-failure branch
  calling `host.cancel` → `processHost.terminate`, proven for Claude in the
  parity suite.
- Duplicate dispatch: `store.claimCandidates`'s existing atomicity
  (Phase 2D.1, unchanged) — proven again here specifically with
  `adapterRequirement: "claude-code"` racing.

### Redaction results

Verified against realistic Claude/Anthropic-shaped values, not synthetic
placeholders: a full-shaped `sk-ant-api03-...` key (both inside a
`parseEvent`-normalized `provider.completed` payload and inside
`collectResult`'s summary), a `Bearer <token>` header value, and an
`ANTHROPIC_API_KEY=<value>` environment-variable-style assignment embedded
in output text — all confirmed absent from the normalized event/result. A
separate test confirms a successful exit code alone is never treated as
validated evidence: `ProviderResult` has no evidence/validation field for
an adapter to populate at all — that classification remains
`evidence-submission.ts`'s job, downstream, never the adapter's.

### Provider parity contract tests (item 8)

`mission-provider-adapter-contract.test.ts` runs the identical 12-test
suite against both adapters (24 tests total): registry registration,
pre-launch capability rejection, deterministic invocation, no secret env
values, normalized terminal-result shape, deterministic event parsing,
structural inability to mutate a Mission/store, working through the shared
`RealExecutionHost`/`InMemoryProcessExecutionHost`, stale-fence rejection at
launch, stale-completion discard with the replacement's lease untouched,
lease-loss cancellation, and duplicate-dispatch resolution. All 24 pass.

### Tests and results

- `mission-provider-adapter-claude-code.test.ts` — 16 tests (capability
  declaration, deterministic/env-allowlisted invocation, event
  normalization including the no-session-started/no-inferred-tool-call
  properties, `collectResult` success/failure, the no-evidence-field
  property, three redaction scenarios, and a persisted-process-handle
  secret-exclusion check with a real `ANTHROPIC_API_KEY` value set in the
  test process's own environment).
- `mission-provider-adapter-contract.test.ts` — 24 tests (12 × 2 providers).
- `mission-process-host-node.test.ts` — 2 new tests added (timeout via a
  real spawned-and-killed process, idempotent `cleanup`), both run with
  `adapterRequirement: "claude-code"` to make explicit they exercise
  Claude's exact host path, not a Codex-only one. 9 total in this file now.
- PID-reuse mismatch and restart-recovery behavior are NOT re-tested a
  third time per-provider — they're already proven provider-agnostic in
  Phase 3A/3B (`mission-process-host.test.ts`, `mission-process-
  recovery.test.ts`) and this phase's parity suite additionally confirms
  both adapters exercise the identical `NodeProcessExecutionHost`/
  `MissionSchedulerStore` mechanism those tests already cover.
- `resident-provider-adapters.test.ts` (the existing, non-Mission Claude
  Run test suite) — all 23 tests still pass unchanged, confirming
  "existing non-Mission Claude Run behavior remains unchanged."

Full suite: **1262 passing** (up from 1220 before this phase — 16 + 24 + 2
new, plus the existing-suite re-verification), 0 failures. Typecheck clean.
Lint: 0 errors, 17 pre-existing warnings, none in new files. Build:
succeeds.

### Live smoke-test status

**Not run.** No Claude Code CLI binary is available/authenticated in this
environment, and per instruction this must never become a CI requirement.
Item 10's manual smoke test (a harmless, bounded task against a disposable
repository, recording normalized events/worktree isolation/terminal
output/redaction/cleanup) remains a manual, human-initiated step for
whoever has local Claude Code access — not attempted here.

### What this phase deliberately did NOT build

Cross-agent messaging, Planner, Mission UI, voice, Devin, provider-selection
policy beyond the existing registry lookup, trajectory analysis — all
unchanged from Phase 3A/3B's scope boundary.

### Remaining work for Phase 3D

1. Wire `RealExecutionHost` + a populated `ProviderAdapterRegistry`
   (Codex + Claude Code both registered) into an actual scheduler
   poll-loop process — nothing today calls `MissionDispatchRuntime.tick`/
   `adopt`/`recoverOnStartup` on a real interval; every test constructs and
   drives a `MissionDispatchRuntime` by hand.
2. A live-database pass: apply the Phase 2D.1 migration to a real Supabase
   project and re-verify the atomicity claims that have only ever been
   proven against fakes (documented as a gap since Phase 2C).
3. The manual Claude Code live smoke test (item 10), whenever a human with
   local Claude Code access wants to run it.
4. Provider-selection policy beyond "the caller already knows which
   `adapterRequirement` string to put on the instruction" — today nothing
   decides Codex-vs-Claude-Code for a given Mission; that decision surface
   was explicitly out of scope for both 3B and 3C.

## Phase 4A — Mission-native participants, assignments, and the Agent Message Protocol foundation

Scope: the durable domain model and command/event infrastructure a future
Planner/UI/voice will depend on — not those systems themselves. No Planner,
no UI, no voice, no third provider, no second execution/lease/worktree/
process architecture.

### Pre-implementation audit (deliverables A–D)

- **A. Files extended, nothing new at the persistence layer:**
  `mission-domain.ts` (participant/assignment/message types + statuses),
  `mission-events.ts` (5 new event types), `mission-commands.ts` (13 new
  commands + a `COLLABORATION_COMMAND_TYPES` routing set),
  `mission-command-handler.ts` (a new branch, sharing the existing
  version/causation-chaining event-emission logic with the Mission-state
  path rather than duplicating it), `mission-projection.ts`
  (`participants`/`assignments`/`messages`). One migration edit (the
  `mission_events.event_type` check constraint only) — no new tables,
  because participants/assignments/messages are all just new event payload
  shapes riding the existing jsonb `payload` column.
- **B. Domain conflicts found:** none blocking. `MissionParticipant` and
  `mission.participant_added`/`AssignmentId` existed from Phase 1 but were
  never actually populated anywhere (`Mission.participants: []` was
  confirmed, by grep, to be dead — no code constructs one). Extended
  `MissionParticipant` freely; left `mission.participant_added` completely
  untouched and added `mission.participant_registered` alongside it for the
  richer snapshot, so every Phase-1 test keeps passing unmodified.
- **C. New events:** `mission.participant_registered`,
  `mission.participant_status_changed`, `mission.participant_removed`,
  `mission.assignment_created`, `mission.assignment_status_changed`,
  `mission.message_posted`.
- **D. Implementation sequence used:** domain types → events → pure
  transition/dependency/policy modules → commands → command-handler
  (collaboration branch) → projection → migration constraint →
  execution-metadata threading → tests.

### A third and fourth state machine, not a second Mission state machine

`mission-collaboration.ts` defines `ParticipantStatus`/`AssignmentStatus`
transition tables, entirely separate from `Mission.state`
(mission-state-machine.ts), `DispatchLeaseState` (mission-scheduler.ts), and
`ExecutionState` (mission-execution.ts) — the same layering discipline every
prior phase drew. An assignment coordinates the EXISTING dispatch/execution
primitives via its `dispatchKey` field (set by `AssignAssignment`, naming
the scheduler slot `workspaceId + missionId + dispatchKey` that actually
gets leased) rather than replacing them; nothing new was built at the
scheduler/runtime layer.

### Commands added (13)

`AddParticipant`, `ActivateParticipant`, `RemoveParticipant`,
`CreateAssignment`, `AssignAssignment`, `StartAssignment`,
`BlockAssignment`, `SubmitAssignment`, `VerifyAssignment`,
`AcceptAssignment`, `RejectAssignment`, `CancelAssignment`, `PostMessage`.
All flow through the EXACT same `applyMissionCommand` seam — idempotency
check, existence check, and optimistic-concurrency check are shared,
unmodified code paths; only a new branch (`isCollaborationCommand`) skips
`intendedTargetState`/`validateTransition`/`payloadsFor` (the Mission-state
machinery) and calls `buildCollaborationPayloads` instead, which reuses the
SAME event-emission/causation-chaining loop via the shared tail — never
duplicated code, a small refactor of the existing function.

### Events added (6)

Listed above. Every one carries the same envelope (correlationId,
causationId, actor, provenance, timestamp) every Mission event already
does — nothing new was invented for these.

### Projections added

`MissionProjection.participants: Record<ParticipantId, MissionParticipant>`,
`.assignments: Record<AssignmentId, MissionAssignment>`,
`.messages: MissionMessage[]` (append-only, same pattern as
`attachedEvidenceIds`). Known scale limitation, not solved here: an
unbounded message log folded into every projection read will grow without
bound for a long-lived, chatty Mission — flagged for a later phase, not
silently accepted as fine.

### Persistence changes

In-memory: none needed beyond the projection/event-handler changes above —
`InMemoryMissionStore`/`InMemoryIdempotencyStore` are event-type-agnostic
already. Supabase: the ONE migration edit (event_type check constraint).
`SupabaseMissionEventReader`/`SupabaseMissionCommandPersistence` needed no
changes — they already round-trip `payload` as opaque jsonb regardless of
which event type it belongs to. Tenant-scoped idempotency (Phase 2D.1's
`(workspace_id, idempotency_key)` primary key) and the atomic RPC are
unchanged and apply to collaboration commands exactly as they do to every
other Mission command, since they're the same command→event→persistence
pipeline. No RLS/tenant boundary was touched, let alone weakened.

### Communication policy (mission-communication-policy.ts)

Enforced BEFORE a `mission.message_posted` event is ever constructed:
unknown/inactive sender, unknown/removed recipient (this is also how
cross-Mission addressing is refused — a foreign Mission's participant id is
structurally absent from the CURRENT Mission's own `participants` map, so
no separate mission-id comparison is needed or possible from inside a
single-Mission pure function), broadcast disallowed by either the Mission
policy OR the sender's own permission (both gates must pass), invalid
assignment reference, delegation beyond the smaller of the Mission policy's
and the sender's own `maxDelegationDepth`, delegation on an assignment the
sender doesn't actually hold, and self-referential delegation (sender
addressed as its own recipient). `delegationDepth` is caller-supplied on the
command rather than derived by walking a reply/causation chain — a
simplification stated explicitly, not hidden, and listed under remaining
work below.

### Execution integration

Participant/assignment identity rides in the SAME opaque
`executionConstraints` bag every other adapter-specific field already
uses — `RealExecutionHost.start` reads `executionConstraints.participantId`/
`.assignmentId` (both optional strings) and includes them on the
`ProviderAssignment` it hands to `adapter.prepareInvocation`. No new field
on `DispatchInstruction`/`DispatchCandidateRequest`, no second dispatch
schema. Proven identical for both providers in
`mission-collaboration-execution.test.ts` (parametrized over
`CodexProviderAdapter`/`ClaudeCodeProviderAdapter`, matching Phase 3C's
parity pattern): metadata present on the dispatch reaches the constructed
`ProviderAssignment` for both, and is left `null` (never fabricated) when
absent. Honestly NOT wired further: nothing in this codebase currently
streams `parseEvent`'s normalized events anywhere in real time — no caller
invokes it from `RealExecutionHost` — so "normalized provider events
carrying participant/assignment identity" is not yet a real, testable path;
flagged as remaining work rather than claimed as done.

### Recovery / determinism behavior defined

- **Duplicate participant/assignment/message commands:** idempotency-key
  replay, identical to every other Mission command — proven directly
  (`command idempotency: a duplicate AddParticipant... replays rather than
  double-registering`).
- **Stale commands:** optimistic-concurrency `version_conflict`, same
  mechanism as Mission-state commands — proven directly.
- **Restart recovery:** `projectMission` (unchanged) folds the SAME event
  types this phase added exactly like every other event type — proven by
  rebuilding a projection from raw events and asserting it's byte-identical
  to the incrementally-applied one, after participants/assignments/messages
  are all present.
- **Participant removal during active execution:** flips the participant's
  own status to `removed` and touches NOTHING else — no second execution
  state machine reacts automatically; a human/reconciler must issue its own
  typed `BlockAssignment`/`CancelAssignment`, a separate decision, never an
  implicit side effect. Proven directly.
- **Blocked assignments / dependency completion:** `StartAssignment`
  refuses with `assignment_dependencies_unsatisfied` (naming every
  unsatisfied dependency id) until every dependency reaches `accepted`
  specifically — `verified` is deliberately not enough, since a verified-
  but-not-yet-accepted assignment can still be rejected.
- **Stale fences:** unchanged — this phase adds no new fencing concern;
  dispatch/lease fencing (Phase 2D.1/2D.2/3A) still governs whatever
  execution an assignment's `dispatchKey` names.
- **Process failure during an assignment / Mission restart while an
  assignment is running:** deliberately NOT auto-mapped by a new mechanism.
  The existing `ExecutionState`/lease recovery model (Phase 2D.2/3A) governs
  the underlying dispatch exactly as before; an assignment's own status
  transition (e.g. to `blocked`/`failed`) is a separate, explicit command a
  caller issues in response — this phase does not pretend process
  reattachment is available where Node's `child_process` genuinely can't
  support it (unchanged from Phase 3B's documented limitation), and does
  not invent an automatic assignment-status-follows-execution-status
  linkage that would be a second, implicit execution state machine.

### Tests added (46, across 4 new files)

`mission-collaboration.test.ts` (14 — pure transitions, dependency check),
`mission-communication-policy.test.ts` (16 — every policy violation),
`mission-command-handler-collaboration.test.ts` (16 — participant lifecycle,
assignment lifecycle, dependency handling, participant removal during
active execution, message rejections through the FULL command path,
idempotency, optimistic concurrency, deterministic-projection/restart-
recovery), `mission-collaboration-execution.test.ts` (4 — assignment
metadata reaching `RealExecutionHost`, parametrized over Codex and Claude,
proving identical coordination behavior for both). All existing Phase 1–3
mission tests (104 in the core mission suite, 1262 in the full repo suite
before this phase) pass unchanged.

### Verification actually run

Full suite: **1312 passing** (up from 1262 before this phase — 46 + 4
already-counted new tests... precisely: 50 new tests total across the 4
files above), 0 failures. Typecheck clean. Lint: 0 errors, 17 pre-existing
warnings, none in new files (one unused import introduced mid-phase was
found and removed before this report). Build: succeeds.

### Architectural limitations found

1. **No live-database verification** — unchanged, pre-existing gap since
   Phase 2C: this environment has no Postgres to apply the migration
   constraint change against.
2. **Message log is unbounded in the projection** — flagged above, not
   solved.
3. **`delegationDepth` is caller-supplied, not chain-derived** — a real
   simplification; a determined caller could lie about its own depth. Fine
   for this phase's "foundation" scope, but a gap a Planner-era pass should
   close by deriving depth from the message's own `causationId`/
   `replyToMessageId` chain instead of trusting the field.
4. **No caller currently streams `parseEvent` output anywhere** — so
   participant/assignment identity reaching NORMALIZED PROVIDER EVENTS
   (as opposed to `ProviderAssignment`, which is proven) is aspirational
   until a real-time event pipeline exists to carry it.

### Provider capability claims corrected during the audit

None in this phase — Phase 3C's capability audit (Codex's `tool_event_
reporting` correction) is the most recent correction; this phase touched no
capability declarations.

## Phase 4B — causal collaboration and bounded delegation

Scope: convert Phase 4A's passive message log into a controlled protocol.
Given the size of the requested spec, this phase implemented the highest-
value, fully-tested core rather than every sub-bullet of every section —
what's covered and what's explicitly deferred is stated below, not left
implicit.

### Audit findings (before implementation)

`MissionMessage` already had `causationId`/`replyToMessageId` — chain links
existed but were completely unused. `delegationDepth` on `PostMessage` was a
trusted, caller-declared number (the critical hole this phase closes).
`waiting_for_input` was a reachable assignment status with no command that
ever reached it. No finding lifecycle existed. `parseEvent` output was never
ingested anywhere (Phase 4A's own documented limitation).

### Chain-derived delegation (the critical correction)

`mission-collaboration-graph.ts`'s `deriveDelegationDepth` walks a
`delegation_request`'s `replyToMessageId`/`causationId` chain backward,
counting prior `delegation_request`s — computed from `current.messages`
(the projection's own state), NEVER from anything the command supplies.
`PostMessage`'s `delegationDepth` field was DELETED from the command type
entirely (not just ignored) — a caller cannot even express a depth anymore,
which is what makes "falsified caller depth" structurally impossible rather
than merely rejected. Fails closed on: an unknown message id in the chain, a
cyclic chain, and (separately) `wouldCreateParticipantCycle`/
`hasAssignmentCycle` for participant/assignment cycles.

### Structured protocol (partial — stated honestly)

`MissionMessage` gained `structuredPayload: Record<string, unknown>`,
interpreted by the command handler rather than free-form `body` text. Full
typed validation was built for `delegation_request`/`delegation_response`
(the depth/cycle/scope/terminal-assignment checks) and for
`question`/`answer` (via the new `AskAssignmentQuestion`/
`AnswerAssignmentQuestion` commands). **NOT built**: dedicated
required-field schemas and auto-command-triggering for `review_request`,
`blocker`, `evidence_notice`, `approval_request`, `completion_notice` —
these remain durable, policy-checked records (sender/recipient/assignment
validity all still apply) but do not yet drive `BlockAssignment`/
`SubmitAssignment`/`AcceptAssignment` automatically the way the instruction's
examples describe. Flagged as the largest deliberate scope cut in this
phase, not an oversight.

### Message-to-command orchestration, atomically

The ONE orchestration built: an accepted `delegation_response` emits BOTH
`mission.message_posted` AND `mission.assignment_created` (the child) in
the SAME `applyMissionCommand` call — genuinely atomic (one command, one
event batch, one version increment), not a two-phase commit or an outbox.
This is the pattern any future `blocker`→`BlockAssignment` /
`completion_notice`→`SubmitAssignment` wiring should follow.

### Child assignments (bounded delegation)

`MissionAssignment` gained `parentAssignmentId`, `originatingMessageId`,
`delegatorParticipantId`, `delegationDepth` — never trusted from a
command, always computed at creation from the accepted `delegation_response`
and its causal chain. `validateScopeNarrowing` (mission-collaboration-
graph.ts) rejects any child whose allowed paths exceed the parent's or
whose prohibited paths are narrower than the parent's — a child can only
ever narrow authority. Duplicate/conflicting responses to the same request
are resolved deterministically: the first accepted response wins; a second
is refused as `duplicate_delegation_response`. Delegation against a
terminal parent (`cancelled`/`failed`/`rejected`/`accepted`) is refused.
**Not separately tested**: delegator removal mid-delegation, parent
cancellation while a child is actively executing, Mission-restart during an
open delegation — the domain model supports inspecting these states (a
removed delegator, a cancelled parent) but dedicated recovery tests for
each specific interruption timing were not written given the scope.

### Finding lifecycle

`MissionFinding` (9 statuses) + `OpenFinding`/`TransitionFinding` commands,
its own small transition table (mission-collaboration.ts) — a THIRD/FOURTH
class of sub-entity state machine alongside participant/assignment status,
never a second Mission or execution state machine. Deliberately NOT
equivalent to assignment rejection: `finding withdrawal closes it without
ever implying assignment rejection` proves the assignment's own status is
untouched by a finding's lifecycle. Whether open findings block
verification is an EXPLICIT policy (`findingsBlockingVerification`),
applied only at `VerifyAssignment(verified: true)` — proven to allow the
`verified: false` (rejection) path through even with an open finding, and to
stop blocking once the finding is withdrawn. A real bug was found and fixed
here: `verified` was initially marked a TERMINAL finding status, which
would have made `verified -> closed` illegal — caught by the finding
lifecycle test failing on the very first run, fixed before this report.

### Clarification and blocking

`AskAssignmentQuestion` moves `running -> waiting_for_input` (validated
against a real, already-posted `question` message); `AnswerAssignmentQuestion`
resumes `waiting_for_input -> running` only when the answer message
genuinely `replyToMessageId`s the specific question — an unrelated message
cannot resolve the wait, proven directly. No new interruption system: since
only `running` leads to `waiting_for_input` in this domain's transition
table, resuming to `running` is deterministic without needing a `resumeTo`
field the way `Mission.state`'s own interruption model needs one (several
possible active states to return to). `unansweredQuestionMessageIds` tracks
open questions in the SAME bounded window as `messages`.

### Provider event ingestion

`RealExecutionHost.pollEvents(handle)` — the smallest addition, using the
EXACT SAME `RealExecutionHost`/`NodeProcessExecutionHost`/`ProviderAdapter`
composition, no new stream supervisor. Consumes only NEW `HostOutputEvent`s
since the last poll (a per-tracked-launch sequence cursor), runs them
through the adapter's existing `parseEvent`, and attaches `executionId`
(from the `ExecutionHandle`) plus `participantId`/`assignmentId` (read from
the tracked launch, sourced from `executionConstraints` exactly as
Phase 4A's `ProviderAssignment` threading already does) — attached AFTER
`parseEvent` returns, never by the adapter, which has no notion of Mission
identity. Proven for both providers: identity attachment, no re-emission on
a repeated poll, order preservation across multiple output chunks, zero
events from an unparseable line, no fabricated tool-call event from prose
that merely mentions a tool, and the one HONEST capability difference kept
intact — Codex emits a real `provider.session_started` for `thread.started`;
Claude Code's adapter never does (Phase 4A's own documented, deliberate
choice), and this phase's ingestion path doesn't paper over that difference.

### Projection bounds

`MissionProjection.messages` is now capped at `MAX_PROJECTION_MESSAGES`
(200), dropping the OLDEST first — fixing the unbounded-growth limitation
Phase 4A flagged. The authoritative history is never truncated:
`queryMissionMessages(events, {cursor, limit})` reads directly from the raw
event stream, recovering messages the live projection has already dropped,
proven directly. `openFindingsCount`/`unansweredQuestionMessageIds` are
summary fields so "is anything waiting?" doesn't require scanning a
(possibly-truncated) message array. Chosen over a new table per the
instruction's preference — extends existing persistence, adds nothing new
to Supabase beyond the two new event-type strings in the same check
constraint every prior phase's new events rode.

### Persistence / migration changes

One migration edit: `mission.finding_opened`/`mission.finding_status_changed`
added to the existing `mission_events.event_type` check constraint (same
migration Phase 4A already touched, itself still never applied anywhere).
No new tables, no Supabase store changes — findings/child-assignments/
delegation are all just new event payload shapes.

### Files added

`mission-collaboration-graph.ts`, `scripts/mission-collaboration-graph.test.ts`,
`scripts/mission-collaboration-delegation.test.ts`,
`scripts/mission-execution-event-ingestion.test.ts`,
`scripts/mission-projection-bounds.test.ts`.

### Files modified

`mission-domain.ts` (delegation fields, finding types, `structuredPayload`),
`mission-events.ts` (2 finding event types + payloads), `mission-commands.ts`
(`AskAssignmentQuestion`, `AnswerAssignmentQuestion`, `OpenFinding`,
`TransitionFinding`; `PostMessage.delegationDepth` removed,
`structuredPayload` added; new typed errors), `mission-command-handler.ts`
(delegation/finding/clarification branches, atomic child-assignment
creation), `mission-collaboration.ts` (finding transition table,
`findingsBlockingVerification`), `mission-communication-policy.ts`
(`delegationDepth` renamed `derivedDelegationDepth`; new violation codes),
`mission-projection.ts` (`findings`, bounded `messages`, summary fields,
`queryMissionMessages`), `mission-provider-adapter.ts` (`participantId`/
`assignmentId` on `ProviderEventEnvelope`), `mission-real-execution-host.ts`
(`pollEvents`), `mission-process-host.ts` (`appendEvents` test control),
the migration file, `package.json`, and the two existing Phase 4A test
files updated for the `delegationDepth` → `derivedDelegationDepth` rename
and the removed command field (mechanical, not behavioral changes).

### Verification actually run

Full suite: **1355 passing** (up from 1312 before this phase — 43 new
tests across 4 new files), 0 failures. Typecheck clean. Lint: 0 errors, 17
pre-existing warnings, none in new files. Build: succeeds. All prior Phase
1–4A tests pass unchanged (the two mechanical test-file edits above are the
only pre-existing test changes, both required by the intentional command-
shape/field-rename changes this phase makes, not behavioral drift).

### Architectural limitations remaining (stated explicitly, not hidden)

1. **review_request/blocker/evidence_notice/approval_request/
   completion_notice have no dedicated typed schema or auto-command-
   triggering yet** — the single largest scope cut this phase made. The
   atomic message→command pattern proven for delegation_response is the
   template a follow-up pass should reuse for these.
2. **Section 10's full recovery matrix (25+ named scenarios) is only
   partially covered** — duplicate messages/responses, concurrent
   delegation responses, stale-fence rejection, and deterministic replay
   after mixed delegation/finding/clarification activity are proven;
   delegator-removed-mid-delegation, parent-cancelled-while-child-running,
   and restart-during-open-finding specifically are not each individually
   tested.
3. **The shared Codex/Claude parity SUITE (Phase 3C's
   `mission-provider-adapter-contract.test.ts`) was not restructured to
   include the new delegation/ingestion scenarios** — parity for those is
   proven in separate, parametrized test files instead
   (`mission-execution-event-ingestion.test.ts`), which achieves the same
   proof but doesn't literally extend the Phase 3C file as instructed.
4. **`delegationDepth` is now derived, but the underlying malformed-chain
   detection is only as good as the messages actually stored** — a
   corrupted/tampered event stream (outside this system's control, e.g. a
   direct DB edit) could still defeat it; this is an acceptable trust
   boundary (the same one every other event-sourced guarantee in this
   codebase already rests on), not a new gap this phase introduces.

### Provider/collaboration capability claims corrected during the audit

None beyond the real bug already noted above (finding status `verified`
incorrectly marked terminal, fixed before this report). No provider
capability declarations were touched in this phase.

## Phase 4C — collaboration protocol completion and recovery hardening

Scope: complete the 5 message types Phase 4B left generic, generalize the
atomic message-to-command seam, harden `pollEvents`, and consolidate
Codex/Claude parity into the canonical Phase 3C file. Extends 4B; nothing
about participants/assignments/messages/delegation/findings/clarification/
ingestion/pagination was redesigned.

### Typed schemas added

`mission-collaboration-protocol.ts` — pure validators for `review_request`,
`blocker`, `evidence_notice`, `approval_request`, `completion_notice`, each
following the exact pattern Phase 4B established for delegation/question/
answer: required fields, sender/recipient/assignment relationship, and
duplicate semantics, all checked against `structuredPayload`, never `body`.

- **review_request**: assignment must be `submitted`; every reviewer must
  be active; self-review refused unless policy explicitly allows it;
  duplicate detection is deliberately narrow (an assignment with an
  outstanding — no-later-message-replies-to-it — `review_request` refuses a
  second one), not a full review aggregate (see limitations).
- **blocker**: a NEW blocker requires a `reason` (one of 7 typed values);
  an UNBLOCK (`resolved: true`) must `replyToMessageId` a real, not-already-
  resolved `blocker` message — an unrelated message can never unblock,
  proven directly.
- **evidence_notice**: requires an assignment reference and at least one
  evidence ref, and every ref must already be known to the Mission
  (`MissionProjection.attachedEvidenceIds`, Phase 1's existing field —
  reused, not duplicated). Never treats presence as correctness — the
  validator only checks the reference is real, never that the evidence
  "passed."
- **approval_request**: informational only. The actual grant/denial is
  always the EXISTING `AcceptAssignment`/`RejectAssignment` command — no
  new "approval_response" message type was invented (the frozen 12-type
  list from Phase 4A has none), avoiding a parallel authority channel.
- **completion_notice**: gates on required evidence and
  `checkDependenciesSatisfied` (reused from mission-collaboration.ts, not
  reimplemented) — but ONLY while the assignment is `running`; past that,
  a duplicate notice is accepted as a no-op, never an error.

### A real authorization gap closed

`AcceptAssignment`/`RejectAssignment` had NO authorization check at all —
any actor could accept any assignment. Fixed by reusing
`MissionAssignment.approvalPolicy` (already existed, Phase 4A, previously
unenforced): when `"human_required"`, the command's `context.actor` must
be `human`; an agent actor is refused as `unauthorized_approval`. This is
the mechanism behind "a provider message cannot grant itself authority" —
the actual decision is a command, gated at the command layer, not a
message.

### Atomic orchestration, generalized

The delegation_response → child-assignment pattern (Phase 4B) is now the
template `PostMessage` applies uniformly: `blocker` (unresolved) →
`BlockAssignment`, `blocker` (resolved, correlated) → resume to `running`,
`completion_notice` (running, valid) → `SubmitAssignment` — each producing
its resulting event in the SAME `applyMissionCommand` call as the message
event, never a second commit. Where a message doesn't authorize a
transition (an invalid completion_notice, any `review_request`/
`evidence_notice`/`approval_request`), only the message event is emitted —
proven by `a completion_notice missing required evidence is rejected, and
the assignment stays running` (the message itself is never partially
applied either — the whole command fails, nothing is persisted).

### Recovery/concurrency covered in this phase

Duplicate completion notices (idempotent no-op), a conflicting decision
after an assignment is already `accepted` (refused — terminal), the
human_required authorization gate itself (an unauthorized actor, then a
human actor, on the SAME assignment), and the existing Phase 4B recovery
set (duplicate messages via idempotency replay, stale version conflict,
malformed causal chain, duplicate delegation response) all still pass
unchanged. **Not separately tested this phase** (stated explicitly, not
hidden): concurrent approval/completion-notice races beyond what optimistic
concurrency already generically guarantees, participant removal mid-review,
parent-cancelled-while-child-running, and most of the 22-item recovery list
in the original instruction — see limitations below.

### Provider event ingestion hardening

`ProviderEventEnvelope` gained an optional `eventId`, set by
`RealExecutionHost.pollEvents` (never by the adapter) as
`${executionId}:${hostEventSequence}:${indexWithinThatEvent'sParseBatch}` —
stable across repeated polls, independent of any in-memory counter that
would reset after a restart. Cursor/duplicate-poll/ordering/malformed-line
behavior — already proven in Phase 4B's dedicated ingestion test file — is
now ALSO proven through the canonical parity file (see below), and remains
unchanged otherwise: `pollEvents`'s cursor is in-memory per `RealExecutionHost`
instance, meaning a genuine process restart re-delivers the full history
from sequence 0 rather than losing anything — at-least-once, not
exactly-once, delivery across a restart. **Durable persistence of
normalized provider events was NOT added** — nothing in this codebase
consumes `pollEvents`'s output yet, so there is no real consumer to make
durable for; this remains the honest limitation stated in Phase 4B's notes,
narrowed but not fully closed.

### Canonical parity contract

`mission-provider-adapter-contract.test.ts` (Phase 3C's file) gained: a
stable-cursor/no-re-delivery test, a malformed-provider-line-through-
RealExecutionHost test, and the honest session-start capability-difference
test — all parametrized identically to every existing test in that file.
Phase 4B's `mission-execution-event-ingestion.test.ts` was NOT deleted (it
covers more granular per-scenario ingestion behavior the canonical file
doesn't duplicate) — consolidated in the sense of "the SHARED parity
guarantee now lives in the canonical file," not in the sense of one file
replacing the other.

### Projection and query verification

Exact boundary tests added: 199 messages (nothing dropped), 200 (still
nothing dropped), 201 (exactly the oldest one dropped) — proving
`MAX_PROJECTION_MESSAGES`'s off-by-one behavior precisely rather than only
at a coarse "way over the limit" scale (Phase 4B's original tests). No
changes to the bounding/pagination mechanism itself.

### Files added

`mission-collaboration-protocol.ts`, `scripts/mission-collaboration-
protocol.test.ts`, `scripts/mission-collaboration-workflows.test.ts`.

### Files modified

`mission-command-handler.ts` (typed protocol validation dispatch, blocker/
completion_notice orchestration, human_required authorization gate),
`mission-commands.ts` (`UnauthorizedApprovalError`), `mission-
communication-policy.ts` (`MessagePolicyViolation` folds in
`ProtocolViolation`), `mission-provider-adapter.ts` (`eventId` field),
`mission-real-execution-host.ts` (`eventId` population in `pollEvents`),
`scripts/mission-projection-bounds.test.ts` (199/200/201 boundary tests),
`scripts/mission-provider-adapter-contract.test.ts` (3 new parametrized
tests), `package.json`. No migration changes this phase — every new
behavior reuses existing event types (`mission.message_posted`,
`mission.assignment_status_changed`); no new event type was needed.

### Verification actually run

Full suite: **1399 passing** (up from 1355 before this phase — 44 new
tests), 0 failures. Typecheck clean. Lint: 0 errors, 17 pre-existing
warnings, none in new files. Build: succeeds. No database work this phase.

### Architectural limitations remaining (stated explicitly)

1. **review_request duplicate detection is narrow, not a full review
   record** — "an outstanding request has no reply yet" is a cheap,
   correct-enough proxy, but multi-reviewer review POLICY (`any_of`/
   `all_of` actually being enforced, a reviewer's finding vs. "no findings"
   outcome closing the review) is typed in the payload shape but not
   wired to any resulting command — a review's OUTCOME still flows through
   the existing `finding`/`OpenFinding` path, not a dedicated review-closure
   command.
2. **No durable persistence of normalized provider events** — `eventId` is
   stable, but nothing stores `pollEvents`'s output; a real consumer still
   needs to be built before "restart recovery for provider events"
   is more than "nothing is lost if you re-poll from scratch."
3. **Most of the originally-requested 22-item recovery matrix remains
   uncovered by a dedicated test** — duplicate structured messages beyond
   completion_notice, concurrent approval/completion races, participant-
   removal-during-review, parent-cancellation-with-active-child, and
   several others are architecturally supported (nothing in the domain
   model prevents inspecting or handling them) but not each individually
   proven this phase, consistent with Phase 4B's own stated scope
   reduction.
4. **`approval_request` has no dedicated "conflicting/duplicate response"
   test of its own** beyond what `AcceptAssignment`/`RejectAssignment`'s
   existing terminal-state guard already proves generically (tested here as
   `a duplicate AcceptAssignment (already accepted) is refused`).

### Capability/state claims corrected during the audit

None found this phase requiring correction — Phase 4B's `verified`-marked-
terminal bug (already fixed and reported then) was the most recent such
finding.

## Phase 2A — command handler and reconciliation

### New files
- `mission-commands.ts` — the 16-command union, `CommandContext`,
  `mintCorrelationId`, `hashCommandPayload`, `CommandOutcomeRecord`, error
  types.
- `mission-command-handler.ts` — `applyMissionCommand`, pure with respect to
  infrastructure.
- `legacy-observation-mapping.ts` — the compatibility boundary: `RunStatus`
  and `AssignmentState` → `NormalizedOrchestrationObservation`.
- `mission-reconciliation.ts` — `reconcileMission`, the four typed outcomes.

### A real bug found and fixed while wiring the handler to Phase 1

The `MissionProjection.resumeTo` field existed, but the `mission.state_changed`
event payload never carried it — only Phase 1's tests exercised the reducer
directly, and none of them entered an interruption state, so this was never
exposed. Had the command handler patched `resumeTo` onto its own projection
after folding events (the original draft did exactly this), a projection built
by anyone else folding the same event stream — `projectMission` called
directly, a future read model, a debugging tool — would have silently missed
it. That would have broken the determinism promise Phase 1's tests assert
(`projecting the same stream twice yields identical output`) the moment two
different callers built a projection from the same events.

Fixed at the correct layer: `MissionStateChangedPayload` now carries
`resumeTo`, and the reducer in `mission-projection.ts` sets it directly. The
command handler no longer patches the projection after folding — it only
constructs the correct event. Guarded by a dedicated test: "a projection built
by folding the same events independently matches the command handler's own
projection."

### CreateMission is genesis, not a transition

The first implementation ran `CreateMission` through `validateTransition({from:
"draft", to: "draft"})`, which correctly rejected it (draft→draft is not a
declared transition) and failed every downstream test. `CreateMission` is now
special-cased before the transition-legality step: it has no "from" state to
validate against, so `applyMissionCommand` constructs its `mission.created`
event directly.

### Command → event mapping

Every command emits exactly one `mission.state_changed`, except:
- `MarkMissionReady` also emits `mission.plan_approved` (first, since it's the
  precondition the state change depends on).
- `AcceptMission` / `RejectMission` also emit `mission.decision_recorded`
  (second, since it depends on the state having changed first).

Within one command, later events' `causationId` chains to the immediately
preceding event's `eventId`; all events from one command share one
`correlationId`; the first event's `causationId` is the context's
(`context.causationId`, possibly null for a root command).

### Idempotency, precisely

`hashCommandPayload` hashes the command alone, independent of any
caller-supplied idempotency key — this is what makes "same key, different
payload" detectable as a conflict rather than a replay. A genuine replay folds
the stored events onto whatever `current` projection the caller has *now*,
rather than requiring it to already reflect them — safe whether or not the
store has caught up.

### Reconciliation

Four outcomes, none of which mutate anything: `consistent`,
`recoverable_divergence` (always carries a `proposedAction`),
`blocked_divergence` (always carries a `requiredAuthority`), `unknown`. Checks
run in a fixed order: terminal-mission conflict first (never overwritten,
regardless of how confident a signal is), then live-mission-reported-done,
then missing-runtime-with-unknown-provider, then no-signal-at-all, then
consistent.

## Phase 5A — Deterministic Mission Planner Foundation

Scope: the provider-neutral planning layer that turns a Mission objective
into a structured, reviewable, executable **Plan proposal** — construction
and validation only. No autonomous replanning loop, no LLM-backed
`propose`, no Mission UI, no Mission Passport, no third provider. The
Planner never launches a provider and never persists a participant or
assignment directly — everything still flows through the existing
`applyMissionCommand` seam.

### A real domain-gap audit finding, and how it was resolved

The requested event names (`mission_plan_proposed`, `mission_plan_approved`,
etc.) collide with event type strings that already exist since Phase 1:
`mission.plan_proposed`/`mission.plan_approved`, carrying
`MissionPlanPayload{planVersion:number}` — the Mission's own bare
incrementing plan-version counter, emitted by `MarkMissionReady`. That is a
genuinely different, thinner concept than the rich Plan this phase builds.
Resolved by naming the new entity `MissionPlanProposal` (not `MissionPlan`)
and by using two new, non-colliding event types —
`mission.plan_proposal_created` and `mission.plan_proposal_status_changed`
— rather than repurposing or colliding with the Phase 1 pair. The old
`mission.plan_proposed`/`mission.plan_approved` strings and their bare
`planVersion` field are untouched.

### Plan model (`mission-domain.ts`)

`MissionPlanProposal` — `id`, `missionId`, `version`, `status`, `objective`,
`assumptions`, `constraints`, `participantProposals`, `assignmentProposals`,
`collaborationTopology`, `evidenceRequirements`, `approvalGates`,
`executionLimits`, `unresolvedQuestions`, `warnings`, `validationErrors`,
`createdAt`, `createdBy`, `supersedesPlanId`. `PLAN_STATUSES` = draft /
validating / valid / invalid / approved / materializing / active /
superseded / rejected / cancelled — "validating" is never actually
persisted (validation is synchronous and pure, so `ValidateMissionPlan`
writes `valid`/`invalid` directly); "cancelled" is a real enum member with
no command that reaches it this phase (see Limitations). A Plan is
data — never a provider prompt, never a launch argument.

`ProposedParticipant`/`ProposedAssignment` reuse the EXISTING
`ParticipantRole`, `AssignmentScope`, `AssignmentBudget`,
`AssignmentApprovalPolicy`, `ParticipantWorkspacePermissions`,
`ParticipantCommunicationPermissions` fields verbatim — no new parallel
field was introduced where an existing one already expressed the same
semantics.

### Planner input/output (`mission-planner.ts`)

`PlannerInput` — objective, workspace context, applicable rules, available
providers (id + honestly-declared capability record), allowed roles,
budget, scope, approval policy, collaboration policy, `operatingMode`
(solo / review_pair / specialist_team / human_led — no unbounded swarm
mode), constraints, optional known participants, optional procedure
override, `now`, `createdBy`, optional `version`/`supersedesPlanId`.

`propose(input)` builds the Plan from a procedure template, then resolves
provider selection per proposed participant: the FIRST provider in
`availableProviders` (caller order preserved, never reordered) whose
DECLARED capabilities are a superset of what the role requires. No match
leaves `providerConstraint.provider` null and records an unresolved
question — never a silent, dishonest assignment. Deterministic: same
input, same Plan, same ids, every time (`${missionId}-plan-<version>`,
`${missionId}-plan-participant-<n>`, `${missionId}-plan-assignment-<n>`).

### Procedure templates (`mission-planner-templates.ts`)

Five pure builders — `solo_implementation`, `implementation_review_pair`,
`implementation_security_review`, `implementation_test_verification`
(forces its verification assignment's `approvalPolicy` to
`human_required` regardless of the Mission's own default),
`investigation_then_implementation`. Each is a pure function of
`PlannerInput`: no randomness, no provider-specific launch arguments
embedded — a template describes who does what under which policy, never a
CLI invocation.

### Plan validator (`mission-planner-validator.ts`)

Pure; returns typed errors AND warnings, never a bare boolean. 13 error
codes covering: missing participant, unknown/cyclic dependency references
(own Kahn's-algorithm cycle check over proposed-assignment ids, separate
from `mission-collaboration-graph.ts`'s materialized-assignment check),
unresolved provider capability, scope exceeding the Mission's own
authority (reuses `validateScopeNarrowing` directly), self-review
non-distinctness, unavailable approval authority, budget exceeding the
Mission's limit, unrecognized dispatch/completion/evidence vocabulary, and
prerequisite-for-impossible-work (an assignment depending into a cyclic
chain).

### Plan simulator (`mission-planner-simulator.ts`)

Pure dry run: topological order (Kahn's algorithm), initially-ready vs.
blocked assignments, collaboration links, required approval points,
possible capability failures, reachable/unreachable assignments, max
dependency chain depth, terminal success conditions. Never calls a
provider, never mutates Mission state. A cyclic graph terminates safely — a
`visiting` set guard returns 0 the instant a chain revisits an id already
on its current path, rather than recursing forever; the acyclic portion of
the walk still contributes a real (non-zero) depth before that guard
fires.

### Commands, events, and the command handler

Six new collaboration commands (routed via `COLLABORATION_COMMAND_TYPES`,
never through the Mission state machine): `ProposeMissionPlan`,
`ValidateMissionPlan`, `ApproveMissionPlan`, `RejectMissionPlan`,
`SupersedeMissionPlan`, `MaterializeMissionPlan`. Two new event types
persisted through the existing `mission_events` JSONB column — no new
table, matching every Phase 4+ addition: `mission.plan_proposal_created`
(full snapshot) and `mission.plan_proposal_status_changed` (generic status
transition, reused for validated/invalid/approved/rejected/superseded/
materialized — the same "one status-changed event type" pattern already
established for participants/assignments/findings).

`PLAN_TRANSITIONS` (`mission-collaboration.ts`) is a new, deliberately
separate state machine — not merged into `Mission.state`,
`DispatchLeaseState`, `ExecutionState`, or participant/assignment/finding
status, matching this repo's established layering.

**Approval authorization**: `ApproveMissionPlan` derives its own
human-required gate from the EXISTING `assignmentProposals[].approvalPolicy`
field (no new parallel "Plan approval policy" field was introduced) — if
ANY proposed assignment requires human approval, approving the whole Plan
does too; an agent actor is refused as `unauthorized_plan_approval`.

**Materialization** (`MaterializeMissionPlan`): converts an approved Plan
directly into `mission.participant_registered`/`mission.assignment_created`
event payloads — the SAME shapes `AddParticipant`/`CreateAssignment`
already produce, constructed inline in one atomic command rather than as N
separate nested command calls (an explicit tradeoff to keep materialization
atomic; stated here rather than left implicit). Identity mapping is
trivial by construction: the proposed ids (`m-1-plan-participant-1`, etc.)
are used directly AS the real `MissionParticipant.id`/`MissionAssignment.id`
— no separate ID-minting or translation table. Idempotent at two layers: if
`plan.status === "active"` already, the whole command is a true no-op
(`{ok:true, payloads:[]}`); independently, each participant/assignment
creation is skipped if `current.participants[id]`/`current.assignments[id]`
already exists, so a retry after an ambiguous prior commit can only create
what's still missing, never duplicate.

**Versioning**: `SupersedeMissionPlan` moves the old Plan to `superseded`
(terminal) and creates the new version in one atomic pair of events. A
terminal Plan (including `superseded`) can never transition again — a
revision always requires a brand-new Plan version. Attempting to
materialize a Plan that was never approved fails as
`plan_not_materializable`.

### Persistence

`supabase/migrations/20260725120000_mission_event_log.sql` — added
`'mission.plan_proposal_created'`/`'mission.plan_proposal_status_changed'`
to the existing `event_type` check constraint, with a comment documenting
the Phase 1 naming collision this avoids. No new table; RLS/tenant
isolation, idempotency, and optimistic concurrency are unchanged (same
`apply_mission_command_atomic` function every other event type already
goes through). This migration has not been applied to any live database —
same status as every prior phase's edits to this file.

`MissionProjection.planProposals: Record<PlanId, MissionPlanProposal>` —
a new derived field, folded by the two new reducer cases in
`mission-projection.ts`; every Plan proposal ever created for the Mission,
including superseded/rejected ones, stays in history.

### Tests added

- `mission-planner.test.ts` (12 tests): deterministic `propose`, stable
  derived ids, all 5 procedure templates produce internally-consistent
  output, operating-mode defaults, capability-only provider selection
  (Codex/Claude chosen purely by declared capability, never by name),
  unresolved-provider unresolved-question recording, no provider-specific
  launch arguments embedded.
- `mission-planner-validator.test.ts` (17 tests): a clean Plan validates
  with zero errors, and one test per `PlanValidationErrorCode` (13 codes)
  plus dishonest-capability rejection, human-required-authority-available,
  and validator purity (never mutates its input).
- `mission-planner-simulator.test.ts` (7 tests): solo/review-pair/
  human-led/investigation-then-implementation simulation shapes, capability
  failure surfacing, safe (non-recursing) cyclic-graph handling, simulator
  purity.
- `mission-command-handler-plan.test.ts` (10 tests): the full
  Propose→Validate→Approve→Materialize lifecycle through
  `applyMissionCommand`, duplicate-planId refusal, invalid-Plan-never-
  approved, the human-required Plan approval gate (agent refused, human
  allowed), Plan rejection terminality, Plan supersession/versioning,
  materialization idempotency and retry-after-ambiguous-commit safety,
  unknown-plan-id handling, and full event-replay-matches-incremental-
  projection parity.

Total: **43 new tests**. Full suite: **1,442 passing, 0 failing**
(1,399 pre-existing + 43 new — no existing test was modified).
`npm run typecheck`: clean. `npm run lint`: 0 errors, 17 pre-existing
warnings (unchanged baseline, no new warnings introduced). `npm run
build`: succeeds.

### Architectural limitations / deferred technical debt (stated explicitly)

- **No `CancelMissionPlan` command.** `"cancelled"` is a real `PlanStatus`
  enum member with no command reaching it this phase — matches the user's
  requested command list (which has no cancel command), but is a real gap
  if a Plan needs to be abandoned outside of rejection/supersession.
- **No dedicated "reconciliation behavior" for revising a materialized
  Plan.** `SupersedeMissionPlan`'s transition table refuses supersession
  from `materializing`/`active`/any terminal status (a materialized Plan
  cannot be superseded at all today) — this is a real refusal, not a
  reconciliation flow. A future phase would need an explicit "Plan v2
  reconciles against already-materialized v1 participants/assignments"
  design, out of scope here.
- **`PlanValidationRequiredError` is defined but never emitted.** Added to
  the `ApplyCommandError` union per the requested error surface, but no
  command path currently returns it (approval already checks the plan's
  own `status` via `PLAN_TRANSITIONS`, which only allows `approved` from
  `valid`, making a separate "must validate first" error redundant in
  practice). Left in the type as declared surface area, not dead code to
  silently remove, since the union is part of the public
  `ApplyCommandError` contract.
- **Materialization is one atomic command, not N nested command
  invocations.** It reuses the same event PAYLOAD SHAPES
  `AddParticipant`/`CreateAssignment` produce, but does not literally call
  those commands — stated explicitly since "reuse existing commands" could
  be read either way.
- **No inaccurate provider capability assumptions were found in the
  existing Codex/Claude adapters during this phase's audit** — Phase 3B/3C
  already correctly declared `tool_event_reporting: false` for Codex (fixed
  in Phase 3C) and no further capability corrections were needed for the
  Planner's capability-matching logic to work honestly.

## Phase 4D — Audit remediation (part 1: baseline fixes; part 2: authority, scope, message identity)

Two back-to-back passes responding to `docs/MISSION_ARCHITECTURE_AUDIT_2026-07-25.md`,
a repository-evidence audit that found the Mission library substantial in
isolation but not yet an integrated, safe production architecture. Every
finding below was reproduced against the current repository state before
any fix was written — none were taken on the audit's word alone.

### Part 1 — the four baseline fixes (Critical/High)

1. **Cross-tenant Mission mutation (Critical).** `apply_mission_command_atomic`
   never re-checked an existing Mission's `workspace_id` against the
   caller-supplied one — the genesis `ON CONFLICT DO NOTHING` insert only
   ever SET it, never verified it again. Fixed by adding a `workspace_mismatch`
   check immediately after the row lock, before idempotency/version logic —
   `supabase/migrations/20260725120000_mission_event_log.sql`. Threaded
   through as a new `workspace_mismatch` RPC status, a new
   `WorkspaceMismatchError`, and a new `applyCommand` result variant
   (`mission-command-persistence.ts`, `mission-commands.ts`,
   `mission-runtime-durable.ts`).
2. **Fence-to-launch race (Critical).** `RealExecutionHost.start` validated
   the fence once at entry, then did capability discovery/env prep/
   invocation prep, then launched without rechecking. Fixed by revalidating
   the fence immediately before `processHost.launch`
   (`mission-real-execution-host.ts`).
3. **Schema-version type mismatch (High).** TypeScript emits the event
   schema version as the string `"oathlock.mission-event.v1"`; the column
   was `integer` with a `::integer` cast — every real event would have
   failed the insert. Fixed by making the column `text` and dropping the cast.
4. **Orphan process on handle-persistence failure (High).** `start` launched
   the process, then persisted its handle; if persistence threw, the process
   ran untracked with no way for recovery to find it. Fixed by tracking the
   handle locally BEFORE the persistence call, and terminating + untracking
   on failure (`mission-real-execution-host.ts`).

Regression tests: `mission-runtime-durable.test.ts` (workspace_mismatch),
`mission-real-execution-host.test.ts` (fence-stale-during-preparation,
persistence-failure-triggers-termination). Full suite at the end of part 1:
1,445 passing.

### Part 2 — authority, scope, and message identity (this pass)

Scope, per the user's explicit instruction: resolve the remaining
Critical/High findings, then the Medium findings affecting causal
integrity, runtime validation, or deterministic recovery — **not** the
full 13-item audit remediation list in one pass. Items §2–4 below are
complete; §5–13 (runtime protocol schemas beyond what already existed,
sender/reference enforcement, atomic clarification orchestration, process-
launch rejection handling, termination confirmation, recovery-path
consolidation, the 200-message-window collaboration index, and a real
Postgres migration harness) are **explicitly deferred** — see Limitations.

#### §2 — Central command authorization (`mission-authorization.ts`, NEW)

One provider-neutral seam, replacing two scattered inline checks
(`AcceptAssignment`/`RejectAssignment`'s and `ApproveMissionPlan`'s
human-required gates) with a single function every command — Mission-state
or collaboration — passes through inside `applyMissionCommand`, right after
the existence/version checks and before either branch builds a payload.

- `AuthorityKind`: `human`, `system`, `mission_owner_or_administrator`
  (mapped onto the EXISTING `ParticipantRole === "owner"`, not a new
  Mission-level `ownerId` field — the domain has no such field and adding
  one was out of scope for an authorization seam), `active_participant`,
  `assignment_assignee`, `assignment_reviewer`, `finding_opener`,
  `finding_responsible_participant`.
- `deriveActorAuthorities(command, projection, actor)` computes what the
  CURRENT actor holds with respect to the SPECIFIC entity a command
  targets — never a global role. A removed/inactive participant holds none
  of them (status must be exactly `"active"`).
- `COMMAND_AUTHORITY_MATRIX`: a `Record<MissionCommandType, AuthorityKind[]>`
  — TypeScript's `Record` type itself guarantees every command type has a
  row (a missing key is a compile error).
- `refineRequiredAuthority` narrows (never broadens) the matrix row for the
  handful of commands whose real requirement depends on entity state:
  `AcceptAssignment`/`RejectAssignment` escalate to human-only when the
  assignment's `approvalPolicy === "human_required"`; `ApproveMissionPlan`
  escalates to human-only when any proposed assignment does. This is the
  SAME behavior the two prior inline checks already implemented — centralized,
  not changed, and their exact pre-existing error codes
  (`unauthorized_approval`, `unauthorized_plan_approval`) are preserved by
  `mission-command-handler.ts` translating a generic denial back to them for
  those two commands specifically, so no existing caller or test broke.
- Self-approval: NOT a separate blanket rule. An assignee CAN accept/reject
  its own submitted work under `"auto"` policy — this is real, previously-tested
  domain behavior (`mission-collaboration-workflows.test.ts`). The
  human-required escalation alone closes the audit's "assignee cannot
  self-approve when policy forbids it" gap, because an agent assignee is
  never `human`. `VerifyAssignment` is the one command that structurally
  excludes `assignment_assignee` from its base matrix row (verification is
  never the assignee's own call, policy or no policy).
- A known, stated limitation: `assignment_reviewer` has no dedicated
  per-assignment registry in the domain (a Plan's collaboration topology
  names a reviewer only up to materialization; nothing persists "participant
  X reviews assignment Y" on the materialized `MissionAssignment`). Any
  active participant with `role === "reviewer"` who isn't the assignee is
  treated as holding review authority for ANY assignment — broader than
  ideal, flagged rather than silently assumed correct.

Tests: `mission-authorization.test.ts` (9 tests) — matrix completeness,
unknown-actor denial, removed-participant denial, human-required escalation
both directions, self-accept-under-auto permitted, human-required Plan
approval both directions, no-projection-yet authority derivation,
denial-before-event-emission, human-actor-always-authorized-for-human/system-rows.

#### §3 — Canonical path containment (`mission-path-containment.ts`, NEW)

Replaces `mission-collaboration-graph.ts`'s raw string-prefix scope check
(`path.startsWith(allowed + "/")`) with real segment-wise canonicalization.

- `canonicalizeRepoPath(raw)`: normalizes backslashes to forward slashes,
  collapses `.`/repeated/leading/trailing separators, resolves internal
  `..`, and FAILS CLOSED (`ok: false`) on: a bare/root-escaping `..`, a
  leading separator (absolute or UNC), a drive-letter path. Never touches
  the filesystem — pure string processing, works whether or not the path
  exists (required: Plans reason about paths that don't exist yet). Case-
  sensitive by design (documented rationale: case-insensitive comparison
  would silently WIDEN what a scope covers relative to a case-sensitive git
  checkout). Symlinks are explicitly out of scope — no authoritative
  on-disk resolution mechanism exists at this layer.
- `isRepoPathContained(candidate, container)` / `isRepoPathContainedByAny`:
  segment-wise containment, fixing the sibling-prefix bug (`src/app` vs.
  `src/application`) as a natural consequence of comparing whole segments
  rather than raw prefixes, and fixing the traversal-escape bug (`src/../outside`
  now canonicalizes to `outside`, a completely different segment list than
  `src`) rather than being string-matched as "starts with src".
- `validateScopeNarrowing` (mission-collaboration-graph.ts) now delegates to
  this utility for BOTH allowed-path coverage and prohibited-path
  preservation (the latter previously an exact-string-match `.includes()`
  check, upgraded to containment: a child prohibition satisfies a parent's
  if it's the same path or a broader ancestor of it).

Tests: `mission-path-containment.test.ts` (25 tests) — `.`/`..`/repeated
separators, root-escaping `..`, Windows backslashes, mixed separators,
absolute paths, drive-letter paths, UNC paths, empty path, sibling-prefix
collision, plus `validateScopeNarrowing` integration cases proving the
fixed behavior end to end (traversal-escape rejection, sibling-prefix
rejection, absolute/drive-letter rejection, prohibition-preservation via
containment rather than exact match).

#### §4 — Mission-scoped messageId uniqueness

`PostMessage` now checks `current.messages.find(m => m.id === command.messageId)`
FIRST, before any other validation. A collision is refused as a new typed
`duplicate_message_id` error carrying `samePayload: boolean` — computed by
comparing every semantically-relevant field (sender, type, body, assignment,
recipients, evidence, replyTo, structuredPayload), distinguishing "identical
message resubmitted under a different idempotency key" from "a genuinely
different message tried to reuse this id." Never a `Map`/array
last-write-wins — the check runs against the full `current.messages` array,
and a rejected duplicate appends zero events, so the causal graph is
provably untouched. Uniqueness is Mission-scoped: `current.messages` is
already scoped to one Mission's projection, so the identical id string is
free to reuse in an unrelated Mission with no code change needed.

Tests: `mission-duplicate-message.test.ts` (7 tests) — genuine-retry replay
bypasses the check entirely (proven via a real `hashCommandPayload`-matched
`priorOutcome`), same-payload/different-idempotency-key conflict,
different-payload conflict, causal-graph-untouched-after-rejection,
cross-Mission id reuse permitted, reply-chain resolves to the original
message after a rejected duplicate, and full-history replay after a
rejected duplicate attempt (which appended no event) still lands on
exactly one message at the reused id.

### Verification (this pass)

Full suite: **1,486 passing, 0 failing** (1,445 baseline + 9 authorization +
25 path-containment + 7 duplicate-message = 41 new tests, zero existing
tests modified beyond three that encoded an authorization gap the new
central seam legitimately closes — see below). `npm run typecheck`: clean.
`npm run lint`: 0 errors, 17 pre-existing warnings (unchanged baseline).
`npm run build`: succeeds.

Three PRE-EXISTING tests initially failed when the authorization seam was
first wired in, all for the same reason — my first draft of
`COMMAND_AUTHORITY_MATRIX` was more restrictive than the domain's actual,
already-tested behavior:
- `AcceptMission` required `human`-only; the domain has no per-Mission
  approval-policy field to justify that (unlike assignments/Plans), and an
  existing test exercises `AcceptMission` via the default `system` actor.
  Fixed by allowing `human`/`system`/`mission_owner_or_administrator`,
  matching every other Mission-lifecycle command.
- `AcceptAssignment`/`RejectAssignment` excluded `assignment_assignee` from
  the base matrix row entirely; an existing test proves an assignee CAN
  self-accept under `"auto"` policy. Fixed by including
  `assignment_assignee` in the base row and relying on the human-required
  escalation alone to close the self-approval gap — not a separate ban.
No test assertion itself was changed; the matrix was corrected to match
already-established, intentionally-tested domain behavior.

### Remaining findings (explicitly deferred, per the audit's own severity ranking)

**Still open — Critical:** none remaining from the audit's original list
(both Criticals were closed in part 1).

**Still open — High:** the authorization matrix above covers ALL commands,
but §6 (sender/reference enforcement beyond the base authorization gate —
e.g. verifying a `completion_notice`'s sender actually owns the assignment,
not just that they hold SOME valid authority) is not implemented; process-
launch rejection handling (spawn-rejection/unhandled-promise safety) is
untouched; termination is still not distinguished from "abort requested"
before lease revocation/redispatch; the two competing recovery-path
implementations (`MissionDispatchRuntime.recoverOnStartup` vs.
`recoverOutstandingIntentsWithProcessHost`) still coexist with no
production selector.

**Still open — Medium:** Phase 4C's protocol "schemas" are still TypeScript
casts plus truthiness checks, not real runtime discriminated-union
validation (§5); clarification orchestration (question+waiting,
answer+resume) is still two separate commands, not one atomic pair (§7);
unresolved collaboration state (unanswered questions, unresolved blockers,
open findings, pending approvals) has no dedicated bounded index outside
the 200-message projection window (§11); no real Postgres migration test
harness exists in this environment (§12) — `supabase`/`psql` are not
installed here, so every SQL change in both this pass and part 1 remains
typechecked/logically reviewed only, never executed against a live database.

### Limitations (this pass's own scope, stated explicitly)

- `assignment_reviewer` authority is granted to ANY active participant with
  `role === "reviewer"`, mission-wide — there is no per-assignment reviewer
  registry to check against instead. Broader than ideal; a future phase
  should either add one or derive reviewer identity from an accepted
  `review_request` message.
- `mission_owner_or_administrator` reuses the existing `ParticipantRole ===
  "owner"` value; the domain still has no Mission-level `ownerId`/admin
  concept independent of participant roles.
- Path canonicalization does not resolve symlinks and does not consult any
  on-disk state — by design (no authoritative resolution mechanism exists
  at this layer), but stated so a future reader doesn't assume symlink
  safety was verified.
- `DuplicateMessageIdError`'s `samePayload` comparison is a manual field-by-field
  equality check, not a payload-digest comparison — kept consistent with how
  `mission-commands.ts` already computes conflict/replay elsewhere, but a
  future refactor could unify it with `hashCommandPayload`.

## Phase 4D Part 3 — Collaboration runtime validation (partial; process/recovery hardening deferred)

Scope actually completed this pass, from the user's 8-item list: **§2
(partial) sender/reference enforcement, §5 real runtime protocol schemas,
§7 active collaboration indexes beyond the 200-message window.** **NOT
done** — stated explicitly, not silently dropped: §2 (partial — evidence-
belongs-to-assignment enforcement, dispatch/execution reference matching),
process-launch rejection handling, confirmed process termination
semantics, recovery-path consolidation, atomic clarification orchestration,
and a real Postgres migration harness. See "Remaining findings" below.

### §5 — Real runtime protocol schemas (`mission-protocol-schema.ts`, NEW)

No existing schema/validation library was found in `package.json` (checked:
no zod/ajv/yup/joi/valibot/superstruct/io-ts) — per instruction, none was
added. `validateStructuredPayloadSchema(messageType, structuredPayload)` is
a hand-written discriminated-union runtime validator, keyed by
`MessageType`, called from `mission-command-handler.ts`'s `PostMessage`
case BEFORE any Phase 4C domain-semantic validator runs. Real checks, not
TypeScript casts: message-type recognition, payload-is-an-object, a CLOSED
allow-list of keys per type (an unrecognized field — e.g. a fabricated
`preApproved: true` on an `approval_request` — is rejected outright, never
silently passed through to a downstream check that doesn't know to look
for it), required-field presence, primitive type checks, enum membership
(`reviewPolicy`, blocker `reason`, `evidenceKind`, approval `subject`), and
non-empty-string id checks inside arrays. `childTitle`/`childObjective` on
`delegation_response` are correctly modeled as OPTIONAL (verified against
`mission-command-handler.ts`'s actual fallback behavior,
`` `Delegated: ${parent.title}` ``/parent's own objective) — my first draft
wrongly required them, which broke 3 legitimate existing tests before I
caught it against real domain behavior.

### §2 (partial) — Sender identity binding and completion_notice ownership

Two concrete gaps closed directly in `mission-command-handler.ts`'s
`PostMessage` case:
- **Sender identity binding**: an `agent`-kind actor can no longer post a
  message claiming a DIFFERENT participant's `senderParticipantId` — this
  is the actual mechanism behind "a provider process cannot grant itself
  new authority": `mission-authorization.ts`'s `active_participant` check
  only proved SOME active participant issued the command, never that it
  was the one named as sender. `human`/`system` actors are exempt (they
  legitimately relay/orchestrate on behalf of a named sender).
- **completion_notice sender ownership**: a `completion_notice` from an
  `agent` actor must now come from the assignment's own assignee — refused
  as a new `completion_notice_sender_not_assignee` violation otherwise.

New typed errors: `SenderIdentityMismatchError`, `ProtocolSchemaViolationError`
(`mission-commands.ts`).

### §7 — Active collaboration indexes beyond 200 messages (`mission-projection.ts`)

Fixed a REAL bug the audit's own finding #335 flagged:
`unansweredQuestionMessageIds` was truncated to match the bounded 200-
message `messages` window on every `mission.message_posted` fold — an
unanswered question older than 200 later messages silently vanished from
the projection entirely. Fixed by removing that truncation; the index is
now genuinely unbounded, updated only by real question/answer correlation,
never by window eviction. Added four NEW unbounded indexes with the same
discipline: `unresolvedBlockerMessageIds`, `pendingReviewRequestMessageIds`,
`pendingApprovalRequestMessageIds`, `pendingDelegationRequestMessageIds`
(open findings and active child-assignment relationships needed no fix —
`findings`/`assignments` are already unbounded `Record`s keyed by id, never
subject to the message window). "Resolution" criteria: a blocker clears on
a correctly-linked `resolved: true` reply; a review_request/approval_request
clears on ANY reply (mirroring `mission-collaboration-protocol.ts`'s own
"outstanding" definition — no dedicated response message type exists for
either); a delegation_request clears on a `delegation_response` reply.

Tests: `mission-collaboration-indexes.test.ts` (12 tests) — 199/200/201/
500-later-messages persistence, resolution removes the entry, deterministic
replay produces identical indexes, authoritative history is never
truncated by these indexes.

Tests for §5/§2: `mission-protocol-schema.test.ts` (18 tests) — every
`ProtocolSchemaErrorCode`, sender identity binding both directions,
completion_notice ownership both directions, denial-before-event-emission.

### Verification (this pass)

Full suite: **1,516 passing, 0 failing** (1,486 baseline + 30 new: 18
protocol-schema + 12 collaboration-index tests). One existing test's
expected error code was corrected (`mission-collaboration-workflows.test.ts`'s
"blocker missing reason" test now expects `protocol_schema_violation`
instead of `message_policy_violation` — the same input is still rejected;
it's now caught one layer earlier, by real schema validation instead of a
domain-semantic check, which is the entire point of this section). `npm run
typecheck`: clean. `npm run lint`: 0 errors, 17 pre-existing warnings
(unchanged). `npm run build`: succeeds.

### Remaining findings (explicitly deferred — genuine scope/effort limit, not silently dropped)

**Still open — High:**
- §2 (remainder): evidence-belongs-to-assignment enforcement is NOT
  implemented — the domain has no per-evidence assignment association at
  all (`MissionProjection.attachedEvidenceIds` is a flat string array, no
  metadata), so this can't be checked without a real domain change, not
  just a validation seam. Dispatch/execution reference matching is also
  untouched.
- Process-launch rejection handling (synchronous/async spawn failure,
  onSpawn rejection, parser init failure, exit-during-handle-persistence,
  post-publication promise rejection) — `NodeProcessExecutionHost.launch`/
  `runProviderProcess` are unchanged from Part 1.
- Confirmed process termination semantics — `AbortController.abort` is
  still treated as sufficient; no bounded grace/force-kill/confirmation
  algorithm exists.
- Recovery-path consolidation — `MissionDispatchRuntime.recoverOnStartup`
  and `recoverOutstandingIntentsWithProcessHost` still coexist with no
  production selector.

**Still open — Medium:**
- Atomic clarification orchestration — `AskAssignmentQuestion`/
  `AnswerAssignmentQuestion` remain separate commands from the `PostMessage`
  that creates the underlying question/answer message; a crash between the
  two still leaves a message-without-state-transition (or vice versa)
  window. Not attempted this pass: folding this into `PostMessage`'s
  existing atomic orchestration (the same pattern already used for
  blocker/completion_notice) is a real, tractable fix, but touches
  assignment-lifecycle behavior exercised by many existing tests and
  deserved a dedicated pass rather than a rushed change alongside
  everything else in this one.
- Real Postgres migration harness — **not built**. `docker`, `supabase`,
  and `psql` are all absent from this environment (verified via `which`).
  No SQL change in any Phase 4D part has ever executed against a real
  Postgres instance. External command a human/CI runner WOULD need:
  `supabase start` (or a Postgres 15+ container) then
  `supabase db reset`/`psql -f supabase/migrations/*.sql` in order,
  followed by direct RPC calls to `apply_mission_command_atomic` exercising
  every case in item 12's list. `scripts/mission-atomicity-integration-test.sh`
  remains stale (still targets an old RPC signature/integer schema
  version) — not updated this pass, since fixing it without being able to
  run it risks encoding new, equally-unverified assumptions.

**Remaining Critical:** none.

### Limitations (this pass)

- The sender-identity-binding check exempts `human`/`system` actors
  entirely — a compromised orchestrator could still impersonate any
  participant. This mirrors the domain's existing trust boundary (system/
  human actors are already trusted to construct correct commands elsewhere)
  rather than introducing a new one, but is worth flagging explicitly.
- `pendingReviewRequestMessageIds`/`pendingApprovalRequestMessageIds` clear
  on ANY reply, not a dedicated "resolved" response — because no such
  message type exists in the domain (both are documented as informational-
  only in Phase 4C). A future review/approval workflow phase should
  replace this with real resolution semantics.

## Phase 4D Part 4 — Evidence provenance (process/termination/recovery/clarification/Postgres deferred)

Scope actually completed: **§7 (evidence provenance domain model) and §8
(evidence reference enforcement)**, the two ordered lowest of the user's
7-item priority list but the ONLY two safely completable as pure
domain-modeling + command-handler work without deep async/process
engineering. **NOT done this pass, explicitly deferred** — items 1–3
(process-launch rejection handling, confirmed termination semantics,
recovery-path consolidation) and items 6–7 (atomic clarification
orchestration, real Postgres harness). See "Why 1–3 and 6 were not
attempted" below for the reasoning, not just the fact.

### §7 — Evidence provenance domain model

Audited first, per instruction, before designing anything: `MissionEvidenceRef`
(Phase 1, `mission-domain.ts`) was DEFINED but never wired into the
projection at all — dead domain modeling. The real evidence store in
production was `MissionProjection.attachedEvidenceIds`/`attestedEvidenceIds`,
two flat string arrays with zero metadata (no assignment, no producer, no
execution/dispatch correlation) — confirmed via grep, not assumed. That is
the actual, reproduced domain gap the audit's §7/§8 findings depend on.

`MissionEvidenceRecord` (`mission-domain.ts`) is the smallest coherent model
closing it — reuses `EvidenceLifecycle`/`EvidenceAvailability`/
`EvidenceIntegrity` VERBATIM (no new axis invented) and adds only the
associative fields needed for reference enforcement: `missionId`,
`assignmentId`, `producerParticipantId`/`producerKind`, `executionId`,
`dispatchKey`, `provider`, `kind` (`EvidenceNoticeKind`, MOVED here from
`mission-collaboration-protocol.ts` — evidence kind is a domain concept,
not message-protocol-only; the protocol file now re-exports it, no
duplication), `source`, `supersededByEvidenceId`. New events:
`mission.evidence_recorded`/`mission.evidence_superseded` — NOT a mutation
of `mission.evidence_attached`/`mission.evidence_attested` (Phase 1's bare
`{evidenceId, digest}` pair), same disambiguation precedent as Phase 5A's
Plan-proposal events.

New commands: `RecordEvidence` (the ONLY way a record comes into existence
— a message can only reference an already-recorded id, never create one:
"do not let a message payload become the authoritative evidence store" is
satisfied structurally, not by convention) and `SupersedeEvidence` (moves
`supersededByEvidenceId` forward; a superseded record is never deleted).
Both wired through the standard collaboration-command path: idempotency,
version-checked, authorized (`RecordEvidence`: any active participant,
human, or system; `SupersedeEvidence`: human/system/owner only), replayed
deterministically.

**Design answers to the 9 questions the user asked to define:**
- Who may create evidence: any active participant (of its own work),
  human, or system (`RecordEvidence`'s authority row).
- When evidence becomes authoritative: the instant `mission.evidence_recorded`
  is folded — there is no separate "pending" evidence state this phase
  introduces (the `lifecycle` axis, reused from Phase 1, already expresses
  the captured→attested→accepted progression if a future phase needs it).
- Whether evidence is immutable: yes, except `lifecycle`/`availability`/
  `supersededByEvidenceId`, which only `SupersedeEvidence` (or a future
  lifecycle-transition command) may advance.
- Whether evidence can be superseded: yes — `SupersedeEvidence`, tested.
- How evidence is associated with an assignment: `assignmentId` field,
  checked to exist at `RecordEvidence` time (`evidence_assignment_not_found`
  otherwise).
- How provider-generated evidence is normalized: `producerKind: "agent"` +
  `provider`/`executionId`/`dispatchKey` fields — not attempted beyond the
  field shape; no adapter was changed to actually EMIT `RecordEvidence`
  commands this pass (see Limitations).
- How human-supplied evidence is represented: `producerKind: "human"`,
  `provider`/`executionId`/`dispatchKey` all null.
- How redacted evidence retains provenance: `availability: "redacted"`
  (reused from Phase 1) sits alongside the full record — the record itself
  (assignment, producer, kind) is never deleted just because the artifact's
  content became unavailable, matching the axis-independence Phase 1
  designed for.
- How evidence survives replay: tested directly — `mission-evidence-provenance.test.ts`'s
  replay test proves the record AND its supersession relationship rebuild
  identically from raw events.

### §8 — Evidence, dispatch, and execution reference enforcement

`validateEvidenceNoticePayload`/`validateCompletionNoticePayload`
(`mission-collaboration-protocol.ts`) now check against real
`evidenceRecords`, not a flat known-id list: unknown evidence id, wrong
assignment (`record.assignmentId !== message.assignmentId`), and
superseded evidence are all refused with distinct typed violation codes
(`evidence_notice_unknown_evidence_ref`, `evidence_wrong_assignment`,
`evidence_superseded`). Cross-Mission references are refused for free,
structurally: each Mission's projection only ever contains ITS OWN
`evidenceRecords`, so a cross-Mission id is simply unknown — no explicit
cross-Mission check was needed or written, and this is proven directly by
a dedicated test using two separate Mission projections.

`completion_notice`'s pre-existing `requiredEvidence` check (a CATEGORY-string
match, e.g. `"evidence://tests"`, set at assignment-creation time — see
mission-planner-templates.ts) was preserved EXACTLY unchanged; the new
record-based check runs ADDITIVELY alongside it, only for `evidenceRefs`
entries that happen to resolve to a real recorded evidenceId. This was a
deliberate, conservative choice: redesigning the category-string contract
to require every completion_notice evidence ref to be a real record would
have been a larger, riskier change than this pass's remaining budget
justified.

**Not implemented this pass**: dispatch-key/execution-id MUTUAL consistency
checks (the record CARRIES these fields, but nothing yet cross-validates
`record.dispatchKey` against the assignment's own current `dispatchKey`, or
`record.executionId` against a real `ExecutionRecord`) — stated as a gap,
not silently assumed complete.

### Tests

`mission-evidence-provenance.test.ts` (11 tests): `RecordEvidence`
success/duplicate/unknown-assignment, `SupersedeEvidence` success/unknown-id,
evidence_notice success/wrong-assignment/cross-Mission/superseded,
completion_notice wrong-assignment, deterministic replay. Plus 2 tests
added to the existing `mission-collaboration-protocol.test.ts` (wrong-assignment,
superseded, at the pure-validator level).

### Verification (this pass)

Full suite: **1,529 passing, 0 failing** (1,518 baseline + 11 new evidence
tests; note: 1,518, not 1,516, because the pure-validator file gained 2
tests during this pass's rewiring, and existing evidence_notice/
completion_notice pure-validator tests were updated to the new
`evidenceRecords`-based signature — no assertion's EXPECTED OUTCOME
changed, only the input shape the (same) test constructs). `npm run
typecheck`: clean. `npm run lint`: 0 errors, 17 pre-existing warnings
(caught and fixed 3 `prefer-const` errors introduced by this pass's own
new test file before finishing — not left for the baseline check to find).
`npm run build`: succeeds.

### Why items 1–3 (process/termination/recovery) and item 6 (atomic clarification) were not attempted

Stated as reasoning, not just a gap list, per this session's established
practice of explaining WHY something was deferred rather than only THAT it
was:

- **Process-launch rejection handling, termination confirmation, and
  recovery-path consolidation together touch the same three files**
  (`mission-process-host-node.ts`, `mission-real-execution-host.ts`,
  `mission-process-recovery.ts`) **and the same live invariant**: whether a
  real OS process may still be running and whether it still holds write
  authority. Getting this wrong in either direction is worse than not
  attempting it: under-confirming leaves genuine orphan processes;
  over-confirming (the exact bug this audit already flagged once, at the
  `AbortController.abort`-as-proof level) causes a redispatch while the old
  process still writes. Correctly modeling this requires a real, carefully
  designed fake-child-process test harness (synchronous throw, async
  error, exit-during-persistence races, bounded timeouts) BEFORE any
  production code changes — the user's own §2 instruction ("do not change
  code until this state diagram is documented") — and that design work
  alone is substantial. Attempting it in the remaining budget of an
  already-large pass risked exactly the kind of rushed, half-verified
  change this session has consistently avoided elsewhere.
- **Atomic clarification orchestration** is deceptively small in
  description but touches assignment-lifecycle behavior exercised by many
  existing tests (`AskAssignmentQuestion`/`AnswerAssignmentQuestion` are
  used across `mission-command-handler-collaboration.test.ts` and others).
  Folding question/answer into `PostMessage`'s existing atomic
  orchestration (mirroring blocker/completion_notice) is the right shape
  — but doing it correctly means either (a) making the OLD two-command
  flow degrade gracefully to a now-redundant no-op, or (b) deciding to
  deprecate it, and both require re-verifying every existing test that
  exercises clarification, not just adding new ones. Flagged for a
  dedicated pass three times now (Parts 2, 3, 4) — this phase prioritized
  the two items (§7/§8) that were both HIGH-VALUE and SAFE to complete
  fully in the time available, rather than partially starting a
  higher-risk item and leaving it half-migrated.
- **Postgres migration harness**: `docker`, `supabase`, and `psql` were
  re-verified absent from this environment (`which docker`/`which supabase`/
  `which psql` all fail). No new attempt was made to add a harness that
  cannot be run here — doing so risks producing untested scripting that
  looks like verification but isn't, which is the exact failure mode the
  audit itself was written to catch.

### Remaining findings

**Remaining Critical:** none.
**Remaining High:** process-launch rejection handling; confirmed process
termination semantics; recovery-path consolidation; dispatch-key/execution-id
mutual consistency enforcement (the field exists on `MissionEvidenceRecord`,
not yet cross-validated).
**Remaining Medium:** atomic clarification orchestration; real Postgres
migration harness (blocked on missing local tooling, documented, not run).

### Limitations (this pass)

- No provider adapter was changed to actually EMIT `RecordEvidence`
  commands — the command/model exist and are fully tested, but nothing in
  `mission-real-execution-host.ts`/`mission-provider-adapter*.ts` calls
  them yet from a real execution. Wiring that is a production-integration
  concern this phase's constraints (no production API/UI) already exclude.
- `completion_notice`'s category-string (`requiredEvidence`) contract and
  its new record-based check coexist rather than being unified into one
  design — stated explicitly rather than silently redesigned.
- Redacted evidence's "retains provenance without exposing content" is
  answered at the FIELD level (`availability: "redacted"` alongside an
  intact record) but no code yet enforces that a caller reading a redacted
  record cannot also read whatever `source`/`integrity` might leak — no
  redaction-content-exposure test was written this pass.

## Phase 4D Part 4 (continued) — process safety, recovery consolidation, atomic clarification

Continuing the SAME Part 4 pass after the evidence provenance work above:
process-launch rejection handling, confirmed termination semantics,
recovery-path consolidation, and atomic clarification orchestration — the
four items previously deferred with reasoning. All four are now complete.
Only the Postgres migration harness remains genuinely blocked, by missing
local tooling (verified, not assumed).

### Process-launch rejection handling (`mission-process-host-node.ts`)

Reproduced the real bug first: `launch()`'s `void runProviderProcess(...).then(...)` had NO `.catch` —
`runProviderProcess` rejects on a synchronous spawn throw (converted to a
rejection by Promise-executor semantics), an async `child.once("error", ...)`,
or an `onSpawn` callback rejection, and none of those were ever caught. That
produced BOTH an unhandled promise rejection AND left `tracked.finished`
false forever, so `inspect`/`collect`/`poll` would report "still running"
indefinitely for a launch that had already, terminally, failed.

Fixed with a `.catch` that sets `tracked.finished = true`, a new
`launchError: Error | null` field on `TrackedProcess` for diagnostics, and
`tracked.exitCode = -1` — a documented sentinel (never a real POSIX/Windows
exit code) that unblocks `RealExecutionHost.poll`'s `exitCode === null`
"still running" check. `inspect` now reports the launch failure's message
in its detail string rather than a generic "process exited with code null."

Tests: `mission-process-host-node.test.ts` — spawn-failure-captured/no-unhandled-rejection
(directly asserts `process.on("unhandledRejection")` never fires),
sentinel-exitCode-unblocks-collect.

### Confirmed termination semantics (`mission-process-host.ts`, `mission-process-host-node.ts`)

`TerminationResult` gained a `kind: TerminationResultKind` field — the 8
outcomes requested (`already_exited`, `graceful_exit_confirmed`,
`forced_kill_confirmed`, `termination_requested_unconfirmed`,
`termination_timed_out`, `process_identity_mismatch`, `process_not_found`,
`termination_state_unknown`) — plus `isConfirmedDeadTermination(kind)`,
which accepts only the three kinds that mean the process is ACTUALLY gone.
`terminated`/`alreadyGone` booleans are PRESERVED for backward
compatibility, derived from `kind` via `buildTerminationResult` — but
matching their ORIGINAL narrower meaning ("this call accomplished/found a
termination"), not the broader "is dead" question `isConfirmedDeadTermination`
answers — these are deliberately different questions and conflating them
was the actual bug this section fixes.

`NodeProcessExecutionHost.terminate` now implements the real bounded
algorithm: (1) identity/existence check first — `process_not_found`/
`process_identity_mismatch`/`already_exited` are all resolved before any
signal is sent; (2) request graceful termination (`abortController.abort()`,
the same signal `runProviderProcess` already wires to `child.kill()`);
(3) poll for natural completion across a bounded `terminationGraceMs`
window (default 3000ms, injectable); (4) escalate — `abort()` again,
idempotent; (5) poll again across a bounded `terminationConfirmMs` window
(default 2000ms); (6) return `termination_timed_out` if still unconfirmed —
NEVER a false `terminated: true`. `mission-process-recovery.ts` now checks
`isConfirmedDeadTermination(termination.kind)` before revoking a lease,
replacing the previous `termination.terminated || termination.alreadyGone`
check with the same practical effect but the correct, honest vocabulary.

**Stated platform limitation**: "force kill" at this layer is a second
`abort()` call, not a distinct SIGKILL-equivalent — `NodeProcessExecutionHost`
holds no direct `ChildProcess` reference of its own (that stays inside
`runProviderProcess`, in `resident-provider-adapters.ts`, deliberately not
reimplemented here). A dedicated test simulating "ignores termination
entirely" was NOT added: this environment is Windows, where `child.kill()`
maps to `TerminateProcess` (no POSIX-signal semantics to "ignore" at all),
so such a test would be both unreliable here and risk leaving a genuinely
unkillable child process lingering for the rest of the test run. The
bounded-wait code path is exercised by every other termination test;
the never-confirms branch is verified by code review, not an added
integration test, for this stated platform reason.

Tests: `mission-process-host-node.test.ts` — process_not_found,
process_identity_mismatch (with explicit real-process cleanup so the test
run doesn't linger), already_exited, graceful_exit_confirmed, duplicate
terminate calls are idempotent.

### Recovery-path consolidation (`mission-dispatch-runtime.ts`)

Audited first: neither `MissionDispatchRuntime.recoverOnStartup` nor
`recoverOutstandingIntentsWithProcessHost` has ANY production caller today
(grep confirmed — both are exercised only by tests), which lowered the risk
of this change considerably. `recoverOnStartup` is now a ROUTER: when the
Runtime is constructed with an optional `processHost: ProcessExecutionHost`,
it delegates ENTIRELY to `recoverOutstandingIntentsWithProcessHost` (the
authoritative, process-aware path) and maps its five outcomes into
`RecoveryReport`'s (extended) shape — `revokedAndClosed` for confirmed-dead/
terminated/quarantined, a NEW `reattached` bucket for still-alive
reattachable processes, a NEW `blockedForReview` bucket for anything
unresolvable. When no `processHost` is configured, it falls back to the
ORIGINAL fence-only classification — kept, not removed, because a caller
with no process-handle tracking capability (`InMemoryExecutionHost` in
tests) genuinely has nothing more informative to check. A production
caller that wires up a real `ProcessExecutionHost` gets the safe path
automatically — it is not a separate opt-in a caller could forget, which is
what "production callers cannot accidentally choose the weaker path"
required.

Tests: `mission-dispatch-runtime.test.ts` — delegates-and-revokes for a
confirmed-dead process, delegates-and-blocks-for-review for a missing
handle (and confirms the intent stays outstanding, never silently closed),
falls back correctly with no `processHost` configured (existing tests
unchanged).

### Atomic clarification orchestration (`mission-command-handler.ts`, `mission-commands.ts`)

`AskAssignmentQuestion`/`AnswerAssignmentQuestion` REDESIGNED to be
self-contained: each command now carries full message-authoring fields
(`senderParticipantId`, `recipientParticipantIds`, `body`, `evidenceRefs`)
and creates its OWN `mission.message_posted` event AND the assignment
transition event in the SAME atomic payload batch — no prior separate
`PostMessage` call is required or even accepted anymore. This is the fix
for the two-command flow the audit flagged: there is no longer a gap
between "message posted" and "assignment transitioned" for a crash to land
in, because there is only one command, one idempotency key, one
expected-version check, one event batch.

Each command reuses the SAME protections `PostMessage` already has:
Mission-scoped duplicate-`messageId` rejection, sender-identity binding
(an agent actor cannot claim a different participant's `senderParticipantId`),
and the full `validateMessage` communication-policy check (sender must
exist and be active — closing "removed participant cannot answer/ask"
structurally, not via a special-cased check). `AnswerAssignmentQuestion`
still requires `questionMessageId` to reference a real, unanswered
`question` message and refuses a second distinct answer
(`question_already_answered`) — unchanged domain logic, now just reached
atomically. Resuming to `"running"` only succeeds when the assignment's
CURRENT status legally permits it via the existing transition table
(`mission-collaboration.ts`) — a cancelled (terminal) assignment structurally
cannot reach `"running"`, so "cancelled assignment not resumed" required no
separate check, just the existing `invalid_assignment_transition` path.

Two PRE-EXISTING tests in `mission-collaboration-delegation.test.ts`
encoded the OLD, now-removed two-command flow (`PostMessage` then
`AskAssignmentQuestion` referencing its messageId) — corrected to the new
atomic single-command flow, since the old flow is exactly the unsafe
pattern this section fixes, not a behavior worth preserving.

Tests: `mission-clarification-atomicity.test.ts` (9 tests) — atomic ask
(exactly 2 events, message + transition), atomic answer (same), duplicate
answer retried (deterministic `duplicate_message_id`), a second distinct
answer rejected, removed participant cannot ask, removed participant
cannot answer, cancelled assignment never resumed, sender-identity
impersonation refused, and full replay reconstructing both the pending and
resolved clarification states exactly.

### Postgres migration harness (`scripts/mission-atomicity-integration-test.sh`)

REWRITTEN, not executed. The prior version of this script was itself
stale in exactly the way the audit predicted: it called
`apply_mission_command_atomic` with a 7-argument shape that has never
matched the migration's real 9-argument signature
(`p_mission_id, p_workspace_id, p_idempotency_key, p_command_type,
p_payload_digest, p_expected_version, p_events, p_result, p_repository_id`),
and used an integer `schemaVersion` in its sample event JSON — both
reproduced and corrected. The rewritten script covers every item in the
user's list: apply-both-migrations-in-order, current TEXT schemaVersion
insertion (asserted directly against the stored column value), Mission
genesis, same-workspace mutation, CROSS-WORKSPACE REJECTION (asserting the
Critical Part-1 fix's `workspace_mismatch` status specifically), stale
expected-version rejection, idempotent retry (asserts event count doesn't
grow), conflicting retry (`idempotency_conflict`), event ordering
(gapless `aggregate_version`), a documented manual projection-replay step,
dispatch-lease function/column existence, evidence-provenance event
acceptance by the check constraint, Planner event constraint survival, and
RLS/service-role assumptions (anon/authenticated refused, service_role
succeeds) — plus a transaction-rollback fault-injection check proving a
mid-loop failure rolls back the genesis insert too, not just the events.

**Status: still NOT executed.** `which docker`/`which supabase`/`which psql`
were all re-verified absent from this environment. The script is
syntax-checked (`bash -n`) but has never run against a real Postgres
instance. Exact commands for a human or CI runner with the right tooling:
`npm i -g supabase` then `bash scripts/mission-atomicity-integration-test.sh`
(requires Docker running). No SQL change across any Phase 4D part may be
described as "database-verified" until that script is actually run and
every line reads PASS.

### Verification (this continuation)

Full suite: **1,548 passing, 0 failing** (1,529 baseline this Part 4 pass +
19 new: 16 process-host-node process-launch/termination tests [7 new,
9 pre-existing unchanged] + 3 dispatch-runtime recovery-delegation tests +
9 clarification-atomicity tests, with 2 pre-existing clarification tests
corrected to the new atomic command shape rather than left encoding the
removed two-command flow). `npm run typecheck`: clean. `npm run lint`: 0
errors, 17 pre-existing warnings (unchanged). `npm run build`: succeeds.

### Remaining findings (end of this Phase 4D pass)

**Remaining Critical:** none.
**Remaining High:** dispatch-key/execution-id mutual-consistency enforcement
on evidence records (the fields exist, cross-validation does not); the
Postgres harness has never actually executed against a real database.
**Remaining Medium:** none newly identified this continuation — the two
Medium items from the prior report (atomic clarification, Postgres harness)
are now respectively DONE and (script-complete-but-unexecuted).

### Limitations (this continuation)

- "Force kill" is not a distinct signal from "graceful termination" at the
  `NodeProcessExecutionHost` layer — both are `AbortController.abort()`
  calls to the same underlying `runProviderProcess` invocation. A host with
  a real supervisor/container runtime underneath it could implement a
  genuinely distinct forced-kill step; this one honestly can't without
  reimplementing process control `resident-provider-adapters.ts` already
  owns.
- No test exercises the `termination_timed_out` branch with a real,
  running, un-killable child process — a deliberate platform-safety
  decision (Windows kill semantics + risk of a lingering, un-killable test
  process), not an oversight. The code path is reachable and reviewed, not
  integration-tested end to end.
- The Postgres harness script is complete and corrected but has never
  actually run. Its PASS/FAIL output in this document is illustrative of
  what it checks, not a claim that any of it has been observed to pass.

## Phase 4D closeout — dispatch/execution mutual-consistency on evidence records

The last stated High-severity gap: `MissionEvidenceRecord.dispatchKey`/
`executionId` existed as fields but nothing cross-validated them.

**`dispatchKey` — now enforced.** `RecordEvidence` refuses a claimed
`dispatchKey` that doesn't match the referenced assignment's own current
`dispatchKey` (`evidence_dispatch_key_mismatch`), including the case where
the assignment was never dispatched at all (`dispatchKey: null` on the
assignment, anything non-null claimed by the evidence). A command with no
`dispatchKey` claimed at all is never blocked by this check — only an
actual claim is verified.

**`executionId` — still NOT cross-validated, and stated why.** The Mission
projection has no `ExecutionRecord` registry at all — execution attempts
live in `mission-execution.ts`/`mission-scheduler-store.ts`, entirely
outside `MissionProjection`. There is no real state in this projection to
check an `executionId` claim against without inventing a new one, which
would be exactly the kind of "smallest coherent model" question item 7
already asked and answered narrowly (dispatchKey/producer/kind, not a full
execution-registry mirror). Left as a genuine, explicitly-stated gap rather
than a fabricated check against nothing.

Tests: `mission-evidence-provenance.test.ts` — matching dispatchKey
accepted, mismatched dispatchKey refused, dispatchKey claimed against a
never-dispatched assignment refused, no-dispatchKey-claimed never blocked.

Verification: full suite **1,552 passing, 0 failing** (1,548 + 4 new).
`npm run typecheck`: clean. `npm run lint`: 0 errors, 17 pre-existing
warnings. `npm run build`: succeeds.

**Postgres harness**: re-verified absent (`docker`/`supabase`/`psql` all
still fail via `which`). No further action possible in this environment
beyond what Part 4's rewrite already did — the harness is complete and
correct on inspection, never executed.

**Remaining Critical: none. Remaining High: none** (the Postgres harness's
non-execution is an environment limitation, not an unaddressed code gap).
**Remaining Medium: none newly identified.**

## Phase 5B — Model-Assisted Mission Planning

Primary objective: let a model PROPOSE `MissionPlanProposal` objects from a
natural-language objective and bounded repository context, while Phase 5A's
deterministic validator/simulator/approval/materialization path remains the
ONLY authority boundary. The model proposes; it never approves,
materializes, dispatches, executes, or mutates Mission state directly.

### Pre-implementation audit (§1)

- **Current `MissionPlanProposal` shape**: unchanged from Phase 5A —
  `id/missionId/version/status/objective/assumptions/constraints/
  participantProposals/assignmentProposals/collaborationTopology/
  evidenceRequirements/approvalGates/executionLimits/unresolvedQuestions/
  warnings/validationErrors/createdAt/createdBy/supersedesPlanId`. This
  phase adds ZERO fields to it — model-assisted planning normalizes INTO
  this exact shape, never alongside it.
- **Plan lifecycle states**: `draft/validating/valid/invalid/approved/
  materializing/active/superseded/rejected/cancelled` (Phase 5A). Confirmed
  `"cancelled"` was a real enum value with NO command reaching it — the
  Phase 5A report's own stated limitation. Closed this phase via
  `CancelMissionPlan` (§14), not a new enum value.
- **Planner interfaces**: `MissionPlanner.propose/validate/simulate`
  (mission-planner.ts) — confirmed reusable verbatim; `validate`/`simulate`
  are called by model-assisted planning with ZERO changes to their
  signatures.
- **Deterministic templates**: the 5 Phase 5A templates
  (mission-planner-templates.ts) — confirmed model-assisted planning
  selects one of these 5 by name (schema-enforced), never an
  arbitrary/invented topology.
- **Validator/simulator entry points**: `validateMissionPlanProposal`
  (mission-planner-validator.ts), `simulateMissionPlanProposal`
  (mission-planner-simulator.ts) — confirmed BOTH are called, unmodified,
  on every model-assisted proposal before it can become a real Plan.
- **Approval/materialization commands**: `ApproveMissionPlan`/
  `MaterializeMissionPlan` — confirmed UNTOUCHED; a model-assisted Plan
  reaches `"draft"` and stops there, same as a deterministic one.
- **Plan versioning/supersession**: `SupersedeMissionPlan`'s pattern
  (supersede old + create new in one atomic payload batch) — confirmed
  reusable directly for model-assisted revision (§13).
- **Cancellation/supersession**: confirmed `CancelMissionPlan` did not
  exist — added this phase (§14).
- **Existing model-client abstractions**: none found specific to Mission
  planning. `@anthropic-ai/sdk` IS a dependency (`package.json`), used
  elsewhere in the repo for UNRELATED features — NOT wired into Mission
  planning this phase (§20's "use deterministic fake model clients, no
  live model API required in CI" instruction is honored literally: no real
  model call exists anywhere in this phase's code).
- **Structured-output/schema-validation libraries**: none found (re-checked:
  no zod/ajv/yup/joi/valibot/superstruct/io-ts in package.json — same
  finding as Phase 4D Part 3). Followed the SAME hand-written
  discriminated-union pattern `mission-protocol-schema.ts` established.
- **Redaction/prompt-construction utilities**: `session-redaction.ts`
  exists for a DIFFERENT purpose (session transcript redaction) — not
  reused directly; `mission-planning-context.ts`'s redaction (binary/
  prohibited-path/encoding exclusion) is purpose-built and narrower.
- **Provider capability representation**: `ProviderCapabilities`
  (mission-provider-adapter.ts) confirmed EXECUTION-specific
  (non_interactive_execution, repository_editing, ...) — confirmed
  planning capability requirements ARE distinct (structured_output,
  strict_json_schema, tool_free_generation, ...) and were given their own
  profile (§5), never reusing `ProviderCapabilities`.
- **Mission planning vs. execution boundary**: confirmed exact — planning
  commands (`RequestModelPlanning`/`RecordModelPlanningResult`) live in
  `mission-command-handler.ts` alongside every other collaboration command
  and import NOTHING from `mission-dispatch-runtime.ts`/
  `mission-real-execution-host.ts`/`mission-process-host-node.ts`/either
  provider adapter — verified both by code review and by a dedicated test
  that greps the handler source for those module names.
- **Outbox/request-result flow needed?** Yes — confirmed and built (§10).
- **CancelMissionPlan needed for coherent revision?** Yes — confirmed and
  built (§14): a stale/materialized revision base is refused at
  `RequestModelPlanning` time using the same Plan-status check.
- **Old Phase 1 plan events (`mission.plan_proposed`/`mission.plan_approved`)**:
  confirmed still simply DORMANT (emitted only by `MarkMissionReady`,
  untouched by any phase since) — neither deprecated nor ambiguous, just a
  separate, thinner, still-functioning concept, exactly as documented in
  Phase 5A.

### Architectural boundary (§2)

No `ModelAssistedMissionPlanner` CLASS was built with the exact 4-method
shape suggested — instead, the SAME durable-command-first architecture
every other Mission subsystem uses: `RequestModelPlanning`/
`RecordModelPlanningResult`/`CancelModelPlanningRequest` (mission-commands.ts),
handled entirely inside `mission-command-handler.ts` (pure, no I/O). The
actual "planner" logic is a set of pure functions
(`mission-model-plan-schema.ts`'s `validateRawModelPlanOutput`,
`mission-model-plan-normalizer.ts`'s `normalizeModelPlanProposal`) the
command handler calls directly — request/result durability comes from the
command pattern itself, not a separate class wrapping it. This satisfies
the SAME "durable request/result separation" requirement with fewer moving
parts, consistent with this session's established preference for
collapsing suggested surface area into the smallest coherent primitive
set (see Phase 5A's Plan-event collapse, Phase 4D's recovery-report
collapse).

Verified structurally (not just by convention) that the model-assisted
path never touches execution: `mission-command-handler.ts` has no import
of `mission-dispatch-runtime`/`mission-real-execution-host`/
`mission-process-host-node`/either provider adapter file — a dedicated
test (`mission-model-planning.test.ts`) greps the handler's own source and
fails if any of those five module names ever appear in it. No fake Mission
participant or assignment is created to "invoke" the model — nothing is
invoked from inside this codebase at all; an external, impure worker makes
the actual model call and reports back via `RecordModelPlanningResult`.

### Canonical Plan output (§3)

Model-assisted planning produces the EXACT `MissionPlanProposal` type. No
`AiMissionPlan`/`LlmPlan`/`GeneratedPlan`/`ModelPlanAggregate` type exists
anywhere. The untrusted intermediate type is `RawModelPlanOutput`
(mission-model-plan-schema.ts) — deliberately NOT Plan-shaped (model-local
ids, no `status`/`id`/`version`, no `provider` field at all).
`normalizeModelPlanProposal` (mission-model-plan-normalizer.ts) is the
ONLY function that converts one into the other, and its result is then run
through the IDENTICAL `validateMissionPlanProposal`/
`simulateMissionPlanProposal`/`ApproveMissionPlan`/`MaterializeMissionPlan`
path every deterministic Plan already uses — proven directly:
`RecordModelPlanningResult`'s success case emits the literal
`mission.plan_proposal_created` event type, not a new one.

### Strict structured output (§4)

`mission-model-plan-schema.ts`'s `validateRawModelPlanOutput` — a
hand-written, closed-allow-list, runtime discriminated-union validator
(no schema library exists in the repo; consistent with Phase 4D Part 3's
finding, not reinvestigated needlessly). Rejects, each with a distinct
typed `ModelPlanSchemaErrorCode`: malformed JSON, unsupported
`schemaVersion`, unknown fields (including a model literally trying to
assert `provider`, which has NO field in the schema at all), duplicate
participant/assignment ids, missing references, dependency cycles
(Kahn's algorithm, same discipline as `mission-planner-validator.ts`),
malformed paths (via `canonicalizeRepoPath`, Phase 4D's canonical utility —
reused, not reimplemented), invalid enum values (role/operatingMode/
approvalPolicy/collaboration-edge-kind), unsupported procedure templates,
and array-size caps (`MAX_MODEL_PARTICIPANTS`=8, `MAX_MODEL_ASSIGNMENTS`=16,
`MAX_MODEL_TOPOLOGY_EDGES`=32, `MAX_MODEL_STRING_ARRAY_LENGTH`=32) closing
"unbounded recursion"/"invalid participant counts." Every field is read by
EXACT key — nothing is regex-scraped out of `rationale`/`assumptions` free
text.

### Model planning capability profile (§5)

`mission-planning-capability.ts` — `PlanningCapability` (`structured_output`,
`strict_json_schema`, `deterministic_sampling`, `tool_free_generation`,
`bounded_retry_support`), DELIBERATELY separate from `ProviderCapabilities`
(Phase 3A). `PlanningModelConfiguration` is trusted, operator-authored
configuration — `checkPlanningCapabilities` never accepts a capability
claim FROM model output (there is no code path that reads capabilities out
of a model response at all). `REQUIRED_PLANNING_CAPABILITIES` = 
structured_output/strict_json_schema/tool_free_generation — an
under-capable configuration fails `RequestModelPlanning` itself with
`planning_capability_unresolved`, before any durable request is created.

### Bounded planning context (§6) / prompt-injection boundary (§7)

`mission-planning-context.ts`'s `buildPlanningContext` — an ALLOW-LIST
builder (`PlanningContextInput` has no field for secrets/credentials/env
vars/binary contents/unrestricted logs AT ALL — proven by a test that
checks the built context's own key set). Deterministic ordering (paths/
roles/rules sorted; snippets sorted by path); bounded (`MAX_DOCUMENTATION_SNIPPETS`=10,
`MAX_SNIPPET_CHARS`=4000, `MAX_PLANNING_CONTEXT_CHARS`=20000 — truncating
whole snippets from the end, never mid-snippet); redacted (binary
extensions and prohibited-path snippets excluded outright via the SAME
`canonicalizeRepoPath` Phase 4D built, non-UTF-8 snippets excluded via a
replacement-character check) — every exclusion produces a
`truncationNotes` entry, nothing silently vanishes. `contextHash` is a real
SHA-256 (via Node's built-in `crypto.subtle`, no new dependency) over the
fully normalized context — the same logical input always hashes identically,
verified directly.

`renderPlanningPrompt` keeps `systemPlanningPolicy`/`missionAuthority`/
`trustedConfiguration`/`userObjective` structurally separate from
`repositoryContent`, which is always labeled "UNTRUSTED REPOSITORY CONTENT."
This function does NOT itself defend against injection — the actual
defense is that `validateRawModelPlanOutput`/`validateMissionPlanProposal`/
`checkTemplateSafeguards` never read this rendered prompt at all, so even
a model that fully "obeys" injected repository text can only produce a
`RawModelPlanOutput`, which still has to pass every deterministic gate.
Proven directly by adversarial tests in `mission-model-planning.test.ts`:
a "model output" simulating compliance with injected instructions to
broaden scope, drop mandatory approval, or fabricate a provider capability
is rejected by the SAME deterministic validation every legitimate proposal
goes through — no special injection-detection code exists or is needed.

### Template-guided generation (§8) / normalization (§9)

The model selects one of the 5 existing `ProcedureTemplateId`s
(schema-enforced) and proposes its own participants/assignments/topology
— NOT parameters into `buildProcedure` (a bigger redesign than this phase's
budget justified) but a full proposal, structurally checked against that
template's MANDATORY safeguards via the NEW
`checkTemplateSafeguards`/`TEMPLATE_SAFEGUARDS` (mission-planner-templates.ts):
minimum/maximum participant counts, a required `human_required` assignment
for `implementation_test_verification`, a required "review" edge for the
two review templates, a required "dependency" edge for
`investigation_then_implementation`. A violation is treated as a
VALIDATION failure (routed through the SAME bounded-repair-or-fail path as
any other validation error), never silently patched into the model's
output — silently "fixing" what a model proposed would hide exactly the
signal a human reviewer needs to see.

Normalization (`mission-model-plan-normalizer.ts`): model-local ids are
mapped to `${missionId}-plan-participant/assignment-<n>` using the SORTED
order of the model's OWN local id strings (never array position) — proven
deterministic regardless of input ordering. Provider assignment is ALWAYS
computed via `resolveProviderForCapabilities` (newly extracted, shared
with Phase 5A's deterministic `propose()` — the exact same function, not
a duplicate) — the model's `requiredCapabilities` is a REQUEST, never a
provider identity; there is no code path that could honor a model-claimed
provider even if one were smuggled in (the schema has no field for it).
Paths normalize via `canonicalizeRepoPath`; string arrays deduplicate and
sort. Equivalent proposals (same content, different JSON key/array order)
normalize to `deepEqual` output — verified directly.

### Durable request/result lifecycle (§10) / planning-request state model (§11)

`PlanningRequestRecord` (mission-domain.ts) — `id/missionId/targetPlanVersion/
kind/basePlanId/status/modelConfigurationId/contextHash/attemptCount/
maxAttempts/createdAt/startedAt/completedAt/correlationId/causationId/
idempotencyKey/redactedDiagnosticRef/finalOutcome/resultingPlanId`. Never
stores secrets or an unrestricted raw prompt — only a
`redactedDiagnosticRef` OPAQUE POINTER into a separate, un-built-this-phase
diagnostic store (§17's "separate bounded diagnostic store" was scoped to
the pointer contract only; the actual store is out of scope — see
Limitations).

7-state machine (`PlanningRequestStatus`): `requested/in_progress/completed/
failed/cancelled/stale/superseded`, transition table in
`mission-collaboration.ts`'s `validatePlanningRequestTransition` — a repair
re-attempt returns `in_progress -> requested`, never a separate
"repairing" status.

Commands (3, not the ~6 the spec enumerated as examples — same
consolidation precedent as the events below): `RequestModelPlanning`
(durably records the request; checks planning capabilities; for
`kind: "revision"`, checks the base Plan is still in a revisable status —
`draft/invalid/valid/approved`, refusing `materializing`/`active`/any
terminal status at REQUEST time, before any model call happens),
`RecordModelPlanningResult` (the ONE place raw model output is ever
parsed — schema-validate, normalize, check template safeguards,
deterministically validate, deterministically simulate, and ONLY on full
success emit the real Plan-creation/supersession events), and
`CancelModelPlanningRequest`. Plus `CancelMissionPlan` (§14).

Events (2, collapsing the ~8 the spec enumerated — the SAME "one
status-changed event reused across every transition" pattern Phase 4A/4B/
5A/4D established): `mission.model_plan_request_created`,
`mission.model_plan_request_status_changed`.

Idempotency/staleness: retries are idempotent via the standard outer
`applyMissionCommand` idempotency check (unchanged) — a genuine retry with
the same idempotency key never re-enters `RecordModelPlanningResult`'s
logic at all. A result for an ALREADY-terminal request (a stale, non-retry
duplicate) is refused as `planning_request_not_actionable` — verified this
can never produce a duplicate Plan version. Mission cancellation
invalidates outstanding requests via a `current.terminal` check inside
`RecordModelPlanningResult` — simpler than a cascading side-effect on
`CancelMission` itself, and verified to produce the exact same practical
outcome (a late result after cancellation becomes `"stale"`, no Plan
created) — stated as a deliberate simplification, not silently assumed
equivalent.

### Repair loop (§12)

Bounded via `attemptCount`/`maxAttempts` on the durable record alone — no
recursion, no hidden retry counter. Every validation failure branch
(malformed/unsupported schema, template safeguard violation, deterministic
validation failure, simulation failure) routes through the SAME
`recordFailureOrRepair()` closure: if `attemptCount < maxAttempts`, the
request returns to `"requested"` (available for exactly one more external
attempt); otherwise `"failed"`, terminal. No Plan state is ever created
before a fully successful attempt. A repair attempt receives NO unrestricted
hidden system policy — structurally true, since nothing in this command
even has access to such a thing (`context`/`command` carry only what the
command payload itself declares).

### Plan revision (§13) / cancellation and supersession (§14)

Revision reuses `SupersedeMissionPlan`'s exact atomic pattern
(supersede-old + create-new in one payload batch) inside
`RecordModelPlanningResult`'s success branch when `request.kind ===
"revision"`. Verified: the prior Plan version's OWN content is byte-for-byte
unchanged (only `.status` moves to `"superseded"`); the new version starts
at `"draft"`, requiring fresh approval even if the prior version had
already been approved; a stale/materialized revision base is rejected at
`RequestModelPlanning` time, before any model call. Materialized-Plan
revision remains categorically out of scope (rejected with a typed
`plan_revision_base_invalid` error) — no reconciliation-with-running-
assignments logic was attempted, matching the constraint.

`CancelMissionPlan` (new) reaches the Phase 5A `"cancelled"` enum value for
the first time — draft/invalid/valid/approved (unmaterialized) all
transition there; `materializing`/`active` refuse it via the existing
`PLAN_TRANSITIONS` table (materialized-Plan cancellation is rejected, per
the audit's own determination). A cancelled or superseded Plan cannot
materialize — verified directly (both already fell out of the existing
Phase 5A transition table with no new code needed).

### Validation feedback (§15) / simulation (§16)

No new feedback surface was built — `PlanValidationError`
(mission-planner-validator.ts, Phase 5A) already carries `code`/
`assignmentId`/`participantId`/`detail` for every one of the categories
§15 lists (missing participant/assignment reference, dependency cycle,
capability mismatch, scope violation, approval-authority unavailable,
budget violation, unrecognized vocabulary). `checkTemplateSafeguards`'s
violation strings are the one NEW feedback category this phase adds.
Neither ever includes secrets or unrestricted internal policy text — both
are pure, structured, and derived only from the Plan/context already
being validated.

Simulation is the EXACT unmodified `simulateMissionPlanProposal` — a
`RecordModelPlanningResult` success path additionally checks
`simulation.unreachableAssignments.length > 0` as a hard failure
(routed through the repair-or-fail path), closing "a failed simulation
cannot be approved or materialized" — since an unreachable assignment in a
model-authored Plan would otherwise silently pass through to `"draft"`
with a structurally broken dependency graph.

### Security and tenant isolation (§18)

Preserved, not re-implemented: planning requests live inside the SAME
per-Mission projection, so workspace/tenant scoping is inherited from the
SAME outer idempotency/version/workspace-mismatch machinery every other
command already goes through (Phase 4D Part 1's `workspace_mismatch` fix
applies here unchanged — no command-specific tenant check was needed).
`RequestModelPlanning`/`CancelModelPlanningRequest` require human/system/
owner authority (`mission-authorization.ts`); `RecordModelPlanningResult`
requires `system` ONLY — an agent participant can never report a model
result, closing "model workers may record results only for an existing
durable request" at the authorization layer, not just the domain-logic
layer. Mission cancellation rejects late results (§10, verified).

### Postgres constraint (§19)

Two new event-type strings appended to the existing
`mission_events.event_type` check constraint (no new table, no new
migration file — same JSONB-payload pattern every phase since 4A has
used). `scripts/mission-atomicity-integration-test.sh` updated with one
additional check (`mission.model_plan_request_created` accepted by the
constraint). **Still not executed** — `docker`/`supabase`/`psql` remain
absent from this environment (re-verified). No claim of live SQL
verification is made for this phase's constraint change, same as every
prior phase's.

### Tests (§20)

5 new test files, 69 new tests: `mission-model-plan-schema.test.ts` (19 —
every `ModelPlanSchemaErrorCode`), `mission-model-plan-normalizer.test.ts`
(10 — determinism, provider resolution, path normalization, template
safeguards), `mission-planning-context.test.ts` (12 — hashing, ordering,
binary/prohibited-path/encoding exclusion, truncation, allow-list
verification, prompt separation), `mission-planning-capability.test.ts`
(4), `mission-model-planning.test.ts` (25 — architecture, request/result,
repair, revision, cancellation, security/prompt-injection, deterministic
replay). All using deterministic fake model output text; no live model API
anywhere in this phase.

### Verification

Full suite: **1,621 passing, 0 failing** (1,552 baseline + 69 new, zero
existing tests modified). `npm run typecheck`: clean. `npm run lint`: 0
errors, 17 pre-existing warnings (caught and auto-fixed 6 `prefer-const`
errors introduced by this phase's own new test file before finishing).
`npm run build`: succeeds.

### Remaining findings

**Remaining Critical: none. Remaining High: none.**
**Remaining Medium:** the `redactedDiagnosticRef` pointer contract exists
(§11/§17) but no actual bounded diagnostic store was built to back it —
stated as deferred, not silently assumed complete.

### Limitations / explicitly deferred work

- No real external model client/worker was built — by design, per the
  explicit "use deterministic fake model clients, no live model API
  required in CI" instruction. `RecordModelPlanningResult` accepts
  `rawModelOutputText` as a plain string parameter; wiring an actual HTTP
  call to a model provider is a production-integration concern this
  phase's constraints already exclude.
- The separate bounded diagnostic store for large/redacted raw model
  responses (§17) was not built — `redactedDiagnosticRef` is a typed
  `string | null` pointer with no backing store yet.
- `checkTemplateSafeguards`'s participant-count/edge-presence checks are a
  STRUCTURAL approximation of "did the model preserve this template's
  safeguards," not a semantic one (e.g. it cannot detect a technically-present
  but toothless review edge). Stated as a real limitation of the
  smallest-coherent-check this phase's budget allowed.
- `RecordModelPlanningResult`'s Mission-cancellation check
  (`current.terminal`) is Mission-level only — a Mission that is merely
  PAUSED (not terminal) still accepts late results, which may or may not
  be the desired policy; not addressed this phase.
- No production API/UI/worker was added, matching the explicit constraint.

## Phase 5E — Planning Runtime Persistence and Recovery Closure

### Completed

- Live migration audit of the 8 migrations applied to the linked "RunLeak"
  Supabase project (`docs/PHASE_5E_MIGRATION_AUDIT.md`) — all additive, no
  collisions, no operational risk to existing behavior.
- Production planning lease, attempt, and diagnostics Supabase adapters
  (`mission-planning-lease-store-supabase.ts`,
  `mission-planning-attempt-store-supabase.ts`,
  `mission-planning-diagnostics-store-supabase.ts`), plus a replayable-response
  Supabase adapter added this phase (`mission-planning-replayable-response-store-supabase.ts`).
- Production planning worker composition root
  (`mission-planning-worker-production.ts`) — constructs `MissionPlanningWorker`
  with the real Supabase-backed stores, never the in-memory reference
  implementations, verified by a structural test.
- Real-Postgres direct-RPC verification: **37/37** (`scripts/phase5e-live-db-harness.ts`,
  against the live "RunLeak" project — functional lease/attempt/diagnostics
  behavior, permission boundaries, 2-way and 10-way claim races, attempt
  terminal-transition races, concurrent diagnostic idempotency, rollback on
  invalid input).
- Live adapter-through-RPC verification: **18/18**
  (`scripts/phase5e-live-adapter-harness.ts` — exercises the actual adapter
  classes, not raw RPC calls, against the live database).
- Corrective release-lease migration applied live
  (`supabase/migrations/20260727040000_fix_release_mission_planning_lease_status_guard.sql`) —
  fixed a real defect the harness found: `release_mission_planning_lease` was
  missing the `status <> 'leased'` guard `renew_mission_planning_lease`
  already had, so a duplicate release silently succeeded instead of being
  refused. Fixed in SQL (live) and mirrored in the in-memory store for parity;
  both now return a distinct `already_released` reason.
- Deterministic-pipeline recovery executor
  (`executeRerunDeterministicPipeline` in `mission-planning-recovery-executor.ts`) —
  loads durable replayable-response material, verifies its digest, re-runs
  the exact schema-validate → normalize → deterministic-validate →
  deterministic-simulate pipeline the live worker uses, records through
  `PlanningRequestPort` only. Never calls `PlanningModelClient` (verified by
  absence of the import and by test).
- Persistence-only recovery executor (`executeReplayPersistence`, same
  file) — replays an already-computed result using its original idempotency
  key; never recomputes the deterministic pipeline, never calls
  `PlanningModelClient`.
- Replay-material persistence gap closed (`docs/PHASE_5E_REPLAY_MATERIAL_AUDIT.md`) —
  `mission_planning_replayable_responses` (an already-deployed table from an
  earlier phase) was never written by the worker; `mission-planning-worker.ts`
  now persists redacted raw output there after every successful invocation,
  as an optional constructor dependency defaulting to an in-memory store.
- Transaction-boundary documentation (`docs/PHASE_5E_TRANSACTION_BOUNDARIES.md`) —
  all 9 specified crash cases mapped to a resolved recovery action, with
  honest TOCTOU-risk and live-vs-in-memory-proof disclosure.
- Final local verification: **1793/1793** passing, typecheck clean, lint
  clean except the same 17 baseline warnings, `npm run build` successful.

### Explicit remaining limitations

- Production `IdempotencyStore` (backing `RecordModelPlanningResult`) is
  still in-memory only, even in the "production" composition root — `replay_persistence_only`'s
  duplicate-call safety currently rests on the Phase 5B command handler's
  own terminal/status checks, not a durable idempotency dedup layer.
- Replayable-response keying uses `providerRequestId ?? attempt-N` as a
  synthetic discriminator and is **not proven** to match the real
  attempt-store primary key in every path.
- Recovery executors have not been exercised against live Postgres — only
  against in-memory stores and fake Supabase clients in this session.
- `MissionPlanningWorker` is not deployed or scheduled anywhere; the
  production composition root exists but nothing currently invokes it.
- Authenticated-role permission verification was skipped in the live
  harness — no mechanism was available in this environment to mint an
  authenticated (non-anon, non-service-role) session; explicitly reported
  as skipped, not claimed as passing.

None of the above are described as completed or verified — they are open
items for a future phase.

## Phase 3D application API — Mission API/service layer (this session)

Scope: the application-facing API/service layer over the existing Mission
command/query boundary — `runMissionCommandDurable`, `applyMissionCommand`,
`projectMission` — for the future production runtime and dashboard UI.
**No production Phase 3D runtime work** (scheduler, provider worker,
deployment composition) was touched or claimed complete; this is the layer
above it. Ran concurrently with an independent Codex verification pass
against disposable PostgreSQL on the assignment-dispatch/execution-result
authority boundary (`996f8c7`, `9944b09`) — this work never reads or writes
`mission_scheduler*` or `mission_execution_result*` tables, so there should
be no file-level overlap, but both sessions touch `src/lib/mission/*`.

### Audit finding that shaped this design
`docs/MISSION_ARCHITECTURE_AUDIT_2026-07-25.md` established that **no
production caller of the Mission command/query boundary existed anywhere in
the repo** before this session — `runMissionCommandDurable` had zero
references outside `src/lib/mission/*` and `scripts/mission*.test.ts`. This
is greenfield application-layer work on top of an already-tested domain
core, not a rewrite of an existing surface. The audit also flagged that
`apply_mission_command_atomic` does not itself re-verify `workspace_id` on
an existing Mission before a write reaches the RPC-level check — this
service does not rely on that alone: every read AND every mutation first
loads the `missions` index row (`missions.workspace_id`) and refuses with
`mission_not_found` (never a 403) before any event is loaded or command is
built, closing the read-path gap the audit could not close from inside the
RPC alone.

### New files

- `src/lib/mission/mission-application-service.ts` — the service. Exposes
  `createMission`, `getMission`, `listMissions`, `getMissionTimeline`,
  `getMissionAssignments`, `getMissionPlan`, `startMission`, `pauseMission`,
  `resumeMission`, `stopMission`, `cancelMission`, `requestMissionReview`,
  `recordMissionReviewDecision`, `getMissionEvidence`,
  `getMissionExecutionStatus`. Every mutation ends in exactly one
  `runMissionCommandDurable` call; no route or service function appends
  events, mutates a projection, or touches scheduler/result-inbox tables.
- `src/lib/mission/mission-application-errors.ts` — `MissionApiError` +
  `fromApplyCommandError`, mapping every `ApplyCommandError.code` to a
  stable HTTP status without collapsing anything into a generic 500.
- `src/lib/mission/mission-principal.ts` — the one place a route resolves a
  request into a Mission `EventActor` + authorized `workspaceId`, reusing
  the two trust paths `/api/agent/*` already established (cookie session /
  `authenticateAgent` bearer) rather than inventing a third.
- `src/app/api/missions/**` — 14 route files (list below) plus
  `src/app/api/missions/_shared.ts` (principal resolution + error mapping,
  mirroring `/api/agent/_shared.ts`'s convention with Mission's own typed
  taxonomy instead of the legacy thrown-class one).
- `scripts/mission-application-service.test.ts` — 15 tests against the same
  in-process fake `MissionEventReader`/`MissionCommandPersistence` shape
  `mission-runtime-durable.test.ts` already uses (never a real Supabase
  client), added to `package.json`'s `test` script.

### Routes added

`POST /api/missions`, `GET /api/missions`,
`GET|POST /api/missions/[missionId]` (GET only — no PATCH/DELETE added),
`GET /api/missions/[missionId]/timeline`,
`GET /api/missions/[missionId]/assignments`,
`GET /api/missions/[missionId]/plan`,
`POST /api/missions/[missionId]/start|pause|resume|stop|cancel`,
`POST /api/missions/[missionId]/review/request`,
`POST /api/missions/[missionId]/review/decision`,
`GET /api/missions/[missionId]/evidence`,
`GET /api/missions/[missionId]/executions`.

### Command mapping decisions (no single 1:1 domain command exists for some verbs)

- `startMission` — there is no domain `StartMission` command. Dispatches
  `BeginPlanning` (from `draft`), `BeginInitialization` (from `ready`), or
  `BeginExecution` (from `initializing`) based on the Mission's current
  state; any other state is refused with a typed `conflict` (409) rather
  than guessing. A future UI likely wants a narrower, state-aware "next
  action" affordance instead of one generic Start button — flagged as a
  design question, not resolved here.
- `stopMission` maps to `BlockMission` (a resumable halt) — there is no
  domain concept of an unresumable stop short of `cancelMission`.
- `requestMissionReview` maps to `BeginReview` and is made idempotent at
  the service layer (not the domain layer): if the Mission is already
  `reviewing`/`verifying`/`ready_for_decision`/`accepted`/`rejected`, the
  current projection is returned without dispatching a second command.
- `recordMissionReviewDecision` maps `"accept"` → `AcceptMission`,
  `"reject"` → `RejectMission`. An optional `expectedVersion` is checked
  against the loaded projection before dispatch and fails explicitly with
  `version_conflict` (409) on drift, in addition to the durable RPC's own
  optimistic-version check on the write path.

### Authorization model

Two trust paths, matching `/api/agent/*`:
- Cookie session (human): `EventActor.kind = "human"`, workspace is the
  caller's explicit `workspaceId` (ownership verified via
  `userOwnsProject`) or their active/default workspace
  (`resolveActiveOrDefaultProjectId`).
- Bearer token (agent/provider): `EventActor.kind = "agent"`, workspace is
  always the token's own bound `workspaceId` — never a client-supplied one.

`POST /api/missions/[missionId]/review/decision` resolves its principal
with `requireHuman: true`, which refuses any bearer-authenticated caller
before the service layer is ever reached (401/403, not silently downgraded
to read-only); `recordMissionReviewDecision` itself also re-checks
`principal.kind === "human"` defensively. Every other command additionally
passes through the existing `authorizeMissionCommand` seam
(`mission-authorization.ts`) inside `applyMissionCommand` — an
authenticated bearer/agent caller is still refused
(`unauthorized_command`) for Mission-level lifecycle commands unless it
also holds `mission_owner_or_administrator` via a registered `owner`
participant.

Tenant isolation: every operation loads the `missions` index row first and
refuses with `mission_not_found` (404) — never a 403, and never a
different error shape than "does not exist" — the instant the row's
`workspace_id` does not match the caller's resolved workspace. Confirmed by
the `cross-tenant Mission mutation refused` and `Mission not found does not
leak cross-tenant existence` tests.

### Typed error taxonomy

`MissionApiError.code` is one of: every `ApplyCommandError.code` from
`mission-commands.ts` (`mission_not_found`, `workspace_mismatch`,
`version_conflict`, `mission_terminal`, `unauthorized_command`,
`unauthorized_approval`, `unauthorized_plan_approval`, `invalid_transition`
and its per-entity variants, `evidence_*`, …) plus
`unauthenticated` (401), `workspace_not_resolved` (404),
`human_required` (403), `validation_error` (400),
`backend_not_configured` (503), and a generic `conflict` (409) used only by
`startMission`'s state-selection guard, which has no matching
`ApplyCommandError` of its own. `workspace_mismatch` and `mission_not_found`
both map to HTTP 404 with the same message shape by design.

### Read-model redaction

DTOs (`toSummary`, `toAssignments`, `toPlan`, `toEvidence`, `toExecutions`)
are explicit field allowlists over `MissionProjection`, not
`JSON.stringify(projection)`. Execution DTOs omit `leaseId`, `fencingToken`
(internal fencing), and `dispatchIntentId`/`dispatchKey` (scheduler
internals). Evidence DTOs expose only `source` (free text describing how
evidence was captured — the domain type itself has no raw-stdout/env/prompt
field to redact; see `MissionEvidenceRecord` in `mission-domain.ts`).
Timeline entries expose `type`/`actor`/`correlation`/`causation`/`version`/
a short derived `summary` string — never the raw event `payload`.

### Known limitations / not done

- `listMissions` paginates the `missions` index table by
  `(created_at, id)` cursor and then calls `getMission` per row (N+1
  reads) rather than a single joined query — acceptable at the `missions`
  table's expected size for now, flagged as a later optimization.
- No PATCH/DELETE on `/api/missions/[missionId]` — out of the requested
  surface.
- `startMission`'s state→command mapping is a judgment call (documented
  above), not a literal domain concept — worth revisiting once the
  dashboard's actual "start" UX is designed.
- This session did not verify the routes against a live Postgres instance
  (no `supabase`/`psql` available here, same constraint the Phase 5E audit
  already recorded) — verification is against `npm test`'s in-process
  fakes only, `npm run typecheck`, `npm run lint`, and `npm run build`.
  Live-database behavior of `apply_mission_command_atomic` (and the
  schema-version mismatch the 2026-07-25 audit flagged) remains whatever
  Codex's independent PostgreSQL verification finds — this layer calls the
  RPC through the existing `SupabaseMissionCommandPersistence`/
  `SupabaseMissionEventReader` unmodified, so it inherits, but does not
  independently confirm, that layer's live-database correctness.
- Did not touch: assignment-authority migrations, accepted-result-authority
  migrations, scheduler claim RPCs, result-acceptance RPCs, fencing logic,
  local Postgres harness, production scheduler polling, provider worker,
  provider-selection policy, deployment/runtime composition, or Phase 5E
  planning persistence, per this session's explicit boundary.

**Phase 3D production runtime is not marked complete by this work** — this
closes the application/API layer gap the 2026-07-25 audit identified; the
production runtime (scheduler, provider worker, deployment composition)
remains a separate, unstarted concern.

## Phase 3D Mission operations UI (this session)

Scope: the dashboard UI over the `/api/missions/*` application API committed
in the prior session (`03991b9`). No production runtime, migrations,
scheduler/RPC/fencing/provider-worker/deployment code touched — this is
purely a presentation layer over the existing API. Ran concurrently with
Codex's independent disposable-PostgreSQL verification of the assignment-
dispatch/execution-result authority boundary; this session never reads or
writes `mission_scheduler*`/`mission_execution_result*` tables or any SQL
migration, so there is no functional overlap, though both sessions touch
files under `src/lib/mission/*`.

### Integration audit (before editing)

- Navigation is a hardcoded array in `ProductShell.tsx` (no file-based
  routing registration) — added a `"Missions"` entry + command-palette
  entry there, plus a new `mission` glyph in `NavIcon`.
- Existing list/detail patterns: `runs/page.tsx` (plain server-component
  table query, no polling — a historical ledger) vs. `AgentWorkspaceClient.tsx`
  /`LiveRunsPanel.tsx` (client component seeded by server-rendered initial
  data, then self-polls via `setInterval`+`fetch`, no SWR/react-query
  anywhere in the repo). Missions needed the LIVE pattern (Mission state
  changes over the Mission's lifetime), so `LiveRunsPanel.tsx` was the
  template, not `runs/page.tsx`.
- Existing approval decisions: `ApprovalDecisionForm.tsx`
  (`/dashboard/approvals/[id]`) — pending/error state, approve/reject
  buttons, `router.refresh()` on success. That page itself uses inline
  `style={{}}`, not the `ol-*`/`WorkspaceUI` system — treated as legacy,
  not copied; `MissionReviewPanel.tsx` follows the pending/error shape but
  is built on `WorkspaceUI` primitives instead.
- Design system: two parallel systems exist — shadcn primitives at
  `src/components/ui/*` (Card/Badge/Tooltip/Separator only, no Tabs/Dialog/
  Table) and the bespoke `WorkspaceUI.tsx` (`Surface`/`PageHeader`/`Button`/
  `StatusLozenge`/`Section`/`Meta`/`WorkspaceEmpty`) that every real
  dashboard page actually uses. Built entirely on `WorkspaceUI.tsx` for
  consistency; the Mission command-center's tab strip is a small bespoke
  strip (no shadcn Tabs exists) and destructive confirmations reuse the
  existing `ProductConfirmDialog.tsx`, not a new dialog.
- UI test convention confirmed: **no jsdom, no `@testing-library/react`**
  anywhere in this repo. UI logic is unit-tested by extracting it into a
  pure module and testing that with `node:test` (precedent:
  `agent-dashboard-presenter.ts` / `agent-dashboard-presenter.test.ts`).
  Followed the same pattern here — see below.
- No prior Mission UI existed (`grep -r "Mission"` under
  `src/app/dashboard/**` / `src/components/product/**` returned nothing) —
  greenfield, no duplication to reconcile.

### New files

- `src/lib/mission/mission-ui-presenter.ts` — every derivation the UI
  needs, as pure functions: state→tone mapping, lifecycle-action
  availability (`availableLifecycleActions`, never inferred from provider/
  execution state — only from `MissionSummaryDto.state`), destructive-
  confirmation gating, review-decision-control gating
  (`canRenderReviewDecisionControls`, human-only), stale-review-conflict
  detection, evidence-provenance labeling (submitted/recorded/reviewed/
  accepted as four genuinely distinct labels), timeline event labeling and
  correlation grouping, typed-error-to-message mapping
  (`friendlyMissionErrorMessage`), Mission-creation validation, and three
  field-allowlist constants (`ASSIGNMENT_DISPLAY_FIELDS`/
  `EXECUTION_DISPLAY_FIELDS`/`EVIDENCE_DISPLAY_FIELDS`) asserted by tests so
  a future DTO field addition can't silently leak an internal identifier
  into the UI without the presenter (and its test) being touched first.
- `src/lib/mission/mission-principal.ts` — added
  `resolveMissionPrincipalForServerComponent` (additive; the existing
  `resolveMissionPrincipal(req, options)` export and its behavior are
  unchanged). Server components render Mission data by calling the
  application service functions directly (matching `runs/page.tsx`'s
  "query the source directly" convention) rather than fetching the app's
  own API route from the server, and those service functions take a
  `MissionPrincipal`, not a `NextRequest` — this factors the existing
  cookie/human resolution branch out so a server component can build one
  without a request object. This is the one "UI integration defect"
  exception exercised in this session; no other Mission application
  service contract was touched.
- `src/app/dashboard/missions/page.tsx` + `MissionListLive.tsx` — Mission
  list. Server component resolves the principal and calls `listMissions`
  directly for the first paint (loading/empty/error all handled: a caught
  `MissionApiError` renders a typed message, an empty result renders
  `WorkspaceEmpty`, otherwise the list renders). `MissionListLive` (client)
  polls `GET /api/missions` every 8s **only** while `shouldPollMissionList`
  says at least one visible Mission is non-terminal; the interval clears
  itself once every Mission on the page settles. "Load more" is a manual,
  cursor-paginated append that never re-fetches or reorders pages already
  shown. No raw `missionId` is displayed anywhere except as the (encoded)
  URL segment for navigation.
- `src/app/dashboard/missions/new/page.tsx` + `MissionCreateForm.tsx` —
  creation form. Fields: objective (→ `goal`), repository (required, since
  `CreateMission` requires it), optional repository id, and coordination
  mode (`RunMode` select — `solo`/`coordinated`/`assurance`/
  `collaborative`, the only mode values the domain defines). **No
  "constraints"/"planning preferences" fields** — `CreateMissionInput` has
  none, and the task said not to invent unsupported domain fields.
  `missionId` and `clientRequestId` are both minted once via `useRef` (not
  per submit), so a duplicate submit — double-click or a network retry —
  reuses the same idempotency key and replays the first attempt rather than
  creating a second Mission. Redirects to `/dashboard/missions/[missionId]`
  on success.
- `src/app/dashboard/missions/[missionId]/page.tsx` +
  `MissionCommandCenter.tsx` — the command center. Server component 404s
  (`notFound()`) on `mission_not_found`, otherwise renders the client
  command center seeded with the initial `MissionSummaryDto`. Tabs:
  Overview, Plan, Assignments, Executions, Timeline, Evidence, Review — a
  small bespoke tab strip (no shadcn `Tabs` primitive exists in this repo).
  Overview polls the Mission summary every 6s while `isMissionPollable`;
  every other tab lazily fetches its own data once, the first time it's
  opened, and again whenever a lifecycle/review action updates the Mission
  summary — never a continuous poll per tab.
- `src/components/product/MissionLifecycleControls.tsx` — renders only the
  actions `availableLifecycleActions(mission.state)` returns; destructive
  actions (`stop`, `cancel`) route through the existing
  `ProductConfirmDialog.tsx` first (`requiresConfirmation`); a pending
  action disables the whole control group so a second click can't fire a
  second request; the Mission summary is only replaced with the server's
  response body after a 2xx — a click is never treated as success before
  the API confirms it.
- `src/components/product/MissionReviewPanel.tsx` — human review. Renders
  usable accept/reject controls only when `canRenderReviewDecisionControls`
  says so (`principalKind === "human"` AND the Mission is in a reviewable
  state); `principalKind` is a prop resolved server-side by
  `resolveMissionPrincipalForServerComponent`, which only ever returns
  `"human"` for a dashboard page — there is no dashboard code path that
  could pass `"agent"` here, but the gate is still asserted in the
  component itself so it stays safe if ever reused elsewhere. Sends
  `expectedVersion: mission.version` with every decision; a
  `version_conflict` response (`isStaleReviewConflict`) renders a specific
  "this Mission changed since the page loaded" message, never a generic
  error. Copy explicitly states a decision is not proof of correctness.

### Evidence / review behavior

- Evidence provenance is reported from `MissionEvidenceRecord.lifecycle`
  ONLY (`captured`→"Submitted", `validated`/`attached`→"Recorded",
  `attested`→"Reviewed", `accepted`→"Accepted") — never derived from
  execution status. An execution reaching `completed` has no code path that
  changes any evidence label; the Evidence tab and Executions tab pull from
  two entirely separate DTOs (`MissionEvidenceDto` / `MissionExecutionDto`)
  with no cross-referencing beyond the execution's own `evidenceIds` list
  (a count, not a status).
- Review acceptance is displayed as "a human recorded a decision," with
  explicit copy that it is not proof of correctness (mirrors the
  `mission-application-service.ts` header's own framing).

### Polling behavior

- List: `GET /api/missions` every 8s while any visible Mission is
  non-terminal; stops once all are terminal.
- Detail overview: `GET /api/missions/[id]` every 6s while the Mission
  itself is non-terminal; stops on reaching a terminal state.
- Other detail tabs: fetch once per open + once after any mutating action
  succeeds; no interval.
- No `visibilitychange` handling — confirmed absent from every existing
  polling component in this repo (`LiveRunsPanel.tsx` et al.), so this
  matches the established convention rather than introducing new behavior
  unilaterally. Worth a follow-up across all polling components, not scoped
  to Missions alone.
- This is UI data refresh only — no production scheduler polling logic was
  added or touched, per the task boundary.

### Tests

`scripts/mission-ui-presenter.test.ts` — 30 tests against
`mission-ui-presenter.ts` (list states, creation validation, lifecycle
availability, destructive confirmation, typed refusal rendering, cross-
tenant message parity, timeline pagination + bounded metadata, evidence/
execution/assignment redaction allowlists, evidence approval distinction,
bearer-vs-human review controls, stale review conflict, active/terminal
Mission polling). Added to `package.json`'s `test` script. No component
rendering tests — this repo has no jsdom/RTL (see integration audit above);
every nontrivial UI decision was extracted into the presenter specifically
so it could be tested this way.

### Known limitations

- No visual/browser verification against a real signed-in session was
  possible in this environment (no Supabase test credentials available) —
  verified only that `npm run build`'s dev server starts clean and that
  `/dashboard/missions` correctly redirects an unauthenticated request to
  `/auth` with no server-side exception. Full click-through verification of
  the command center, lifecycle controls, and review flow against a real
  Mission remains undone.
- `MissionListLive`'s poll replaces only the first page's worth of Missions
  and appends anything already loaded via "Load more" that wasn't in the
  latest poll response — Missions that changed rank (e.g. a re-sort by
  `updated_at`) after the first page can end up duplicated or reordered
  relative to what "Load more" originally fetched. Acceptable for a first
  version; a stable merge-by-id-and-cursor-position would be a cleaner fix.
- No `visibilitychange`-based pause (see Polling behavior above) — matches
  existing convention, not a Mission-specific gap, but still means a
  backgrounded tab keeps polling.
- `availableLifecycleActions`'s state→action mapping is this session's own
  judgment call, layered on top of `startMission`'s already-documented
  judgment call from the API session — both should be revisited together
  once real Mission lifecycle usage data exists.
- Depends entirely on the Mission application API from `03991b9`, which
  itself was not verified against live Postgres in that session (no
  `supabase`/`psql` available). Nothing here independently confirms
  `apply_mission_command_atomic`'s live-database behavior — that remains
  whatever Codex's independent disposable-PostgreSQL verification finds.
- Did not touch: Mission migrations, scheduler claim RPCs, accepted-result
  RPCs, assignment authority, execution-result authority, fencing logic,
  database harnesses, production scheduler polling, provider worker,
  provider-selection policy, deployment/runtime composition, Phase 5E
  planning persistence, or the Mission application service's public
  contracts (the one additive `mission-principal.ts` export above is the
  sole exception, and it changes no existing signature or behavior).

**Phase 3D production is still not marked complete.** This closes the UI
gap over the already-committed application API; the production runtime
(scheduler, provider worker, deployment composition) and live-database
verification of the command/query boundary remain separate, unstarted (or
Codex-owned) concerns.

## Build plan Phase 6 — Mission verification + Passport projection (this session)

Scope: `docs/PRODUCT_REBUILD_PLAN.md`'s Phase 6 ("Verification, decision,
Passport projection"), applied narrowly. Deliberately did NOT attempt
Phase 5's originally-planned "merge the existing agent workspace into the
Mission detail view, split `AgentWorkspaceClient.tsx`, collapse nav to
Watchfloor · History · Rules" — that is a large, high-risk refactor of
~2,700 lines of working, load-bearing code, and doing it in the same pass
as new Phase 6 work would make both harder to verify independently. The
new standalone Mission UI (`d12316c`) remains the surface; whether it
should absorb the legacy workspace is a product decision, not something
resolved unilaterally here. Phase 7 (Voice) is explicitly marked
deferrable in the plan itself and was not touched.

### What Phase 6 turned out to need

The Mission domain already fully supports state-machine verification
(`BeginVerification`, `VerifyAssignment`) and a binary decision
(`AcceptMission`/`RejectMission`, wired end-to-end by the prior sessions).
What did NOT exist: a **reproducible Passport projection** — a read-model
that proves, from the Mission's own event log alone, what was approved,
what evidence exists, whether verification ran, and what was decided. That
is what this session built.

**Real domain gap found, NOT closed**: `mission-domain.ts`'s
`MissionDecision` type already defines five values —
`accept | reject | request_changes | continue_investigation | escalate` —
but `mission-command-handler.ts` only ever emits `mission.decision_recorded`
for `accept`/`reject` (`AcceptMission`/`RejectMission`). The other three
decision values exist in the type system with no command that can ever
produce them. Extending the decision surface to the full five values (per
the plan's "final decision surface: accept / reject / request changes /
continue investigation / escalate") requires new domain commands
(`RequestMissionChanges`/`ContinueMissionInvestigation`/`EscalateMission`
or similar) — a change to the Mission command union and its authorization
matrix, not a read-model or UI change. Left untouched: this session's scope
was additive reads only, and Codex is independently verifying the exact
live-command surface concurrently, so extending it here risked colliding
with that work. **This is the concrete, actionable remainder of Phase 6.**

### New files

- `src/lib/mission/mission-passport.ts` — `buildMissionPassport(projection,
  events, now?)`, pure and deterministic. Given the same event log twice,
  produces byte-identical output except `generatedAt` (asserted by test).
  Reports: objective/repository, final state, the actually-approved plan
  (by matching `approvedPlanVersion` against a real `MissionPlanProposal`,
  not just echoing the version number), assignment outcomes (status +
  required-vs-attached evidence counts), evidence entries (redacted to the
  same fields the Evidence tab already uses — kind/lifecycle/availability/
  digest/sourceRevision, never raw content), whether `BeginVerification`
  ever ran (from the event log, never inferred from provider state), the
  most recent `mission.decision_recorded` event if any, and an integrity
  block (`eventCount`, `lastEventId`, a SHA-256 digest over
  `(eventId, aggregateVersion, type)` tuples) so a caller can independently
  confirm which exact event stream a Passport was built from.
  `streamComplete`/`streamIntegrityIssues` are copied straight from the
  projection's own `complete`/`integrityIssues` fields — this module never
  re-decides trust independently of what `mission-projection.ts` already
  computed.
- `getMissionPassport` added to `mission-application-service.ts` (query
  only, same `loadProjection` seam every other read uses — no new store,
  so it structurally cannot drift from what the Timeline/Evidence/Plan tabs
  show for the same Mission).
- `GET /api/missions/[missionId]/passport` — same tenant-scoping and
  typed-error convention as every other Mission route.
- `PassportTab` added to `MissionCommandCenter.tsx` as an 8th tab. Fetches
  once per open (a Passport only changes when the event log changes, so
  continuous polling would be wasted traffic — matches the plan's
  UI-refresh conservatism). Shows verification/decision/approved-plan/
  assignment-outcome/evidence sections plus the integrity footer
  (event count, truncated stream digest, complete-history flag). Decision
  copy again states a recorded decision is not itself proof of correctness
  — same framing as `MissionReviewPanel.tsx`.
- `mission-ui-presenter.ts` gained `missionDecisionLabel`/
  `missionDecisionTone` (all five domain decision values get a distinct
  label/tone, even the three the domain can't yet emit — so the UI is
  ready the day the domain gap above is closed) and `shortDigest` (a
  12-char truncation convention for displaying SHA-256 hex digests without
  ever showing or needing the full 64 characters inline).

### Tests

- `scripts/mission-passport.test.ts` — 8 tests, driven against REAL event
  streams produced by `applyMissionCommand` (never hand-built fixture
  events): verification-ran detection, accept vs. reject distinction, no-
  decision/no-verification for an in-progress Mission, reproducibility
  (identical digest from the identical log run twice; different digest for
  a genuinely different log), approved-plan-matches-projection, evidence
  field redaction, and `streamComplete`/`streamIntegrityIssues` mirroring.
- `scripts/mission-ui-presenter.test.ts` — 3 new tests for the decision
  label/tone/digest helpers (30 → 33 tests in that file).
- `scripts/mission-application-service.test.ts` — 1 new static-source test
  confirming `getMissionPassport` reuses the shared `(projection, events)`
  pair rather than a separate store (17 → 18 tests in that file).
- Full suite: 1863/1863 passing (was 1850 before this session).

### Known limitations

- The three unreachable `MissionDecision` values (`request_changes`,
  `continue_investigation`, `escalate`) remain unreachable — see "Real
  domain gap found" above. The Passport and its UI already label and tone
  them correctly; nothing can currently produce one.
- No live-database verification of the `missions`/`mission_events` tables
  this Passport reads from was performed in this session — same
  constraint as every prior session (no `supabase`/`psql` available here).
  `buildMissionPassport` itself has no I/O and needs none to trust; the
  event log it's fed is only as trustworthy as `SupabaseMissionEventReader`
  and the underlying RPC, which remain Codex's independent-verification
  scope.
- Phase 5's originally-planned workspace merge and nav collapse remain
  undone (see Scope above) — a deliberate deferral, not an oversight.
- Phase 7 (Voice) untouched, per the plan's own "deferrable" marking.
- Did not touch: Mission migrations, scheduler claim RPCs, accepted-result
  RPCs, assignment authority, execution-result authority, fencing logic,
  database harnesses, production scheduler polling, provider worker,
  provider-selection policy, deployment/runtime composition, or Phase 5E
  planning persistence.

**Phase 3D production is still not marked complete**, and the build plan's
own release gate (cross-tenant proof against a live DB, the canonical
Claude-raises-finding → Codex-adopts → verification-reruns →
human-accepts-exact-SHA acceptance test) has not been run end-to-end
against the Mission stack. This session closes the concrete Passport-
projection gap in Phase 6; the decision-surface gap it surfaced, and
Phase 5's deferred workspace merge, are the next well-scoped pieces of
work, not "nothing left."

## Decision surface: request_changes / continue_investigation (this session)

Closes the "unreachable decision values" gap this same document flagged
earlier — `MissionDecision` already defined `request_changes` and
`continue_investigation`; no command could ever produce them. Scoped
per an explicit choice: route both through `reviewing`, never straight
to `executing`, and leave `escalate` unbuilt for a separate follow-up.

**Why `reviewing`, not `executing`.** The obvious target for "send this
back for rework" is `executing`, but `ready_for_decision -> executing` is
an explicitly, deliberately illegal transition — `mission-domain.test.ts`'s
`"undeclared transitions are refused"` test asserts it by name, with its
own guard test right below asserting *"a run cannot jump straight from
executing to a decision... guards the product rule that verification
precedes a human decision."* Routing through `reviewing` instead honors
that invariant exactly: rework has to pass back through review (and can
reach `executing` again from there, same as any other Mission) rather than
skipping the gate the invariant protects. Both existing tests still pass
unmodified — added a third test (`mission-command-handler.test.ts`) that
directly re-asserts `ready_for_decision -> executing` stays illegal after
this change, so a future edit can't silently reopen that path.

**`escalate` deliberately not built.** It has no analogous safe default —
"escalate" implies leaving `ready_for_decision` for some kind of
suspended/on-hold state, which is what `blocked` is for, but `blocked`
requires a `resumeTo` target and `ready_for_decision` has no active-state
predecessor recorded to resume into (the projection only tracks
`resumeTo` for interruptions from an active state, and `ready_for_decision`
isn't one). Building this properly means extending what the projection
records, not just adding a command — left as a named follow-up rather
than force-fit into this session's minimal scope.

**What changed:**
- `mission-state-machine.ts` — one new edge:
  `ready_for_decision: [..., "reviewing"]`. Nothing removed.
- `mission-commands.ts` — two new command variants,
  `RequestMissionChanges`/`ContinueMissionInvestigation`, each carrying a
  required `reason: StateReason` (same shape as `RejectMission`).
- `mission-command-handler.ts` — both target `"reviewing"`; both carry
  their `reason` onto the emitted events (`reasonOf`), same convention as
  every other reasoned transition; both push a
  `mission.decision_recorded` event alongside `mission.state_changed`, with
  `decision: "request_changes"`/`"continue_investigation"` — reusing the
  existing `MissionDecisionPayload` shape unchanged (`reviewedRevision:
  null` for both, matching `RejectMission`'s pattern).
- `mission-authorization.ts` — both gated identically to
  `AcceptMission`/`RejectMission`: `["human", "system",
  mission_owner_or_administrator"]`. Automatically covered by the existing
  "every row in the authority matrix is non-empty" test since
  `COMMAND_AUTHORITY_MATRIX` is a `Record<MissionCommandType, ...>` — a
  missing entry would have failed `npm run typecheck`, not just a test.
- `mission-application-service.ts` — `RecordReviewDecisionInput.decision`
  widened to accept the two new values; `recordMissionReviewDecision`
  dispatches the matching command. Still human-only (`requireHuman: true`
  at the route, `principal.kind !== "human"` re-checked in the service) —
  unchanged from accept/reject.
- `POST /api/missions/[missionId]/review/decision` — accepts the two new
  decision strings; refuses anything else (including `"escalate"`,
  explicitly, since no command exists for it yet) with a clear
  `validation_error` listing what's actually accepted.
- `MissionReviewPanel.tsx` — two new buttons ("Request changes",
  "Continue investigating") alongside Accept/Reject, gated by the same
  `canRenderReviewDecisionControls` human-only check, same stale-version-
  conflict handling, same "not proof of correctness" framing.

**Tests added:** 5 new — 3 in `mission-command-handler.test.ts` (both
commands' happy path including that the Mission can move forward to
`executing` again afterward, plus the explicit "still illegal" guard),
1 in `mission-authorization.test.ts` (an agent without the owner role is
refused for both, same as accept/reject), 1 in
`mission-application-service.test.ts` (service-layer dispatch lands in
`reviewing`, never `accepted`/`rejected`). Full suite: 1864 → 1869.

**Known limitation:** `escalate` remains unreachable, by design, until the
resume-target plumbing it needs is built. Nothing currently produces a
`mission.decision_recorded` event with `decision: "escalate"` — the
Passport/UI already label and tone that value correctly (built in the
Phase 6 session), so wiring the command later requires no UI change, only
the domain-side resume-target work described above.

## Agent collaboration bridge (this session)

Scope: closes the "agents are isolated one-shot workers" gap discussed
this session — the Agent Message Protocol (`PostMessage`/`OpenFinding`,
built since Phase 4A) has existed the whole time, but nothing ever
produced those commands FROM an agent's own output, and nothing ever fed
a participant's pending messages INTO the next agent's launch prompt.
This session builds both directions as pure, fully-tested translation —
deliberately NOT wired into live dispatch yet, since live dispatch itself
still has no production entrypoint (see the runtime-worker checkpoint
notes above) and the "accepted-result bridge" (turning a completed
execution into a real `RecordExecutionCompleted` call) is still open,
separate work Codex's checkpoint already flagged as remaining.

### New file: `mission-collaboration-bridge.ts`

- `parseCollaborationDirectives(summary)` — scans an agent's own
  (already-redacted) final output for a fenced ` ```oathlock-collaboration ```
  ` block containing a JSON array of directives, validates each entry
  independently. A malformed directive is dropped and reported in
  `parseErrors`; a malformed block never throws; an agent that emits
  nothing (the overwhelmingly common case) yields an empty, valid result.
  Deterministic parsing of an explicit format — not NLP guessing at
  free-text.
- `buildCollaborationCommands(...)` — turns each directive into REAL
  `PostMessage`/`OpenFinding` commands, verified against the actual
  `applyMissionCommand` handler in tests (not just typed correctly). Two
  directive kinds only, on purpose:
  - `"message"` → one `PostMessage` (`messageType: "information"`).
  - `"finding"` → a `PostMessage` (`messageType: "finding"`) followed by
    a real `OpenFinding` referencing that message's id as
    `originatingMessageId` — matching the domain's own requirement that a
    finding can never exist without the message that raised it. Skips
    `OpenFinding` entirely (posts only the message) when there's no real
    `assignmentId` to attach it to, rather than guessing one.
  - Every OTHER `MessageType` (`review_request`/`blocker`/
    `evidence_notice`/`approval_request`/`completion_notice`/
    `delegation_request`/`delegation_response`) requires its own validated
    structured payload (`mission-collaboration-protocol.ts`) that an
    agent's free-text output has no reliable way to produce correctly —
    explicitly left out rather than faked with a best-effort payload guess.
  - **Real domain behavior surfaced by testing against the actual
    handler, not assumed:** `DEFAULT_COMMUNICATION_POLICY.allowBroadcast`
    is `false` — a Mission-wide policy setting, separate from a
    participant's own `canBroadcast` permission. A `"broadcast"` directive
    is correctly refused by the real command handler unless that policy
    is explicitly turned on; the bridge does not, and should not, silently
    downgrade or bypass that refusal.
- `pendingMessagesFor(messages, participantId, since)` — every message
  addressed to a participant (directly or via broadcast), excluding their
  own, posted after an optional cutoff. **Honest limitation, stated
  directly in the code rather than assumed away:** there is no per-
  recipient delivery/read-tracking field anywhere in the Mission domain
  today (`MissionMessage` carries none) — "pending" here is time-based
  (typically the participant's own last dispatched execution's
  `startedAt`), never a claim about what an agent has actually "seen."
- `renderPendingMessagesForLaunch(pending, maxMessages)` — plain text for
  splicing into a launch grant, bounded so a chatty Mission can't blow out
  an agent's context window with unread backlog.
- `COLLABORATION_DIRECTIVE_INSTRUCTIONS` / `composeTaskWithCollaborationContext` —
  the exact contract text told to an agent, and the one place both
  adapters compose it into the task, so Codex and Claude Code are given
  identical instructions in an identical position rather than two
  hand-copied variants that could drift.

### Adapter wiring (real, not just library code)

- `ProviderAssignment` (`mission-provider-adapter.ts`) gained one optional
  field, `pendingMessagesContext?: string | null` — additive, defaults to
  absent, changes no existing behavior for a caller that doesn't set it.
- Both `mission-provider-adapter-codex.ts` and
  `mission-provider-adapter-claude-code.ts` now compose
  `COLLABORATION_DIRECTIVE_INSTRUCTIONS` (and `pendingMessagesContext`, if
  present) into the launch task — but ONLY when the dispatch has a real
  `participantId` (a genuine Mission participant to attribute a directive
  to). An ad hoc, non-Mission dispatch gets its plain goal, byte-identical
  to before this change.

### What this does NOT do yet (honest, not silently deferred)

- **Nothing calls `pendingMessagesContext` yet.** No code populates that
  field on a `ProviderAssignment` today — `RealExecutionHost.start`
  constructs assignments from `DispatchInstruction`, which has no message
  history to draw from. Wiring `pendingMessagesFor` in requires either
  extending `DispatchInstruction`/`executionConstraints` or having
  whatever calls `RealExecutionHost` fetch messages first — a real,
  separate piece of wiring, not done here.
- **Nothing calls `buildCollaborationCommands` on a real completed
  execution yet.** That requires the "accepted-result bridge" (parse a
  finished `ExecutionOutcome`'s `summary`, call this module, dispatch the
  resulting commands through the Mission's own durable command boundary)
  — explicitly still open, per Codex's runtime-worker checkpoint.
- **No delegation-approval loop.** An agent can post a
  `delegation_request` message (any active participant may `PostMessage`),
  but creating the actual child assignment still requires `human`,
  `system`, or the Mission owner (`CreateAssignment`/`AssignAssignment`'s
  authorization row, unchanged) — a deliberate safety boundary discussed
  this session, not loosened here. An automated approval loop (a
  `"system"`-actor process watching for delegation requests and
  auto-issuing `AssignAssignment` under some policy) is separate,
  unbuilt work.
- **None of this runs anywhere.** Same as everything else this session:
  real, tested, additive code with zero production caller yet, because
  Mission dispatch itself has no production entrypoint.

### Tests

`scripts/mission-collaboration-bridge.test.ts` — 17 tests: directive
parsing (well-formed, malformed JSON, malformed individual directives,
unclosed fences, the empty-output common case), command construction
verified against the REAL `applyMissionCommand` handler (message accepted,
finding's two-command sequence accepted with correct `originatingMessageId`
linkage, the broadcast-policy refusal, no-assignmentId skip, mint-call
independence across multiple directives), and the pending-messages/launch-
rendering pure functions. Full suite: 1869 → 1886.

## Delegation directives + provider-boundary length fix (same session, follow-up)

While checking `mission-command-handler.ts`'s `PostMessage` branch for the
bridge above, found something better than expected: **agent-to-agent
delegation with no human/system gate already exists**, fully built. A
`delegation_response` message with `structuredPayload.accepted === true`
ATOMICALLY creates a real child `MissionAssignment` in the SAME command —
no separate `CreateAssignment`/`AssignAssignment` call, and `PostMessage`
itself only requires `active_participant` authority. My earlier assumption
(recorded in this file's prior "Decision surface" section, and stated to
the human in conversation) that agent delegation always needs human/system
approval was **wrong** for this path specifically — it's only true if
delegation is attempted via `CreateAssignment`/`AssignAssignment` directly.
The domain's actual intended path for agent-initiated delegation is
`delegation_request` → `delegation_response`, and it needs no approval
loop at all.

- Added `DelegationRequestDirective`/`DelegationResponseDirective` to
  `mission-collaboration-bridge.ts` — `delegation_request` carries no
  structured payload at all (`mission-protocol-schema.ts`'s schema for it
  is empty) and `delegation_response` needs only
  `{accepted, childTitle?, childObjective?, allowedPaths?,
  prohibitedPaths?}` — both simple enough for an agent's own output to
  reliably produce, unlike the five richer-payload message types still
  excluded. Both recipients fields are required to be an explicit
  participant list, never `"broadcast"` — delegation targets someone
  specific.
- 4 new tests, including a genuine end-to-end proof: a `delegation_request`
  from one participant, accepted by another, produces a REAL second
  `MissionAssignment` (`parentAssignmentId`/`delegatorParticipantId`/
  `assigneeParticipantId` all correctly set) via the actual command
  handler — not asserted against a mock.
- **Real bug caught by running the full suite, not assumed fixed:**
  `COLLABORATION_DIRECTIVE_INSTRUCTIONS` initially made the launch task
  text exceed `resident-provider-adapters.ts`'s hard 1000-character
  `validateGrant` ceiling, breaking an EXISTING test
  (`mission-execution-event-ingestion.test.ts`) the moment a Mission
  dispatch tried to actually launch. Fixed two ways: trimmed the
  instructions text itself, and made `composeTaskWithCollaborationContext`
  defensively budget-aware — it drops pending-message context first, then
  the instructions entirely, rather than silently truncate mid-JSON or let
  the provider boundary throw. 3 new tests lock this in, including one
  that reproduces the original failure mode directly (a goal long enough
  that even goal+instructions alone would exceed the ceiling).

Full suite: 1886 → 1893.

## Bug audit (this session, follow-up)

Requested: find and fix real bugs across everything built this session, not
just the one already-fixed provider-task-length issue above. Ran a
skeptical, file-by-file review of every Mission API/service/UI/bridge file
against the actual, ground-truth domain core (`mission-commands.ts`,
`mission-command-handler.ts`, `mission-domain.ts`, `mission-state-machine.ts`,
`mission-authorization.ts`, `mission-communication-policy.ts`,
`mission-protocol-schema.ts`) — anywhere my code's assumption about the
domain disagreed with what the domain actually does is treated as my bug,
never the domain's.

- [x] **Provider launch-task length overflow** (`mission-collaboration-bridge.ts`) —
      fixed and verified in the prior session entry above; re-confirmed
      still fixed by this pass (3 tests, full suite green).
- [x] **`PAUSABLE_STATES` wrongly included `"initializing"`**
      (`mission-ui-presenter.ts`) — `PauseMission` targets `"paused"`, but
      `MISSION_TRANSITIONS.initializing` (`mission-state-machine.ts`) is
      `["executing","blocked","failed","cancelled"]` — no `"paused"` edge.
      The Mission command center offered a working-looking "Pause" button
      for an initializing Mission that would 409 every time it was
      clicked, directly contradicting `availableLifecycleActions`'s own
      doc comment ("never shows a control the API would refuse
      outright"). **Fixed**: removed `"initializing"` from
      `PAUSABLE_STATES`.
- [x] **`STOPPABLE_STATES` wrongly included `"needs_input"`**
      (`mission-ui-presenter.ts`) — `stopMission` maps to `BlockMission`
      (target `"blocked"`), but `MISSION_TRANSITIONS.needs_input` is
      `[...ACTIVE_MISSION_STATES, "cancelled", "failed"]`, and
      `ACTIVE_MISSION_STATES` never includes `"blocked"` — same class of
      bug, same silent-409 consequence. **Fixed**: removed
      `"needs_input"` from `STOPPABLE_STATES`.
- [x] **Regression coverage added, not just a point fix** — two new
      exhaustive tests in `mission-ui-presenter.test.ts` iterate every
      single `MissionState` and assert `availableLifecycleActions`'s
      pause/stop offering exactly matches what the REAL
      `validateTransition` (imported directly, not re-implemented) says
      is legal. This is deliberately NOT a second hand-maintained list of
      "which states should offer pause/stop" that could drift out of sync
      with the state machine the same way the original bug did — any
      future change to either `MISSION_TRANSITIONS` or the presenter's
      sets will be caught automatically by this cross-check, not require
      someone to remember to update both.
- [x] Reviewed and found correct (no bug): `mission-collaboration-bridge.ts`
      directive parsing/validation/command construction, delegation
      flows, `pendingMessagesFor`; `mission-passport.ts`'s field
      references against `MissionProjection`/`MissionEvent`;
      `mission-application-service.ts`'s tenant-isolation guard
      (`loadOwnedMissionRow`) applied consistently, all constructed
      `MissionCommand` literals matching real command shapes,
      `startCommandFor`'s state→command mapping all legal per the state
      machine, `recordMissionReviewDecision`'s human-only + version-conflict
      guards; `mission-application-errors.ts`/`mission-principal.ts`'s
      error taxonomy and tenant-safe principal resolution; every
      `/api/missions/**` route; all `Mission*.tsx` client components
      (polling gating, ref usage against stale closures, idempotency-key
      minting); both provider adapters' collaboration-context wiring.
      Full findings and per-file confidence: this pass's own review
      output (not persisted as a separate doc — the two real findings and
      their fixes above are the complete, actionable result of it).

Full suite: 1893 → 1895.
