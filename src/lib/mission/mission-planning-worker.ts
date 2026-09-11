/**
 * MissionPlanningWorker — Phase 5C §4/§5/§6/§7/§10/§11/§12/§13/§15.
 * ----------------------------------------------------------------------------
 * The composition root for the provider-neutral planning-worker runtime.
 * Consumes durable `PlanningRequestRecord`s (Phase 5B), invokes a configured
 * `PlanningModelClient` OUTSIDE any Mission command transaction, records
 * bounded redacted diagnostics, and submits results back ONLY through
 * `PlanningRequestPort.recordModelPlanningResult` (which itself only ever
 * calls Phase 5B's `RecordModelPlanningResult` command). It never appends a
 * Mission event directly and structurally cannot call any execution command
 * — `PlanningRequestPort` has no method that could construct one.
 *
 * ---- Worker lifecycle states (distinct from PlanningRequestStatus and Plan status) ----
 * claimed             durable-adjacent (lease acquired) | not yet retryable
 * invoking            local-only, blocked-from-fresh-model-invocation (one is in flight)
 * response_received   local-only, terminal-for-this-network-call
 * parsing             local-only
 * validating          local-only
 * simulating          local-only
 * repairing           local-only, repair-eligible (bounded, max 1 by default)
 * recording_result    local-only — the one moment a Mission command is issued
 * completed           terminal, durable via the Mission event it produced
 * failed              terminal, durable via the Mission event it produced
 * cancelled            terminal, durable via the Mission event it produced
 * stale               terminal, durable via the Mission event it produced
 * lease_lost          terminal-for-this-attempt, fresh-attempt-eligible (a new worker may claim the request again)
 * outcome_unknown     terminal-for-this-attempt, NEVER auto-duplicates the model call — needs an explicit new attempt
 *
 * Lifecycle: claim -> acquire lease -> load PlanningRequestRecord -> verify
 * still eligible -> rebuild+hash deterministic context -> compare hash to
 * recorded contextHash (reject/stale on mismatch) -> invoke
 * PlanningModelClient -> capture bounded diagnostics -> schema-validate ->
 * normalize -> deterministic validate -> deterministic simulate -> optional
 * bounded repair (max 1) -> RecordModelPlanningResult -> close lease ->
 * persist terminal diagnostics.
 */

import type { PlanningRequestRecord } from "./mission-domain";
import type { PlanningRequestPort } from "./mission-planning-request-port";
import type { ClaimPlanningLeaseInput } from "./mission-planning-lease-store";
import type { PlanningModelRegistry } from "./mission-planning-model-registry";
import type { PlanningDiagnosticInput, DiagnosticStage } from "./mission-planning-diagnostics-store";
import type { GenerateStructuredPlanInput, PlanningModelInvocationResult } from "./mission-planning-model-client";
import { buildPlanningContext, type PlanningContextInput } from "./mission-planning-context";
import { validateRawModelPlanOutput, MODEL_PLAN_OUTPUT_SCHEMA_VERSION, PLANNING_MODEL_PLAN_SCHEMA_VERSION } from "./mission-model-plan-schema";
import { normalizeModelPlanProposal } from "./mission-model-plan-normalizer";
import { validateMissionPlanProposal, type PlanValidationContext } from "./mission-planner-validator";
import { simulateMissionPlanProposal } from "./mission-planner-simulator";
import type { PlannerProviderDescriptor } from "./mission-planner";
import { InMemoryPlanningAttemptStore, type CreateAttemptInput, type PlanningAttemptKind, type PlanningAttemptState } from "./mission-planning-attempt-store";
import { redactForDiagnostics } from "./mission-planning-redaction";
import {
  InMemoryPlanningReplayableResponseStore,
  computeReplayableResponseDigest,
  type PlanningReplayableResponseStore,
  type StoreReplayableResponseResult,
} from "./mission-planning-replayable-response-store";

/**
 * Structural (not nominal) collaborator contracts — deliberately looser than
 * `InMemoryPlanningLeaseStore`/`InMemoryPlanningAttemptStore`/
 * `InMemoryPlanningDiagnosticsStore`'s own concrete types, so a durable
 * Supabase-backed adapter (necessarily async — every call is a network round
 * trip, with a richer/more specific refusal-reason union than the in-memory
 * store's — see `mission-planning-lease-store-supabase.ts` /
 * `mission-planning-attempt-store-supabase.ts`) can be swapped in without
 * this file caring which one it holds. Every method return type is
 * `X | Promise<X>` for that reason, and every result/lease/attempt shape
 * below is deliberately a MINIMAL structural pick of only the fields this
 * file actually reads (never `.status`, never the full record) — this is
 * what lets both the narrower in-memory result types and the Supabase
 * adapters' richer, differently-shaped result types satisfy the same
 * interface. Every call site below `await`s the result unconditionally: the
 * in-memory stores' real (synchronous) return values and a durable
 * adapter's real (`Promise`) return values are both valid to `await`. This
 * is what makes `mission-planning-worker-production.ts`'s Supabase-backed
 * composition possible without forking this file's control flow or
 * changing behavior for existing in-memory-backed callers.
 */
