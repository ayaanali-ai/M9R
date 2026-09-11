/**
 * Mission scheduler store — the durable persistence boundary for dispatch
 * leases (Phase 2D.1).
 * ----------------------------------------------------------------------------
 * `mission-scheduler.ts` defines what a lease transition MEANS: whether an
 * acquire/renew/release/revoke is legal, and what the resulting lease looks
 * like. This module defines where that decision is made SAFE against
 * multiple scheduler workers racing each other over a real database. It does
 * not redefine lease legality, candidate selection policy, retry
 * classification, or expiry semantics — every one of those still lives in
 * the pure functions this module imports and calls. What this module adds is
 * exactly the mechanical guarantee a database transaction is suited to
 * provide: atomic ownership, fencing, and tenant-scope verification across
 * concurrent callers.
 *
 * The uniqueness boundary a lease protects is `workspaceId + missionId +
 * dispatchKey`, never `missionId` alone — see `mission-scheduler.ts`'s
 * `DispatchKey` doc comment. This vertical slice uses one slot per Mission
 * (`DEFAULT_DISPATCH_KEY`); nothing here assumes that stays true.
 *
 * Two implementations, same split of responsibility as
 * `mission-store.ts`/`mission-store-supabase.ts` drew for the Mission
 * aggregate itself:
 *   - `InMemoryMissionSchedulerStore` — a rigorous reference implementation.
 *     Its atomicity is real, not simulated: every method here is fully
 *     synchronous internally (no `await` between reading a slot's state and
 *     committing its mutation), so two concurrent JS calls via
 *     `Promise.all` can never interleave mid-decision — the same argument
 *     `InMemoryMissionStore` rests on.
 *   - `SupabaseMissionSchedulerStore` — calls the atomic RPCs in
 *     `supabase/migrations/20260726010000_mission_dispatch_leases.sql`.
 *     Verified here only at the RPC-argument-shape level (a fake
 *     SupabaseClient); the actual row-lock behavior that makes concurrent
 *     claims safe has never executed against a real Postgres instance in
 *     this environment — see the migration file and IMPLEMENTATION_NOTES.md
 *     for what remains database-unverified.
 */

import type { MissionId, MissionState } from "./mission-domain";
import {
  acquireLease as acquireLeasePure,
  isFencingTokenCurrent as isFencingTokenCurrentPure,
  releaseLease as releaseLeasePure,
  renewLease as renewLeasePure,
  revokeLease as revokeLeasePure,
  type DispatchKey,
  type DispatchLease,
  type DispatchLeaseId,
  type LeaseHolder,
  type SchedulerPolicy,
} from "./mission-scheduler";

// ---------------------------------------------------------------------------
// Durable dispatch instruction (the scheduler's outbox row)
// ---------------------------------------------------------------------------

/**
 * What a successful claim commits FOR the Runtime to pick up later — durable
 * proof of "this slot was claimed, here is what to run," written in the SAME
 * transaction as the lease itself. This is the fix for "lease committed, then
 * the process crashes before Runtime receives the dispatch": the instruction
 * is not delivered over a queue, it is a row a restarted scheduler can find
 * again via `listOutstandingDispatchIntents`. No provider is called from
 * here — `adapterRequirement` and `executionConstraints` are opaque data the
 * (not-yet-built) Runtime will interpret.
 */
