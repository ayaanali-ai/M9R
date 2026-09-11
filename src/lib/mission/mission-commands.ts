/**
 * Mission commands — the initial command union and the context every command
 * carries.
 * ----------------------------------------------------------------------------
 * This module defines DATA only. The behavior that interprets these commands
 * lives in `mission-command-handler.ts`, which is where purity is enforced.
 */

import { createHash } from "node:crypto";
import type {
  AssignmentApprovalPolicy,
  ActiveMissionState,
  AssignmentBudget,
  AssignmentId,
  AssignmentScope,
  MessageRecipients,
  MessageType,
  MissionId,
  MissionState,
  ParticipantCommunicationPermissions,
  ParticipantId,
  ParticipantKind,
  ParticipantRole,
  ParticipantWorkspacePermissions,
  StateReason,
} from "./mission-domain";
import type { EventActor, MissionEvent } from "./mission-events";
import type { IdempotencyKey } from "./mission-idempotency";
import type { AgentKindKey } from "@/lib/agent-workspace-data";
import type { RunMode } from "@/lib/run-mode";

// ---------------------------------------------------------------------------
// Command context
// ---------------------------------------------------------------------------

/**
 * Everything a command needs that is not about the command's own intent:
 * who is doing it, why it's linked to what came before, and when.
 *
 * `correlationId` groups every event produced by one logical user request —
 * every event emitted by a single command call shares it. `causationId`
 * points at the event or message that directly triggered this command, and is
 * null only for a root command (nothing upstream caused it).
 *
 * Both are supplied here, already resolved, so `applyMissionCommand` itself
 * never has to decide where an id comes from — see `mintCorrelationId` below
 * for the one place that minting happens, which is deliberately OUTSIDE the
 * pure handler.
 */
export interface CommandContext {
  correlationId: string;
  causationId: string | null;
  actor: EventActor;
  timestamp: string;
}

/**
 * Mint a correlationId at the outer command boundary when the caller has none
 * to propagate. Deliberately NOT called from inside `applyMissionCommand` —
 * minting happens once, by whatever is constructing the CommandContext, so the
 * handler itself stays a function of its inputs alone.
 *
 * Uses `randomUUID`, which touches no database, provider, or external state —
 * it is non-deterministic output, not an infrastructure dependency, which is
 * the distinction the architecture rule actually draws.
 */
export function mintCorrelationId(): string {
  return crypto.randomUUID();
}

