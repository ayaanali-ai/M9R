/**
 * Mission collaboration protocol — typed schemas for the five message types
 * Phase 4B left generic (Phase 4C).
 * ----------------------------------------------------------------------------
 * `delegation_request`/`delegation_response`/`question`/`answer` already got
 * real typed semantics in Phase 4B. This module extends the SAME pattern —
 * validated `structuredPayload` shapes, never free-form `body` text — to
 * `review_request`, `blocker`, `evidence_notice`, `approval_request`, and
 * `completion_notice`. Every validator here is pure: given the same message
 * payload and the same projection state, it always returns the same
 * verdict. `mission-command-handler.ts` is the only caller, and it always
 * runs these AFTER the generic `validateMessage` policy check
 * (mission-communication-policy.ts) has already passed.
 *
 * None of these validators emit an event or decide a resulting command
 * themselves — that split stays in `mission-command-handler.ts`'s
 * `deriveResultingCollaborationPayloads` (the generalized orchestration seam
 * this phase introduces), so "is this payload well-formed and authorized"
 * stays separate from "what, if anything, does accepting it cause."
 */

import type { AssignmentId, MissionAssignment, MissionMessage } from "./mission-domain";
import { checkDependenciesSatisfied } from "./mission-collaboration";

export type ProtocolViolation =
  | { code: "review_request_assignment_not_submitted"; assignmentId: AssignmentId }
  | { code: "review_request_self_review_disallowed"; participantId: string }
  | { code: "review_request_reviewer_not_active"; participantId: string }
  | { code: "review_request_duplicate"; assignmentId: AssignmentId }
  | { code: "review_request_no_reviewers" }
  | { code: "blocker_missing_reason" }
  | { code: "blocker_unblock_missing_reference" }
  | { code: "blocker_unblock_wrong_reference"; blockerMessageId: string }
  | { code: "blocker_already_resolved"; blockerMessageId: string }
  | { code: "evidence_notice_missing_assignment" }
  | { code: "evidence_notice_missing_evidence_refs" }
  | { code: "evidence_notice_unknown_evidence_ref"; evidenceId: string }
  | { code: "evidence_wrong_assignment"; evidenceId: string; expectedAssignmentId: string; actualAssignmentId: string | null }
  | { code: "evidence_superseded"; evidenceId: string; supersededByEvidenceId: string }
  | { code: "approval_request_missing_subject" }
  | { code: "approval_request_missing_reference"; subject: string }
  | { code: "approval_request_duplicate"; subject: string; reference: string }
  | { code: "completion_notice_missing_assignment" }
  | { code: "completion_notice_assignment_not_running"; assignmentId: AssignmentId }
  | { code: "completion_notice_missing_required_evidence"; missing: string[] }
  | { code: "completion_notice_dependencies_incomplete"; unsatisfied: AssignmentId[] }
  | { code: "completion_notice_sender_not_assignee"; assignmentId: AssignmentId; senderParticipantId: string };

export type ProtocolValidationResult = { ok: true } | { ok: false; violation: ProtocolViolation };

// ---------------------------------------------------------------------------
// review_request
// ---------------------------------------------------------------------------

export const REVIEW_POLICIES = ["single_reviewer", "any_of", "all_of"] as const;
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number];

export interface ReviewRequestPayload {
  reviewerParticipantIds: string[];
  scope?: string;
  requiredEvidence?: string[];
  originatingExecutionRef?: string | null;
  reviewPolicy?: ReviewPolicy;
}

export interface ValidateReviewRequestInput {
  message: Pick<MissionMessage, "senderParticipantId" | "assignmentId">;
  payload: ReviewRequestPayload;
  assignment: MissionAssignment | null;
  participants: Record<string, { status: string }>;
  allowSelfReview: boolean;
  /** Every message already in the projection — used only to detect an outstanding, unanswered prior request for the same assignment. */
  priorMessages: readonly MissionMessage[];
}

