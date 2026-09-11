import { createClient } from "@/lib/supabase/server";
import { AgentJoinError } from "@/lib/agent-join-service";
import { AGENT_KIND_SLUG_PATTERN } from "@/lib/agent-join";

async function ownerClient() {
  const db = await createClient();
  if (!db) throw new AgentJoinError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new AgentJoinError("Authentication required.", "AUTH_REQUIRED", 401);
  return { db, user };
}

function boundedCapabilities(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 25) return null;
  const capabilities = value.map((item) => typeof item === "string" ? item.trim() : "");
  return capabilities.every((item) => item.length > 0 && item.length <= 100) ? [...new Set(capabilities)] : null;
}

export async function listResidentAuthorizations() {
  const { db } = await ownerClient();
  const [{ data: residents, error: residentError }, { data: authorizations, error: authorizationError }] = await Promise.all([
    db.from("resident_instances").select("id, workspace_id, connection_id, instance_key, provider, capabilities, lease_expires_at, last_seen_at, revoked_at").order("created_at", { ascending: false }).limit(100),
    db.from("resident_provider_authorizations").select("id, workspace_id, resident_instance_id, target_connection_id, provider, repository_binding_id, repository, capabilities, approval_policy, max_duration_ms, max_estimated_tokens, max_delegation_depth, revoked_at, created_at").order("created_at", { ascending: false }).limit(100),
  ]);
  if (residentError || authorizationError) throw new AgentJoinError("Could not read resident authorizations.", "RESIDENT_AUTH_READ_FAILED", 500);
  return { residents: residents ?? [], authorizations: authorizations ?? [] };
}

export async function createResidentAuthorization(input: {
  residentInstanceId?: unknown;
  repositoryBindingId?: unknown;
  capabilities?: unknown;
  approvalPolicy?: unknown;
  maxDurationMs?: unknown;
  maxEstimatedTokens?: unknown;
  maxDelegationDepth?: unknown;
}) {
  const { db, user } = await ownerClient();
  const residentInstanceId = typeof input.residentInstanceId === "string" ? input.residentInstanceId.trim() : "";
  const repositoryBindingId = typeof input.repositoryBindingId === "string" ? input.repositoryBindingId.trim() : "";
  const capabilities = boundedCapabilities(input.capabilities);
  const approvalPolicy = input.approvalPolicy === "human_before_start" || input.approvalPolicy === "preauthorized_bounded" ? input.approvalPolicy : null;
  const maxDurationMs = Number(input.maxDurationMs);
  const maxEstimatedTokens = input.maxEstimatedTokens == null ? null : Number(input.maxEstimatedTokens);
  const maxDelegationDepth = Number(input.maxDelegationDepth);
  if (residentInstanceId.length < 8 || repositoryBindingId.length < 8 || repositoryBindingId.length > 100 || !capabilities || !approvalPolicy
    || !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1_000 || maxDurationMs > 86_400_000
    || (maxEstimatedTokens !== null && (!Number.isSafeInteger(maxEstimatedTokens) || maxEstimatedTokens < 1 || maxEstimatedTokens > 1_000_000))
    || !Number.isSafeInteger(maxDelegationDepth) || maxDelegationDepth < 0 || maxDelegationDepth > 1) {
    throw new AgentJoinError("Resident authorization is invalid or unbounded.", "BAD_RESIDENT_AUTHORIZATION", 400);
  }
  const { data: resident } = await db.from("resident_instances")
    .select("id, workspace_id, connection_id, provider, capabilities, revoked_at")
    .eq("id", residentInstanceId).maybeSingle();
  if (!resident || resident.revoked_at || typeof resident.provider !== "string" || !AGENT_KIND_SLUG_PATTERN.test(resident.provider)) throw new AgentJoinError("Active resident was not found.", "RESIDENT_NOT_FOUND", 404);
  const residentCapabilities = new Set((resident.capabilities ?? []) as string[]);
  if (capabilities.some((capability) => !residentCapabilities.has(capability))) throw new AgentJoinError("Authorization capabilities exceed the resident declaration.", "CAPABILITY_MISMATCH", 400);
  const { data: connection } = await db.from("agent_connections").select("id, workspace_id, repo_hint, status")
    .eq("id", resident.connection_id).eq("workspace_id", resident.workspace_id).maybeSingle();
  if (!connection || connection.status !== "active" || !connection.repo_hint) throw new AgentJoinError("Resident connection has no active repository binding.", "CONNECTION_NOT_READY", 409);
  const { data, error } = await db.from("resident_provider_authorizations").upsert({
    workspace_id: resident.workspace_id,
    resident_instance_id: resident.id,
    target_connection_id: resident.connection_id,
    provider: resident.provider,
    repository_binding_id: repositoryBindingId,
    repository: connection.repo_hint,
    capabilities,
    approval_policy: approvalPolicy,
    max_duration_ms: maxDurationMs,
    max_estimated_tokens: maxEstimatedTokens,
    max_delegation_depth: maxDelegationDepth,
    revoked_at: null,
    created_by: user.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: "workspace_id,resident_instance_id,target_connection_id,repository_binding_id" }).select("*").single();
  if (error || !data) throw new AgentJoinError("Could not save resident authorization.", "RESIDENT_AUTH_WRITE_FAILED", 500);
  return data;
}

export async function revokeResidentAuthorization(id: string) {
  const { db } = await ownerClient();
  const { data, error } = await db.from("resident_provider_authorizations")
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id).is("revoked_at", null).select("id, revoked_at").maybeSingle();
  if (error || !data) throw new AgentJoinError("Active resident authorization was not found.", "RESIDENT_AUTH_NOT_FOUND", 404);
  return data;
}
