/**
 * Crash-safe worker recovery — Phase 5D Priority 5.
 * ----------------------------------------------------------------------------
 * Per docs/PHASE_5D_TRANSACTION_BOUNDARIES.md, nothing between "lease claim"
 * and "lease release" is one real transaction: a crash can leave an
 * `InMemoryPlanningAttemptStore` record in any non-terminal state while the
 * lease, the diagnostic store, and the authoritative `PlanningRequestRecord`
 * have each independently advanced (or not) by different amounts.
 *
 * This module is a PURE classifier: given a snapshot of an attempt, its
 * lease, and the authoritative request/mission state, it answers "what is
 * safe to do next" without doing anything itself. The one guarantee this
 * file exists to make airtight: once a `providerRequestId` is known but no
 * `responseReceivedAt` was ever recorded, this classifier NEVER returns an
 * action that implies issuing another model call. That case
 * (`"unsafe_requires_new_attempt_decision"`) is a dead end for automation by
 * design — a human, or an explicit fresh worker attempt that consciously
 * accepts the risk of a possible duplicate call, must decide.
 *
 * WHAT `recoverPlanningAttempts` ACTUALLY DOES vs. just classifies:
 *  - `terminal_closed`, `skip_owned_by_live_worker`,
 *    `unsafe_requires_new_attempt_decision`, `requires_human_review`: no
 *    action taken. Classification only.
 *  - `retry_safe_no_external_call`: the runner marks the attempt as
 *    terminal (`stale`, via the attempt store's own fencing-token
 *    transition) so a fresh worker knows this attempt is abandoned and can
 *    re-claim the planning request from scratch. It does NOT itself
 *    re-invoke the model or re-issue a fresh attempt — that remains the next
 *    worker poll's job.
 *  - `rerun_deterministic_pipeline_only` and `replay_persistence_only`: the
 *    runner does NOT execute the deterministic pipeline or replay the
 *    result command itself (that requires the worker's parse/validate/
 *    simulate functions and model-response bytes, which this module does not
 *    have access to). It returns the classification only; a caller with
 *    those dependencies wired (the worker itself, on its next poll) is
 *    expected to act on it. This keeps the deliverable scoped to
 *    classification + the no-auto-retry guarantee, not full auto-execution.
 */

import type { PlanningAttemptOutcome, PlanningWorkerAttempt } from "./mission-planning-attempt-store";
import { InMemoryPlanningAttemptStore } from "./mission-planning-attempt-store";
import type { PlanningLease } from "./mission-planning-lease-store";
import { InMemoryPlanningLeaseStore } from "./mission-planning-lease-store";
import { isTerminalPlanningRequestStatus, type PlanningRequestRecord } from "./mission-domain";
import type { PlanningRequestPort } from "./mission-planning-request-port";
import {
  executeRerunDeterministicPipeline,
  executeReplayPersistence,
  type RecoveryExecutorDeps,
  type RecoveryExecutorInput,
  type RecoveryExecutorResult,
} from "./mission-planning-recovery-executor";

export type RecoveryAction =
  | "retry_safe_no_external_call"
  | "replay_persistence_only"
  | "rerun_deterministic_pipeline_only"
  | "unsafe_requires_new_attempt_decision"
  | "requires_human_review"
  | "terminal_closed"
  /**
   * The lease is live (not expired) and owned by a worker that has not been
   * declared dead. This is not a recovery case at all — it is just a normal
   * in-flight attempt. Recovery should only ever be invoked against attempts
   * whose lease is expired or whose owning worker is known-dead; this value
   * is a defensive short-circuit for the case where it gets called anyway.
   */
  | "skip_owned_by_live_worker";

export interface RequestSnapshotForRecovery {
  /** The authoritative `PlanningRequestRecord` as currently recorded, or null if the request cannot be found (treated as inconclusive -> requires_human_review). */
  request: PlanningRequestRecord | null;
  /** Whether the owning Mission itself is terminal — wins over every other rule. */
  missionTerminal: boolean;
}

export interface ClassifyRecoveryInput {
  attempt: PlanningWorkerAttempt;
  /** Null if the lease is expired/released/gone by the time recovery runs. */
  lease: PlanningLease | null;
  requestSnapshot: RequestSnapshotForRecovery;
  now: number;
}

function isLeaseLive(lease: PlanningLease | null, now: number): boolean {
  if (!lease) return false;
  if (lease.status !== "active") return false;
  return new Date(lease.expiresAt).getTime() > now;
}

