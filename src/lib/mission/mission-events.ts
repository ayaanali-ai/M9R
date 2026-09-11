/**
 * Mission domain events (spec STATE_MODEL §14)
 * ----------------------------------------------------------------------------
 * Every state transition emits an immutable event carrying aggregate,
 * previous state, next state, actor, reason, correlation, causation, and
 * timestamp.
 *
 * Causation is the point. Timestamp order alone is NOT causality
 * (spec PASSPORT_EVIDENCE §5) — "Claude's finding caused Codex's change" is a
 * claim the record must be able to prove, not infer from two adjacent rows.
 *
 * These events are also the instrumentation: because they carry causation and
 * correlation, analytics are an OUTPUT of the architecture rather than a
 * reporting layer bolted on later. The Passport is a reproducible projection
 * over this sequence (spec PASSPORT_EVIDENCE §6).
 */

import type {
  ActiveMissionState,
  AssignmentId,
  MissionAssignment,
  MissionDecision,
  MissionId,
  MissionMessage,
  MissionParticipant,
  MissionState,
  ParticipantId,
  ParticipantStatus,
  AssignmentStatus,
  ProvenanceKind,
  StateReason,
} from "./mission-domain";

export const MISSION_EVENT_SCHEMA_VERSION = "oathlock.mission-event.v1" as const;

/** Who caused this event. Actors are never inferred. */
export type EventActor =
  | { kind: "human"; id: ParticipantId }
  | { kind: "agent"; id: ParticipantId }
  | { kind: "system"; id: "orchestrator" | "reconciler" | "planner" | "verifier" };

export const MISSION_EVENT_TYPES = [
  "mission.created",
  "mission.plan_proposed",
  "mission.plan_approved",
  "mission.state_changed",
  "mission.participant_added",
  "mission.evidence_attached",
  "mission.evidence_attested",
  "mission.decision_recorded",
  // Phase 4A — participants, assignments, the Agent Message Protocol.
  // `mission.participant_added`'s bare {participantId} above predates
  // these and is left untouched; new richer registration goes through
  // `mission.participant_registered` instead (see MissionParticipantPayload
  // vs. MissionParticipantRegisteredPayload below).
  "mission.participant_registered",
  "mission.participant_status_changed",
  "mission.participant_removed",
  "mission.assignment_created",
  "mission.assignment_status_changed",
  "mission.message_posted",
  // Phase 4B — finding lifecycle.
  "mission.finding_opened",
  "mission.finding_status_changed",
  // Phase 5A — Mission Plan proposals. Named "plan_proposal_*", NOT
  // "plan_*", to avoid colliding with the existing `mission.plan_proposed`/
  // `mission.plan_approved` above (Phase 1's bare `planVersion` counter —
  // a genuinely different, thinner concept; see mission-domain.ts's
  // MissionPlanProposal doc comment for the full disambiguation).
  "mission.plan_proposal_created",
  "mission.plan_proposal_status_changed",
  // Phase 4D Part 4 — the evidence provenance model. NOT a mutation of
  // `mission.evidence_attached`/`mission.evidence_attested` above (Phase 1's
  // bare `{evidenceId, digest}` pair) — same disambiguation precedent as
  // Phase 5A's Plan-proposal events. See mission-domain.ts's
  // MissionEvidenceRecord doc comment.
  "mission.evidence_recorded",
  "mission.evidence_superseded",
  "mission.execution_started",
  "mission.execution_terminal",
  // Phase 5B — model-assisted planning request/result lifecycle. Two event
  // types cover the full 7-state `PlanningRequestStatus` machine — the SAME
  // "one status-changed event reused across every transition" pattern
  // Phase 4A/4B/5A already established for participants/assignments/
  // findings/Plan proposals, rather than the ~6 separately-named events the
  // spec enumerated as EXAMPLES. A successful result still emits the
  // EXISTING `mission.plan_proposal_created`/`mission.plan_proposal_status_changed`
  // events (no new Plan-creation path) — these two only cover the
  // planning-request record's OWN lifecycle.
  "mission.model_plan_request_created",
  "mission.model_plan_request_status_changed",
] as const;

export type MissionEventType = (typeof MISSION_EVENT_TYPES)[number];

/**
 * Fields common to every event. Immutable by construction: read-only, and
 * never mutated after `createMissionEvent` returns.
 */
export interface MissionEventEnvelope {
  readonly schemaVersion: typeof MISSION_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly type: MissionEventType;
  /** The aggregate this event belongs to. */
  readonly missionId: MissionId;
  /** Aggregate version AFTER this event is applied. Strictly increasing by 1. */
  readonly aggregateVersion: number;
  readonly actor: EventActor;
  /** Structured reason; required for non-happy-path transitions. */
  readonly reason: StateReason | null;
  /** Groups every event belonging to one logical user request. */
  readonly correlationId: string;
  /** The event that directly caused this one. Null only for a root event. */
  readonly causationId: string | null;
  readonly timestamp: string;
  /** How this event's claim is grounded (spec PRODUCT §7). */
  readonly provenance: ProvenanceKind;
}

