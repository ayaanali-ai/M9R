/**
 * Mission projection bounds — Phase 4B
 *
 * Proves the live projection's message window is capped (not unbounded, the
 * limitation Phase 4A's notes flagged), that the authoritative event history
 * is never truncated (only the summary view is), and that cursor-based
 * pagination over the raw event stream correctly recovers full history.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MAX_PROJECTION_MESSAGES, projectMission, queryMissionMessages } from "../src/lib/mission/mission-projection.ts";
import { createMissionEvent, type MissionEvent } from "../src/lib/mission/mission-events.ts";

const MISSION_ID = "m-1";

function messageEvent(sequence: number, aggregateVersion: number): MissionEvent {
  return createMissionEvent({
    eventId: `evt-${sequence}`,
    missionId: MISSION_ID,
    aggregateVersion,
    actor: { kind: "system", id: "orchestrator" },
    correlationId: `corr-${sequence}`,
    causationId: null,
    timestamp: `2026-08-05T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
    provenance: "system_inference",
    payload: {
      type: "mission.message_posted",
      message: {
        id: `msg-${sequence}`,
        missionId: MISSION_ID,
        senderParticipantId: "p-1",
        recipientParticipantIds: ["p-2"],
        assignmentId: null,
        type: "information",
        body: `message ${sequence}`,
        evidenceRefs: [],
        correlationId: `corr-${sequence}`,
        causationId: null,
        replyToMessageId: null,
        createdAt: `2026-08-05T00:00:00.000Z`,
        structuredPayload: {},
      },
    },
  });
}

function manyMessageEvents(count: number): MissionEvent[] {
  return Array.from({ length: count }, (_, i) => messageEvent(i + 1, i + 1));
}

test("the live projection's messages array is capped at MAX_PROJECTION_MESSAGES, dropping the oldest first", () => {
  const events = manyMessageEvents(MAX_PROJECTION_MESSAGES + 50);
  const projection = projectMission(MISSION_ID, events);
  assert.equal(projection.messages.length, MAX_PROJECTION_MESSAGES);
  assert.equal(projection.messages[0].id, `msg-51`, "the oldest 50 must have been dropped from the live window");
  assert.equal(projection.messages[projection.messages.length - 1].id, `msg-${MAX_PROJECTION_MESSAGES + 50}`);
});

test("the authoritative event history is NOT truncated — queryMissionMessages recovers messages the bounded projection already dropped", () => {
  const events = manyMessageEvents(MAX_PROJECTION_MESSAGES + 50);
  const projection = projectMission(MISSION_ID, events);
  assert.ok(!projection.messages.some((m) => m.id === "msg-1"), "the live projection no longer carries the very first message");

  const firstPage = queryMissionMessages(events, { limit: 10 });
  assert.equal(firstPage.messages.length, 10);
  assert.equal(firstPage.messages[0].id, "msg-1", "the raw event stream still has it — nothing was deleted, only excluded from the summary view");
});

test("queryMissionMessages paginates deterministically across the full stream with no gaps or duplicates", () => {
  const total = 25;
  const events = manyMessageEvents(total);
  const seen: string[] = [];
  let cursor: number | null = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = queryMissionMessages(events, { cursor, limit: 7 });
    seen.push(...page.messages.map((m) => m.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, total);
  assert.deepEqual(seen, Array.from({ length: total }, (_, i) => `msg-${i + 1}`), "pagination must reconstruct the exact original order with no gaps or repeats");
});

test("queryMissionMessages returns no next cursor once every message has been read", () => {
  const events = manyMessageEvents(5);
  const page = queryMissionMessages(events, { limit: 100 });
  assert.equal(page.messages.length, 5);
  assert.equal(page.nextCursor, null);
});

test("deterministic rebuild: replaying the same event stream twice produces byte-identical bounded projections", () => {
  const events = manyMessageEvents(MAX_PROJECTION_MESSAGES + 10);
  const first = projectMission(MISSION_ID, events);
  const second = projectMission(MISSION_ID, events);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// Exact boundary behavior at 199 / 200 / 201 messages (Phase 4C)
// ---------------------------------------------------------------------------

test("at exactly 199 messages (one under the cap), nothing is dropped", () => {
  const projection = projectMission(MISSION_ID, manyMessageEvents(MAX_PROJECTION_MESSAGES - 1));
  assert.equal(projection.messages.length, MAX_PROJECTION_MESSAGES - 1);
  assert.equal(projection.messages[0].id, "msg-1");
});

test("at exactly 200 messages (exactly the cap), nothing is dropped yet", () => {
  const projection = projectMission(MISSION_ID, manyMessageEvents(MAX_PROJECTION_MESSAGES));
  assert.equal(projection.messages.length, MAX_PROJECTION_MESSAGES);
  assert.equal(projection.messages[0].id, "msg-1", "the 200th message must not have evicted the 1st");
});

test("at exactly 201 messages (one over the cap), exactly the oldest one is dropped", () => {
  const projection = projectMission(MISSION_ID, manyMessageEvents(MAX_PROJECTION_MESSAGES + 1));
  assert.equal(projection.messages.length, MAX_PROJECTION_MESSAGES);
  assert.equal(projection.messages[0].id, "msg-2", "msg-1 must be the ONLY one dropped");
  assert.equal(projection.messages[projection.messages.length - 1].id, `msg-${MAX_PROJECTION_MESSAGES + 1}`);
});
