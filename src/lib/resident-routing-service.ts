import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { createRoutedAssignment } from "@/lib/assignment-service";
import { decideAssistanceApproval, routeAssistanceRequest, type ResidentRoutingCandidate } from "@/lib/resident-routing";
import type { ResidentProvider } from "@/lib/resident-launch-contract";
import { queueLaunchGrant } from "@/lib/resident-grant-service";
import type { CoordinationIntent } from "@/lib/coordination-value-gate";
import type { AgentModelTier, AgentTaskClass } from "@/lib/agent-task-routing";

function service() {
  if (!supabase) throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  return supabase;
}

export interface RoutedAssistanceInput {
  dispatchId: string;
  task: string;
  repositoryBindingId: string;
  explicitTargetConnectionId: string | null;
  preferredProvider: ResidentProvider | null;
  requiredCapabilities: string[];
  allowedPaths: string[];
  prohibitedPaths: string[];
  maxDurationMs: number;
  maxEstimatedTokens: number | null;
  maxAddedLatencyMs: number;
  coordinationIntent: CoordinationIntent;
  objectiveSuccessCriteria: string[];
  taskClass: AgentTaskClass;
  modelTier: AgentModelTier;
  requiresHumanApproval: boolean;
  delegationDepth: number;
}

export interface RoutedAssistanceOutcome {
  status: "assigned" | "human_approval_required" | "no_eligible_resident";
  routingReason: string;
  targetConnectionId: string | null;
  residentInstanceId: string | null;
  assignmentId: string | null;
}

type AuthorizationRow = {
  id: string;
  resident_instance_id: string;
  target_connection_id: string;
  provider: ResidentProvider;
  repository_binding_id: string;
  repository: string;
  capabilities: string[] | null;
  approval_policy: "human_before_start" | "preauthorized_bounded";
  max_duration_ms: number;
  max_estimated_tokens: number | null;
  max_delegation_depth: number;
  created_by: string;
};

type RoutedRequestPacket = {
  task: string;
  requiredCapabilities: string[];
  allowedPaths: string[];
  prohibitedPaths: string[];
  maxDurationMs: number;
  maxEstimatedTokens: number | null;
  maxAddedLatencyMs: number;
  coordinationIntent: CoordinationIntent;
  objectiveSuccessCriteria?: string[];
  taskClass?: AgentTaskClass;
  modelTier?: AgentModelTier;
  delegationDepth: number;
};

function taskWithSuccessCriteria(task: string, criteria: string[] = []): string {
  return criteria.length > 0 ? `${task} Acceptance: ${criteria.join("; ")}`.slice(0, 500) : task;
}

