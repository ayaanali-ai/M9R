/**
 * Mission projections (spec STATE_MODEL §2, PASSPORT_EVIDENCE §6)
 * ----------------------------------------------------------------------------
 * Projections are DERIVED views. They are never the authoritative store, and
 * the UI holds projection state only — it does not author domain state.
 *
 * Every reducer here is pure and deterministic: replaying the same event
 * sequence always produces byte-identical output. That is what makes the
 * Passport "reproducible from the same event sequence" rather than a snapshot
 * someone hopes is still accurate.
 *
 * Missing history is surfaced, not smoothed over. A projection built from a
 * stream with a version gap reports `complete: false`, because
 * "complete history" is a claim the record must not make falsely
 * (spec PASSPORT_EVIDENCE §9).
 */

import {
  isTerminalMissionState,
  type ActiveMissionState,
  type AssignmentId,
  type MissionAssignment,
  type MissionDecision,
  type MissionFinding,
  type MissionId,
  type MissionMessage,
  type MissionParticipant,
  type MissionEvidenceRecord,
  type PlanningRequestRecord,
  type MissionPlanProposal,
  type MissionState,
  type ParticipantId,
  type PlanId,
  type StateReason,
} from "./mission-domain";
import { validateEventSequence, type MissionEvent } from "./mission-events";
import type { MissionExecutionRecord } from "./mission-execution-registry";

