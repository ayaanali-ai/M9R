import { createClient } from "@/lib/supabase/server";
import { supabase } from "@/lib/supabase";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { applyAssignmentDecision, checkAssignmentCompletionLinkage, checkAssignmentRuntimeConstraints, validateAssignment, type AssignmentDecision, type AssignmentInput, type AssignmentState } from "@/lib/assignment";

function service() {
  if (!supabase) throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  return supabase;
}

async function humanClient() {
  const db = await createClient();
  if (!db) throw new AgentJoinError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new AgentJoinError("Authentication required.", "AUTH_REQUIRED", 401);
  return { db, user };
}

export async function createAssignmentForDashboard(targetConnectionId: string, input: AssignmentInput) {
  const { db, user } = await humanClient();
  const { data: connection, error: connectionError } = await db.from("agent_connections")
    .select("id, workspace_id, repo_hint, status").eq("id", targetConnectionId).maybeSingle();
  if (connectionError || !connection || connection.status !== "active") throw new AgentJoinError("Active target agent not found.", "TARGET_NOT_FOUND", 404);
  const checked = validateAssignment(input);
  if (!checked.ok || !checked.assignment) throw new AgentJoinError(checked.errors.join(" "), "INVALID_ASSIGNMENT", 400);
  const a = checked.assignment;
  if (connection.repo_hint && a.repository !== connection.repo_hint) throw new AgentJoinError("Assignment repository must match the connected agent repository.", "REPOSITORY_MISMATCH", 400);
  const { data, error } = await db.from("agent_assignments").insert({
    workspace_id: connection.workspace_id, target_connection_id: connection.id, created_by: user.id,
    version: a.version, repository: a.repository, task: a.task, scope: a.scope,
    prohibited_scope: a.prohibitedScope, max_duration_ms: a.maxDurationMs,
    max_estimated_tokens: a.maxEstimatedTokens, approval_policy: a.approvalPolicy,
    evidence_required: a.evidenceRequired, state: a.state, expires_at: a.expiresAt,
  }).select("*").single();
  if (error || !data) throw new AgentJoinError("Could not create assignment.", "ASSIGNMENT_CREATE_FAILED", 500);
  const { error: deliveryError } = await db.from("agent_instructions").insert({
    workspace_id: connection.workspace_id, connection_id: connection.id,
    assignment_id: data.id, instruction: `Assignment ${data.id}: ${a.task}`,
  });
  if (deliveryError) {
    await db.from("agent_assignments").delete().eq("id", data.id);
    throw new AgentJoinError("Could not deliver assignment.", "ASSIGNMENT_DELIVERY_FAILED", 500);
  }
  return data;
}

export async function createRoutedAssignment(input: {
  workspaceId: string;
  requestingConnectionId: string;
  targetConnectionId: string;
  residentInstanceId: string;
  dispatchId: string;
  createdBy: string;
  requiredCapabilities: string[];
  assignment: AssignmentInput;
}) {
  const checked = validateAssignment(input.assignment);
  if (!checked.ok || !checked.assignment) throw new AgentJoinError(checked.errors.join(" "), "INVALID_ASSIGNMENT", 400);
  const a = checked.assignment;
  const db = service();
  const { data: existing, error: existingError } = await db.from("agent_assignments").select("*")
    .eq("workspace_id", input.workspaceId).eq("dispatch_id", input.dispatchId).maybeSingle();
  if (existingError) throw new AgentJoinError("Could not check routed assignment idempotency.", "ASSIGNMENT_CREATE_FAILED", 500);
  if (existing) return existing;
  const { data, error } = await db.from("agent_assignments").insert({
    workspace_id: input.workspaceId,
    requesting_connection_id: input.requestingConnectionId,
    target_connection_id: input.targetConnectionId,
    resident_instance_id: input.residentInstanceId,
    dispatch_id: input.dispatchId,
    created_by: input.createdBy,
    required_capabilities: input.requiredCapabilities,
    version: a.version,
    repository: a.repository,
    task: a.task,
    scope: a.scope,
    prohibited_scope: a.prohibitedScope,
    max_duration_ms: a.maxDurationMs,
    max_estimated_tokens: a.maxEstimatedTokens,
    approval_policy: a.approvalPolicy,
    evidence_required: a.evidenceRequired,
    state: a.state,
    expires_at: a.expiresAt,
  }).select("*").single();
  if (error?.code === "23505") {
    const { data: concurrent } = await db.from("agent_assignments").select("*")
      .eq("workspace_id", input.workspaceId).eq("dispatch_id", input.dispatchId).maybeSingle();
    if (concurrent) return concurrent;
  }
  if (error || !data) throw new AgentJoinError("Could not create routed assignment.", "ASSIGNMENT_CREATE_FAILED", 500);
  const { error: deliveryError } = await db.from("agent_instructions").insert({
    workspace_id: input.workspaceId,
    connection_id: input.targetConnectionId,
    assignment_id: data.id,
    instruction: `Assignment ${data.id}: ${a.task}`,
  });
  if (deliveryError) {
    await db.from("agent_assignments").delete().eq("id", data.id);
    throw new AgentJoinError("Could not deliver routed assignment.", "ASSIGNMENT_DELIVERY_FAILED", 500);
  }
  return data;
}

export async function listAssignmentsForDashboard() {
  const { db } = await humanClient();
  await sweepExpiredAssignments();
  const { data, error } = await db.from("agent_assignments").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) throw error;
  return data ?? [];
}

export async function listAssignmentsForAgent(agent: AuthedAgent) {
  await sweepExpiredAssignments();
  const { data, error } = await service().from("agent_assignments").select("*")
    .eq("workspace_id", agent.workspaceId).eq("target_connection_id", agent.connectionId)
    .in("state", ["requested", "accepted"]).order("created_at", { ascending: true }).limit(100);
  if (error) throw error;
  return data ?? [];
}

