/**
 * Mission command handler — the narrow seam every orchestrator command
 * flows through.
 * ----------------------------------------------------------------------------
 * ARCHITECTURE RULE: `applyMissionCommand` is pure with respect to
 * infrastructure. It reads no database, calls no provider, mutates no
 * external state. Every fact it needs — the current projection, the prior
 * idempotency outcome, the clock — is a parameter. The same input always
 * produces the same output.
 *
 * This is what makes it testable without a database and safe to call from
 * inside a transaction later: the impure shell around it (a future API route
 * or orchestrator step) owns the actual read/write; this function only
 * decides what SHOULD happen.
 *
 * Order of checks matters and is deliberate:
 *   1. Idempotency — a genuine retry must succeed even if the version has
 *      since moved on, because from the caller's point of view nothing new is
 *      happening.
 *   2. Existence — CreateMission must not clobber, other commands must have
 *      something to act on.
 *   3. Optimistic concurrency — only once we know this is real, new work.
 *   4. Transition legality — the state machine has the final word.
 */

import {
  isActiveMissionState,
  type ActiveMissionState,
  type Mission,
  type MissionAssignment,
  type MissionFinding,
  type MissionMessage,
  type MissionParticipant,
  type MissionState,
} from "./mission-domain";
import { requiresResumeTarget, validateTransition } from "./mission-state-machine";
import { createMissionEvent, type MissionEvent, type MissionEventPayload } from "./mission-events";
import { transitionMissionExecution, type MissionExecutionRecord } from "./mission-execution-registry";
import { checkExpectedVersion } from "./mission-concurrency";
import {
  applyMissionEvent,
  emptyMissionProjection,
  type MissionProjection,
} from "./mission-projection";
import {
  hashCommandPayload,
  messagePayloadDigest,
  isCollaborationCommand,
  type ApplyCommandError,
  type CommandContext,
  type CommandOutcomeRecord,
  type MissionCommand,
} from "./mission-commands";
import { checkDependenciesSatisfied, findingsBlockingVerification, validateAssignmentTransition, validateFindingTransition, validatePlanTransition, validateParticipantTransition, validatePlanningRequestTransition, findOutstandingPlanningRequestForSlot } from "./mission-collaboration";
import { authorizeMissionCommand, resolveAgentParticipantId } from "./mission-authorization";
import { validateStructuredPayloadSchema } from "./mission-protocol-schema";
import { validateMissionPlanProposal } from "./mission-planner-validator";
import { simulateMissionPlanProposal } from "./mission-planner-simulator";
import { checkPlanningCapabilities } from "./mission-planning-capability";
import { validateRawModelPlanOutput } from "./mission-model-plan-schema";
import { normalizeModelPlanProposal } from "./mission-model-plan-normalizer";
import { validateDelegationApproval, validateMessage, type CommunicationPolicyConfig, DEFAULT_COMMUNICATION_POLICY } from "./mission-communication-policy";
import { deriveDelegationDepth, validateScopeNarrowing, wouldCreateParticipantCycle } from "./mission-collaboration-graph";
import {
  validateApprovalRequestPayload,
  validateBlockerPayload,
  validateCompletionNoticePayload,
  validateEvidenceNoticePayload,
  validateReviewRequestPayload,
} from "./mission-collaboration-protocol";

export interface ApplyCommandInput {
  /** Null only when the command is CreateMission and the mission is new. */
  current: MissionProjection | null;
  command: MissionCommand;
  context: CommandContext;
  /** The caller's belief about the current version. 0 for CreateMission. */
  expectedVersion: number;
  /** Pre-fetched idempotency record for this key, if the caller found one. */
  priorOutcome: CommandOutcomeRecord | null;
  /** Injectable for deterministic tests; defaults to a random id per event. */
  mintEventId?: () => string;
  /** Governs `PostMessage` (mission-communication-policy.ts). Defaults to `DEFAULT_COMMUNICATION_POLICY`. */
  communicationPolicy?: CommunicationPolicyConfig;
}

export interface ApplyCommandSuccess {
  ok: true;
  projection: MissionProjection;
  events: MissionEvent[];
  aggregateVersion: number;
  /** True when this result was replayed from a prior identical command. */
  replayed: boolean;
}

export interface ApplyCommandFailure {
  ok: false;
  error: ApplyCommandError;
}

export type ApplyCommandResult = ApplyCommandSuccess | ApplyCommandFailure;

function defaultMintEventId(): string {
  return crypto.randomUUID();
}

function humanMissionParticipant(context: CommandContext): MissionParticipant {
  return {
    id: context.actor.id,
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
    createdAt: context.timestamp,
    updatedAt: context.timestamp,
  };
}

/**
 * The target state a command intends to reach. For commands where the target
 * depends on where the mission currently is (resuming, or looping between
 * review/verification), this consults `current` — but the actual LEGALITY of
 * reaching it is always decided by `validateTransition`, never here.
 */
function intendedTargetState(command: MissionCommand, current: Mission | MissionProjection | null): MissionState | null {
  switch (command.type) {
    case "CreateMission":
      return "draft";
    case "BeginPlanning":
      return "planning";
    case "MarkMissionReady":
      return "ready";
    case "BeginInitialization":
      return "initializing";
    case "BeginExecution":
      return "executing";
    case "BeginReview":
      return "reviewing";
    case "BeginVerification":
      return "verifying";
    case "RequestInput":
      return "needs_input";
    case "BlockMission":
      return "blocked";
    case "PauseMission":
      return "paused";
    case "ResumeMission":
      // The only legal resume target is the one recorded at interruption
      // time — never any active state, and never guessed.
      return (current as MissionProjection | null)?.resumeTo ?? null;
    case "MarkReadyForDecision":
      return "ready_for_decision";
    case "AcceptMission":
      return "accepted";
    case "RejectMission":
      return "rejected";
    case "RequestMissionChanges":
    case "ContinueMissionInvestigation":
      return "reviewing";
    case "EscalateMission":
      return "needs_input";
    case "CancelMission":
      return "cancelled";
    case "FailMission":
      return "failed";
    // Phase 4A collaboration commands never reach this function —
    // `applyMissionCommand` branches them to `applyCollaborationCommand`
    // before `intendedTargetState` is ever called. Listed explicitly
    // (rather than a catch-all `default`) so a genuinely new Mission-state
    // command added later still gets TypeScript's exhaustiveness check.
    case "AddParticipant":
    case "ActivateParticipant":
    case "RemoveParticipant":
    case "CreateAssignment":
    case "AssignAssignment":
    case "StartAssignment":
    case "BlockAssignment":
    case "SubmitAssignment":
    case "VerifyAssignment":
    case "AcceptAssignment":
    case "RejectAssignment":
    case "CancelAssignment":
    case "AskAssignmentQuestion":
    case "AnswerAssignmentQuestion":
    case "OpenFinding":
    case "TransitionFinding":
    case "ProposeMissionPlan":
    case "ValidateMissionPlan":
    case "ApproveMissionPlan":
    case "RejectMissionPlan":
    case "SupersedeMissionPlan":
    case "MaterializeMissionPlan":
    case "RecordExecutionStarted":
    case "RecordExecutionCompleted":
    case "RecordExecutionFailed":
    case "RecordExecutionCancelled":
    case "RecordExecutionLeaseLost":
    case "RecordEvidence":
    case "SupersedeEvidence":
    case "CancelMissionPlan":
    case "RequestModelPlanning":
    case "RecordModelPlanningResult":
    case "CancelModelPlanningRequest":
    case "PostMessage":
      return null;
  }
}

/** Reason attached to the command, when its type carries one. */
function reasonOf(command: MissionCommand) {
  switch (command.type) {
    case "RequestInput":
    case "BlockMission":
    case "PauseMission":
    case "RejectMission":
    case "CancelMission":
    case "FailMission":
    case "RequestMissionChanges":
    case "ContinueMissionInvestigation":
    case "EscalateMission":
      return command.reason;
    default:
      return null;
  }
}

/**
 * Build the event payload(s) a command produces once its transition has been
 * validated. Most commands emit one `mission.state_changed`. Two commands
 * emit a second, more specific event alongside it:
 *   - MarkMissionReady also records which plan version was approved.
 *   - Accept/RejectMission also records the decision itself.
 * Modelling these as a genuinely separate fact from the state change is what
 * keeps "the mission moved to ready_for_decision" distinct from "a human
 * decided accept" — the same separation Phase 1 drew between evidence
 * attachment and attestation.
 */
function payloadsFor(
  command: MissionCommand,
  transition: { previousState: MissionState; nextState: MissionState; resumeTo: ActiveMissionState | null },
): MissionEventPayload[] {
  const payloads: MissionEventPayload[] = [
    {
      type: "mission.state_changed",
      previousState: transition.previousState,
      nextState: transition.nextState,
      resumeTo: transition.resumeTo,
    },
  ];

  if (command.type === "MarkMissionReady") {
    payloads.unshift({ type: "mission.plan_approved", planVersion: command.planVersion });
  }
  if (command.type === "AcceptMission") {
    payloads.push({ type: "mission.decision_recorded", decision: "accept", reviewedRevision: command.reviewedRevision });
  }
  if (command.type === "RejectMission") {
    payloads.push({ type: "mission.decision_recorded", decision: "reject", reviewedRevision: null });
  }
  if (command.type === "RequestMissionChanges") {
    payloads.push({ type: "mission.decision_recorded", decision: "request_changes", reviewedRevision: null });
  }
  if (command.type === "ContinueMissionInvestigation") {
    payloads.push({ type: "mission.decision_recorded", decision: "continue_investigation", reviewedRevision: null });
  }
  if (command.type === "EscalateMission") {
    payloads.push({ type: "mission.decision_recorded", decision: "escalate", reviewedRevision: null });
  }

  return payloads;
}