/**
 * Precedence, applied strictly in this order (see file doc comment and
 * docs/PHASE_5D_TRANSACTION_BOUNDARIES.md for why order matters — later
 * rules assume earlier ones already ruled out the more severe cases):
 *
 *  1. Mission terminal -> terminal_closed. Wins over everything, including
 *     an attempt that otherwise looks mid-flight or ambiguous.
 *  2. Request snapshot missing, or already cancelled/superseded/stale/
 *     completed/failed in the authoritative source -> terminal_closed.
 *  3. Attempt already in a terminal local state -> terminal_closed.
 *  4. Lease is still live (not expired, active, owned by a worker not
 *     declared dead) -> skip_owned_by_live_worker. This is intentionally
 *     BEFORE the provider-request-id check: a live worker mid-invocation
 *     with a providerRequestId already attached is not a crash to recover
 *     from, it is normal operation, and must not be classified as
 *     ambiguous/unsafe.
 *  5. providerRequestId known, responseReceivedAt still null ->
 *     unsafe_requires_new_attempt_decision, ALWAYS (never overridden by
 *     anything below) — this is the "never duplicate a call" guarantee.
 *  6. responseReceivedAt set but no local result computed yet (state is
 *     response_received/parsing) -> rerun_deterministic_pipeline_only.
 *  7. Local result computed (state is validating/simulating/repairing/
 *     recording_result — i.e. past parsing, intent to record a result is
 *     underway) but authoritative status still shows outstanding
 *     (requested/in_progress) -> replay_persistence_only.
 *  8. attempt is `claimed` or `invoking` with no providerRequestId ->
 *     retry_safe_no_external_call (the model was never actually invoked;
 *     nothing to undo, nothing that could have duplicated).
 *  9. Otherwise, state doesn't cleanly match any rule -> requires_human_review.
 */
export function classifyRecoveryAction(input: ClassifyRecoveryInput): RecoveryAction {
  const { attempt, lease, requestSnapshot, now } = input;

  // (1) Mission terminal wins over everything.
  if (requestSnapshot.missionTerminal) return "terminal_closed";

  // (2) Authoritative request snapshot already terminal (or missing).
  const request = requestSnapshot.request;
  if (!request) return "requires_human_review";
  if (isTerminalPlanningRequestStatus(request.status)) return "terminal_closed";

  // (3) Attempt already terminal locally.
  if (isAttemptTerminal(attempt.state)) return "terminal_closed";

  // (4) Live lease short-circuit — not a recovery case.
  if (isLeaseLive(lease, now)) return "skip_owned_by_live_worker";

  // (5) Provider request id known, no response ever recorded — the
  // never-duplicate guarantee. This check runs before any state-based
  // branching below and is never overridden.
  if (attempt.providerRequestId !== null && attempt.responseReceivedAt === null) {
    return "unsafe_requires_new_attempt_decision";
  }

  // (6) Response received but not yet fully processed locally.
  if (attempt.responseReceivedAt !== null && (attempt.state === "response_received" || attempt.state === "parsing")) {
    return "rerun_deterministic_pipeline_only";
  }

  // (7) Local result pipeline underway/complete, but authoritative status
  // still shows the request outstanding — reload-fresh semantics are the
  // caller's responsibility (requestSnapshot must be re-fetched immediately
  // before this call); if it already flipped to terminal, rule (2) above
  // already caught it as terminal_closed.
  if (
    attempt.responseReceivedAt !== null &&
    (attempt.state === "validating" || attempt.state === "simulating" || attempt.state === "repairing" || attempt.state === "recording_result") &&
    (request.status === "requested" || request.status === "in_progress")
  ) {
    return "replay_persistence_only";
  }

  // (8) Never reached the model (whether still `claimed` or crashed
  // mid-`invoking` before a providerRequestId was ever attached) — no
  // external call was made, safe to let a fresh worker restart from scratch.
  if ((attempt.state === "claimed" || attempt.state === "invoking") && attempt.providerRequestId === null) {
    return "retry_safe_no_external_call";
  }

  // (9) Doesn't cleanly match — surface for a human rather than guess.
  return "requires_human_review";
}

function isAttemptTerminal(state: PlanningWorkerAttempt["state"]): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "stale" ||
    state === "superseded" ||
    state === "lease_lost" ||
    state === "outcome_unknown"
  );
}

