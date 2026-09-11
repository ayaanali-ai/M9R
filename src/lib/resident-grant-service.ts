import { createHash, randomBytes } from "node:crypto";
import { supabase } from "@/lib/supabase";
import type { ResidentProvider } from "@/lib/resident-launch-contract";
import type { AgentModelTier } from "@/lib/agent-task-routing";

type DbClient = NonNullable<typeof supabase>;

export function launchGrantIdempotencyKey(assignmentId: string): string {
  if (typeof assignmentId !== "string" || assignmentId.trim().length < 8 || assignmentId.length > 100) throw new Error("Assignment id is invalid.");
  return `assignment:${assignmentId.trim()}:launch:v1`;
}

export async function queueLaunchGrant(input: {
  db?: DbClient;
  workspaceId: string;
  assignmentId: string;
  requestingConnectionId: string;
  targetConnectionId: string;
  residentInstanceId: string;
  authorizationId: string;
  provider: ResidentProvider;
  repository: string;
  repositoryBindingId: string;
  task: string;
  requiredCapabilities: string[];
  allowedPaths: string[];
  prohibitedPaths: string[];
  maxDurationMs: number;
  maxEstimatedTokens: number | null;
  modelTier: AgentModelTier;
  delegationDepth: number;
  approvalPolicy: "human_before_start" | "preauthorized_bounded";
  expiresAt: string;
}): Promise<string> {
  const db = input.db ?? supabase;
  if (!db) throw new Error("M9R agent backend is not configured.");
  // Claim authority is the authenticated, exact resident identity checked by the
  // atomic RPC. This discarded nonce digest is retained only for protocol
  // compatibility; no raw claim credential exists to leak or replay.
  const claimTokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  const { data, error } = await db.rpc("create_resident_launch_grant_v2_atomic", {
    p_workspace_id: input.workspaceId,
    p_assignment_id: input.assignmentId,
    p_requesting_connection_id: input.requestingConnectionId,
    p_target_connection_id: input.targetConnectionId,
    p_resident_instance_id: input.residentInstanceId,
    p_authorization_id: input.authorizationId,
    p_provider: input.provider,
    p_repository: input.repository,
    p_repository_binding_id: input.repositoryBindingId,
    p_task: input.task,
    p_required_capabilities: input.requiredCapabilities,
    p_allowed_paths: input.allowedPaths,
    p_prohibited_paths: input.prohibitedPaths,
    p_max_duration_ms: input.maxDurationMs,
    p_max_estimated_tokens: input.maxEstimatedTokens,
    p_model_tier: input.modelTier,
    p_delegation_depth: input.delegationDepth,
    p_approval_policy: input.approvalPolicy,
    p_idempotency_key: launchGrantIdempotencyKey(input.assignmentId),
    p_claim_token_hash: claimTokenHash,
    p_issued_at: new Date().toISOString(),
    p_expires_at: input.expiresAt,
  });
  const result = Array.isArray(data) ? data[0] as { launch_grant_id?: string; accepted?: boolean; reason?: string } | undefined : null;
  if (error || !result?.accepted || !result.launch_grant_id) {
    const reason = error?.code ?? result?.reason ?? "unknown_queue_failure";
    throw Object.assign(new Error(`Could not queue the resident launch grant (${reason}).`), {
      code: "LAUNCH_GRANT_QUEUE_FAILED",
      status: 503,
    });
  }
  return result.launch_grant_id;
}