export async function transitionAssignmentForAgent(agent: AuthedAgent, id: string, decision: AssignmentDecision, evidenceRecordId?: string, runId?: string) {
  const db = service();
  const { data: current, error } = await db.from("agent_assignments").select("*").eq("id", id)
    .eq("workspace_id", agent.workspaceId).eq("target_connection_id", agent.connectionId).maybeSingle();
  if (error || !current) throw new AgentJoinError("Assignment not found.", "ASSIGNMENT_NOT_FOUND", 404);
  const runtime = checkAssignmentRuntimeConstraints({
    decision,
    expiresAt: current.expires_at,
    acceptedAt: current.accepted_at,
    maxDurationMs: current.max_duration_ms,
  });
  if (!runtime.ok) {
    await db.from("agent_assignments").update({ state: "expired", cancelled_at: new Date().toISOString() })
      .eq("id", id).eq("workspace_id", agent.workspaceId).eq("target_connection_id", agent.connectionId)
      .eq("state", current.state).in("state", ["requested", "accepted"]);
    throw new AgentJoinError(
      runtime.reason === "duration_exceeded" ? "Assignment duration was exceeded." : "Assignment expired before this decision.",
      runtime.reason === "duration_exceeded" ? "ASSIGNMENT_DURATION_EXCEEDED" : "ASSIGNMENT_EXPIRED",
      409,
    );
  }
  const next = applyAssignmentDecision(current.state as AssignmentState, decision);
  if (!next.ok) throw new AgentJoinError(next.reason ?? "Invalid transition.", "INVALID_TRANSITION", 409);
  if (decision === "complete" && current.evidence_required && !evidenceRecordId) throw new AgentJoinError("Completion evidence is required.", "EVIDENCE_REQUIRED", 400);
  let evidence: { id: string; workspace_id: string; run_id: string; created_at: string | null } | null = null;
  if (evidenceRecordId) {
    const { data } = await db.from("evidence_records").select("id, workspace_id, run_id, created_at").eq("id", evidenceRecordId).eq("workspace_id", agent.workspaceId).maybeSingle();
    evidence = data;
    if (!evidence) throw new AgentJoinError("Evidence record not found in this workspace.", "EVIDENCE_NOT_FOUND", 400);
    if (runId && evidence.run_id !== runId) throw new AgentJoinError("Evidence does not belong to the supplied run.", "EVIDENCE_RUN_MISMATCH", 400);
  }
  let run: { id: string; started_at: string | null } | null = null;
  if (runId) {
    const { data } = await db.from("agent_runs").select("id, started_at").eq("id", runId).eq("workspace_id", agent.workspaceId).eq("connection_id", agent.connectionId).maybeSingle();
    run = data;
    if (!run) throw new AgentJoinError("Run does not belong to the assigned agent.", "RUN_MISMATCH", 400);
  }
  if (decision === "complete" && runId && evidenceRecordId && run && evidence) {
    const linkage = checkAssignmentCompletionLinkage({
      acceptedAt: current.accepted_at,
      runId,
      runStartedAt: run.started_at,
      evidenceRunId: evidence.run_id,
      evidenceCreatedAt: evidence.created_at,
    });
    if (!linkage.ok) {
      throw new AgentJoinError("Run and evidence must be created for this assignment after acceptance.", "ASSIGNMENT_LINKAGE_MISMATCH", 400);
    }
    const { data: reused } = await db.from("agent_assignments").select("id").neq("id", id)
      .or(`run_id.eq.${runId},evidence_record_id.eq.${evidenceRecordId}`).limit(1).maybeSingle();
    if (reused) throw new AgentJoinError("Run or evidence is already linked to another assignment.", "ASSIGNMENT_EVIDENCE_REUSED", 409);
  }
  const timestamps = next.state === "accepted" ? { accepted_at: new Date().toISOString() } : next.state === "completed" ? { completed_at: new Date().toISOString() } : { cancelled_at: new Date().toISOString() };
  const { data: updated, error: updateError } = await db.from("agent_assignments").update({ state: next.state, evidence_record_id: evidenceRecordId ?? null, run_id: runId ?? null, ...timestamps })
    .eq("id", id).eq("workspace_id", agent.workspaceId).eq("target_connection_id", agent.connectionId)
    .eq("state", current.state).select("*").maybeSingle();
  if (updateError || !updated) throw new AgentJoinError("Assignment changed concurrently.", "ASSIGNMENT_CONFLICT", 409);
  return updated;
}

export async function cancelAssignmentForDashboard(id: string) {
  const { db } = await humanClient();
  const { data: current } = await db.from("agent_assignments").select("state").eq("id", id).maybeSingle();
  if (!current) throw new AgentJoinError("Assignment not found.", "ASSIGNMENT_NOT_FOUND", 404);
  const next = applyAssignmentDecision(current.state as AssignmentState, "cancel");
  if (!next.ok) throw new AgentJoinError(next.reason ?? "Invalid transition.", "INVALID_TRANSITION", 409);
  const { data, error } = await db.from("agent_assignments").update({ state: next.state, cancelled_at: new Date().toISOString() }).eq("id", id).eq("state", current.state).select("*").maybeSingle();
  if (error || !data) throw new AgentJoinError("Assignment changed concurrently.", "ASSIGNMENT_CONFLICT", 409);
  return data;
}

export async function sweepExpiredAssignments(now = new Date().toISOString()) {
  const { data, error } = await service().from("agent_assignments").update({ state: "expired", cancelled_at: now })
    .in("state", ["requested", "accepted"]).lt("expires_at", now).select("id");
  if (error) throw error;
  return data?.length ?? 0;
}
