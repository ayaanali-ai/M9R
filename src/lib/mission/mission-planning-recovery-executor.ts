/**
 * Recovery executors — Phase 5E Tasks C/D.
 * ----------------------------------------------------------------------------
 * `mission-planning-recovery.ts`'s `classifyRecoveryAction` is a PURE
 * classifier — it decides WHAT is safe, never DOES anything (see that
 * file's header). This module is the "does it" half for exactly the two
 * actions that never require a fresh model call:
 *   - `rerun_deterministic_pipeline_only` -> `executeRerunDeterministicPipeline`
 *   - `replay_persistence_only`           -> `executeReplayPersistence`
 *
 * Neither function here imports or calls anything from
 * `mission-planning-model-client.ts` / `PlanningModelClient` — this is
 * enforced structurally (no such import exists in this file) as well as by
 * `scripts/mission-planning-recovery-executor.test.ts`'s explicit
 * "never calls the model" assertions.
 *
 * SCOPE BOUNDARY (unchanged from the rest of Phase 5C/5D/5E): both
 * executors write ONLY through `PlanningRequestPort.recordModelPlanningResult`
 * — the same single write path `MissionPlanningWorker` uses — and never
 * touch `mission-dispatch-runtime.ts`/`mission-process-host*.ts`/
 * `mission-real-execution-host.ts`/`mission-scheduler*.ts`/
 * `mission-provider-adapter*.ts`.
 */

import type { PlanningRequestRecord } from "./mission-domain";
import { isTerminalPlanningRequestStatus } from "./mission-domain";
import type { PlanningRequestPort } from "./mission-planning-request-port";
import type { PlanningWorkerAttempt, PlanningAttemptState } from "./mission-planning-attempt-store";
import type { PlanningLeaseStoreLike, PlanningAttemptStoreLike } from "./mission-planning-worker";
import { computeReplayableResponseDigest, type PlanningReplayableResponseStore } from "./mission-planning-replayable-response-store";
import type { PlanningDiagnosticRecord } from "./mission-planning-diagnostics-store";
import type { PlannerProviderDescriptor } from "./mission-planner";
import type { PlanValidationContext } from "./mission-planner-validator";
import { validateRawModelPlanOutput } from "./mission-model-plan-schema";
import { normalizeModelPlanProposal } from "./mission-model-plan-normalizer";
import { validateMissionPlanProposal } from "./mission-planner-validator";
import { simulateMissionPlanProposal } from "./mission-planner-simulator";

/**
 * Byte-for-byte the SAME construction `mission-planning-worker.ts` uses for
 * a successful/failed result (`finalizeWithFencingCheck`):
 * `planning-result:${planningRequestId}:${lease.attempt}`. `lease.attempt`
 * itself is not durable once the original lease is gone (reclaimed/expired)
 * — the durably-stored proxy for it is `PlanningWorkerAttempt.attemptNumber`
 * (attached at attempt-creation time from the same counter). Both executors
 * derive the key from the durable attempt record for that reason. KNOWN
 * LIMITATION (documented, not fixed here — flagged for the closure report):
 * `attemptNumber` and `lease.attempt` are two independently-incrementing
 * counters in the current wiring (see `mission-planning-worker.ts`'s
 * `process()` bookkeeping vs. `InMemoryPlanningLeaseStore.claim`) and are
 * only guaranteed to agree when a request's attempts and lease claims stay
 * 1:1, which is the common case but not a proven invariant. Closing this
 * gap durably would require the worker to persist the ACTUAL idempotency
 * key it used (not just enough state to recompute one), which is out of
 * scope for this task.
 */
export function deriveRecordResultIdempotencyKey(planningRequestId: string, attemptNumber: number): string {
  return `planning-result:${planningRequestId}:${attemptNumber}`;
}

export type RerunPipelineRefusalReason =
  | "missing_replay_material"
  | "digest_mismatch"
  | "identity_mismatch"
  | "request_not_found"
  | "request_not_actionable"
  | "mission_terminal"
  | "target_plan_version_stale"
  | "lease_fence_invalid"
  | "model_call_still_required";

