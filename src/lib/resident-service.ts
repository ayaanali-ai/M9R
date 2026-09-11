import { supabase } from "@/lib/supabase";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { acceptResidentHeartbeat, validateLaunchEventSubmission, validateResidentRegistration } from "@/lib/resident-service-contract";
import type { LaunchState } from "@/lib/resident-launch-contract";
import { redactSession } from "@/lib/session-redaction";
import { buildBoundedDiffManifest } from "@/lib/resident-write-isolation";

function db() {
  if (!supabase) throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  return supabase;
}

function requireResidentScope(agent: AuthedAgent): void {
  if (!agent.scopes.includes("session:submit")) throw new AgentJoinError("Token lacks resident scope.", "FORBIDDEN", 403);
}

export async function registerResident(agent: AuthedAgent, payload: unknown) {
  requireResidentScope(agent);
  const checked = validateResidentRegistration(payload, agent.agentKind);
  if (!checked.ok || !checked.registration) throw new AgentJoinError("Invalid resident registration.", checked.reason ?? "BAD_RESIDENT", 400);
  const { data: existing, error: lookupError } = await db().from("resident_instances").select("connection_id, heartbeat_sequence, lease_expires_at, revoked_at")
    .eq("workspace_id", agent.workspaceId).eq("instance_key", checked.registration.instanceKey).maybeSingle();
  if (lookupError) throw new AgentJoinError("Could not verify resident identity.", "RESIDENT_REGISTER_FAILED", 500);
  // A resident's connection_id rotates across reconnects (a fresh local
  // token/claim gets a new agent_connections row), so the SAME instance key
  // legitimately shows up under a different connection_id on every restart.
  // Only an instance whose lease is still live is actually "another
  // connection" worth conflicting on -- one whose lease already expired (or
  // was explicitly revoked) is just a dead registration nobody is renewing,
  // and blocking a real reconnect behind it made a resident permanently
  // unable to come back once its lease lapsed once. Confirmed live: codex
  // and opencode residents stuck in a 409 loop for days off a lease that
  // expired within minutes of being written.
  const existingIsLive = Boolean(existing) && !existing!.revoked_at && Date.parse(existing!.lease_expires_at ?? "") > Date.now();
  if (existingIsLive && existing!.connection_id !== agent.connectionId) {
    throw new AgentJoinError("Resident instance key is already bound to another connection.", "RESIDENT_KEY_CONFLICT", 409);
  }
  const now = new Date().toISOString();
  const lease = new Date(Date.parse(now) + 90_000).toISOString();
  const residentRecord = {
    workspace_id: agent.workspaceId,
    connection_id: agent.connectionId,
    instance_key: checked.registration.instanceKey,
    provider: checked.registration.provider,
    capabilities: checked.registration.capabilities,
    lease_expires_at: lease,
    last_seen_at: now,
    revoked_at: null,
    updated_at: now,
  };
  // Matched on workspace_id+instance_key alone (not also connection_id) so a
  // reconnect that legitimately changed connection_id -- the case just
  // cleared above -- actually overwrites the stale row instead of the WHERE
  // clause silently matching nothing and falling through to a duplicate
  // insert that the unique index then rejects.
  const write = existing
    ? db().from("resident_instances").update(residentRecord)
        .eq("workspace_id", agent.workspaceId).eq("instance_key", checked.registration.instanceKey)
        .select("id, lease_expires_at, heartbeat_sequence").single()
    : db().from("resident_instances").insert(residentRecord).select("id, lease_expires_at, heartbeat_sequence").single();
  const { data, error } = await write;
  if (error?.code === "23505") throw new AgentJoinError("Resident instance key was claimed concurrently.", "RESIDENT_KEY_CONFLICT", 409);
  if (error || !data) throw new AgentJoinError("Could not register resident.", "RESIDENT_REGISTER_FAILED", 500);
  return {
    residentInstanceId: data.id as string,
    leaseExpiresAt: data.lease_expires_at as string,
    heartbeatSequence: Number(data.heartbeat_sequence ?? 0),
  };
}