export interface PlanningLeaseStoreLike {
  claim(
    input: ClaimPlanningLeaseInput,
  ): MaybePromise<{ ok: true; lease: { leaseId: string; fencingToken: number; ownerId: string; attempt: number } } | { ok: false; reason: string; heldBy?: string; expiresAt?: string }>;
  release(workspaceId: string, missionId: string, planningRequestId: string, leaseId: string, fencingToken: number): MaybePromise<unknown>;
  isFencingTokenCurrent(workspaceId: string, missionId: string, planningRequestId: string, leaseId: string, fencingToken: number, now: string): MaybePromise<boolean>;
  peek(workspaceId: string, missionId: string, planningRequestId: string): MaybePromise<{ leaseId: string; fencingToken: number; ownerId: string; attempt: number } | null>;
}

export interface PlanningAttemptStoreLike {
  create(input: CreateAttemptInput): MaybePromise<{ workerAttemptId: string; fencingToken: number }>;
  listForRequest(workspaceId: string, missionId: string, planningRequestId: string): MaybePromise<{ workerAttemptId: string; leaseId: string; fencingToken: number }[]>;
  transition(
    workerAttemptId: string,
    fencingToken: number,
    toState: PlanningAttemptState,
    now: string,
    opts?: { detail?: string; outcome?: string | null },
  ): MaybePromise<unknown>;
}

export interface PlanningDiagnosticsStoreLike {
  store(input: PlanningDiagnosticInput): Promise<{ ref: string }>;
}

type MaybePromise<T> = T | Promise<T>;

export type WorkerLifecycleState =
  | "claimed"
  | "invoking"
  | "response_received"
  | "parsing"
  | "validating"
  | "simulating"
  | "repairing"
  | "recording_result"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale"
  | "superseded"
  | "lease_lost"
  | "outcome_unknown";

export interface PlanningWorkerLogger {
  event(kind: string, detail: Record<string, unknown>): void;
}

export const NOOP_LOGGER: PlanningWorkerLogger = { event() {} };

export interface PlanningWorkerDeps {
  workspaceId: string;
  ownerId: string;
  registry: PlanningModelRegistry;
  requestPort: PlanningRequestPort;
  leaseStore: PlanningLeaseStoreLike;
  diagnosticsStore: PlanningDiagnosticsStoreLike;
  clock: () => string;
  mintId: () => string;
  logger?: PlanningWorkerLogger;
  leaseDurationMs?: number;
  maxRepairAttempts?: number;
  /**
   * Optional durable per-attempt record (Phase 5D Priority 3). Defaults to a
   * fresh in-memory instance so existing callers/tests that don't pass one
   * keep working unchanged — this is additive instrumentation, not a new
   * required collaborator. `process()`'s return shape is untouched by it.
   */
  attemptStore?: PlanningAttemptStoreLike;
  /**
   * Optional durable replay-material store (Phase 5E Task B). Defaults to a
   * fresh in-memory instance so existing callers/tests that don't pass one
   * keep working unchanged — this is additive instrumentation, not a new
   * required collaborator, exactly like `attemptStore` above. Written to
   * right after a successful model invocation (redacted raw output only —
   * never on a failed/rejected outcome, since there's nothing to replay a
   * deterministic pipeline against in that case).
   */
  replayableResponseStore?: PlanningReplayableResponseStore;
}

export interface ProcessPlanningRequestInput {
  missionId: string;
  planningRequestId: string;
  /** Context inputs the worker deterministically rebuilds and hashes — never trusts a caller-supplied hash directly. */
  contextInput: PlanningContextInput;
  planValidationContext: PlanValidationContext;
  availableProviders: PlannerProviderDescriptor[];
  createdBy: string;
  /** Whether the caller has already observed a cancellation signal for this request (checked again internally at each gate). */
  isCancelled?: () => Promise<boolean> | boolean;
}

export interface ProcessPlanningRequestResult {
  finalState: WorkerLifecycleState;
  attempts: number;
  diagnosticRefs: string[];
  resultingPlanId: string | null;
}

const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_MAX_REPAIR_ATTEMPTS = 1;

export class MissionPlanningWorker {
  private readonly deps: PlanningWorkerDeps;
  private readonly attemptStore: PlanningAttemptStoreLike;
  private readonly replayableResponseStore: PlanningReplayableResponseStore;

  constructor(deps: PlanningWorkerDeps) {
    this.deps = deps;
    this.attemptStore = deps.attemptStore ?? new InMemoryPlanningAttemptStore();
    this.replayableResponseStore = deps.replayableResponseStore ?? new InMemoryPlanningReplayableResponseStore();
  }

  /** Read-only accessor for tests/ops — never used by `process()` to change its own behavior. */
  getReplayableResponseStore(): PlanningReplayableResponseStore {
    return this.replayableResponseStore;
  }

