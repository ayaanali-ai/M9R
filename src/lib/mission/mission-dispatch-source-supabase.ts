import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { DispatchLease } from "./mission-scheduler";
import type { MissionDispatchSource, MissionDispatchSourceCandidate, MissionDispatchProjectionView } from "./mission-runtime-worker";

type CandidateRow = {
  workspace_id: string; mission_id: string; repository_id: string | null; mission_state: MissionDispatchProjectionView["state"];
  mission_source_version: number; assignment_id: string; dispatch_key: string; adapter_requirement: string | null; assignment_source_version: number; lease: DispatchLease | null;
};

/** Service-role-only bounded source backed by the runtime dispatch index RPC. */
export class SupabaseMissionDispatchSource implements MissionDispatchSource {
  constructor(private readonly client: SupabaseClient, private readonly workspaceIds: readonly string[]) {}

  async listWorkspaces(): Promise<string[]> { return [...new Set(this.workspaceIds)].sort(); }

  async listCandidates(input: { workspaceId: string; limit: number }): Promise<MissionDispatchSourceCandidate[]> {
    if (!this.workspaceIds.includes(input.workspaceId)) throw new Error("Mission dispatch source refused an unconfigured workspace.");
    const { data, error } = await this.client.rpc("list_mission_runtime_dispatch_candidates", { p_workspace_id: input.workspaceId, p_limit: input.limit });
    if (error) throw new Error(`Failed to list bounded Mission dispatch candidates: ${error.message}`);
    return ((data ?? []) as CandidateRow[]).map((row): MissionDispatchSourceCandidate => {
      const projection: MissionDispatchProjectionView = {
        missionId: row.mission_id,
        workspaceId: row.workspace_id,
        repositoryId: row.repository_id,
        state: row.mission_state,
      };
      return {
        projection,
        assignmentId: row.assignment_id,
        dispatchKey: row.dispatch_key,
        adapterRequirement: row.adapter_requirement,
        executionConstraints: { assignmentId: row.assignment_id, expectedAssignmentSourceVersion: row.assignment_source_version },
        lease: row.lease,
      };
    });
  }
}

export function createSupabaseMissionDispatchSource(workspaceIds: readonly string[]): SupabaseMissionDispatchSource {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabaseMissionDispatchSource(supabase, workspaceIds);
}
