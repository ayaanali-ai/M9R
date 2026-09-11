/**
 * Mission collaboration protocol — Phase 4C typed-schema tests
 *
 * Pure validator tests for the five message types Phase 4B left generic:
 * review_request, blocker, evidence_notice, approval_request,
 * completion_notice.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  validateApprovalRequestPayload,
  validateBlockerPayload,
  validateCompletionNoticePayload,
  validateEvidenceNoticePayload,
  validateReviewRequestPayload,
} from "../src/lib/mission/mission-collaboration-protocol.ts";
import type { MissionAssignment, MissionEvidenceRecord, MissionMessage } from "../src/lib/mission/mission-domain.ts";

function evidenceRecord(id: string, overrides: Partial<MissionEvidenceRecord> = {}): MissionEvidenceRecord {
  return {
    id,
    missionId: "m-1",
    assignmentId: "a-1",
    producerParticipantId: "p-1",
    producerKind: "agent",
    executionId: null,
    dispatchKey: null,
    provider: null,
    kind: "test_result",
    source: "test",
    lifecycle: "attached",
    availability: "available",
    integrity: null,
    supersededByEvidenceId: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

function evidenceRecords(...records: MissionEvidenceRecord[]): Record<string, MissionEvidenceRecord> {
  return Object.fromEntries(records.map((r) => [r.id, r]));
}

function assignment(overrides: Partial<MissionAssignment> = {}): MissionAssignment {
  return {
    id: "a-1",
    missionId: "m-1",
    assigneeParticipantId: "p-1",
    title: "t",
    objective: "o",
    scope: { allowedPaths: ["."], prohibitedPaths: [] },
    dependencies: [],
    requiredEvidence: [],
    approvalPolicy: "auto",
    budget: { maxDurationMs: null, maxEstimatedTokens: null },
    status: "submitted",
    reviewerParticipantIds: [],
    dispatchKey: null,
    parentAssignmentId: null,
    originatingMessageId: null,
    delegatorParticipantId: null,
    delegationDepth: 0,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function message(overrides: Partial<MissionMessage> = {}): MissionMessage {
  return {
    id: "m-1",
    missionId: "mission-1",
    senderParticipantId: "p-1",
    recipientParticipantIds: ["p-2"],
    assignmentId: "a-1",
    type: "review_request",
    body: "",
    evidenceRefs: [],
    correlationId: "corr-1",
    causationId: null,
    replyToMessageId: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    structuredPayload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// review_request
// ---------------------------------------------------------------------------

test("review_request: a valid request against a submitted assignment with an active, non-self reviewer is accepted", () => {
  const result = validateReviewRequestPayload({
    message: { senderParticipantId: "p-1", assignmentId: "a-1" },
    payload: { reviewerParticipantIds: ["p-2"] },
    assignment: assignment(),
    participants: { "p-2": { status: "active" } },
    allowSelfReview: false,
    priorMessages: [],
  });
  assert.equal(result.ok, true);
});

test("review_request: assignment not submitted is rejected", () => {
  const result = validateReviewRequestPayload({
    message: { senderParticipantId: "p-1", assignmentId: "a-1" },
    payload: { reviewerParticipantIds: ["p-2"] },
    assignment: assignment({ status: "running" }),
    participants: { "p-2": { status: "active" } },
    allowSelfReview: false,
    priorMessages: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "review_request_assignment_not_submitted");
});

test("review_request: self-review is rejected when policy disallows it", () => {
  const result = validateReviewRequestPayload({
    message: { senderParticipantId: "p-1", assignmentId: "a-1" },
    payload: { reviewerParticipantIds: ["p-1"] },
    assignment: assignment(),
    participants: { "p-1": { status: "active" } },
    allowSelfReview: false,
    priorMessages: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "review_request_self_review_disallowed");
});

test("review_request: self-review is accepted when policy explicitly allows it", () => {
  const result = validateReviewRequestPayload({
    message: { senderParticipantId: "p-1", assignmentId: "a-1" },
    payload: { reviewerParticipantIds: ["p-1"] },
    assignment: assignment(),
    participants: { "p-1": { status: "active" } },
    allowSelfReview: true,
    priorMessages: [],
  });
  assert.equal(result.ok, true);
});

test("review_request: an inactive/removed reviewer is rejected", () => {
  const result = validateReviewRequestPayload({
    message: { senderParticipantId: "p-1", assignmentId: "a-1" },
    payload: { reviewerParticipantIds: ["p-2"] },
    assignment: assignment(),
    participants: { "p-2": { status: "removed" } },
    allowSelfReview: false,
    priorMessages: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "review_request_reviewer_not_active");
});

test("review_request: a duplicate (outstanding, unanswered) request for the same assignment is rejected", () => {
  const priorRequest = message({ id: "req-1", type: "review_request" });
  const result = validateReviewRequestPayload({
    message: { senderParticipantId: "p-1", assignmentId: "a-1" },
    payload: { reviewerParticipantIds: ["p-2"] },
    assignment: assignment(),
    participants: { "p-2": { status: "active" } },
    allowSelfReview: false,
    priorMessages: [priorRequest],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "review_request_duplicate");
});

test("review_request: a non-resolving reply (no structuredPayload.resolution) does NOT clear 'outstanding' — a new request is still refused (audit item 2)", () => {
  const priorRequest = message({ id: "req-1", type: "review_request" });
  const reply = message({ id: "finding-1", type: "finding", replyToMessageId: "req-1" });
  const result = validateReviewRequestPayload({
    message: { senderParticipantId: "p-1", assignmentId: "a-1" },
    payload: { reviewerParticipantIds: ["p-2"] },
    assignment: assignment(),
    participants: { "p-2": { status: "active" } },
    allowSelfReview: false,
    priorMessages: [priorRequest, reply],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "review_request_duplicate");
});

test("review_request: a PRIOR request explicitly RESOLVED (structuredPayload.resolution: 'approved') is no longer 'outstanding' — a new request is allowed", () => {
  const priorRequest = message({ id: "req-1", type: "review_request" });
  const reply = message({ id: "finding-1", type: "finding", replyToMessageId: "req-1", structuredPayload: { resolution: "approved" } });
  const result = validateReviewRequestPayload({
    message: { senderParticipantId: "p-1", assignmentId: "a-1" },
    payload: { reviewerParticipantIds: ["p-2"] },
    assignment: assignment(),
    participants: { "p-2": { status: "active" } },
    allowSelfReview: false,
    priorMessages: [priorRequest, reply],
  });
  assert.equal(result.ok, true);
});

test("review_request: no reviewers listed at all is rejected", () => {
  const result = validateReviewRequestPayload({
    message: { senderParticipantId: "p-1", assignmentId: "a-1" },
    payload: { reviewerParticipantIds: [] },
    assignment: assignment(),
    participants: {},
    allowSelfReview: false,
    priorMessages: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "review_request_no_reviewers");
});

// ---------------------------------------------------------------------------
// blocker
// ---------------------------------------------------------------------------

test("blocker: a new blocker requires a reason", () => {
  const result = validateBlockerPayload({ message: { replyToMessageId: null }, payload: {}, priorMessages: [] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "blocker_missing_reason");
});

test("blocker: a new blocker with a reason is accepted", () => {
  const result = validateBlockerPayload({ message: { replyToMessageId: null }, payload: { reason: "waiting_for_human" }, priorMessages: [] });
  assert.equal(result.ok, true);
});

test("blocker: an unblock message must reference the original blocker", () => {
  const result = validateBlockerPayload({ message: { replyToMessageId: null }, payload: { resolved: true }, priorMessages: [] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "blocker_unblock_missing_reference");
});

test("blocker: an unblock message replying to something that isn't a blocker is rejected", () => {
  const notABlocker = message({ id: "info-1", type: "information" });
  const result = validateBlockerPayload({ message: { replyToMessageId: "info-1" }, payload: { resolved: true }, priorMessages: [notABlocker] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "blocker_unblock_wrong_reference");
});

test("blocker: a valid unblock (replying to the real blocker) is accepted", () => {
  const original = message({ id: "block-1", type: "blocker", structuredPayload: { reason: "waiting_for_human" } });
  const result = validateBlockerPayload({ message: { replyToMessageId: "block-1" }, payload: { resolved: true }, priorMessages: [original] });
  assert.equal(result.ok, true);
});

test("blocker: an already-resolved blocker cannot be unblocked a second time", () => {
  const original = message({ id: "block-1", type: "blocker", structuredPayload: { reason: "waiting_for_human" } });
  const firstUnblock = message({ id: "unblock-1", type: "blocker", replyToMessageId: "block-1", structuredPayload: { resolved: true } });
  const result = validateBlockerPayload({ message: { replyToMessageId: "block-1" }, payload: { resolved: true }, priorMessages: [original, firstUnblock] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "blocker_already_resolved");
});

// ---------------------------------------------------------------------------
// evidence_notice
// ---------------------------------------------------------------------------

test("evidence_notice: requires an assignment reference", () => {
  const result = validateEvidenceNoticePayload({ message: { assignmentId: null, evidenceRefs: ["ev-1"] }, evidenceRecords: evidenceRecords(evidenceRecord("ev-1")) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "evidence_notice_missing_assignment");
});

test("evidence_notice: requires at least one evidence reference", () => {
  const result = validateEvidenceNoticePayload({ message: { assignmentId: "a-1", evidenceRefs: [] }, evidenceRecords: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "evidence_notice_missing_evidence_refs");
});

test("evidence_notice: a nonexistent evidence reference is rejected", () => {
  const result = validateEvidenceNoticePayload({ message: { assignmentId: "a-1", evidenceRefs: ["ev-ghost"] }, evidenceRecords: evidenceRecords(evidenceRecord("ev-1")) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "evidence_notice_unknown_evidence_ref");
});

test("evidence_notice: a known evidence reference is accepted", () => {
  const result = validateEvidenceNoticePayload({ message: { assignmentId: "a-1", evidenceRefs: ["ev-1"] }, evidenceRecords: evidenceRecords(evidenceRecord("ev-1"), evidenceRecord("ev-2")) });
  assert.equal(result.ok, true);
});

test("evidence_notice: evidence belonging to a DIFFERENT assignment is rejected", () => {
  const result = validateEvidenceNoticePayload({ message: { assignmentId: "a-1", evidenceRefs: ["ev-1"] }, evidenceRecords: evidenceRecords(evidenceRecord("ev-1", { assignmentId: "a-2" })) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "evidence_wrong_assignment");
});

test("evidence_notice: superseded evidence is rejected", () => {
  const result = validateEvidenceNoticePayload({ message: { assignmentId: "a-1", evidenceRefs: ["ev-1"] }, evidenceRecords: evidenceRecords(evidenceRecord("ev-1", { supersededByEvidenceId: "ev-2" })) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "evidence_superseded");
});

// ---------------------------------------------------------------------------
// approval_request
// ---------------------------------------------------------------------------

test("approval_request: requires a subject", () => {
  const result = validateApprovalRequestPayload({ payload: {}, priorMessages: [] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "approval_request_missing_subject");
});

test("approval_request: assignment_acceptance requires an assignmentId", () => {
  const result = validateApprovalRequestPayload({ payload: { subject: "assignment_acceptance" }, priorMessages: [] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "approval_request_missing_reference");
});

test("approval_request: finding_resolution requires a findingId", () => {
  const result = validateApprovalRequestPayload({ payload: { subject: "finding_resolution" }, priorMessages: [] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "approval_request_missing_reference");
});

test("approval_request: a well-formed request is accepted", () => {
  const result = validateApprovalRequestPayload({ payload: { subject: "assignment_acceptance", assignmentId: "a-1" }, priorMessages: [] });
  assert.equal(result.ok, true);
});

test("approval_request: a second request for the same outstanding subject/reference is refused", () => {
  const priorMessages = [
    { id: "m-1", type: "approval_request" as const, replyToMessageId: null, structuredPayload: { subject: "assignment_acceptance", assignmentId: "a-1" } },
  ] as unknown as import("../src/lib/mission/mission-domain").MissionMessage[];
  const result = validateApprovalRequestPayload({ payload: { subject: "assignment_acceptance", assignmentId: "a-1" }, priorMessages });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "approval_request_duplicate");
});

test("approval_request: a non-resolving reply does NOT clear 'outstanding' — a new request is still refused (audit item 2)", () => {
  const priorMessages = [
    { id: "m-1", type: "approval_request" as const, replyToMessageId: null, structuredPayload: { subject: "assignment_acceptance", assignmentId: "a-1" } },
    { id: "m-2", type: "information" as const, replyToMessageId: "m-1", structuredPayload: {} },
  ] as unknown as import("../src/lib/mission/mission-domain").MissionMessage[];
  const result = validateApprovalRequestPayload({ payload: { subject: "assignment_acceptance", assignmentId: "a-1" }, priorMessages });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "approval_request_duplicate");
});

test("approval_request: a new request is accepted once the prior one has an explicitly RESOLVING reply (structuredPayload.resolution)", () => {
  const priorMessages = [
    { id: "m-1", type: "approval_request" as const, replyToMessageId: null, structuredPayload: { subject: "assignment_acceptance", assignmentId: "a-1" } },
    { id: "m-2", type: "information" as const, replyToMessageId: "m-1", structuredPayload: { resolution: "approved" } },
  ] as unknown as import("../src/lib/mission/mission-domain").MissionMessage[];
  const result = validateApprovalRequestPayload({ payload: { subject: "assignment_acceptance", assignmentId: "a-1" }, priorMessages });
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// completion_notice
// ---------------------------------------------------------------------------

test("completion_notice: requires an assignment reference", () => {
  const result = validateCompletionNoticePayload({ message: { assignmentId: null, evidenceRefs: [] }, assignment: null, assignments: {}, evidenceRecords: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "completion_notice_missing_assignment");
});

test("completion_notice: missing required evidence is rejected", () => {
  const result = validateCompletionNoticePayload({
    message: { assignmentId: "a-1", evidenceRefs: [] },
    assignment: assignment({ status: "running", requiredEvidence: ["evidence://tests"] }),
    assignments: {},
    evidenceRecords: {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.violation.code, "completion_notice_missing_required_evidence");
    if (result.violation.code === "completion_notice_missing_required_evidence") assert.deepEqual(result.violation.missing, ["evidence://tests"]);
  }
});

test("completion_notice: incomplete dependencies are rejected", () => {
  const dep = assignment({ id: "dep-1", status: "running" });
  const result = validateCompletionNoticePayload({
    message: { assignmentId: "a-1", evidenceRefs: [] },
    assignment: assignment({ status: "running", dependencies: ["dep-1"] }),
    assignments: { "dep-1": dep },
    evidenceRecords: {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "completion_notice_dependencies_incomplete");
});

test("completion_notice: a valid notice (evidence present, dependencies accepted) is accepted", () => {
  const dep = assignment({ id: "dep-1", status: "accepted" });
  const result = validateCompletionNoticePayload({
    message: { assignmentId: "a-1", evidenceRefs: ["evidence://tests"] },
    assignment: assignment({ status: "running", requiredEvidence: ["evidence://tests"], dependencies: ["dep-1"] }),
    assignments: { "dep-1": dep },
    evidenceRecords: {},
  });
  assert.equal(result.ok, true);
});

test("completion_notice: a duplicate notice for an assignment already past 'running' is accepted (idempotent, no re-validation of evidence)", () => {
  const result = validateCompletionNoticePayload({
    message: { assignmentId: "a-1", evidenceRefs: [] },
    assignment: assignment({ status: "submitted", requiredEvidence: ["evidence://tests"] }),
    assignments: {},
    evidenceRecords: {},
  });
  assert.equal(result.ok, true);
});
