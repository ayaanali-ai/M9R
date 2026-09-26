import assert from "node:assert/strict";
import test from "node:test";
import { checkRoomLitmus } from "../src/lib/mission/room-litmus-core";

const targetA = { pageGroupId: "pg-shared", origin: "https://shop.example", path: "/item/1", tabRef: "tab-a" };
const targetB = { ...targetA, tabRef: "tab-b" };
const base = {
  schema: "m9r.room-log/0",
  roomId: "room-1",
  traceCoverage: "complete",
  pageGroups: [{ pageGroupId: "pg-shared", origin: "https://shop.example", path: "/item/1", ownerConfirmed: true, members: [{ actorId: "agent-a", tabRef: "tab-a" }, { actorId: "agent-b", tabRef: "tab-b" }] }],
  events: [
    { eventId: "a1", roomId: "room-1", sequence: 1, actorId: "agent-a", actorKind: "agent", type: "agent.action", target: targetA, dependsOn: [] },
    { eventId: "ask-1", roomId: "room-1", sequence: 2, actorId: "agent-a", actorKind: "agent", type: "agent.ask", recipientActorId: "agent-b", body: "Which size should I select?" },
    { eventId: "reply-1", roomId: "room-1", sequence: 3, actorId: "agent-b", actorKind: "agent", type: "agent.reply", replyTo: "ask-1", body: "Choose medium; the stock row is current." },
    { eventId: "a2", roomId: "room-1", sequence: 4, actorId: "agent-b", actorKind: "agent", type: "agent.action", target: targetB, dependsOn: ["a1", "reply-1"] },
  ],
};

test("room log passes only with a cross-agent causal action, direct agent ask/reply, and same page group", () => {
  const result = checkRoomLitmus(base);
  assert.equal(result.pass, true);
  assert.deepEqual(result.criteria, { dependentAgentAction: true, agentQuestionAnswered: true, noHumanRelay: true, sameSharedPageGroup: true, completeTrace: true });
});

test("independent actions in different page groups fail even if both agents acted", () => {
  const log = structuredClone(base);
  log.events[3]!.target!.pageGroupId = "different-tab-group";
  const result = checkRoomLitmus(log);
  assert.equal(result.pass, false);
  assert.equal(result.criteria.dependentAgentAction, false);
});

test("a human-relayed answer fails the no-human-relay criterion", () => {
  const log = structuredClone(base);
  const events: Array<Record<string, unknown>> = [...log.events];
  events.splice(2, 0, { eventId: "human-1", roomId: "room-1", sequence: 3, actorId: "human-1", actorKind: "human", type: "human.relay", relatedEventId: "ask-1" });
  const relayLog = { ...log, events };
  const result = checkRoomLitmus(relayLog);
  assert.equal(result.pass, false);
  assert.equal(result.criteria.noHumanRelay, false);
});

test("same agent cannot satisfy the between-agents rule by depending on itself", () => {
  const log = structuredClone(base);
  log.events[3]!.actorId = "agent-a";
  const result = checkRoomLitmus(log);
  assert.equal(result.pass, false);
  assert.equal(result.criteria.dependentAgentAction, false);
});

test("incomplete message-only exports fail closed instead of implying a multiplayer proof", () => {
  const log = { ...base, traceCoverage: "messages-only" };
  const result = checkRoomLitmus(log);
  assert.equal(result.pass, false);
  assert.equal(result.criteria.completeTrace, false);
});

test("replayed IDs and malformed or oversized logs are rejected", () => {
  const duplicate = structuredClone(base);
  duplicate.events[3]!.eventId = "a1";
  assert.equal(checkRoomLitmus(duplicate).pass, false);
  const oversized = { ...base, events: Array.from({ length: 10_001 }, (_, index) => ({ eventId: `e-${index}`, roomId: "room-1", sequence: index + 1, actorId: "agent-a", actorKind: "agent", type: "room.message" })) };
  assert.match(checkRoomLitmus(oversized).reasons[0] ?? "", /bounded events list/);
  assert.equal(checkRoomLitmus(null).pass, false);
});
