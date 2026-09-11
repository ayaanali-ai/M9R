/**
 * Mission application service — the narrow, tenant-safe surface that
 * `/api/missions/*` routes (and, later, the dashboard UI) call.
 * ----------------------------------------------------------------------------
 * This module is the ONLY place outside `src/lib/mission/*` itself allowed
 * to construct a `MissionCommand` or call `runMissionCommandDurable`. It
 * never appends events, mutates projections, or touches scheduler/result
 * tables directly — every mutation here ends in exactly one
 * `runMissionCommandDurable` call, and every read loads events through
 * `SupabaseMissionEventReader`/the `missions` index row and projects them
 * with the existing pure `projectMission`.
 *
 * Tenant safety: every operation resolves the Mission's ACTUAL workspace_id
 * from the `missions` index table first (a plain, cheap row read) and
 * refuses with `mission_not_found` — never a 403 — the moment it does not
 * match the caller's resolved workspace. This is deliberately defensive:
 * the audit noted `apply_mission_command_atomic` does not itself re-verify
 * workspace_id (see docs/MISSION_ARCHITECTURE_AUDIT_2026-07-25.md §"Critical
 * multi-tenant" finding); the atomic RPC does still enforce it for writes
 * (`missions.workspace_id` check inside the function, `status =
 * 'workspace_mismatch'`) but this service does not rely on that alone for
 * reads, since a read never reaches the RPC at all.
 */

import { supabase } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseMissionEventReader, type SupabaseMissionEventReader } from "./mission-store-supabase";
import { createSupabaseMissionCommandPersistence, type SupabaseMissionCommandPersistence } from "./mission-command-persistence";
import { runMissionCommandDurable } from "./mission-runtime-durable";
import { projectMission, queryMissionMessages, type MissionProjection } from "./mission-projection";
import { deriveIdempotencyKey } from "./mission-idempotency";
import { resolveCommandContext, mintCorrelationId, type CommandContext, type MissionCommand } from "./mission-commands";
import type { EventActor, MissionEvent } from "./mission-events";
import type { MissionId, MissionState, StateReason } from "./mission-domain";
import type { RunMode } from "@/lib/run-mode";
import { MissionApiError, fromApplyCommandError } from "./mission-application-errors";
import type { MissionPrincipal } from "./mission-principal";
import { buildMissionPassport, type MissionPassport } from "./mission-passport";
import { createSupabaseMissionRuntimeEventJournal } from "./mission-runtime-event-store-supabase";
import type { MissionRuntimeActivity } from "./mission-runtime-activity";
import type { MissionRuntimeActivityReader } from "./mission-runtime-activity-relay";
import { createSupabaseMissionGitProvenanceReader, type MissionGitProvenanceReader, type MissionGitProvenanceWriter } from "./mission-git-provenance-store";
import { createSupabaseMissionGitSigningIdentityStore, type MissionGitSigningIdentity, type MissionGitSigningIdentityStore } from "./mission-git-signing-identity-store";
import { isMissionFeatureEnabled } from "./mission-feature-flags";
import { createSupabaseMissionMessageDeliveryStore, type MissionMessageDeliveryStore } from "./mission-message-delivery-store";
import { createSupabaseMissionNotificationStore, type MissionNotification, type MissionNotificationStore } from "./mission-notification-store";
import { expandMessageDeliveries, type MissionMessageDelivery } from "./mission-message-delivery";
import { isMessageType, MISSION_BROADCAST_CHANNEL, type MessageRecipients, type MessageType } from "./mission-domain";
import { DEFAULT_COMMUNICATION_POLICY } from "./mission-communication-policy";
import { authorizeGitOperation, buildGitCommitCandidate, type GitOperation } from "./mission-git-provenance";
import type { GitOperationResult, MissionGitProvenanceRecord } from "./mission-git-provenance";
import { signAttestationPayload } from "./mission-git-attestation-signer";
import type { BoundedDiffManifest } from "../resident-write-isolation";

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

interface MissionServiceDeps {
  reader: SupabaseMissionEventReader;
  persistence: SupabaseMissionCommandPersistence;
  runtimeActivityReader: MissionRuntimeActivityReader;
  gitProvenanceReader: MissionGitProvenanceReader;
  gitProvenanceWriter: MissionGitProvenanceWriter;
  gitSigningIdentityStore: MissionGitSigningIdentityStore;
  deliveryStore: MissionMessageDeliveryStore;
  notificationStore: MissionNotificationStore;
  client: SupabaseClient;
}

function deps(): MissionServiceDeps {
  if (!supabase) throw new MissionApiError("M9R is not configured.", "backend_not_configured", 503);
  return {
    reader: createSupabaseMissionEventReader(),
    persistence: createSupabaseMissionCommandPersistence(),
    runtimeActivityReader: createSupabaseMissionRuntimeEventJournal(),
    gitProvenanceReader: createSupabaseMissionGitProvenanceReader(),
    gitProvenanceWriter: createSupabaseMissionGitProvenanceReader(),
    gitSigningIdentityStore: createSupabaseMissionGitSigningIdentityStore(supabase),
    deliveryStore: createSupabaseMissionMessageDeliveryStore(),
    notificationStore: createSupabaseMissionNotificationStore(),
    client: supabase,
  };
}

interface MissionIndexRow {
  id: string;
  workspace_id: string;
  repository_id: string | null;
  current_version: number;
  created_at: string;
  updated_at: string;
}

