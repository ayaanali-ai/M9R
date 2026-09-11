/**
 * Planning-request port — Phase 5C §13/§14.
 * ----------------------------------------------------------------------------
 * The ONLY way `MissionPlanningWorker` touches Mission state. Deliberately a
 * narrow interface — not `MissionStore`, not the full command handler — so
 * that "the worker cannot call `ApproveMissionPlan`/`MaterializeMissionPlan`/
 * `StartMission`/`CreateAssignment`/`AddParticipant`/`DispatchAssignment`/any
 * execution command" is true STRUCTURALLY: this type has no method that
 * could construct one. Two implementations exist: `PlanningRequestPortImpl`
 * (in-memory, reuses Phase 5B's `runMissionCommand`/`applyMissionCommand` —
 * used by tests and non-production callers) and `DurablePlanningRequestPort`
 * (Postgres-backed, reuses the same `applyMissionCommand` via
 * `runMissionCommandDurable` — used by the production planning worker).
 * Neither ever builds a parallel write path to the event log.
 */

import type { MissionId, PlanningRequestRecord } from "./mission-domain";
import type { CommandContext } from "./mission-commands";
import { runMissionCommand, type RunMissionCommandInput } from "./mission-runtime";
import type { MissionStore } from "./mission-store";
import type { IdempotencyStore } from "./mission-idempotency";
import type { CommandOutcomeRecord } from "./mission-commands";
import { loadMissionProjection } from "./mission-store";
import type { PlannerProviderDescriptor } from "./mission-planner";
import type { PlanValidationContext } from "./mission-planner-validator";
import { projectMission } from "./mission-projection";
import { runMissionCommandDurable, type MissionEventReader } from "./mission-runtime-durable";
import type { MissionCommandPersistence } from "./mission-command-persistence";

export interface MissionPlanningSnapshot {
  missionId: MissionId;
  workspaceId: string;
  terminal: boolean;
  planningRequests: Record<string, PlanningRequestRecord>;
  /** version -> planId, for the "target Plan version still current" staleness check. */
  planVersions: Record<number, string>;
}

export interface RecordModelPlanningResultInput {
  /**
   * The caller's configured workspace — checked against the Mission's own
   * genesis `workspaceId` before any command runs. A worker misconfigured
   * (or misrouted a `missionId`) for workspace A must never be able to
   * claim/complete a planning request that belongs to workspace B.
   */
  workspaceId: string;
  missionId: MissionId;
  planningRequestId: string;
  rawModelOutputText: string | null;
  failureCode: string | null;
  redactedDiagnosticRef: string | null;
  availableProviders: PlannerProviderDescriptor[];
  planValidationContext: PlanValidationContext;
  createdBy: string;
  context: CommandContext;
  idempotencyKey: string;
}

export type RecordModelPlanningResultOutcome =
  | { ok: true; nextStatus: PlanningRequestRecord["status"]; finalOutcome: PlanningRequestRecord["finalOutcome"]; resultingPlanId: string | null }
  | { ok: false; error: unknown };

/** Returned by write/read paths when the caller's `workspaceId` does not match the Mission's genesis `workspaceId`. */
export const WORKSPACE_MISMATCH_ERROR = "workspace_mismatch" as const;

/**
 * The only operations a planning worker may perform against Mission state.
 * No method here can create, approve, materialize, or dispatch anything —
 * that is the whole point of this type existing separately from
 * `MissionStore`/`ApplyCommandInput`.
 *
 * Every method takes the caller's `workspaceId` and enforces it against the
 * Mission's own genesis `workspaceId` before returning/mutating anything —
 * see `WORKSPACE_MISMATCH_ERROR` / cross-workspace gap tracked in Phase 5D.
 */
export interface PlanningRequestPort {
  loadSnapshot(workspaceId: string, missionId: MissionId): Promise<MissionPlanningSnapshot | null>;
  loadPlanningRequest(workspaceId: string, missionId: MissionId, planningRequestId: string): Promise<PlanningRequestRecord | null>;
  /** The ONLY write path — delegates to Phase 5B's `RecordModelPlanningResult` command, never a direct event append. */
  recordModelPlanningResult(input: RecordModelPlanningResultInput): Promise<RecordModelPlanningResultOutcome>;
}