  /** Read-only accessor for tests/ops — never used by `process()` to change its own behavior. */
  getAttemptStore(): PlanningAttemptStoreLike {
    return this.attemptStore;
  }

  /** Read-only accessor for tests/ops (e.g. proving a production composition root actually wired a durable store) — never used by `process()` to change its own behavior. */
  getLeaseStore(): PlanningLeaseStoreLike {
    return this.deps.leaseStore;
  }

  /** Read-only accessor for tests/ops — never used by `process()` to change its own behavior. */
  getDiagnosticsStore(): PlanningDiagnosticsStoreLike {
    return this.deps.diagnosticsStore;
  }

  /** Read-only accessor for tests/ops (e.g. proving a production composition root actually wired a durable port) — never used by `process()` to change its own behavior. */
  getRequestPort(): PlanningRequestPort {
    return this.deps.requestPort;
  }

  private mapFinalStateToAttemptState(finalState: WorkerLifecycleState): import("./mission-planning-attempt-store").PlanningAttemptState {
    return finalState;
  }

  private log(kind: string, detail: Record<string, unknown>): void {
    (this.deps.logger ?? NOOP_LOGGER).event(kind, detail);
  }

  private async storeDiagnostic(input: {
    missionId: string;
    planningRequestId: string;
    modelConfigurationId: string;
    providerRequestId: string | null;
    contextHash: string;
    stage: DiagnosticStage;
    promptMetadataSummary: string;
    detail: string | null;
    usage?: { inputTokens: number; outputTokens: number };
    finishReason?: string | null;
    failureClassification?: string | null;
    /**
     * Which logical attempt this diagnostic belongs to (1-based). Part of
     * the diagnostics store's idempotency identity — without it, two
     * genuinely distinct attempts against the same planning request (e.g.
     * a fresh worker after recovery) that happen to share stage +
     * contextHash would collide as if they were the same retried call.
     * Callers pass `request.attemptCount + 1`, the same value already used
     * for `correlation.attempt` elsewhere in this file.
     */
    attemptNumber: number;
  }): Promise<string> {
    const { attemptNumber, ...rest } = input;
    // Prefer providerRequestId as the attempt discriminator when known: it
    // is minted fresh per model invocation, so it correctly distinguishes
    // two genuinely different attempts that happen to share the same
    // `request.attemptCount` (e.g. a prior `outcome_unknown` attempt, which
    // never advances attemptCount, followed by an explicit fresh attempt).
    // Falls back to the attempt-number proxy only for the pre-invocation
    // (no providerRequestId yet) diagnostics.
    const workerAttemptId = input.providerRequestId ?? `attempt-${attemptNumber}`;
    const record = await this.deps.diagnosticsStore.store({
      workspaceId: this.deps.workspaceId,
      createdAt: this.deps.clock(),
      workerAttemptId,
      ...rest,
    });
    this.log("diagnostic_stored", { ref: record.ref, stage: input.stage });
    return record.ref;
  }

  /**
   * Public entry point — unchanged return shape. Wraps `processCore` with
   * durable attempt-store bookkeeping (Phase 5D Priority 3): creates (or
   * finds) the attempt tied to whatever lease `processCore` claimed, and
   * closes it out with the same terminal state `processCore` returned.
   * Deliberately best-effort/non-fatal — an attempt-store failure must
   * never change the worker's real (Mission-facing) outcome, since the
   * attempt store is diagnostic/recovery scaffolding, not Mission authority.
   */
  async process(input: ProcessPlanningRequestInput): Promise<ProcessPlanningRequestResult> {
    const result = await this.processCore(input);
    try {
      const lease = await this.deps.leaseStore.peek(this.deps.workspaceId, input.missionId, input.planningRequestId);
      if (lease && lease.ownerId === this.deps.ownerId) {
        const attemptsForRequest = await this.attemptStore.listForRequest(this.deps.workspaceId, input.missionId, input.planningRequestId);
        const existing = attemptsForRequest.find((a) => a.leaseId === lease.leaseId && a.fencingToken === lease.fencingToken);
        const attempt =
          existing ??
          (await this.attemptStore.create({
            workspaceId: this.deps.workspaceId,
            missionId: input.missionId,
            planningRequestId: input.planningRequestId,
            leaseId: lease.leaseId,
            fencingToken: lease.fencingToken,
            workerIdentity: this.deps.ownerId,
            modelConfigurationId: "unknown",
            attemptKind: "initial" as PlanningAttemptKind,
            attemptNumber: Math.max(result.attempts, 1),
            contextHash: "unknown",
            correlationId: this.deps.mintId(),
            now: this.deps.clock(),
            mintId: this.deps.mintId,
          }));
        await this.attemptStore.transition(attempt.workerAttemptId, attempt.fencingToken, this.mapFinalStateToAttemptState(result.finalState), this.deps.clock(), {
          outcome:
            result.finalState === "completed"
              ? "success"
              : result.finalState === "outcome_unknown"
                ? "outcome_unknown"
                : result.finalState === "cancelled"
                  ? "cancelled"
                  : result.finalState === "stale" || result.finalState === "superseded"
                    ? result.finalState
                    : result.finalState === "lease_lost"
                      ? "lease_lost"
                      : null,
        });
      }
    } catch (attemptStoreError) {
      this.log("attempt_store_bookkeeping_failed", { planningRequestId: input.planningRequestId, error: String(attemptStoreError) });
    }
    return result;
  }

