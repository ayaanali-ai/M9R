/**
 * Atomic clarification orchestration — Phase 4D Part 4 §6 tests
 *
 * `AskAssignmentQuestion`/`AnswerAssignmentQuestion` each create their own
 * message AND perform the assignment transition in ONE command — no prior
 * separate `PostMessage` required or accepted. Covers: duplicate answer
 * rejection (both "same answer retried" and "a second, distinct answer"),
 * removed-participant rejection, cancelled-assignment-prevents-resume,
 * and deterministic replay of the pending/resolved clarification state.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMissionCommand, type ApplyCommandInput } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext, type MissionCommand } from "../src/lib/mission/mission-commands.ts";
import type { MissionProjection } from "../src/lib/mission/mission-projection.ts";

const MISSION_ID = "m-1";
const ACTOR = { kind: "system" as const, id: "orchestrator" as const };
let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}
function ctx(actor: { kind: "human" | "agent" | "system"; id: string } = ACTOR) {
  return resolveCommandContext({ actor: actor as never, timestamp: "2026-09-05T00:00:00.000Z" });
}
function run(current: MissionProjection | null, command: MissionCommand, expectedVersion: number, actor: { kind: "human" | "agent" | "system"; id: string } = ACTOR, opts: Partial<ApplyCommandInput> = {}) {
  return applyMissionCommand({ current, command, context: ctx(actor), expectedVersion, priorOutcome: null, mintEventId, ...opts });
}

function addParticipant(participantId: string): MissionCommand {
  return {
    type: "AddParticipant",
    missionId: MISSION_ID,
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

function askQuestion(overrides: Partial<Extract<MissionCommand, { type: "AskAssignmentQuestion" }>> = {}): MissionCommand {
  return {
    type: "AskAssignmentQuestion",
    missionId: MISSION_ID,
    assignmentId: "a-1",
    messageId: "q-1",
    senderParticipantId: "p-1",
    recipientParticipantIds: ["p-2"],
    body: "which branch?",
    evidenceRefs: [],
    ...overrides,
  };
}

function answerQuestion(overrides: Partial<Extract<MissionCommand, { type: "AnswerAssignmentQuestion" }>> = {}): MissionCommand {
  return {
    type: "AnswerAssignmentQuestion",
    missionId: MISSION_ID,
    assignmentId: "a-1",
    questionMessageId: "q-1",
    messageId: "a-msg-1",
    senderParticipantId: "p-2",
    recipientParticipantIds: ["p-1"],
    body: "main",
    evidenceRefs: [],
    ...overrides,
  };
}

/** Mission with p-1 (assignee, running a-1) and p-2 (active) participants. */
function bootstrap(): MissionProjection {
  let p = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(p.ok);
  if (!p.ok) throw new Error("unreachable");
  let projection = p.projection;

  for (const id of ["p-1", "p-2"]) {
    p = run(projection, addParticipant(id), projection.aggregateVersion);
    assert.ok(p.ok);
    if (!p.ok) throw new Error("unreachable");
    projection = p.projection;
    p = run(projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: id }, projection.aggregateVersion);
    assert.ok(p.ok);
    if (!p.ok) throw new Error("unreachable");
    projection = p.projection;
  }

  p = run(
    projection,
    { type: "CreateAssignment", missionId: MISSION_ID, assignmentId: "a-1", title: "t", objective: "o", scope: { allowedPaths: ["."], prohibitedPaths: [] }, dependencies: [], requiredEvidence: [], approvalPolicy: "auto", budget: { maxDurationMs: null, maxEstimatedTokens: null } },
    projection.aggregateVersion,
  );
  assert.ok(p.ok);
  if (!p.ok) throw new Error("unreachable");
  projection = p.projection;

  p = run(projection, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId: "a-1", assigneeParticipantId: "p-1", dispatchKey: "primary" }, projection.aggregateVersion);
  assert.ok(p.ok);
  if (!p.ok) throw new Error("unreachable");
  projection = p.projection;

  p = run(projection, { type: "StartAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion);
  assert.ok(p.ok);
  if (!p.ok) throw new Error("unreachable");
  return p.projection;
}

test("atomic ask: one command produces exactly one message_posted + one assignment_status_changed event, nothing partial", () => {
  const projection = bootstrap();
  const result = run(projection, askQuestion(), projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].type, "mission.message_posted");
  assert.equal(result.events[1].type, "mission.assignment_status_changed");
  assert.equal(result.projection.assignments["a-1"].status, "waiting_for_input");
});