export interface DispatchInstruction {
  instructionId: string;
  missionId: MissionId;
  workspaceId: string;
  /** Immutable assignment linkage captured at claim time. Nullable only for legacy intents created before Phase 3D.0. */
  assignmentId?: string | null;
  repositoryId: string | null;
  dispatchKey: DispatchKey;
  /** Opaque to the scheduler — e.g. "codex" | "claude-code" | "browser-verifier". Not validated or dispatched here. */
  adapterRequirement: string | null;
  leaseId: DispatchLeaseId;
  fencingToken: number;
  /** How many times this slot has been claimed, including this claim. */
  attempt: number;
  executionConstraints: Record<string, unknown>;
  createdAt: string;
  deliveredAt: string | null;
  /**
   * Set once a LATER claim on the same slot supersedes this instruction — a
   * crashed worker's stale instruction must read as dead, not merely
   * "not yet delivered," once someone else has taken over the slot.
   */
  supersededAt: string | null;
  /**
   * Set by `attachProcessHandle` once a real `ProcessExecutionHost` (Phase
   * 3A, `mission-process-host.ts`) has actually launched something for this
   * instruction. Null immediately after a claim — the handle does not exist
   * until launch happens, which is necessarily a separate step from the
   * claim itself (the scheduler cannot know a process's identity before
   * that process exists). This is the field that makes Phase 3A's corrected
   * recovery possible: without a persisted handle, a restarted Runtime has
   * no way to ask "is the process I dispatched still alive?" and Phase
   * 2D.2's conservative always-revoke recovery is the best available
   * answer. `PersistableProcessHandle` itself is intentionally untyped
   * here (kept as `Record<string, unknown>` at this layer) to avoid a
   * circular import between the scheduler store and the process-host
   * module; `mission-process-recovery.ts` narrows it back to
   * `PersistableProcessHandle` where it's actually used.
   */
  processHandle: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// claimCandidates
// ---------------------------------------------------------------------------

export interface DispatchCandidateRequest {
  missionId: MissionId;
  workspaceId: string;
  /** When supplied, the store verifies it against the Mission's own genesis repositoryId; a mismatch refuses the claim. */
  repositoryId?: string | null;
  dispatchKey: DispatchKey;
  /**
   * The Mission state the caller observed when it decided (via
   * `selectDispatchCandidates`, pure) that this slot was eligible. The store
   * RE-VERIFIES membership in `dispatchableStates` as a defense against a
   * stale read, but does not decide policy: the whitelist itself is always
   * supplied by the caller, never hardcoded here.
   */
  missionState: MissionState;
  /** Required for all new production dispatches; null is retained only to read legacy intents. */
  assignmentId?: string | null;
  adapterRequirement?: string | null;
  executionConstraints?: Record<string, unknown>;
}

export interface ClaimCandidatesInput {
  candidates: DispatchCandidateRequest[];
  holder: LeaseHolder;
  now: string;
  policy: SchedulerPolicy;
  /** Caller-supplied whitelist — pass `DISPATCHABLE_MISSION_STATES` from mission-scheduler.ts. Never defined inside the store. */
  dispatchableStates: readonly MissionState[];
}

export type ClaimRefusalReason =
  | "not_dispatchable_state"
  | "already_leased"
  | "mission_not_found"
  | "workspace_mismatch"
  | "repository_mismatch";

export interface ClaimedCandidate {
  missionId: MissionId;
  dispatchKey: DispatchKey;
  lease: DispatchLease;
  instruction: DispatchInstruction;
}

export interface ClaimRefusal {
  missionId: MissionId;
  dispatchKey: DispatchKey;
  reason: ClaimRefusalReason;
}

export interface ClaimCandidatesResult {
  claimed: ClaimedCandidate[];
  refused: ClaimRefusal[];
}

// ---------------------------------------------------------------------------
// renew / release / revoke / validateFence
// ---------------------------------------------------------------------------

export type LeaseMutationRefusalReason =
  | "lease_not_found"
  | "stale_fencing_token"
  | "lease_not_held_by_caller"
  | "lease_already_terminal"
  | "lease_expired"
  | "renewal_outside_window";

export interface RenewDispatchLeaseInput {
  workspaceId: string;
  missionId: MissionId;
  dispatchKey: DispatchKey;
  /** Must match the CURRENT generation's leaseId — a superseded generation's id never matches. */
  leaseId: DispatchLeaseId;
  /** Must match the current fencing token exactly. This is fencing enforced at the mutation boundary, not merely available via `validateFence`. */
  fencingToken: number;
  holder: LeaseHolder;
  now: string;
  policy: SchedulerPolicy;
}

export type RenewDispatchLeaseResult = { ok: true; lease: DispatchLease } | { ok: false; reason: LeaseMutationRefusalReason };

export interface ReleaseDispatchLeaseInput {
  workspaceId: string;
  missionId: MissionId;
  dispatchKey: DispatchKey;
  leaseId: DispatchLeaseId;
  fencingToken: number;
  holder: LeaseHolder;
  now: string;
}

export type ReleaseDispatchLeaseResult = { ok: true; lease: DispatchLease } | { ok: false; reason: LeaseMutationRefusalReason };

export interface RevokeDispatchLeaseInput {
  workspaceId: string;
  missionId: MissionId;
  dispatchKey: DispatchKey;
  now: string;
  reason: string;
}

export type RevokeDispatchLeaseResult = { ok: true; lease: DispatchLease } | { ok: false; reason: LeaseMutationRefusalReason };

export interface ValidateFenceInput {
  workspaceId: string;
  missionId: MissionId;
  dispatchKey: DispatchKey;
  leaseId: DispatchLeaseId;
  fencingToken: number;
}

// ---------------------------------------------------------------------------
// The store boundary
// ---------------------------------------------------------------------------

export interface MissionSchedulerStore {
  claimCandidates(input: ClaimCandidatesInput): Promise<ClaimCandidatesResult>;
  renewLease(input: RenewDispatchLeaseInput): Promise<RenewDispatchLeaseResult>;
  releaseLease(input: ReleaseDispatchLeaseInput): Promise<ReleaseDispatchLeaseResult>;
  revokeLease(input: RevokeDispatchLeaseInput): Promise<RevokeDispatchLeaseResult>;
  /**
   * Read-only authoritative check: is this fencing token still current for
   * this slot? The mutation methods above already enforce fencing
   * themselves — this exists for a future write path (e.g. attaching
   * execution results) to check BEFORE doing its own work, without this
   * store needing to know anything about what that work is.
   */
  validateFence(input: ValidateFenceInput): Promise<boolean>;
  /** For scheduler-restart recovery: instructions no worker has yet been told about, and no later claim has superseded. */
  listOutstandingDispatchIntents(workspaceId: string): Promise<DispatchInstruction[]>;
  markDispatchIntentDelivered(instructionId: string, deliveredAt: string): Promise<void>;
  /**
   * Records what a real `ProcessExecutionHost.launch` actually produced,
   * against the instruction it was launched for. A no-op write (the same
   * caveats as `markDispatchIntentDelivered`: overwrite, not a
   * check-and-set — the caller already holds the lease that authorized the
   * launch, so nothing here needs its own fencing check) if the instruction
   * has since been superseded; the caller's next `listOutstandingDispatchIntents`
   * read will simply not include it. See `DispatchInstruction.processHandle`
   * for why this exists.
   */
  attachProcessHandle(instructionId: string, handle: Record<string, unknown>): Promise<void>;
}

// ---------------------------------------------------------------------------
// InMemoryMissionSchedulerStore — the rigorous reference implementation
// ---------------------------------------------------------------------------

export interface InMemoryMissionRecord {
  workspaceId: string;
  repositoryId: string | null;
}

function refusalFromPureError(code: string): LeaseMutationRefusalReason {
  switch (code) {
    case "lease_not_held_by_caller":
    case "lease_already_terminal":
    case "lease_expired":
    case "renewal_outside_window":
      return code;
    default:
      // Unreachable given the pure functions' actual error unions, but keeps this total.
      return "lease_not_found";
  }
}

/**
 * Reference implementation, backed by an in-process Map. Every public method
 * is synchronous internally end-to-end — no `await` appears between reading
 * a slot's current lease and writing its replacement — so two concurrent
 * calls raced via `Promise.all` genuinely cannot interleave mid-decision.
 * That is what makes the concurrency tests against this class a real proof
 * rather than an assumption, the same argument `InMemoryMissionStore`
 * documents for the Mission aggregate itself.
 *
 * The `missions` map stands in for what a real deployment verifies by
 * joining the `missions` table inside the atomic RPC — tenant-scope checks
 * here are not a shortcut, they are the same check, against an in-memory
 * substitute for the same source of truth.
 */
export class InMemoryMissionSchedulerStore implements MissionSchedulerStore {
  private readonly missions: Map<MissionId, InMemoryMissionRecord>;
  private readonly leases = new Map<string, DispatchLease>();
  private readonly intents = new Map<string, DispatchInstruction>();
  private readonly attempts = new Map<string, number>();
  private instructionSeq = 0;
  private mintLeaseId: () => string;