/** Read authorization and lease state, route deterministically, then deliver only preauthorized bounded work. */
export async function routeAssistanceForAgent(agent: AuthedAgent, input: RoutedAssistanceInput): Promise<RoutedAssistanceOutcome> {
  const db = service();
  const { data: authorizationData, error: authorizationError } = await db
    .from("resident_provider_authorizations")
    .select("id, resident_instance_id, target_connection_id, provider, repository_binding_id, repository, capabilities, approval_policy, max_duration_ms, max_estimated_tokens, max_delegation_depth, created_by")
    .eq("workspace_id", agent.workspaceId)
    .eq("repository_binding_id", input.repositoryBindingId)
    .is("revoked_at", null);
  if (authorizationError) throw new AgentJoinError("Could not read resident authorizations.", "RESIDENT_ROUTING_FAILED", 500);
  const authorizations = (authorizationData ?? []) as AuthorizationRow[];
  const residentIds = [...new Set(authorizations.map((row) => row.resident_instance_id))];
  if (residentIds.length === 0) return noEligible(input.dispatchId, agent.workspaceId, db);

  const { data: residentData, error: residentError } = await db.from("resident_instances")
    .select("id, connection_id, provider, capabilities, lease_expires_at")
    .eq("workspace_id", agent.workspaceId).in("id", residentIds).is("revoked_at", null);
  if (residentError) throw new AgentJoinError("Could not read resident leases.", "RESIDENT_ROUTING_FAILED", 500);

  const { data: activeData, error: activeError } = await db.from("launch_grants").select("resident_instance_id")
    .eq("workspace_id", agent.workspaceId).in("resident_instance_id", residentIds)
    .in("state", ["claimed", "launching", "running", "returning"]);
  if (activeError) throw new AgentJoinError("Could not read resident workload.", "RESIDENT_ROUTING_FAILED", 500);
  const activeCounts = new Map<string, number>();
  for (const row of activeData ?? []) activeCounts.set(row.resident_instance_id, (activeCounts.get(row.resident_instance_id) ?? 0) + 1);
  const residentById = new Map((residentData ?? []).map((resident) => [resident.id, resident]));
  const authorizationByCandidate = new Map<string, AuthorizationRow>();
  const candidates: ResidentRoutingCandidate[] = authorizations.flatMap((authorization) => {
    const resident = residentById.get(authorization.resident_instance_id);
    if (!resident || resident.connection_id !== authorization.target_connection_id || resident.provider !== authorization.provider) return [];
    authorizationByCandidate.set(`${resident.id}:${authorization.target_connection_id}`, authorization);
    return [{
      connectionId: authorization.target_connection_id,
      residentInstanceId: resident.id,
      provider: authorization.provider,
      repositoryBindingId: authorization.repository_binding_id,
      capabilities: authorization.capabilities ?? [],
      leaseExpiresAt: resident.lease_expires_at ?? "",
      authorizationActive: true,
      maxDelegationDepth: authorization.max_delegation_depth,
      activeLaunches: activeCounts.get(resident.id) ?? 0,
    }];
  });

  const routing = routeAssistanceRequest({
    requestingConnectionId: agent.connectionId,
    explicitTargetConnectionId: input.explicitTargetConnectionId,
    preferredProvider: input.preferredProvider,
    repositoryBindingId: input.repositoryBindingId,
    requiredCapabilities: input.requiredCapabilities,
    delegationDepth: input.delegationDepth,
  }, candidates);
  if (!routing.ok || !routing.selected) return noEligible(input.dispatchId, agent.workspaceId, db, routing.reason);

  const selectedAuthorization = authorizationByCandidate.get(`${routing.selected.residentInstanceId}:${routing.selected.connectionId}`)!;
  const approval = decideAssistanceApproval({
    maxDurationMs: input.maxDurationMs,
    maxEstimatedTokens: input.maxEstimatedTokens,
    delegationDepth: input.delegationDepth,
  }, {
    approvalPolicy: selectedAuthorization.approval_policy,
    maxDurationMs: selectedAuthorization.max_duration_ms,
    maxEstimatedTokens: selectedAuthorization.max_estimated_tokens,
    maxDelegationDepth: selectedAuthorization.max_delegation_depth,
  });
  const routingRequest: RoutedRequestPacket = {
    task: input.task,
    requiredCapabilities: input.requiredCapabilities,
    allowedPaths: input.allowedPaths,
    prohibitedPaths: input.prohibitedPaths,
    maxDurationMs: input.maxDurationMs,
    maxEstimatedTokens: input.maxEstimatedTokens,
    maxAddedLatencyMs: input.maxAddedLatencyMs,
    coordinationIntent: input.coordinationIntent,
    objectiveSuccessCriteria: input.objectiveSuccessCriteria,
    taskClass: input.taskClass,
    modelTier: input.modelTier,
    delegationDepth: input.delegationDepth,
  };
  const deliveredTask = taskWithSuccessCriteria(input.task, input.objectiveSuccessCriteria);
  if (input.requiresHumanApproval || approval.decision !== "preauthorized") {
    const { error: pendingError } = await db.from("dispatches").update({
      target_connection_id: routing.selected.connectionId,
      resident_instance_id: routing.selected.residentInstanceId,
      routing_reason: routing.reason,
      routing_request: routingRequest,
      approval_state: "pending",
    }).eq("id", input.dispatchId).eq("workspace_id", agent.workspaceId);
    if (pendingError) throw new AgentJoinError("Could not retain the routing approval decision.", "ROUTING_RECORD_FAILED", 500);
    return {
      status: "human_approval_required",
      routingReason: routing.reason,
      targetConnectionId: routing.selected.connectionId,
      residentInstanceId: routing.selected.residentInstanceId,
      assignmentId: null,
    };
  }

  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const assignment = await createRoutedAssignment({
    workspaceId: agent.workspaceId,
    requestingConnectionId: agent.connectionId,
    targetConnectionId: routing.selected.connectionId,
    residentInstanceId: routing.selected.residentInstanceId,
    dispatchId: input.dispatchId,
    createdBy: selectedAuthorization.created_by,
    requiredCapabilities: input.requiredCapabilities,
    assignment: {
      repository: selectedAuthorization.repository,
      task: deliveredTask,
      scope: input.allowedPaths,
      prohibitedScope: input.prohibitedPaths,
      maxDurationMs: input.maxDurationMs,
      maxEstimatedTokens: input.maxEstimatedTokens,
      approvalPolicy: "preauthorized_bounded",
      evidenceRequired: true,
      expiresAt,
    },
  });
  const launchGrantId = await queueLaunchGrant({
    workspaceId: agent.workspaceId,
    assignmentId: assignment.id,
    requestingConnectionId: agent.connectionId,
    targetConnectionId: routing.selected.connectionId,
    residentInstanceId: routing.selected.residentInstanceId,
    authorizationId: selectedAuthorization.id,
    provider: selectedAuthorization.provider,
    repository: selectedAuthorization.repository,
    repositoryBindingId: selectedAuthorization.repository_binding_id,
    task: deliveredTask,
    requiredCapabilities: input.requiredCapabilities,
    allowedPaths: input.allowedPaths,
    prohibitedPaths: input.prohibitedPaths,
    maxDurationMs: input.maxDurationMs,
    maxEstimatedTokens: input.maxEstimatedTokens,
    modelTier: input.modelTier,
    delegationDepth: input.delegationDepth,
    approvalPolicy: "preauthorized_bounded",
    expiresAt,
  });
  const { error: dispatchError } = await db.from("dispatches").update({
    target_connection_id: routing.selected.connectionId,
    resident_instance_id: routing.selected.residentInstanceId,
    routing_reason: routing.reason,
    routing_request: routingRequest,
    approval_state: "approved",
    assignment_id: assignment.id,
    launch_grant_id: launchGrantId,
  }).eq("id", input.dispatchId).eq("workspace_id", agent.workspaceId);
  if (dispatchError) throw new AgentJoinError("Assignment was created, but its Dispatch routing record could not be updated.", "ROUTING_RECORD_FAILED", 500);
  return {
    status: "assigned",
    routingReason: routing.reason,
    targetConnectionId: routing.selected.connectionId,
    residentInstanceId: routing.selected.residentInstanceId,
    assignmentId: assignment.id,
  };
}