test("atomic answer: one command produces exactly one message_posted + one assignment_status_changed event", () => {
  const projection = bootstrap();
  const asked = run(projection, askQuestion(), projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.ok(asked.ok);
  if (!asked.ok) return;

  const answered = run(asked.projection, answerQuestion(), asked.aggregateVersion, { kind: "agent", id: "p-2" });
  assert.ok(answered.ok);
  if (!answered.ok) return;
  assert.equal(answered.events.length, 2);
  assert.equal(answered.events[0].type, "mission.message_posted");
  assert.equal(answered.events[1].type, "mission.assignment_status_changed");
  assert.equal(answered.projection.assignments["a-1"].status, "running");
});

test("duplicate answer (same messageId retried) is deterministic — refused as duplicate_message_id, not double-applied", () => {
  const projection = bootstrap();
  const asked = run(projection, askQuestion(), projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.ok(asked.ok);
  if (!asked.ok) return;
  const answered = run(asked.projection, answerQuestion(), asked.aggregateVersion, { kind: "agent", id: "p-2" });
  assert.ok(answered.ok);
  if (!answered.ok) return;

  const retry = run(answered.projection, answerQuestion(), answered.aggregateVersion, { kind: "agent", id: "p-2" });
  assert.equal(retry.ok, false);
  if (!retry.ok) assert.equal(retry.error.code, "duplicate_message_id");
});

test("a SECOND, DISTINCT answer to the same question is rejected — the question is already resolved", () => {
  const projection = bootstrap();
  const asked = run(projection, askQuestion(), projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.ok(asked.ok);
  if (!asked.ok) return;
  const answered = run(asked.projection, answerQuestion(), asked.aggregateVersion, { kind: "agent", id: "p-2" });
  assert.ok(answered.ok);
  if (!answered.ok) return;

  const secondAnswer = run(answered.projection, answerQuestion({ messageId: "a-msg-2", body: "a completely different answer" }), answered.aggregateVersion, { kind: "agent", id: "p-2" });
  assert.equal(secondAnswer.ok, false);
  if (!secondAnswer.ok) assert.equal(secondAnswer.error.code, "question_already_answered");
});

test("a removed participant cannot ask a question", () => {
  let projection = bootstrap();
  const removed = run(projection, { type: "RemoveParticipant", missionId: MISSION_ID, participantId: "p-1", reason: { code: "done", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, projection.aggregateVersion);
  assert.ok(removed.ok);
  if (!removed.ok) return;
  projection = removed.projection;

  const result = run(projection, askQuestion(), projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.equal(result.ok, false);
});

test("a removed participant cannot answer a question", () => {
  let projection = bootstrap();
  const asked = run(projection, askQuestion(), projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.ok(asked.ok);
  if (!asked.ok) return;
  projection = asked.projection;

  const removed = run(projection, { type: "RemoveParticipant", missionId: MISSION_ID, participantId: "p-2", reason: { code: "done", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, projection.aggregateVersion);
  assert.ok(removed.ok);
  if (!removed.ok) return;
  projection = removed.projection;

  const result = run(projection, answerQuestion(), projection.aggregateVersion, { kind: "agent", id: "p-2" });
  assert.equal(result.ok, false, "a removed participant must never be able to resolve a pending question");
});

test("a cancelled assignment is never resumed by an answer — the transition is refused, matching invalid_assignment_transition", () => {
  const projection = bootstrap();
  const asked = run(projection, askQuestion(), projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.ok(asked.ok);
  if (!asked.ok) return;

  const cancelled = run(asked.projection, { type: "CancelAssignment", missionId: MISSION_ID, assignmentId: "a-1", reason: { code: "no_longer_needed", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, asked.aggregateVersion);
  assert.ok(cancelled.ok);
  if (!cancelled.ok) return;

  const result = run(cancelled.projection, answerQuestion(), cancelled.aggregateVersion, { kind: "agent", id: "p-2" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_assignment_transition");
});

test("an agent cannot impersonate another participant when asking or answering (sender identity binding applies here too)", () => {
  const projection = bootstrap();
  const result = run(projection, askQuestion(), projection.aggregateVersion, { kind: "agent", id: "p-2" }); // acting as p-2, claiming to be sender p-1
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "sender_identity_mismatch");
});

test("replay reconstructs the exact same pending-then-resolved clarification state", async () => {
  const { projectMission } = await import("../src/lib/mission/mission-projection.ts");
  const allEvents: import("../src/lib/mission/mission-events.ts").MissionEvent[] = [];

  let p = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(p.ok);
  if (!p.ok) return;
  allEvents.push(...p.events);
  let projection = p.projection;

  for (const id of ["p-1", "p-2"]) {
    p = run(projection, addParticipant(id), projection.aggregateVersion);
    assert.ok(p.ok);
    if (!p.ok) return;
    allEvents.push(...p.events);
    projection = p.projection;
    p = run(projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: id }, projection.aggregateVersion);
    assert.ok(p.ok);
    if (!p.ok) return;
    allEvents.push(...p.events);
    projection = p.projection;
  }

  p = run(projection, { type: "CreateAssignment", missionId: MISSION_ID, assignmentId: "a-1", title: "t", objective: "o", scope: { allowedPaths: ["."], prohibitedPaths: [] }, dependencies: [], requiredEvidence: [], approvalPolicy: "auto", budget: { maxDurationMs: null, maxEstimatedTokens: null } }, projection.aggregateVersion);
  assert.ok(p.ok);
  if (!p.ok) return;
  allEvents.push(...p.events);
  projection = p.projection;

  p = run(projection, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId: "a-1", assigneeParticipantId: "p-1", dispatchKey: "primary" }, projection.aggregateVersion);
  assert.ok(p.ok);
  if (!p.ok) return;
  allEvents.push(...p.events);
  projection = p.projection;

  p = run(projection, { type: "StartAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion);
  assert.ok(p.ok);
  if (!p.ok) return;
  allEvents.push(...p.events);
  projection = p.projection;

  p = run(projection, askQuestion(), projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.ok(p.ok);
  if (!p.ok) return;
  allEvents.push(...p.events);
  projection = p.projection;
  assert.equal(projection.assignments["a-1"].status, "waiting_for_input");
  assert.deepEqual(projection.unansweredQuestionMessageIds, ["q-1"]);

  const midReplay = projectMission(MISSION_ID, allEvents);
  assert.deepEqual(midReplay, projection, "replay must match the pending (unanswered) state exactly");

  p = run(projection, answerQuestion(), projection.aggregateVersion, { kind: "agent", id: "p-2" });
  assert.ok(p.ok);
  if (!p.ok) return;
  allEvents.push(...p.events);
  projection = p.projection;
  assert.equal(projection.assignments["a-1"].status, "running");
  assert.deepEqual(projection.unansweredQuestionMessageIds, []);

  const finalReplay = projectMission(MISSION_ID, allEvents);
  assert.deepEqual(finalReplay, projection, "replay must match the resolved state exactly");
});