  private async processCore(input: ProcessPlanningRequestInput): Promise<ProcessPlanningRequestResult> {
    const leaseDurationMs = this.deps.leaseStore ? (this.deps as PlanningWorkerDeps).leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS : DEFAULT_LEASE_DURATION_MS;
    const maxRepairAttempts = this.deps.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
    const diagnosticRefs: string[] = [];
    const checkCancelled = async (): Promise<boolean> => (input.isCancelled ? await input.isCancelled() : false);

    // ---- cancellation gate: before claim -------------------------------------
    if (await checkCancelled()) {
      this.log("cancellation_observed", { planningRequestId: input.planningRequestId, gate: "before_claim" });
      return { finalState: "cancelled", attempts: 0, diagnosticRefs, resultingPlanId: null };
    }

    // ---- claim ----------------------------------------------------------------
    const claim = await this.deps.leaseStore.claim({
      workspaceId: this.deps.workspaceId,
      missionId: input.missionId,
      planningRequestId: input.planningRequestId,
      ownerId: this.deps.ownerId,
      now: this.deps.clock(),
      leaseDurationMs,
      mintLeaseId: this.deps.mintId,
    });
    if (!claim.ok) {
      this.log("claim_refused", { planningRequestId: input.planningRequestId, reason: claim.reason, heldBy: claim.heldBy });
      return { finalState: "lease_lost", attempts: 0, diagnosticRefs, resultingPlanId: null };
    }
    const lease = claim.lease;
    this.log("claimed", { planningRequestId: input.planningRequestId, leaseId: lease.leaseId, fencingToken: lease.fencingToken });

    // ---- load request + eligibility --------------------------------------------
    const snapshot = await this.deps.requestPort.loadSnapshot(this.deps.workspaceId, input.missionId);
    const request = snapshot?.planningRequests[input.planningRequestId] ?? null;
    if (!request) {
      return { finalState: "failed", attempts: 0, diagnosticRefs, resultingPlanId: null };
    }
    if (request.status !== "requested" && request.status !== "in_progress") {
      // Already terminal (cancelled/superseded/completed/etc.) — nothing to do.
      // Checked BEFORE any invocation, ahead of the context-hash/target-plan-version
      // staleness checks below: a superseded request must never even reach
      // the model-invocation step, let alone recordModelPlanningResult.
      this.log("stale_result_discarded", { planningRequestId: input.planningRequestId, reason: "already_terminal", status: request.status });
      const finalState: WorkerLifecycleState = request.status === "cancelled" ? "cancelled" : request.status === "superseded" ? "superseded" : "stale";
      return { finalState, attempts: request.attemptCount, diagnosticRefs, resultingPlanId: null };
    }
    if (snapshot?.terminal) {
      this.log("stale_result_discarded", { planningRequestId: input.planningRequestId, reason: "mission_terminal" });
      return { finalState: "stale", attempts: request.attemptCount, diagnosticRefs, resultingPlanId: null };
    }

    // ---- cancellation gate: after claim, before invocation ---------------------
    if (await checkCancelled()) {
      this.log("cancellation_observed", { planningRequestId: input.planningRequestId, gate: "after_claim_before_invocation" });
      await this.deps.leaseStore.release(this.deps.workspaceId, input.missionId, input.planningRequestId, lease.leaseId, lease.fencingToken);
      return { finalState: "cancelled", attempts: request.attemptCount, diagnosticRefs, resultingPlanId: null };
    }

    // ---- rebuild + hash deterministic context; staleness check ----------------
    const boundedContext = await buildPlanningContext(input.contextInput);
    if (boundedContext.contextHash !== request.contextHash) {
      this.log("stale_result_discarded", { planningRequestId: input.planningRequestId, reason: "context_hash_mismatch" });
      const ref = await this.storeDiagnostic({
        missionId: input.missionId,
        planningRequestId: input.planningRequestId,
        modelConfigurationId: request.modelConfigurationId,
        providerRequestId: null,
        contextHash: boundedContext.contextHash,
        stage: "terminal",
        promptMetadataSummary: "context hash mismatch — recorded contextHash no longer matches deterministic rebuild",
        detail: null,
        failureClassification: "context_stale",
        attemptNumber: request.attemptCount + 1,
      });
      diagnosticRefs.push(ref);
      const outcome = await this.recordFailure(input, request, null, ref);
      return { finalState: outcome.finalState, attempts: request.attemptCount + 1, diagnosticRefs, resultingPlanId: null };
    }

    // ---- target Plan version staleness (revision kind) -------------------------
    if (request.kind === "revision" && request.basePlanId) {
      const currentPlanIdAtTargetVersion = snapshot?.planVersions[request.targetPlanVersion];
      if (currentPlanIdAtTargetVersion && currentPlanIdAtTargetVersion !== request.basePlanId) {
        this.log("stale_result_discarded", { planningRequestId: input.planningRequestId, reason: "target_plan_version_stale" });
        const outcome = await this.recordFailure(input, request, null, null);
        return { finalState: outcome.finalState, attempts: request.attemptCount + 1, diagnosticRefs, resultingPlanId: null };
      }
    }

    // ---- resolve trusted model config -------------------------------------------
    const resolved = this.deps.registry.resolve(request.modelConfigurationId, MODEL_PLAN_OUTPUT_SCHEMA_VERSION);
    if (!resolved.ok) {
      this.log("capability_or_config_rejected", { planningRequestId: input.planningRequestId, reason: resolved.reason });
      const outcome = await this.recordFailure(input, request, `config_${resolved.reason}`, null);
      await this.deps.leaseStore.release(this.deps.workspaceId, input.missionId, input.planningRequestId, lease.leaseId, lease.fencingToken);
      return { finalState: outcome.finalState, attempts: request.attemptCount + 1, diagnosticRefs, resultingPlanId: null };
    }
    const config = resolved.config;

    // ---- invoke (with bounded transport/throttle retry) -------------------------
    this.log("invocation_started", { planningRequestId: input.planningRequestId, planningModelConfigId: config.planningModelConfigId });
    const invocation = await this.invokeWithRetry(config, {
      planningModelConfigId: config.planningModelConfigId,
      trustedCapabilities: config.capabilityProfile,
      boundedContext,
      schemaVersion: MODEL_PLAN_OUTPUT_SCHEMA_VERSION,
      maxOutputTokens: config.maxOutputTokens,
      sampling: { temperature: 0, topP: 1 },
      timeoutMs: config.timeoutMs,
      correlation: { missionId: input.missionId, planningRequestId: input.planningRequestId, attempt: request.attemptCount + 1, correlationId: this.deps.mintId() },
    });

    if (await checkCancelled()) {
      this.log("cancellation_observed", { planningRequestId: input.planningRequestId, gate: "after_response_before_recording" });
      await this.deps.leaseStore.release(this.deps.workspaceId, input.missionId, input.planningRequestId, lease.leaseId, lease.fencingToken);
      return { finalState: "cancelled", attempts: request.attemptCount + 1, diagnosticRefs, resultingPlanId: null };
    }

    const invocationDiagRef = await this.storeDiagnostic({
      missionId: input.missionId,
      planningRequestId: input.planningRequestId,
      modelConfigurationId: config.planningModelConfigId,
      providerRequestId: invocation.providerRequestId,
      contextHash: boundedContext.contextHash,
      stage: "invocation",
      promptMetadataSummary: `${input.contextInput.constraints.length} constraints, ${input.contextInput.documentationSnippets.length} snippets`,
      detail: invocation.diagnosticSummary,
      usage: invocation.usage,
      finishReason: invocation.finishReason,
      failureClassification: invocation.outcome !== "success" ? invocation.outcome : null,
      attemptNumber: request.attemptCount + 1,
    });
    diagnosticRefs.push(invocationDiagRef);

    if (invocation.outcome === "outcome_unknown") {
      // NEVER auto-duplicate the model call — surface distinctly, requiring an explicit new attempt.
      this.log("outcome_unknown", { planningRequestId: input.planningRequestId });
      await this.deps.leaseStore.release(this.deps.workspaceId, input.missionId, input.planningRequestId, lease.leaseId, lease.fencingToken);
      return { finalState: "outcome_unknown", attempts: request.attemptCount, diagnosticRefs, resultingPlanId: null };
    }

    if (invocation.outcome !== "success") {
      // transport_failure/throttled exhausted retries, or a non-retryable provider_rejected.
      const outcome = await this.finalizeWithFencingCheck(input, request, lease, invocation.outcome, invocation.rawOutputText, invocationDiagRef, invocation.outcome);
      return { finalState: outcome.finalState, attempts: request.attemptCount + 1, diagnosticRefs, resultingPlanId: null };
    }

    // Persist bounded, redacted replay material for the raw model response
    // (Phase 5E Task B) right after a successful invocation — best-effort,
    // non-fatal: a replay-store failure must never change the worker's real
    // (Mission-facing) outcome, exactly like the attempt-store bookkeeping
    // in `process()` above. Only stored on success: a failed/rejected
    // invocation has nothing worth replaying a deterministic pipeline
    // against.
    await this.storeReplayableResponseBestEffort(input, config.planningModelConfigId, invocation.providerRequestId, request.attemptCount + 1, invocation.rawOutputText as string);

    // ---- schema/normalize/validate/simulate, with one bounded repair -----------
    let rawOutput = invocation.rawOutputText as string;
    let repairAttemptsUsed = 0;
    let lastValidationErrors: string[] = [];
    let lastSimulationErrors: string[] = [];

    for (;;) {
      const schemaResult = validateRawModelPlanOutput(rawOutput);
      if (!schemaResult.ok) {
        this.log("schema_rejected", { planningRequestId: input.planningRequestId, error: schemaResult.error });
        lastValidationErrors = [JSON.stringify(schemaResult.error)];
        const repaired = await this.tryRepair(config, boundedContext, input, request, rawOutput, lastValidationErrors, lastSimulationErrors, repairAttemptsUsed, maxRepairAttempts);
        if (repaired) {
          repairAttemptsUsed += 1;
          rawOutput = repaired;
          continue;
        }
        const outcome = await this.finalizeWithFencingCheck(input, request, lease, "provider_rejected", rawOutput, invocationDiagRef, "schema_rejected");
        return { finalState: outcome.finalState, attempts: request.attemptCount + 1, diagnosticRefs, resultingPlanId: null };
      }

      const { proposal, templateSafeguardViolations } = normalizeModelPlanProposal({
        missionId: input.missionId,
        version: request.targetPlanVersion,
        supersedesPlanId: request.kind === "revision" ? request.basePlanId : null,
        raw: schemaResult.value,
        availableProviders: input.availableProviders,
        now: this.deps.clock(),
        createdBy: input.createdBy,
      });
      if (templateSafeguardViolations.length > 0) {
        lastValidationErrors = templateSafeguardViolations.map((v) => String(v));
        const repaired = await this.tryRepair(config, boundedContext, input, request, rawOutput, lastValidationErrors, lastSimulationErrors, repairAttemptsUsed, maxRepairAttempts);
        if (repaired) {
          repairAttemptsUsed += 1;
          rawOutput = repaired;
          continue;
        }
        const outcome = await this.finalizeWithFencingCheck(input, request, lease, "provider_rejected", rawOutput, invocationDiagRef, "template_safeguard_violation");
        return { finalState: outcome.finalState, attempts: request.attemptCount + 1, diagnosticRefs, resultingPlanId: null };
      }

      const validation = validateMissionPlanProposal(proposal, input.planValidationContext);
      if (!validation.ok) {
        this.log("validation_rejected", { planningRequestId: input.planningRequestId, errors: validation.errors });
        lastValidationErrors = validation.errors.map((e) => JSON.stringify(e));
        const repaired = await this.tryRepair(config, boundedContext, input, request, rawOutput, lastValidationErrors, lastSimulationErrors, repairAttemptsUsed, maxRepairAttempts);
        if (repaired) {
          repairAttemptsUsed += 1;
          rawOutput = repaired;
          continue;
        }
        const outcome = await this.finalizeWithFencingCheck(input, request, lease, "provider_rejected", rawOutput, invocationDiagRef, "deterministic_validation_failed");
        return { finalState: outcome.finalState, attempts: request.attemptCount + 1, diagnosticRefs, resultingPlanId: null };
      }

      const simulation = simulateMissionPlanProposal(proposal);
      if (simulation.unreachableAssignments.length > 0) {
        this.log("simulation_rejected", { planningRequestId: input.planningRequestId, unreachable: simulation.unreachableAssignments });
        lastSimulationErrors = simulation.unreachableAssignments.map((a) => JSON.stringify(a));
        const repaired = await this.tryRepair(config, boundedContext, input, request, rawOutput, lastValidationErrors, lastSimulationErrors, repairAttemptsUsed, maxRepairAttempts);
        if (repaired) {
          repairAttemptsUsed += 1;
          rawOutput = repaired;
          continue;
        }
        const outcome = await this.finalizeWithFencingCheck(input, request, lease, "provider_rejected", rawOutput, invocationDiagRef, "simulation_failed");
        return { finalState: outcome.finalState, attempts: request.attemptCount + 1, diagnosticRefs, resultingPlanId: null };
      }

      // Success path — record the result. Fencing/staleness re-checked immediately before the write.
      const outcome = await this.finalizeWithFencingCheck(input, request, lease, "success", rawOutput, invocationDiagRef, null);
      return { finalState: outcome.finalState, attempts: request.attemptCount + 1, diagnosticRefs, resultingPlanId: outcome.resultingPlanId };
    }
  }