/**
 * The Phase 4A counterpart to `payloadsFor`/`intendedTargetState`/
 * `validateTransition` — but for participants, assignments, and messages,
 * never for `Mission.state`. Called only for `isCollaborationCommand`
 * commands, after the generic idempotency/existence/version checks
 * `applyMissionCommand` already ran; `current` is guaranteed non-null here
 * (no collaboration command is a genesis command the way CreateMission is).
 */
function buildCollaborationPayloads(
  command: MissionCommand,
  current: MissionProjection,
  context: CommandContext,
  communicationPolicy: CommunicationPolicyConfig,
): { ok: true; payloads: MissionEventPayload[] } | { ok: false; error: ApplyCommandError } {
  switch (command.type) {
    case "AddParticipant": {
      if (current.participants[command.participantId]) {
        return { ok: false, error: { code: "participant_already_exists", missionId: command.missionId, participantId: command.participantId } };
      }
      const participant: MissionParticipant = {
        id: command.participantId,
        kind: command.kind,
        role: command.role,
        agentKind: command.agentKind,
        displayName: command.displayName,
        status: "proposed",
        provider: command.provider,
        adapterId: command.adapterId,
        capabilities: command.capabilities,
        assignmentScope: command.assignmentScope,
        workspacePermissions: command.workspacePermissions,
        communicationPermissions: command.communicationPermissions,
        createdAt: context.timestamp,
        updatedAt: context.timestamp,
      };
      return { ok: true, payloads: [{ type: "mission.participant_registered", participant }] };
    }

    case "ActivateParticipant": {
      const participant = current.participants[command.participantId];
      if (!participant) return { ok: false, error: { code: "participant_not_found", missionId: command.missionId, participantId: command.participantId } };
      const transition = validateParticipantTransition(participant.status, "active");
      if (!transition.ok) return { ok: false, error: { code: "invalid_participant_transition", participantId: command.participantId, errors: transition.errors } };
      return {
        ok: true,
        payloads: [{ type: "mission.participant_status_changed", participantId: command.participantId, previousStatus: participant.status, nextStatus: "active" }],
      };
    }

    case "RemoveParticipant": {
      const participant = current.participants[command.participantId];
      if (!participant) return { ok: false, error: { code: "participant_not_found", missionId: command.missionId, participantId: command.participantId } };
      const transition = validateParticipantTransition(participant.status, "removed");
      if (!transition.ok) return { ok: false, error: { code: "invalid_participant_transition", participantId: command.participantId, errors: transition.errors } };
      return { ok: true, payloads: [{ type: "mission.participant_removed", participantId: command.participantId }] };
    }

    case "CreateAssignment": {
      if (current.assignments[command.assignmentId]) {
        return { ok: false, error: { code: "assignment_already_exists", missionId: command.missionId, assignmentId: command.assignmentId } };
      }
      // Always a ROOT assignment — `CreateAssignment` carries no parent
      // fields at all. A delegated CHILD assignment is only ever produced
      // as the side effect of an accepted `delegation_response` message
      // (see the "PostMessage" case below), never through this command
      // directly — that's what keeps depth/scope always derived, never
      // caller-declared.
      const assignment: MissionAssignment = {
        id: command.assignmentId,
        missionId: command.missionId,
        assigneeParticipantId: null,
        title: command.title,
        objective: command.objective,
        scope: command.scope,
        dependencies: command.dependencies,
        requiredEvidence: command.requiredEvidence,
        approvalPolicy: command.approvalPolicy,
        budget: command.budget,
        status: "proposed",
        reviewerParticipantIds: [],
        dispatchKey: null,
        parentAssignmentId: null,
        originatingMessageId: null,
        delegatorParticipantId: null,
        delegationDepth: 0,
        createdAt: context.timestamp,
        updatedAt: context.timestamp,
      };
      return { ok: true, payloads: [{ type: "mission.assignment_created", assignment }] };
    }

    case "AssignAssignment": {
      const assignment = current.assignments[command.assignmentId];
      if (!assignment) return { ok: false, error: { code: "assignment_not_found", missionId: command.missionId, assignmentId: command.assignmentId } };
      const assignee = current.participants[command.assigneeParticipantId];
      if (!assignee) return { ok: false, error: { code: "participant_not_found", missionId: command.missionId, participantId: command.assigneeParticipantId } };
      if (assignee.status !== "active") return { ok: false, error: { code: "assignee_not_active", participantId: command.assigneeParticipantId } };
      const transition = validateAssignmentTransition(assignment.status, "claimed");
      if (!transition.ok) return { ok: false, error: { code: "invalid_assignment_transition", assignmentId: command.assignmentId, errors: transition.errors } };
      return {
        ok: true,
        payloads: [
          {
            type: "mission.assignment_status_changed",
            assignmentId: command.assignmentId,
            previousStatus: assignment.status,
            nextStatus: "claimed",
            assigneeParticipantId: command.assigneeParticipantId,
            dispatchKey: command.dispatchKey,
          },
        ],
      };
    }

    case "StartAssignment": {
      const assignment = current.assignments[command.assignmentId];
      if (!assignment) return { ok: false, error: { code: "assignment_not_found", missionId: command.missionId, assignmentId: command.assignmentId } };
      const dependencyCheck = checkDependenciesSatisfied(assignment, current.assignments);
      if (!dependencyCheck.ok) {
        return { ok: false, error: { code: "assignment_dependencies_unsatisfied", assignmentId: command.assignmentId, unsatisfied: dependencyCheck.unsatisfied } };
      }
      const transition = validateAssignmentTransition(assignment.status, "running");
      if (!transition.ok) return { ok: false, error: { code: "invalid_assignment_transition", assignmentId: command.assignmentId, errors: transition.errors } };
      return { ok: true, payloads: [{ type: "mission.assignment_status_changed", assignmentId: command.assignmentId, previousStatus: assignment.status, nextStatus: "running" }] };
    }

    case "BlockAssignment":
    case "SubmitAssignment":
    case "AcceptAssignment":
    case "RejectAssignment":
    case "CancelAssignment": {
      const assignment = current.assignments[command.assignmentId];
      if (!assignment) return { ok: false, error: { code: "assignment_not_found", missionId: command.missionId, assignmentId: command.assignmentId } };
      const nextStatus =
        command.type === "BlockAssignment"
          ? "blocked"
          : command.type === "SubmitAssignment"
            ? "submitted"
            : command.type === "AcceptAssignment"
              ? "accepted"
              : command.type === "RejectAssignment"
                ? "rejected"
                : "cancelled";
      const transition = validateAssignmentTransition(assignment.status, nextStatus);
      if (!transition.ok) return { ok: false, error: { code: "invalid_assignment_transition", assignmentId: command.assignmentId, errors: transition.errors } };
      return { ok: true, payloads: [{ type: "mission.assignment_status_changed", assignmentId: command.assignmentId, previousStatus: assignment.status, nextStatus }] };
    }

    case "VerifyAssignment": {
      const assignment = current.assignments[command.assignmentId];
      if (!assignment) return { ok: false, error: { code: "assignment_not_found", missionId: command.missionId, assignmentId: command.assignmentId } };
      if (command.verified) {
        // Policy, applied explicitly — a finding existing is not itself a
        // block; whether OPEN findings on THIS assignment count as blocking
        // is `findingsBlockingVerification`'s own decision, not assumed here.
        const blocking = findingsBlockingVerification(Object.values(current.findings).filter((f) => f.assignmentId === command.assignmentId));
        if (blocking.length > 0) {
          return { ok: false, error: { code: "unresolved_findings_block_transition", assignmentId: command.assignmentId, findingIds: blocking.map((f) => f.id) } };
        }
      }
      const nextStatus = command.verified ? "verified" : "rejected";
      const transition = validateAssignmentTransition(assignment.status, nextStatus);
      if (!transition.ok) return { ok: false, error: { code: "invalid_assignment_transition", assignmentId: command.assignmentId, errors: transition.errors } };
      return { ok: true, payloads: [{ type: "mission.assignment_status_changed", assignmentId: command.assignmentId, previousStatus: assignment.status, nextStatus }] };
    }

    case "AskAssignmentQuestion": {
      // Phase 4D Part 4 §6: ATOMIC — the question message and the
      // running -> waiting_for_input transition are ONE command, one event
      // batch. No prior separate `PostMessage` call is required or
      // accepted; `command.messageId` here NAMES the question message this
      // command itself creates.
      const assignment = current.assignments[command.assignmentId];
      if (!assignment) return { ok: false, error: { code: "assignment_not_found", missionId: command.missionId, assignmentId: command.assignmentId } };

      const existingMessage = current.messages.find((m) => m.id === command.messageId);
      if (existingMessage) {
        const samePayload = messagePayloadDigest({
          senderParticipantId: existingMessage.senderParticipantId,
          type: existingMessage.type,
          body: existingMessage.body,
          assignmentId: existingMessage.assignmentId,
          recipientParticipantIds: existingMessage.recipientParticipantIds,
          evidenceRefs: existingMessage.evidenceRefs,
          replyToMessageId: existingMessage.replyToMessageId,
          structuredPayload: existingMessage.structuredPayload,
        }) === messagePayloadDigest({
          senderParticipantId: command.senderParticipantId,
          type: "question",
          body: command.body,
          assignmentId: command.assignmentId,
          recipientParticipantIds: command.recipientParticipantIds,
          evidenceRefs: command.evidenceRefs,
          replyToMessageId: null,
          structuredPayload: {},
        });
        return { ok: false, error: { code: "duplicate_message_id", missionId: command.missionId, messageId: command.messageId, samePayload } };
      }

      if (context.actor.kind === "agent" && resolveAgentParticipantId(current, context.actor) !== command.senderParticipantId) {
        return { ok: false, error: { code: "sender_identity_mismatch", missionId: command.missionId, actorId: context.actor.id, claimedSenderParticipantId: command.senderParticipantId } };
      }

      const validation = validateMessage({
        senderParticipantId: command.senderParticipantId,
        recipientParticipantIds: command.recipientParticipantIds,
        assignmentId: command.assignmentId,
        type: "question",
        derivedDelegationDepth: 0,
        participants: current.participants,
        assignments: current.assignments,
        policy: communicationPolicy,
      });
      if (!validation.ok) return { ok: false, error: { code: "message_policy_violation", violation: validation.violation } };

      const transition = validateAssignmentTransition(assignment.status, "waiting_for_input");
      if (!transition.ok) return { ok: false, error: { code: "invalid_assignment_transition", assignmentId: command.assignmentId, errors: transition.errors } };

      const question: MissionMessage = {
        id: command.messageId,
        missionId: command.missionId,
        senderParticipantId: command.senderParticipantId,
        recipientParticipantIds: command.recipientParticipantIds,
        assignmentId: command.assignmentId,
        type: "question",
        body: command.body,
        evidenceRefs: command.evidenceRefs,
        correlationId: context.correlationId,
        causationId: context.causationId,
        replyToMessageId: null,
        createdAt: context.timestamp,
        structuredPayload: {},
      };
      return {
        ok: true,
        payloads: [
          { type: "mission.message_posted", message: question },
          { type: "mission.assignment_status_changed", assignmentId: command.assignmentId, previousStatus: assignment.status, nextStatus: "waiting_for_input" },
        ],
      };
    }

    case "AnswerAssignmentQuestion": {
      // Phase 4D Part 4 §6: ATOMIC — the answer message and the
      // waiting_for_input -> running transition are ONE command, one event
      // batch. `command.messageId` NAMES the answer message this command
      // itself creates; `command.questionMessageId` must reference a real,
      // still-unanswered question already in this Mission's history.
      const assignment = current.assignments[command.assignmentId];
      if (!assignment) return { ok: false, error: { code: "assignment_not_found", missionId: command.missionId, assignmentId: command.assignmentId } };

      const existingMessage = current.messages.find((m) => m.id === command.messageId);
      if (existingMessage) {
        const samePayload = messagePayloadDigest({
          senderParticipantId: existingMessage.senderParticipantId,
          type: existingMessage.type,
          body: existingMessage.body,
          assignmentId: existingMessage.assignmentId,
          recipientParticipantIds: existingMessage.recipientParticipantIds,
          evidenceRefs: existingMessage.evidenceRefs,
          replyToMessageId: existingMessage.replyToMessageId,
          structuredPayload: existingMessage.structuredPayload,
        }) === messagePayloadDigest({
          senderParticipantId: command.senderParticipantId,
          type: "answer",
          body: command.body,
          assignmentId: command.assignmentId,
          recipientParticipantIds: command.recipientParticipantIds,
          evidenceRefs: command.evidenceRefs,
          replyToMessageId: command.questionMessageId,
          structuredPayload: {},
        });
        return { ok: false, error: { code: "duplicate_message_id", missionId: command.missionId, messageId: command.messageId, samePayload } };
      }

      const question = current.messages.find((m) => m.id === command.questionMessageId);
      // Unrelated/nonexistent question reference — refused before any
      // sender/policy check even runs, matching the audit's "no unrelated
      // answer can resume the assignment" requirement.
      if (!question || question.type !== "question") return { ok: false, error: { code: "question_not_found", messageId: command.questionMessageId } };

      const alreadyAnswered = current.messages.some((m) => m.type === "answer" && m.replyToMessageId === command.questionMessageId);
      if (alreadyAnswered) return { ok: false, error: { code: "question_already_answered", messageId: command.questionMessageId } };

      if (context.actor.kind === "agent" && resolveAgentParticipantId(current, context.actor) !== command.senderParticipantId) {
        return { ok: false, error: { code: "sender_identity_mismatch", missionId: command.missionId, actorId: context.actor.id, claimedSenderParticipantId: command.senderParticipantId } };
      }

      const validation = validateMessage({
        senderParticipantId: command.senderParticipantId,
        recipientParticipantIds: command.recipientParticipantIds,
        assignmentId: command.assignmentId,
        type: "answer",
        derivedDelegationDepth: 0,
        participants: current.participants,
        assignments: current.assignments,
        policy: communicationPolicy,
      });
      if (!validation.ok) return { ok: false, error: { code: "message_policy_violation", violation: validation.violation } };

      // Only "running" leads to "waiting_for_input" in this domain's
      // transition table (mission-collaboration.ts), so resuming to
      // "running" is deterministic — no separate resumeTo field needed,
      // unlike Mission.state's own interruption model, which has several
      // possible active states to return to. A CANCELLED (terminal)
      // assignment never legally reaches "running" from here, so
      // cancellation-prevents-resume is enforced by this same check, not a
      // separate one.
      const transition = validateAssignmentTransition(assignment.status, "running");
      if (!transition.ok) return { ok: false, error: { code: "invalid_assignment_transition", assignmentId: command.assignmentId, errors: transition.errors } };

      const answer: MissionMessage = {
        id: command.messageId,
        missionId: command.missionId,
        senderParticipantId: command.senderParticipantId,
        recipientParticipantIds: command.recipientParticipantIds,
        assignmentId: command.assignmentId,
        type: "answer",
        body: command.body,
        evidenceRefs: command.evidenceRefs,
        correlationId: context.correlationId,
        causationId: context.causationId,
        replyToMessageId: command.questionMessageId,
        createdAt: context.timestamp,
        structuredPayload: {},
      };
      return {
        ok: true,
        payloads: [
          { type: "mission.message_posted", message: answer },
          { type: "mission.assignment_status_changed", assignmentId: command.assignmentId, previousStatus: assignment.status, nextStatus: "running" },
        ],
      };
    }

    case "OpenFinding": {
      if (current.findings[command.findingId]) return { ok: false, error: { code: "finding_already_exists", missionId: command.missionId, findingId: command.findingId } };
      if (!current.assignments[command.assignmentId]) return { ok: false, error: { code: "assignment_not_found", missionId: command.missionId, assignmentId: command.assignmentId } };
      const finding: MissionFinding = {
        id: command.findingId,
        missionId: command.missionId,
        assignmentId: command.assignmentId,
        openedByParticipantId: command.openedByParticipantId,
        responsibleParticipantId: command.responsibleParticipantId,
        statement: command.statement,
        evidenceRefs: command.evidenceRefs,
        originatingMessageId: command.originatingMessageId,
        status: "opened",
        resolutionEvidenceRefs: [],
        createdAt: context.timestamp,
        updatedAt: context.timestamp,
      };
      return { ok: true, payloads: [{ type: "mission.finding_opened", finding }] };
    }

    case "TransitionFinding": {
      const finding = current.findings[command.findingId];
      if (!finding) return { ok: false, error: { code: "finding_not_found", missionId: command.missionId, findingId: command.findingId } };
      const transition = validateFindingTransition(finding.status, command.nextStatus);
      if (!transition.ok) return { ok: false, error: { code: "invalid_finding_transition", findingId: command.findingId, errors: transition.errors } };
      return {
        ok: true,
        payloads: [
          {
            type: "mission.finding_status_changed",
            findingId: command.findingId,
            previousStatus: finding.status,
            nextStatus: command.nextStatus,
            resolutionEvidenceRefs: command.resolutionEvidenceRefs,
          },
        ],
      };
    }

    case "ProposeMissionPlan": {
      if (current.planProposals[command.planId]) {
        return { ok: false, error: { code: "plan_already_exists", missionId: command.missionId, planId: command.planId } };
      }
      return { ok: true, payloads: [{ type: "mission.plan_proposal_created", planProposal: command.plan }] };
    }

    case "ValidateMissionPlan": {
      const plan = current.planProposals[command.planId];
      if (!plan) return { ok: false, error: { code: "plan_not_found", missionId: command.missionId, planId: command.planId } };
      const result = validateMissionPlanProposal(plan, command.context);
      const nextStatus = result.ok ? "valid" : "invalid";
      const transition = validatePlanTransition(plan.status, nextStatus);
      if (!transition.ok) return { ok: false, error: { code: "invalid_plan_transition", planId: command.planId, errors: transition.errors } };
      return {
        ok: true,
        payloads: [{ type: "mission.plan_proposal_status_changed", planId: command.planId, previousStatus: plan.status, nextStatus, validationErrors: result.errors.map((e) => e.detail) }],
      };
    }

    case "ApproveMissionPlan": {
      const plan = current.planProposals[command.planId];
      if (!plan) return { ok: false, error: { code: "plan_not_found", missionId: command.missionId, planId: command.planId } };
      // The human_required escalation itself now lives in
      // mission-authorization.ts's `refineRequiredAuthority` (centralized,
      // Phase 4D) — `applyMissionCommand` checks authorization before this
      // function is ever called, so by the time we get here the actor is
      // already known to be permitted.
      const transition = validatePlanTransition(plan.status, "approved");
      if (!transition.ok) return { ok: false, error: { code: "invalid_plan_transition", planId: command.planId, errors: transition.errors } };
      return { ok: true, payloads: [{ type: "mission.plan_proposal_status_changed", planId: command.planId, previousStatus: plan.status, nextStatus: "approved" }] };
    }

    case "RejectMissionPlan": {
      const plan = current.planProposals[command.planId];
      if (!plan) return { ok: false, error: { code: "plan_not_found", missionId: command.missionId, planId: command.planId } };
      const transition = validatePlanTransition(plan.status, "rejected");
      if (!transition.ok) return { ok: false, error: { code: "invalid_plan_transition", planId: command.planId, errors: transition.errors } };
      return { ok: true, payloads: [{ type: "mission.plan_proposal_status_changed", planId: command.planId, previousStatus: plan.status, nextStatus: "rejected" }] };
    }

    case "SupersedeMissionPlan": {
      const plan = current.planProposals[command.planId];
      if (!plan) return { ok: false, error: { code: "plan_not_found", missionId: command.missionId, planId: command.planId } };
      if (current.planProposals[command.newPlan.id]) {
        return { ok: false, error: { code: "plan_already_exists", missionId: command.missionId, planId: command.newPlan.id } };
      }

      // Reconciliation policy (audit item 3): superseding an `active`
      // (materialized) Plan is now allowed, but ONLY through this explicit
      // step — never by silently deleting the `active` -> [] terminal
      // guard in `PLAN_TRANSITIONS`/`isTerminalPlanStatus`, which stays
      // terminal for every OTHER command (ApproveMissionPlan,
      // RejectMissionPlan, MaterializeMissionPlan, ...). Policy chosen:
      // in-flight assignments this Plan materialized are CANCELLED,
      // atomically in the same event batch — not merely flagged for human
      // review — because leaving them running
      // against a Plan that no longer exists is the actual unsafe state the
      // audit was pointing at. Only assignments still in a state
      // `ASSIGNMENT_TRANSITIONS` allows moving to "cancelled" FROM are
      // cancelled here (proposed/ready/claimed/running/waiting_for_input/
      // blocked); an assignment already `submitted` (awaiting review) or
      // past that has no legal "cancelled" transition in the domain model
      // (submitted -> verified/rejected/failed only) and is deliberately
      // left untouched — forcing one through here would mean quietly
      // widening `ASSIGNMENT_TRANSITIONS` as a side effect of this command,
      // not a decision this command should make silently. Those are
      // exactly the ones a human should be looking at, and the
      // `mission.plan_proposal_status_changed` event with `supersededPlanId`
      // remains the durable signal that triggers that review.
      let transition: ReturnType<typeof validatePlanTransition>;
      const supersedingActivePlan = plan.status === "active";
      if (supersedingActivePlan) {
        transition = { ok: true, errors: [] };
      } else {
        transition = validatePlanTransition(plan.status, "superseded");
        if (!transition.ok) return { ok: false, error: { code: "invalid_plan_transition", planId: command.planId, errors: transition.errors } };
      }

      const payloads: MissionEventPayload[] = [
        { type: "mission.plan_proposal_status_changed", planId: command.planId, previousStatus: plan.status, nextStatus: "superseded" },
      ];

      if (supersedingActivePlan) {
        for (const proposedAssignment of plan.assignmentProposals) {
          const assignment = current.assignments[proposedAssignment.proposedAssignmentId];
          if (!assignment) continue;
          const cancelTransition = validateAssignmentTransition(assignment.status, "cancelled");
          if (!cancelTransition.ok) continue; // already terminal or past the cancellable window — left for human review, see above
          payloads.push({
            type: "mission.assignment_status_changed",
            assignmentId: assignment.id,
            previousStatus: assignment.status,
            nextStatus: "cancelled",
          });
        }
      }

      payloads.push({ type: "mission.plan_proposal_created", planProposal: { ...command.newPlan, supersedesPlanId: command.planId } });

      return { ok: true, payloads };
    }

    case "MaterializeMissionPlan": {
      const plan = current.planProposals[command.planId];
      if (!plan) return { ok: false, error: { code: "plan_not_found", missionId: command.missionId, planId: command.planId } };
      if (plan.status === "active") {
        // Idempotent: a retry after an ambiguous prior commit finds the
        // Plan already materialized and does nothing further — never a
        // second round of participant/assignment creation.
        return { ok: true, payloads: [] };
      }
      const transition = validatePlanTransition(plan.status, "materializing");
      if (!transition.ok) return { ok: false, error: { code: "plan_not_materializable", planId: command.planId, status: plan.status } };

      const payloads: MissionEventPayload[] = [];
      const materializedParticipantIds: Record<string, string> = {};
      const materializedAssignmentIds: Record<string, string> = {};

      for (const proposedParticipant of plan.participantProposals) {
        const realId = proposedParticipant.proposedParticipantId;
        materializedParticipantIds[proposedParticipant.proposedParticipantId] = realId;
        if (current.participants[realId]) continue; // already materialized (partial-retry safety) — never re-registered
        payloads.push({
          type: "mission.participant_registered",
          participant: {
            id: realId,
            kind: "agent",
            role: proposedParticipant.role,
            agentKind: null,
            displayName: `${proposedParticipant.role} (${realId})`,
            status: "proposed",
            provider: proposedParticipant.providerConstraint.provider,
            adapterId: proposedParticipant.providerConstraint.provider,
            capabilities: proposedParticipant.providerConstraint.requiredCapabilities,
            assignmentScope: { allowedPaths: proposedParticipant.workspacePermissions.allowedPaths, prohibitedPaths: proposedParticipant.workspacePermissions.prohibitedPaths },
            workspacePermissions: proposedParticipant.workspacePermissions,
            communicationPermissions: proposedParticipant.communicationPermissions,
            createdAt: context.timestamp,
            updatedAt: context.timestamp,
          },
        });
      }

      for (const proposedAssignment of plan.assignmentProposals) {
        const realId = proposedAssignment.proposedAssignmentId;
        materializedAssignmentIds[proposedAssignment.proposedAssignmentId] = realId;
        if (current.assignments[realId]) continue; // already materialized — idempotent
        payloads.push({
          type: "mission.assignment_created",
          assignment: {
            id: realId,
            missionId: command.missionId,
            assigneeParticipantId: proposedAssignment.proposedAssigneeId ? (materializedParticipantIds[proposedAssignment.proposedAssigneeId] ?? proposedAssignment.proposedAssigneeId) : null,
            title: plan.objective,
            objective: proposedAssignment.objective,
            scope: proposedAssignment.scope,
            dependencies: proposedAssignment.dependencies.map((dep) => materializedAssignmentIds[dep] ?? dep),
            requiredEvidence: proposedAssignment.requiredEvidence,
            approvalPolicy: proposedAssignment.approvalPolicy,
            budget: proposedAssignment.budget,
            status: "proposed",
            reviewerParticipantIds: [],
            dispatchKey: null,
            parentAssignmentId: null,
            originatingMessageId: null,
            delegatorParticipantId: null,
            delegationDepth: 0,
            createdAt: context.timestamp,
            updatedAt: context.timestamp,
          },
        });
      }

      payloads.push({
        type: "mission.plan_proposal_status_changed",
        planId: command.planId,
        previousStatus: plan.status,
        nextStatus: "active",
        materializedParticipantIds,
        materializedAssignmentIds,
      });

      return { ok: true, payloads };
    }

    case "RecordExecutionStarted": {
      const assignment = current.assignments[command.assignmentId];
      if (!assignment || assignment.missionId !== command.missionId || assignment.dispatchKey !== command.dispatchKey) {
        return { ok: false, error: { code: "invalid_assignment_transition", assignmentId: command.assignmentId, errors: ["Execution assignment or dispatch key does not match the Mission projection."] } };
      }
      const existing = current.executions[command.executionId];
      if (existing) {
        const same = existing.missionId === command.missionId
          && existing.assignmentId === command.assignmentId
          && existing.dispatchIntentId === command.dispatchIntentId
          && existing.leaseId === command.leaseId
          && existing.fencingToken === command.fencingToken;
        if (same) return { ok: true, payloads: [] };
        return { ok: false, error: { code: "invalid_assignment_transition", assignmentId: command.assignmentId, errors: ["Execution identity is already bound to a different dispatch generation."] } };
      }
      const record: MissionExecutionRecord = {
        executionId: command.executionId,
        missionId: command.missionId,
        workspaceId: command.workspaceId,
        assignmentId: command.assignmentId,
        dispatchIntentId: command.dispatchIntentId,
        dispatchKey: command.dispatchKey,
        providerAdapterId: command.providerAdapterId,
        leaseId: command.leaseId,
        fencingToken: command.fencingToken,
        attempt: command.attempt,
        status: "started",
        startedAt: command.timestamp,
        terminalAt: null,
        terminalReason: null,
        resultDigest: null,
        evidenceIds: [],
        correlationId: command.correlationId,
        causationId: command.causationId,
      };
      return { ok: true, payloads: [{ type: "mission.execution_started", record }] };
    }

    case "RecordExecutionCompleted":
    case "RecordExecutionFailed":
    case "RecordExecutionCancelled":
    case "RecordExecutionLeaseLost": {
      const assignment = current.assignments[command.assignmentId];
      const existing = current.executions[command.executionId];
      if (!assignment || assignment.missionId !== command.missionId || assignment.dispatchKey !== command.dispatchKey || !existing) {
        return { ok: false, error: { code: "invalid_assignment_transition", assignmentId: command.assignmentId, errors: ["Execution terminal result does not match a started assignment and dispatch."] } };
      }
      if (existing.workspaceId !== command.workspaceId || existing.dispatchIntentId !== command.dispatchIntentId || existing.leaseId !== command.leaseId || existing.fencingToken !== command.fencingToken || existing.providerAdapterId !== command.providerAdapterId) {
        return { ok: false, error: { code: "invalid_assignment_transition", assignmentId: command.assignmentId, errors: ["Execution terminal result does not match its authoritative generation."] } };
      }
      const nextStatus = command.type === "RecordExecutionCompleted" ? "completed" as const
        : command.type === "RecordExecutionFailed" ? "failed" as const
        : command.type === "RecordExecutionCancelled" ? "cancelled" as const
        : "lease_lost" as const;
      const transitioned = transitionMissionExecution(existing, nextStatus, {
        timestamp: command.timestamp,
        reason: command.reason,
        resultDigest: command.resultDigest,
        evidenceIds: command.evidenceIds,
      });
      if (!transitioned.ok) {
        return { ok: false, error: { code: "invalid_assignment_transition", assignmentId: command.assignmentId, errors: [transitioned.code] } };
      }
      if (transitioned.record === existing) return { ok: true, payloads: [] };
      return { ok: true, payloads: [{ type: "mission.execution_terminal", record: transitioned.record }] };
    }

    case "RecordEvidence": {
      if (current.evidenceRecords[command.evidenceId]) {
        return { ok: false, error: { code: "evidence_already_exists", missionId: command.missionId, evidenceId: command.evidenceId } };
      }
      const targetAssignment = command.assignmentId ? current.assignments[command.assignmentId] : null;
      if (command.assignmentId && !targetAssignment) {
        return { ok: false, error: { code: "evidence_assignment_not_found", missionId: command.missionId, assignmentId: command.assignmentId } };
      }
      // Phase 4D Part 4 (dispatch/execution mutual-consistency, previously
      // deferred): a claimed `dispatchKey` must match the SAME assignment's
      // own current `dispatchKey` — evidence produced under one dispatch
      // slot must never be attributable to a different one, whether that's
      // a stale claim from a prior attempt or a fabricated reference. Only
      // checked when both the command and the assignment actually carry a
      // dispatchKey to compare; an assignment never dispatched (`dispatchKey:
      // null`) cannot receive evidence claiming one at all.
      if (command.dispatchKey !== null && targetAssignment && targetAssignment.dispatchKey !== command.dispatchKey) {
        return { ok: false, error: { code: "evidence_dispatch_key_mismatch", missionId: command.missionId, evidenceId: command.evidenceId, assignmentId: command.assignmentId as string, expectedDispatchKey: targetAssignment.dispatchKey, actualDispatchKey: command.dispatchKey } };
      }
      const record: import("./mission-domain").MissionEvidenceRecord = {
        id: command.evidenceId,
        missionId: command.missionId,
        assignmentId: command.assignmentId,
        producerParticipantId: command.producerParticipantId,
        producerKind: command.producerKind,
        executionId: command.executionId,
        dispatchKey: command.dispatchKey,
        provider: command.provider,
        kind: command.kind,
        source: command.source,
        lifecycle: command.lifecycle,
        availability: command.availability,
        integrity: command.integrity,
        supersededByEvidenceId: null,
        createdAt: context.timestamp,
        updatedAt: context.timestamp,
      };
      return { ok: true, payloads: [{ type: "mission.evidence_recorded", record }] };
    }

    case "SupersedeEvidence": {
      const record = current.evidenceRecords[command.evidenceId];
      if (!record) return { ok: false, error: { code: "evidence_not_found", missionId: command.missionId, evidenceId: command.evidenceId } };
      if (!current.evidenceRecords[command.supersededByEvidenceId]) {
        return { ok: false, error: { code: "evidence_not_found", missionId: command.missionId, evidenceId: command.supersededByEvidenceId } };
      }
      return { ok: true, payloads: [{ type: "mission.evidence_superseded", evidenceId: command.evidenceId, supersededByEvidenceId: command.supersededByEvidenceId }] };
    }

    case "CancelMissionPlan": {
      const plan = current.planProposals[command.planId];
      if (!plan) return { ok: false, error: { code: "plan_not_found", missionId: command.missionId, planId: command.planId } };
      const transition = validatePlanTransition(plan.status, "cancelled");
      if (!transition.ok) return { ok: false, error: { code: "invalid_plan_transition", planId: command.planId, errors: transition.errors } };
      return { ok: true, payloads: [{ type: "mission.plan_proposal_status_changed", planId: command.planId, previousStatus: plan.status, nextStatus: "cancelled" }] };
    }

    case "RequestModelPlanning": {
      if (current.planningRequests[command.planningRequestId]) {
        return { ok: false, error: { code: "planning_request_already_exists", missionId: command.missionId, planningRequestId: command.planningRequestId } };
      }
      // Mission-terminal check wins over supersession logic (Phase 5D §5):
      // a terminal Mission never accepts a new planning request at all, so
      // there is nothing to supersede — checked before the slot lookup below.
      if (current.terminal) {
        return { ok: false, error: { code: "mission_terminal", missionId: command.missionId } };
      }
      const capabilityCheck = checkPlanningCapabilities({
        id: command.modelConfigurationId,
        capabilities: command.planningCapabilities,
        maximumContextTokens: 0,
        maximumOutputTokens: 0,
        maxRepairAttempts: command.maxAttempts,
      });
      if (!capabilityCheck.ok) {
        return { ok: false, error: { code: "planning_capability_unresolved", modelConfigurationId: command.modelConfigurationId, missingCapabilities: capabilityCheck.error.missingCapabilities } };
      }
      if (command.kind === "revision") {
        if (!command.basePlanId) return { ok: false, error: { code: "plan_revision_base_invalid", missionId: command.missionId, basePlanId: "", detail: "kind 'revision' requires basePlanId." } };
        const basePlan = current.planProposals[command.basePlanId];
        if (!basePlan) return { ok: false, error: { code: "plan_revision_base_invalid", missionId: command.missionId, basePlanId: command.basePlanId, detail: "basePlanId does not reference an existing Plan." } };
        const revisableStatuses: import("./mission-domain").PlanStatus[] = ["draft", "invalid", "valid", "approved"];
        if (!revisableStatuses.includes(basePlan.status)) {
          return { ok: false, error: { code: "plan_revision_base_invalid", missionId: command.missionId, basePlanId: command.basePlanId, detail: `Plan status '${basePlan.status}' cannot be revised (materialized/terminal Plans are out of scope for revision).` } };
        }
      }
      const record: import("./mission-domain").PlanningRequestRecord = {
        id: command.planningRequestId,
        missionId: command.missionId,
        targetPlanVersion: command.targetPlanVersion,
        kind: command.kind,
        basePlanId: command.basePlanId,
        status: "requested",
        modelConfigurationId: command.modelConfigurationId,
        contextHash: command.contextHash,
        attemptCount: 0,
        maxAttempts: command.maxAttempts,
        createdAt: context.timestamp,
        startedAt: null,
        completedAt: null,
        correlationId: context.correlationId,
        causationId: context.causationId,
        idempotencyKey: command.planningRequestId,
        redactedDiagnosticRef: null,
        finalOutcome: null,
        resultingPlanId: null,
      };

      const requestPayloads: MissionEventPayload[] = [];

      // Supersession (Phase 5D §5): a new revision-kind request targeting
      // the same mission+slot (kind + basePlanId lineage) as an existing
      // OUTSTANDING (requested/in_progress) planning request supersedes
      // that older request — it must never be allowed to resolve
      // independently and race the new one. Deterministic/idempotent by
      // construction: `findOutstandingPlanningRequestForSlot` only ever
      // finds a NON-terminal record, so a request already superseded (or
      // otherwise terminal) is simply not found again on a repeat call —
      // there is nothing left to supersede a second time.
      const outstanding = findOutstandingPlanningRequestForSlot(current.planningRequests, {
        missionId: command.missionId,
        kind: command.kind,
        basePlanId: command.basePlanId,
      });
      if (outstanding) {
        requestPayloads.push({
          type: "mission.model_plan_request_status_changed",
          planningRequestId: outstanding.id,
          previousStatus: outstanding.status,
          nextStatus: "superseded",
          finalOutcome: "superseded",
        });
      }

      requestPayloads.push({ type: "mission.model_plan_request_created", record });
      return { ok: true, payloads: requestPayloads };
    }

    case "RecordModelPlanningResult": {
      const request = current.planningRequests[command.planningRequestId];
      if (!request) return { ok: false, error: { code: "planning_request_not_found", missionId: command.missionId, planningRequestId: command.planningRequestId } };
      if (request.status !== "requested" && request.status !== "in_progress") {
        return { ok: false, error: { code: "planning_request_not_actionable", planningRequestId: command.planningRequestId, status: request.status } };
      }

      const attemptCount = request.attemptCount + 1;

      // Mission cancellation invalidates outstanding planning requests — a
      // terminal Mission never accepts a late result, whatever it contains.
      if (current.terminal) {
        return {
          ok: true,
          payloads: [{ type: "mission.model_plan_request_status_changed", planningRequestId: command.planningRequestId, previousStatus: request.status, nextStatus: "stale", attemptCount, finalOutcome: "stale", redactedDiagnosticRef: command.redactedDiagnosticRef }],
        };
      }

      // A bounded repair attempt (Phase 5B §12): any validation failure
      // below routes here rather than immediately terminal, UNLESS the
      // attempt budget is exhausted — then it's `failed`, terminal. Never
      // recursive/unbounded: `attemptCount`/`maxAttempts` are the only
      // inputs, both durable, both set once at `RequestModelPlanning` time.
      const recordFailureOrRepair = (): MissionEventPayload => {
        const canRepair = attemptCount < request.maxAttempts;
        return {
          type: "mission.model_plan_request_status_changed",
          planningRequestId: command.planningRequestId,
          previousStatus: request.status,
          nextStatus: canRepair ? "requested" : "failed",
          attemptCount,
          redactedDiagnosticRef: command.redactedDiagnosticRef,
          finalOutcome: canRepair ? undefined : "rejected",
        };
      };

      if (command.failureCode || !command.rawModelOutputText) {
        return { ok: true, payloads: [recordFailureOrRepair()] };
      }

      const schemaResult = validateRawModelPlanOutput(command.rawModelOutputText);
      if (!schemaResult.ok) {
        return { ok: true, payloads: [recordFailureOrRepair()] };
      }

      const { proposal, templateSafeguardViolations } = normalizeModelPlanProposal({
        missionId: command.missionId,
        version: request.targetPlanVersion,
        supersedesPlanId: request.kind === "revision" ? request.basePlanId : null,
        raw: schemaResult.value,
        availableProviders: command.availableProviders,
        now: context.timestamp,
        createdBy: command.createdBy,
      });

      if (templateSafeguardViolations.length > 0) {
        return { ok: true, payloads: [recordFailureOrRepair()] };
      }

      const validation = validateMissionPlanProposal(proposal, command.planValidationContext);
      if (!validation.ok) {
        return { ok: true, payloads: [recordFailureOrRepair()] };
      }

      const simulation = simulateMissionPlanProposal(proposal);
      if (simulation.unreachableAssignments.length > 0) {
        return { ok: true, payloads: [recordFailureOrRepair()] };
      }

      // Success — the SAME event shapes ProposeMissionPlan/SupersedeMissionPlan
      // already produce. Raw model output never itself becomes Mission
      // state; only this fully-normalized, fully-validated `proposal` does.
      const successPayloads: MissionEventPayload[] = [];
      if (request.kind === "proposal") {
        if (current.planProposals[proposal.id]) {
          return { ok: false, error: { code: "plan_already_exists", missionId: command.missionId, planId: proposal.id } };
        }
        successPayloads.push({ type: "mission.plan_proposal_created", planProposal: proposal });
      } else {
        const basePlan = request.basePlanId ? current.planProposals[request.basePlanId] : null;
        if (!basePlan) return { ok: false, error: { code: "plan_revision_base_invalid", missionId: command.missionId, basePlanId: request.basePlanId ?? "", detail: "basePlanId no longer exists." } };
        const transition = validatePlanTransition(basePlan.status, "superseded");
        if (!transition.ok) return { ok: false, error: { code: "invalid_plan_transition", planId: request.basePlanId as string, errors: transition.errors } };
        if (current.planProposals[proposal.id]) return { ok: false, error: { code: "plan_already_exists", missionId: command.missionId, planId: proposal.id } };
        successPayloads.push({ type: "mission.plan_proposal_status_changed", planId: request.basePlanId as string, previousStatus: basePlan.status, nextStatus: "superseded" });
        successPayloads.push({ type: "mission.plan_proposal_created", planProposal: { ...proposal, supersedesPlanId: request.basePlanId } });
      }

      successPayloads.push({
        type: "mission.model_plan_request_status_changed",
        planningRequestId: command.planningRequestId,
        previousStatus: request.status,
        nextStatus: "completed",
        attemptCount,
        redactedDiagnosticRef: command.redactedDiagnosticRef,
        finalOutcome: "created_plan",
        resultingPlanId: proposal.id,
      });

      return { ok: true, payloads: successPayloads };
    }

    case "CancelModelPlanningRequest": {
      const request = current.planningRequests[command.planningRequestId];
      if (!request) return { ok: false, error: { code: "planning_request_not_found", missionId: command.missionId, planningRequestId: command.planningRequestId } };
      const transition = validatePlanningRequestTransition(request.status, "cancelled");
      if (!transition.ok) return { ok: false, error: { code: "invalid_planning_request_transition", planningRequestId: command.planningRequestId, errors: transition.errors } };
      return { ok: true, payloads: [{ type: "mission.model_plan_request_status_changed", planningRequestId: command.planningRequestId, previousStatus: request.status, nextStatus: "cancelled", finalOutcome: "cancelled" }] };
    }

    case "PostMessage": {
      // Mission-scoped `messageId` uniqueness (Phase 4D §4). A genuine
      // idempotent retry (same idempotency key) never reaches this function
      // at all — `applyMissionCommand`'s idempotency check above replays it
      // first. Finding an existing message with this id here means either
      // the identical payload was resubmitted under a DIFFERENT idempotency
      // key, or a genuinely different message tried to reuse an id already
      // used in this Mission. Both are refused as a typed conflict — never
      // silently accepted via whatever `Map`/array last-write-wins semantics
      // a caller's own bookkeeping might have (mission-collaboration-graph.ts's
      // causal lookups key strictly by id and must never see two messages
      // claiming the same one).
      const existingMessage = current.messages.find((m) => m.id === command.messageId);
      if (existingMessage) {
        const samePayload = messagePayloadDigest({
          senderParticipantId: existingMessage.senderParticipantId,
          type: existingMessage.type,
          body: existingMessage.body,
          assignmentId: existingMessage.assignmentId,
          recipientParticipantIds: existingMessage.recipientParticipantIds,
          evidenceRefs: existingMessage.evidenceRefs,
          replyToMessageId: existingMessage.replyToMessageId,
          structuredPayload: existingMessage.structuredPayload,
        }) === messagePayloadDigest({
          senderParticipantId: command.senderParticipantId,
          type: command.messageType,
          body: command.body,
          assignmentId: command.assignmentId,
          recipientParticipantIds: command.recipientParticipantIds,
          evidenceRefs: command.evidenceRefs,
          replyToMessageId: command.replyToMessageId,
          structuredPayload: command.structuredPayload,
        });
        return { ok: false, error: { code: "duplicate_message_id", missionId: command.missionId, messageId: command.messageId, samePayload } };
      }

      // Sender identity binding (Phase 4D Part 3 §2): the actor issuing this
      // command must BE the participant it claims to speak for — an active,
      // authorized agent actor cannot post a message on behalf of a
      // DIFFERENT participant id. Without this, `active_participant`
      // authorization (mission-authorization.ts) only proves SOME active
      // participant issued the command, never that it is the one named in
      // `senderParticipantId` — a provider process could otherwise
      // impersonate any other participant's voice in the causal graph.
      // Human/system actors are exempt: they act ON BEHALF of a named
      // sender (e.g. relaying/orchestrating), never impersonating a peer
      // agent's own voice.
      if (context.actor.kind === "agent" && resolveAgentParticipantId(current, context.actor) !== command.senderParticipantId) {
        return { ok: false, error: { code: "sender_identity_mismatch", missionId: command.missionId, actorId: context.actor.id, claimedSenderParticipantId: command.senderParticipantId } };
      }

      // Missions created before the human participant was part of the genesis
      // batch may still have no durable human row. Repair only the caller's
      // own identity, in the same command batch as the first message; never
      // revive a removed participant or materialize an arbitrary principal.
      const participants = { ...current.participants };
      const registrationPayloads: MissionEventPayload[] = [];
      if (context.actor.kind === "human" && command.senderParticipantId === context.actor.id && !participants[command.senderParticipantId]) {
        const participant = humanMissionParticipant(context);
        participants[participant.id] = participant;
        registrationPayloads.push({ type: "mission.participant_registered", participant });
      }

      const schemaCheck = validateStructuredPayloadSchema(command.messageType, command.structuredPayload);
      if (!schemaCheck.ok) return { ok: false, error: { code: "protocol_schema_violation", error: schemaCheck.error } };

      const isDelegationRequest = command.messageType === "delegation_request";
      let derivedDepth = 0;
      if (isDelegationRequest) {
        const depthResult = deriveDelegationDepth(
          { id: command.messageId, replyToMessageId: command.replyToMessageId, causationId: context.causationId, type: command.messageType },
          current.messages,
        );
        if (!depthResult.ok) return { ok: false, error: { code: "message_policy_violation", violation: { code: "malformed_causal_chain", messageId: command.messageId, reason: depthResult.reason } } };
        derivedDepth = depthResult.depth;
      }

      const validation = validateMessage({
        senderParticipantId: command.senderParticipantId,
        recipientParticipantIds: command.recipientParticipantIds,
        assignmentId: command.assignmentId,
        type: command.messageType,
        derivedDelegationDepth: derivedDepth,
        participants,
        assignments: current.assignments,
        policy: communicationPolicy,
      });
      if (!validation.ok) return { ok: false, error: { code: "message_policy_violation", violation: validation.violation } };

      // ---- Phase 4C: typed protocol validation for the five message types
      // Phase 4B left generic. Each is a pure check against the SAME
      // projection state every other collaboration command already reads —
      // never free-form `body` text.
      const structuredPayload = command.structuredPayload ?? {};
      if (command.messageType === "review_request") {
        const reviewPayload = structuredPayload as { reviewerParticipantIds?: string[]; scope?: string; requiredEvidence?: string[]; originatingExecutionRef?: string | null; reviewPolicy?: import("./mission-collaboration-protocol").ReviewPolicy };
        const reviewResult = validateReviewRequestPayload({
          message: { senderParticipantId: command.senderParticipantId, assignmentId: command.assignmentId },
          payload: { ...reviewPayload, reviewerParticipantIds: reviewPayload.reviewerParticipantIds ?? [] },
          assignment: command.assignmentId ? (current.assignments[command.assignmentId] ?? null) : null,
          participants,
          allowSelfReview: false,
          priorMessages: current.messages,
        });
        if (!reviewResult.ok) return { ok: false, error: { code: "message_policy_violation", violation: reviewResult.violation } };
      } else if (command.messageType === "blocker") {
        const blockerResult = validateBlockerPayload({ message: { replyToMessageId: command.replyToMessageId }, payload: structuredPayload as import("./mission-collaboration-protocol").BlockerPayload, priorMessages: current.messages });
        if (!blockerResult.ok) return { ok: false, error: { code: "message_policy_violation", violation: blockerResult.violation } };
      } else if (command.messageType === "evidence_notice") {
        const evidenceResult = validateEvidenceNoticePayload({ message: { assignmentId: command.assignmentId, evidenceRefs: command.evidenceRefs }, evidenceRecords: current.evidenceRecords });
        if (!evidenceResult.ok) return { ok: false, error: { code: "message_policy_violation", violation: evidenceResult.violation } };
      } else if (command.messageType === "approval_request") {
        const approvalResult = validateApprovalRequestPayload({ payload: structuredPayload as import("./mission-collaboration-protocol").ApprovalRequestPayload, priorMessages: current.messages });
        if (!approvalResult.ok) return { ok: false, error: { code: "message_policy_violation", violation: approvalResult.violation } };
      } else if (command.messageType === "completion_notice") {
        const completionAssignment = command.assignmentId ? (current.assignments[command.assignmentId] ?? null) : null;
        // Sender ownership (Phase 4D Part 3 §2): a completion_notice must
        // come from the assignment's own assignee — a human/system actor
        // may relay one on behalf of the assignee, but another agent
        // participant (e.g. a reviewer, or an unrelated participant) may
        // never submit completion for work it wasn't assigned.
        if (completionAssignment && context.actor.kind === "agent" && completionAssignment.assigneeParticipantId !== command.senderParticipantId) {
          return { ok: false, error: { code: "message_policy_violation", violation: { code: "completion_notice_sender_not_assignee", assignmentId: completionAssignment.id, senderParticipantId: command.senderParticipantId } } };
        }
        const completionResult = validateCompletionNoticePayload({
          message: { assignmentId: command.assignmentId, evidenceRefs: command.evidenceRefs },
          assignment: completionAssignment,
          assignments: current.assignments,
          evidenceRecords: current.evidenceRecords,
        });
        if (!completionResult.ok) return { ok: false, error: { code: "message_policy_violation", violation: completionResult.violation } };
      }

      if (isDelegationRequest && command.assignmentId && command.recipientParticipantIds !== "mission_broadcast") {
        for (const recipientId of command.recipientParticipantIds) {
          if (wouldCreateParticipantCycle(recipientId, command.assignmentId, current.assignments)) {
            return { ok: false, error: { code: "message_policy_violation", violation: { code: "participant_delegation_cycle", participantId: recipientId } } };
          }
        }
      }

      const message: MissionMessage = {
        id: command.messageId,
        missionId: command.missionId,
        senderParticipantId: command.senderParticipantId,
        recipientParticipantIds: command.recipientParticipantIds,
        assignmentId: command.assignmentId,
        type: command.messageType,
        body: command.body,
        evidenceRefs: command.evidenceRefs,
        correlationId: context.correlationId,
        causationId: context.causationId,
        replyToMessageId: command.replyToMessageId,
        createdAt: context.timestamp,
        structuredPayload: command.structuredPayload ?? {},
      };
      const payloads: MissionEventPayload[] = [...registrationPayloads, { type: "mission.message_posted", message }];

      // ---- Message-to-command orchestration: an ACCEPTED delegation_response
      // atomically also creates the bounded child assignment, in the SAME
      // command — never a second, separately-committed step. A message is
      // still never authority on its own: everything below is validated
      // exactly as strictly as any other command would be.
      if (command.messageType === "delegation_response" && command.structuredPayload?.accepted === true && command.replyToMessageId) {
        const requestMessage = current.messages.find((m) => m.id === command.replyToMessageId);
        if (!requestMessage || requestMessage.type !== "delegation_request") {
          return { ok: false, error: { code: "message_policy_violation", violation: { code: "malformed_causal_chain", messageId: command.messageId, reason: "replyToMessageId does not reference a delegation_request" } } };
        }
        const alreadyResponded = current.messages.some(
          (m) => m.type === "delegation_response" && m.replyToMessageId === command.replyToMessageId && m.structuredPayload?.accepted === true,
        );
        if (alreadyResponded) {
          return { ok: false, error: { code: "message_policy_violation", violation: { code: "duplicate_delegation_response", originatingMessageId: command.replyToMessageId } } };
        }
        const parentAssignmentId = requestMessage.assignmentId;
        const parent = parentAssignmentId ? current.assignments[parentAssignmentId] : null;
        if (!parentAssignmentId || !parent) {
          return { ok: false, error: { code: "message_policy_violation", violation: { code: "invalid_assignment_reference", assignmentId: parentAssignmentId ?? "" } } };
        }
        if (parent.status === "cancelled" || parent.status === "failed" || parent.status === "rejected" || parent.status === "accepted") {
          return { ok: false, error: { code: "message_policy_violation", violation: { code: "delegation_against_terminal_assignment", assignmentId: parent.id } } };
        }
        const depthResult = deriveDelegationDepth({ id: requestMessage.id, replyToMessageId: requestMessage.replyToMessageId, causationId: requestMessage.causationId, type: requestMessage.type }, current.messages);
        if (!depthResult.ok) return { ok: false, error: { code: "message_policy_violation", violation: { code: "malformed_causal_chain", messageId: requestMessage.id, reason: depthResult.reason } } };

        const childPayload = command.structuredPayload as { childTitle?: string; childObjective?: string; allowedPaths?: string[]; prohibitedPaths?: string[] };
        const childScope = { allowedPaths: childPayload.allowedPaths ?? parent.scope.allowedPaths, prohibitedPaths: childPayload.prohibitedPaths ?? parent.scope.prohibitedPaths };
        const narrowing = validateScopeNarrowing(parent.scope, childScope);
        if (!narrowing.ok) {
          return { ok: false, error: { code: "message_policy_violation", violation: { code: "delegation_scope_exceeds_parent", assignmentId: parent.id } } };
        }
        const approval = validateDelegationApproval({
          policy: communicationPolicy,
          assignmentId: parent.id,
          childScope,
        });
        if (!approval.ok) {
          return { ok: false, error: { code: "message_policy_violation", violation: approval.violation } };
        }

        const childAssignment: MissionAssignment = {
          id: `${parent.id}-child-${command.messageId}`,
          missionId: command.missionId,
          assigneeParticipantId: command.senderParticipantId,
          title: childPayload.childTitle ?? `Delegated: ${parent.title}`,
          objective: childPayload.childObjective ?? parent.objective,
          scope: childScope,
          dependencies: [],
          requiredEvidence: parent.requiredEvidence,
          approvalPolicy: parent.approvalPolicy,
          budget: parent.budget,
          status: "proposed",
          reviewerParticipantIds: [],
          dispatchKey: null,
          parentAssignmentId: parent.id,
          originatingMessageId: command.messageId,
          delegatorParticipantId: requestMessage.senderParticipantId,
          delegationDepth: depthResult.depth + 1,
          createdAt: context.timestamp,
          updatedAt: context.timestamp,
        };
        payloads.push({ type: "mission.assignment_created", assignment: childAssignment });
      }

      // ---- Generalized orchestration, continued: blocker/unblock and
      // completion_notice each may ALSO cause an assignment status change,
      // in this SAME command — the same atomic pattern delegation_response
      // uses above, not a type-specific transaction of its own.
      if (command.messageType === "blocker" && command.assignmentId) {
        const assignment = current.assignments[command.assignmentId];
        if (assignment) {
          if (structuredPayload.resolved === true) {
            const transition = validateAssignmentTransition(assignment.status, "running");
            if (transition.ok) payloads.push({ type: "mission.assignment_status_changed", assignmentId: command.assignmentId, previousStatus: assignment.status, nextStatus: "running" });
          } else {
            const transition = validateAssignmentTransition(assignment.status, "blocked");
            if (transition.ok) payloads.push({ type: "mission.assignment_status_changed", assignmentId: command.assignmentId, previousStatus: assignment.status, nextStatus: "blocked" });
          }
        }
      }

      if (command.messageType === "completion_notice" && command.assignmentId) {
        const assignment = current.assignments[command.assignmentId];
        // Idempotent duplicate handling: only "running" ever proposes
        // SubmitAssignment — an assignment already submitted/beyond simply
        // records the message with no resulting command, never an error.
        if (assignment && assignment.status === "running") {
          const transition = validateAssignmentTransition(assignment.status, "submitted");
          if (transition.ok) payloads.push({ type: "mission.assignment_status_changed", assignmentId: command.assignmentId, previousStatus: assignment.status, nextStatus: "submitted" });
        }
      }

      return { ok: true, payloads };
    }

    default:
      // Unreachable: `isCollaborationCommand` only routes here for the
      // cases above. Kept total rather than asserted, matching this
      // module's existing style for genuinely unreachable branches.
      return { ok: false, error: { code: "mission_not_found", missionId: command.missionId } };
  }
}