  constructor(missions: Map<MissionId, InMemoryMissionRecord>, mintLeaseId: () => string = () => crypto.randomUUID()) {
    this.missions = missions;
    this.mintLeaseId = mintLeaseId;
  }

  private slotKey(workspaceId: string, missionId: MissionId, dispatchKey: DispatchKey): string {
    return `${workspaceId}::${missionId}::${dispatchKey}`;
  }

  /**
   * One call is one transaction, matching the real RPC: an uncaught
   * exception partway through the candidate loop must leave NOTHING from
   * this call committed, not just the one candidate that triggered it. Real
   * Postgres gets this for free (the whole function body is one implicit
   * transaction); the in-memory reference has to earn it explicitly by
   * snapshotting and restoring on throw.
   */
  async claimCandidates(input: ClaimCandidatesInput): Promise<ClaimCandidatesResult> {
    const leasesSnapshot = new Map(this.leases);
    const intentsSnapshot = new Map([...this.intents].map(([id, intent]) => [id, { ...intent }]));
    const attemptsSnapshot = new Map(this.attempts);
    const instructionSeqSnapshot = this.instructionSeq;

    try {
      return this.claimCandidatesUnchecked(input);
    } catch (err) {
      this.leases.clear();
      for (const [k, v] of leasesSnapshot) this.leases.set(k, v);
      this.intents.clear();
      for (const [k, v] of intentsSnapshot) this.intents.set(k, v);
      this.attempts.clear();
      for (const [k, v] of attemptsSnapshot) this.attempts.set(k, v);
      this.instructionSeq = instructionSeqSnapshot;
      throw err;
    }
  }