  private async invokeWithRetry(
    config: import("./mission-planning-model-registry").TrustedPlanningModelConfig,
    generateInput: GenerateStructuredPlanInput,
  ): Promise<PlanningModelInvocationResult> {
    let transportRetries = 0;
    let throttleRetries = 0;
    for (;;) {
      const result = await config.client.generateStructuredPlan(generateInput);
      if (result.outcome === "transport_failure" && transportRetries < config.retryPolicy.maxTransportRetries) {
        transportRetries += 1;
        continue;
      }
      if (result.outcome === "throttled" && throttleRetries < config.retryPolicy.maxThrottleRetries) {
        throttleRetries += 1;
        continue;
      }
      this.log("invocation_completed", { outcome: result.outcome, providerRequestId: result.providerRequestId });
      return result;
    }
  }

  private async tryRepair(
    config: import("./mission-planning-model-registry").TrustedPlanningModelConfig,
    boundedContext: import("./mission-planning-context").BoundedPlanningContext,
    input: ProcessPlanningRequestInput,
    request: PlanningRequestRecord,
    originalRawOutput: string,
    validationErrors: string[],
    simulationErrors: string[],
    repairAttemptsUsed: number,
    maxRepairAttempts: number,
  ): Promise<string | null> {
    if (repairAttemptsUsed >= maxRepairAttempts) return null;
    this.log("repair_attempted", { planningRequestId: input.planningRequestId, attempt: repairAttemptsUsed + 1 });
    const result = await config.client.repairStructuredPlan({
      planningModelConfigId: config.planningModelConfigId,
      trustedCapabilities: config.capabilityProfile,
      boundedContext,
      schemaVersion: MODEL_PLAN_OUTPUT_SCHEMA_VERSION,
      maxOutputTokens: config.maxOutputTokens,
      sampling: { temperature: 0, topP: 1 },
      timeoutMs: config.timeoutMs,
      correlation: { missionId: input.missionId, planningRequestId: input.planningRequestId, attempt: request.attemptCount + 1, correlationId: this.deps.mintId() },
      originalRawOutput,
      validationErrors,
      simulationErrors,
      remainingAttempts: maxRepairAttempts - repairAttemptsUsed,
    });
    if (result.outcome !== "success" || !result.rawOutputText) {
      this.log("repair_attempted", { planningRequestId: input.planningRequestId, result: "failed" });
      return null;
    }
    this.log("repair_attempted", { planningRequestId: input.planningRequestId, result: "succeeded" });
    return result.rawOutputText;
  }

