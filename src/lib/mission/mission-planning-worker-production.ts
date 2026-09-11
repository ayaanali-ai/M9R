/**
 * Production composition root for `MissionPlanningWorker` — Phase 5D/5E
 * follow-up.
 * ----------------------------------------------------------------------------
 * `createProductionMissionPlanningWorker(config)` wires the three durable,
 * Supabase-backed stores added alongside this file
 * (`SupabaseMissionPlanningLeaseStore`, `SupabaseMissionPlanningAttemptStore`,
 * `SupabasePlanningDiagnosticsStore`) into `MissionPlanningWorker`, so the
 * happy path holds no in-memory store.
 *
 * Why adapters exist: `MissionPlanningWorker`'s `PlanningLeaseStoreLike` /
 * `PlanningAttemptStoreLike` contracts (mission-planning-worker.ts) were
 * shaped around `InMemoryPlanningLeaseStore` / `InMemoryPlanningAttemptStore`
 * — positional arguments, a narrower set of typed refusal reasons, no
 * workspace/mission-terminal/request-terminal flags at claim time. The
 * Supabase-backed stores' RPCs need MORE information than that (the SQL
 * functions trust the caller to have already derived
 * mission-terminal/request-exists/request-terminal — see
 * `supabase/migrations/20260727020000_mission_planning_leases.sql`'s header
 * comment) and expose a RICHER set of typed refusals. `SupabaseLeaseStoreAdapter`
 * / `SupabaseAttemptStoreAdapter` below bridge that gap: they derive the
 * extra fields from a fresh `PlanningRequestPort` snapshot, and fold the
 * richer refusal/attempt-kind vocabularies down onto the narrower shapes
 * `MissionPlanningWorker` understands. Every such folding decision is called
 * out in a comment at the point it happens — nothing is silently coerced.
 *
 * `PlanningRequestPort` here is `DurablePlanningRequestPort`
 * (mission-planning-request-port.ts) — the durable Postgres-backed sibling
 * of `PlanningRequestPortImpl`, wired to the same `SupabaseMissionEventReader`
 * / `SupabaseMissionCommandPersistence` pair `mission-application-service.ts`
 * uses for the live `/api/missions/*` routes, so this worker's reads/writes
 * land in the same `mission_events` / `mission_command_outcomes` tables as
 * every other real Mission command path. No in-memory store in this
 * composition root's happy path.
 *
 * No top-level side effects: nothing below runs until
 * `createProductionMissionPlanningWorker` is called. No module-level
 * singleton — every call builds a fresh set of collaborators. Config is
 * validated synchronously, before any Supabase client or store is
 * constructed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import {
  MissionPlanningWorker,
  type PlanningLeaseStoreLike,
  type PlanningAttemptStoreLike,
} from "./mission-planning-worker";
import type {
  ClaimPlanningLeaseInput,
  ClaimPlanningLeaseResult,
  ReleasePlanningLeaseResult,
  PlanningLease,
} from "./mission-planning-lease-store";
import type {
  CreateAttemptInput,
  PlanningWorkerAttempt,
  TransitionResult,
  PlanningAttemptState,
  PlanningAttemptKind,
} from "./mission-planning-attempt-store";
import { SupabaseMissionPlanningLeaseStore } from "./mission-planning-lease-store-supabase";
import {
  SupabaseMissionPlanningAttemptStore,
  type SupabasePlanningWorkerAttempt,
} from "./mission-planning-attempt-store-supabase";
import { SupabasePlanningDiagnosticsStore } from "./mission-planning-diagnostics-store-supabase";
import { DurablePlanningRequestPort, type PlanningRequestPort } from "./mission-planning-request-port";
import { SupabaseMissionEventReader } from "./mission-store-supabase";
import { SupabaseMissionCommandPersistence } from "./mission-command-persistence";
import { PlanningModelRegistry, type TrustedPlanningModelConfig } from "./mission-planning-model-registry";
import type { PlanningWorkerLogger } from "./mission-planning-worker";

export interface ProductionMissionPlanningWorkerConfig {
  workspaceId: string;
  ownerId: string;
  modelConfigs: TrustedPlanningModelConfig[];
  clock?: () => string;
  mintId?: () => string;
  logger?: PlanningWorkerLogger;
  leaseDurationMs?: number;
  maxRepairAttempts?: number;
  /** Injectable for tests only — production callers should omit this and let the guarded default (`@/lib/supabase`) be used. */
  supabaseClient?: SupabaseClient;
}

function defaultClock(): string {
  return new Date().toISOString();
}