  private claimCandidatesUnchecked(input: ClaimCandidatesInput): ClaimCandidatesResult {
    const claimed: ClaimedCandidate[] = [];
    const refused: ClaimRefusal[] = [];

    for (const candidate of input.candidates) {
      const key = this.slotKey(candidate.workspaceId, candidate.missionId, candidate.dispatchKey);

      const record = this.missions.get(candidate.missionId);
      if (!record) {
        refused.push({ missionId: candidate.missionId, dispatchKey: candidate.dispatchKey, reason: "mission_not_found" });
        continue;
      }
      if (record.workspaceId !== candidate.workspaceId) {
        refused.push({ missionId: candidate.missionId, dispatchKey: candidate.dispatchKey, reason: "workspace_mismatch" });
        continue;
      }
      if (candidate.repositoryId != null && record.repositoryId !== candidate.repositoryId) {
        refused.push({ missionId: candidate.missionId, dispatchKey: candidate.dispatchKey, reason: "repository_mismatch" });
        continue;
      }
      if (!input.dispatchableStates.includes(candidate.missionState)) {
        refused.push({ missionId: candidate.missionId, dispatchKey: candidate.dispatchKey, reason: "not_dispatchable_state" });
        continue;
      }

      const current = this.leases.get(key) ?? null;
      const result = acquireLeasePure({
        leaseId: this.mintLeaseId(),
        missionId: candidate.missionId,
        workspaceId: candidate.workspaceId,
        dispatchKey: candidate.dispatchKey,
        holder: input.holder,
        current,
        now: input.now,
        policy: input.policy,
      });

      if (!result.ok) {
        refused.push({ missionId: candidate.missionId, dispatchKey: candidate.dispatchKey, reason: "already_leased" });
        continue;
      }

      this.leases.set(key, result.lease);
      const attempt = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, attempt);

      // A crashed worker's outstanding instruction for this exact slot must
      // never be actioned once the slot has been reclaimed by someone else.
      for (const intent of this.intents.values()) {
        if (
          intent.workspaceId === candidate.workspaceId &&
          intent.missionId === candidate.missionId &&
          intent.dispatchKey === candidate.dispatchKey &&
          intent.supersededAt === null
        ) {
          intent.supersededAt = input.now;
        }
      }

      this.instructionSeq += 1;
      const instruction: DispatchInstruction = {
        instructionId: `intent-${this.instructionSeq}`,
        missionId: candidate.missionId,
        workspaceId: candidate.workspaceId,
        assignmentId: candidate.assignmentId ?? null,
        repositoryId: record.repositoryId,
        dispatchKey: candidate.dispatchKey,
        adapterRequirement: candidate.adapterRequirement ?? null,
        leaseId: result.lease.leaseId,
        fencingToken: result.lease.fencingToken,
        attempt,
        executionConstraints: candidate.executionConstraints ?? {},
        createdAt: input.now,
        deliveredAt: null,
        supersededAt: null,
        processHandle: null,
      };
      this.intents.set(instruction.instructionId, instruction);

      claimed.push({ missionId: candidate.missionId, dispatchKey: candidate.dispatchKey, lease: result.lease, instruction });
    }