  /**
   * Best-effort write to the replay-material store (Phase 5E Task B). Uses
   * the SAME workerAttemptId discriminator `storeDiagnostic` uses
   * (`providerRequestId ?? attempt-${attemptNumber}`) so a replay executor
   * can join a replayable-response row back to its diagnostics via the same
   * identity. Redacts via `redactForDiagnostics` before storing — never
   * persists the raw text verbatim. Swallows and logs any failure rather
   * than throwing, matching `process()`'s attempt-store bookkeeping
   * best-effort contract.
   */
  private async storeReplayableResponseBestEffort(
    input: ProcessPlanningRequestInput,
    modelConfigurationId: string,
    providerRequestId: string | null,
    attemptNumber: number,
    rawOutputText: string,
  ): Promise<void> {
    try {
      const workerAttemptId = providerRequestId ?? `attempt-${attemptNumber}`;
      const redacted = redactForDiagnostics(rawOutputText);
      if (redacted.status === "rejected_unsafe" || redacted.status === "not_stored") {
        // Nothing safe to persist — a replay executor will refuse
        // `missing_replay_material` for this attempt, which is correct: we
        // must never store content the redaction layer couldn't vouch for.
        return;
      }
      const outputDigest = await computeReplayableResponseDigest(redacted.text);
      const result: StoreReplayableResponseResult = await this.replayableResponseStore.store({
        workerAttemptId,
        workspaceId: this.deps.workspaceId,
        missionId: input.missionId,
        planningRequestId: input.planningRequestId,
        modelConfigurationId,
        schemaVersion: PLANNING_MODEL_PLAN_SCHEMA_VERSION,
        redactedRawOutput: redacted.text,
        outputDigest,
        createdAt: this.deps.clock(),
      });
      this.log("replayable_response_stored", { planningRequestId: input.planningRequestId, workerAttemptId, status: result.status, reason: result.reason });
    } catch (replayStoreError) {
      this.log("replayable_response_store_failed", { planningRequestId: input.planningRequestId, error: String(replayStoreError) });
    }
  }