export async function heartbeatResident(agent: AuthedAgent, payload: unknown) {
  requireResidentScope(agent);
  const instanceKey = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>).instanceKey : null;
  if (typeof instanceKey !== "string") throw new AgentJoinError("Resident instance key is required.", "BAD_RESIDENT", 400);
  const { data: resident } = await db().from("resident_instances").select("id, heartbeat_sequence")
    .eq("workspace_id", agent.workspaceId).eq("connection_id", agent.connectionId).eq("instance_key", instanceKey).is("revoked_at", null).maybeSingle();
  if (!resident) throw new AgentJoinError("Resident is not active.", "RESIDENT_INACTIVE", 403);
  const now = new Date().toISOString();
  const accepted = acceptResidentHeartbeat(payload, { now, previousSequence: Number(resident.heartbeat_sequence ?? 0) });
  if (!accepted.ok) throw new AgentJoinError("Resident heartbeat was rejected.", accepted.reason === "sequence_not_newer" ? "HEARTBEAT_REPLAY" : "BAD_HEARTBEAT", accepted.reason === "sequence_not_newer" ? 409 : 400);
  const { data, error } = await db().rpc("record_resident_heartbeat_atomic", {
    p_resident_instance_id: resident.id,
    p_workspace_id: agent.workspaceId,
    p_connection_id: agent.connectionId,
    p_sequence: accepted.sequence,
    p_seen_at: now,
    p_lease_expires_at: accepted.leaseExpiresAt,
  });
  const result = Array.isArray(data) ? data[0] as { accepted?: boolean } | undefined : null;
  if (error || !result?.accepted) throw new AgentJoinError("Resident heartbeat was rejected.", "HEARTBEAT_REPLAY", 409);
  return { residentInstanceId: resident.id as string, sequence: accepted.sequence, leaseExpiresAt: accepted.leaseExpiresAt };
}

export async function listResidentGrants(agent: AuthedAgent, instanceKey: string) {
  requireResidentScope(agent);
  const { data: resident } = await db().from("resident_instances").select("id, lease_expires_at")
    .eq("workspace_id", agent.workspaceId).eq("connection_id", agent.connectionId).eq("instance_key", instanceKey).is("revoked_at", null).maybeSingle();
  if (!resident || Date.parse(resident.lease_expires_at ?? "") <= Date.now()) throw new AgentJoinError("Resident is offline.", "RESIDENT_INACTIVE", 403);
  const { data, error } = await db().from("launch_grants")
    .select("id, protocol_version, provider, repository, repository_binding_id, task, required_capabilities, allowed_paths, prohibited_paths, max_duration_ms, max_estimated_tokens, model_tier, delegation_depth, approval_policy, state, expires_at")
    .eq("workspace_id", agent.workspaceId).eq("resident_instance_id", resident.id).in("state", ["authorized", "queued"]).gt("expires_at", new Date().toISOString()).order("created_at");
  if (error) throw new AgentJoinError("Could not read resident grants.", "GRANT_READ_FAILED", 500);
  return { residentInstanceId: resident.id as string, grants: data ?? [] };
}

export async function claimResidentGrant(agent: AuthedAgent, grantId: string, instanceKey: string) {
  requireResidentScope(agent);
  const { data, error } = await db().rpc("claim_resident_launch_grant_atomic", {
    p_launch_grant_id: grantId,
    p_workspace_id: agent.workspaceId,
    p_connection_id: agent.connectionId,
    p_instance_key: instanceKey,
    p_claimed_at: new Date().toISOString(),
  });
  const result = Array.isArray(data) ? data[0] as { accepted?: boolean; reason?: string; sequence?: number } | undefined : null;
  if (error || !result?.accepted) throw new AgentJoinError("Launch grant could not be claimed.", result?.reason === "already_claimed" ? "GRANT_ALREADY_CLAIMED" : "GRANT_CLAIM_REJECTED", 409);
  return result;
}