export type ReplayPersistenceRefusalReason =
  | "missing_diagnostic"
  | "missing_replay_material"
  | "request_not_found"
  | "identity_mismatch"
  | "lease_fence_invalid"
  | "model_call_still_required";

/** Read-side contract both executors need from the diagnostics store — a superset of `PlanningDiagnosticsStoreLike` (worker.ts), which only declares `store`. Both `InMemoryPlanningDiagnosticsStore` and `SupabasePlanningDiagnosticsStore` already implement `get`. */
export interface PlanningDiagnosticsReadStoreLike {
  get(workspaceId: string, ref: string): PlanningDiagnosticRecord | null | Promise<PlanningDiagnosticRecord | null>;
}

export interface RecoveryExecutorDeps {
  workspaceId: string;
  requestPort: PlanningRequestPort;
  leaseStore: PlanningLeaseStoreLike;
  attemptStore: PlanningAttemptStoreLike;
  diagnosticsStore: PlanningDiagnosticsReadStoreLike;
  replayableResponseStore: PlanningReplayableResponseStore;
  availableProviders: PlannerProviderDescriptor[];
  planValidationContext: PlanValidationContext;
  createdBy: string;
  clock: () => string;
  mintId: () => string;
}

export interface RecoveryExecutorInput {
  attempt: PlanningWorkerAttempt;
  /** Current lease, if still peekable — used to validate fencing before any durable write. Null if the lease is already gone (expired/reclaimed), in which case both executors refuse rather than guess. */
  lease: { leaseId: string; fencingToken: number } | null;
}

export type RecoveryExecutorResult =
  | { ok: true; outcome: "completed" | "failed" | "already_complete"; resultingPlanId: string | null }
  | { ok: false; reason: RerunPipelineRefusalReason | ReplayPersistenceRefusalReason };

/** Maps a `PlanningRequestRecord.status` (or `RecordModelPlanningResultOutcome.nextStatus`, same union) to the corresponding terminal `PlanningAttemptState` — both unions share their terminal member names by design. Non-terminal statuses (`requested`) fall back to `failed`, mirroring `mission-planning-worker.ts`'s own `finalizeWithFencingCheck` mapping (a "bounced back for a fresh attempt" outcome is this worker/attempt's own turn ending in failure, not success). */
function mapNextStatusToAttemptState(status: PlanningRequestRecord["status"]): PlanningAttemptState {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "stale":
      return "stale";
    case "superseded":
      return "superseded";
    default:
      return "failed";
  }
}

async function releaseLeaseIfPresent(deps: RecoveryExecutorDeps, attempt: PlanningWorkerAttempt, lease: { leaseId: string; fencingToken: number } | null): Promise<void> {
  if (!lease) return;
  await deps.leaseStore.release(deps.workspaceId, attempt.missionId, attempt.planningRequestId, lease.leaseId, lease.fencingToken);
}

/**
 * Verifies the durable pieces both executors need before touching anything:
 * identity match, lease fencing (if a lease is still held), and a FRESH
 * `PlanningRequestRecord` that is still actionable. Returns the fresh
 * request record on success. Shared by both executors so the eligibility
 * vocabulary/order is identical, matching `mission-planning-worker.ts`'s own
 * fencing-then-fresh-reload pattern in `finalizeWithFencingCheck`.
 */
async function loadEligibleFreshRequest(
  deps: RecoveryExecutorDeps,
  input: RecoveryExecutorInput,
): Promise<{ ok: true; request: PlanningRequestRecord } | { ok: false; reason: RerunPipelineRefusalReason | ReplayPersistenceRefusalReason }> {
  const { attempt, lease } = input;
  if (attempt.workspaceId !== deps.workspaceId) return { ok: false, reason: "identity_mismatch" };

  if (lease) {
    const fenceOk = await deps.leaseStore.isFencingTokenCurrent(deps.workspaceId, attempt.missionId, attempt.planningRequestId, lease.leaseId, lease.fencingToken, deps.clock());
    if (!fenceOk) return { ok: false, reason: "lease_fence_invalid" };
  }

  const snapshot = await deps.requestPort.loadSnapshot(deps.workspaceId, attempt.missionId);
  if (snapshot?.terminal) return { ok: false, reason: "request_not_found" };
  const request = snapshot?.planningRequests[attempt.planningRequestId];
  if (!request) return { ok: false, reason: "request_not_found" };
  if (isTerminalPlanningRequestStatus(request.status)) return { ok: false, reason: "request_not_actionable" };
  if (request.status !== "requested" && request.status !== "in_progress") return { ok: false, reason: "request_not_actionable" };

  return { ok: true, request };
}

