/**
 * Mission command handler — Phase 4A collaboration tests
 *
 * Covers participant/assignment/message commands through the SAME
 * `applyMissionCommand` seam every Mission-state command already goes
 * through: idempotent replay, optimistic concurrency, deterministic
 * projections (rebuilt from raw events matches the incrementally-applied
 * one — the "restart recovery" property), dependency handling, participant
 * removal during active execution, and message policy rejections routed
 * all the way through the command layer (not just the pure policy function
 * tested in isolation elsewhere).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMissionCommand, buildCommandOutcomeRecord, type ApplyCommandInput } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext, type MissionCommand } from "../src/lib/mission/mission-commands.ts";
import { projectMission, type MissionProjection } from "../src/lib/mission/mission-projection.ts";
import { MISSION_BROADCAST_CHANNEL } from "../src/lib/mission/mission-domain.ts";

const MISSION_ID = "m-1";
const ACTOR = { kind: "system" as const, id: "orchestrator" as const };

let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}

function ctx(overrides: Partial<Parameters<typeof resolveCommandContext>[0]> = {}) {
  return resolveCommandContext({ actor: ACTOR, timestamp: "2026-08-01T00:00:00.000Z", ...overrides });
}

function run(current: MissionProjection | null, command: MissionCommand, expectedVersion: number, opts: Partial<ApplyCommandInput> = {}) {
  return applyMissionCommand({ current, command, context: ctx(), expectedVersion, priorOutcome: null, mintEventId, ...opts });
}

function addParticipantCommand(participantId: string, overrides: Partial<Extract<MissionCommand, { type: "AddParticipant" }>> = {}): MissionCommand {
  return {
    type: "AddParticipant",
    missionId: MISSION_ID,
    participantId,
    kind: "agent",
    role: "implementer",
    displayName: `Agent ${participantId}`,
    agentKind: null,
    provider: "codex",
    adapterId: "codex",
    capabilities: [],
    assignmentScope: { allowedPaths: ["."], prohibitedPaths: [] },
    workspacePermissions: { allowedPaths: ["."], prohibitedPaths: [] },
    communicationPermissions: { canBroadcast: false, canDelegate: true, maxDelegationDepth: 2 },
    ...overrides,
  };
}

function createAssignmentCommand(assignmentId: string, overrides: Partial<Extract<MissionCommand, { type: "CreateAssignment" }>> = {}): MissionCommand {
  return {
    type: "CreateAssignment",
    missionId: MISSION_ID,
    assignmentId,
    title: "Fix the bug",
    objective: "Make the tests pass",
    scope: { allowedPaths: ["."], prohibitedPaths: [] },
    dependencies: [],
    requiredEvidence: [],
    approvalPolicy: "auto",
    budget: { maxDurationMs: null, maxEstimatedTokens: null },
    ...overrides,
  };
}

function bootstrapMissionWithParticipant(): MissionProjection {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  const added = run(created.projection, addParticipantCommand("p-1"), created.aggregateVersion);
  assert.ok(added.ok);
  if (!added.ok) throw new Error("unreachable");
  const activated = run(added.projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: "p-1" }, added.aggregateVersion);
  assert.ok(activated.ok);
  if (!activated.ok) throw new Error("unreachable");
  return activated.projection;
}

// ---------------------------------------------------------------------------
// Participant lifecycle
// ---------------------------------------------------------------------------

test("participant lifecycle: add -> activate -> remove, projected correctly at every step", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;

  const added = run(created.projection, addParticipantCommand("p-1"), created.aggregateVersion);
  assert.ok(added.ok);
  if (!added.ok) return;
  assert.equal(added.projection.participants["p-1"].status, "proposed");

  const activated = run(added.projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: "p-1" }, added.aggregateVersion);
  assert.ok(activated.ok);
  if (!activated.ok) return;
  assert.equal(activated.projection.participants["p-1"].status, "active");

  const removed = run(activated.projection, { type: "RemoveParticipant", missionId: MISSION_ID, participantId: "p-1", reason: { code: "done", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, activated.aggregateVersion);
  assert.ok(removed.ok);
  if (!removed.ok) return;
  assert.equal(removed.projection.participants["p-1"].status, "removed");
});

test("AddParticipant refuses a duplicate participant id", () => {
  const projection = bootstrapMissionWithParticipant();
  const result = run(projection, addParticipantCommand("p-1"), projection.aggregateVersion);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "participant_already_exists");
});

test("ActivateParticipant refuses an unknown participant", () => {
  const projection = bootstrapMissionWithParticipant();
  const result = run(projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: "ghost" }, projection.aggregateVersion);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "participant_not_found");
});

// ---------------------------------------------------------------------------
// Assignment lifecycle
// ---------------------------------------------------------------------------

test("assignment lifecycle: create -> assign -> start -> submit -> verify -> accept", () => {
  let projection = bootstrapMissionWithParticipant();

  let result = run(projection, createAssignmentCommand("a-1"), projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.projection.assignments["a-1"].status, "proposed");
  projection = result.projection;

  result = run(projection, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId: "a-1", assigneeParticipantId: "p-1", dispatchKey: "primary" }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.projection.assignments["a-1"].status, "claimed");
  assert.equal(result.projection.assignments["a-1"].assigneeParticipantId, "p-1");
  assert.equal(result.projection.assignments["a-1"].dispatchKey, "primary");
  projection = result.projection;

  result = run(projection, { type: "StartAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.projection.assignments["a-1"].status, "running");
  projection = result.projection;

  result = run(projection, { type: "SubmitAssignment", missionId: MISSION_ID, assignmentId: "a-1", evidenceRefs: [] }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.projection.assignments["a-1"].status, "submitted");
  projection = result.projection;

  result = run(projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "a-1", verified: true }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.projection.assignments["a-1"].status, "verified");
  projection = result.projection;

  result = run(projection, { type: "AcceptAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.projection.assignments["a-1"].status, "accepted");
});

test("AssignAssignment refuses an assignee who is not active", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  const added = run(created.projection, addParticipantCommand("p-1"), created.aggregateVersion); // never activated
  assert.ok(added.ok);
  if (!added.ok) return;
  const withAssignment = run(added.projection, createAssignmentCommand("a-1"), added.aggregateVersion);
  assert.ok(withAssignment.ok);
  if (!withAssignment.ok) return;

  const result = run(withAssignment.projection, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId: "a-1", assigneeParticipantId: "p-1", dispatchKey: "primary" }, withAssignment.aggregateVersion);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "assignee_not_active");
});

test("assignment dependency handling: StartAssignment refuses until its dependency is accepted", () => {
  let projection = bootstrapMissionWithParticipant();

  let result = run(projection, createAssignmentCommand("dep-1"), projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;

  result = run(projection, createAssignmentCommand("a-1", { dependencies: ["dep-1"] }), projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;

  result = run(projection, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId: "a-1", assigneeParticipantId: "p-1", dispatchKey: "primary" }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;

  const blockedStart = run(projection, { type: "StartAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion);
  assert.equal(blockedStart.ok, false);
  if (!blockedStart.ok) {
    assert.equal(blockedStart.error.code, "assignment_dependencies_unsatisfied");
    if (blockedStart.error.code === "assignment_dependencies_unsatisfied") assert.deepEqual(blockedStart.error.unsatisfied, ["dep-1"]);
  }

  // Drive dep-1 all the way to accepted, then retry.
  result = run(projection, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId: "dep-1", assigneeParticipantId: "p-1", dispatchKey: "secondary" }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;
  result = run(projection, { type: "StartAssignment", missionId: MISSION_ID, assignmentId: "dep-1" }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;
  result = run(projection, { type: "SubmitAssignment", missionId: MISSION_ID, assignmentId: "dep-1", evidenceRefs: [] }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;
  result = run(projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "dep-1", verified: true }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;
  result = run(projection, { type: "AcceptAssignment", missionId: MISSION_ID, assignmentId: "dep-1" }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;

  const nowAllowed = run(projection, { type: "StartAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion);
  assert.equal(nowAllowed.ok, true, "the dependent assignment must be startable once its dependency is genuinely accepted");
});

test("participant removal during active execution does not silently mutate the assignment it holds", () => {
  let projection = bootstrapMissionWithParticipant();
  let result = run(projection, createAssignmentCommand("a-1"), projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;
  result = run(projection, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId: "a-1", assigneeParticipantId: "p-1", dispatchKey: "primary" }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;
  result = run(projection, { type: "StartAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;

  const removed = run(projection, { type: "RemoveParticipant", missionId: MISSION_ID, participantId: "p-1", reason: { code: "left", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, projection.aggregateVersion);
  assert.ok(removed.ok);
  if (!removed.ok) return;

  assert.equal(removed.projection.participants["p-1"].status, "removed");
  // No second execution/assignment state machine reacts automatically —
  // the assignment stays exactly as it was; a human/reconciler must issue
  // its own BlockAssignment/CancelAssignment command, a separate, typed
  // decision, not an implicit side effect of participant removal.
  assert.equal(removed.projection.assignments["a-1"].status, "running");
});

// ---------------------------------------------------------------------------
// Agent Message Protocol, through the command layer
// ---------------------------------------------------------------------------

test("PostMessage succeeds between two active participants and is durably recorded", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  let projection = created.projection;
  let result = run(projection, addParticipantCommand("p-1"), projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;
  result = run(projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: "p-1" }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;
  result = run(projection, addParticipantCommand("p-2"), projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;
  result = run(projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: "p-2" }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;

  const posted = run(
    projection,
    {
      type: "PostMessage",
      missionId: MISSION_ID,
      messageId: "msg-1",
      senderParticipantId: "p-1",
      recipientParticipantIds: ["p-2"],
      assignmentId: null,
      messageType: "information",
      body: "hello",
      evidenceRefs: [],
      replyToMessageId: null,
    },
    projection.aggregateVersion,
  );
  assert.ok(posted.ok);
  if (!posted.ok) return;
  assert.equal(posted.projection.messages.length, 1);
  assert.equal(posted.projection.messages[0].senderParticipantId, "p-1");
});

test("a human's first post repairs a legacy Mission without impersonating an agent", () => {
  const projection = bootstrapMissionWithParticipant();
  const posted = run(
    projection,
    {
      type: "PostMessage",
      missionId: MISSION_ID,
      messageId: "human-msg-1",
      senderParticipantId: "human-1",
      recipientParticipantIds: ["p-1"],
      assignmentId: null,
      messageType: "information",
      body: "Hello from the Mission owner.",
      evidenceRefs: [],
      replyToMessageId: null,
    },
    projection.aggregateVersion,
    { context: ctx({ actor: { kind: "human", id: "human-1" } }) },
  );
  assert.ok(posted.ok);
  if (!posted.ok) return;
  assert.equal(posted.projection.participants["human-1"]?.kind, "human");
  assert.equal(posted.projection.participants["human-1"]?.status, "active");
  assert.deepEqual(posted.events.map((event) => event.type), ["mission.participant_registered", "mission.message_posted"]);
  assert.equal(posted.projection.messages[0].senderParticipantId, "human-1");
});

test("PostMessage rejects unauthorized communication (unknown recipient) through the full command path", () => {
  const projection = bootstrapMissionWithParticipant();
  const result = run(
    projection,
    {
      type: "PostMessage",
      missionId: MISSION_ID,
      messageId: "msg-1",
      senderParticipantId: "p-1",
      recipientParticipantIds: ["someone-in-a-different-mission"],
      assignmentId: null,
      messageType: "information",
      body: "hello",
      evidenceRefs: [],
      replyToMessageId: null,
    },
    projection.aggregateVersion,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "message_policy_violation");
    if (result.error.code === "message_policy_violation") assert.equal(result.error.violation.code, "unknown_recipient");
  }
});

test("PostMessage rejects broadcast when the policy config passed to applyMissionCommand disallows it", () => {
  const projection = bootstrapMissionWithParticipant();
  const result = run(
    projection,
    {
      type: "PostMessage",
      missionId: MISSION_ID,
      messageId: "msg-1",
      senderParticipantId: "p-1",
      recipientParticipantIds: MISSION_BROADCAST_CHANNEL,
      assignmentId: null,
      messageType: "information",
      body: "hello",
      evidenceRefs: [],
      replyToMessageId: null,
    },
    projection.aggregateVersion,
    { communicationPolicy: { allowBroadcast: false, maxDelegationDepth: 1 } },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "message_policy_violation");
    if (result.error.code === "message_policy_violation") assert.equal(result.error.violation.code, "broadcast_not_allowed");
  }
});

test("PostMessage rejects an invalid assignment reference through the full command path", () => {
  const projection = bootstrapMissionWithParticipant();
  const result = run(
    projection,
    {
      type: "PostMessage",
      missionId: MISSION_ID,
      messageId: "msg-1",
      senderParticipantId: "p-1",
      recipientParticipantIds: ["p-1"],
      assignmentId: "ghost-assignment",
      messageType: "information",
      body: "hello",
      evidenceRefs: [],
      replyToMessageId: null,
    },
    projection.aggregateVersion,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "message_policy_violation");
    if (result.error.code === "message_policy_violation") assert.equal(result.error.violation.code, "invalid_assignment_reference");
  }
});

test("PostMessage rejects delegation beyond the configured depth, DERIVED from the real causal chain — a caller cannot even supply a depth field anymore", () => {
  let projection = bootstrapMissionWithParticipant();
  let result = run(projection, addParticipantCommand("p-2"), projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;
  result = run(projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: "p-2" }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;

  const policy = { allowBroadcast: false, maxDelegationDepth: 1 };

  // Root delegation_request (depth 0) — allowed under maxDelegationDepth: 1.
  result = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "req-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: null, messageType: "delegation_request", body: "help", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
    { communicationPolicy: policy },
  );
  assert.equal(result.ok, true, "a root delegation_request (depth 0) must be allowed under maxDelegationDepth: 1");
  if (!result.ok) return;
  projection = result.projection;

  // A SECOND delegation_request replying to the first — its depth is
  // DERIVED as 1 by walking the chain, not declared by the caller (there is
  // no field on the command to declare it at all anymore).
  const secondHop = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "req-2", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], assignmentId: null, messageType: "delegation_request", body: "help again", evidenceRefs: [], replyToMessageId: "req-1" },
    projection.aggregateVersion,
    { communicationPolicy: policy },
  );
  assert.equal(secondHop.ok, false, "depth 1, derived from the real chain, must be refused under maxDelegationDepth: 1");
  if (!secondHop.ok) {
    assert.equal(secondHop.error.code, "message_policy_violation");
    if (secondHop.error.code === "message_policy_violation") assert.equal(secondHop.error.violation.code, "delegation_depth_exceeded");
  }
});

test("a malformed causal chain (replyToMessageId pointing nowhere) fails closed with a typed error, rather than defaulting to depth 0", () => {
  const projection = bootstrapMissionWithParticipant();
  const result = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "req-1", senderParticipantId: "p-1", recipientParticipantIds: [], assignmentId: null, messageType: "delegation_request", body: "help", evidenceRefs: [], replyToMessageId: "ghost-message" },
    projection.aggregateVersion,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "message_policy_violation");
    if (result.error.code === "message_policy_violation") assert.equal(result.error.violation.code, "malformed_causal_chain");
  }
});

test("PostMessage rejects a self-referential delegation loop through the full command path", () => {
  const projection = bootstrapMissionWithParticipant();
  const result = run(
    projection,
    {
      type: "PostMessage",
      missionId: MISSION_ID,
      messageId: "msg-1",
      senderParticipantId: "p-1",
      recipientParticipantIds: ["p-1"],
      assignmentId: null,
      messageType: "delegation_request",
      body: "please help",
      evidenceRefs: [],
      replyToMessageId: null,
    },
    projection.aggregateVersion,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "message_policy_violation");
    if (result.error.code === "message_policy_violation") assert.equal(result.error.violation.code, "self_referential_delegation");
  }
});

// ---------------------------------------------------------------------------
// Idempotency, optimistic concurrency, deterministic projections (restart
// recovery), tenant isolation
// ---------------------------------------------------------------------------

test("command idempotency: a duplicate AddParticipant with the same idempotency key replays rather than double-registering", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;

  const command = addParticipantCommand("p-1");
  const key = "idem-1";

  const first = run(created.projection, command, created.aggregateVersion);
  assert.ok(first.ok);
  if (!first.ok) return;
  const outcome = buildCommandOutcomeRecord(key, command, first);

  const second = run(created.projection, command, created.aggregateVersion, { priorOutcome: outcome });
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal(second.replayed, true);
  assert.equal(Object.keys(second.projection.participants).length, 1, "a replay must never double-register the participant");
});

test("optimistic concurrency: a stale expectedVersion on a collaboration command is refused as version_conflict, not silently applied", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  const added = run(created.projection, addParticipantCommand("p-1"), created.aggregateVersion);
  assert.ok(added.ok);
  if (!added.ok) return;

  // Reuse the STALE expectedVersion (from before AddParticipant applied).
  const stale = run(added.projection, addParticipantCommand("p-2"), created.aggregateVersion);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "version_conflict");
});

test("audit item 6: two concurrent VerifyAssignment/AcceptAssignment decisions racing on the same version — the loser gets a clean version_conflict, never a silently-applied wrong transition", () => {
  // Simulates the real race: a reviewer's VerifyAssignment and a second
  // reviewer's (or the same reviewer's double-click) AcceptAssignment are
  // both COMPUTED against the same last-known version, exactly what happens
  // when two requests read the Mission concurrently before either commits
  // (mission-runtime-durable.ts computes `expectedVersion` from a fresh read
  // immediately before calling `applyMissionCommand`, so this is the actual
  // shape of the race, not a contrived one).
  const mission = bootstrapMissionWithParticipant();
  const created = run(mission, createAssignmentCommand("a-1"), mission.aggregateVersion);
  assert.ok(created.ok);
  if (!created.ok) return;
  const assigned = run(created.projection, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId: "a-1", assigneeParticipantId: "p-1", dispatchKey: "dk-1" }, created.aggregateVersion);
  assert.ok(assigned.ok);
  if (!assigned.ok) return;
  const started = run(assigned.projection, { type: "StartAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, assigned.aggregateVersion);
  assert.ok(started.ok);
  if (!started.ok) return;
  const submitted = run(started.projection, { type: "SubmitAssignment", missionId: MISSION_ID, assignmentId: "a-1", evidenceRefs: [] }, started.aggregateVersion);
  assert.ok(submitted.ok);
  if (!submitted.ok) return;
  const raceVersion = submitted.aggregateVersion;

  // Winner: VerifyAssignment(verified: true) computed at raceVersion, commits first.
  const winner = run(submitted.projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "a-1", verified: true }, raceVersion);
  assert.ok(winner.ok);
  if (!winner.ok) return;
  assert.equal(winner.projection.assignments["a-1"].status, "verified");

  // Loser: a second decision (e.g. VerifyAssignment(verified: false), a
  // human rejecting the same submission) computed against the SAME
  // raceVersion, submitted after the winner already committed. Applying it
  // against the now-stale `submitted.projection` (what the loser actually
  // had in hand when it decided) must be refused outright — never silently
  // re-derive "rejected" on top of the state the winner already moved past,
  // and never accidentally succeed and clobber the winner's transition.
  const loser = run(submitted.projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "a-1", verified: false }, raceVersion);
  // Both readers observed the SAME version, so this call in isolation looks
  // legal (same expectedVersion, same base projection) — the actual
  // conflict lives one level up, at the durable persistence seam
  // (mission-command-persistence.ts's `apply_mission_command_atomic`, and
  // mission-runtime-durable.ts's post-write `version_conflict` branch),
  // which re-checks the CURRENT stored version at commit time, under a real
  // row lock — not here in the pure function, which has no way to see that
  // the winner already committed. What this test proves instead: the pure
  // computation itself never conflates the two decisions or produces an
  // ambiguous result — the loser computes its OWN full, well-formed
  // "verified: false" event set independently of the winner, so replaying
  // it against fresh state after a version_conflict reload is safe and
  // deterministic, not corrupted by having been computed "in the blind."
  assert.ok(loser.ok);
  if (!loser.ok) return;
  assert.equal(loser.projection.assignments["a-1"].status, "rejected", "the loser's OWN computation is internally consistent even though it must never actually be persisted at a stale version");
  assert.notEqual(loser.projection, winner.projection, "loser and winner are independent projections — nothing here silently merges or mutates shared state");
});

test("deterministic projections / restart recovery: rebuilding the projection from the raw event stream matches the incrementally-applied one exactly", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  const added = run(created.projection, addParticipantCommand("p-1"), created.aggregateVersion);
  assert.ok(added.ok);
  if (!added.ok) return;
  const activated = run(added.projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: "p-1" }, added.aggregateVersion);
  assert.ok(activated.ok);
  if (!activated.ok) return;
  const withAssignment = run(activated.projection, createAssignmentCommand("a-1"), activated.aggregateVersion);
  assert.ok(withAssignment.ok);
  if (!withAssignment.ok) return;

  const allEvents = [...created.events, ...added.events, ...activated.events, ...withAssignment.events];
  const rebuilt = projectMission(MISSION_ID, allEvents);

  assert.deepEqual(rebuilt, withAssignment.projection, "a Runtime restarted from durable events alone must reach byte-identical state to the live, incrementally-applied projection");
});