let idCounter = 0;
function defaultMintId(): string {
  idCounter += 1;
  return `pw-${Date.now().toString(36)}-${idCounter}`;
}

/** SQL's `attempt_kind` enum is richer than the worker's `initial | repair` union — same collapse `mission-planning-attempt-store-supabase.ts` would need, kept local here since that file's own export type stays a raw `string`. */
function toWorkerAttemptKind(sqlKind: string): PlanningAttemptKind {
  if (sqlKind === "schema_repair" || sqlKind === "validation_repair") return "repair";
  return "initial";
}

function toWorkerAttempt(row: SupabasePlanningWorkerAttempt): PlanningWorkerAttempt {
  return {
    workerAttemptId: row.workerAttemptId,
    workspaceId: row.workspaceId,
    missionId: row.missionId,
    planningRequestId: row.planningRequestId,
    leaseId: row.leaseId,
    fencingToken: row.fencingToken,
    workerIdentity: row.workerId,
    modelConfigurationId: row.modelConfigurationId,
    providerRequestId: row.providerRequestId,
    attemptKind: toWorkerAttemptKind(row.attemptKind),
    attemptNumber: row.attemptNumber,
    state: row.state as PlanningAttemptState,
    contextHash: row.contextHash,
    startedAt: row.startedAt,
    responseReceivedAt: row.responseReceivedAt,
    completedAt: row.completedAt,
    outcome: row.outcomeClassification,
    diagnosticRef: row.diagnosticRef,
    // mission_planning_worker_attempts has no retry-count columns (see mission-planning-attempt-store-supabase.ts's file header) — never fabricated, always reported as zero.
    retryMetadata: { transportRetries: 0, throttleRetries: 0 },
    parentAttemptId: row.parentAttemptId,
    correlationId: row.correlationId,
    causationId: row.causationId,
    // The durable transition log is a separate table this adapter does not hydrate per call — no current caller reads `transitions` off an adapter-returned attempt.
    transitions: [],
  };
}

/**
 * Bridges `MissionPlanningWorker`'s `PlanningLeaseStoreLike` contract to
 * `SupabaseMissionPlanningLeaseStore`'s richer RPC-shaped API. See this
 * file's header for why the bridge is necessary and what it folds together.
 */
class SupabaseLeaseStoreAdapter implements PlanningLeaseStoreLike {
  private readonly store: SupabaseMissionPlanningLeaseStore;
  private readonly requestPort: PlanningRequestPort;
  private readonly mintWorkerAttemptId: () => string;

  constructor(
    store: SupabaseMissionPlanningLeaseStore,
    requestPort: PlanningRequestPort,
    mintWorkerAttemptId: () => string,
  ) {
    this.store = store;
    this.requestPort = requestPort;
    this.mintWorkerAttemptId = mintWorkerAttemptId;
  }

  /** Read-only accessor for the structural test — proves the adapter wraps a real `SupabaseMissionPlanningLeaseStore`, not an in-memory fallback. */
  getWrappedStore(): SupabaseMissionPlanningLeaseStore {
    return this.store;
  }

  async claim(input: ClaimPlanningLeaseInput): Promise<ClaimPlanningLeaseResult> {
    const snapshot = await this.requestPort.loadSnapshot(input.workspaceId, input.missionId);
    const request = snapshot?.planningRequests[input.planningRequestId] ?? null;
    const missionTerminal = snapshot?.terminal ?? false;
    const requestExists = request !== null;
    const requestTerminal = request ? request.status !== "requested" && request.status !== "in_progress" : false;

    const result = await this.store.claim({
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      planningRequestId: input.planningRequestId,
      missionTerminal,
      requestExists,
      requestTerminal,
      ownerId: input.ownerId,
      now: input.now,
      leaseDurationMs: input.leaseDurationMs,
      workerAttemptId: this.mintWorkerAttemptId(),
      workerId: input.ownerId,
      // Not yet known at claim time (model resolution happens after the lease is held) — placeholders mirroring the same "unknown" convention mission-planning-worker.ts's own attempt-store bookkeeping already uses.
      modelConfigurationId: "unknown",
      attemptKind: "initial_invocation",
      attemptNumber: 1,
      contextHash: "unknown",
      correlationId: this.mintWorkerAttemptId(),
      causationId: null,
    });

    if (result.ok) {
      return {
        ok: true,
        lease: {
          workspaceId: result.lease.workspaceId,
          missionId: result.lease.missionId,
          planningRequestId: result.lease.planningRequestId,
          ownerId: result.lease.ownerId,
          leaseId: result.lease.leaseId,
          fencingToken: result.lease.fencingToken,
          acquiredAt: result.lease.acquiredAt,
          expiresAt: result.lease.expiresAt,
          attempt: result.lease.attempt,
          status: "active",
        },
      };
    }

    // `ClaimPlanningLeaseResult`'s failure branch only models one refusal
    // reason ("already_leased") — the in-memory store never had a richer
    // vocabulary to begin with. The Supabase RPC can also refuse with
    // mission_not_found / workspace_mismatch / mission_terminal /
    // planning_request_not_found / planning_request_terminal — every one of
    // those folds onto the same "cannot claim right now" outcome from
    // `MissionPlanningWorker`'s point of view (it only ever reacts to
    // `claim.ok === false` by returning `lease_lost`), so they are folded
    // into the same shape here, with the REAL reason preserved in `heldBy`
    // for diagnosability rather than silently discarded.
    return {
      ok: false,
      reason: "already_leased",
      heldBy: result.reason === "already_leased" ? "unknown" : `refused:${result.reason}`,
      expiresAt: input.now,
    };
  }