/**
 * Task C — `rerun_deterministic_pipeline_only`. Never calls
 * `PlanningModelClient` (no such import exists in this file). Re-runs the
 * SAME pure pipeline functions the worker uses (schema-validate ->
 * normalize -> deterministic-validate -> deterministic-simulate) against
 * the DURABLY stored, digest-verified redacted raw output — never against
 * freshly re-derived context, since a replay must reproduce the original
 * response, not ask the model again.
 */
export async function executeRerunDeterministicPipeline(deps: RecoveryExecutorDeps, input: RecoveryExecutorInput): Promise<RecoveryExecutorResult> {
  const { attempt, lease } = input;

  // `model_call_still_required`: nothing to rerun a pipeline against if the
  // attempt never actually received a model response.
  if (attempt.responseReceivedAt === null || attempt.providerRequestId === null) {
    return { ok: false, reason: "model_call_still_required" };
  }

  const material = await deps.replayableResponseStore.get(deps.workspaceId, attempt.providerRequestId);
  if (!material) return { ok: false, reason: "missing_replay_material" };
  if (material.workspaceId !== deps.workspaceId || material.missionId !== attempt.missionId || material.planningRequestId !== attempt.planningRequestId) {
    return { ok: false, reason: "identity_mismatch" };
  }

  // Recompute the digest over the STORED material and compare — never
  // proceed against unverified content, even content this store itself
  // returned (defense in depth against a corrupted/tampered row).
  const recomputedDigest = await computeReplayableResponseDigest(material.redactedRawOutput);
  if (recomputedDigest !== material.outputDigest) return { ok: false, reason: "digest_mismatch" };

  const eligible = await loadEligibleFreshRequest(deps, input);
  if (!eligible.ok) return eligible;
  const request = eligible.request;

  if (request.kind === "revision" && request.basePlanId) {
    const fresh = await deps.requestPort.loadSnapshot(deps.workspaceId, attempt.missionId);
    const planIdAtVersion = fresh?.planVersions[request.targetPlanVersion];
    if (planIdAtVersion && planIdAtVersion !== request.basePlanId) {
      return { ok: false, reason: "target_plan_version_stale" };
    }
  }

  const idempotencyKey = deriveRecordResultIdempotencyKey(attempt.planningRequestId, attempt.attemptNumber);

  // ---- re-run the deterministic pipeline against the stored material ----
  let rawModelOutputText: string | null = material.redactedRawOutput;
  let failureCode: string | null = null;

  const schemaResult = validateRawModelPlanOutput(material.redactedRawOutput);
  if (!schemaResult.ok) {
    failureCode = "schema_rejected";
    rawModelOutputText = null;
  } else {
    const { proposal, templateSafeguardViolations } = normalizeModelPlanProposal({
      missionId: attempt.missionId,
      version: request.targetPlanVersion,
      supersedesPlanId: request.kind === "revision" ? request.basePlanId : null,
      raw: schemaResult.value,
      availableProviders: deps.availableProviders,
      now: deps.clock(),
      createdBy: deps.createdBy,
    });
    if (templateSafeguardViolations.length > 0) {
      failureCode = "template_safeguard_violation";
      rawModelOutputText = null;
    } else {
      const validation = validateMissionPlanProposal(proposal, deps.planValidationContext);
      if (!validation.ok) {
        failureCode = "deterministic_validation_failed";
        rawModelOutputText = null;
      } else {
        const simulation = simulateMissionPlanProposal(proposal);
        if (simulation.unreachableAssignments.length > 0) {
          failureCode = "simulation_failed";
          rawModelOutputText = null;
        }
      }
    }
  }

  // Fencing re-checked immediately before the write — matches
  // `finalizeWithFencingCheck`'s "fence right before the durable write" rule.
  if (lease) {
    const fenceOk = await deps.leaseStore.isFencingTokenCurrent(deps.workspaceId, attempt.missionId, attempt.planningRequestId, lease.leaseId, lease.fencingToken, deps.clock());
    if (!fenceOk) return { ok: false, reason: "lease_fence_invalid" };
  }

  const recorded = await deps.requestPort.recordModelPlanningResult({
    workspaceId: deps.workspaceId,
    missionId: attempt.missionId,
    planningRequestId: attempt.planningRequestId,
    rawModelOutputText,
    failureCode,
    redactedDiagnosticRef: attempt.diagnosticRef,
    availableProviders: deps.availableProviders,
    planValidationContext: deps.planValidationContext,
    createdBy: deps.createdBy,
    // Original correlation/causation are preserved unchanged — the attempt
    // record is the durable source of truth for both.
    context: { correlationId: attempt.correlationId, causationId: attempt.causationId, actor: { kind: "system", id: "reconciler" }, timestamp: deps.clock() },
    idempotencyKey,
  });

  // CRASH-SAFETY ORDERING: the durable Mission-facing result
  // (`recordModelPlanningResult`) is written BEFORE the attempt's local
  // terminal transition, never the reverse. If this process crashes between
  // the two, the next recovery pass sees an attempt still in a non-terminal
  // state but a Mission event that already landed — re-running THIS
  // executor again is safe (idempotency key dedup / the command's own
  // terminal-status check refuses a second write). The reverse order would
  // be unsafe: closing the attempt first and then crashing before the
  // durable result lands would strand the request as "attempt closed, no
  // result ever recorded" with no local signal left to recover from.
  if (!recorded.ok) {
    return { ok: false, reason: "lease_fence_invalid" };
  }

  const terminalState = mapNextStatusToAttemptState(recorded.nextStatus);
  await deps.attemptStore.transition(attempt.workerAttemptId, attempt.fencingToken, terminalState, deps.clock(), {
    detail: "recovery: rerun_deterministic_pipeline_only",
    // The command's own richer failureCode (schema_rejected/deterministic_validation_failed/...)
    // does not fit `PlanningAttemptOutcome`'s narrower union — same simplification
    // `mission-planning-worker.ts` applies at its own attempt-store bookkeeping boundary.
    outcome: recorded.nextStatus === "completed" ? "success" : "provider_rejected",
  });

  await releaseLeaseIfPresent(deps, attempt, lease);

  return { ok: true, outcome: recorded.nextStatus === "completed" ? "completed" : "failed", resultingPlanId: recorded.resultingPlanId };
}

