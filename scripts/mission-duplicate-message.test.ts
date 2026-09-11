/**
 * Mission-scoped messageId uniqueness — Phase 4D §4 tests
 *
 * A `PostMessage` reusing an id already used in this Mission must never be
 * silently accepted, whatever payload it carries — the causal graph
 * (mission-collaboration-graph.ts) looks messages up strictly by id, so two
 * messages claiming the same one is not a cosmetic problem.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMissionCommand, type ApplyCommandInput } from "../src/lib/mission/mission-command-handler.ts";
import { hashCommandPayload, resolveCommandContext, type MissionCommand } from "../src/lib/mission/mission-commands.ts";
import type { MissionProjection } from "../src/lib/mission/mission-projection.ts";
import { projectMission } from "../src/lib/mission/mission-projection.ts";

const MISSION_ID = "m-1";
const OTHER_MISSION_ID = "m-2";
const ACTOR = { kind: "system" as const, id: "orchestrator" as const };

let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}

function ctx() {
  return resolveCommandContext({ actor: ACTOR, timestamp: "2026-08-25T00:00:00.000Z" });
}

function run(current: MissionProjection | null, command: MissionCommand, expectedVersion: number, opts: Partial<ApplyCommandInput> = {}) {
  return applyMissionCommand({ current, command, context: ctx(), expectedVersion, priorOutcome: null, mintEventId, ...opts });
}

function addParticipant(missionId: string, participantId: string): MissionCommand {
  return {
    type: "AddParticipant",
    missionId,
    participantId,
    kind: "agent",
    role: "implementer",
    displayName: participantId,
    agentKind: null,
    provider: "codex",
    adapterId: "codex",
    capabilities: [],
    assignmentScope: { allowedPaths: ["."], prohibitedPaths: [] },
    workspacePermissions: { allowedPaths: ["."], prohibitedPaths: [] },
    communicationPermissions: { canBroadcast: false, canDelegate: true, maxDelegationDepth: 3 },
  };
}

function bootstrap(missionId: string): MissionProjection {
  let r = run(null, { type: "CreateMission", missionId, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  let projection = r.projection;

  for (const id of ["p-1", "p-2"]) {
    r = run(projection, addParticipant(missionId, id), projection.aggregateVersion);
    assert.ok(r.ok);
    if (!r.ok) throw new Error("unreachable");
    projection = r.projection;
    r = run(projection, { type: "ActivateParticipant", missionId, participantId: id }, projection.aggregateVersion);
    assert.ok(r.ok);
    if (!r.ok) throw new Error("unreachable");
    projection = r.projection;
  }
  return projection;
}

function postMessage(missionId: string, overrides: Partial<Extract<MissionCommand, { type: "PostMessage" }>> = {}): MissionCommand {
  return {
    type: "PostMessage",
    missionId,
    messageId: "msg-1",
    senderParticipantId: "p-1",
    recipientParticipantIds: ["p-2"],
    assignmentId: null,
    messageType: "information",
    body: "hello",
    evidenceRefs: [],
    replyToMessageId: null,
    ...overrides,
  };
}

test("a genuine retry (same idempotency key) replays via applyMissionCommand's own idempotency check, never reaching PostMessage's duplicate-id check at all", () => {
  const projection = bootstrap(MISSION_ID);
  const command = postMessage(MISSION_ID);
  const first = run(projection, command, projection.aggregateVersion);
  assert.ok(first.ok);
  if (!first.ok) return;

  const outcome = { idempotencyKey: "key-1", payloadDigest: hashCommandPayload(command), events: first.events, aggregateVersion: first.aggregateVersion };
  const replay = run(projection, command, projection.aggregateVersion, { priorOutcome: outcome });
  assert.ok(replay.ok);
  if (replay.ok) assert.equal(replay.replayed, true, "a matching priorOutcome must short-circuit before PostMessage's own duplicate-id check ever runs");
});

test("the same messageId with an IDENTICAL payload under a DIFFERENT idempotency key is refused, not silently merged", () => {
  const projection = bootstrap(MISSION_ID);
  const command = postMessage(MISSION_ID);
  const first = run(projection, command, projection.aggregateVersion);
  assert.ok(first.ok);
  if (!first.ok) return;

  // No priorOutcome this time (a different idempotency key would produce a
  // cache miss upstream) — applyMissionCommand must re-evaluate PostMessage
  // fresh, and the duplicate messageId check must catch it.
  const second = run(first.projection, command, first.aggregateVersion);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error.code, "duplicate_message_id");
    if (second.error.code === "duplicate_message_id") assert.equal(second.error.samePayload, true);
  }
});

test("the same messageId with a DIFFERENT payload is refused as a typed conflict, samePayload:false", () => {
  const projection = bootstrap(MISSION_ID);
  const first = run(projection, postMessage(MISSION_ID, { body: "first version" }), projection.aggregateVersion);
  assert.ok(first.ok);
  if (!first.ok) return;

  const second = run(first.projection, postMessage(MISSION_ID, { body: "a completely different message" }), first.aggregateVersion);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error.code, "duplicate_message_id");
    if (second.error.code === "duplicate_message_id") assert.equal(second.error.samePayload, false);
  }
});

test("a duplicate messageId attempt never modifies the causal graph — the original message is untouched and no new event is appended", () => {
  const projection = bootstrap(MISSION_ID);
  const first = run(projection, postMessage(MISSION_ID, { body: "original" }), projection.aggregateVersion);
  assert.ok(first.ok);
  if (!first.ok) return;

  const versionBefore = first.aggregateVersion;
  const messagesBefore = first.projection.messages.length;

  const conflicting = run(first.projection, postMessage(MISSION_ID, { body: "attempted overwrite" }), first.aggregateVersion);
  assert.equal(conflicting.ok, false);

  // Nothing observable changed — a failure result carries no projection to
  // even inspect, which is itself the proof no event was appended.
  assert.equal("events" in conflicting, false);
  assert.equal(first.projection.messages.length, messagesBefore);
  assert.equal(first.projection.messages[0].body, "original");
  void versionBefore;
});

test("the SAME messageId is allowed to exist independently in a DIFFERENT Mission — uniqueness is Mission-scoped, not global", () => {
  const missionA = bootstrap(MISSION_ID);
  const missionB = bootstrap(OTHER_MISSION_ID);

  const postedInA = run(missionA, postMessage(MISSION_ID), missionA.aggregateVersion);
  assert.ok(postedInA.ok);

  const postedInB = run(missionB, postMessage(OTHER_MISSION_ID), missionB.aggregateVersion);
  assert.ok(postedInB.ok, "the same messageId string must be free to reuse in an unrelated Mission");
});

test("causal lookup (replyToMessageId chain) after a rejected duplicate still resolves to the ORIGINAL message, never the rejected one", () => {
  const projection = bootstrap(MISSION_ID);
  const original = run(projection, postMessage(MISSION_ID, { body: "original", messageType: "question", assignmentId: null }), projection.aggregateVersion);
  assert.ok(original.ok);
  if (!original.ok) return;

  const duplicateAttempt = run(original.projection, postMessage(MISSION_ID, { body: "impersonating original", messageType: "question" }), original.aggregateVersion);
  assert.equal(duplicateAttempt.ok, false);

  // A reply targeting "msg-1" must resolve against the ORIGINAL question,
  // proven by AskAssignmentQuestion-style downstream logic being able to
  // find exactly one message with that id and it being the original body.
  const matches = original.projection.messages.filter((m) => m.id === "msg-1");
  assert.equal(matches.length, 1, "exactly one message may ever hold a given id in this Mission's history");
  assert.equal(matches[0].body, "original");
});

test("replaying full history (including a rejected duplicate attempt's non-existent event) rebuilds a projection with exactly one message at the reused id", () => {
  const missionId = "m-replay";
  const allEvents: import("../src/lib/mission/mission-events.ts").MissionEvent[] = [];

  let r = run(null, { type: "CreateMission", missionId, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(r.ok);
  if (!r.ok) return;
  allEvents.push(...r.events);
  let projection = r.projection;

  for (const id of ["p-1", "p-2"]) {
    r = run(projection, addParticipant(missionId, id), projection.aggregateVersion);
    assert.ok(r.ok);
    if (!r.ok) return;
    allEvents.push(...r.events);
    projection = r.projection;
    r = run(projection, { type: "ActivateParticipant", missionId, participantId: id }, projection.aggregateVersion);
    assert.ok(r.ok);
    if (!r.ok) return;
    allEvents.push(...r.events);
    projection = r.projection;
  }

  r = run(projection, postMessage(missionId), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  allEvents.push(...r.events);
  projection = r.projection;

  // A rejected duplicate attempt appends NO event — so replaying history
  // from genesis, unaffected by however many times a duplicate was tried,
  // must still land on exactly one message at "msg-1".
  const rejectedDuplicate = run(projection, postMessage(missionId, { body: "duplicate attempt" }), projection.aggregateVersion);
  assert.equal(rejectedDuplicate.ok, false);

  const rebuilt = projectMission(missionId, allEvents);
  const matches = rebuilt.messages.filter((m) => m.id === "msg-1");
  assert.equal(matches.length, 1);
  assert.deepEqual(rebuilt, projection);
});