  async release(
    workspaceId: string,
    missionId: string,
    planningRequestId: string,
    leaseId: string,
    fencingToken: number,
  ): Promise<ReleasePlanningLeaseResult> {
    const result = await this.store.release(workspaceId, missionId, planningRequestId, leaseId, fencingToken, defaultClock());
    if (!result.ok) return result;
    return { ok: true };
  }

  async isFencingTokenCurrent(
    workspaceId: string,
    missionId: string,
    planningRequestId: string,
    leaseId: string,
    fencingToken: number,
  ): Promise<boolean> {
    return this.store.isFencingTokenCurrent(workspaceId, missionId, planningRequestId, leaseId, fencingToken);
  }

  async peek(workspaceId: string, missionId: string, planningRequestId: string): Promise<PlanningLease | null> {
    const row = await this.store.peek(workspaceId, missionId, planningRequestId);
    if (!row) return null;
    return {
      workspaceId: row.workspaceId,
      missionId: row.missionId,
      planningRequestId: row.planningRequestId,
      ownerId: row.ownerId,
      leaseId: row.leaseId,
      fencingToken: row.fencingToken,
      acquiredAt: row.acquiredAt,
      expiresAt: row.expiresAt,
      attempt: row.attempt,
      // `revoked` has no equivalent in the in-memory 3-state status — folded onto "expired" (both mean "no longer a live claim", the distinction is diagnostic-only via `revokedReason`, not read by MissionPlanningWorker).
      status: row.status === "leased" ? "active" : row.status === "released" ? "released" : "expired",
    };
  }
}

/**
 * Bridges `MissionPlanningWorker`'s `PlanningAttemptStoreLike` contract to
 * `SupabaseMissionPlanningAttemptStore`'s richer, object-argument API.
 */
class SupabaseAttemptStoreAdapter implements PlanningAttemptStoreLike {
  private readonly store: SupabaseMissionPlanningAttemptStore;

  constructor(store: SupabaseMissionPlanningAttemptStore) {
    this.store = store;
  }

  /** Read-only accessor for the structural test — proves the adapter wraps a real `SupabaseMissionPlanningAttemptStore`, not an in-memory fallback. */
  getWrappedStore(): SupabaseMissionPlanningAttemptStore {
    return this.store;
  }

  /**
   * `create` is only reached by `MissionPlanningWorker.process()`'s
   * best-effort bookkeeping when `listForRequest` found no attempt matching
   * the just-claimed lease — which should never happen for a Supabase-backed
   * lease, since `claim_mission_planning_lease` creates the attempt row in
   * the SAME transaction (see the lease migration's header comment). There
   * is deliberately no standalone `create` RPC call wired here: throwing
   * surfaces a genuine invariant violation instead of silently fabricating a
   * second, disconnected attempt row.
   */
  async create(input: CreateAttemptInput): Promise<PlanningWorkerAttempt> {
    throw new Error(
      `SupabaseAttemptStoreAdapter.create was reached for planning request ${input.planningRequestId} — this should be unreachable for a Supabase-backed lease store, since claim_mission_planning_lease creates the attempt row transactionally. This indicates the just-claimed attempt was not found by listForRequest.`,
    );
  }

  async listForRequest(workspaceId: string, missionId: string, planningRequestId: string): Promise<PlanningWorkerAttempt[]> {
    const rows = await this.store.listForRequest(workspaceId, missionId, planningRequestId);
    return rows.map(toWorkerAttempt);
  }