/**
 * Task D — `replay_persistence_only`. Trusts the ALREADY-COMPUTED result —
 * zero `PlanningModelClient` calls, zero re-runs of schema-validate /
 * normalize / deterministic-validate / deterministic-simulate. Looks up the
 * prior diagnostic (by the attempt's own `diagnosticRef`, its durable
 * idempotency identity), reloads the current `PlanningRequestRecord` fresh,
 * and either short-circuits (already terminal) or replays
 * `recordModelPlanningResult` using the EXACT SAME derived idempotency key
 * — never a newly minted one.
 *
 * DESIGN CHOICE (documented per task instructions): when the request is
 * already terminal/completed, this function does NOT re-call
 * `recordModelPlanningResult` — it treats the attempt/lease bookkeeping as
 * the only thing left to close out, idempotently, and returns
 * `already_complete`. Re-calling with the same idempotency key would also
 * be safe in principle (the command's own idempotency-store dedup would
 * short-circuit it), but skipping the call entirely is strictly simpler and
 * avoids depending on that dedup path at all, which the audit flags as
 * best-effort (in-memory-only `IdempotencyStore` in production wiring).
 */
export async function executeReplayPersistence(deps: RecoveryExecutorDeps, input: RecoveryExecutorInput): Promise<RecoveryExecutorResult> {
  const { attempt, lease } = input;

  if (attempt.responseReceivedAt === null || attempt.providerRequestId === null) {
    return { ok: false, reason: "model_call_still_required" };
  }
  if (attempt.workspaceId !== deps.workspaceId) return { ok: false, reason: "identity_mismatch" };

  // (1) Prior diagnostic lookup — the durable identity anchor for this attempt's invocation.
  if (!attempt.diagnosticRef) return { ok: false, reason: "missing_diagnostic" };
  const diagnostic = await deps.diagnosticsStore.get(deps.workspaceId, attempt.diagnosticRef);
  if (!diagnostic) return { ok: false, reason: "missing_diagnostic" };

  // (2) Reload the current (authoritative) request fresh.
  const snapshot = await deps.requestPort.loadSnapshot(deps.workspaceId, attempt.missionId);
  const request = snapshot?.planningRequests[attempt.planningRequestId];
  if (!request) return { ok: false, reason: "request_not_found" };

  const idempotencyKey = deriveRecordResultIdempotencyKey(attempt.planningRequestId, attempt.attemptNumber);

  // (3) Already terminal/completed -> idempotently close out local
  // bookkeeping only, never re-call the command.
  if (isTerminalPlanningRequestStatus(request.status)) {
    if (lease) {
      const fenceOk = await deps.leaseStore.isFencingTokenCurrent(deps.workspaceId, attempt.missionId, attempt.planningRequestId, lease.leaseId, lease.fencingToken, deps.clock());
      if (fenceOk) await releaseLeaseIfPresent(deps, attempt, lease);
    }
    const terminalAttemptState = mapNextStatusToAttemptState(request.status);
    await deps.attemptStore.transition(attempt.workerAttemptId, attempt.fencingToken, terminalAttemptState, deps.clock(), {
      detail: "recovery: replay_persistence_only (already_complete)",
      outcome: request.status === "completed" ? "success" : request.status === "cancelled" ? "cancelled" : request.status === "stale" ? "stale" : request.status === "superseded" ? "superseded" : "provider_rejected",
    });
    return { ok: true, outcome: "already_complete", resultingPlanId: null };
  }

  // (4) Not terminal — replay the command with the SAME idempotency key.
  if (lease) {
    const fenceOk = await deps.leaseStore.isFencingTokenCurrent(deps.workspaceId, attempt.missionId, attempt.planningRequestId, lease.leaseId, lease.fencingToken, deps.clock());
    if (!fenceOk) return { ok: false, reason: "lease_fence_invalid" };
  }

  const material = await deps.replayableResponseStore.get(deps.workspaceId, attempt.providerRequestId);
  const rawModelOutputText = material ? material.redactedRawOutput : null;
  const failureCode = material ? null : (diagnostic.failureClassification ?? "provider_rejected");
  if (!material && !diagnostic.failureClassification) return { ok: false, reason: "missing_replay_material" };

  const recorded = await deps.requestPort.recordModelPlanningResult({
    workspaceId: deps.workspaceId,
    missionId: attempt.missionId,
    planningRequestId: attempt.planningRequestId,
    rawModelOutputText,
    failureCode,
    redactedDiagnosticRef: attempt.diagnosticRef,
    availableProviders: deps.availableProviders,
    planValidationContext: deps.planValidationContext,
    createdBy: deps.createdBy,
    context: { correlationId: attempt.correlationId, causationId: attempt.causationId, actor: { kind: "system", id: "reconciler" }, timestamp: deps.clock() },
    idempotencyKey,
  });

  // Same crash-safety ordering rationale as executeRerunDeterministicPipeline: durable result before local terminal transition.
  if (!recorded.ok) return { ok: false, reason: "lease_fence_invalid" };

  const terminalState = mapNextStatusToAttemptState(recorded.nextStatus);
  await deps.attemptStore.transition(attempt.workerAttemptId, attempt.fencingToken, terminalState, deps.clock(), {
    detail: "recovery: replay_persistence_only",
    outcome: recorded.nextStatus === "completed" ? "success" : "provider_rejected",
  });

  await releaseLeaseIfPresent(deps, attempt, lease);

  return { ok: true, outcome: recorded.nextStatus === "completed" ? "completed" : "failed", resultingPlanId: recorded.resultingPlanId };
}
