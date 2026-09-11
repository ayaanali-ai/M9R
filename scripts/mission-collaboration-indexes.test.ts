/**
 * Active collaboration indexes beyond the 200-message window — Phase 4D
 * Part 3 §7.
 *
 * The bounded `messages` projection (MAX_PROJECTION_MESSAGES = 200) is fine
 * for "what's happening now," but it must never be the ONLY place an
 * outstanding obligation is discoverable — a question doesn't stop being
 * unanswered just because 200 later messages arrived. These tests prove
 * `unansweredQuestionMessageIds`/`unresolvedBlockerMessageIds`/
 * `pendingReviewRequestMessageIds`/`pendingApprovalRequestMessageIds`/
 * `pendingDelegationRequestMessageIds` stay correct at 199, 200, 201, and
 * well beyond 200 later messages, and that resolving an item removes it
 * from the index regardless of window position.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MAX_PROJECTION_MESSAGES, projectMission } from "../src/lib/mission/mission-projection.ts";
import { createMissionEvent, type MissionEvent } from "../src/lib/mission/mission-events.ts";
import type { MissionMessage } from "../src/lib/mission/mission-domain.ts";

const MISSION_ID = "m-1";
let seq = 0;

function messageEvent(overrides: Partial<MissionMessage> & { type: MissionMessage["type"] }): MissionEvent {
  seq += 1;
  const message: MissionMessage = {
    id: `msg-${seq}`,
    missionId: MISSION_ID,
    senderParticipantId: "p-1",
    recipientParticipantIds: ["p-2"],
    assignmentId: null,
    body: `message ${seq}`,
    evidenceRefs: [],
    correlationId: `corr-${seq}`,
    causationId: null,
    replyToMessageId: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    structuredPayload: {},
    ...overrides,
  };
  return createMissionEvent({
    eventId: `evt-${seq}`,
    missionId: MISSION_ID,
    aggregateVersion: seq,
    actor: { kind: "system", id: "orchestrator" },
    correlationId: message.correlationId,
    causationId: null,
    timestamp: "2026-08-05T00:00:00.000Z",
    provenance: "system_inference",
    payload: { type: "mission.message_posted", message },
  });
}

function fillerMessages(count: number): MissionEvent[] {
  return Array.from({ length: count }, () => messageEvent({ type: "information" }));
}

test("an unanswered question remains in the index after exactly 199 later messages (still inside the bounded window)", () => {
  seq = 0;
  const events = [messageEvent({ type: "question" }), ...fillerMessages(199)];
  const projection = projectMission(MISSION_ID, events);
  assert.deepEqual(projection.unansweredQuestionMessageIds, ["msg-1"]);
});

test("an unanswered question remains in the index after exactly 200 later messages (right at the window boundary)", () => {
  seq = 0;
  const events = [messageEvent({ type: "question" }), ...fillerMessages(200)];
  const projection = projectMission(MISSION_ID, events);
  assert.deepEqual(projection.unansweredQuestionMessageIds, ["msg-1"]);
  assert.equal(projection.messages.some((m) => m.id === "msg-1"), false, "the question message ITSELF has already been dropped from the bounded window");
});

test("an unanswered question remains in the index after 201 later messages (one past the boundary)", () => {
  seq = 0;
  const events = [messageEvent({ type: "question" }), ...fillerMessages(201)];
  const projection = projectMission(MISSION_ID, events);
  assert.deepEqual(projection.unansweredQuestionMessageIds, ["msg-1"]);
});

test("an unanswered question remains discoverable well beyond 200 later messages (500 later)", () => {
  seq = 0;
  const events = [messageEvent({ type: "question" }), ...fillerMessages(500)];
  const projection = projectMission(MISSION_ID, events);
  assert.deepEqual(projection.unansweredQuestionMessageIds, ["msg-1"]);
  assert.equal(projection.messages.length, MAX_PROJECTION_MESSAGES, "the bounded window itself stays capped");
});

test("answering a question removes it from the index, however far outside the bounded window the original question now sits", () => {
  seq = 0;
  const questionEvent = messageEvent({ type: "question" });
  const filler = fillerMessages(300);
  const answerEvent = messageEvent({ type: "answer", replyToMessageId: "msg-1" });
  const projection = projectMission(MISSION_ID, [questionEvent, ...filler, answerEvent]);
  assert.deepEqual(projection.unansweredQuestionMessageIds, []);
});

test("a NEW unresolved blocker stays in the index across the 200-message boundary until explicitly resolved", () => {
  seq = 0;
  const blockerEvent = messageEvent({ type: "blocker", structuredPayload: { reason: "dependency_incomplete" } });
  const filler = fillerMessages(250);
  const projection = projectMission(MISSION_ID, [blockerEvent, ...filler]);
  assert.deepEqual(projection.unresolvedBlockerMessageIds, ["msg-1"]);
});

test("resolving a blocker (resolved:true, correctly replyToMessageId-linked) removes it from the index", () => {
  seq = 0;
  const blockerEvent = messageEvent({ type: "blocker", structuredPayload: { reason: "dependency_incomplete" } });
  const filler = fillerMessages(250);
  const unblockEvent = messageEvent({ type: "blocker", replyToMessageId: "msg-1", structuredPayload: { resolved: true } });
  const projection = projectMission(MISSION_ID, [blockerEvent, ...filler, unblockEvent]);
  assert.deepEqual(projection.unresolvedBlockerMessageIds, []);
});

test("a pending review_request stays discoverable past the 200-message window until a RESOLVING reply arrives", () => {
  seq = 0;
  const reviewEvent = messageEvent({ type: "review_request", structuredPayload: { reviewerParticipantIds: ["p-2"] } });
  const filler = fillerMessages(220);
  const projection = projectMission(MISSION_ID, [reviewEvent, ...filler]);
  assert.deepEqual(projection.pendingReviewRequestMessageIds, ["msg-1"]);

  const replyEvent = messageEvent({ type: "information", replyToMessageId: "msg-1", structuredPayload: { resolution: "approved" } });
  const resolved = projectMission(MISSION_ID, [reviewEvent, ...filler, replyEvent]);
  assert.deepEqual(resolved.pendingReviewRequestMessageIds, []);
});

test("a NON-resolving reply (plain commentary, no resolution field) does NOT clear a pending review_request", () => {
  seq = 0;
  const reviewEvent = messageEvent({ type: "review_request", structuredPayload: { reviewerParticipantIds: ["p-2"] } });
  const commentEvent = messageEvent({ type: "information", replyToMessageId: "msg-1" });
  const projection = projectMission(MISSION_ID, [reviewEvent, commentEvent]);
  assert.deepEqual(projection.pendingReviewRequestMessageIds, ["msg-1"], "a reply that doesn't explicitly resolve the request must not silently clear it");
});

test("an explicit resolution: 'comment' reply does NOT clear a pending review_request either", () => {
  seq = 0;
  const reviewEvent = messageEvent({ type: "review_request", structuredPayload: { reviewerParticipantIds: ["p-2"] } });
  const commentEvent = messageEvent({ type: "information", replyToMessageId: "msg-1", structuredPayload: { resolution: "comment" } });
  const projection = projectMission(MISSION_ID, [reviewEvent, commentEvent]);
  assert.deepEqual(projection.pendingReviewRequestMessageIds, ["msg-1"]);
});

test("a pending approval_request stays discoverable past the 200-message window until a RESOLVING reply arrives", () => {
  seq = 0;
  const approvalEvent = messageEvent({ type: "approval_request", structuredPayload: { subject: "permission" } });
  const filler = fillerMessages(220);
  const projection = projectMission(MISSION_ID, [approvalEvent, ...filler]);
  assert.deepEqual(projection.pendingApprovalRequestMessageIds, ["msg-1"]);

  const replyEvent = messageEvent({ type: "information", replyToMessageId: "msg-1", structuredPayload: { resolution: "rejected" } });
  const resolved = projectMission(MISSION_ID, [approvalEvent, ...filler, replyEvent]);
  assert.deepEqual(resolved.pendingApprovalRequestMessageIds, []);
});

test("a NON-resolving reply does NOT clear a pending approval_request", () => {
  seq = 0;
  const approvalEvent = messageEvent({ type: "approval_request", structuredPayload: { subject: "permission" } });
  const commentEvent = messageEvent({ type: "information", replyToMessageId: "msg-1" });
  const projection = projectMission(MISSION_ID, [approvalEvent, commentEvent]);
  assert.deepEqual(projection.pendingApprovalRequestMessageIds, ["msg-1"]);
});

test("a pending delegation_request stays discoverable past the 200-message window until a delegation_response arrives", () => {
  seq = 0;
  const requestEvent = messageEvent({ type: "delegation_request" });
  const filler = fillerMessages(220);
  const projectionBefore = projectMission(MISSION_ID, [requestEvent, ...filler]);
  assert.deepEqual(projectionBefore.pendingDelegationRequestMessageIds, ["msg-1"]);

  const responseEvent = messageEvent({ type: "delegation_response", replyToMessageId: "msg-1", structuredPayload: { accepted: true } });
  const projectionAfter = projectMission(MISSION_ID, [requestEvent, ...filler, responseEvent]);
  assert.deepEqual(projectionAfter.pendingDelegationRequestMessageIds, []);
});

test("deterministic replay: rebuilding the same event stream twice produces identical indexes", () => {
  seq = 0;
  const events = [
    messageEvent({ type: "question" }),
    messageEvent({ type: "blocker", structuredPayload: { reason: "waiting_for_human" } }),
    ...fillerMessages(210),
    messageEvent({ type: "answer", replyToMessageId: "msg-1" }),
  ];
  const first = projectMission(MISSION_ID, events);
  const second = projectMission(MISSION_ID, events);
  assert.deepEqual(first, second);
});

test("the authoritative message history is never truncated by these indexes — only the bounded live summary is capped", () => {
  seq = 0;
  const events = [messageEvent({ type: "question" }), ...fillerMessages(300)];
  const projection = projectMission(MISSION_ID, events);
  // The index survives; the bounded summary does not retain the original
  // message — that split is the entire point (see queryMissionMessages for
  // full-history retrieval, exercised in mission-projection-bounds.test.ts).
  assert.deepEqual(projection.unansweredQuestionMessageIds, ["msg-1"]);
  assert.equal(projection.messages.length, MAX_PROJECTION_MESSAGES);
});
