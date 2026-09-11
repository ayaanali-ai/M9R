import type { SupabaseClient } from "@supabase/supabase-js";
import type { AcceptExecutionResultInput, AcceptExecutionResultResult, AcceptedExecutionResult, AcceptedResultRefusalReason, MissionExecutionResultStore } from "./mission-execution-result-store";

const REFUSALS = new Set<AcceptedResultRefusalReason>([
  "legacy_missing_assignment_linkage", "dispatch_not_found", "workspace_mismatch", "mission_mismatch", "assignment_mismatch", "execution_mismatch", "provider_mismatch", "lease_mismatch", "stale_fencing_generation", "execution_attempt_mismatch", "unsupported_result_kind", "unsupported_schema_version", "invalid_digest", "invalid_idempotency_key", "metadata_not_redacted", "metadata_too_large", "invalid_dispatch_state", "execution_not_started", "execution_already_terminal", "terminal_result_conflict", "result_after_lease_loss", "idempotency_conflict", "invalid_evidence_requirement",
]);

export class SupabaseMissionExecutionResultStore implements MissionExecutionResultStore {
  constructor(private readonly client: SupabaseClient) {}

  async acceptResult(input: AcceptExecutionResultInput): Promise<AcceptExecutionResultResult> {
    const { data, error } = await this.client.rpc("accept_mission_execution_result_atomic", {
      p_workspace_id: input.workspaceId, p_mission_id: input.missionId, p_assignment_id: input.assignmentId,
      p_dispatch_intent_id: input.dispatchIntentId, p_execution_id: input.executionId, p_provider_adapter_id: input.providerAdapterId,
      p_lease_id: input.leaseId, p_fencing_generation: input.fencingGeneration, p_execution_attempt: input.executionAttempt,
      p_result_kind: input.resultKind, p_result_schema_version: input.resultSchemaVersion, p_result_digest: input.resultDigest,
      p_idempotency_key: input.idempotencyKey, p_metadata: input.metadata, p_evidence_descriptors: input.evidenceDescriptors, p_evidence_required: input.evidenceRequired,
      p_correlation_id: input.correlationId, p_causation_id: input.causationId, p_now: input.now,
    });
    if (error) throw new Error(`Failed to accept fenced Mission execution result: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) throw new Error("Result acceptance RPC returned no row.");
    if (row.status === "accepted" || row.status === "duplicate") {
      const accepted = row.accepted_result as { acceptedResultId?: string; status?: AcceptExecutionResultResult extends never ? never : string } | null;
      if (!accepted?.acceptedResultId || !["pending", "claimed", "retry", "fully_applied"].includes(accepted.status ?? "")) throw new Error("Result acceptance RPC returned malformed accepted result.");
      return { ok: true, duplicate: row.status === "duplicate", acceptedResultId: accepted.acceptedResultId, applicationStatus: accepted.status as "pending" | "claimed" | "retry" | "fully_applied" };
    }
    if (row.status === "refused" && typeof row.reason === "string" && REFUSALS.has(row.reason as AcceptedResultRefusalReason)) return { ok: false, reason: row.reason as AcceptedResultRefusalReason };
    throw new Error(`Result acceptance RPC returned unknown outcome: ${String(row.status)}:${String(row.reason)}`);
  }

  async claimUnapplied(input: { owner: string; now: string; leaseDurationMs: number; limit: number }): Promise<AcceptedExecutionResult[]> {
    const { data, error } = await this.client.rpc("claim_mission_execution_results_for_application_atomic", { p_owner: input.owner, p_now: input.now, p_lease_duration_ms: input.leaseDurationMs, p_limit: input.limit });
    if (error) throw new Error(`Failed to claim accepted Mission execution results: ${error.message}`);
    return (data ?? []).map((row: Record<string, unknown>) => this.mapRow(row));
  }

  async markLifecycleApplied(input: { acceptedResultId: string; owner: string; at: string }): Promise<void> { await this.update(input, "lifecycle_applied"); }
  async markEvidenceApplied(input: { acceptedResultId: string; owner: string; at: string }): Promise<void> { await this.update(input, "evidence_applied"); }
  async markFullyApplied(input: { acceptedResultId: string; owner: string; at: string }): Promise<void> { await this.update(input, "fully_applied"); }
  async markApplicationFailed(input: { acceptedResultId: string; owner: string; errorCode: string; nextAttemptAt: string }): Promise<void> { await this.update({ ...input, at: input.nextAttemptAt }, "failed", input.errorCode, input.nextAttemptAt); }
  async releaseApplicationClaim(input: { acceptedResultId: string; owner: string }): Promise<void> { await this.update({ ...input, at: new Date().toISOString() }, "release"); }

  private async update(input: { acceptedResultId: string; owner: string; at: string }, action: string, errorCode: string | null = null, nextAttemptAt: string | null = null): Promise<void> {
    const { data, error } = await this.client.rpc("update_mission_execution_result_application_atomic", { p_accepted_result_id: input.acceptedResultId, p_owner: input.owner, p_action: action, p_now: input.at, p_error_code: errorCode, p_next_attempt_at: nextAttemptAt });
    if (error) throw new Error(`Failed to update accepted Mission execution result application: ${error.message}`);
    const outcome = data as { ok?: unknown; reason?: unknown } | null;
    if (!outcome || outcome.ok !== true) {
      const reason = typeof outcome?.reason === "string" ? outcome.reason : "claim_not_owned";
      throw new Error(`Accepted Mission execution result application update refused: ${reason}`);
    }
  }

  private mapRow(row: Record<string, unknown>): AcceptedExecutionResult {
    if (typeof row.accepted_result_id !== "string" || typeof row.fencing_generation !== "string" && typeof row.fencing_generation !== "number") throw new Error("Malformed claimed Mission execution result row.");
    if (row.evidence_required !== null && typeof row.evidence_required !== "boolean") throw new Error("Malformed evidence requirement on claimed Mission execution result row.");
    return { acceptedResultId: row.accepted_result_id, workspaceId: String(row.workspace_id), missionId: String(row.mission_id), assignmentId: String(row.assignment_id), dispatchIntentId: String(row.dispatch_intent_id), dispatchKey: String(row.dispatch_key), executionId: String(row.execution_id), providerAdapterId: String(row.provider_adapter_id), leaseId: String(row.lease_id), fencingGeneration: String(row.fencing_generation), executionAttempt: Number(row.execution_attempt), resultKind: row.result_kind as AcceptedExecutionResult["resultKind"], resultDigest: String(row.result_digest), metadata: row.metadata as AcceptedExecutionResult["metadata"], evidenceDescriptors: row.evidence_descriptors as AcceptedExecutionResult["evidenceDescriptors"], evidenceRequired: row.evidence_required as boolean | null, correlationId: String(row.correlation_id), causationId: row.causation_id === null ? null : String(row.causation_id), retryCount: Number(row.retry_count), lifecycleAppliedAt: row.lifecycle_applied_at === null ? null : String(row.lifecycle_applied_at), evidenceAppliedAt: row.evidence_applied_at === null ? null : String(row.evidence_applied_at) };
  }
}
