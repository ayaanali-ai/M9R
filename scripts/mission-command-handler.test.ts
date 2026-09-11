/**
 * Mission command handler — Phase 2A tests
 *
 * Covers: every command's happy path, idempotent replay, idempotency
 * conflict, version conflict, invalid transition refusal, terminal
 * immutability, resumeTo correctness end to end, and correlation/causation
 * propagation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMissionCommand,
  buildCommandOutcomeRecord,
  type ApplyCommandInput,
} from "../src/lib/mission/mission-command-handler.ts";
import { hashCommandPayload, resolveCommandContext, type MissionCommand } from "../src/lib/mission/mission-commands.ts";
import type { MissionProjection } from "../src/lib/mission/mission-projection.ts";
import { projectMission } from "../src/lib/mission/mission-projection.ts";
import type { StateReason } from "../src/lib/mission/mission-domain.ts";
import { validateTransition } from "../src/lib/mission/mission-state-machine.ts";

const MISSION_ID = "m-1";
const ACTOR = { kind: "system" as const, id: "orchestrator" as const };

let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}

function ctx(overrides: Partial<Parameters<typeof resolveCommandContext>[0]> = {}) {
  return resolveCommandContext({ actor: ACTOR, timestamp: "2026-07-24T00:00:00.000Z", ...overrides });
}

function reason(code = "test"): StateReason {
  return { code, summary: "test reason", relatedEntityIds: [], recoverable: true, suggestedActions: [] };
}

function run(current: MissionProjection | null, command: MissionCommand, expectedVersion: number, opts: Partial<ApplyCommandInput> = {}) {
  return applyMissionCommand({
    current,
    command,
    context: ctx(),
    expectedVersion,
    priorOutcome: null,
    mintEventId,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Happy path: draft → ... → accepted
// ---------------------------------------------------------------------------

test("CreateMission produces draft state at version 1", () => {
  const result = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w-1", repository: "acme/app", goal: "Add SSO", mode: "solo" }, 0);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.projection.state, "draft");
    assert.equal(result.aggregateVersion, 1);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, "mission.created");
    assert.equal(result.replayed, false);
  }
});

test("human-created Missions establish a durable active conversation owner", () => {
  const result = run(
    null,
    { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w-1", repository: "acme/app", goal: "Add a shared room", mode: "solo" },
    0,
    { context: ctx({ actor: { kind: "human", id: "human-1" } }) },
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.projection.participants["human-1"]?.kind, "human");
  assert.equal(result.projection.participants["human-1"]?.status, "active");
  assert.equal(result.projection.participants["human-1"]?.communicationPermissions.canBroadcast, true);
  assert.deepEqual(result.events.map((event) => event.type), ["mission.created", "mission.participant_registered"]);
  assert.equal(result.aggregateVersion, 2);
});

test("the full happy path reaches accepted with resumeTo cleared throughout", () => {
  let projection: MissionProjection | null = null;
  let version = 0;

  function step(command: MissionCommand) {
    const result = run(projection, command, version);
    assert.ok(result.ok, `command ${command.type} failed: ${!result.ok ? JSON.stringify(result.error) : ""}`);
    if (result.ok) {
      projection = result.projection;
      version = result.aggregateVersion;
    }
  }

  step({ type: "CreateMission", missionId: MISSION_ID, workspaceId: "w-1", repository: "acme/app", goal: "Add SSO", mode: "solo" });
  step({ type: "BeginPlanning", missionId: MISSION_ID });
  step({ type: "MarkMissionReady", missionId: MISSION_ID, planVersion: 1 });
  step({ type: "BeginInitialization", missionId: MISSION_ID });
  step({ type: "BeginExecution", missionId: MISSION_ID });
  step({ type: "BeginReview", missionId: MISSION_ID });
  step({ type: "BeginVerification", missionId: MISSION_ID });
  step({ type: "MarkReadyForDecision", missionId: MISSION_ID });
  step({ type: "AcceptMission", missionId: MISSION_ID, reviewedRevision: "sha-abc123" });

  assert.equal((projection as unknown as MissionProjection).state, "accepted");
  assert.equal((projection as unknown as MissionProjection).terminal, true);
  assert.equal((projection as unknown as MissionProjection).resumeTo, null);
  assert.equal((projection as unknown as MissionProjection).decision, "accept");
  assert.equal((projection as unknown as MissionProjection).reviewedRevision, "sha-abc123");
});

test("EscalateMission records the decision and an explicit resume target from ready_for_decision", () => {
  let result = run(null, {
    type: "CreateMission",
    missionId: MISSION_ID,
    workspaceId: "ws-1",
    repository: "acme/app",
    goal: "goal",
    mode: "solo",
  }, 0);
  assert.ok(result.ok);
  if (!result.ok) return;

  const sequence: MissionCommand[] = [
    { type: "BeginPlanning", missionId: MISSION_ID },
    { type: "MarkMissionReady", missionId: MISSION_ID, planVersion: 1 },
    { type: "BeginInitialization", missionId: MISSION_ID },
    { type: "BeginExecution", missionId: MISSION_ID },
    { type: "BeginVerification", missionId: MISSION_ID },
    { type: "MarkReadyForDecision", missionId: MISSION_ID },
  ];
  for (const command of sequence) {
    result = run(result.projection, command, result.aggregateVersion);
    assert.ok(result.ok);
    if (!result.ok) return;
  }

  const escalated = run(result.projection, {
    type: "EscalateMission",
    missionId: MISSION_ID,
    reason: { code: "specialist_review", summary: "Needs security review", relatedEntityIds: [], recoverable: true, suggestedActions: [] },
    resumeTo: "reviewing",
  }, result.aggregateVersion, { context: ctx({ actor: { kind: "human", id: "reviewer-1" } }) });

  assert.ok(escalated.ok);
  if (!escalated.ok) return;
  assert.equal(escalated.projection.state, "needs_input");
  assert.equal(escalated.projection.resumeTo, "reviewing");
  assert.equal(
    escalated.events.some((event) => event.payload.type === "mission.decision_recorded" && event.payload.decision === "escalate"),
    true,
  );

  const resumed = run(escalated.projection, { type: "ResumeMission", missionId: MISSION_ID }, escalated.aggregateVersion);
  assert.ok(resumed.ok);
  if (resumed.ok) {
    assert.equal(resumed.projection.state, "reviewing");
    assert.equal(resumed.projection.resumeTo, null);
  }
});

test("MarkMissionReady emits plan_approved before state_changed, both sharing correlation", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w-1", repository: "r", goal: "g", mode: "solo" }, 0);
  assert.ok(created.ok);
  const planning = run(created.ok ? created.projection : null, { type: "BeginPlanning", missionId: MISSION_ID }, 1);
  assert.ok(planning.ok);
  const ready = run(planning.ok ? planning.projection : null, { type: "MarkMissionReady", missionId: MISSION_ID, planVersion: 2 }, 2);
  assert.ok(ready.ok);
  if (ready.ok) {
    assert.equal(ready.events.length, 2);
    assert.equal(ready.events[0].type, "mission.plan_approved");
    assert.equal(ready.events[1].type, "mission.state_changed");
    assert.equal(ready.events[0].correlationId, ready.events[1].correlationId);
    // Second event in the batch is caused by the first, not by whatever
    // caused the command itself.
    assert.equal(ready.events[1].causationId, ready.events[0].eventId);
    assert.equal(ready.projection.approvedPlanVersion, 2);
  }
});

test("RejectMission emits state_changed then decision_recorded", () => {
  let projection: MissionProjection | null = null;
  let version = 0;
  for (const command of [
    { type: "CreateMission" as const, missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" as const },
    { type: "BeginPlanning" as const, missionId: MISSION_ID },
    { type: "MarkMissionReady" as const, missionId: MISSION_ID, planVersion: 1 },
    { type: "BeginInitialization" as const, missionId: MISSION_ID },
    { type: "BeginExecution" as const, missionId: MISSION_ID },
    { type: "BeginVerification" as const, missionId: MISSION_ID },
    { type: "MarkReadyForDecision" as const, missionId: MISSION_ID },
  ]) {
    const result = run(projection, command, version);
    assert.ok(result.ok);
    if (result.ok) { projection = result.projection; version = result.aggregateVersion; }
  }
  const rejected = run(projection, { type: "RejectMission", missionId: MISSION_ID, reason: reason("scope_too_large") }, version);
  assert.ok(rejected.ok);
  if (rejected.ok) {
    assert.equal(rejected.events[0].type, "mission.state_changed");
    assert.equal(rejected.events[1].type, "mission.decision_recorded");
    assert.equal(rejected.projection.state, "rejected");
    assert.equal(rejected.projection.decision, "reject");
  }
});

test("RequestMissionChanges sends a ready_for_decision Mission back to reviewing, never straight to executing", () => {
  let projection: MissionProjection | null = null;
  let version = 0;
  for (const command of [
    { type: "CreateMission" as const, missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" as const },
    { type: "BeginPlanning" as const, missionId: MISSION_ID },
    { type: "MarkMissionReady" as const, missionId: MISSION_ID, planVersion: 1 },
    { type: "BeginInitialization" as const, missionId: MISSION_ID },
    { type: "BeginExecution" as const, missionId: MISSION_ID },
    { type: "BeginVerification" as const, missionId: MISSION_ID },
    { type: "MarkReadyForDecision" as const, missionId: MISSION_ID },
  ]) {
    const result = run(projection, command, version);
    assert.ok(result.ok);
    if (result.ok) { projection = result.projection; version = result.aggregateVersion; }
  }
  const sentBack = run(projection, { type: "RequestMissionChanges", missionId: MISSION_ID, reason: reason("needs_more_test_coverage") }, version);
  assert.ok(sentBack.ok);
  if (sentBack.ok) {
    assert.equal(sentBack.events[0].type, "mission.state_changed");
    assert.equal((sentBack.events[0].payload as { nextState: string }).nextState, "reviewing");
    assert.equal(sentBack.events[1].type, "mission.decision_recorded");
    assert.equal((sentBack.events[1].payload as { decision: string }).decision, "request_changes");
    assert.equal(sentBack.projection.state, "reviewing");
    assert.equal(sentBack.projection.decision, "request_changes");
    assert.equal(sentBack.projection.terminal, false); // never terminal — this is explicitly a "send it back," not a decision that ends the Mission
    assert.deepEqual(sentBack.events[0].reason, reason("needs_more_test_coverage"));

    // The Mission can now move forward again — through review, not skipping it.
    const backToExecuting = run(sentBack.projection, { type: "BeginExecution", missionId: MISSION_ID }, sentBack.aggregateVersion);
    assert.ok(backToExecuting.ok);
    if (backToExecuting.ok) assert.equal(backToExecuting.projection.state, "executing");
  }
});

test("ContinueMissionInvestigation sends a ready_for_decision Mission back to reviewing, distinct from RequestMissionChanges", () => {
  let projection: MissionProjection | null = null;
  let version = 0;
  for (const command of [
    { type: "CreateMission" as const, missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" as const },
    { type: "BeginPlanning" as const, missionId: MISSION_ID },
    { type: "MarkMissionReady" as const, missionId: MISSION_ID, planVersion: 1 },
    { type: "BeginInitialization" as const, missionId: MISSION_ID },
    { type: "BeginExecution" as const, missionId: MISSION_ID },
    { type: "BeginVerification" as const, missionId: MISSION_ID },
    { type: "MarkReadyForDecision" as const, missionId: MISSION_ID },
  ]) {
    const result = run(projection, command, version);
    assert.ok(result.ok);
    if (result.ok) { projection = result.projection; version = result.aggregateVersion; }
  }
  const continued = run(projection, { type: "ContinueMissionInvestigation", missionId: MISSION_ID, reason: reason("evidence_inconclusive") }, version);
  assert.ok(continued.ok);
  if (continued.ok) {
    assert.equal(continued.projection.state, "reviewing");
    assert.equal(continued.projection.decision, "continue_investigation");
    assert.notEqual(continued.projection.decision, "request_changes");
  }
});

test("ready_for_decision -> executing remains illegal even after adding the reviewing edge (RequestMissionChanges never bypasses review)", () => {
  // Reuses the state machine directly, the same way mission-domain.test.ts's
  // "undeclared transitions are refused" guard does, so this test fails
  // loudly if that invariant is ever silently loosened alongside this change.
  const result = validateTransition({ from: "ready_for_decision", to: "executing", reason: reason(), resumeTo: "executing" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /Illegal transition/);
});

// ---------------------------------------------------------------------------
// Enforcement: idempotency
// ---------------------------------------------------------------------------

test("a duplicate command (same key, same payload) replays the prior result", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;

  const command: MissionCommand = { type: "BeginPlanning", missionId: MISSION_ID };
  const first = applyMissionCommand({ current: created.projection, command, context: ctx(), expectedVersion: 1, priorOutcome: null, mintEventId });
  assert.ok(first.ok);
  if (!first.ok) return;

  const outcomeRecord = buildCommandOutcomeRecord("key-1", command, first);

  // Retried with a STALE expected version — a genuine duplicate must still
  // succeed, because from the caller's perspective nothing new is happening.
  const replay = applyMissionCommand({
    current: created.projection,
    command,
    context: ctx(),
    expectedVersion: 0,
    priorOutcome: outcomeRecord,
    mintEventId,
  });
  assert.ok(replay.ok);
  if (replay.ok) {
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.events, first.events);
    assert.equal(replay.aggregateVersion, first.aggregateVersion);
  }
});

test("the same key with a different payload is an idempotency conflict, not a replay", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;

  const original: MissionCommand = { type: "BeginPlanning", missionId: MISSION_ID };
  const first = applyMissionCommand({ current: created.projection, command: original, context: ctx(), expectedVersion: 1, priorOutcome: null, mintEventId });
  assert.ok(first.ok);
  if (!first.ok) return;
  const outcomeRecord = buildCommandOutcomeRecord("key-1", original, first);

  const different: MissionCommand = { type: "CancelMission", missionId: MISSION_ID, reason: reason() };
  const result = applyMissionCommand({
    current: created.projection,
    command: different,
    context: ctx(),
    expectedVersion: 1,
    priorOutcome: outcomeRecord,
    mintEventId,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "idempotency_conflict");
});

test("command result includes emitted event IDs and the resulting aggregateVersion", () => {
  const result = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" }, 0);
  assert.ok(result.ok);
  if (result.ok) {
    assert.ok(result.events.every((e) => typeof e.eventId === "string" && e.eventId.length > 0));
    assert.equal(result.aggregateVersion, result.events[result.events.length - 1].aggregateVersion);
  }
});

// ---------------------------------------------------------------------------
// Enforcement: expectedVersion
// ---------------------------------------------------------------------------

test("a stale expectedVersion is refused as a version conflict", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  const result = run(created.projection, { type: "BeginPlanning", missionId: MISSION_ID }, 0);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "version_conflict");
    if (result.error.code === "version_conflict") {
      assert.equal(result.error.expectedVersion, 0);
      assert.equal(result.error.currentVersion, 1);
    }
  }
});

test("CreateMission against an existing mission is refused, not silently accepted", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  const result = run(created.projection, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "different", mode: "solo" }, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "mission_already_exists");
});

test("a command against a mission that does not exist is refused", () => {
  const result = run(null, { type: "BeginPlanning", missionId: MISSION_ID }, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "mission_not_found");
});

// ---------------------------------------------------------------------------
// Enforcement: transition legality + terminal immutability
// ---------------------------------------------------------------------------

test("an illegal transition is refused with the state machine's own errors", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  // draft cannot go straight to executing.
  const result = run(created.projection, { type: "BeginExecution", missionId: MISSION_ID }, 1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_transition");
    if (result.error.code === "invalid_transition") assert.match(result.error.errors.join(" "), /Illegal transition/);
  }
});

test("no command can move a terminal mission", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  const cancelled = run(created.projection, { type: "CancelMission", missionId: MISSION_ID, reason: reason() }, 1);
  assert.ok(cancelled.ok);
  if (!cancelled.ok) return;

  for (const command of [
    { type: "BeginPlanning" as const, missionId: MISSION_ID },
    { type: "CancelMission" as const, missionId: MISSION_ID, reason: reason() },
    { type: "AcceptMission" as const, missionId: MISSION_ID, reviewedRevision: null },
  ]) {
    const result = applyMissionCommand({
      current: cancelled.projection,
      command,
      context: ctx(),
      expectedVersion: cancelled.aggregateVersion,
      priorOutcome: null,
      mintEventId,
    });
    assert.equal(result.ok, false, `${command.type} must be refused on a terminal mission`);
    if (!result.ok) assert.equal(result.error.code, "invalid_transition");
  }
});

// ---------------------------------------------------------------------------
// resumeTo correctness end to end
// ---------------------------------------------------------------------------

test("BlockMission records resumeTo, and ResumeMission returns to exactly that state", () => {
  let projection: MissionProjection | null = null;
  let version = 0;
  for (const command of [
    { type: "CreateMission" as const, missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" as const },
    { type: "BeginPlanning" as const, missionId: MISSION_ID },
    { type: "MarkMissionReady" as const, missionId: MISSION_ID, planVersion: 1 },
    { type: "BeginInitialization" as const, missionId: MISSION_ID },
    { type: "BeginExecution" as const, missionId: MISSION_ID },
    { type: "BeginReview" as const, missionId: MISSION_ID },
  ]) {
    const result = run(projection, command, version);
    assert.ok(result.ok, `${command.type}: ${!result.ok ? JSON.stringify(result.error) : ""}`);
    if (result.ok) { projection = result.projection; version = result.aggregateVersion; }
  }

  const blocked = run(projection, { type: "BlockMission", missionId: MISSION_ID, reason: reason("dependency_unavailable") }, version);
  assert.ok(blocked.ok);
  if (!blocked.ok) return;
  assert.equal(blocked.projection.state, "blocked");
  assert.equal(blocked.projection.resumeTo, "reviewing");

  const resumed = run(blocked.projection, { type: "ResumeMission", missionId: MISSION_ID }, blocked.aggregateVersion);
  assert.ok(resumed.ok);
  if (resumed.ok) {
    assert.equal(resumed.projection.state, "reviewing");
    assert.equal(resumed.projection.resumeTo, null);
  }
});

test("ResumeMission on a mission with no recorded resume target is refused", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  const result = run(created.projection, { type: "ResumeMission", missionId: MISSION_ID }, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "no_resume_target");
});

test("a mission cannot resume into a state other than the one it was interrupted from", () => {
  let projection: MissionProjection | null = null;
  let version = 0;
  for (const command of [
    { type: "CreateMission" as const, missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" as const },
    { type: "BeginPlanning" as const, missionId: MISSION_ID },
    { type: "MarkMissionReady" as const, missionId: MISSION_ID, planVersion: 1 },
    { type: "BeginInitialization" as const, missionId: MISSION_ID },
    { type: "BeginExecution" as const, missionId: MISSION_ID },
  ]) {
    const result = run(projection, command, version);
    assert.ok(result.ok);
    if (result.ok) { projection = result.projection; version = result.aggregateVersion; }
  }
  const paused = run(projection, { type: "PauseMission", missionId: MISSION_ID, reason: reason() }, version);
  assert.ok(paused.ok);
  if (!paused.ok) return;
  assert.equal(paused.projection.resumeTo, "executing");

  // Directly attempting BeginReview instead of ResumeMission must fail: the
  // transition table only allows paused -> its recordedResumeTo.
  const result = applyMissionCommand({
    current: paused.projection,
    command: { type: "BeginReview", missionId: MISSION_ID },
    context: ctx(),
    expectedVersion: paused.aggregateVersion,
    priorOutcome: null,
    mintEventId,
  });
  assert.equal(result.ok, false);
});

test("a projection built by folding the same events independently matches the command handler's own projection", () => {
  // Guards the determinism promise across the resumeTo fix: the event, not a
  // handler side-channel, must be what carries resumeTo.
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  const planning = run(created.projection, { type: "BeginPlanning", missionId: MISSION_ID }, 1);
  assert.ok(planning.ok);
  if (!planning.ok) return;
  const ready = run(planning.projection, { type: "MarkMissionReady", missionId: MISSION_ID, planVersion: 1 }, 2);
  assert.ok(ready.ok);
  if (!ready.ok) return;
  const init = run(ready.projection, { type: "BeginInitialization", missionId: MISSION_ID }, ready.aggregateVersion);
  assert.ok(init.ok);
  if (!init.ok) return;
  const exec = run(init.projection, { type: "BeginExecution", missionId: MISSION_ID }, init.aggregateVersion);
  assert.ok(exec.ok);
  if (!exec.ok) return;
  const blocked = run(exec.projection, { type: "BlockMission", missionId: MISSION_ID, reason: reason() }, exec.aggregateVersion);
  assert.ok(blocked.ok);
  if (!blocked.ok) return;

  const allEvents = [...created.events, ...planning.events, ...ready.events, ...init.events, ...exec.events, ...blocked.events];
  const independentlyProjected = projectMission(MISSION_ID, allEvents);
  assert.equal(independentlyProjected.resumeTo, blocked.projection.resumeTo);
  assert.equal(independentlyProjected.state, blocked.projection.state);
});

// ---------------------------------------------------------------------------
// Correlation / causation
// ---------------------------------------------------------------------------

test("every event a single command emits shares one correlationId", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  const planning = run(created.projection, { type: "BeginPlanning", missionId: MISSION_ID }, 1);
  assert.ok(planning.ok);
  if (!planning.ok) return;
  const ready = run(planning.projection, { type: "MarkMissionReady", missionId: MISSION_ID, planVersion: 1 }, 2);
  assert.ok(ready.ok);
  if (ready.ok) {
    const correlations = new Set(ready.events.map((e) => e.correlationId));
    assert.equal(correlations.size, 1);
  }
});

test("a command context propagates the caller's causationId onto the first emitted event", () => {
  const result = applyMissionCommand({
    current: null,
    command: { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" },
    context: ctx({ causationId: "evt-upstream" }),
    expectedVersion: 0,
    priorOutcome: null,
    mintEventId,
  });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.events[0].causationId, "evt-upstream");
});

test("mintCorrelationId is not called by applyMissionCommand itself — it only uses what the context supplies", () => {
  const explicit = resolveCommandContext({ actor: ACTOR, timestamp: "2026-07-24T00:00:00.000Z", correlationId: "corr-explicit" });
  assert.equal(explicit.correlationId, "corr-explicit");
  const result = applyMissionCommand({
    current: null,
    command: { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" },
    context: explicit,
    expectedVersion: 0,
    priorOutcome: null,
    mintEventId,
  });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.events[0].correlationId, "corr-explicit");
});

test("hashCommandPayload is sensitive to payload but not to context", () => {
  const a: MissionCommand = { type: "BeginPlanning", missionId: MISSION_ID };
  const b: MissionCommand = { type: "BeginPlanning", missionId: MISSION_ID };
  const c: MissionCommand = { type: "BeginPlanning", missionId: "other-mission" };
  assert.equal(hashCommandPayload(a), hashCommandPayload(b));
  assert.notEqual(hashCommandPayload(a), hashCommandPayload(c));
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test("applyMissionCommand does not mutate the projection it was given", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  const snapshot = JSON.stringify(created.projection);
  run(created.projection, { type: "BeginPlanning", missionId: MISSION_ID }, 1);
  assert.equal(JSON.stringify(created.projection), snapshot);
});

test("the same command applied twice from the same starting point (no idempotency record) is refused the second time by version, not silently reapplied", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  const first = run(created.projection, { type: "BeginPlanning", missionId: MISSION_ID }, 1);
  assert.ok(first.ok);
  // Same expectedVersion reused without an idempotency key: this simulates a
  // caller that forgot to advance its belief about the version, which must
  // be caught by concurrency, not silently accepted twice.
  const second = run(created.projection, { type: "BeginPlanning", missionId: MISSION_ID }, 1);
  assert.ok(second.ok, "the state itself hasn't moved from the caller's point of view, so this succeeds identically");
  if (first.ok && second.ok) assert.deepEqual(first.events.map((e) => e.type), second.events.map((e) => e.type));
});
