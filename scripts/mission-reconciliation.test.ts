/**
 * Mission reconciliation + legacy observation mapping — Phase 2A tests.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { reconcileMission } from "../src/lib/mission/mission-reconciliation.ts";
import {
  mapAssignmentStateToObservation,
  mapRunStatusToObservation,
} from "../src/lib/mission/legacy-observation-mapping.ts";

const MISSION_ID = "m-1";

function base() {
  return {
    missionId: MISSION_ID,
    legacyObservation: null,
    providerExecutionState: null,
    runtimeProcessState: null,
  } as const;
}

// ---------------------------------------------------------------------------
// The three named examples
// ---------------------------------------------------------------------------

test("provider completed, mission still executing → recoverable divergence proposing a normalized completion", () => {
  const outcome = reconcileMission({
    ...base(),
    missionState: "executing",
    providerExecutionState: "completed",
  });
  assert.equal(outcome.kind, "recoverable_divergence");
  if (outcome.kind === "recoverable_divergence") {
    assert.equal(outcome.proposedAction.type, "emit_normalized_completion");
  }
});

test("runtime process missing, provider state unknown → blocked divergence requiring the system reconciler", () => {
  const outcome = reconcileMission({
    ...base(),
    missionState: "executing",
    runtimeProcessState: "missing",
    providerExecutionState: "unknown",
  });
  assert.equal(outcome.kind, "blocked_divergence");
  if (outcome.kind === "blocked_divergence") {
    assert.equal(outcome.requiredAuthority, "system_reconciler");
  }
});

test("legacy run says failed, mission says accepted → integrity conflict, terminal mission is never overwritten", () => {
  const observation = mapRunStatusToObservation({ runId: "run-1", status: "failed", observedAt: "2026-07-24T00:00:00Z" });
  const outcome = reconcileMission({
    ...base(),
    missionState: "accepted",
    legacyObservation: observation,
  });
  assert.equal(outcome.kind, "blocked_divergence");
  if (outcome.kind === "blocked_divergence") {
    assert.equal(outcome.requiredAuthority, "human_review");
    assert.match(outcome.details.join(" "), /terminal/);
    assert.match(outcome.details.join(" "), /immutable/);
  }
});

// ---------------------------------------------------------------------------
// Consistent / unknown
// ---------------------------------------------------------------------------

test("a live mission whose signals agree is consistent", () => {
  const outcome = reconcileMission({
    ...base(),
    missionState: "executing",
    providerExecutionState: "working",
    runtimeProcessState: "running",
  });
  assert.equal(outcome.kind, "consistent");
});

test("a terminal mission with no conflicting signal is consistent", () => {
  const outcome = reconcileMission({ ...base(), missionState: "accepted" });
  assert.equal(outcome.kind, "consistent");
});

test("a terminal mission with an agreeing signal is consistent, not blocked", () => {
  const observation = mapRunStatusToObservation({ runId: "run-1", status: "completed", observedAt: null });
  const outcome = reconcileMission({ ...base(), missionState: "accepted", legacyObservation: observation });
  assert.equal(outcome.kind, "consistent");
});

test("no signal at all is unknown, never asserted as consistent", () => {
  const outcome = reconcileMission({ ...base(), missionState: "executing" });
  assert.equal(outcome.kind, "unknown");
});

test("draft/planning/ready missions with no signal are still unknown, not consistent by default", () => {
  for (const missionState of ["draft", "planning", "ready"] as const) {
    const outcome = reconcileMission({ ...base(), missionState });
    assert.equal(outcome.kind, "unknown", `${missionState} with no signal must be unknown`);
  }
});

// ---------------------------------------------------------------------------
// No silent auto-resolution — every non-consistent outcome is typed and
// carries either a proposed action or a required authority, never both
// missing.
// ---------------------------------------------------------------------------

test("recoverable divergence always carries a proposed action", () => {
  const outcome = reconcileMission({ ...base(), missionState: "reviewing", providerExecutionState: "completed" });
  assert.equal(outcome.kind, "recoverable_divergence");
  if (outcome.kind === "recoverable_divergence") assert.ok(outcome.proposedAction);
});

test("blocked divergence always carries a required authority", () => {
  const outcome = reconcileMission({ ...base(), missionState: "verifying", runtimeProcessState: "missing", providerExecutionState: "unknown" });
  assert.equal(outcome.kind, "blocked_divergence");
  if (outcome.kind === "blocked_divergence") assert.ok(outcome.requiredAuthority);
});

test("reconciliation never mutates its input", () => {
  const input = { ...base(), missionState: "executing" as const, providerExecutionState: "completed" as const };
  const snapshot = JSON.stringify(input);
  reconcileMission(input);
  assert.equal(JSON.stringify(input), snapshot);
});

// ---------------------------------------------------------------------------
// Legacy observation mapping — lossy notes are explicit, not silent
// ---------------------------------------------------------------------------

test("run status mapping is total over every real RunStatus value", () => {
  const statuses = ["started", "working", "blocked", "waiting_for_human", "submitted", "completed", "failed", "expired"] as const;
  for (const status of statuses) {
    const observation = mapRunStatusToObservation({ runId: "r", status, observedAt: null });
    assert.ok(observation.phase, `status ${status} must map to a phase`);
  }
});

test("a lossy run-status mapping records what it lost", () => {
  const observation = mapRunStatusToObservation({ runId: "r", status: "submitted", observedAt: null });
  assert.equal(observation.lossy, true);
  assert.ok(observation.lossNotes.length > 0);
  assert.match(observation.lossNotes.join(" "), /not that a human accepted/);
});

test("a non-lossy run-status mapping records no notes", () => {
  const observation = mapRunStatusToObservation({ runId: "r", status: "working", observedAt: null });
  assert.equal(observation.lossy, false);
  assert.deepEqual(observation.lossNotes, []);
});

test("assignment state mapping is total over every real AssignmentState value", () => {
  const states = ["requested", "accepted", "rejected", "cancelled", "expired", "completed"] as const;
  for (const state of states) {
    const observation = mapAssignmentStateToObservation({ assignmentId: "a", state, observedAt: null });
    assert.ok(observation.phase, `assignment state ${state} must map to a phase`);
  }
});

test("assignment 'rejected' is explicitly noted as lossy against the shared vocabulary", () => {
  const observation = mapAssignmentStateToObservation({ assignmentId: "a", state: "rejected", observedAt: null });
  assert.equal(observation.lossy, true);
  assert.match(observation.lossNotes.join(" "), /decision not to proceed/);
});

test("completed run and completed assignment both normalize to the same phase", () => {
  const runObs = mapRunStatusToObservation({ runId: "r", status: "completed", observedAt: null });
  const assignmentObs = mapAssignmentStateToObservation({ assignmentId: "a", state: "completed", observedAt: null });
  assert.equal(runObs.phase, "completed");
  assert.equal(assignmentObs.phase, "completed");
});

test("the mapping never fabricates an observedAt timestamp it wasn't given", () => {
  const observation = mapRunStatusToObservation({ runId: "r", status: "working", observedAt: null });
  assert.equal(observation.observedAt, null);
});