export async function recordResidentLaunchEvent(agent: AuthedAgent, grantId: string, instanceKey: string, payload: unknown) {
  requireResidentScope(agent);
  const { data: grant } = await db().from("launch_grants").select("state, resident_instance_id")
    .eq("id", grantId).eq("workspace_id", agent.workspaceId).eq("target_connection_id", agent.connectionId).maybeSingle();
  if (!grant) throw new AgentJoinError("Launch grant was not found.", "GRANT_NOT_FOUND", 404);
  const { data: resident } = await db().from("resident_instances").select("id")
    .eq("id", grant.resident_instance_id).eq("connection_id", agent.connectionId).eq("instance_key", instanceKey).is("revoked_at", null).maybeSingle();
  if (!resident) throw new AgentJoinError("Resident is not authorized for this grant.", "RESIDENT_INACTIVE", 403);
  const { data: latest } = await db().from("launch_events").select("sequence").eq("launch_grant_id", grantId).order("sequence", { ascending: false }).limit(1).maybeSingle();
  const checked = validateLaunchEventSubmission(payload, grant.state as LaunchState, Number(latest?.sequence ?? 0));
  if (!checked.ok) throw new AgentJoinError("Launch event was rejected.", checked.reason ?? "BAD_EVENT", checked.reason === "sequence_not_newer" ? 409 : 400);
  const { data, error } = await db().rpc("record_resident_launch_event_atomic", {
    p_launch_grant_id: grantId,
    p_workspace_id: agent.workspaceId,
    p_connection_id: agent.connectionId,
    p_instance_key: instanceKey,
    p_event_type: checked.event,
    p_expected_from_state: grant.state,
    p_to_state: checked.nextState,
    p_sequence: checked.sequence,
    p_occurred_at: new Date().toISOString(),
    p_payload: checked.resultText
      ? {
          result_text: redactSession(checked.resultText).redactedText,
          // Real usage the provider CLI reported on its own JSON events — never estimated. Null fields mean unknown.
          ...(checked.usage ? { usage: checked.usage } : {}),
          ...(checked.modelTier ? { model_tier: checked.modelTier, requested_model: checked.requestedModel } : {}),
          ...(checked.reportedModel ? { reported_model: checked.reportedModel } : {}),
        }
      : checked.failureCode ? { failure_code: checked.failureCode } : {},
  });
  const result = Array.isArray(data) ? data[0] as { accepted?: boolean; reason?: string } | undefined : null;
  if (error || !result?.accepted) throw new AgentJoinError("Launch event was rejected.", "EVENT_CONFLICT", 409);
  return { ...result, state: checked.nextState };
}

export async function upsertResidentDiffManifest(agent: AuthedAgent, grantId: string, instanceKey: string, payload: unknown) {
  requireResidentScope(agent);
  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const { data: grant } = await db().from("launch_grants").select("id, workspace_id, target_connection_id, resident_instance_id, allowed_paths, prohibited_paths")
    .eq("id", grantId).eq("workspace_id", agent.workspaceId).eq("target_connection_id", agent.connectionId).maybeSingle();
  if (!grant) throw new AgentJoinError("Launch grant was not found.", "GRANT_NOT_FOUND", 404);
  const { data: resident } = await db().from("resident_instances").select("id").eq("id", grant.resident_instance_id)
    .eq("connection_id", agent.connectionId).eq("instance_key", instanceKey).is("revoked_at", null).maybeSingle();
  if (!resident) throw new AgentJoinError("Resident is not authorized for this grant.", "RESIDENT_INACTIVE", 403);
  try {
    const manifest = buildBoundedDiffManifest({ grantId, baseCommit: String(body.baseCommit ?? ""), headCommit: String(body.headCommit ?? ""),
      allowedPaths: grant.allowed_paths as string[], prohibitedPaths: grant.prohibited_paths as string[], changes: body.changes as never });
    const { data, error } = await db().from("launch_diff_reviews").upsert({ workspace_id: agent.workspaceId, launch_grant_id: grantId,
      manifest, manifest_digest: manifest.digest, decision: "pending", decided_by: null, decided_at: null }, { onConflict: "launch_grant_id,manifest_digest", ignoreDuplicates: true })
      .select("id, manifest_digest, decision").single();
    if (error || !data) throw new Error("write failed");
    return { review: data, manifest, writeEnabled: false };
  } catch { throw new AgentJoinError("Diff manifest is invalid or unbounded.", "BAD_DIFF_MANIFEST", 400); }
}

export async function getResidentDiffReview(agent: AuthedAgent, grantId: string, instanceKey: string) {
  requireResidentScope(agent);
  const { data: grant } = await db().from("launch_grants").select("resident_instance_id").eq("id", grantId).eq("workspace_id", agent.workspaceId).eq("target_connection_id", agent.connectionId).maybeSingle();
  if (!grant) throw new AgentJoinError("Launch grant was not found.", "GRANT_NOT_FOUND", 404);
  const { data: resident } = await db().from("resident_instances").select("id").eq("id", grant.resident_instance_id).eq("connection_id", agent.connectionId).eq("instance_key", instanceKey).is("revoked_at", null).maybeSingle();
  if (!resident) throw new AgentJoinError("Resident is not authorized for this grant.", "RESIDENT_INACTIVE", 403);
  const { data, error } = await db().from("launch_diff_reviews").select("id, manifest, manifest_digest, decision, decided_at").eq("launch_grant_id", grantId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new AgentJoinError("Could not read diff review.", "DIFF_REVIEW_READ_FAILED", 500);
  return { review: data ?? null, writeEnabled: data?.decision === "approved" && data.manifest?.digest === data.manifest_digest };
}