export class PlanningRequestPortImpl implements PlanningRequestPort {
  private readonly missionStore: MissionStore;
  private readonly idempotencyStore: IdempotencyStore<CommandOutcomeRecord>;

  constructor(missionStore: MissionStore, idempotencyStore: IdempotencyStore<CommandOutcomeRecord>) {
    this.missionStore = missionStore;
    this.idempotencyStore = idempotencyStore;
  }

  async loadSnapshot(workspaceId: string, missionId: MissionId): Promise<MissionPlanningSnapshot | null> {
    const { projection, version } = await loadMissionProjection(this.missionStore, missionId);
    if (version === 0 && projection.aggregateVersion === 0) return null;
    // Never reveal (or act on) a Mission belonging to a different workspace —
    // treat it identically to "does not exist" from this caller's vantage.
    if (projection.workspaceId !== workspaceId) return null;
    const planVersions: Record<number, string> = {};
    for (const plan of Object.values(projection.planProposals)) {
      planVersions[plan.version] = plan.id;
    }
    return {
      missionId,
      workspaceId: projection.workspaceId,
      terminal: projection.terminal,
      planningRequests: { ...projection.planningRequests },
      planVersions,
    };
  }

  async loadPlanningRequest(workspaceId: string, missionId: MissionId, planningRequestId: string): Promise<PlanningRequestRecord | null> {
    const snapshot = await this.loadSnapshot(workspaceId, missionId);
    return snapshot?.planningRequests[planningRequestId] ?? null;
  }

  async recordModelPlanningResult(input: RecordModelPlanningResultInput): Promise<RecordModelPlanningResultOutcome> {
    // Defense-in-depth: re-check workspace ownership right before the write,
    // not just at the worker's earlier `loadSnapshot` call — closes the gap
    // where a misconfigured/misrouted caller could otherwise still complete
    // a request belonging to another workspace.
    const snapshot = await this.loadSnapshot(input.workspaceId, input.missionId);
    if (!snapshot) {
      return { ok: false, error: { code: WORKSPACE_MISMATCH_ERROR, missionId: input.missionId, workspaceId: input.workspaceId } };
    }
    const runInput: RunMissionCommandInput = {
      missionStore: this.missionStore,
      idempotencyStore: this.idempotencyStore,
      command: {
        type: "RecordModelPlanningResult",
        missionId: input.missionId,
        planningRequestId: input.planningRequestId,
        rawModelOutputText: input.rawModelOutputText,
        failureCode: input.failureCode,
        redactedDiagnosticRef: input.redactedDiagnosticRef,
        availableProviders: input.availableProviders,
        planValidationContext: input.planValidationContext,
        createdBy: input.createdBy,
      },
      context: input.context,
      idempotencyKey: input.idempotencyKey,
    };
    const result = await runMissionCommand(runInput);
    if (!result.ok) return { ok: false, error: result.error };
    const statusEvent = result.events.find(
      (e) => e.type === "mission.model_plan_request_status_changed" && (e.payload as { planningRequestId: string }).planningRequestId === input.planningRequestId,
    );
    const payload = statusEvent?.payload as { nextStatus: PlanningRequestRecord["status"]; finalOutcome: PlanningRequestRecord["finalOutcome"]; resultingPlanId?: string } | undefined;
    return {
      ok: true,
      nextStatus: payload?.nextStatus ?? "failed",
      finalOutcome: payload?.finalOutcome ?? null,
      resultingPlanId: payload?.resultingPlanId ?? null,
    };
  }
}