export function applyMissionCommand(input: ApplyCommandInput): ApplyCommandResult {
  const { command, context, current, expectedVersion, priorOutcome } = input;
  const mintEventId = input.mintEventId ?? defaultMintEventId;

  // ---- 1. Idempotency ------------------------------------------------------
  const payloadDigest = hashCommandPayload(command);
  if (priorOutcome) {
    if (priorOutcome.payloadDigest !== payloadDigest) {
      return {
        ok: false,
        error: {
          code: "idempotency_conflict",
          message: "This idempotency key was already used for a different command payload.",
        },
      };
    }
    // Genuine replay: fold the already-recorded events onto whatever
    // projection the caller has now, so this is safe to call whether or not
    // the store has caught up yet.
    const base = current ?? emptyMissionProjection(command.missionId);
    let projection = base;
    for (const event of priorOutcome.events) projection = applyMissionEvent(projection, event);
    return { ok: true, projection, events: priorOutcome.events, aggregateVersion: priorOutcome.aggregateVersion, replayed: true };
  }

  // ---- 2. Existence ---------------------------------------------------------
  if (command.type === "CreateMission") {
    if (current !== null) {
      return { ok: false, error: { code: "mission_already_exists", missionId: command.missionId } };
    }
  } else if (current === null) {
    return { ok: false, error: { code: "mission_not_found", missionId: command.missionId } };
  }

  // ---- 3. Optimistic concurrency --------------------------------------------
  const currentVersion = current?.aggregateVersion ?? 0;
  const concurrency = checkExpectedVersion({
    missionId: command.missionId,
    check: { expectedVersion, currentVersion },
  });
  if (!concurrency.ok) {
    return {
      ok: false,
      error: {
        code: "version_conflict",
        missionId: command.missionId,
        expectedVersion: concurrency.conflict.expectedVersion,
        currentVersion: concurrency.conflict.currentVersion,
        message: concurrency.conflict.message,
      },
    };
  }

  // ---- 3a. Authorization (Phase 4D) ------------------------------------------
  // One provider-neutral seam for every command, Mission-state or
  // collaboration — checked before EITHER branch below builds a payload, so
  // a denied command never reaches event emission. Runs only on genuinely
  // new work: the idempotency check above already returned for a replay, so
  // authorization is never re-evaluated (and can never flip) on retry.
  const authorization = authorizeMissionCommand(command, current, context.actor);
  if (!authorization.ok) {
    // Two commands had their own specific, pre-existing error codes before
    // this seam existed (`unauthorized_approval`, `unauthorized_plan_approval`)
    // — preserved verbatim here rather than replaced by the new generic
    // `unauthorized_command` code, so every caller and test that already
    // depends on those exact codes keeps working unchanged.
    if (command.type === "AcceptAssignment" || command.type === "RejectAssignment") {
      return { ok: false, error: { code: "unauthorized_approval", assignmentId: command.assignmentId } };
    }
    if (command.type === "ApproveMissionPlan") {
      return { ok: false, error: { code: "unauthorized_plan_approval", planId: command.planId } };
    }
    return { ok: false, error: authorization.error };
  }

  // ---- 3b. Collaboration commands (Phase 4A) — participants, assignments,
  // messages. Never touch Mission.state, never go through
  // intendedTargetState/validateTransition/payloadsFor — `current` is
  // guaranteed non-null here (existence check above already refused any
  // collaboration command against a missing Mission).
  if (isCollaborationCommand(command)) {
    const built = buildCollaborationPayloads(command, current as MissionProjection, context, input.communicationPolicy ?? DEFAULT_COMMUNICATION_POLICY);
    if (!built.ok) return built;

    const events: MissionEvent[] = [];
    let version = currentVersion;
    let causationId = context.causationId;
    for (const payload of built.payloads) {
      version += 1;
      const event = createMissionEvent({
        eventId: mintEventId(),
        missionId: command.missionId,
        aggregateVersion: version,
        actor: context.actor,
        correlationId: context.correlationId,
        causationId,
        timestamp: context.timestamp,
        provenance: context.actor.kind === "human" ? "human_decision" : "system_inference",
        reason: null,
        payload,
      });
      events.push(event);
      causationId = event.eventId;
    }
    let projection = current as MissionProjection;
    for (const event of events) projection = applyMissionEvent(projection, event);
    return { ok: true, projection, events, aggregateVersion: version, replayed: false };
  }

  // ---- 4. Transition legality -------------------------------------------------
  // CreateMission is genesis, not a transition — there is no "from" state to
  // validate against, so it never goes through validateTransition. Every
  // other command acts on an existing Mission and always does.
  const fromState: MissionState = current?.state ?? "draft";
  let resumeToForEvent: ActiveMissionState | null = null;
  let toState: MissionState;

  if (command.type === "CreateMission") {
    toState = "draft";
  } else {
    const intended = intendedTargetState(command, current);

    if (command.type === "ResumeMission" && !intended) {
      return {
        ok: false,
        error: {
          code: "no_resume_target",
          missionId: command.missionId,
          message: "This mission has no recorded resume target — it was not actually interrupted.",
        },
      };
    }
    if (!intended) {
      // Unreachable given the command union, but keeps the function total.
      return { ok: false, error: { code: "invalid_transition", from: fromState, attempted: fromState, errors: ["Unknown command."] } };
    }
    toState = intended;

    const needsResumeTarget = requiresResumeTarget(toState);
    const candidateResumeTo: ActiveMissionState | null =
      command.type === "EscalateMission"
        ? command.resumeTo
        : needsResumeTarget && current && isActiveMissionState(fromState as ActiveMissionState)
          ? (fromState as ActiveMissionState)
          : null;

    const transitionResult = validateTransition({
      from: fromState,
      to: toState,
      reason: reasonOf(command),
      resumeTo: needsResumeTarget ? candidateResumeTo : undefined,
      recordedResumeTo: current?.resumeTo ?? null,
    });

    if (!transitionResult.ok) {
      return {
        ok: false,
        error: { code: "invalid_transition", from: fromState, attempted: toState, errors: transitionResult.errors },
      };
    }
    resumeToForEvent = needsResumeTarget ? transitionResult.resumeTo : null;
  }

  // ---- 5. Event emission + aggregateVersion increment ------------------------
  const payloads =
    command.type === "CreateMission"
      ? [
          {
            type: "mission.created" as const,
            goal: command.goal,
            repository: command.repository,
            workspaceId: command.workspaceId,
            repositoryId: command.repositoryId ?? null,
          },
          ...(context.actor.kind === "human" ? [{ type: "mission.participant_registered" as const, participant: humanMissionParticipant(context) }] : []),
        ]
      : payloadsFor(command, { previousState: fromState, nextState: toState, resumeTo: resumeToForEvent });

  const events: MissionEvent[] = [];
  let version = currentVersion;
  let causationId = context.causationId;

  for (const payload of payloads) {
    version += 1;
    const event = createMissionEvent({
      eventId: mintEventId(),
      missionId: command.missionId,
      aggregateVersion: version,
      actor: context.actor,
      correlationId: context.correlationId,
      causationId,
      timestamp: context.timestamp,
      provenance: context.actor.kind === "human" ? "human_decision" : "system_inference",
      reason: reasonOf(command),
      payload,
    });
    events.push(event);
    // Chain within one command's own event batch: the second event in a
    // batch is caused by the first, not by whatever caused the command.
    causationId = event.eventId;
  }

  // resumeTo is carried on the event itself (see payloadsFor) and applied by
  // the ordinary reducer below — no patching outside of folding events.
  let projection = current ?? emptyMissionProjection(command.missionId);
  for (const event of events) projection = applyMissionEvent(projection, event);

  return { ok: true, projection, events, aggregateVersion: version, replayed: false };
}

/** Build the record a caller should persist against this command's idempotency key. */
export function buildCommandOutcomeRecord(
  idempotencyKey: string,
  command: MissionCommand,
  result: ApplyCommandSuccess,
): CommandOutcomeRecord {
  return {
    idempotencyKey,
    payloadDigest: hashCommandPayload(command),
    events: result.events,
    aggregateVersion: result.aggregateVersion,
  };
}
