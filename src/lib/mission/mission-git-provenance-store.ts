import { supabase } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GitOperationResult, MissionGitProvenanceRecord } from "./mission-git-provenance";

export interface MissionGitProvenanceReader {
  list(input: { workspaceId: string; missionId: string; limit?: number }): Promise<MissionGitProvenanceRecord[]>;
}

export interface MissionGitProvenanceWriter {
  record(input: MissionGitProvenanceRecord): Promise<MissionGitProvenanceRecord>;
  recordResult(input: { workspaceId: string; missionId: string; operationId: string; candidateDigest: string; result: GitOperationResult }): Promise<MissionGitProvenanceRecord | null>;
}

export class SupabaseMissionGitProvenanceReader implements MissionGitProvenanceReader, MissionGitProvenanceWriter {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(input: { workspaceId: string; missionId: string; limit?: number }): Promise<MissionGitProvenanceRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const { data, error } = await this.client
      .from("mission_git_provenance")
      .select("operation_id, operation, workspace_id, mission_id, assignment_id, participant_id, branch, commit_sha, candidate_digest, manifest_digest, status, authorization_attestation, operation_result, recorded_at")
      .eq("workspace_id", input.workspaceId)
      .eq("mission_id", input.missionId)
      .order("recorded_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Failed to list Mission Git provenance: ${error.message}`);
    return (data ?? []).map((row) => fromRow(row as Record<string, unknown>));
  }

  async record(input: MissionGitProvenanceRecord): Promise<MissionGitProvenanceRecord> {
    const { data, error } = await this.client.from("mission_git_provenance").upsert({
      operation_id: input.operationId,
      workspace_id: input.workspaceId,
      mission_id: input.missionId,
      assignment_id: input.assignmentId,
      participant_id: input.participantId,
      operation: input.operation,
      branch: input.branch,
      commit_sha: input.commitSha,
      candidate_digest: input.candidateDigest,
      manifest_digest: input.manifestDigest,
      status: input.status,
      authorization_attestation: input.authorization,
      recorded_at: input.recordedAt,
      operation_result: input.result,
    }, { onConflict: "operation_id" }).select("operation_id, operation, workspace_id, mission_id, assignment_id, participant_id, branch, commit_sha, candidate_digest, manifest_digest, status, authorization_attestation, operation_result, recorded_at").single();
    if (error) throw new Error(`Failed to record Mission Git provenance: ${error.message}`);
    return fromRow(data as Record<string, unknown>);
  }

  async recordResult(input: { workspaceId: string; missionId: string; operationId: string; candidateDigest: string; result: GitOperationResult }): Promise<MissionGitProvenanceRecord | null> {
    const { data, error } = await this.client.from("mission_git_provenance")
      .update({ status: input.result.outcome === "succeeded" ? "completed" : "failed", operation_result: input.result })
      .eq("operation_id", input.operationId)
      .eq("workspace_id", input.workspaceId)
      .eq("mission_id", input.missionId)
      .eq("candidate_digest", input.candidateDigest)
      .eq("status", "recorded")
      .select("operation_id, operation, workspace_id, mission_id, assignment_id, participant_id, branch, commit_sha, candidate_digest, manifest_digest, status, authorization_attestation, operation_result, recorded_at")
      .maybeSingle();
    if (error) throw new Error(`Failed to record Mission Git operation result: ${error.message}`);
    return data ? fromRow(data as Record<string, unknown>) : null;
  }
}

function fromRow(row: Record<string, unknown>): MissionGitProvenanceRecord {
  return {
      operationId: String(row.operation_id),
      operation: String(row.operation) as MissionGitProvenanceRecord["operation"],
      workspaceId: String(row.workspace_id),
      missionId: String(row.mission_id),
      assignmentId: String(row.assignment_id),
      participantId: String(row.participant_id),
      branch: String(row.branch),
      commitSha: String(row.commit_sha),
      candidateDigest: String(row.candidate_digest),
      manifestDigest: String(row.manifest_digest),
      status: String(row.status) as MissionGitProvenanceRecord["status"],
      authorization: row.authorization_attestation && typeof row.authorization_attestation === "object" ? row.authorization_attestation as MissionGitProvenanceRecord["authorization"] : null,
      result: row.operation_result && typeof row.operation_result === "object" ? row.operation_result as MissionGitProvenanceRecord["result"] : null,
      recordedAt: String(row.recorded_at),
  };
}

export function createSupabaseMissionGitProvenanceReader(): SupabaseMissionGitProvenanceReader {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabaseMissionGitProvenanceReader(supabase);
}