/** Resolve a Mission's genesis row and refuse (mission_not_found — never a 403) if it belongs to a different workspace. Never leaks cross-tenant existence. */
async function loadOwnedMissionRow(client: SupabaseClient, missionId: string, workspaceId: string): Promise<MissionIndexRow> {
  const { data, error } = await client
    .from("missions")
    .select("id, workspace_id, repository_id, current_version, created_at, updated_at")
    .eq("id", missionId)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up Mission ${missionId}: ${error.message}`);
  if (!data || (data as MissionIndexRow).workspace_id !== workspaceId) {
    throw new MissionApiError("Mission was not found.", "mission_not_found", 404);
  }
  return data as MissionIndexRow;
}

async function loadProjection(deps: MissionServiceDeps, missionId: string, workspaceId: string): Promise<{ projection: MissionProjection; events: MissionEvent[] }> {
  await loadOwnedMissionRow(deps.client, missionId, workspaceId);
  const events = await deps.reader.loadEvents(missionId as MissionId);
  return { projection: projectMission(missionId as MissionId, events), events };
}

function buildContext(actor: EventActor, causationId?: string | null, correlationId?: string | null): CommandContext {
  return resolveCommandContext({
    actor,
    timestamp: new Date().toISOString(),
    causationId: causationId ?? null,
    correlationId: correlationId ?? mintCorrelationId(),
  });
}

async function dispatch(
  deps: MissionServiceDeps,
  workspaceId: string,
  command: MissionCommand,
  context: CommandContext,
  clientRequestId?: string | null,
  options: { communicationPolicy?: import("./mission-communication-policy").CommunicationPolicyConfig } = {},
): Promise<MissionProjection> {
  const idempotencyKey = deriveIdempotencyKey({
    missionId: command.missionId,
    commandType: command.type,
    clientKey: clientRequestId,
    payload: command,
  });
  const result = await runMissionCommandDurable({
    reader: deps.reader,
    persistence: deps.persistence,
    command,
    context,
    idempotencyKey,
    workspaceId,
    communicationPolicy: options.communicationPolicy,
  });
  if (!result.ok) throw fromApplyCommandError(result.error, context.correlationId);
  return result.projection;
}

/**
 * Buzz-parity tamper-evident audit trail (crates/buzz-audit) — appends to
 * the hash-chained ledger (src/lib/audit-log.ts) for every governance-
 * relevant write this service performs. Best-effort by design, same as the
 * rest of this codebase's cross-cutting side effects: a broken audit append
 * must never fail the Mission command that already committed, but IS logged
 * at error level (not warn) because a silent audit gap defeats the entire
 * point of a tamper-evident log.
 */
async function auditLog(principal: MissionPrincipal, action: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const { appendAuditLogEntry } = await import("@/lib/audit-log");
    await appendAuditLogEntry({
      workspaceId: principal.workspaceId,
      action,
      actorKind: principal.kind,
      actorId: principal.kind === "human" ? principal.userId : principal.agent?.connectionId ?? null,
      payload,
    });
  } catch (error) {
    console.error(`Audit log append failed for action "${action}" in workspace ${principal.workspaceId}:`, error instanceof Error ? error.message : error);
  }
}

function defaultReason(code: string, summary: string): StateReason {
  return { code, summary, relatedEntityIds: [], recoverable: true, suggestedActions: [] };
}

// ---------------------------------------------------------------------------
// Read DTOs — bounded, redacted views over MissionProjection
// ---------------------------------------------------------------------------

export interface MissionSummaryDto {
  missionId: string;
  workspaceId: string;
  state: MissionState;
  version: number;
  objective: string;
  repository: string;
  planStatus: { proposedVersion: number; approvedVersion: number | null };
  assignmentSummary: Record<string, number>;
  executionSummary: { active: number; terminal: number };
  evidenceSummary: { total: number; attached: number; attested: number };
  openFindingsCount: number;
  reviewStatus: "not_started" | "reviewing" | "accepted" | "rejected" | "other";
  stopStatus: { blocked: boolean; paused: boolean; reason: StateReason | null };
  createdAt: string | null;
  updatedAt: string | null;
  lastEventVersion: number;
}

function toSummary(projection: MissionProjection): MissionSummaryDto {
  const assignmentSummary: Record<string, number> = {};
  for (const a of Object.values(projection.assignments)) {
    assignmentSummary[a.status] = (assignmentSummary[a.status] ?? 0) + 1;
  }
  let activeExec = 0;
  let terminalExec = 0;
  for (const e of Object.values(projection.executions)) {
    if (e.terminalAt) terminalExec += 1;
    else activeExec += 1;
  }
  const reviewStatus: MissionSummaryDto["reviewStatus"] =
    projection.state === "reviewing" || projection.state === "verifying" || projection.state === "ready_for_decision"
      ? "reviewing"
      : projection.state === "accepted"
        ? "accepted"
        : projection.state === "rejected"
          ? "rejected"
          : projection.state === "draft" || projection.state === "planning" || projection.state === "ready"
            ? "not_started"
            : "other";

  return {
    missionId: projection.missionId,
    workspaceId: projection.workspaceId,
    state: projection.state,
    version: projection.aggregateVersion,
    objective: projection.goal,
    repository: projection.repository,
    planStatus: { proposedVersion: projection.planVersion, approvedVersion: projection.approvedPlanVersion },
    assignmentSummary,
    executionSummary: { active: activeExec, terminal: terminalExec },
    evidenceSummary: {
      total: Object.keys(projection.evidenceRecords).length,
      attached: projection.attachedEvidenceIds.length,
      attested: projection.attestedEvidenceIds.length,
    },
    openFindingsCount: projection.openFindingsCount,
    reviewStatus,
    stopStatus: { blocked: projection.state === "blocked", paused: projection.state === "paused", reason: projection.reason },
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    lastEventVersion: projection.aggregateVersion,
  };
}

export interface MissionAssignmentDto {
  id: string;
  title: string;
  objective: string;
  status: string;
  assigneeParticipantId: string | null;
  approvalPolicy: unknown;
  parentAssignmentId: string | null;
  dependencies: string[];
}

function toAssignments(projection: MissionProjection): MissionAssignmentDto[] {
  return Object.values(projection.assignments).map((a) => ({
    id: a.id,
    title: a.title,
    objective: a.objective,
    status: a.status,
    assigneeParticipantId: a.assigneeParticipantId,
    approvalPolicy: a.approvalPolicy,
    parentAssignmentId: a.parentAssignmentId,
    dependencies: a.dependencies,
  }));
}

export interface MissionPlanDto {
  currentVersion: number;
  approvedVersion: number | null;
  proposals: Array<{
    id: string;
    version: number;
    status: string;
    objective: string;
    assumptions: string[];
    constraints: string[];
    unresolvedQuestions: string[];
    warnings: string[];
    supersedesPlanId: string | null;
    createdAt: string;
  }>;
}

function toPlan(projection: MissionProjection): MissionPlanDto {
  return {
    currentVersion: projection.planVersion,
    approvedVersion: projection.approvedPlanVersion,
    proposals: Object.values(projection.planProposals).map((p) => ({
      id: p.id,
      version: p.version,
      status: p.status,
      objective: p.objective,
      assumptions: p.assumptions,
      constraints: p.constraints,
      unresolvedQuestions: p.unresolvedQuestions,
      warnings: p.warnings,
      supersedesPlanId: p.supersedesPlanId,
      createdAt: p.createdAt,
    })),
  };
}

export interface MissionEvidenceDto {
  id: string;
  assignmentId: string | null;
  producerKind: string;
  kind: string;
  lifecycle: string;
  availability: string;
  source: string;
  supersededByEvidenceId: string | null;
}

function toEvidence(projection: MissionProjection): MissionEvidenceDto[] {
  return Object.values(projection.evidenceRecords).map((e) => ({
    id: e.id,
    assignmentId: e.assignmentId,
    producerKind: e.producerKind,
    kind: e.kind,
    lifecycle: e.lifecycle,
    availability: e.availability,
    // Free-text but never raw stdout/env — producers write a short description here, not attach transcripts (mission-domain.ts's MissionEvidenceRecord.source doc comment).
    source: e.source,
    supersededByEvidenceId: e.supersededByEvidenceId ?? null,
  }));
}

export interface MissionExecutionDto {
  executionId: string;
  assignmentId: string;
  providerAdapterId: string;
  attempt: number;
  status: string;
  startedAt: string;
  terminalAt: string | null;
  terminalReason: string | null;
  evidenceIds: string[];
}

function toExecutions(projection: MissionProjection): MissionExecutionDto[] {
  return Object.values(projection.executions).map((e) => ({
    executionId: e.executionId,
    assignmentId: e.assignmentId,
    providerAdapterId: e.providerAdapterId,
    attempt: e.attempt,
    status: e.status,
    startedAt: e.startedAt,
    terminalAt: e.terminalAt,
    terminalReason: e.terminalReason,
    evidenceIds: e.evidenceIds,
    // Deliberately omitted: leaseId, fencingToken (internal fencing), dispatchIntentId/dispatchKey (scheduler internals).
  }));
}

export interface TimelineEntryDto {
  eventId: string;
  type: string;
  aggregateVersion: number;
  timestamp: string;
  actorKind: string;
  actorId: string;
  correlationId: string;
  causationId: string | null;
  /** Bounded display metadata only — never the raw payload (which may carry participant/assignment detail beyond what a timeline viewer should see in one shot). */
  summary: string;
}

export interface TimelinePageDto {
  entries: TimelineEntryDto[];
  nextCursor: string | null;
}

export interface MissionParticipantDto {
  id: string;
  kind: string;
  role: string;
  displayName: string;
  status: string;
  provider: string | null;
  adapterId: string | null;
  communicationPermissions: { canBroadcast: boolean; canDelegate: boolean; maxDelegationDepth: number };
}

export interface MissionMessageDto {
  id: string;
  senderParticipantId: string;
  recipientParticipantIds: string[] | "mission_broadcast";
  assignmentId: string | null;
  type: string;
  body: string;
  evidenceRefs: string[];
  replyToMessageId: string | null;
  createdAt: string;
}

export interface MissionMessageDeliveryDto {
  id: string;
  messageId: string;
  recipientParticipantId: string;
  bridgeInstanceId: string | null;
  agentSessionId: string | null;
  status: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MissionConversationDto {
  participants: MissionParticipantDto[];
  messages: MissionMessageDto[];
  nextCursor: string | null;
}

function summarizeEvent(event: MissionEvent): string {
  switch (event.type) {
    case "mission.state_changed":
      return `${(event.payload as { previousState: string }).previousState} -> ${(event.payload as { nextState: string }).nextState}`;
    default:
      return event.type;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface CreateMissionInput {
  missionId: string;
  repository: string;
  repositoryId?: string | null;
  goal: string;
  mode: RunMode;
  clientRequestId?: string | null;
}

export async function createMission(principal: MissionPrincipal, input: CreateMissionInput): Promise<MissionSummaryDto> {
  if (!input.missionId?.trim()) throw new MissionApiError("missionId is required.", "validation_error", 400);
  if (!input.repository?.trim()) throw new MissionApiError("repository is required.", "validation_error", 400);
  if (!input.goal?.trim()) throw new MissionApiError("goal is required.", "validation_error", 400);

  const d = deps();
  const context = buildContext(principal.actor);
  const command: MissionCommand = {
    type: "CreateMission",
    missionId: input.missionId as MissionId,
    workspaceId: principal.workspaceId,
    repository: input.repository,
    repositoryId: input.repositoryId ?? null,
    goal: input.goal,
    mode: input.mode,
  };
  const projection = await dispatch(d, principal.workspaceId, command, context, input.clientRequestId);
  return toSummary(projection);
}

export interface AddMissionParticipantInput {
  missionId: string;
  participantId: string;
  kind: import("./mission-domain").ParticipantKind;
  role: import("./mission-domain").ParticipantRole;
  displayName: string;
  agentKind: import("@/lib/agent-workspace-data").AgentKindKey | null;
  provider: string | null;
  adapterId: string | null;
  capabilities?: string[];
  assignmentScope?: import("./mission-domain").AssignmentScope;
  workspacePermissions?: import("./mission-domain").ParticipantWorkspacePermissions;
  communicationPermissions?: import("./mission-domain").ParticipantCommunicationPermissions;
  clientRequestId?: string | null;
  /** Activate immediately after registering — most callers outside the Planner want this rather than a two-step proposed->active flow. */
  activate?: boolean;
}

/** Register a Mission participant (and optionally activate it) through the collaboration command boundary — never AddParticipant/ActivateParticipant directly. */
export async function addMissionParticipant(principal: MissionPrincipal, input: AddMissionParticipantInput): Promise<MissionSummaryDto> {
  if (!input.participantId?.trim()) throw new MissionApiError("participantId is required.", "validation_error", 400);
  const d = deps();
  const scope = input.assignmentScope ?? { allowedPaths: [], prohibitedPaths: [] };
  const context = buildContext(principal.actor);
  const command: MissionCommand = {
    type: "AddParticipant",
    missionId: input.missionId as MissionId,
    participantId: input.participantId as import("./mission-domain").ParticipantId,
    kind: input.kind,
    role: input.role,
    displayName: input.displayName,
    agentKind: input.agentKind,
    provider: input.provider,
    adapterId: input.adapterId,
    capabilities: input.capabilities ?? [],
    assignmentScope: scope,
    workspacePermissions: input.workspacePermissions ?? { allowedPaths: scope.allowedPaths, prohibitedPaths: scope.prohibitedPaths },
    communicationPermissions: input.communicationPermissions ?? { canBroadcast: false, canDelegate: false, maxDelegationDepth: 0 },
  };
  let projection = await dispatch(d, principal.workspaceId, command, context, input.clientRequestId);
  if (input.activate) {
    const activateContext = buildContext(principal.actor);
    const activateCommand: MissionCommand = { type: "ActivateParticipant", missionId: input.missionId as MissionId, participantId: input.participantId as import("./mission-domain").ParticipantId };
    projection = await dispatch(d, principal.workspaceId, activateCommand, activateContext, input.clientRequestId ? `${input.clientRequestId}:activate` : null);
  }
  return toSummary(projection);
}

export interface CreateMissionAssignmentInput {
  missionId: string;
  assignmentId: string;
  title: string;
  objective: string;
  scope?: import("./mission-domain").AssignmentScope;
  dependencies?: string[];
  requiredEvidence?: string[];
  approvalPolicy?: import("./mission-domain").AssignmentApprovalPolicy;
  budget?: import("./mission-domain").AssignmentBudget;
  /** When supplied (with dispatchKey), the assignment is claimed by this participant in the same call rather than left "proposed" — most callers outside the Planner want bounded work assigned immediately, not a two-step proposal cycle. */
  assigneeParticipantId?: string | null;
  dispatchKey?: string | null;
  clientRequestId?: string | null;
}

/**
 * Create a root Mission assignment (and optionally claim it for a
 * participant in the same call) through the collaboration command
 * boundary. This is the piece that was missing for anything outside the
 * Planner pipeline (mission-planning-worker*.ts) to give an agent bounded
 * work directly — e.g. a chat-triggered Mission (mission-channel-binding.ts)
 * that wants a real assignment before a Git candidate can be authorized
 * (authorizeMissionGitOperation requires assignment.assigneeParticipantId
 * to match).
 */
export async function createMissionAssignment(principal: MissionPrincipal, input: CreateMissionAssignmentInput): Promise<MissionSummaryDto> {
  if (!input.assignmentId?.trim()) throw new MissionApiError("assignmentId is required.", "validation_error", 400);
  if (!input.title?.trim()) throw new MissionApiError("title is required.", "validation_error", 400);
  if (!input.objective?.trim()) throw new MissionApiError("objective is required.", "validation_error", 400);
  const d = deps();
  const context = buildContext(principal.actor);
  const command: MissionCommand = {
    type: "CreateAssignment",
    missionId: input.missionId as MissionId,
    assignmentId: input.assignmentId as import("./mission-domain").AssignmentId,
    title: input.title,
    objective: input.objective,
    scope: input.scope ?? { allowedPaths: [], prohibitedPaths: [] },
    dependencies: (input.dependencies ?? []) as import("./mission-domain").AssignmentId[],
    requiredEvidence: input.requiredEvidence ?? [],
    approvalPolicy: input.approvalPolicy ?? "human_required",
    budget: input.budget ?? { maxDurationMs: null, maxEstimatedTokens: null },
  };
  let projection = await dispatch(d, principal.workspaceId, command, context, input.clientRequestId);
  if (input.assigneeParticipantId && input.dispatchKey) {
    const assignContext = buildContext(principal.actor);
    const assignCommand: MissionCommand = {
      type: "AssignAssignment",
      missionId: input.missionId as MissionId,
      assignmentId: input.assignmentId as import("./mission-domain").AssignmentId,
      assigneeParticipantId: input.assigneeParticipantId as import("./mission-domain").ParticipantId,
      dispatchKey: input.dispatchKey,
    };
    projection = await dispatch(d, principal.workspaceId, assignCommand, assignContext, input.clientRequestId ? `${input.clientRequestId}:assign` : null);
  }
  return toSummary(projection);
}

export async function getMission(principal: MissionPrincipal, missionId: string): Promise<MissionSummaryDto> {
  const d = deps();
  const { projection } = await loadProjection(d, missionId, principal.workspaceId);
  return toSummary(projection);
}

export interface ListMissionsResult {
  missions: MissionSummaryDto[];
  nextCursor: string | null;
}

export async function listMissions(principal: MissionPrincipal, options: { limit?: number; cursor?: string | null } = {}): Promise<ListMissionsResult> {
  const d = deps();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  let query = d.client
    .from("missions")
    .select("id, created_at")
    .eq("workspace_id", principal.workspaceId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (options.cursor) {
    const [createdAt, id] = decodeCursor(options.cursor);
    query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`);
  }
  const { data, error } = await query;
  if (error) throw new Error(`Failed to list Missions: ${error.message}`);
  const rows = (data ?? []) as { id: string; created_at: string }[];
  const page = rows.slice(0, limit);
  const summaries = await Promise.all(page.map((r) => getMission(principal, r.id)));
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id) : null;
  return { missions: summaries, nextCursor };
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString("base64url");
}
function decodeCursor(cursor: string): [string, string] {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return [String(createdAt), String(id)];
  } catch {
    throw new MissionApiError("Invalid pagination cursor.", "validation_error", 400);
  }
}

