/**
 * Supabase-backed MissionSchedulerStore — calls the atomic RPCs in
 * `supabase/migrations/20260726010000_mission_dispatch_leases.sql`.
 * ----------------------------------------------------------------------------
 * Verified in `mission-scheduler-store-supabase.test.ts` only at the
 * RPC-argument-shape level, against a fake SupabaseClient — the same
 * boundary `mission-store-supabase.test.ts` draws for the Mission aggregate.
 * The actual row-lock behavior that makes concurrent claims safe against two
 * real workers has never executed against a live Postgres instance in this
 * environment. `InMemoryMissionSchedulerStore` (mission-scheduler-store.ts)
 * is where the concurrency invariants are actually proven, with real
 * `Promise.all` interleaving.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type {
  ClaimCandidatesInput,
  ClaimCandidatesResult,
  ClaimRefusalReason,
  ClaimedCandidate,
  DispatchInstruction,
  LeaseMutationRefusalReason,
  MissionSchedulerStore,
  ReleaseDispatchLeaseInput,
  ReleaseDispatchLeaseResult,
  RenewDispatchLeaseInput,
  RenewDispatchLeaseResult,
  RevokeDispatchLeaseInput,
  RevokeDispatchLeaseResult,
  ValidateFenceInput,
} from "./mission-scheduler-store";
import type { DispatchLease } from "./mission-scheduler";

interface ClaimRpcRow {
  mission_id: string;
  dispatch_key: string;
  status: "claimed" | "refused";
  reason: ClaimRefusalReason | null;
  lease: DispatchLease | null;
  instruction: DispatchInstruction | null;
}

interface MutationRpcRow {
  status: string;
  reason: LeaseMutationRefusalReason | null;
  lease: DispatchLease | null;
}

export class SupabaseMissionSchedulerStore implements MissionSchedulerStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async claimCandidates(input: ClaimCandidatesInput): Promise<ClaimCandidatesResult> {
    const { data, error } = await this.client.rpc("claim_mission_dispatch_candidates_atomic", {
      p_candidates: input.candidates,
      p_holder: input.holder,
      p_now: input.now,
      p_lease_duration_ms: input.policy.leaseDurationMs,
      p_dispatchable_states: input.dispatchableStates,
    });

    if (error) throw new Error(`Failed to claim Mission dispatch candidates: ${error.message}`);

    const rows = (data ?? []) as ClaimRpcRow[];
    const claimed: ClaimedCandidate[] = [];
    const refused: ClaimCandidatesResult["refused"] = [];

    for (const row of rows) {
      if (row.status === "claimed" && row.lease && row.instruction) {
        claimed.push({ missionId: row.mission_id, dispatchKey: row.dispatch_key, lease: row.lease, instruction: row.instruction });
      } else {
        refused.push({ missionId: row.mission_id, dispatchKey: row.dispatch_key, reason: row.reason ?? "already_leased" });
      }
    }

    return { claimed, refused };
  }

  async renewLease(input: RenewDispatchLeaseInput): Promise<RenewDispatchLeaseResult> {
    const { data, error } = await this.client.rpc("renew_mission_dispatch_lease_atomic", {
      p_workspace_id: input.workspaceId,
      p_mission_id: input.missionId,
      p_dispatch_key: input.dispatchKey,
      p_lease_id: input.leaseId,
      p_fencing_token: input.fencingToken,
      p_holder: input.holder,
      p_now: input.now,
      p_lease_duration_ms: input.policy.leaseDurationMs,
      p_renewal_window_ms: input.policy.renewalWindowMs,
    });
    if (error) throw new Error(`Failed to renew Mission dispatch lease: ${error.message}`);
    return this.mapMutationRow(data);
  }

  async releaseLease(input: ReleaseDispatchLeaseInput): Promise<ReleaseDispatchLeaseResult> {
    const { data, error } = await this.client.rpc("release_mission_dispatch_lease_atomic", {
      p_workspace_id: input.workspaceId,
      p_mission_id: input.missionId,
      p_dispatch_key: input.dispatchKey,
      p_lease_id: input.leaseId,
      p_fencing_token: input.fencingToken,
      p_holder: input.holder,
      p_now: input.now,
    });
    if (error) throw new Error(`Failed to release Mission dispatch lease: ${error.message}`);
    return this.mapMutationRow(data);
  }

  async revokeLease(input: RevokeDispatchLeaseInput): Promise<RevokeDispatchLeaseResult> {
    const { data, error } = await this.client.rpc("revoke_mission_dispatch_lease_atomic", {
      p_workspace_id: input.workspaceId,
      p_mission_id: input.missionId,
      p_dispatch_key: input.dispatchKey,
      p_now: input.now,
      p_reason: input.reason,
    });
    if (error) throw new Error(`Failed to revoke Mission dispatch lease: ${error.message}`);
    return this.mapMutationRow(data);
  }

  async validateFence(input: ValidateFenceInput): Promise<boolean> {
    const { data, error } = await this.client.rpc("validate_mission_dispatch_fence_atomic", {
      p_workspace_id: input.workspaceId,
      p_mission_id: input.missionId,
      p_dispatch_key: input.dispatchKey,
      p_lease_id: input.leaseId,
      p_fencing_token: input.fencingToken,
    });
    if (error) throw new Error(`Failed to validate Mission dispatch fence: ${error.message}`);
    return data === true;
  }

  async listOutstandingDispatchIntents(workspaceId: string): Promise<DispatchInstruction[]> {
    const { data, error } = await this.client
      .from("mission_dispatch_intents")
      .select(
        "id, mission_id, workspace_id, assignment_id, repository_id, dispatch_key, adapter_requirement, lease_id, fencing_token, attempt, execution_constraints, created_at, delivered_at, superseded_at, process_handle",
      )
      .eq("workspace_id", workspaceId)
      .is("delivered_at", null)
      .is("superseded_at", null);

    if (error) throw new Error(`Failed to list outstanding Mission dispatch intents for ${workspaceId}: ${error.message}`);

    return (data ?? []).map((row) => ({
      instructionId: row.id,
      missionId: row.mission_id,
      workspaceId: row.workspace_id,
      assignmentId: row.assignment_id ?? null,
      repositoryId: row.repository_id,
      dispatchKey: row.dispatch_key,
      adapterRequirement: row.adapter_requirement,
      leaseId: row.lease_id,
      fencingToken: row.fencing_token,
      attempt: row.attempt,
      executionConstraints: row.execution_constraints,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
      supersededAt: row.superseded_at,
      processHandle: row.process_handle,
    }));
  }

  async markDispatchIntentDelivered(instructionId: string, deliveredAt: string): Promise<void> {
    const { error } = await this.client.from("mission_dispatch_intents").update({ delivered_at: deliveredAt }).eq("id", instructionId);
    if (error) throw new Error(`Failed to mark Mission dispatch intent ${instructionId} delivered: ${error.message}`);
  }

  async attachProcessHandle(instructionId: string, handle: Record<string, unknown>): Promise<void> {
    const { error } = await this.client.from("mission_dispatch_intents").update({ process_handle: handle }).eq("id", instructionId);
    if (error) throw new Error(`Failed to attach a process handle to Mission dispatch intent ${instructionId}: ${error.message}`);
  }

  private mapMutationRow(data: unknown): { ok: true; lease: DispatchLease } | { ok: false; reason: LeaseMutationRefusalReason } {
    const row = Array.isArray(data) ? (data[0] as MutationRpcRow | undefined) : undefined;
    if (!row) throw new Error("Mission dispatch lease RPC returned no row.");
    if (row.status === "refused" || !row.lease) {
      return { ok: false, reason: row.reason ?? "lease_not_found" };
    }
    return { ok: true, lease: row.lease };
  }
}

/** Guarded factory — throws if OathLock's Supabase env is not configured, matching the rest of the service layer. */
export function createSupabaseMissionSchedulerStore(): SupabaseMissionSchedulerStore {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabaseMissionSchedulerStore(supabase);
}