async function dashboardUser() {
  const db = await createClient();
  if (!db) throw new AgentJoinError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new AgentJoinError("Authentication required.", "AUTH_REQUIRED", 401);
  return { db, user };
}

/** Owner approval materializes and delivers the pending routed assignment exactly once. */
export async function approveRoutedAssistanceForDashboard(dispatchId: string) {
  const { db, user } = await dashboardUser();
  const serviceDb = service();
  const { data: dispatch, error } = await db.from("dispatches")
    .select("id, workspace_id, run_id, target_connection_id, resident_instance_id, approval_state, routing_request")
    .eq("id", dispatchId).maybeSingle();
  if (error || !dispatch) throw new AgentJoinError("Pending assistance request not found.", "DISPATCH_NOT_FOUND", 404);
  if (dispatch.approval_state === "approved") {
    const { data: existing } = await db.from("agent_assignments").select("*").eq("dispatch_id", dispatchId).maybeSingle();
    if (existing) return existing;
  }
  if (dispatch.approval_state !== "pending" || !dispatch.target_connection_id || !dispatch.resident_instance_id || !dispatch.routing_request) {
    throw new AgentJoinError("Assistance request is not awaiting approval.", "INVALID_ROUTING_STATE", 409);
  }
  const packet = dispatch.routing_request as RoutedRequestPacket;
  const { data: authorization } = await db.from("resident_provider_authorizations")
    .select("id, provider, repository, repository_binding_id, created_by, max_duration_ms, max_estimated_tokens, max_delegation_depth, revoked_at")
    .eq("workspace_id", dispatch.workspace_id).eq("resident_instance_id", dispatch.resident_instance_id)
    .eq("target_connection_id", dispatch.target_connection_id).maybeSingle();
  if (!authorization || authorization.revoked_at || authorization.created_by !== user.id) {
    throw new AgentJoinError("Resident authorization is no longer active.", "AUTHORIZATION_REVOKED", 409);
  }
  if (packet.maxDurationMs > authorization.max_duration_ms
    || packet.delegationDepth > authorization.max_delegation_depth
    || (packet.maxEstimatedTokens !== null && (authorization.max_estimated_tokens === null || packet.maxEstimatedTokens > authorization.max_estimated_tokens))) {
    throw new AgentJoinError("Assistance request exceeds the current authorization boundary.", "AUTHORIZATION_BOUNDARY_EXCEEDED", 409);
  }
  const { data: run } = await db.from("agent_runs").select("connection_id").eq("id", dispatch.run_id)
    .eq("workspace_id", dispatch.workspace_id).maybeSingle();
  if (!run) throw new AgentJoinError("Requesting run was not found.", "RUN_NOT_FOUND", 404);
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const assignment = await createRoutedAssignment({
    workspaceId: dispatch.workspace_id,
    requestingConnectionId: run.connection_id,
    targetConnectionId: dispatch.target_connection_id,
    residentInstanceId: dispatch.resident_instance_id,
    dispatchId,
    createdBy: user.id,
    requiredCapabilities: packet.requiredCapabilities,
    assignment: {
      repository: authorization.repository,
      task: taskWithSuccessCriteria(packet.task, packet.objectiveSuccessCriteria),
      scope: packet.allowedPaths,
      prohibitedScope: packet.prohibitedPaths,
      maxDurationMs: packet.maxDurationMs,
      maxEstimatedTokens: packet.maxEstimatedTokens,
      approvalPolicy: "human_before_start",
      evidenceRequired: true,
      expiresAt,
    },
  });
  const launchGrantId = await queueLaunchGrant({
    workspaceId: dispatch.workspace_id,
    assignmentId: assignment.id,
    requestingConnectionId: run.connection_id,
    targetConnectionId: dispatch.target_connection_id,
    residentInstanceId: dispatch.resident_instance_id,
    authorizationId: authorization.id,
    provider: authorization.provider as ResidentProvider,
    repository: authorization.repository,
    repositoryBindingId: authorization.repository_binding_id,
    task: taskWithSuccessCriteria(packet.task, packet.objectiveSuccessCriteria),
    requiredCapabilities: packet.requiredCapabilities,
    allowedPaths: packet.allowedPaths,
    prohibitedPaths: packet.prohibitedPaths,
    maxDurationMs: packet.maxDurationMs,
    maxEstimatedTokens: packet.maxEstimatedTokens,
    modelTier: packet.modelTier ?? "balanced",
    delegationDepth: packet.delegationDepth,
    approvalPolicy: "human_before_start",
    expiresAt,
  });
  const { data: updatedDispatch, error: updateError } = await serviceDb.from("dispatches")
    .update({ approval_state: "approved", assignment_id: assignment.id, launch_grant_id: launchGrantId })
    .eq("id", dispatchId).eq("workspace_id", dispatch.workspace_id).eq("approval_state", "pending")
    .select("id, approval_state, assignment_id, launch_grant_id").maybeSingle();
  if (updateError || !updatedDispatch) {
    const { data: concurrentlyApproved } = await serviceDb.from("dispatches")
      .select("id, approval_state, assignment_id, launch_grant_id")
      .eq("id", dispatchId).eq("workspace_id", dispatch.workspace_id).maybeSingle();
    const sameApproval = concurrentlyApproved?.approval_state === "approved"
      && concurrentlyApproved.assignment_id === assignment.id
      && concurrentlyApproved.launch_grant_id === launchGrantId;
    if (!sameApproval) {
      console.error("Could not record assistance approval:", updateError?.code ?? "state_mismatch", updateError?.message ?? "dispatch approval did not match");
      throw new AgentJoinError("Could not record assistance approval.", "ROUTING_RECORD_FAILED", updateError ? 500 : 409);
    }
  }
  return assignment;
}