/**
 * Durable, Postgres-backed sibling of `PlanningRequestPortImpl`. Same
 * narrow `PlanningRequestPort` contract and the same documented invariants
 * (workspace scoping on every method, structurally only able to construct
 * `RecordModelPlanningResult`) — the only difference is where reads/writes
 * land:
 *
 *   - `loadSnapshot`/`loadPlanningRequest` load events via
 *     `MissionEventReader.loadEvents` (a plain Postgres read) and project
 *     them with the same pure `projectMission` `runMissionCommandDurable`
 *     itself uses — this mirrors `PlanningRequestPortImpl`'s
 *     `loadMissionProjection(missionStore, missionId)` call exactly,
 *     `missionStore.loadEvents` swapped for `reader.loadEvents`.
 *   - `recordModelPlanningResult` calls `runMissionCommandDurable` (the
 *     single-transaction `apply_mission_command_atomic` RPC path) instead of
 *     `runMissionCommand`/`MissionStore.append` — this is the SAME command
 *     handler (`applyMissionCommand`) underneath, just the durable impure
 *     shell instead of the in-memory one, so no domain-logic behavior
 *     changes.
 */
export class DurablePlanningRequestPort implements PlanningRequestPort {
  private readonly reader: MissionEventReader;
  private readonly persistence: MissionCommandPersistence;

  constructor(reader: MissionEventReader, persistence: MissionCommandPersistence) {
    this.reader = reader;
    this.persistence = persistence;
  }

  async loadSnapshot(workspaceId: string, missionId: MissionId): Promise<MissionPlanningSnapshot | null> {
    const events = await this.reader.loadEvents(missionId);
    if (events.length === 0) return null;
    const projection = projectMission(missionId, events);
    // Never reveal (or act on) a Mission belonging to a different workspace —
    // treat it identically to "does not exist" from this caller's vantage.
    if (projection.workspaceId !== workspaceId) return null;
    const planVersions: Record<number, string> = {};
    for (const plan of Object.values(projection.planProposals)) {
      planVersions[plan.version] = plan.id;
    }
    return {
      missionId,
      workspaceId: projection.workspaceId,
      terminal: projection.terminal,
      planningRequests: { ...projection.planningRequests },
      planVersions,
    };
  }

  async loadPlanningRequest(workspaceId: string, missionId: MissionId, planningRequestId: string): Promise<PlanningRequestRecord | null> {
    const snapshot = await this.loadSnapshot(workspaceId, missionId);
    return snapshot?.planningRequests[planningRequestId] ?? null;
  }

  async recordModelPlanningResult(input: RecordModelPlanningResultInput): Promise<RecordModelPlanningResultOutcome> {
    // Defense-in-depth: re-check workspace ownership right before the write,
    // not just at the worker's earlier `loadSnapshot` call — closes the gap
    // where a misconfigured/misrouted caller could otherwise still complete
    // a request belonging to another workspace. Identical to
    // `PlanningRequestPortImpl`'s check; `runMissionCommandDurable`'s own RPC
    // also re-verifies workspace_id, but this port does not rely on that
    // alone (same defensive posture as mission-application-service.ts).
    const snapshot = await this.loadSnapshot(input.workspaceId, input.missionId);
    if (!snapshot) {
      return { ok: false, error: { code: WORKSPACE_MISMATCH_ERROR, missionId: input.missionId, workspaceId: input.workspaceId } };
    }
    const result = await runMissionCommandDurable({
      reader: this.reader,
      persistence: this.persistence,
      command: {
        type: "RecordModelPlanningResult",
        missionId: input.missionId,
        planningRequestId: input.planningRequestId,
        rawModelOutputText: input.rawModelOutputText,
        failureCode: input.failureCode,
        redactedDiagnosticRef: input.redactedDiagnosticRef,
        availableProviders: input.availableProviders,
        planValidationContext: input.planValidationContext,
        createdBy: input.createdBy,
      },
      context: input.context,
      idempotencyKey: input.idempotencyKey,
      workspaceId: input.workspaceId,
    });
    if (!result.ok) return { ok: false, error: result.error };
    const statusEvent = result.events.find(
      (e) => e.type === "mission.model_plan_request_status_changed" && (e.payload as { planningRequestId: string }).planningRequestId === input.planningRequestId,
    );
    const payload = statusEvent?.payload as { nextStatus: PlanningRequestRecord["status"]; finalOutcome: PlanningRequestRecord["finalOutcome"]; resultingPlanId?: string } | undefined;
    return {
      ok: true,
      nextStatus: payload?.nextStatus ?? "failed",
      finalOutcome: payload?.finalOutcome ?? null,
      resultingPlanId: payload?.resultingPlanId ?? null,
    };
  }
}