  /**
   * Phase 5C §5 — fencing before recording a result: revalidate the lease
   * fence, reload the current record, confirm not cancelled/superseded,
   * confirm Mission not terminal, confirm attempt within maxAttempts. A
   * stale/fenced-out worker discards with only bounded diagnostics
   * preserved — never records a result.
   */
  private async finalizeWithFencingCheck(
    input: ProcessPlanningRequestInput,
    request: PlanningRequestRecord,
    lease: { leaseId: string; fencingToken: number; ownerId: string; attempt: number },
    outcome: "success" | "provider_rejected" | "transport_failure" | "throttled",
    rawOutput: string | null,
    diagnosticRef: string,
    failureClassification: string | null,
  ): Promise<{ finalState: WorkerLifecycleState; resultingPlanId: string | null }> {
    const now = this.deps.clock();
    const fenceOk = await this.deps.leaseStore.isFencingTokenCurrent(this.deps.workspaceId, input.missionId, input.planningRequestId, lease.leaseId, lease.fencingToken, now);
    if (!fenceOk) {
      this.log("lease_lost", { planningRequestId: input.planningRequestId });
      return { finalState: "lease_lost", resultingPlanId: null };
    }

    const freshSnapshot = await this.deps.requestPort.loadSnapshot(this.deps.workspaceId, input.missionId);
    const freshRequest = freshSnapshot?.planningRequests[input.planningRequestId];
    if (!freshRequest || (freshRequest.status !== "requested" && freshRequest.status !== "in_progress")) {
      // Includes supersession: a request superseded by a newer
      // RequestModelPlanning call WHILE this attempt was in flight (invoked
      // but not yet recorded) must never proceed to recordModelPlanningResult.
      this.log("stale_result_discarded", { planningRequestId: input.planningRequestId, reason: "no_longer_actionable", status: freshRequest?.status ?? null });
      await this.deps.leaseStore.release(this.deps.workspaceId, input.missionId, input.planningRequestId, lease.leaseId, lease.fencingToken);
      const finalState: WorkerLifecycleState = freshRequest?.status === "cancelled" ? "cancelled" : freshRequest?.status === "superseded" ? "superseded" : "stale";
      return { finalState, resultingPlanId: null };
    }
    if (freshSnapshot?.terminal) {
      await this.deps.leaseStore.release(this.deps.workspaceId, input.missionId, input.planningRequestId, lease.leaseId, lease.fencingToken);
      return { finalState: "stale", resultingPlanId: null };
    }

    this.log("recording_result", { planningRequestId: input.planningRequestId, outcome });
    const recorded = await this.deps.requestPort.recordModelPlanningResult({
      workspaceId: this.deps.workspaceId,
      missionId: input.missionId,
      planningRequestId: input.planningRequestId,
      rawModelOutputText: outcome === "success" ? rawOutput : null,
      failureCode: outcome === "success" ? null : (failureClassification ?? outcome),
      redactedDiagnosticRef: diagnosticRef,
      availableProviders: input.availableProviders,
      planValidationContext: input.planValidationContext,
      createdBy: input.createdBy,
      context: { correlationId: this.deps.mintId(), causationId: null, actor: { kind: "system", id: "orchestrator" }, timestamp: now },
      idempotencyKey: `planning-result:${input.planningRequestId}:${lease.attempt}`,
    });

    await this.deps.leaseStore.release(this.deps.workspaceId, input.missionId, input.planningRequestId, lease.leaseId, lease.fencingToken);

    if (!recorded.ok) {
      this.log("result_recorded", { planningRequestId: input.planningRequestId, ok: false });
      return { finalState: "failed", resultingPlanId: null };
    }
    this.log("result_recorded", { planningRequestId: input.planningRequestId, ok: true, nextStatus: recorded.nextStatus });
    const finalState: WorkerLifecycleState =
      recorded.nextStatus === "completed" ? "completed" :
      recorded.nextStatus === "cancelled" ? "cancelled" :
      recorded.nextStatus === "stale" ? "stale" :
      recorded.nextStatus === "superseded" ? "superseded" :
      recorded.nextStatus === "requested" ? "failed" /* bounced back for a fresh attempt — this worker's turn is done */ :
      "failed";
    return { finalState, resultingPlanId: recorded.resultingPlanId };
  }