export async function rejectRoutedAssistanceForDashboard(dispatchId: string) {
  const { db } = await dashboardUser();
  const { data: owned } = await db.from("dispatches").select("id, workspace_id, approval_state").eq("id", dispatchId).maybeSingle();
  if (!owned) throw new AgentJoinError("Pending assistance request not found.", "DISPATCH_NOT_FOUND", 404);
  const { data, error } = await service().from("dispatches").update({ approval_state: "rejected", resolution_state: "resolved" })
    .eq("id", dispatchId).eq("workspace_id", owned.workspace_id).eq("approval_state", "pending").select("id, approval_state").maybeSingle();
  if (error || !data) throw new AgentJoinError("Pending assistance request not found.", "DISPATCH_NOT_FOUND", 404);
  return data;
}

async function noEligible(dispatchId: string, workspaceId: string, db: ReturnType<typeof service>, reason = "no_eligible_resident"): Promise<RoutedAssistanceOutcome> {
  const { error } = await db.from("dispatches").update({ routing_reason: reason, approval_state: "not_applicable" }).eq("id", dispatchId).eq("workspace_id", workspaceId);
  if (error) {
    console.error("Could not retain resident routing outcome:", error.code, error.message);
    throw new AgentJoinError("Could not retain the routing outcome.", "ROUTING_RECORD_FAILED", 500);
  }
  return { status: "no_eligible_resident", routingReason: reason, targetConnectionId: null, residentInstanceId: null, assignmentId: null };
}
