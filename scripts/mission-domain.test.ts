/**
 * Mission domain — Phase 1 tests
 *
 * Covers: valid transitions, invalid transitions, terminal immutability,
 * version conflicts, deterministic projections, idempotency, the two
 * independent evidence axes, and legacy Run mapping.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVE_MISSION_STATES,
  EVIDENCE_AVAILABILITY,
  EVIDENCE_LIFECYCLE,
  MISSION_STATES,
  TERMINAL_MISSION_STATES,
  isActiveMissionState,
  isEvidenceAvailability,
  isEvidenceLifecycle,
  isMissionState,
  isTerminalMissionState,
  type MissionState,
  type StateReason,
} from "../src/lib/mission/mission-domain.ts";
import {
  MISSION_TRANSITIONS,
  allowedTransitionsFrom,
  requiresReason,
  validateTransition,
} from "../src/lib/mission/mission-state-machine.ts";
import {
  createMissionEvent,
  validateEventSequence,
  type MissionEvent,
  type MissionEventPayload,
} from "../src/lib/mission/mission-events.ts";
import {
  CONCURRENCY_CONFLICT_STATUS,
  checkExpectedVersion,
  isConcurrencyConflict,
} from "../src/lib/mission/mission-concurrency.ts";
import {
  InMemoryIdempotencyStore,
  checkIdempotency,
  deriveIdempotencyKey,
} from "../src/lib/mission/mission-idempotency.ts";
import { projectMission, applyMissionEvent, emptyMissionProjection } from "../src/lib/mission/mission-projection.ts";
import {
  groupLegacyRunsIntoMissions,
  mapLegacyRunToMission,
  mapRunStatusToMissionState,
} from "../src/lib/mission/legacy-run-mapping.ts";

const reason: StateReason = {
  code: "test",
  summary: "test reason",
  relatedEntityIds: [],
  recoverable: true,
  suggestedActions: [],
};

let seq = 0;
function event(payload: MissionEventPayload, version: number, causationId: string | null = null): MissionEvent {
  seq += 1;
  return createMissionEvent({
    eventId: `evt-${seq}`,
    missionId: "m-1",
    aggregateVersion: version,
    actor: { kind: "system", id: "orchestrator" },
    correlationId: "corr-1",
    causationId,
    timestamp: `2026-07-24T00:00:${String(version).padStart(2, "0")}.000Z`,
    provenance: "system_inference",
    payload,
  });
}

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

test("the happy path from draft to accepted is fully legal", () => {
  const path: MissionState[] = [
    "draft", "planning", "ready", "initializing", "executing",
    "reviewing", "verifying", "ready_for_decision", "accepted",
  ];
  for (let i = 0; i < path.length - 1; i += 1) {
    const result = validateTransition({ from: path[i], to: path[i + 1] });
    assert.ok(result.ok, `${path[i]} → ${path[i + 1]} must be legal: ${result.errors.join("; ")}`);
    assert.equal(result.state, path[i + 1]);
  }
});

test("every declared transition in the table validates", () => {
  for (const from of MISSION_STATES) {
    for (const to of allowedTransitionsFrom(from)) {
      const result = validateTransition({
        from,
        to,
        reason: requiresReason(to) ? reason : null,
        resumeTo: (["needs_input", "blocked", "paused"] as const).includes(to as never) ? "executing" : null,
        recordedResumeTo: isActiveMissionState(to) ? "executing" : null,
      });
      // Resuming is only legal into the recorded target; the loop supplies
      // "executing", so other active targets are legitimately refused.
      const resumingElsewhere =
        (["needs_input", "blocked", "paused"] as readonly string[]).includes(from) &&
        isActiveMissionState(to as MissionState) &&
        to !== "executing";
      if (resumingElsewhere) continue;
      assert.ok(result.ok, `declared transition ${from} → ${to} failed: ${result.errors.join("; ")}`);
    }
  }
});

test("verifying can loop back to executing or reviewing", () => {
  assert.ok(validateTransition({ from: "verifying", to: "executing" }).ok);
  assert.ok(validateTransition({ from: "verifying", to: "reviewing" }).ok);
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

test("undeclared transitions are refused", () => {
  const illegal: Array<[MissionState, MissionState]> = [
    ["draft", "executing"],
    ["draft", "accepted"],
    ["planning", "verifying"],
    ["ready", "accepted"],
    ["executing", "accepted"],
    ["executing", "ready_for_decision"],
    ["reviewing", "accepted"],
    ["ready_for_decision", "executing"],
  ];
  for (const [from, to] of illegal) {
    const result = validateTransition({ from, to, reason, resumeTo: "executing" });
    assert.equal(result.ok, false, `${from} → ${to} must be illegal`);
    assert.match(result.errors.join(" "), /Illegal transition/);
    assert.equal(result.state, from, "a refused transition must not change state");
  }
});

test("a run cannot jump straight from executing to a decision", () => {
  // Guards the product rule that verification precedes a human decision.
  const result = validateTransition({ from: "executing", to: "ready_for_decision" });
  assert.equal(result.ok, false);
});

test("entering a non-happy-path state without a reason is refused", () => {
  for (const to of ["blocked", "failed", "cancelled"] as const) {
    const result = validateTransition({ from: "executing", to, resumeTo: "executing" });
    assert.equal(result.ok, false, `${to} must require a reason`);
    assert.match(result.errors.join(" "), /requires a structured reason/);
  }
});

test("interruptions must record where they resume to", () => {
  const result = validateTransition({ from: "executing", to: "paused", reason });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /requires a resume target/);
});

test("an interruption resumes only into the state it was interrupted from", () => {
  const ok = validateTransition({ from: "paused", to: "reviewing", recordedResumeTo: "reviewing" });
  assert.ok(ok.ok);

  const wrong = validateTransition({ from: "paused", to: "executing", recordedResumeTo: "reviewing" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.errors.join(" "), /cannot resume into/);
});

test("a resume target must be an active state", () => {
  const result = validateTransition({
    from: "executing",
    to: "blocked",
    reason,
    resumeTo: "accepted" as never,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /not an active state/);
});

// ---------------------------------------------------------------------------
// Terminal immutability (spec STATE_MODEL §16)
// ---------------------------------------------------------------------------

test("terminal states have no outbound transitions", () => {
  for (const terminal of TERMINAL_MISSION_STATES) {
    assert.deepEqual(MISSION_TRANSITIONS[terminal], [], `${terminal} must be terminal`);
  }
});

test("no transition out of a terminal state is permitted, to any state", () => {
  for (const from of TERMINAL_MISSION_STATES) {
    for (const to of MISSION_STATES) {
      const result = validateTransition({ from, to, reason, resumeTo: "executing", recordedResumeTo: "executing" });
      assert.equal(result.ok, false, `${from} → ${to} must be refused`);
      assert.match(result.errors.join(" "), /terminal/);
      assert.equal(result.state, from);
    }
  }
});

test("terminal immutability outranks an otherwise well-formed request", () => {
  // accepted → cancelled looks plausible but must still be refused.
  const result = validateTransition({ from: "accepted", to: "cancelled", reason });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /successor Mission/);
});

// ---------------------------------------------------------------------------
// Version conflicts (spec STATE_MODEL §13)
// ---------------------------------------------------------------------------

test("a matching expected version yields the next version", () => {
  const result = checkExpectedVersion({ missionId: "m-1", check: { expectedVersion: 4, currentVersion: 4 } });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.nextVersion, 5);
});

test("a stale expected version returns a 409 conflict with the cursor", () => {
  const result = checkExpectedVersion({
    missionId: "m-1",
    check: { expectedVersion: 3, currentVersion: 7 },
    latestEventCursor: "evt-99",
  });
  assert.equal(isConcurrencyConflict(result), true);
  if (!result.ok) {
    assert.equal(result.conflict.status, CONCURRENCY_CONFLICT_STATUS);
    assert.equal(result.conflict.code, "version_conflict");
    assert.equal(result.conflict.currentVersion, 7);
    assert.equal(result.conflict.latestEventCursor, "evt-99");
    assert.match(result.conflict.message, /stale/);
  }
});

test("an expected version ahead of current is also a conflict", () => {
  const result = checkExpectedVersion({ missionId: "m-1", check: { expectedVersion: 9, currentVersion: 2 } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.conflict.message, /ahead of/);
});

// ---------------------------------------------------------------------------
// Idempotency (spec STATE_MODEL §12)
// ---------------------------------------------------------------------------

test("the same command yields the same idempotency key", () => {
  const a = deriveIdempotencyKey({ missionId: "m-1", commandType: "START_MISSION", payload: { planVersion: 1 } });
  const b = deriveIdempotencyKey({ missionId: "m-1", commandType: "START_MISSION", payload: { planVersion: 1 } });
  assert.equal(a, b);
});

test("different commands, missions, or payloads yield different keys", () => {
  const base = deriveIdempotencyKey({ missionId: "m-1", commandType: "START_MISSION", payload: { planVersion: 1 } });
  assert.notEqual(base, deriveIdempotencyKey({ missionId: "m-2", commandType: "START_MISSION", payload: { planVersion: 1 } }));
  assert.notEqual(base, deriveIdempotencyKey({ missionId: "m-1", commandType: "STOP_MISSION", payload: { planVersion: 1 } }));
  assert.notEqual(base, deriveIdempotencyKey({ missionId: "m-1", commandType: "START_MISSION", payload: { planVersion: 2 } }));
});

test("a client-supplied key wins over the derived one", () => {
  const key = deriveIdempotencyKey({
    missionId: "m-1",
    commandType: "START_MISSION",
    clientKey: "client-123",
    payload: {},
  });
  assert.equal(key, "client-123");
});

test("a duplicate command replays the prior result instead of re-running", async () => {
  const store = new InMemoryIdempotencyStore<{ ran: number }>();
  const key = "k-1";

  assert.deepEqual(await checkIdempotency(store, key), { duplicate: false });
  await store.remember({
    key, missionId: "m-1", commandType: "START_MISSION",
    result: { ran: 1 }, recordedAt: "2026-07-24T00:00:00.000Z", aggregateVersion: 2,
  });

  const second = await checkIdempotency(store, key);
  assert.equal(second.duplicate, true);
  if (second.duplicate) assert.deepEqual(second.outcome.result, { ran: 1 });

  // A retry must not overwrite the original outcome.
  await store.remember({
    key, missionId: "m-1", commandType: "START_MISSION",
    result: { ran: 2 }, recordedAt: "2026-07-24T00:00:05.000Z", aggregateVersion: 3,
  });
  const third = await checkIdempotency(store, key);
  if (third.duplicate) assert.deepEqual(third.outcome.result, { ran: 1 }, "first write must win");
  assert.equal(store.size, 1);
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test("events are frozen after construction", () => {
  const e = event({ type: "mission.created", goal: "g", repository: "r", workspaceId: "ws-1", repositoryId: null }, 1);
  assert.ok(Object.isFrozen(e));
  assert.throws(() => {
    (e as unknown as { aggregateVersion: number }).aggregateVersion = 99;
  }, TypeError);
});

test("events carry actor, correlation, causation, version, and timestamp", () => {
  const e = event({ type: "mission.created", goal: "g", repository: "r", workspaceId: "ws-1", repositoryId: null }, 1);
  assert.equal(e.actor.kind, "system");
  assert.equal(e.correlationId, "corr-1");
  assert.equal(e.causationId, null);
  assert.equal(e.aggregateVersion, 1);
  assert.ok(e.timestamp);
  assert.ok(e.provenance);
});

test("a well-formed stream validates", () => {
  const a = event({ type: "mission.created", goal: "g", repository: "r", workspaceId: "ws-1", repositoryId: null }, 1);
  const b = event({ type: "mission.state_changed", previousState: "draft", nextState: "planning", resumeTo: null }, 2, a.eventId);
  assert.equal(validateEventSequence([a, b]).ok, true);
});

test("a version gap is reported, not tolerated", () => {
  const a = event({ type: "mission.created", goal: "g", repository: "r", workspaceId: "ws-1", repositoryId: null }, 1);
  const c = event({ type: "mission.state_changed", previousState: "draft", nextState: "planning", resumeTo: null }, 3, a.eventId);
  const result = validateEventSequence([a, c]);
  assert.equal(result.ok, false);
  assert.match(result.issues.map((i) => i.message).join(" "), /Version gap/);
});

test("causation pointing outside the stream is reported", () => {
  const a = event({ type: "mission.created", goal: "g", repository: "r", workspaceId: "ws-1", repositoryId: null }, 1);
  const b = event({ type: "mission.state_changed", previousState: "draft", nextState: "planning", resumeTo: null }, 2, "evt-missing");
  const result = validateEventSequence([a, b]);
  assert.equal(result.ok, false);
  assert.match(result.issues.map((i) => i.message).join(" "), /not in this stream/);
});

// ---------------------------------------------------------------------------
// Deterministic projections
// ---------------------------------------------------------------------------

function sampleStream(): MissionEvent[] {
  seq = 0;
  const a = event({ type: "mission.created", goal: "Add SSO", repository: "acme/app", workspaceId: "ws-1", repositoryId: null }, 1);
  const b = event({ type: "mission.plan_proposed", planVersion: 1 }, 2, a.eventId);
  const c = event({ type: "mission.plan_approved", planVersion: 1 }, 3, b.eventId);
  const d = event({ type: "mission.state_changed", previousState: "draft", nextState: "planning", resumeTo: null }, 4, c.eventId);
  const e = event({ type: "mission.participant_added", participantId: "codex" }, 5, d.eventId);
  const f = event({ type: "mission.evidence_attached", evidenceId: "ev-1", digest: "d1" }, 6, e.eventId);
  const g = event({ type: "mission.decision_recorded", decision: "accept", reviewedRevision: "abc123" }, 7, f.eventId);
  return [a, b, c, d, e, f, g];
}

test("projecting the same stream twice yields identical output", () => {
  const stream = sampleStream();
  assert.deepEqual(projectMission("m-1", stream), projectMission("m-1", stream));
});

test("a projection reflects every applied event", () => {
  const p = projectMission("m-1", sampleStream());
  assert.equal(p.goal, "Add SSO");
  assert.equal(p.repository, "acme/app");
  assert.equal(p.approvedPlanVersion, 1);
  assert.deepEqual(p.participantIds, ["codex"]);
  assert.deepEqual(p.attachedEvidenceIds, ["ev-1"]);
  assert.equal(p.decision, "accept");
  assert.equal(p.reviewedRevision, "abc123");
  assert.equal(p.aggregateVersion, 7);
  assert.equal(p.complete, true);
});

test("applying an event never mutates the input projection", () => {
  const before = emptyMissionProjection("m-1");
  const snapshot = JSON.stringify(before);
  applyMissionEvent(before, event({ type: "mission.participant_added", participantId: "codex" }, 1));
  assert.equal(JSON.stringify(before), snapshot, "reducer must be pure");
});

test("attachment and attestation are tracked separately", () => {
  seq = 0;
  const a = event({ type: "mission.created", goal: "g", repository: "r", workspaceId: "ws-1", repositoryId: null }, 1);
  const b = event({ type: "mission.evidence_attached", evidenceId: "ev-1", digest: "d" }, 2, a.eventId);
  const p = projectMission("m-1", [a, b]);
  assert.deepEqual(p.attachedEvidenceIds, ["ev-1"]);
  assert.deepEqual(p.attestedEvidenceIds, [], "system attachment must never imply human attestation");
});

test("a damaged stream projects but is honestly marked incomplete", () => {
  seq = 0;
  const a = event({ type: "mission.created", goal: "g", repository: "r", workspaceId: "ws-1", repositoryId: null }, 1);
  const c = event({ type: "mission.participant_added", participantId: "codex" }, 5, a.eventId);
  const p = projectMission("m-1", [a, c]);
  assert.equal(p.complete, false, "must not claim a complete history");
  assert.ok(p.integrityIssues.length > 0);
  assert.deepEqual(p.participantIds, ["codex"], "still inspectable");
});

test("a terminal state change marks the projection terminal", () => {
  seq = 0;
  const a = event({ type: "mission.created", goal: "g", repository: "r", workspaceId: "ws-1", repositoryId: null }, 1);
  const b = event({ type: "mission.state_changed", previousState: "ready_for_decision", nextState: "accepted", resumeTo: null }, 2, a.eventId);
  assert.equal(projectMission("m-1", [a, b]).terminal, true);
});

// ---------------------------------------------------------------------------
// Evidence: two independent axes
// ---------------------------------------------------------------------------

test("evidence lifecycle and availability are separate enums", () => {
  assert.deepEqual([...EVIDENCE_LIFECYCLE], ["captured", "validated", "attached", "attested", "accepted"]);
  assert.deepEqual([...EVIDENCE_AVAILABILITY], ["available", "invalid", "redacted", "unavailable"]);
  // No value may appear on both axes, or the two would collapse in practice.
  for (const l of EVIDENCE_LIFECYCLE) {
    assert.equal(isEvidenceAvailability(l), false, `${l} must not be an availability value`);
  }
  for (const a of EVIDENCE_AVAILABILITY) {
    assert.equal(isEvidenceLifecycle(a), false, `${a} must not be a lifecycle value`);
  }
});

test("attached-and-redacted is expressible — the axes are orthogonal", () => {
  assert.ok(isEvidenceLifecycle("attached"));
  assert.ok(isEvidenceAvailability("redacted"));
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("state guards accept only real states", () => {
  assert.ok(isMissionState("executing"));
  assert.equal(isMissionState("Working"), false);
  assert.equal(isMissionState("objective"), false);
  for (const s of ACTIVE_MISSION_STATES) assert.ok(isActiveMissionState(s));
  for (const s of TERMINAL_MISSION_STATES) assert.ok(isTerminalMissionState(s));
  assert.equal(isTerminalMissionState("executing"), false);
});

// ---------------------------------------------------------------------------
// Legacy Run mapping
// ---------------------------------------------------------------------------

test("legacy run statuses map to conservative mission states", () => {
  assert.equal(mapRunStatusToMissionState("started"), "initializing");
  assert.equal(mapRunStatusToMissionState("working"), "executing");
  assert.equal(mapRunStatusToMissionState("waiting_for_human"), "needs_input");
  assert.equal(mapRunStatusToMissionState("failed"), "failed");
  assert.equal(mapRunStatusToMissionState("expired"), "cancelled");
});

test("a completed run is ready_for_decision, never accepted", () => {
  // The agent finishing is not a human accepting the outcome.
  assert.equal(mapRunStatusToMissionState("completed"), "ready_for_decision");
  assert.equal(mapRunStatusToMissionState("submitted"), "ready_for_decision");
});

test("a run that is both completed_at and live is flagged, not trusted", () => {
  const view = mapLegacyRunToMission({
    id: "run-1", status: "working", taskTitle: "Fix drawer", repoHint: "acme/app",
    startedAt: "2026-07-01T00:00:00Z", completedAt: "2026-07-01T01:00:00Z", lastSeenAt: null,
  });
  assert.equal(view.inconsistencies.length > 0, true);
  assert.match(view.inconsistencies.join(" "), /completed_at/);
});

test("legacy views are labelled as derived and never fabricate a resume target", () => {
  const view = mapLegacyRunToMission({
    id: "run-2", status: "blocked", taskTitle: null, repoHint: null,
    startedAt: "2026-07-01T00:00:00Z", completedAt: null, lastSeenAt: null,
  });
  assert.equal(view.derivedFromLegacyRun, true);
  assert.equal(view.resumeTo, null);
  assert.equal(view.goal, "Untitled work");
  assert.ok(view.reason, "a blocked mission requires a reason");
});

test("re-runs of the same work collapse into one mission group", () => {
  const groups = groupLegacyRunsIntoMissions([
    { id: "r1", status: "failed", taskTitle: "Add SSO", repoHint: "acme/app", startedAt: "2026-07-01T00:00:00Z", completedAt: null, lastSeenAt: null },
    { id: "r2", status: "completed", taskTitle: "Add  SSO", repoHint: "acme/app", startedAt: "2026-07-02T00:00:00Z", completedAt: null, lastSeenAt: null },
    { id: "r3", status: "working", taskTitle: "Other work", repoHint: "acme/app", startedAt: "2026-07-03T00:00:00Z", completedAt: null, lastSeenAt: null },
  ]);
  assert.equal(groups.size, 2, "whitespace-different titles must group together");
});