export function resolveCommandContext(input: {
  correlationId?: string | null;
  causationId?: string | null;
  actor: EventActor;
  timestamp: string;
}): CommandContext {
  return {
    correlationId: input.correlationId?.trim() || mintCorrelationId(),
    causationId: input.causationId ?? null,
    actor: input.actor,
    timestamp: input.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Command union
// ---------------------------------------------------------------------------

type ExecutionCommandBase = {
  missionId: MissionId;
  workspaceId: string;
  assignmentId: AssignmentId;
  dispatchIntentId: string;
  executionId: string;
  dispatchKey: string;
  providerAdapterId: string;
  leaseId: string;
  /** Canonical decimal string: never round-trip a PostgreSQL bigint through JS number. */
  fencingToken: string;
  attempt: number;
  correlationId: string;
  causationId: string | null;
  timestamp: string;
  resultDigest?: string | null;
  reason?: string | null;
  evidenceIds?: string[];
};

export type MissionCommand =
  | {
      type: "CreateMission";
      missionId: MissionId;
      workspaceId: string;
      repository: string;
      /** Optional stable repository identifier; null when the caller has none. Genesis-only, immutable thereafter. */
      repositoryId?: string | null;
      goal: string;
      mode: RunMode;
    }
  | { type: "BeginPlanning"; missionId: MissionId }
  | { type: "MarkMissionReady"; missionId: MissionId; planVersion: number }
  | { type: "BeginInitialization"; missionId: MissionId }
  | { type: "BeginExecution"; missionId: MissionId }
  | { type: "BeginReview"; missionId: MissionId }
  | { type: "BeginVerification"; missionId: MissionId }
  | { type: "RequestInput"; missionId: MissionId; reason: StateReason }
  | { type: "BlockMission"; missionId: MissionId; reason: StateReason }
  | { type: "PauseMission"; missionId: MissionId; reason: StateReason }
  | { type: "ResumeMission"; missionId: MissionId }
  | { type: "MarkReadyForDecision"; missionId: MissionId }
  | { type: "AcceptMission"; missionId: MissionId; reviewedRevision: string | null }
  | { type: "RejectMission"; missionId: MissionId; reason: StateReason }
  // ---- Decision surface: send work back rather than accept/reject outright --
  // Both target "reviewing" (never "executing" directly — see the state
  // machine's own comment on this edge). `EscalateMission` is deliberately
  // NOT added here yet: it needs a resume-target concept ready_for_decision
  // doesn't have today, left for a follow-up rather than guessed at.
  | { type: "RequestMissionChanges"; missionId: MissionId; reason: StateReason }
  | { type: "ContinueMissionInvestigation"; missionId: MissionId; reason: StateReason }
  | { type: "EscalateMission"; missionId: MissionId; reason: StateReason; resumeTo: ActiveMissionState }
  | { type: "CancelMission"; missionId: MissionId; reason: StateReason }
  | { type: "FailMission"; missionId: MissionId; reason: StateReason }
  // ---- Phase 4A: participants ----------------------------------------------
  | {
      type: "AddParticipant";
      missionId: MissionId;
      participantId: ParticipantId;
      kind: ParticipantKind;
      role: ParticipantRole;
      displayName: string;
      agentKind: AgentKindKey | null;
      /** e.g. "codex" | "claude-code" — the ProviderAdapter.id this participant's execution attempts run under. */
      provider: string | null;
      adapterId: string | null;
      capabilities: string[];
      assignmentScope: AssignmentScope;
      workspacePermissions: ParticipantWorkspacePermissions;
      communicationPermissions: ParticipantCommunicationPermissions;
    }
  | { type: "ActivateParticipant"; missionId: MissionId; participantId: ParticipantId }
  | { type: "RemoveParticipant"; missionId: MissionId; participantId: ParticipantId; reason: StateReason }
  // ---- Phase 4A: assignments -----------------------------------------------
  | {
      type: "CreateAssignment";
      missionId: MissionId;
      assignmentId: AssignmentId;
      title: string;
      objective: string;
      scope: AssignmentScope;
      dependencies: AssignmentId[];
      requiredEvidence: string[];
      approvalPolicy: AssignmentApprovalPolicy;
      budget: AssignmentBudget;
    }
  | { type: "AssignAssignment"; missionId: MissionId; assignmentId: AssignmentId; assigneeParticipantId: ParticipantId; dispatchKey: string }
  | { type: "StartAssignment"; missionId: MissionId; assignmentId: AssignmentId }
  | { type: "BlockAssignment"; missionId: MissionId; assignmentId: AssignmentId; reason: StateReason }
  | { type: "SubmitAssignment"; missionId: MissionId; assignmentId: AssignmentId; evidenceRefs: string[] }
  | { type: "VerifyAssignment"; missionId: MissionId; assignmentId: AssignmentId; verified: boolean; reason?: StateReason }
  | { type: "AcceptAssignment"; missionId: MissionId; assignmentId: AssignmentId }
  | { type: "RejectAssignment"; missionId: MissionId; assignmentId: AssignmentId; reason: StateReason }
  | { type: "CancelAssignment"; missionId: MissionId; assignmentId: AssignmentId; reason: StateReason }
  // ---- Phase 4B: clarification (waiting_for_input) --------------------------
  // ---- Phase 4D Part 4 §6: atomic clarification ------------------------------
  // Each command creates its OWN message event (question/answer) AND the
  // assignment transition event in the SAME atomic payload batch — never a
  // separately-committed prior `PostMessage` a caller has to remember to
  // send first. This is the fix for the two-command flow the audit
  // flagged: a crash between "message posted" and "assignment transitioned"
  // can no longer happen, because there is no longer a gap between them —
  // one command, one idempotency key, one expected-version check, one
  // event batch.
  | {
      type: "AskAssignmentQuestion";
      missionId: MissionId;
      assignmentId: AssignmentId;
      messageId: string;
      senderParticipantId: ParticipantId;
      recipientParticipantIds: MessageRecipients;
      body: string;
      evidenceRefs: string[];
    }
  | {
      type: "AnswerAssignmentQuestion";
      missionId: MissionId;
      assignmentId: AssignmentId;
      questionMessageId: string;
      messageId: string;
      senderParticipantId: ParticipantId;
      recipientParticipantIds: MessageRecipients;
      body: string;
      evidenceRefs: string[];
    }
  // ---- Phase 4B: finding lifecycle ------------------------------------------
  | {
      type: "OpenFinding";
      missionId: MissionId;
      findingId: string;
      assignmentId: AssignmentId;
      openedByParticipantId: ParticipantId;
      responsibleParticipantId: ParticipantId | null;
      statement: string;
      evidenceRefs: string[];
      originatingMessageId: string;
    }
  | {
      type: "TransitionFinding";
      missionId: MissionId;
      findingId: string;
      nextStatus: import("./mission-domain").FindingStatus;
      resolutionEvidenceRefs?: string[];
    }
  // ---- Phase 5A: Mission Plan proposals -------------------------------------
  // `plan`/`newPlan` are ALREADY-BUILT `MissionPlanProposal`s — built by
  // `MissionPlanner.propose`/a future model-backed equivalent OUTSIDE
  // `applyMissionCommand` (which stays pure and template-agnostic); the
  // command only records what was proposed and enforces the same
  // idempotency/concurrency/tenant machinery every other command does.
  | { type: "ProposeMissionPlan"; missionId: MissionId; planId: string; plan: import("./mission-domain").MissionPlanProposal }
  | { type: "ValidateMissionPlan"; missionId: MissionId; planId: string; context: import("./mission-planner-validator").PlanValidationContext }
  | { type: "ApproveMissionPlan"; missionId: MissionId; planId: string }
  | { type: "RejectMissionPlan"; missionId: MissionId; planId: string; reason: StateReason }
  | { type: "SupersedeMissionPlan"; missionId: MissionId; planId: string; newPlan: import("./mission-domain").MissionPlanProposal }
  | { type: "MaterializeMissionPlan"; missionId: MissionId; planId: string }
  // ---- Phase 3D.0: authoritative execution lifecycle ----------------------
  // Worker/provider code never appends these events. The execution result port
  // accepts a fenced scheduler result first, then invokes this command boundary.
  | ({ type: "RecordExecutionStarted" } & ExecutionCommandBase)
  | ({ type: "RecordExecutionCompleted" } & ExecutionCommandBase)
  | ({ type: "RecordExecutionFailed" } & ExecutionCommandBase)
  | ({ type: "RecordExecutionCancelled" } & ExecutionCommandBase)
  | ({ type: "RecordExecutionLeaseLost" } & ExecutionCommandBase)
  // ---- Phase 4D Part 4: evidence provenance ---------------------------------
  // The ONLY way a MissionEvidenceRecord comes into existence — a message
  // (`evidence_notice`) may only REFERENCE an already-recorded id, never
  // create one. Keeps the authoritative evidence store out of message
  // payloads entirely.
  | {
      type: "RecordEvidence";
      missionId: MissionId;
      evidenceId: string;
      assignmentId: AssignmentId | null;
      producerParticipantId: ParticipantId | null;
      producerKind: import("./mission-domain").EvidenceProducerKind;
      executionId: string | null;
      dispatchKey: string | null;
      provider: string | null;
      kind: import("./mission-domain").EvidenceNoticeKind;
      source: string;
      lifecycle: import("./mission-domain").EvidenceLifecycle;
      availability: import("./mission-domain").EvidenceAvailability;
      integrity: import("./mission-domain").EvidenceIntegrity | null;
    }
  | { type: "SupersedeEvidence"; missionId: MissionId; evidenceId: string; supersededByEvidenceId: string }
  // ---- Phase 5B §14: Plan cancellation ---------------------------------------
  // Deliberately separate from `RejectMissionPlan` (a domain-semantic
  // decision, e.g. "a human decided this Plan is wrong") — cancellation is
  // "this Plan is no longer wanted," a distinct fact, same split Phase 1
  // drew between evidence attachment and attestation. `PLAN_TRANSITIONS`
  // (mission-collaboration.ts) refuses this from `materializing`/`active`
  // — a materialized Plan cannot be cancelled, matching the audit's own
  // determination.
  | { type: "CancelMissionPlan"; missionId: MissionId; planId: string; reason: StateReason }
  // ---- Phase 5B: model-assisted planning request/result lifecycle -----------
  // `RequestModelPlanning` durably records that a model was asked to
  // produce (`kind: "proposal"`) or revise (`kind: "revision"`) a Plan —
  // the actual external model call happens OUTSIDE this command, by an
  // impure worker, never inside this atomic transaction (§10). Carries the
  // TRUSTED planning capability profile the caller is asserting for
  // `modelConfigurationId` — the model can never declare its own
  // capabilities (mission-planning-capability.ts).
  | {
      type: "RequestModelPlanning";
      missionId: MissionId;
      planningRequestId: string;
      kind: import("./mission-domain").PlanningRequestKind;
      targetPlanVersion: number;
      basePlanId: import("./mission-domain").PlanId | null;
      modelConfigurationId: string;
      planningCapabilities: import("./mission-planning-capability").PlanningCapabilityRecord;
      contextHash: string;
      maxAttempts: number;
    }
  // `RecordModelPlanningResult` is the ONLY place raw model output is ever
  // parsed — schema-validated (mission-model-plan-schema.ts), normalized
  // into the canonical `MissionPlanProposal` (mission-model-plan-normalizer.ts),
  // then run through the EXACT SAME deterministic
  // `validateMissionPlanProposal`/`simulateMissionPlanProposal` every
  // deterministically-authored Plan already goes through. `rawModelOutputText`
  // is present on an attempt that produced output; `failureCode` is present
  // on an attempt that failed before producing any (e.g. the model call
  // itself errored) — never both, never neither.
  | {
      type: "RecordModelPlanningResult";
      missionId: MissionId;
      planningRequestId: string;
      rawModelOutputText: string | null;
      failureCode: string | null;
      redactedDiagnosticRef: string | null;
      availableProviders: import("./mission-planner").PlannerProviderDescriptor[];
      planValidationContext: import("./mission-planner-validator").PlanValidationContext;
      createdBy: string;
    }
  | { type: "CancelModelPlanningRequest"; missionId: MissionId; planningRequestId: string; reason: StateReason }
  // ---- Phase 4A: Agent Message Protocol ------------------------------------
  | {
      type: "PostMessage";
      missionId: MissionId;
      messageId: string;
      senderParticipantId: ParticipantId;
      recipientParticipantIds: MessageRecipients;
      assignmentId: AssignmentId | null;
      messageType: MessageType;
      body: string;
      evidenceRefs: string[];
      replyToMessageId: string | null;
      /**
       * Typed protocol fields for this message's `type` — e.g. a
       * `delegation_response`'s `{accepted, childTitle, childObjective,
       * allowedPaths?, prohibitedPaths?}`. Interpreted by
       * `mission-command-handler.ts`'s collaboration branch, never by
       * free-form `body` text. Deliberately does NOT carry a delegation
       * depth field — depth is always derived from the durable message
       * chain (mission-collaboration-graph.ts), never accepted from a
       * caller.
       */
      structuredPayload?: Record<string, unknown>;
    };

export type MissionCommandType = MissionCommand["type"];

/** The Phase 4A commands that coordinate participants/assignments/messages — routed by `mission-command-handler.ts` through `mission-collaboration.ts`/`mission-communication-policy.ts` instead of the Mission-state machine. Never emits `mission.state_changed`. */
export const COLLABORATION_COMMAND_TYPES = [
  "AddParticipant",
  "ActivateParticipant",
  "RemoveParticipant",
  "CreateAssignment",
  "AssignAssignment",
  "StartAssignment",
  "BlockAssignment",
  "SubmitAssignment",
  "VerifyAssignment",
  "AcceptAssignment",
  "RejectAssignment",
  "CancelAssignment",
  "AskAssignmentQuestion",
  "AnswerAssignmentQuestion",
  "OpenFinding",
  "TransitionFinding",
  "ProposeMissionPlan",
  "ValidateMissionPlan",
  "ApproveMissionPlan",
  "RejectMissionPlan",
  "SupersedeMissionPlan",
  "MaterializeMissionPlan",
  "RecordEvidence",
  "SupersedeEvidence",
  "CancelMissionPlan",
  "RequestModelPlanning",
  "RecordModelPlanningResult",
  "CancelModelPlanningRequest",
  "PostMessage",
] as const satisfies readonly MissionCommandType[];

export function isCollaborationCommand(command: MissionCommand): boolean {
  return (COLLABORATION_COMMAND_TYPES as readonly string[]).includes(command.type);
}

// ---------------------------------------------------------------------------
// Idempotency support specific to commands
// ---------------------------------------------------------------------------

/**
 * Hash of the command's payload ALONE — independent of whether the caller
 * supplied a custom idempotency key. This is what makes "same key, different
 * payload" detectable: two calls can share a key while this digest differs,
 * which is exactly the conflict case, not a replay.
 */
export function hashCommandPayload(command: MissionCommand): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

/**
 * Digest over exactly the fields that make two messages semantically the
 * same content, used by `DuplicateMessageIdError.samePayload` (mission-
 * command-handler.ts's PostMessage/AskAssignmentQuestion/
 * AnswerAssignmentQuestion duplicate-id checks) to decide "identical message
 * resubmitted under a different idempotency key" vs. "a genuinely different
 * message tried to reuse this id." Same technique as `hashCommandPayload`
 * (sha256 over a canonical JSON shape) rather than a hand-rolled
 * field-by-field `===`/`JSON.stringify` chain, so adding a new
 * content-bearing field to `MissionMessage` can't silently fall out of this
 * comparison the way it could with manual equality.
 */
export function messagePayloadDigest(input: {
  senderParticipantId: string;
  type: string;
  body: string;
  assignmentId: string | null;
  recipientParticipantIds: unknown;
  evidenceRefs?: readonly string[];
  replyToMessageId: string | null;
  structuredPayload?: unknown;
}): string {
  return createHash("sha256").update(JSON.stringify({
    senderParticipantId: input.senderParticipantId,
    type: input.type,
    body: input.body,
    assignmentId: input.assignmentId,
    recipientParticipantIds: input.recipientParticipantIds,
    evidenceRefs: input.evidenceRefs ?? [],
    replyToMessageId: input.replyToMessageId,
    structuredPayload: input.structuredPayload ?? {},
  })).digest("hex");
}

/** What gets remembered against an idempotency key after a command applies. */
export interface CommandOutcomeRecord {
  idempotencyKey: IdempotencyKey;
  payloadDigest: string;
  events: MissionEvent[];
  aggregateVersion: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface VersionConflictError {
  code: "version_conflict";
  missionId: MissionId;
  expectedVersion: number;
  currentVersion: number;
  message: string;
}

export interface IdempotencyConflictError {
  code: "idempotency_conflict";
  message: string;
}

/** The caller-supplied workspaceId does not match the Mission's own genesis workspace_id — a tenant-isolation refusal, never conflated with a concurrency conflict. Raised only by the durable (Supabase) persistence path; the in-memory reference path has no separate tenant store to disagree with. */
export interface WorkspaceMismatchError {
  code: "workspace_mismatch";
  missionId: MissionId;
  suppliedWorkspaceId: string;
}

export interface InvalidTransitionError {
  code: "invalid_transition";
  from: MissionState;
  attempted: MissionState;
  errors: string[];
}

export interface MissionNotFoundError {
  code: "mission_not_found";
  missionId: MissionId;
}

export interface MissionAlreadyExistsError {
  code: "mission_already_exists";
  missionId: MissionId;
}

export interface NoResumeTargetError {
  code: "no_resume_target";
  missionId: MissionId;
  message: string;
}

// ---- Phase 4A: participants/assignments/messages ---------------------------

export interface ParticipantNotFoundError {
  code: "participant_not_found";
  missionId: MissionId;
  participantId: ParticipantId;
}

export interface ParticipantAlreadyExistsError {
  code: "participant_already_exists";
  missionId: MissionId;
  participantId: ParticipantId;
}

export interface InvalidParticipantTransitionError {
  code: "invalid_participant_transition";
  participantId: ParticipantId;
  errors: string[];
}

export interface AssignmentNotFoundError {
  code: "assignment_not_found";
  missionId: MissionId;
  assignmentId: AssignmentId;
}

export interface AssignmentAlreadyExistsError {
  code: "assignment_already_exists";
  missionId: MissionId;
  assignmentId: AssignmentId;
}

export interface InvalidAssignmentTransitionError {
  code: "invalid_assignment_transition";
  assignmentId: AssignmentId;
  errors: string[];
}

export interface AssignmentDependenciesUnsatisfiedError {
  code: "assignment_dependencies_unsatisfied";
  assignmentId: AssignmentId;
  unsatisfied: AssignmentId[];
}

export interface AssigneeNotActiveError {
  code: "assignee_not_active";
  participantId: ParticipantId;
}

export interface MessagePolicyViolationError {
  code: "message_policy_violation";
  violation: import("./mission-communication-policy").MessagePolicyViolation;
}

/** `messageId` is already used within this Mission — refused before any policy/protocol validation runs. `samePayload` distinguishes "identical message resubmitted under a different idempotency key" from "a genuinely different message tried to reuse this id"; both are refused, never merged or overwritten. */
export interface DuplicateMessageIdError {
  code: "duplicate_message_id";
  missionId: MissionId;
  messageId: string;
  samePayload: boolean;
}

/** An agent actor tried to post a message claiming a DIFFERENT participant's `senderParticipantId` — impersonation, refused before any policy/protocol check runs. */
export interface SenderIdentityMismatchError {
  code: "sender_identity_mismatch";
  missionId: MissionId;
  actorId: string;
  claimedSenderParticipantId: ParticipantId;
}

/** `structuredPayload` failed real runtime schema validation (mission-protocol-schema.ts) — a TypeScript cast is never treated as proof of shape. */
export interface ProtocolSchemaViolationError {
  code: "protocol_schema_violation";
  error: import("./mission-protocol-schema").ProtocolSchemaError;
}

// ---- Phase 4B: findings, questions, delegation --------------------------

export interface FindingNotFoundError {
  code: "finding_not_found";
  missionId: MissionId;
  findingId: string;
}

export interface FindingAlreadyExistsError {
  code: "finding_already_exists";
  missionId: MissionId;
  findingId: string;
}

export interface InvalidFindingTransitionError {
  code: "invalid_finding_transition";
  findingId: string;
  errors: string[];
}

export interface QuestionNotFoundError {
  code: "question_not_found";
  messageId: string;
}

export interface QuestionAlreadyAnsweredError {
  code: "question_already_answered";
  messageId: string;
}

export interface UnresolvedFindingsBlockError {
  code: "unresolved_findings_block_transition";
  assignmentId: AssignmentId;
  findingIds: string[];
}

/**
 * Phase 4C: an assignment whose `approvalPolicy` is `"human_required"`
 * (mission-domain.ts, existing field — not new) must be accepted/rejected
 * by a human actor. A `delegation_response`/`approval_request` message can
 * still PROPOSE the decision informationally, but the decision itself is
 * always this existing typed command, gated here — never granted by a
 * message, and never by an agent actor when the policy says human-only.
 */
export interface UnauthorizedApprovalError {
  code: "unauthorized_approval";
  assignmentId: AssignmentId;
}

// ---- Phase 5A: Mission Plan proposals --------------------------------------

export interface PlanNotFoundError {
  code: "plan_not_found";
  missionId: MissionId;
  planId: string;
}

export interface PlanAlreadyExistsError {
  code: "plan_already_exists";
  missionId: MissionId;
  planId: string;
}

export interface InvalidPlanTransitionError {
  code: "invalid_plan_transition";
  planId: string;
  errors: string[];
}

/** A Plan's `approvalPolicy` is derived from its assignment proposals — if ANY assignment requires human approval, the WHOLE Plan does. An agent actor may never approve such a Plan, mirroring `UnauthorizedApprovalError` for assignments. */
export interface UnauthorizedPlanApprovalError {
  code: "unauthorized_plan_approval";
  planId: string;
}

export interface PlanNotMaterializableError {
  code: "plan_not_materializable";
  planId: string;
  status: import("./mission-domain").PlanStatus;
}

// ---- Phase 4D Part 4: evidence provenance ----------------------------------

export interface EvidenceAlreadyExistsError {
  code: "evidence_already_exists";
  missionId: MissionId;
  evidenceId: string;
}

export interface EvidenceNotFoundError {
  code: "evidence_not_found";
  missionId: MissionId;
  evidenceId: string;
}

/** `RecordEvidence` was given an `assignmentId` that doesn't exist in this Mission — refused before any record is created. */
export interface EvidenceAssignmentNotFoundError {
  code: "evidence_assignment_not_found";
  missionId: MissionId;
  assignmentId: AssignmentId;
}

/** `RecordEvidence` claimed a `dispatchKey` that doesn't match the referenced assignment's own current one — refused before the record is created. */
export interface EvidenceDispatchKeyMismatchError {
  code: "evidence_dispatch_key_mismatch";
  missionId: MissionId;
  evidenceId: string;
  assignmentId: AssignmentId;
  expectedDispatchKey: string | null;
  actualDispatchKey: string;
}

// ---- Phase 5B: model-assisted planning -------------------------------------

export interface PlanningRequestNotFoundError {
  code: "planning_request_not_found";
  missionId: MissionId;
  planningRequestId: string;
}

export interface PlanningRequestAlreadyExistsError {
  code: "planning_request_already_exists";
  missionId: MissionId;
  planningRequestId: string;
}

export interface InvalidPlanningRequestTransitionError {
  code: "invalid_planning_request_transition";
  planningRequestId: string;
  errors: string[];
}

/** `RequestModelPlanning`'s asserted `planningCapabilities` did not meet the minimum required set — refused before any durable request is even created. */
export interface PlanningCapabilityUnresolvedError {
  code: "planning_capability_unresolved";
  modelConfigurationId: string;
  missingCapabilities: string[];
}

/** The planning request is not in a state that can accept a result (already terminal, or the Mission itself is terminal) — a late/stale result, refused before it can create or revise anything. */
export interface PlanningRequestNotActionableError {
  code: "planning_request_not_actionable";
  planningRequestId: string;
  status: import("./mission-domain").PlanningRequestStatus;
}

/** `RequestModelPlanning` targeted a `basePlanId` (kind: "revision") that doesn't exist, or targeted a Plan that is already terminal/materialized — a revision base must be a real, still-revisable Plan. */
export interface PlanRevisionBaseInvalidError {
  code: "plan_revision_base_invalid";
  missionId: MissionId;
  basePlanId: string;
  detail: string;
}

/** `RequestModelPlanning` targeted a Mission that is already terminal — no new planning request may be created once a Mission has reached a terminal state, whatever it would have targeted. */
export interface MissionTerminalError {
  code: "mission_terminal";
  missionId: MissionId;
}

export type ApplyCommandError =
  | VersionConflictError
  | IdempotencyConflictError
  | WorkspaceMismatchError
  | import("./mission-authorization").UnauthorizedCommandError
  | InvalidTransitionError
  | MissionNotFoundError
  | MissionAlreadyExistsError
  | NoResumeTargetError
  | ParticipantNotFoundError
  | ParticipantAlreadyExistsError
  | InvalidParticipantTransitionError
  | AssignmentNotFoundError
  | AssignmentAlreadyExistsError
  | InvalidAssignmentTransitionError
  | AssignmentDependenciesUnsatisfiedError
  | AssigneeNotActiveError
  | MessagePolicyViolationError
  | DuplicateMessageIdError
  | SenderIdentityMismatchError
  | ProtocolSchemaViolationError
  | FindingNotFoundError
  | FindingAlreadyExistsError
  | InvalidFindingTransitionError
  | QuestionNotFoundError
  | QuestionAlreadyAnsweredError
  | UnresolvedFindingsBlockError
  | UnauthorizedApprovalError
  | PlanNotFoundError
  | PlanAlreadyExistsError
  | InvalidPlanTransitionError
  | UnauthorizedPlanApprovalError
  | PlanNotMaterializableError
  | EvidenceAlreadyExistsError
  | EvidenceNotFoundError
  | EvidenceAssignmentNotFoundError
  | EvidenceDispatchKeyMismatchError
  | PlanningRequestNotFoundError
  | PlanningRequestAlreadyExistsError
  | InvalidPlanningRequestTransitionError
  | PlanningCapabilityUnresolvedError
  | PlanningRequestNotActionableError
  | PlanRevisionBaseInvalidError
  | MissionTerminalError;