/**
 * "Duplicate" is judged narrowly and cheaply: an assignment with an already-
 * OUTSTANDING `review_request` may not receive a second one. A request is
 * OUTSTANDING until a reply explicitly resolves it —
 * `structuredPayload.resolution === "approved" | "rejected"` — mirroring
 * `mission-projection.ts`'s `pendingReviewRequestMessageIds` semantics
 * (a plain commentary reply, no `resolution` or `resolution: "comment"`,
 * does NOT resolve it, so re-requesting is still refused). This is
 * deliberately simpler than tracking a full review record — a dedicated
 * review aggregate was explicitly not built this phase (see
 * IMPLEMENTATION_NOTES.md).
 */
export function validateReviewRequestPayload(input: ValidateReviewRequestInput): ProtocolValidationResult {
  if (!input.assignment) return { ok: false, violation: { code: "review_request_assignment_not_submitted", assignmentId: input.message.assignmentId ?? "" } };
  if (input.assignment.status !== "submitted") {
    return { ok: false, violation: { code: "review_request_assignment_not_submitted", assignmentId: input.assignment.id } };
  }
  if (input.payload.reviewerParticipantIds.length === 0) return { ok: false, violation: { code: "review_request_no_reviewers" } };

  for (const reviewerId of input.payload.reviewerParticipantIds) {
    if (!input.allowSelfReview && reviewerId === input.message.senderParticipantId) {
      return { ok: false, violation: { code: "review_request_self_review_disallowed", participantId: reviewerId } };
    }
    const reviewer = input.participants[reviewerId];
    if (!reviewer || reviewer.status !== "active") {
      return { ok: false, violation: { code: "review_request_reviewer_not_active", participantId: reviewerId } };
    }
  }

  const resolvedIds = new Set(
    input.priorMessages
      .filter((m) => m.replyToMessageId && (m.structuredPayload?.resolution === "approved" || m.structuredPayload?.resolution === "rejected"))
      .map((m) => m.replyToMessageId as string),
  );
  const outstanding = input.priorMessages.some((m) => m.type === "review_request" && m.assignmentId === input.assignment!.id && !resolvedIds.has(m.id));
  if (outstanding) return { ok: false, violation: { code: "review_request_duplicate", assignmentId: input.assignment.id } };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// blocker
// ---------------------------------------------------------------------------

export const BLOCKER_REASONS = [
  "waiting_for_participant",
  "waiting_for_human",
  "dependency_incomplete",
  "environment_unavailable",
  "policy_denial",
  "external_dependency_unavailable",
  "unresolved_finding",
] as const;
export type BlockerReason = (typeof BLOCKER_REASONS)[number];

export interface BlockerPayload {
  reason?: BlockerReason;
  detail?: string;
  /** Present only on an UNBLOCK message — must `replyToMessageId` the original blocker. */
  resolved?: boolean;
}

export interface ValidateBlockerInput {
  message: Pick<MissionMessage, "replyToMessageId">;
  payload: BlockerPayload;
  priorMessages: readonly MissionMessage[];
}

export function validateBlockerPayload(input: ValidateBlockerInput): ProtocolValidationResult {
  if (input.payload.resolved === true) {
    if (!input.message.replyToMessageId) return { ok: false, violation: { code: "blocker_unblock_missing_reference" } };
    const original = input.priorMessages.find((m) => m.id === input.message.replyToMessageId);
    if (!original || original.type !== "blocker") return { ok: false, violation: { code: "blocker_unblock_wrong_reference", blockerMessageId: input.message.replyToMessageId } };
    const alreadyResolved = input.priorMessages.some((m) => m.type === "blocker" && m.replyToMessageId === input.message.replyToMessageId && m.structuredPayload?.resolved === true);
    if (alreadyResolved) return { ok: false, violation: { code: "blocker_already_resolved", blockerMessageId: input.message.replyToMessageId } };
    return { ok: true };
  }
  if (!input.payload.reason) return { ok: false, violation: { code: "blocker_missing_reason" } };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// evidence_notice
// ---------------------------------------------------------------------------

// Moved to mission-domain.ts (Phase 4D Part 4) — evidence KIND is a domain
// concept, reused now by MissionEvidenceRecord, not a message-protocol-only
// one. Re-exported here so no existing import site needed to change.
export { EVIDENCE_NOTICE_KINDS, type EvidenceNoticeKind } from "./mission-domain";
import type { EvidenceNoticeKind } from "./mission-domain";

export interface EvidenceNoticePayload {
  evidenceKind?: EvidenceNoticeKind;
}

export interface ValidateEvidenceNoticeInput {
  message: Pick<MissionMessage, "assignmentId" | "evidenceRefs">;
  /**
   * Phase 4D Part 4: real evidence records (`MissionProjection.evidenceRecords`),
   * NOT the flat `attachedEvidenceIds` string array Phase 1 left behind —
   * that array has no assignment association at all, making
   * "evidence belongs to the referenced assignment" impossible to check.
   * Keyed by evidenceId, scoped to this Mission by construction (the
   * projection itself only ever holds this Mission's own records).
   */
  evidenceRecords: Record<string, import("./mission-domain").MissionEvidenceRecord>;
}

/** Never treats presence as proof of correctness — this only checks the reference is well-formed, known, belongs to the cited assignment, and is not superseded — never that the underlying evidence PASSED anything. */
export function validateEvidenceNoticePayload(input: ValidateEvidenceNoticeInput): ProtocolValidationResult {
  if (!input.message.assignmentId) return { ok: false, violation: { code: "evidence_notice_missing_assignment" } };
  if (input.message.evidenceRefs.length === 0) return { ok: false, violation: { code: "evidence_notice_missing_evidence_refs" } };
  for (const evidenceId of input.message.evidenceRefs) {
    const record = input.evidenceRecords[evidenceId];
    if (!record) return { ok: false, violation: { code: "evidence_notice_unknown_evidence_ref", evidenceId } };
    if (record.assignmentId !== null && record.assignmentId !== input.message.assignmentId) {
      return { ok: false, violation: { code: "evidence_wrong_assignment", evidenceId, expectedAssignmentId: input.message.assignmentId, actualAssignmentId: record.assignmentId } };
    }
    if (record.supersededByEvidenceId !== null) {
      return { ok: false, violation: { code: "evidence_superseded", evidenceId, supersededByEvidenceId: record.supersededByEvidenceId } };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// approval_request — informational only; the actual grant/denial is always
// the existing typed Mission command (AcceptAssignment/RejectAssignment/
// TransitionFinding), never a second "approval_response" message type this
// phase would have to invent. See mission-command-handler.ts's new
// human_required authorization gate on those commands.
// ---------------------------------------------------------------------------

export const APPROVAL_SUBJECTS = ["assignment_acceptance", "scope_expansion", "permission", "delegation", "finding_resolution"] as const;
export type ApprovalSubject = (typeof APPROVAL_SUBJECTS)[number];

export interface ApprovalRequestPayload {
  subject?: ApprovalSubject;
  assignmentId?: string;
  findingId?: string;
}

export interface ValidateApprovalRequestInput {
  payload: ApprovalRequestPayload;
  /** Every message already in the projection — used only to detect an outstanding, unanswered prior approval_request for the same (subject, reference), mirroring `validateReviewRequestPayload`'s duplicate check. */
  priorMessages: readonly MissionMessage[];
}

/**
 * "Duplicate" is judged the same narrow, cheap way `validateReviewRequestPayload`
 * does: an already-OUTSTANDING `approval_request` for the same subject and
 * reference (assignmentId or findingId, whichever the subject uses) may not
 * receive a second one. OUTSTANDING = no reply yet resolved it via
 * `structuredPayload.resolution === "approved" | "rejected"` — see that
 * function's doc comment for why a non-resolving commentary reply does not
 * count.
 */
export function validateApprovalRequestPayload(input: ValidateApprovalRequestInput): ProtocolValidationResult {
  const { payload, priorMessages } = input;
  if (!payload.subject) return { ok: false, violation: { code: "approval_request_missing_subject" } };
  const usesAssignmentReference = payload.subject === "assignment_acceptance" || payload.subject === "scope_expansion" || payload.subject === "delegation";
  if (usesAssignmentReference && !payload.assignmentId) {
    return { ok: false, violation: { code: "approval_request_missing_reference", subject: payload.subject } };
  }
  if (payload.subject === "finding_resolution" && !payload.findingId) {
    return { ok: false, violation: { code: "approval_request_missing_reference", subject: payload.subject } };
  }

  const reference = usesAssignmentReference ? payload.assignmentId! : payload.findingId!;
  const resolvedIds = new Set(
    priorMessages
      .filter((m) => m.replyToMessageId && (m.structuredPayload?.resolution === "approved" || m.structuredPayload?.resolution === "rejected"))
      .map((m) => m.replyToMessageId as string),
  );
  const outstanding = priorMessages.some((m) => {
    if (m.type !== "approval_request" || resolvedIds.has(m.id)) return false;
    const priorPayload = m.structuredPayload as ApprovalRequestPayload | undefined;
    if (!priorPayload || priorPayload.subject !== payload.subject) return false;
    const priorReference = usesAssignmentReference ? priorPayload.assignmentId : priorPayload.findingId;
    return priorReference === reference;
  });
  if (outstanding) return { ok: false, violation: { code: "approval_request_duplicate", subject: payload.subject, reference } };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// completion_notice
// ---------------------------------------------------------------------------

export interface CompletionNoticePayload {
  dispatchKey?: string | null;
}

export interface ValidateCompletionNoticeInput {
  message: Pick<MissionMessage, "assignmentId" | "evidenceRefs">;
  assignment: MissionAssignment | null;
  assignments: Record<AssignmentId, MissionAssignment>;
  /**
   * Phase 4D Part 4: real evidence records, checked additively alongside
   * the pre-existing `requiredEvidence` category-string match below.
   * `MissionAssignment.requiredEvidence` holds CATEGORY strings (e.g.
   * `"evidence://diff"`, set at assignment-creation time — see
   * mission-planner-templates.ts), not record ids, so an exact-string
   * match against them is preserved unchanged. For any `evidenceRefs` entry
   * that DOES resolve to a real recorded evidenceId, that record must
   * belong to THIS assignment and must not be superseded — closing the
   * "arbitrary/wrong-assignment/superseded evidence id" gap without
   * disturbing the existing category-matching contract.
   */
  evidenceRecords: Record<string, import("./mission-domain").MissionEvidenceRecord>;
}

export function validateCompletionNoticePayload(input: ValidateCompletionNoticeInput): ProtocolValidationResult {
  if (!input.assignment) return { ok: false, violation: { code: "completion_notice_missing_assignment" } };
  // Idempotent duplicate handling: a completion_notice for an assignment
  // already past "running" is not an ERROR (a real duplicate must not
  // fail loudly) — the command handler treats this as message-only,
  // informational, no resulting command. Only "running" is checked HERE
  // as the state that actually needs the required-evidence/dependency
  // gates enforced before submission.
  if (input.assignment.status !== "running") return { ok: true };

  const missing = input.assignment.requiredEvidence.filter((ref) => !input.message.evidenceRefs.includes(ref));
  if (missing.length > 0) return { ok: false, violation: { code: "completion_notice_missing_required_evidence", missing } };

  for (const ref of input.message.evidenceRefs) {
    const record = input.evidenceRecords[ref];
    if (!record) continue; // not a recorded evidenceId — a category string, unchanged from the check above
    if (record.assignmentId !== null && record.assignmentId !== input.assignment.id) {
      return { ok: false, violation: { code: "evidence_wrong_assignment", evidenceId: ref, expectedAssignmentId: input.assignment.id, actualAssignmentId: record.assignmentId } };
    }
    if (record.supersededByEvidenceId !== null) {
      return { ok: false, violation: { code: "evidence_superseded", evidenceId: ref, supersededByEvidenceId: record.supersededByEvidenceId } };
    }
  }

  const dependencyCheck = checkDependenciesSatisfied(input.assignment, input.assignments);
  if (!dependencyCheck.ok) return { ok: false, violation: { code: "completion_notice_dependencies_incomplete", unsatisfied: dependencyCheck.unsatisfied } };

  return { ok: true };
}
