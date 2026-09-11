import { createHash, randomUUID } from "node:crypto";
import { supabase } from "@/lib/supabase";
import {
  canTransitionGoalStatus,
  parseGoalContract,
  type GoalBudget,
  type GoalContract,
  type GoalStatus,
} from "./goal-contract";
import type { AuthedAgent } from "@/lib/agent-join-service";
import { isRecentlySeenConnection } from "@/lib/agent-dashboard-presenter";
import type { MissionPrincipal } from "@/lib/mission/mission-principal";
import { createMission, getMission, startMission, type MissionSummaryDto } from "@/lib/mission/mission-application-service";
import { buildGoalWorkforceProposal, type GoalWorkforceProposal, type WorkforceCandidateInput } from "./goal-workforce";
import { parseContextPacket, type ContextPacket } from "./context-packet";
import { parseCompletionReceipt, type CompletionReceipt } from "./completion-receipt";

export type GoalApiErrorCode =
  | "backend_not_configured"
  | "validation_error"
  | "principal_mismatch"
  | "parent_goal_not_found"
  | "goal_not_found"
  | "idempotency_conflict"
  | "goal_read_failed"
  | "goal_create_failed"
  | "goal_status_conflict"
  | "human_required"
  | "repository_target_missing"
  | "workforce_read_failed"
  | "mission_dispatch_failed"
  | "context_packet_principal_mismatch"
  | "context_packet_create_failed"
  | "context_packet_read_failed"
  | "receipt_principal_mismatch"
  | "receipt_goal_mismatch"
  | "receipt_create_failed"
  | "receipt_read_failed";

export class GoalApiError extends Error {
  readonly code: GoalApiErrorCode;
  readonly status: number;
  readonly detail?: Record<string, unknown>;