export interface RecoveredAttemptResult {
  attempt: PlanningWorkerAttempt;
  action: RecoveryAction;
  /**
   * Only populated when `action` is `rerun_deterministic_pipeline_only` or
   * `replay_persistence_only` AND `executorDeps` was passed to
   * `recoverPlanningAttempts` (Phase 5E Task E). Every other action —
   * especially `unsafe_requires_new_attempt_decision`,
   * `requires_human_review`, `retry_safe_no_external_call`,
   * `terminal_closed`, and `skip_owned_by_live_worker` — is left as
   * classification-only: this field stays `undefined` for them, and neither
   * `executeRerunDeterministicPipeline` nor `executeReplayPersistence` is
   * ever called for them. See `scripts/mission-planning-recovery-executor.test.ts`'s
   * `outcome_unknown` guard test for the assertion that proves this.
   */
  executorResult?: RecoveryExecutorResult;
}

/**
 * Scans every non-terminal attempt in `attemptStore`, classifies it, and
 * for `retry_safe_no_external_call` only, marks the attempt `stale` (via
 * the attempt store's own fencing-checked `transition`) so it stops
 * appearing in future scans. Every other action is classification-only —
 * see the file's top doc comment for the exact scope. Never issues a model
 * call, never calls `requestPort.recordModelPlanningResult` itself.
 *
 * Idempotent: running this twice in a row against the same store state
 * produces identical classifications both times, and the second run causes
 * no additional mutation (the first run's `retry_safe_no_external_call`
 * attempts are already `stale`/terminal by the second run, so they are
 * excluded from `listNonTerminal()` and classified as `terminal_closed`
 * only if re-fed manually — in the normal scan path they simply no longer
 * appear).
 */
export async function recoverPlanningAttempts(
  attemptStore: InMemoryPlanningAttemptStore,
  leaseStore: InMemoryPlanningLeaseStore,
  requestPort: PlanningRequestPort,
  now: number,
  /**
   * Optional (Phase 5E Task E) — when provided, `rerun_deterministic_pipeline_only`
   * and `replay_persistence_only` classifications are additionally routed to
   * their matching executor. Omitted entirely, this function's behavior is
   * byte-identical to before Task E: classification only, no executor ever
   * called. This keeps every existing caller/test that doesn't pass
   * `executorDeps` unaffected.
   */
  executorDeps?: RecoveryExecutorDeps,
): Promise<RecoveredAttemptResult[]> {
  const results: RecoveredAttemptResult[] = [];
  const nowIso = new Date(now).toISOString();

  for (const attempt of attemptStore.listNonTerminal()) {
    const lease = leaseStore.peek(attempt.workspaceId, attempt.missionId, attempt.planningRequestId);
    const snapshot = await requestPort.loadSnapshot(attempt.workspaceId, attempt.missionId);
    const requestSnapshot: RequestSnapshotForRecovery = {
      request: snapshot?.planningRequests[attempt.planningRequestId] ?? null,
      missionTerminal: snapshot?.terminal ?? false,
    };

    const action = classifyRecoveryAction({ attempt, lease, requestSnapshot, now });

    if (action === "retry_safe_no_external_call") {
      const outcome: PlanningAttemptOutcome = "stale";
      attemptStore.transition(attempt.workerAttemptId, attempt.fencingToken, "stale", nowIso, {
        detail: "recovery: never invoked, safe to reclaim from scratch",
        outcome,
      });
      results.push({ attempt, action });
      continue;
    }

    // Every other action besides these two exact literals is left as
    // classification-only, on purpose — see this function's own doc comment
    // and `RecoveredAttemptResult.executorResult`'s doc comment. In
    // particular `unsafe_requires_new_attempt_decision` NEVER reaches this
    // branch: `classifyRecoveryAction` never returns it alongside these two
    // values for the same attempt (they are mutually exclusive outcomes of
    // one classification call).
    if (executorDeps && (action === "rerun_deterministic_pipeline_only" || action === "replay_persistence_only")) {
      const executorInput: RecoveryExecutorInput = { attempt, lease: lease ? { leaseId: lease.leaseId, fencingToken: lease.fencingToken } : null };
      const executorResult =
        action === "rerun_deterministic_pipeline_only"
          ? await executeRerunDeterministicPipeline(executorDeps, executorInput)
          : await executeReplayPersistence(executorDeps, executorInput);
      results.push({ attempt, action, executorResult });
      continue;
    }

    results.push({ attempt, action });
  }

  return results;
}