export interface MissionStateChangedPayload {
  readonly previousState: MissionState;
  readonly nextState: MissionState;
  /**
   * Where the Mission resumes to, when `nextState` is an interruption
   * (needs_input/blocked/paused), or null when leaving one or when this
   * transition is not an interruption at all. Carried on the EVENT, not
   * patched onto a projection afterward — a projection built by folding
   * events must be reproducible from the events alone (spec
   * PASSPORT_EVIDENCE §6), and resumeTo is part of what "the state" means.
   */
  readonly resumeTo: ActiveMissionState | null;
}

export interface MissionDecisionPayload {
  readonly decision: MissionDecision;
  /** The exact reviewed revision the human decided on. */
  readonly reviewedRevision: string | null;
}

export interface MissionEvidencePayload {
  readonly evidenceId: string;
  readonly digest: string;
}

export interface MissionParticipantPayload {
  readonly participantId: ParticipantId;
}

// ---------------------------------------------------------------------------
// Phase 4A — participants, assignments, the Agent Message Protocol
// ---------------------------------------------------------------------------

/** Full snapshot at registration — the projection folds this directly, never patches it together from a bare id afterward. */
export interface MissionParticipantRegisteredPayload {
  readonly participant: MissionParticipant;
}

export interface MissionParticipantStatusChangedPayload {
  readonly participantId: ParticipantId;
  readonly previousStatus: ParticipantStatus;
  readonly nextStatus: ParticipantStatus;
}

export interface MissionParticipantRemovedPayload {
  readonly participantId: ParticipantId;
}

export interface MissionAssignmentCreatedPayload {
  readonly assignment: MissionAssignment;
}

export interface MissionAssignmentStatusChangedPayload {
  readonly assignmentId: AssignmentId;
  readonly previousStatus: AssignmentStatus;
  readonly nextStatus: AssignmentStatus;
  /** Carried when `AssignAssignment` sets (or a later transition clears) the assignee — the projection's assignment record needs this alongside the status change, not as a separate event. */
  readonly assigneeParticipantId?: ParticipantId | null;
  /** Carried when `AssignAssignment` binds a scheduler slot. */
  readonly dispatchKey?: string | null;
}

/** A durable Mission record of one message. Never itself Mission-mutating — see MissionMessage's doc comment in mission-domain.ts. */
export interface MissionMessagePostedPayload {
  readonly message: MissionMessage;
}

// ---------------------------------------------------------------------------
// Phase 4B — finding lifecycle
// ---------------------------------------------------------------------------

export interface MissionFindingOpenedPayload {
  readonly finding: import("./mission-domain").MissionFinding;
}

export interface MissionFindingStatusChangedPayload {
  readonly findingId: string;
  readonly previousStatus: import("./mission-domain").FindingStatus;
  readonly nextStatus: import("./mission-domain").FindingStatus;
  readonly resolutionEvidenceRefs?: string[];
}

export interface MissionPlanPayload {
  readonly planVersion: number;
}

// ---------------------------------------------------------------------------
// Phase 5A — Mission Plan proposals
// ---------------------------------------------------------------------------

export interface MissionPlanProposalCreatedPayload {
  readonly planProposal: import("./mission-domain").MissionPlanProposal;
}

export interface MissionPlanProposalStatusChangedPayload {
  readonly planId: string;
  readonly previousStatus: import("./mission-domain").PlanStatus;
  readonly nextStatus: import("./mission-domain").PlanStatus;
  readonly validationErrors?: string[];
  /** Set only by materialization — the real ids minted for what this Plan proposed, keyed by the PROPOSED id, so the mapping survives in the event itself rather than needing to be re-derived later. */
  readonly materializedParticipantIds?: Record<string, string>;
  readonly materializedAssignmentIds?: Record<string, string>;
}

export interface MissionCreatedPayload {
  readonly goal: string;
  readonly repository: string;
  /** Genesis identity — carried on the event so it is never inferred later. */
  readonly workspaceId: string;
  readonly repositoryId: string | null;
}

// ---------------------------------------------------------------------------
// Phase 4D Part 4 — evidence provenance
// ---------------------------------------------------------------------------

export interface MissionEvidenceRecordedPayload {
  readonly record: import("./mission-domain").MissionEvidenceRecord;
}

export interface MissionEvidenceSupersededPayload {
  readonly evidenceId: string;
  readonly supersededByEvidenceId: string;
}

export interface MissionExecutionStartedPayload {
  readonly record: import("./mission-execution-registry").MissionExecutionRecord;
}

export interface MissionExecutionTerminalPayload {
  readonly record: import("./mission-execution-registry").MissionExecutionRecord;
}

// ---------------------------------------------------------------------------
// Phase 5B — model-assisted planning requests
// ---------------------------------------------------------------------------

export interface MissionModelPlanRequestCreatedPayload {
  readonly record: import("./mission-domain").PlanningRequestRecord;
}

export interface MissionModelPlanRequestStatusChangedPayload {
  readonly planningRequestId: string;
  readonly previousStatus: import("./mission-domain").PlanningRequestStatus;
  readonly nextStatus: import("./mission-domain").PlanningRequestStatus;
  readonly attemptCount?: number;
  readonly redactedDiagnosticRef?: string | null;
  readonly finalOutcome?: import("./mission-domain").PlanningRequestRecord["finalOutcome"];
  readonly resultingPlanId?: string | null;
}