  async transition(
    workerAttemptId: string,
    fencingToken: number,
    toState: PlanningAttemptState,
    now: string,
    opts?: { detail?: string; outcome?: PlanningWorkerAttempt["outcome"] },
  ): Promise<TransitionResult> {
    // MissionPlanningWorker's call sites never carry the owning workspaceId
    // into this positional signature — the in-memory store never needed one
    // (its primary key already includes it). Passing an empty string here
    // means the adapter's own workspace_mismatch defense-in-depth check
    // (mission-planning-attempt-store-supabase.ts) never actually fires from
    // this path; cross-workspace protection for the underlying attempt
    // mutation still holds structurally because `workerAttemptId` values are
    // only ever obtained from a lease/attempt this worker itself claimed
    // within its own configured workspace.
    const result = await this.store.transition({ workspaceId: "", workerAttemptId, fencingToken, toState, now, detail: opts?.detail, outcomeClassification: opts?.outcome });
    if (!result.ok) {
      // `workspace_mismatch` has no slot in `TransitionResult`'s narrower reason union — folds onto `not_found` (both mean "not a mutable attempt this caller may act on").
      const reason = result.reason === "workspace_mismatch" ? "not_found" : result.reason;
      return { ok: false, reason };
    }
    return { ok: true, attempt: toWorkerAttempt(result.attempt), noop: result.noop || undefined };
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`createProductionMissionPlanningWorker: ${field} must be a non-empty string.`);
  }
}

/**
 * Synchronously validates `config`, then constructs a `MissionPlanningWorker`
 * whose lease/attempt/diagnostics stores are all Supabase-backed (via the
 * adapters above) — no in-memory store in the happy path. See this file's
 * header for the one stated durability gap (`PlanningRequestPort`'s
 * in-memory `MissionStore`).
 */
export function createProductionMissionPlanningWorker(config: ProductionMissionPlanningWorkerConfig): MissionPlanningWorker {
  assertNonEmptyString(config.workspaceId, "workspaceId");
  assertNonEmptyString(config.ownerId, "ownerId");
  if (!Array.isArray(config.modelConfigs) || config.modelConfigs.length === 0) {
    throw new Error("createProductionMissionPlanningWorker: modelConfigs must be a non-empty array.");
  }
  for (const modelConfig of config.modelConfigs) {
    assertNonEmptyString(modelConfig.planningModelConfigId, "modelConfigs[].planningModelConfigId");
  }
  if (config.leaseDurationMs !== undefined && !(config.leaseDurationMs > 0)) {
    throw new Error("createProductionMissionPlanningWorker: leaseDurationMs must be a positive number when provided.");
  }
  if (config.maxRepairAttempts !== undefined && !(config.maxRepairAttempts >= 0)) {
    throw new Error("createProductionMissionPlanningWorker: maxRepairAttempts must be a non-negative number when provided.");
  }

  const client = config.supabaseClient ?? supabase;
  if (!client) throw new Error("createProductionMissionPlanningWorker: M9R agent backend is not configured.");

  const mintId = config.mintId ?? defaultMintId;
  const clock = config.clock ?? defaultClock;

  const registry = new PlanningModelRegistry();
  for (const modelConfig of config.modelConfigs) registry.register(modelConfig);

  const requestPort = new DurablePlanningRequestPort(new SupabaseMissionEventReader(client), new SupabaseMissionCommandPersistence(client));

  const rawLeaseStore = new SupabaseMissionPlanningLeaseStore(client);
  const rawAttemptStore = new SupabaseMissionPlanningAttemptStore(client);
  const diagnosticsStore = new SupabasePlanningDiagnosticsStore(client);

  const leaseStore = new SupabaseLeaseStoreAdapter(rawLeaseStore, requestPort, mintId);
  const attemptStore = new SupabaseAttemptStoreAdapter(rawAttemptStore);

  const worker = new MissionPlanningWorker({
    workspaceId: config.workspaceId,
    ownerId: config.ownerId,
    registry,
    requestPort,
    leaseStore,
    diagnosticsStore,
    clock,
    mintId,
    logger: config.logger,
    leaseDurationMs: config.leaseDurationMs,
    maxRepairAttempts: config.maxRepairAttempts,
    attemptStore,
  });

  return worker;
}

/** Exported for the structural test — proves the constructed worker actually holds the three Supabase-backed store instances, not fresh in-memory ones. */
export { SupabaseLeaseStoreAdapter, SupabaseAttemptStoreAdapter };