    return { claimed, refused };
  }

  async renewLease(input: RenewDispatchLeaseInput): Promise<RenewDispatchLeaseResult> {
    const key = this.slotKey(input.workspaceId, input.missionId, input.dispatchKey);
    const current = this.leases.get(key);
    if (!current) return { ok: false, reason: "lease_not_found" };
    if (current.leaseId !== input.leaseId || current.fencingToken !== input.fencingToken) {
      // Either a different generation entirely, or the right generation but
      // a stale token within it (e.g. a renewal this same worker already
      // performed once, then retried after a dropped response). Either way,
      // this caller is not authoritative for the CURRENT fencing state.
      return { ok: false, reason: "stale_fencing_token" };
    }

    const result = renewLeasePure({ current, holder: input.holder, now: input.now, policy: input.policy });
    if (!result.ok) return { ok: false, reason: refusalFromPureError(result.error.code) };

    this.leases.set(key, result.lease);
    return { ok: true, lease: result.lease };
  }

  async releaseLease(input: ReleaseDispatchLeaseInput): Promise<ReleaseDispatchLeaseResult> {
    const key = this.slotKey(input.workspaceId, input.missionId, input.dispatchKey);
    const current = this.leases.get(key);
    if (!current) return { ok: false, reason: "lease_not_found" };
    if (current.leaseId !== input.leaseId || current.fencingToken !== input.fencingToken) {
      return { ok: false, reason: "stale_fencing_token" };
    }

    const result = releaseLeasePure({ current, holder: input.holder, now: input.now });
    if (!result.ok) return { ok: false, reason: refusalFromPureError(result.error.code) };

    this.leases.set(key, result.lease);
    return { ok: true, lease: result.lease };
  }

  /** Revocation is deliberately NOT fencing-checked: it's the scheduler/reconciler's override, exercised precisely when the current holder is unreachable or unknown. */
  async revokeLease(input: RevokeDispatchLeaseInput): Promise<RevokeDispatchLeaseResult> {
    const key = this.slotKey(input.workspaceId, input.missionId, input.dispatchKey);
    const current = this.leases.get(key);
    if (!current) return { ok: false, reason: "lease_not_found" };

    const result = revokeLeasePure({ current, now: input.now, reason: input.reason });
    if (!result.ok) return { ok: false, reason: refusalFromPureError(result.error.code) };

    this.leases.set(key, result.lease);
    return { ok: true, lease: result.lease };
  }

  async validateFence(input: ValidateFenceInput): Promise<boolean> {
    const key = this.slotKey(input.workspaceId, input.missionId, input.dispatchKey);
    const current = this.leases.get(key);
    if (!current) return false;
    return current.leaseId === input.leaseId && isFencingTokenCurrentPure(current, input.fencingToken);
  }

  async listOutstandingDispatchIntents(workspaceId: string): Promise<DispatchInstruction[]> {
    return [...this.intents.values()].filter(
      (intent) => intent.workspaceId === workspaceId && intent.deliveredAt === null && intent.supersededAt === null,
    );
  }

  async markDispatchIntentDelivered(instructionId: string, deliveredAt: string): Promise<void> {
    const intent = this.intents.get(instructionId);
    if (!intent) return;
    intent.deliveredAt = deliveredAt;
  }

  async attachProcessHandle(instructionId: string, handle: Record<string, unknown>): Promise<void> {
    const intent = this.intents.get(instructionId);
    if (!intent) return;
    intent.processHandle = handle;
  }
}