export type MissionEventPayload =
  | ({ type: "mission.created" } & MissionCreatedPayload)
  | ({ type: "mission.plan_proposed" } & MissionPlanPayload)
  | ({ type: "mission.plan_approved" } & MissionPlanPayload)
  | ({ type: "mission.state_changed" } & MissionStateChangedPayload)
  | ({ type: "mission.participant_added" } & MissionParticipantPayload)
  | ({ type: "mission.evidence_attached" } & MissionEvidencePayload)
  | ({ type: "mission.evidence_attested" } & MissionEvidencePayload)
  | ({ type: "mission.decision_recorded" } & MissionDecisionPayload)
  | ({ type: "mission.participant_registered" } & MissionParticipantRegisteredPayload)
  | ({ type: "mission.participant_status_changed" } & MissionParticipantStatusChangedPayload)
  | ({ type: "mission.participant_removed" } & MissionParticipantRemovedPayload)
  | ({ type: "mission.assignment_created" } & MissionAssignmentCreatedPayload)
  | ({ type: "mission.assignment_status_changed" } & MissionAssignmentStatusChangedPayload)
  | ({ type: "mission.message_posted" } & MissionMessagePostedPayload)
  | ({ type: "mission.finding_opened" } & MissionFindingOpenedPayload)
  | ({ type: "mission.finding_status_changed" } & MissionFindingStatusChangedPayload)
  | ({ type: "mission.plan_proposal_created" } & MissionPlanProposalCreatedPayload)
  | ({ type: "mission.plan_proposal_status_changed" } & MissionPlanProposalStatusChangedPayload)
  | ({ type: "mission.evidence_recorded" } & MissionEvidenceRecordedPayload)
  | ({ type: "mission.evidence_superseded" } & MissionEvidenceSupersededPayload)
  | ({ type: "mission.execution_started" } & MissionExecutionStartedPayload)
  | ({ type: "mission.execution_terminal" } & MissionExecutionTerminalPayload)
  | ({ type: "mission.model_plan_request_created" } & MissionModelPlanRequestCreatedPayload)
  | ({ type: "mission.model_plan_request_status_changed" } & MissionModelPlanRequestStatusChangedPayload);

export type MissionEvent = MissionEventEnvelope & { readonly payload: MissionEventPayload };

export interface CreateMissionEventInput {
  eventId: string;
  missionId: MissionId;
  aggregateVersion: number;
  actor: EventActor;
  correlationId: string;
  causationId: string | null;
  timestamp: string;
  provenance: ProvenanceKind;
  reason?: StateReason | null;
  payload: MissionEventPayload;
}

/**
 * Build an immutable event. Frozen so that a projection, a test, or a future
 * orchestrator cannot mutate history in place.
 */
export function createMissionEvent(input: CreateMissionEventInput): MissionEvent {
  const event: MissionEvent = {
    schemaVersion: MISSION_EVENT_SCHEMA_VERSION,
    eventId: input.eventId,
    type: input.payload.type,
    missionId: input.missionId,
    aggregateVersion: input.aggregateVersion,
    actor: input.actor,
    reason: input.reason ?? null,
    correlationId: input.correlationId,
    causationId: input.causationId,
    timestamp: input.timestamp,
    provenance: input.provenance,
    payload: input.payload,
  };
  return Object.freeze(event);
}

export interface EventSequenceIssue {
  index: number;
  message: string;
}

/**
 * Validate that a stream is a well-formed history for one aggregate: same
 * mission, versions strictly increasing by exactly 1, and every non-root event
 * caused by an event already in the stream.
 *
 * Gaps matter — a Passport projected over a stream with a missing version is
 * not a complete history, and the record must say so rather than quietly
 * rendering whatever it has.
 */
export function validateEventSequence(events: readonly MissionEvent[]): { ok: boolean; issues: EventSequenceIssue[] } {
  const issues: EventSequenceIssue[] = [];
  const seenIds = new Set<string>();

  events.forEach((event, index) => {
    if (index === 0) {
      if (event.aggregateVersion !== 1) {
        issues.push({ index, message: `First event must have aggregateVersion 1, got ${event.aggregateVersion}.` });
      }
      if (event.causationId !== null) {
        issues.push({ index, message: "First event must be a root event with a null causationId." });
      }
    } else {
      const previous = events[index - 1];
      if (event.missionId !== previous.missionId) {
        issues.push({ index, message: "Event stream mixes multiple missions." });
      }
      if (event.aggregateVersion !== previous.aggregateVersion + 1) {
        issues.push({
          index,
          message: `Version gap: expected ${previous.aggregateVersion + 1}, got ${event.aggregateVersion}.`,
        });
      }
      if (event.causationId !== null && !seenIds.has(event.causationId)) {
        issues.push({ index, message: `causationId ${event.causationId} refers to an event not in this stream.` });
      }
    }
    seenIds.add(event.eventId);
  });

  return { ok: issues.length === 0, issues };
}