/** The read model most surfaces need. */
export interface MissionProjection {
  missionId: MissionId;
  /** Genesis identity, from `mission.created`. Empty string until that event is folded. */
  workspaceId: string;
  goal: string;
  repository: string;
  repositoryId: string | null;
  state: MissionState;
  resumeTo: ActiveMissionState | null;
  reason: StateReason | null;
  planVersion: number;
  approvedPlanVersion: number | null;
  participantIds: ParticipantId[];
  /**
   * Phase 4A — full participant records, keyed by id. Distinct from the
   * legacy `participantIds` list above, which stays exactly as Phase 1 left
   * it (fed only by the untouched `mission.participant_added` event).
   */
  participants: Record<ParticipantId, MissionParticipant>;
  assignments: Record<AssignmentId, MissionAssignment>;
  findings: Record<string, MissionFinding>;
  /** Phase 5A — every Plan proposal ever created for this Mission, including superseded/rejected ones (immutable history, same discipline as everything else here). */
  planProposals: Record<PlanId, MissionPlanProposal>;
  /** Phase 4D Part 4 — the authoritative evidence store, keyed by evidenceId. Every record ever created, including superseded ones (immutable history) — never inferred from a message payload; only `RecordEvidence`/`SupersedeEvidence` write here. */
  evidenceRecords: Record<string, MissionEvidenceRecord>;
  /** Durable, fenced execution generations. Provider process ids are references, never identity. */
  executions: Record<string, MissionExecutionRecord>;
  /** Phase 5B — every model-assisted planning request ever made for this Mission, including terminal (completed/failed/cancelled/stale/superseded) ones. Never contains a raw model response — only `redactedDiagnosticRef` pointers into a separate diagnostic store. */
  planningRequests: Record<string, PlanningRequestRecord>;
  /**
   * Phase 4B: BOUNDED to the most recent `MAX_PROJECTION_MESSAGES` — the
   * live projection is for "what's happening now," not a full archive. The
   * authoritative, unbounded history is never lost: it's the underlying
   * event stream itself, retrievable via `queryMissionMessages` (paginated,
   * cursor-based, reads raw events directly rather than this capped array).
   * Fixes the unbounded-growth limitation Phase 4A's notes flagged and left
   * open.
   */
  messages: MissionMessage[];
  /** Bounded projection summary — lets a caller know "is anything waiting?" without scanning `messages` (which may have already dropped the older half of history) or paging through events. */
  openFindingsCount: number;
  /**
   * Message ids of `question`s with no correlated `answer` yet — Phase 4D
   * Part 3 fix: this index is DELIBERATELY UNBOUNDED, independent of the
   * `messages` array's 200-entry window. A question does not stop being
   * unanswered just because 200 later messages pushed it out of the live
   * summary — the audit's own finding #335 flagged exactly this bug in the
   * PREVIOUS implementation, which truncated this list to match `messages`.
   * An entry is added when the `question` message posts and removed only
   * when a real, correlated `answer` posts — never on any bounded-window
   * eviction. Resolved items leave this index; the full immutable history
   * (including which question the removed answer resolved) remains
   * retrievable via `queryMissionMessages`.
   */
  unansweredQuestionMessageIds: string[];
  /** Message ids of NEW `blocker` messages with no correlated resolving (`resolved: true`, correctly `replyToMessageId`-linked) `blocker` message yet. Unbounded — same discipline as `unansweredQuestionMessageIds`. */
  unresolvedBlockerMessageIds: string[];
  /** Message ids of `review_request`s with no later message replying to them yet — mirrors `mission-collaboration-protocol.ts`'s own "outstanding" definition. Unbounded. */
  pendingReviewRequestMessageIds: string[];
  /** Message ids of `approval_request`s with no later message replying to them yet. Unbounded. */
  pendingApprovalRequestMessageIds: string[];
  /** Message ids of `delegation_request`s with no later `delegation_response` replying to them yet. Unbounded. */
  pendingDelegationRequestMessageIds: string[];
  attachedEvidenceIds: string[];
  attestedEvidenceIds: string[];
  decision: MissionDecision | null;
  reviewedRevision: string | null;
  aggregateVersion: number;
  terminal: boolean;
  /** False when the source stream had gaps or ordering problems. */
  complete: boolean;
  /** Deterministic notes about why the projection is incomplete. */
  integrityIssues: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

export function emptyMissionProjection(missionId: MissionId): MissionProjection {
  return {
    missionId,
    workspaceId: "",
    goal: "",
    repository: "",
    repositoryId: null,
    state: "draft",
    resumeTo: null,
    reason: null,
    planVersion: 0,
    approvedPlanVersion: null,
    participantIds: [],
    participants: {},
    assignments: {},
    findings: {},
    planProposals: {},
    evidenceRecords: {},
    executions: {},
    planningRequests: {},
    messages: [],
    openFindingsCount: 0,
    unansweredQuestionMessageIds: [],
    unresolvedBlockerMessageIds: [],
    pendingReviewRequestMessageIds: [],
    pendingApprovalRequestMessageIds: [],
    pendingDelegationRequestMessageIds: [],
    attachedEvidenceIds: [],
    attestedEvidenceIds: [],
    decision: null,
    reviewedRevision: null,
    aggregateVersion: 0,
    terminal: false,
    complete: true,
    integrityIssues: [],
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * Apply one event. Returns a NEW projection — never mutates the input, so a
 * caller can safely keep intermediate states (useful for a timeline).
 */
/** The live projection's message window — see MissionProjection.messages's doc comment. */
export const MAX_PROJECTION_MESSAGES = 200;

export function applyMissionEvent(state: MissionProjection, event: MissionEvent): MissionProjection {
  const next: MissionProjection = {
    ...state,
    participantIds: [...state.participantIds],
    participants: { ...state.participants },
    assignments: { ...state.assignments },
    findings: { ...state.findings },
    planProposals: { ...state.planProposals },
    evidenceRecords: { ...state.evidenceRecords },
    executions: { ...state.executions },
    planningRequests: { ...state.planningRequests },
    messages: [...state.messages],
    unansweredQuestionMessageIds: [...state.unansweredQuestionMessageIds],
    unresolvedBlockerMessageIds: [...state.unresolvedBlockerMessageIds],
    pendingReviewRequestMessageIds: [...state.pendingReviewRequestMessageIds],
    pendingApprovalRequestMessageIds: [...state.pendingApprovalRequestMessageIds],
    pendingDelegationRequestMessageIds: [...state.pendingDelegationRequestMessageIds],
    attachedEvidenceIds: [...state.attachedEvidenceIds],
    attestedEvidenceIds: [...state.attestedEvidenceIds],
    integrityIssues: [...state.integrityIssues],
    aggregateVersion: event.aggregateVersion,
    updatedAt: event.timestamp,
  };

  switch (event.payload.type) {
    case "mission.created":
      next.goal = event.payload.goal;
      next.repository = event.payload.repository;
      next.workspaceId = event.payload.workspaceId;
      next.repositoryId = event.payload.repositoryId;
      next.state = "draft";
      next.createdAt = event.timestamp;
      break;

    case "mission.plan_proposed":
      next.planVersion = event.payload.planVersion;
      break;

    case "mission.plan_approved":
      next.approvedPlanVersion = event.payload.planVersion;
      break;

    case "mission.state_changed": {
      next.state = event.payload.nextState;
      next.reason = event.reason;
      next.resumeTo = event.payload.resumeTo;
      next.terminal = isTerminalMissionState(event.payload.nextState);
      break;
    }

    case "mission.participant_added":
      if (!next.participantIds.includes(event.payload.participantId)) {
        next.participantIds.push(event.payload.participantId);
      }
      break;

    case "mission.evidence_attached":
      if (!next.attachedEvidenceIds.includes(event.payload.evidenceId)) {
        next.attachedEvidenceIds.push(event.payload.evidenceId);
      }
      break;

    case "mission.evidence_attested":
      // Attestation is a distinct claim from attachment and is tracked
      // separately — system attachment must never read as human approval.
      if (!next.attestedEvidenceIds.includes(event.payload.evidenceId)) {
        next.attestedEvidenceIds.push(event.payload.evidenceId);
      }
      break;

    case "mission.decision_recorded":
      next.decision = event.payload.decision;
      next.reviewedRevision = event.payload.reviewedRevision;
      break;

    // ---- Phase 4A: participants ----------------------------------------
    case "mission.participant_registered":
      next.participants[event.payload.participant.id] = event.payload.participant;
      break;

    case "mission.participant_status_changed": {
      const existing = next.participants[event.payload.participantId];
      if (existing) next.participants[event.payload.participantId] = { ...existing, status: event.payload.nextStatus, updatedAt: event.timestamp };
      break;
    }

    case "mission.participant_removed": {
      const existing = next.participants[event.payload.participantId];
      if (existing) next.participants[event.payload.participantId] = { ...existing, status: "removed", updatedAt: event.timestamp };
      break;
    }

    // ---- Phase 4A: assignments -------------------------------------------
    case "mission.assignment_created":
      next.assignments[event.payload.assignment.id] = event.payload.assignment;
      break;

    case "mission.assignment_status_changed": {
      const existing = next.assignments[event.payload.assignmentId];
      if (existing) {
        next.assignments[event.payload.assignmentId] = {
          ...existing,
          status: event.payload.nextStatus,
          assigneeParticipantId: event.payload.assigneeParticipantId !== undefined ? event.payload.assigneeParticipantId : existing.assigneeParticipantId,
          dispatchKey: event.payload.dispatchKey !== undefined ? event.payload.dispatchKey : existing.dispatchKey,
          updatedAt: event.timestamp,
        };
      }
      break;
    }

    // ---- Phase 4A: Agent Message Protocol ---------------------------------
    case "mission.message_posted": {
      const message = event.payload.message;
      next.messages.push(message);
      if (next.messages.length > MAX_PROJECTION_MESSAGES) next.messages.shift();

      // Every index below is intentionally UNBOUNDED — never pruned to
      // match the `messages` window above. An obligation does not resolve
      // itself just because 200 later messages arrived; only a real
      // correlated resolution message removes an entry.
      if (message.type === "question") {
        next.unansweredQuestionMessageIds.push(message.id);
      } else if (message.type === "answer" && message.replyToMessageId) {
        next.unansweredQuestionMessageIds = next.unansweredQuestionMessageIds.filter((id) => id !== message.replyToMessageId);
      }

      if (message.type === "blocker") {
        if (message.structuredPayload?.resolved === true && message.replyToMessageId) {
          next.unresolvedBlockerMessageIds = next.unresolvedBlockerMessageIds.filter((id) => id !== message.replyToMessageId);
        } else if (message.structuredPayload?.resolved !== true) {
          next.unresolvedBlockerMessageIds.push(message.id);
        }
      }

      if (message.type === "review_request") {
        next.pendingReviewRequestMessageIds.push(message.id);
        // Audit item 4 — per-assignment reviewer registry. Naming reviewers
        // in a `review_request` for THIS assignment is the only place the
        // domain records "who reviews this," so it's also where the
        // registry is populated — additive, never replacing previously
        // named reviewers from an earlier request on the same assignment.
        const reviewerIds = message.structuredPayload?.reviewerParticipantIds;
        if (message.assignmentId && Array.isArray(reviewerIds)) {
          const assignment = next.assignments[message.assignmentId];
          if (assignment) {
            const merged = new Set(assignment.reviewerParticipantIds);
            for (const id of reviewerIds) {
              if (typeof id === "string") merged.add(id);
            }
            next.assignments[message.assignmentId] = { ...assignment, reviewerParticipantIds: [...merged] };
          }
        }
      }
      if (message.type === "approval_request") {
        next.pendingApprovalRequestMessageIds.push(message.id);
      }
      if (message.type === "delegation_request") {
        next.pendingDelegationRequestMessageIds.push(message.id);
      }
      // A reply to an outstanding review_request/approval_request only
      // resolves it when the reply explicitly says so via
      // `structuredPayload.resolution` — same convention `blocker` already
      // uses (`structuredPayload.resolved === true`). Plain commentary
      // replies (no `resolution`, or `resolution: "comment"`) must NOT
      // silently clear the pending flag — that was the bug: ANY reply used
      // to clear it. `resolution` is `"approved" | "rejected" | "comment"`
      // (mission-collaboration-protocol.ts validates it per subject-type);
      // "approved"/"rejected" both resolve the request — the request is no
      // longer outstanding either way — only "comment" (or absence) leaves
      // it pending.
      if (message.replyToMessageId) {
        const resolution = message.structuredPayload?.resolution;
        const resolves = resolution === "approved" || resolution === "rejected";
        if (resolves) {
          next.pendingReviewRequestMessageIds = next.pendingReviewRequestMessageIds.filter((id) => id !== message.replyToMessageId);
          next.pendingApprovalRequestMessageIds = next.pendingApprovalRequestMessageIds.filter((id) => id !== message.replyToMessageId);
        }
        if (message.type === "delegation_response") {
          next.pendingDelegationRequestMessageIds = next.pendingDelegationRequestMessageIds.filter((id) => id !== message.replyToMessageId);
        }
      }
      break;
    }

    // ---- Phase 4B: finding lifecycle --------------------------------------
    case "mission.finding_opened":
      next.findings[event.payload.finding.id] = event.payload.finding;
      next.openFindingsCount += 1;
      break;

    case "mission.finding_status_changed": {
      const existing = next.findings[event.payload.findingId];
      if (existing) {
        const wasOpenBefore = existing.status !== "closed" && existing.status !== "withdrawn";
        const isOpenAfter = event.payload.nextStatus !== "closed" && event.payload.nextStatus !== "withdrawn";
        if (wasOpenBefore && !isOpenAfter) next.openFindingsCount -= 1;
        if (!wasOpenBefore && isOpenAfter) next.openFindingsCount += 1;
        next.findings[event.payload.findingId] = {
          ...existing,
          status: event.payload.nextStatus,
          resolutionEvidenceRefs: event.payload.resolutionEvidenceRefs ?? existing.resolutionEvidenceRefs,
          updatedAt: event.timestamp,
        };
      }
      break;
    }

    // ---- Phase 5A: Mission Plan proposals ---------------------------------
    case "mission.plan_proposal_created":
      next.planProposals[event.payload.planProposal.id] = event.payload.planProposal;
      break;

    case "mission.plan_proposal_status_changed": {
      const existing = next.planProposals[event.payload.planId];
      if (existing) {
        next.planProposals[event.payload.planId] = {
          ...existing,
          status: event.payload.nextStatus,
          validationErrors: event.payload.validationErrors ?? existing.validationErrors,
        };
      }
      break;
    }

    // ---- Phase 4D Part 4: evidence provenance -----------------------------
    case "mission.evidence_recorded":
      next.evidenceRecords[event.payload.record.id] = event.payload.record;
      break;

    case "mission.evidence_superseded": {
      const existing = next.evidenceRecords[event.payload.evidenceId];
      if (existing) {
        next.evidenceRecords[event.payload.evidenceId] = { ...existing, supersededByEvidenceId: event.payload.supersededByEvidenceId, updatedAt: event.timestamp };
      }
      break;
    }

    case "mission.execution_started":
      next.executions[event.payload.record.executionId] = event.payload.record;
      break;

    case "mission.execution_terminal":
      next.executions[event.payload.record.executionId] = event.payload.record;
      break;

    // ---- Phase 5B: model-assisted planning requests -----------------------
    case "mission.model_plan_request_created":
      next.planningRequests[event.payload.record.id] = event.payload.record;
      break;

    case "mission.model_plan_request_status_changed": {
      const existing = next.planningRequests[event.payload.planningRequestId];
      if (existing) {
        next.planningRequests[event.payload.planningRequestId] = {
          ...existing,
          status: event.payload.nextStatus,
          attemptCount: event.payload.attemptCount ?? existing.attemptCount,
          redactedDiagnosticRef: event.payload.redactedDiagnosticRef !== undefined ? event.payload.redactedDiagnosticRef : existing.redactedDiagnosticRef,
          finalOutcome: event.payload.finalOutcome !== undefined ? event.payload.finalOutcome : existing.finalOutcome,
          resultingPlanId: event.payload.resultingPlanId !== undefined ? event.payload.resultingPlanId : existing.resultingPlanId,
          startedAt: event.payload.nextStatus === "in_progress" && existing.startedAt === null ? event.timestamp : existing.startedAt,
          completedAt: event.payload.nextStatus !== "requested" && event.payload.nextStatus !== "in_progress" ? event.timestamp : existing.completedAt,
        };
      }
      break;
    }
  }

  return next;
}

/**
 * Fold a full event stream into a projection. Validates the sequence first and
 * records any integrity problems on the result rather than throwing — a
 * damaged history should still be inspectable, just honestly labelled.
 */
export function projectMission(missionId: MissionId, events: readonly MissionEvent[]): MissionProjection {
  const sequence = validateEventSequence(events);
  let projection = emptyMissionProjection(missionId);

  for (const event of events) {
    projection = applyMissionEvent(projection, event);
  }

  if (!sequence.ok) {
    projection = {
      ...projection,
      complete: false,
      integrityIssues: sequence.issues.map((issue) => `event[${issue.index}]: ${issue.message}`),
    };
  }

  return projection;
}

// ---------------------------------------------------------------------------
// Phase 4B — cursor-based collaboration history, independent of the
// projection's bounded `messages` window
// ---------------------------------------------------------------------------

export interface QueryMissionMessagesOptions {
  /** Aggregate version to resume AFTER — omit for the first page. Cursor semantics: opaque to the caller, always the returned `nextCursor`. */
  cursor?: number | null;
  limit: number;
}

export interface QueryMissionMessagesResult {
  messages: MissionMessage[];
  /** Pass this back as `cursor` for the next page. Null once every event has been read — there is no next page. */
  nextCursor: number | null;
}

/**
 * The FULL, unbounded message history, read directly from the raw event
 * stream in `aggregateVersion` order — never from the projection's capped
 * `messages` array. This is what makes "the authoritative event history
 * remains intact" true even though the live projection deliberately drops
 * old messages: nothing is ever deleted from the event stream itself, only
 * excluded from the SUMMARY view.
 */
export function queryMissionMessages(events: readonly MissionEvent[], options: QueryMissionMessagesOptions): QueryMissionMessagesResult {
  const startAfter = options.cursor ?? 0;
  const messages: MissionMessage[] = [];
  let nextCursor: number | null = null;

  for (const event of events) {
    if (event.aggregateVersion <= startAfter) continue;
    if (event.payload.type !== "mission.message_posted") continue;
    if (messages.length >= options.limit) {
      nextCursor = event.aggregateVersion - 1;
      break;
    }
    messages.push(event.payload.message);
  }

  return { messages, nextCursor };
}