export async function getMissionTimeline(
  principal: MissionPrincipal,
  missionId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<TimelinePageDto> {
  const d = deps();
  await loadOwnedMissionRow(d.client, missionId, principal.workspaceId);
  const events = await d.reader.loadEvents(missionId as MissionId);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const afterVersion = options.cursor ? Number(decodeVersionCursor(options.cursor)) : 0;
  const sorted = events.filter((e) => e.aggregateVersion > afterVersion);
  const page = sorted.slice(0, limit);
  const entries: TimelineEntryDto[] = page.map((e) => ({
    eventId: e.eventId,
    type: e.type,
    aggregateVersion: e.aggregateVersion,
    timestamp: e.timestamp,
    actorKind: e.actor.kind,
    actorId: e.actor.id,
    correlationId: e.correlationId,
    causationId: e.causationId,
    summary: summarizeEvent(e),
  }));
  const nextCursor = sorted.length > limit ? encodeVersionCursor(page[page.length - 1].aggregateVersion) : null;
  return { entries, nextCursor };
}

export interface MissionRuntimeActivityPageDto {
  activities: MissionRuntimeActivity[];
}

/** Recent structured provider/system observations, separate from the Mission domain timeline. */
export async function getMissionRuntimeActivity(
  principal: MissionPrincipal,
  missionId: string,
  options: { limit?: number; participantId?: string | null } = {},
): Promise<MissionRuntimeActivityPageDto> {
  const d = deps();
  await loadOwnedMissionRow(d.client, missionId, principal.workspaceId);
  const activities = await d.runtimeActivityReader.listActivities({
    workspaceId: principal.workspaceId,
    missionId,
    participantId: options.participantId ?? null,
    limit: Math.min(Math.max(options.limit ?? 100, 1), 500),
  });
  return { activities };
}

export async function getMissionConversation(
  principal: MissionPrincipal,
  missionId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<MissionConversationDto> {
  const d = deps();
  const { projection, events } = await loadProjection(d, missionId, principal.workspaceId);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const cursor = options.cursor ? decodeVersionCursor(options.cursor) : null;
  const page = queryMissionMessages(events, { limit, cursor });
  const participants = Object.values(projection.participants)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  // Older Missions may predate the human participant genesis event. Expose
  // the authenticated principal as the pending conversation owner so the
  // first post can durably repair that Mission in the same command batch.
  if (principal.kind === "human" && !participants.some((participant) => participant.id === principal.actor.id)) {
    participants.push({
      id: principal.actor.id,
      kind: "human",
      role: "owner",
      agentKind: null,
      displayName: "Mission owner",
      status: "active",
      provider: null,
      adapterId: null,
      capabilities: [],
      assignmentScope: { allowedPaths: [], prohibitedPaths: [] },
      workspacePermissions: { allowedPaths: [], prohibitedPaths: [] },
      communicationPermissions: { canBroadcast: true, canDelegate: true, maxDelegationDepth: 8 },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
  }

  return {
    participants: participants.map((participant) => ({
        id: participant.id,
        kind: participant.kind,
        role: participant.role,
        displayName: participant.displayName,
        status: participant.status,
        provider: participant.provider,
        adapterId: participant.adapterId,
        communicationPermissions: participant.communicationPermissions,
      })),
    messages: page.messages.map((message) => ({
      id: message.id,
      senderParticipantId: message.senderParticipantId,
      recipientParticipantIds: message.recipientParticipantIds,
      assignmentId: message.assignmentId,
      type: message.type,
      body: message.body,
      evidenceRefs: [...message.evidenceRefs],
      replyToMessageId: message.replyToMessageId,
      createdAt: message.createdAt,
    })),
    nextCursor: page.nextCursor === null ? null : encodeVersionCursor(page.nextCursor),
  };
}

export interface PostMissionMessageInput {
  messageId?: string | null;
  senderParticipantId: string;
  recipientParticipantIds: MessageRecipients;
  assignmentId?: string | null;
  messageType: string;
  body: string;
  evidenceRefs?: string[];
  replyToMessageId?: string | null;
  structuredPayload?: Record<string, unknown>;
  clientRequestId?: string | null;
  causationId?: string | null;
  correlationId?: string | null;
}

export interface PostedMissionMessageDto {
  message: MissionMessageDto;
  deliveries: MissionMessageDeliveryDto[];
}

function notificationKindForMessage(messageType: string): MissionNotification["kind"] | null {
  if (messageType === "question") return "question";
  if (messageType === "blocker") return "blocker";
  if (messageType === "review_request") return "review_request";
  if (messageType === "approval_request") return "approval_request";
  return null;
}

function notificationTitle(kind: MissionNotification["kind"], senderName: string): string {
  switch (kind) {
    case "question": return `${senderName} asked a question`;
    case "blocker": return `${senderName} reported a blocker`;
    case "review_request": return `${senderName} requested a review`;
    case "approval_request": return `${senderName} needs approval`;
    default: return `${senderName} needs your attention`;
  }
}

async function ownerIdForWorkspace(client: SupabaseClient, workspaceId: string): Promise<string | null> {
  const { data, error } = await client.from("projects").select("owner_id").eq("id", workspaceId).maybeSingle();
  if (error) throw new Error(`Failed to resolve workspace notification owner: ${error.message}`);
  return data?.owner_id == null ? null : String(data.owner_id);
}

async function notifyHumanIfRequired(input: {
  deps: MissionServiceDeps;
  principal: MissionPrincipal;
  missionId: string;
  message: MissionProjection["messages"][number];
  participants: MissionProjection["participants"];
}): Promise<void> {
  // Human-authored messages should never notify their own author. Agent
  // messages create one durable inbox item for the workspace owner when the
  // recipient set includes a human or the message is an attention type.
  if (input.principal.kind !== "agent") return;
  const kind = notificationKindForMessage(input.message.type);
  const participantValues = Object.values(input.participants);
  const activeHumanIds = new Set(participantValues.filter((participant) => participant.kind === "human" && participant.status !== "removed").map((participant) => participant.id));
  const recipientIds = input.message.recipientParticipantIds === MISSION_BROADCAST_CHANNEL ? [...activeHumanIds] : input.message.recipientParticipantIds;
  const explicitHumanRecipient = recipientIds.some((id) => activeHumanIds.has(id));
  const humanMentioned = participantValues.some((participant) => participant.kind === "human" && new RegExp(`(^|\\s)@${participant.displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}($|\\s)`, "i").test(input.message.body));
  if (!kind && !explicitHumanRecipient && !humanMentioned) return;
  const recipientUserId = await ownerIdForWorkspace(input.deps.client, input.principal.workspaceId);
  if (!recipientUserId) return;
  const sender = participantValues.find((participant) => participant.id === input.message.senderParticipantId);
  const notificationKind = kind ?? "mention";
  const notification: MissionNotification = {
    id: `mission-notification-${input.message.id}-${notificationKind}`,
    workspaceId: input.principal.workspaceId,
    missionId: input.missionId,
    recipientUserId,
    recipientParticipantId: explicitHumanRecipient ? recipientIds.find((id) => activeHumanIds.has(id)) ?? null : null,
    sourceMessageId: input.message.id,
    kind: notificationKind,
    title: notificationTitle(notificationKind, sender?.displayName ?? "An agent"),
    body: input.message.body.slice(0, 2_048),
    payload: { messageType: input.message.type, assignmentId: input.message.assignmentId, replyToMessageId: input.message.replyToMessageId },
    createdAt: input.message.createdAt,
    readAt: null,
  };
  await input.deps.notificationStore.insert([notification]);
}

function toMessageDto(message: MissionProjection["messages"][number]): MissionMessageDto {
  return {
    id: message.id,
    senderParticipantId: message.senderParticipantId,
    recipientParticipantIds: message.recipientParticipantIds,
    assignmentId: message.assignmentId,
    type: message.type,
    body: message.body,
    evidenceRefs: [...message.evidenceRefs],
    replyToMessageId: message.replyToMessageId,
    createdAt: message.createdAt,
  };
}

function toDeliveryDto(delivery: MissionMessageDelivery): MissionMessageDeliveryDto {
  return {
    id: delivery.id,
    messageId: delivery.messageId,
    recipientParticipantId: delivery.recipientParticipantId,
    bridgeInstanceId: delivery.bridgeInstanceId,
    agentSessionId: delivery.agentSessionId,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    nextAttemptAt: delivery.nextAttemptAt,
    lastAttemptAt: delivery.lastAttemptAt,
    deliveredAt: delivery.deliveredAt,
    acknowledgedAt: delivery.acknowledgedAt,
    failureCode: delivery.failureCode,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

function validatePostMessageInput(input: PostMissionMessageInput): { messageType: MessageType; recipients: MessageRecipients; body: string; evidenceRefs: string[]; structuredPayload: Record<string, unknown> } {
  if (!input.senderParticipantId?.trim()) throw new MissionApiError("senderParticipantId is required.", "validation_error", 400);
  if (!isMessageType(input.messageType)) throw new MissionApiError("messageType is not supported.", "validation_error", 400);
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body || body.length > 12_000) throw new MissionApiError("body is required and must be at most 12,000 characters.", "validation_error", 400);
  const recipients = input.recipientParticipantIds;
  if (recipients !== MISSION_BROADCAST_CHANNEL) {
    if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > 8 || recipients.some((id) => typeof id !== "string" || !id.trim())) {
      throw new MissionApiError("recipientParticipantIds must contain between one and eight participant ids.", "validation_error", 400);
    }
    if (new Set(recipients).size !== recipients.length) throw new MissionApiError("recipientParticipantIds must not contain duplicates.", "validation_error", 400);
  }
  const evidenceRefs = Array.isArray(input.evidenceRefs) ? input.evidenceRefs : [];
  if (evidenceRefs.length > 32 || evidenceRefs.some((ref) => typeof ref !== "string" || ref.length > 256)) {
    throw new MissionApiError("evidenceRefs are limited to 32 bounded references.", "validation_error", 400);
  }
  const structuredPayload = input.structuredPayload ?? {};
  if (typeof structuredPayload !== "object" || Array.isArray(structuredPayload)) throw new MissionApiError("structuredPayload must be an object.", "validation_error", 400);
  if (JSON.stringify(structuredPayload).length > 8_192) throw new MissionApiError("structuredPayload is too large.", "validation_error", 400);
  return { messageType: input.messageType, recipients, body, evidenceRefs: [...evidenceRefs], structuredPayload };
}

/** Post one authoritative Mission message, then enqueue one delivery per resolved recipient. */
export async function postMissionMessage(principal: MissionPrincipal, missionId: string, input: PostMissionMessageInput): Promise<PostedMissionMessageDto> {
  const normalized = validatePostMessageInput(input);
  const d = deps();
  await loadProjection(d, missionId, principal.workspaceId);
  const messageId = input.messageId?.trim() || crypto.randomUUID();
  const context = buildContext(principal.actor, input.causationId, input.correlationId);
  const command: MissionCommand = {
    type: "PostMessage",
    missionId: missionId as MissionId,
    messageId,
    senderParticipantId: input.senderParticipantId,
    recipientParticipantIds: normalized.recipients,
    assignmentId: input.assignmentId?.trim() || null,
    messageType: normalized.messageType,
    body: normalized.body,
    evidenceRefs: normalized.evidenceRefs,
    replyToMessageId: input.replyToMessageId?.trim() || null,
    structuredPayload: normalized.structuredPayload,
  };
  const projection = await dispatch(d, principal.workspaceId, command, context, input.clientRequestId, {
    // The conversation surface is the explicit Mission channel. Keep the
    // domain default fail-closed for generic agent commands, while allowing
    // this authenticated channel path to use its sender-level canBroadcast
    // permission rather than rendering a channel action that always fails.
    communicationPolicy: { ...DEFAULT_COMMUNICATION_POLICY, allowBroadcast: true },
  });
  const message = projection.messages.find((candidate) => candidate.id === messageId);
  if (!message) throw new Error("Mission message was accepted but could not be projected.");
  const activeRecipientIds = Object.values(projection.participants).filter((participant) => participant.status === "active").map((participant) => participant.id);
  const deliveries = expandMessageDeliveries({
    idPrefix: "mission",
    workspaceId: principal.workspaceId,
    missionId,
    messageId,
    senderParticipantId: message.senderParticipantId,
    recipientParticipantIds: message.recipientParticipantIds,
    activeRecipientIds,
    createdAt: message.createdAt,
  });
  await d.deliveryStore.insert(deliveries);
  await notifyHumanIfRequired({ deps: d, principal, missionId, message, participants: projection.participants });
  return { message: toMessageDto(message), deliveries: deliveries.map(toDeliveryDto) };
}

/**
 * OathLock's counterpart to Buzz's `request_approval` workflow action
 * (crates/buzz-workflow/src/schema.rs's ActionDef::RequestApproval): instead
 * of a bespoke approval-token table scoped to one workflow step (Buzz's
 * `workflow_approvals`), this routes through the Mission's own
 * `MarkReadyForDecision` command — the same human-decision gate every other
 * path in this codebase uses, so a workflow-triggered approval request shows
 * up in the same place, and is answered the same way
 * (`recordMissionReviewDecision`/`/api/missions/[missionId]/review/decision`),
 * as any other Mission awaiting a human call.
 */
export async function requestMissionDecision(principal: MissionPrincipal, missionId: string, input: { reason: string; clientRequestId?: string | null }): Promise<MissionSummaryDto> {
  const reason = input.reason?.trim();
  if (!reason) throw new MissionApiError("reason is required.", "validation_error", 400);
  if (reason.length > 2000) throw new MissionApiError("reason must be at most 2000 characters.", "validation_error", 400);
  const d = deps();
  const context = buildContext(principal.actor);
  const command: MissionCommand = { type: "MarkReadyForDecision", missionId: missionId as MissionId };
  const projection = await dispatch(d, principal.workspaceId, command, context, input.clientRequestId);
  await auditLog(principal, "mission.decision_requested", { missionId, reason });
  return toSummary(projection);
}

export interface RecordMissionEvidenceInput {
  evidenceId?: string | null;
  assignmentId?: string | null;
  producerParticipantId?: string | null;
  producerKind: import("./mission-domain").EvidenceProducerKind;
  executionId?: string | null;
  dispatchKey?: string | null;
  provider?: string | null;
  kind: import("./mission-domain").EvidenceNoticeKind;
  source: string;
  lifecycle: import("./mission-domain").EvidenceLifecycle;
  availability: import("./mission-domain").EvidenceAvailability;
  integrity?: import("./mission-domain").EvidenceIntegrity | null;
  clientRequestId?: string | null;
  causationId?: string | null;
  correlationId?: string | null;
}

/**
 * The bearer-authenticated counterpart to mission-execution-result-processor.ts's
 * inline RecordEvidence issuance (the only other place this command is ever
 * built) — that path only fires for the one-shot dispatch runtime. This is
 * what an ACP session (src/lib/bridge/acp-client.ts's runtimeEventSink) or
 * any other live, interactive session calls so evidence from that work
 * reaches the same mission_events stream buildMissionPassport already reads
 * from unconditionally.
 */
export async function recordMissionEvidence(principal: MissionPrincipal, missionId: string, input: RecordMissionEvidenceInput): Promise<MissionEvidenceDto> {
  if (!input.source?.trim()) throw new MissionApiError("source is required.", "validation_error", 400);
  if (input.source.length > 2048) throw new MissionApiError("source must be at most 2048 characters.", "validation_error", 400);
  const d = deps();
  await loadProjection(d, missionId, principal.workspaceId);
  const evidenceId = input.evidenceId?.trim() || crypto.randomUUID();
  const context = buildContext(principal.actor, input.causationId, input.correlationId);
  const command: MissionCommand = {
    type: "RecordEvidence",
    missionId: missionId as MissionId,
    evidenceId,
    assignmentId: (input.assignmentId?.trim() || null) as import("./mission-domain").AssignmentId | null,
    producerParticipantId: (input.producerParticipantId?.trim() || null) as import("./mission-domain").ParticipantId | null,
    producerKind: input.producerKind,
    executionId: input.executionId?.trim() || null,
    dispatchKey: input.dispatchKey?.trim() || null,
    provider: input.provider?.trim() || null,
    kind: input.kind,
    source: input.source.trim(),
    lifecycle: input.lifecycle,
    availability: input.availability,
    integrity: input.integrity ?? null,
  };
  const resultProjection = await dispatch(d, principal.workspaceId, command, context, input.clientRequestId);
  const recorded = toEvidence(resultProjection).find((entry) => entry.id === evidenceId);
  if (!recorded) throw new Error("Evidence was accepted but could not be projected.");
  await auditLog(principal, "mission.evidence_recorded", { missionId, evidenceId, kind: input.kind, lifecycle: input.lifecycle, availability: input.availability });
  return recorded;
}

export async function getMissionMessageDeliveries(
  principal: MissionPrincipal,
  missionId: string,
  options: { limit?: number; recipientParticipantId?: string | null } = {},
): Promise<{ deliveries: MissionMessageDeliveryDto[] }> {
  const d = deps();
  await loadOwnedMissionRow(d.client, missionId, principal.workspaceId);
  const deliveries = await d.deliveryStore.listForMission({
    workspaceId: principal.workspaceId,
    missionId,
    recipientParticipantId: options.recipientParticipantId ?? null,
    limit: Math.min(Math.max(options.limit ?? 100, 1), 500),
  });
  return { deliveries: deliveries.map(toDeliveryDto) };
}

/** A recipient may acknowledge only its own workspace-scoped delivery. */
export async function acknowledgeMissionMessageDelivery(
  principal: MissionPrincipal,
  missionId: string,
  deliveryId: string,
): Promise<MissionMessageDeliveryDto> {
  const d = deps();
  await loadOwnedMissionRow(d.client, missionId, principal.workspaceId);
  const current = await d.deliveryStore.get(deliveryId);
  if (!current || current.workspaceId !== principal.workspaceId || current.missionId !== missionId) {
    throw new MissionApiError("Message delivery was not found.", "mission_not_found", 404);
  }
  const acknowledged = await d.deliveryStore.transition({
    id: deliveryId,
    expectedStatus: "delivered",
    nextStatus: "acknowledged",
    now: new Date().toISOString(),
  });
  if (acknowledged) return toDeliveryDto(acknowledged);
  if (current.status === "acknowledged") return toDeliveryDto(current);
  throw new MissionApiError("Message delivery is not ready to acknowledge.", "validation_error", 409);
}

function encodeVersionCursor(version: number): string {
  return Buffer.from(String(version)).toString("base64url");
}
function decodeVersionCursor(cursor: string): number {
  const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isFinite(n) || n < 0) throw new MissionApiError("Invalid pagination cursor.", "validation_error", 400);
  return n;
}

export async function getMissionAssignments(principal: MissionPrincipal, missionId: string): Promise<MissionAssignmentDto[]> {
  const d = deps();
  const { projection } = await loadProjection(d, missionId, principal.workspaceId);
  return toAssignments(projection);
}

export async function getMissionPlan(principal: MissionPrincipal, missionId: string): Promise<MissionPlanDto> {
  const d = deps();
  const { projection } = await loadProjection(d, missionId, principal.workspaceId);
  return toPlan(projection);
}

export async function getMissionEvidence(principal: MissionPrincipal, missionId: string): Promise<MissionEvidenceDto[]> {
  const d = deps();
  const { projection } = await loadProjection(d, missionId, principal.workspaceId);
  return toEvidence(projection);
}

export interface MissionFindingDto {
  id: string;
  assignmentId: string;
  openedByParticipantId: string;
  responsibleParticipantId: string | null;
  statement: string;
  evidenceRefs: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

function toFindings(projection: MissionProjection): MissionFindingDto[] {
  return Object.values(projection.findings).map((f) => ({
    id: f.id,
    assignmentId: f.assignmentId,
    openedByParticipantId: f.openedByParticipantId,
    responsibleParticipantId: f.responsibleParticipantId,
    statement: f.statement,
    evidenceRefs: f.evidenceRefs,
    status: f.status,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  }));
}

export async function getMissionFindings(principal: MissionPrincipal, missionId: string): Promise<MissionFindingDto[]> {
  const d = deps();
  const { projection } = await loadProjection(d, missionId, principal.workspaceId);
  return toFindings(projection);
}

export async function getMissionExecutionStatus(principal: MissionPrincipal, missionId: string): Promise<MissionExecutionDto[]> {
  const d = deps();
  const { projection } = await loadProjection(d, missionId, principal.workspaceId);
  return toExecutions(projection);
}

/**
 * Build plan Phase 6: "Passport as a reproducible projection over
 * immutable events." Pure derivation (`buildMissionPassport`) over the
 * exact event stream every other read on this Mission already loads — no
 * separate store, no cached snapshot, so it can never drift from what the
 * timeline/evidence/plan tabs show for the same Mission.
 */
export async function getMissionPassport(principal: MissionPrincipal, missionId: string): Promise<MissionPassport> {
  const d = deps();
  const { projection, events } = await loadProjection(d, missionId, principal.workspaceId);
  const gitProvenance = isMissionFeatureEnabled("gitProvenance")
    ? await d.gitProvenanceReader.list({ workspaceId: principal.workspaceId, missionId, limit: 500 })
    : [];
  const passport = buildMissionPassport(projection, events);
  return gitProvenance.length > 0 ? { ...passport, gitProvenance } : passport;
}

/** Read-only list, redacted the same way the Passport's gitProvenance already is — no raw manifest/violation detail, just what the branch-channel UI needs (Phase B8). */
export async function getMissionGitProvenance(principal: MissionPrincipal, missionId: string): Promise<MissionGitProvenanceRecord[]> {
  if (!isMissionFeatureEnabled("gitProvenance")) return [];
  const d = deps();
  await loadOwnedMissionRow(d.client, missionId, principal.workspaceId);
  return d.gitProvenanceReader.list({ workspaceId: principal.workspaceId, missionId, limit: 100 });
}

/**
 * Registers a participant's PUBLIC signing key (plan §11.3 "commit
 * identity"). The private half never reaches this service — it is
 * generated and held only by the Agent Bridge (src/lib/bridge/git-signer.ts).
 * Only the Bridge's own bearer-agent credential may register a key, and
 * only for the participant it is authenticated as.
 */
export async function registerMissionGitSigningIdentity(principal: MissionPrincipal, missionId: string, input: { participantId: string; publicKey: string; fingerprint: string }): Promise<MissionGitSigningIdentity> {
  if (principal.kind !== "agent") throw new MissionApiError("Only an authenticated Bridge may register a Git signing identity.", "agent_required", 403);
  if (!input.publicKey?.trim() || !input.fingerprint?.trim()) throw new MissionApiError("publicKey and fingerprint are required.", "validation_error", 400);
  const d = deps();
  const { projection } = await loadProjection(d, missionId, principal.workspaceId);
  if (!projection.participants[input.participantId]) throw new MissionApiError("participantId is not a participant of this Mission.", "validation_error", 400);
  return d.gitSigningIdentityStore.register({ workspaceId: principal.workspaceId, missionId, participantId: input.participantId, publicKey: input.publicKey, fingerprint: input.fingerprint });
}

export async function getMissionGitSigningIdentities(principal: MissionPrincipal, missionId: string): Promise<MissionGitSigningIdentity[]> {
  const d = deps();
  await loadOwnedMissionRow(d.client, missionId, principal.workspaceId);
  return d.gitSigningIdentityStore.list({ workspaceId: principal.workspaceId, missionId });
}

export interface AuthorizeMissionGitOperationInput {
  operationId?: string | null;
  operation: GitOperation;
  assignmentId: string;
  participantId: string;
  branch: string;
  commitSha: string;
  manifest: Pick<BoundedDiffManifest, "digest" | "reviewable" | "changedFiles" | "violations">;
  message: string;
  decision: "approved" | "rejected";
}

/** Record a human decision over one exact, reviewable Git candidate. This authorizes an operation but never performs a push. */
export async function authorizeMissionGitOperation(
  principal: MissionPrincipal,
  missionId: string,
  input: AuthorizeMissionGitOperationInput,
): Promise<{ candidate: ReturnType<typeof buildGitCommitCandidate>; authorization: { actorKind: "human"; actorId: string; decision: "approved" | "rejected"; candidateDigest: string; recordedAt: string; signature: string | null; keyId: string | null }; authorizationResult: ReturnType<typeof authorizeGitOperation>; provenance: MissionGitProvenanceRecord }> {
  if (principal.kind !== "human") throw new MissionApiError("Only an authenticated human may authorize Git operations.", "human_required", 403);
  if (!isMissionFeatureEnabled("gitProvenance")) throw new MissionApiError("Git provenance is disabled for this deployment.", "conflict", 409);
  const d = deps();
  const { projection } = await loadProjection(d, missionId, principal.workspaceId);
  const assignment = projection.assignments[input.assignmentId];
  if (!assignment || assignment.assigneeParticipantId !== input.participantId) {
    throw new MissionApiError("The Git candidate is not bound to the selected Mission assignment and participant.", "validation_error", 400);
  }
  let candidate: ReturnType<typeof buildGitCommitCandidate>;
  try {
    candidate = buildGitCommitCandidate({
      workspaceId: principal.workspaceId,
      missionId,
      assignmentId: input.assignmentId,
      participantId: input.participantId,
      branch: input.branch,
      commitSha: input.commitSha,
      manifest: input.manifest,
      message: input.message,
    });
  } catch (error) {
    throw new MissionApiError(error instanceof Error ? error.message : "Git candidate is invalid.", "validation_error", 400);
  }

  // Conflict handling (plan §11.6): a second, DIFFERENT candidate for the
  // same branch while an earlier one is still pending (recorded but not yet
  // completed/failed/rejected) is a real conflict, not something to
  // silently allow — the branch has two authors' worth of unresolved
  // candidates at once. Approving/rejecting the SAME candidate again is
  // fine (idempotent retry), which is why this only looks at OTHER digests.
  if (input.decision === "approved") {
    const existing = await d.gitProvenanceReader.list({ workspaceId: principal.workspaceId, missionId, limit: 200 });
    const conflicting = existing.find((record) => record.branch === candidate.branch && record.status === "recorded" && record.candidateDigest !== candidate.candidateDigest);
    if (conflicting) {
      throw new MissionApiError(
        `Branch "${candidate.branch}" already has a pending authorized candidate (${conflicting.candidateDigest.slice(0, 12)}) that has not completed or failed yet. Resolve that one first.`,
        "conflict",
        409,
      );
    }
  }

  const recordedAt = new Date().toISOString();
  let signature: string | null = null;
  let keyId: string | null = null;
  try {
    const signed = signAttestationPayload({ missionId, operation: input.operation, actorId: principal.actor.id, decision: input.decision, candidateDigest: candidate.candidateDigest, recordedAt });
    signature = signed.signature;
    keyId = signed.keyId;
  } catch {
    // No MISSION_GIT_ATTESTATION_SIGNING_KEY configured — the attestation is
    // still recorded and authoritative (Supabase row integrity + the
    // authenticated human session already establish who decided what), it
    // just carries no independent signature. Never block authorization on
    // an optional hardening layer.
  }
  const authorization = {
    actorKind: "human" as const,
    actorId: principal.actor.id,
    decision: input.decision,
    candidateDigest: candidate.candidateDigest,
    recordedAt,
    signature,
    keyId,
  };
  const authorizationResult = authorizeGitOperation({ candidate, operation: input.operation, attestation: authorization });
  const provenance: MissionGitProvenanceRecord = {
    operationId: input.operationId?.trim() || crypto.randomUUID(),
    operation: input.operation,
    workspaceId: principal.workspaceId,
    missionId,
    assignmentId: input.assignmentId,
    participantId: input.participantId,
    branch: candidate.branch,
    commitSha: candidate.commitSha,
    candidateDigest: candidate.candidateDigest,
    manifestDigest: candidate.manifestDigest,
    status: authorizationResult.ok ? "recorded" : "rejected",
    authorization,
    result: null,
    recordedAt,
  };
  const stored = await d.gitProvenanceWriter.record(provenance);
  await auditLog(principal, "mission.git_operation_authorized", { missionId, operationId: stored.operationId, operation: input.operation, decision: input.decision, branch: candidate.branch, commitSha: candidate.commitSha, status: stored.status });
  return { candidate, authorization, authorizationResult, provenance: stored };
}

export interface RecordMissionGitOperationResultInput {
  operationId: string;
  candidateDigest: string;
  outcome: GitOperationResult["outcome"];
  providerRef?: string | null;
  summary: string;
}

/** Record only the outcome of an already human-authorized exact candidate. This never authorizes or executes Git. */
export async function recordMissionGitOperationResult(
  principal: MissionPrincipal,
  missionId: string,
  input: RecordMissionGitOperationResultInput,
): Promise<{ provenance: MissionGitProvenanceRecord }> {
  if (principal.kind !== "agent") throw new MissionApiError("Only an authenticated agent Bridge may report a Git operation result.", "agent_required", 403);
  if (!isMissionFeatureEnabled("gitProvenance")) throw new MissionApiError("Git provenance is disabled for this deployment.", "conflict", 409);
  const d = deps();
  const records = await d.gitProvenanceReader.list({ workspaceId: principal.workspaceId, missionId, limit: 500 });
  const current = records.find((record) => record.operationId === input.operationId && record.candidateDigest === input.candidateDigest && record.status === "recorded");
  if (!current || current.participantId !== principal.actor.id) throw new MissionApiError("Git result is not bound to an approved candidate owned by this Bridge.", "conflict", 409);
  const result: GitOperationResult = {
    outcome: input.outcome,
    providerRef: typeof input.providerRef === "string" ? input.providerRef.trim().slice(0, 512) || null : null,
    summary: input.summary.trim().slice(0, 512),
    recordedAt: new Date().toISOString(),
  };
  if (!result.summary) throw new MissionApiError("A bounded Git result summary is required.", "validation_error", 400);
  const stored = await d.gitProvenanceWriter.recordResult({ workspaceId: principal.workspaceId, missionId, operationId: input.operationId, candidateDigest: input.candidateDigest, result });
  if (!stored) throw new MissionApiError("Git result was already recorded or no longer matches the approved candidate.", "conflict", 409);
  await auditLog(principal, "mission.git_operation_result", { missionId, operationId: input.operationId, outcome: input.outcome, providerRef: result.providerRef });
  await announceGitOperationInFeed(principal, missionId, stored).catch((error) => {
    // Buzz-parity "branch-as-channel": Git activity is announced into the
    // same Mission feed the channel binding writes to (mission-channel-
    // binding.ts), never a silently separate surface. Best-effort only — a
    // feed announcement is not part of Git provenance's own authority chain.
    console.warn(`Mission ${missionId}: could not announce Git operation ${input.operationId} in the feed.`, error instanceof Error ? error.message : error);
  });
  return { provenance: stored };
}

/** Post the recorded Git outcome into the Mission's own message stream — the branch/commit becomes part of the same conversation, not a separate tab. */
async function announceGitOperationInFeed(principal: MissionPrincipal, missionId: string, provenance: MissionGitProvenanceRecord): Promise<void> {
  const outcome = provenance.result?.outcome ?? "unknown";
  const branch = provenance.branch ?? "(no branch)";
  const shortSha = provenance.commitSha ? provenance.commitSha.slice(0, 12) : "(no commit)";
  const body = `${provenance.operation} on ${branch} @ ${shortSha}: ${outcome}${provenance.result?.summary ? ` — ${provenance.result.summary}` : ""}`;
  await postMissionMessage(principal, missionId, {
    senderParticipantId: provenance.participantId,
    messageType: "information",
    recipientParticipantIds: MISSION_BROADCAST_CHANNEL,
    body,
    structuredPayload: { kind: "git_operation", gitOperationId: provenance.operationId, branch: provenance.branch, commitSha: provenance.commitSha, outcome, providerRef: provenance.result?.providerRef ?? null },
    clientRequestId: `git-operation-feed:${provenance.operationId}`,
  });
}

// ---------------------------------------------------------------------------
// Mutations — every one ends in exactly one `dispatch` (== one
// runMissionCommandDurable call). None of these read or write scheduler /
// execution-result tables, and none infer outcomes from provider state.
// ---------------------------------------------------------------------------

export interface MissionLifecycleInput {
  reason?: string | null;
  clientRequestId?: string | null;
}

/** Advance a Mission from wherever it currently is toward active work. There is no single "Start" domain command — this picks the one forward transition the current state actually supports (BeginPlanning from draft, BeginInitialization from ready, BeginExecution from initializing) and otherwise refuses with a typed conflict rather than guessing. */
export async function startMission(principal: MissionPrincipal, missionId: string, input: MissionLifecycleInput = {}): Promise<MissionSummaryDto> {
  const d = deps();
  const { projection } = await loadProjection(d, missionId, principal.workspaceId);
  const command = startCommandFor(projection);
  const context = buildContext(principal.actor);
  const next = await dispatch(d, principal.workspaceId, command, context, input.clientRequestId);
  return toSummary(next);
}

function startCommandFor(projection: MissionProjection): MissionCommand {
  switch (projection.state) {
    case "draft":
      return { type: "BeginPlanning", missionId: projection.missionId };
    case "ready":
      return { type: "BeginInitialization", missionId: projection.missionId };
    case "initializing":
      return { type: "BeginExecution", missionId: projection.missionId };
    default:
      throw new MissionApiError(
        `Mission is in state "${projection.state}" and cannot be started; expected draft, ready, or initializing.`,
        "conflict",
        409,
        { detail: { state: projection.state } },
      );
  }
}

export async function pauseMission(principal: MissionPrincipal, missionId: string, input: MissionLifecycleInput = {}): Promise<MissionSummaryDto> {
  const d = deps();
  const context = buildContext(principal.actor);
  const command: MissionCommand = {
    type: "PauseMission",
    missionId: missionId as MissionId,
    reason: defaultReason("mission_paused", input.reason ?? "Paused via Mission API"),
  };
  const projection = await dispatchOwned(d, principal.workspaceId, missionId, command, context, input.clientRequestId);
  return toSummary(projection);
}

export async function resumeMission(principal: MissionPrincipal, missionId: string, input: MissionLifecycleInput = {}): Promise<MissionSummaryDto> {
  const d = deps();
  const context = buildContext(principal.actor);
  const command: MissionCommand = { type: "ResumeMission", missionId: missionId as MissionId };
  const projection = await dispatchOwned(d, principal.workspaceId, missionId, command, context, input.clientRequestId);
  return toSummary(projection);
}

/** "Stop" maps to `BlockMission` — a resumable halt, distinct from the permanent `CancelMission`. There is no separate domain concept of an unresumable stop short of cancel. */
export async function stopMission(principal: MissionPrincipal, missionId: string, input: MissionLifecycleInput = {}): Promise<MissionSummaryDto> {
  const d = deps();
  const context = buildContext(principal.actor);
  const command: MissionCommand = {
    type: "BlockMission",
    missionId: missionId as MissionId,
    reason: defaultReason("mission_stopped", input.reason ?? "Stopped via Mission API"),
  };
  const projection = await dispatchOwned(d, principal.workspaceId, missionId, command, context, input.clientRequestId);
  return toSummary(projection);
}

export async function cancelMission(principal: MissionPrincipal, missionId: string, input: MissionLifecycleInput = {}): Promise<MissionSummaryDto> {
  const d = deps();
  const context = buildContext(principal.actor);
  const command: MissionCommand = {
    type: "CancelMission",
    missionId: missionId as MissionId,
    reason: defaultReason("mission_cancelled", input.reason ?? "Cancelled via Mission API"),
  };
  const projection = await dispatchOwned(d, principal.workspaceId, missionId, command, context, input.clientRequestId);
  return toSummary(projection);
}

async function dispatchOwned(
  d: MissionServiceDeps,
  workspaceId: string,
  missionId: string,
  command: MissionCommand,
  context: CommandContext,
  clientRequestId?: string | null,
): Promise<MissionProjection> {
  await loadOwnedMissionRow(d.client, missionId, workspaceId);
  return dispatch(d, workspaceId, command, context, clientRequestId);
}

/**
 * `BeginReview` — idempotent by design: if the Mission is already
 * `reviewing` (or past it), this returns the current projection rather than
 * re-issuing the command, so a repeated "request review" call from a
 * flaky client is a no-op, not a conflict.
 */
export async function requestMissionReview(principal: MissionPrincipal, missionId: string, input: MissionLifecycleInput = {}): Promise<MissionSummaryDto> {
  const d = deps();
  const { projection } = await loadProjection(d, missionId, principal.workspaceId);
  if (projection.state === "reviewing" || projection.state === "verifying" || projection.state === "ready_for_decision" || projection.state === "accepted" || projection.state === "rejected") {
    return toSummary(projection);
  }
  const context = buildContext(principal.actor);
  const command: MissionCommand = { type: "BeginReview", missionId: missionId as MissionId };
  const next = await dispatch(d, principal.workspaceId, command, context, input.clientRequestId);
  return toSummary(next);
}

export interface RecordReviewDecisionInput {
  decision: "accept" | "reject" | "request_changes" | "continue_investigation" | "escalate";
  reason?: string | null;
  reviewedRevision?: string | null;
  resumeTo?: "reviewing" | "verifying" | null;
  /** The Mission version this decision was made against — a stale value fails explicitly via `version_conflict`, never silently applies to a Mission that has since moved on. */
  expectedVersion?: number | null;
  clientRequestId?: string | null;
}

/**
 * Only reachable by a `requireHuman`-resolved principal — enforced by the
 * caller (the route resolves the principal with `requireHuman: true`
 * before this is ever invoked; see /api/missions/[missionId]/review/decision).
 * Recorded here defensively too so this function is never safe to call with
 * an agent principal even if a future caller forgets the route-level gate.
 */
export async function recordMissionReviewDecision(principal: MissionPrincipal, missionId: string, input: RecordReviewDecisionInput): Promise<MissionSummaryDto> {
  if (principal.kind !== "human") {
    throw new MissionApiError("Only an authenticated human may record a Mission review decision.", "human_required", 403);
  }
  const d = deps();
  const { projection } = await loadProjection(d, missionId, principal.workspaceId);
  if (input.expectedVersion != null && input.expectedVersion !== projection.aggregateVersion) {
    throw new MissionApiError("Mission has changed since this review decision was prepared; reload and retry.", "version_conflict", 409, {
      detail: { expectedVersion: input.expectedVersion, actualVersion: projection.aggregateVersion },
    });
  }
  const context = buildContext(principal.actor);
  const command: MissionCommand = ((): MissionCommand => {
    switch (input.decision) {
      case "accept":
        return { type: "AcceptMission", missionId: missionId as MissionId, reviewedRevision: input.reviewedRevision ?? null };
      case "reject":
        return { type: "RejectMission", missionId: missionId as MissionId, reason: defaultReason("mission_rejected", input.reason ?? "Rejected via Mission API") };
      case "request_changes":
        return { type: "RequestMissionChanges", missionId: missionId as MissionId, reason: defaultReason("mission_changes_requested", input.reason ?? "Changes requested via Mission API") };
      case "continue_investigation":
        return { type: "ContinueMissionInvestigation", missionId: missionId as MissionId, reason: defaultReason("mission_investigation_continued", input.reason ?? "Investigation continued via Mission API") };
      case "escalate":
        if (input.resumeTo !== "reviewing" && input.resumeTo !== "verifying") {
          throw new MissionApiError("Escalation requires an explicit reviewing or verifying resume target.", "validation_error", 400);
        }
        return {
          type: "EscalateMission",
          missionId: missionId as MissionId,
          reason: defaultReason("mission_escalated", input.reason ?? "Escalated for additional human input"),
          resumeTo: input.resumeTo,
        };
    }
  })();
  const next = await dispatch(d, principal.workspaceId, command, context, input.clientRequestId);
  await auditLog(principal, "mission.review_decision", { missionId, decision: input.decision, reason: input.reason ?? null });
  return toSummary(next);
}

export { queryMissionMessages };