  /** Used for pre-invocation failures (config rejected, context stale, target-plan-version stale) — no model call happened, so no invocation diagnostic. */
  private async recordFailure(
    input: ProcessPlanningRequestInput,
    request: PlanningRequestRecord,
    failureCode: string | null,
    diagnosticRef: string | null,
  ): Promise<{ finalState: WorkerLifecycleState; resultingPlanId: string | null }> {
    const now = this.deps.clock();
    const recorded = await this.deps.requestPort.recordModelPlanningResult({
      workspaceId: this.deps.workspaceId,
      missionId: input.missionId,
      planningRequestId: input.planningRequestId,
      rawModelOutputText: null,
      failureCode: failureCode ?? "pre_invocation_rejected",
      redactedDiagnosticRef: diagnosticRef,
      availableProviders: input.availableProviders,
      planValidationContext: input.planValidationContext,
      createdBy: input.createdBy,
      context: { correlationId: this.deps.mintId(), causationId: null, actor: { kind: "system", id: "orchestrator" }, timestamp: now },
      idempotencyKey: `planning-result:${input.planningRequestId}:pre-invocation:${request.attemptCount + 1}`,
    });
    if (!recorded.ok) return { finalState: "failed", resultingPlanId: null };
    const finalState: WorkerLifecycleState =
      recorded.nextStatus === "stale" ? "stale" :
      recorded.nextStatus === "failed" ? "failed" :
      recorded.nextStatus === "cancelled" ? "cancelled" :
      "failed";
    return { finalState, resultingPlanId: recorded.resultingPlanId };
  }
}