  constructor(message: string, code: GoalApiErrorCode, status: number, detail?: Record<string, unknown>) {
    super(message);
    this.name = "GoalApiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export interface GoalSummaryDto {
  id: string;
  workspaceId: string;
  principalId: string;
  principalKind: GoalContract["goal"]["principalKind"];
  clientRequestId: string;
  title: string;
  objective: string;
  successConditions: string[];
  constraints: string[];
  allowedCapabilities: string[];
  providerPreferences: string[];
  autonomyPolicy: GoalContract["goal"]["autonomyPolicy"];
  budget: GoalBudget;
  deadline: string | null;
  parentGoalId: string | null;
  contextRefs: string[];
  status: GoalStatus;
  currentMissionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalEventDto {
  id: string;
  goalId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  actorKind: string;
  actorId: string;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
}

type GoalRow = {
  id: string;
  workspace_id: string;
  principal_id: string;
  principal_kind: GoalSummaryDto["principalKind"];
  client_request_id: string;
  title: string;
  objective: string;
  success_conditions: string[];
  constraints: string[];
  allowed_capabilities: string[];
  provider_preferences: string[];
  autonomy_policy: GoalSummaryDto["autonomyPolicy"];
  budget: GoalBudget;
  deadline: string | null;
  parent_goal_id: string | null;
  context_refs: string[];
  status: GoalStatus;
  current_mission_id: string | null;
  created_at: string;
  updated_at: string;
};

function requireService() {
  if (!supabase) throw new GoalApiError("M9R is not configured.", "backend_not_configured", 503);
  return supabase;
}

function digestContract(contract: GoalContract): string {
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

function toSummary(row: GoalRow): GoalSummaryDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    principalKind: row.principal_kind,
    clientRequestId: row.client_request_id,
    title: row.title,
    objective: row.objective,
    successConditions: row.success_conditions ?? [],
    constraints: row.constraints ?? [],
    allowedCapabilities: row.allowed_capabilities ?? [],
    providerPreferences: row.provider_preferences ?? [],
    autonomyPolicy: row.autonomy_policy,
    budget: row.budget,
    deadline: row.deadline,
    parentGoalId: row.parent_goal_id,
    contextRefs: row.context_refs ?? [],
    status: row.status,
    currentMissionId: row.current_mission_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const GOAL_COLUMNS = [
  "id",
  "workspace_id",
  "principal_id",
  "principal_kind",
  "client_request_id",
  "title",
  "objective",
  "success_conditions",
  "constraints",
  "allowed_capabilities",
  "provider_preferences",
  "autonomy_policy",
  "budget",
  "deadline",
  "parent_goal_id",
  "context_refs",
  "status",
  "current_mission_id",
  "created_at",
  "updated_at",
].join(", ");

function validatePrincipal(agent: AuthedAgent, contract: GoalContract): void {
  const { principalId, principalKind } = contract.goal;
  if (principalId !== agent.connectionId || ["personal_agent", "workspace_agent", "provider_agent"].includes(principalKind) === false) {
    throw new GoalApiError(
      "The Goal principal must be this authenticated agent connection.",
      "principal_mismatch",
      403,
    );
  }
}

async function loadGoalForWorkspace(workspaceId: string, goalId: string): Promise<GoalSummaryDto> {
  const db = requireService();
  const { data, error } = await db
    .from("goals")
    .select(GOAL_COLUMNS)
    .eq("id", goalId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) {
    console.error("loadGoalForWorkspace failed:", error.message, error.code);
    throw new GoalApiError("Could not read the Goal.", "goal_read_failed", 500);
  }
  if (!data) throw new GoalApiError("Goal was not found.", "goal_not_found", 404);
  return toSummary(data as unknown as GoalRow);
}

export async function createGoal(agent: AuthedAgent, input: unknown): Promise<GoalSummaryDto> {
  const validation = parseGoalContract(input);
  if (!validation.ok) {
    throw new GoalApiError("Goal contract is invalid.", "validation_error", 400, { issues: validation.errors });
  }
  const contract = validation.value;
  validatePrincipal(agent, contract);

  const db = requireService();
  if (contract.goal.parentGoalId) {
    const { data: parent, error: parentError } = await db
      .from("goals")
      .select("id")
      .eq("id", contract.goal.parentGoalId)
      .eq("workspace_id", agent.workspaceId)
      .maybeSingle();
    if (parentError) {
      throw new GoalApiError("Could not resolve the parent Goal.", "goal_create_failed", 500);
    }
    if (!parent) throw new GoalApiError("Parent Goal was not found.", "parent_goal_not_found", 404);
  }

  const goalId = randomUUID();
  const correlationId = `goal:${goalId}`;
  const { data, error } = await db.rpc("create_goal_atomic", {
    p_workspace_id: agent.workspaceId,
    p_goal_id: goalId,
    p_principal_id: contract.goal.principalId,
    p_principal_kind: contract.goal.principalKind,
    p_client_request_id: contract.goal.clientRequestId,
    p_request_digest: digestContract(contract),
    p_title: contract.goal.title,
    p_objective: contract.goal.objective,
    p_success_conditions: contract.goal.successConditions,
    p_constraints: contract.goal.constraints,
    p_allowed_capabilities: contract.goal.allowedCapabilities,
    p_provider_preferences: contract.goal.providerPreferences,
    p_autonomy_policy: contract.goal.autonomyPolicy,
    p_budget: contract.goal.budget,
    p_deadline: contract.goal.deadline,
    p_parent_goal_id: contract.goal.parentGoalId,
    p_context_refs: contract.goal.contextRefs,
    p_contract: contract,
    p_actor_kind: "agent",
    p_actor_id: agent.connectionId,
    p_correlation_id: correlationId,
    p_created_by_connection_id: agent.connectionId,
    p_created_by_user_id: null,
  });
  if (error) {
    console.error("createGoal atomic RPC failed:", error.message, error.code);
    throw new GoalApiError("Could not create the Goal.", "goal_create_failed", 500);
  }

  const result = (Array.isArray(data) ? data[0] : data) as { result?: string; goal_id?: string } | null;
  if (!result?.goal_id) throw new GoalApiError("Could not create the Goal.", "goal_create_failed", 500);
  if (result.result === "idempotency_conflict") {
    throw new GoalApiError("This request id was already used for a different Goal.", "idempotency_conflict", 409);
  }

  return getGoal(agent, result.goal_id);
}

export async function getGoal(agent: AuthedAgent, goalId: string): Promise<GoalSummaryDto> {
  return loadGoalForWorkspace(agent.workspaceId, goalId);
}

export async function listGoals(agent: AuthedAgent, limit = 20): Promise<GoalSummaryDto[]> {
  const db = requireService();
  const boundedLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 20, 1), 100);
  const { data, error } = await db
    .from("goals")
    .select(GOAL_COLUMNS)
    .eq("workspace_id", agent.workspaceId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(boundedLimit);
  if (error) {
    console.error("listGoals failed:", error.message, error.code);
    throw new GoalApiError("Could not list Goals.", "goal_read_failed", 500);
  }
  return ((data ?? []) as unknown as GoalRow[]).map(toSummary);
}

export async function getGoalEvents(agent: AuthedAgent, goalId: string): Promise<GoalEventDto[]> {
  await getGoal(agent, goalId);
  const db = requireService();
  const { data, error } = await db
    .from("goal_events")
    .select("id, goal_id, sequence, event_type, payload, actor_kind, actor_id, correlation_id, causation_id, occurred_at")
    .eq("goal_id", goalId)
    .eq("workspace_id", agent.workspaceId)
    .order("sequence", { ascending: true })
    .limit(200);
  if (error) {
    console.error("getGoalEvents failed:", error.message, error.code);
    throw new GoalApiError("Could not read Goal events.", "goal_read_failed", 500);
  }
  return ((data ?? []) as Array<{
    id: string;
    goal_id: string;
    sequence: number;
    event_type: string;
    payload: Record<string, unknown>;
    actor_kind: string;
    actor_id: string;
    correlation_id: string;
    causation_id: string | null;
    occurred_at: string;
  }>).map((event) => ({
    id: event.id,
    goalId: event.goal_id,
    sequence: event.sequence,
    type: event.event_type,
    payload: event.payload,
    actorKind: event.actor_kind,
    actorId: event.actor_id,
    correlationId: event.correlation_id,
    causationId: event.causation_id,
    occurredAt: event.occurred_at,
  }));
}

function missionPrincipalForAgent(agent: AuthedAgent): MissionPrincipal {
  return {
    actor: { kind: "agent", id: agent.connectionId },
    workspaceId: agent.workspaceId,
    kind: "agent",
    userId: null,
    agent,
  };
}

async function transitionGoal(
  workspaceId: string,
  goalId: string,
  expectedStatus: GoalStatus,
  nextStatus: GoalStatus,
  eventType: string,
  payload: Record<string, unknown>,
  actor: { kind: "human" | "agent" | "system"; id: string },
  currentMissionId: string | null = null,
): Promise<GoalSummaryDto> {
  const current = await loadGoalForWorkspace(workspaceId, goalId);
  if (current.status !== expectedStatus || !canTransitionGoalStatus(expectedStatus, nextStatus)) {
    throw new GoalApiError(
      `Goal is in state "${current.status}" and cannot move to "${nextStatus}".`,
      "goal_status_conflict",
      409,
      { status: current.status, expectedStatus, nextStatus },
    );
  }

  const db = requireService();
  const { data, error } = await db.rpc("transition_goal_atomic", {
    p_workspace_id: workspaceId,
    p_goal_id: goalId,
    p_expected_status: expectedStatus,
    p_next_status: nextStatus,
    p_event_type: eventType,
    p_payload: payload,
    p_actor_kind: actor.kind,
    p_actor_id: actor.id,
    p_correlation_id: `goal:${goalId}:${eventType}`,
    p_current_mission_id: currentMissionId,
  });
  if (error) {
    console.error("transitionGoal atomic RPC failed:", error.message, error.code);
    throw new GoalApiError("Could not transition the Goal.", "goal_create_failed", 500);
  }
  const result = (Array.isArray(data) ? data[0] : data) as { result?: string; status?: string } | null;
  if (result?.result === "status_conflict") {
    throw new GoalApiError("Goal changed while this request was in flight.", "goal_status_conflict", 409);
  }
  if (result?.result === "not_found") throw new GoalApiError("Goal was not found.", "goal_not_found", 404);
  if (result?.result !== "applied") throw new GoalApiError("Could not transition the Goal.", "goal_create_failed", 500);
  return loadGoalForWorkspace(workspaceId, goalId);
}

/** Human-only approval gate. A personal agent can propose, but cannot approve itself. */
export async function authorizeGoal(principal: MissionPrincipal, goalId: string): Promise<GoalSummaryDto> {
  if (principal.kind !== "human" || !principal.userId) {
    throw new GoalApiError("Only a signed-in human can authorize a Goal.", "human_required", 403);
  }
  return transitionGoal(
    principal.workspaceId,
    goalId,
    "proposed",
    "authorized",
    "goal.authorized",
    { authorization: "human" },
    { kind: "human", id: principal.userId },
  );
}

export interface GoalMissionDispatchResult {
  goal: GoalSummaryDto;
  mission: MissionSummaryDto;
}

export interface GoalWorkforceProposalResult {
  goal: GoalSummaryDto;
  proposal: GoalWorkforceProposal;
}

export type GoalContextPacketDto = ContextPacket & { goalId: string; persistedAt: string };

export type GoalCompletionReceiptDto = CompletionReceipt & { persistedAt: string };

type ContextPacketRow = {
  goal_id: string;
  packet_id: string;
  source_principal_id: string;
  source_agent_id: string;
  intended_recipient_principal_id: string | null;
  purpose: string;
  content_ref: string;
  sensitivity: ContextPacket["packet"]["sensitivity"];
  allowed_transformations: string[];
  redaction_status: ContextPacket["packet"]["redactionStatus"];
  digest: string;
  expires_at: string | null;
  created_at: string;
};

function toContextPacket(row: ContextPacketRow): GoalContextPacketDto {
  return {
    version: "m9r.context_packet.v1",
    packet: {
      id: row.packet_id,
      sourcePrincipalId: row.source_principal_id,
      sourceAgentId: row.source_agent_id,
      intendedRecipientPrincipalId: row.intended_recipient_principal_id,
      purpose: row.purpose,
      contentRef: row.content_ref,
      sensitivity: row.sensitivity,
      allowedTransformations: row.allowed_transformations ?? [],
      redactionStatus: row.redaction_status,
      digest: row.digest,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    },
    goalId: row.goal_id,
    persistedAt: row.created_at,
  };
}

type CompletionReceiptRow = {
  receipt_id: string;
  goal_id: string;
  mission_id: string | null;
  status: CompletionReceipt["receipt"]["status"];
  conditions: CompletionReceipt["receipt"]["conditions"];
  evidence: CompletionReceipt["receipt"]["evidence"];
  agent_ids: string[];
  provider_ids: string[];
  approvals: string[];
  unresolved_risks: string[];
  decisions_required: string[];
  context_packet_ids: string[];
  started_at: string | null;
  completed_at: string | null;
  generated_at: string;
  created_at: string;
};

function toCompletionReceipt(row: CompletionReceiptRow): GoalCompletionReceiptDto {
  return {
    version: "m9r.completion_receipt.v1",
    receipt: {
      receiptId: row.receipt_id,
      goalId: row.goal_id,
      missionId: row.mission_id,
      status: row.status,
      conditions: row.conditions ?? [],
      evidence: row.evidence ?? [],
      agentIds: row.agent_ids ?? [],
      providerIds: row.provider_ids ?? [],
      approvals: row.approvals ?? [],
      unresolvedRisks: row.unresolved_risks ?? [],
      decisionsRequired: row.decisions_required ?? [],
      contextPacketIds: row.context_packet_ids ?? [],
      startedAt: row.started_at,
      completedAt: row.completed_at,
      generatedAt: row.generated_at,
    },
    persistedAt: row.created_at,
  };
}

const CONTEXT_PACKET_COLUMNS = [
  "goal_id",
  "packet_id",
  "source_principal_id",
  "source_agent_id",
  "intended_recipient_principal_id",
  "purpose",
  "content_ref",
  "sensitivity",
  "allowed_transformations",
  "redaction_status",
  "digest",
  "expires_at",
  "created_at",
].join(", ");

const RECEIPT_COLUMNS = [
  "receipt_id",
  "goal_id",
  "mission_id",
  "status",
  "conditions",
  "evidence",
  "agent_ids",
  "provider_ids",
  "approvals",
  "unresolved_risks",
  "decisions_required",
  "context_packet_ids",
  "started_at",
  "completed_at",
  "generated_at",
  "created_at",
].join(", ");

async function requireOwnedGoal(agent: AuthedAgent, goalId: string): Promise<GoalSummaryDto> {
  const goal = await getGoal(agent, goalId);
  if (goal.principalId !== agent.connectionId) {
    throw new GoalApiError("This Goal is not assigned to the authenticated agent.", "principal_mismatch", 403);
  }
  return goal;
}

async function getContextPacket(agent: AuthedAgent, goalId: string, packetId: string): Promise<GoalContextPacketDto> {
  await requireOwnedGoal(agent, goalId);
  const db = requireService();
  const { data, error } = await db
    .from("goal_context_packets")
    .select(CONTEXT_PACKET_COLUMNS)
    .eq("workspace_id", agent.workspaceId)
    .eq("goal_id", goalId)
    .eq("packet_id", packetId)
    .maybeSingle();
  if (error) {
    console.error("getContextPacket failed:", error.message, error.code);
    throw new GoalApiError("Could not read the context packet.", "context_packet_read_failed", 500);
  }
  if (!data) throw new GoalApiError("Context packet was not found.", "context_packet_read_failed", 404);
  return toContextPacket(data as unknown as ContextPacketRow);
}

/** Persist a bounded reference to context; raw memory/transcripts never enter this route. */
export async function createContextPacket(agent: AuthedAgent, goalId: string, input: unknown): Promise<GoalContextPacketDto> {
  const goal = await requireOwnedGoal(agent, goalId);
  const validation = parseContextPacket(input);
  if (!validation.ok) {
    throw new GoalApiError("Context packet is invalid.", "validation_error", 400, { issues: validation.errors });
  }
  const packet = validation.value;
  if (packet.packet.sourcePrincipalId !== goal.principalId || packet.packet.sourceAgentId !== agent.connectionId) {
    throw new GoalApiError(
      "A context packet must identify the authenticated Goal principal and agent.",
      "context_packet_principal_mismatch",
      403,
    );
  }

  const db = requireService();
  const { data, error } = await db.rpc("create_goal_context_packet_atomic", {
    p_workspace_id: agent.workspaceId,
    p_goal_id: goalId,
    p_packet_id: packet.packet.id,
    p_source_principal_id: packet.packet.sourcePrincipalId,
    p_source_agent_id: packet.packet.sourceAgentId,
    p_intended_recipient_principal_id: packet.packet.intendedRecipientPrincipalId,
    p_purpose: packet.packet.purpose,
    p_content_ref: packet.packet.contentRef,
    p_sensitivity: packet.packet.sensitivity,
    p_allowed_transformations: packet.packet.allowedTransformations,
    p_redaction_status: packet.packet.redactionStatus,
    p_digest: packet.packet.digest,
    p_expires_at: packet.packet.expiresAt,
    p_actor_kind: "agent",
    p_actor_id: agent.connectionId,
    p_correlation_id: `goal:${goalId}:context:${packet.packet.id}`,
  });
  if (error) {
    console.error("createContextPacket atomic RPC failed:", error.message, error.code);
    throw new GoalApiError("Could not create the context packet.", "context_packet_create_failed", 500);
  }
  const result = (Array.isArray(data) ? data[0] : data) as { result?: string; packet_id?: string } | null;
  if (!result?.packet_id) throw new GoalApiError("Could not create the context packet.", "context_packet_create_failed", 500);
  if (result.result === "idempotency_conflict") {
    throw new GoalApiError("This packet id was already used for different context.", "idempotency_conflict", 409);
  }
  if (result.result === "not_found") throw new GoalApiError("Goal was not found.", "goal_not_found", 404);
  return getContextPacket(agent, goalId, result.packet_id);
}

export async function listContextPackets(agent: AuthedAgent, goalId: string): Promise<GoalContextPacketDto[]> {
  await requireOwnedGoal(agent, goalId);
  const db = requireService();
  const { data, error } = await db
    .from("goal_context_packets")
    .select(CONTEXT_PACKET_COLUMNS)
    .eq("workspace_id", agent.workspaceId)
    .eq("goal_id", goalId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(200);
  if (error) {
    console.error("listContextPackets failed:", error.message, error.code);
    throw new GoalApiError("Could not read context packets.", "context_packet_read_failed", 500);
  }
  return ((data ?? []) as unknown as ContextPacketRow[]).map(toContextPacket);
}

async function getCompletionReceipt(agent: AuthedAgent, goalId: string, receiptId: string): Promise<GoalCompletionReceiptDto> {
  await requireOwnedGoal(agent, goalId);
  const db = requireService();
  const { data, error } = await db
    .from("goal_completion_receipts")
    .select(RECEIPT_COLUMNS)
    .eq("workspace_id", agent.workspaceId)
    .eq("goal_id", goalId)
    .eq("receipt_id", receiptId)
    .maybeSingle();
  if (error) {
    console.error("getCompletionReceipt failed:", error.message, error.code);
    throw new GoalApiError("Could not read the completion receipt.", "receipt_read_failed", 500);
  }
  if (!data) throw new GoalApiError("Completion receipt was not found.", "receipt_read_failed", 404);
  return toCompletionReceipt(data as unknown as CompletionReceiptRow);
}

/** Store evidence-backed completion without silently completing or mutating the Goal. */
export async function submitCompletionReceipt(agent: AuthedAgent, goalId: string, input: unknown): Promise<GoalCompletionReceiptDto> {
  await requireOwnedGoal(agent, goalId);
  const validation = parseCompletionReceipt(input);
  if (!validation.ok) {
    throw new GoalApiError("Completion receipt is invalid.", "validation_error", 400, { issues: validation.errors });
  }
  const receipt = validation.value;
  if (receipt.receipt.goalId !== goalId) {
    throw new GoalApiError("Completion receipt Goal does not match the route.", "receipt_goal_mismatch", 400);
  }
  if (!receipt.receipt.agentIds.includes(agent.connectionId)) {
    throw new GoalApiError(
      "A completion receipt must identify the authenticated submitting agent.",
      "receipt_principal_mismatch",
      403,
    );
  }

  const receiptDigest = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  const db = requireService();
  const { data, error } = await db.rpc("create_goal_receipt_atomic", {
    p_workspace_id: agent.workspaceId,
    p_goal_id: goalId,
    p_receipt_id: receipt.receipt.receiptId,
    p_receipt_digest: receiptDigest,
    p_mission_id: receipt.receipt.missionId,
    p_status: receipt.receipt.status,
    p_conditions: receipt.receipt.conditions,
    p_evidence: receipt.receipt.evidence,
    p_agent_ids: receipt.receipt.agentIds,
    p_provider_ids: receipt.receipt.providerIds,
    p_approvals: receipt.receipt.approvals,
    p_unresolved_risks: receipt.receipt.unresolvedRisks,
    p_decisions_required: receipt.receipt.decisionsRequired,
    p_context_packet_ids: receipt.receipt.contextPacketIds,
    p_started_at: receipt.receipt.startedAt,
    p_completed_at: receipt.receipt.completedAt,
    p_generated_at: receipt.receipt.generatedAt,
    p_actor_kind: "agent",
    p_actor_id: agent.connectionId,
    p_correlation_id: `goal:${goalId}:receipt:${receipt.receipt.receiptId}`,
  });
  if (error) {
    console.error("submitCompletionReceipt atomic RPC failed:", error.message, error.code);
    throw new GoalApiError("Could not create the completion receipt.", "receipt_create_failed", 500);
  }
  const result = (Array.isArray(data) ? data[0] : data) as { result?: string; receipt_id?: string } | null;
  if (!result?.receipt_id) throw new GoalApiError("Could not create the completion receipt.", "receipt_create_failed", 500);
  if (result.result === "idempotency_conflict") {
    throw new GoalApiError("This receipt id was already used for different evidence.", "idempotency_conflict", 409);
  }
  if (result.result === "not_found") throw new GoalApiError("Goal was not found.", "goal_not_found", 404);
  return getCompletionReceipt(agent, goalId, result.receipt_id);
}

export async function listCompletionReceipts(agent: AuthedAgent, goalId: string): Promise<GoalCompletionReceiptDto[]> {
  await requireOwnedGoal(agent, goalId);
  const db = requireService();
  const { data, error } = await db
    .from("goal_completion_receipts")
    .select(RECEIPT_COLUMNS)
    .eq("workspace_id", agent.workspaceId)
    .eq("goal_id", goalId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(200);
  if (error) {
    console.error("listCompletionReceipts failed:", error.message, error.code);
    throw new GoalApiError("Could not read completion receipts.", "receipt_read_failed", 500);
  }
  return ((data ?? []) as unknown as CompletionReceiptRow[]).map(toCompletionReceipt);
}

/**
 * Return a live, workspace-scoped workforce proposal without mutating the
 * Mission. Ranking is advisory: selecting a worker still requires the
 * existing Mission participant/assignment boundary and human approval.
 */
export async function proposeGoalWorkforce(agent: AuthedAgent, goalId: string): Promise<GoalWorkforceProposalResult> {
  const goal = await getGoal(agent, goalId);
  if (goal.principalId !== agent.connectionId) {
    throw new GoalApiError("This Goal is not assigned to the authenticated agent.", "principal_mismatch", 403);
  }
  if (!(["authorized", "planning"] as GoalStatus[]).includes(goal.status)) {
    throw new GoalApiError(
      `Goal must be authorized before workforce proposal; current state is "${goal.status}".`,
      "goal_status_conflict",
      409,
      { status: goal.status, expectedStatus: ["authorized", "planning"] },
    );
  }

  const db = requireService();
  const { data, error } = await db
    .from("agent_connections")
    .select("id, agent_kind, model, available_models, capabilities, last_seen_at")
    .eq("workspace_id", agent.workspaceId)
    .eq("status", "active")
    .is("revoked_at", null);
  if (error) {
    console.error("proposeGoalWorkforce failed:", error.message, error.code);
    throw new GoalApiError("Could not read available workforce connections.", "workforce_read_failed", 500);
  }

  const candidates: WorkforceCandidateInput[] = (data ?? [])
    .filter((row) => row.id !== agent.connectionId && isRecentlySeenConnection({ last_seen_at: row.last_seen_at as string | null }))
    .map((row) => {
      const availableModels = Array.isArray(row.available_models)
        ? row.available_models.map((model) => typeof model === "string" ? model : String((model as { id?: unknown }).id ?? "")).filter(Boolean)
        : [];
      const capabilities = Array.isArray(row.capabilities)
        ? row.capabilities.filter((capability): capability is string => typeof capability === "string")
        : [];
      return {
        connectionId: String(row.id),
        agentKind: String(row.agent_kind),
        model: typeof row.model === "string" ? row.model : null,
        availableModels,
        capabilities,
        lastSeenAt: (row.last_seen_at as string | null) ?? null,
      };
    });

  return { goal, proposal: buildGoalWorkforceProposal(goal.providerPreferences, goal.allowedCapabilities, candidates) };
}

/**
 * Create exactly one Mission for a human-authorized Goal and enter Mission
 * planning through the existing Mission command boundary. The repository is
 * never accepted from the Goal body: it comes from the approved connection's
 * repo_hint, preserving the connection's existing repository scope.
 */
export async function dispatchGoalToMission(agent: AuthedAgent, goalId: string): Promise<GoalMissionDispatchResult> {
  const goal = await getGoal(agent, goalId);
  if (goal.principalId !== agent.connectionId) {
    throw new GoalApiError("This Goal is not assigned to the authenticated agent.", "principal_mismatch", 403);
  }
  if (goal.currentMissionId) {
    return { goal, mission: await getMission(missionPrincipalForAgent(agent), goal.currentMissionId) };
  }
  if (goal.status !== "authorized") {
    throw new GoalApiError(
      `Goal must be human-authorized before dispatch; current state is "${goal.status}".`,
      "goal_status_conflict",
      409,
      { status: goal.status, expectedStatus: "authorized" },
    );
  }
  const repository = agent.repoHint?.trim();
  if (!repository) {
    throw new GoalApiError("The authenticated agent has no approved repository target.", "repository_target_missing", 422);
  }

  const principal = missionPrincipalForAgent(agent);
  const missionId = `goal-${goal.id}-m1`;
  const mode = goal.providerPreferences.length > 1 ? "collaborative" : "coordinated";
  let mission: MissionSummaryDto;
  try {
    await createMission(principal, {
      missionId,
      repository,
      repositoryId: null,
      goal: goal.objective,
      mode,
      clientRequestId: `goal:${goal.id}:mission:create`,
    });
    const existingMission = await getMission(principal, missionId);
    mission = existingMission.state === "draft"
      ? await startMission(principal, missionId, { clientRequestId: `goal:${goal.id}:mission:start` })
      : existingMission;
  } catch (error) {
    if (error instanceof GoalApiError) throw error;
    console.error("dispatchGoalToMission failed:", error instanceof Error ? error.message : error);
    throw new GoalApiError("Could not dispatch the Goal to a Mission.", "mission_dispatch_failed", 500);
  }

  const nextGoal = await transitionGoal(
    agent.workspaceId,
    goal.id,
    "authorized",
    "planning",
    "goal.mission_created",
    { missionId },
    { kind: "agent", id: agent.connectionId },
    missionId,
  );
  return { goal: nextGoal, mission };
}
