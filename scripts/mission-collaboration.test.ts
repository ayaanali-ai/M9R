/**
 * Mission collaboration — Phase 4A pure-domain tests
 *
 * Covers the participant and assignment transition tables and the
 * dependency-satisfaction check — all pure, independent of Mission.state.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { checkDependenciesSatisfied, validateAssignmentTransition, validateParticipantTransition } from "../src/lib/mission/mission-collaboration.ts";
import type { MissionAssignment } from "../src/lib/mission/mission-domain.ts";

test("participant: proposed -> active is legal in one step (no separate 'mark ready' command)", () => {
  const result = validateParticipantTransition("proposed", "active");
  assert.equal(result.ok, true);
});

test("participant: waiting -> active resumes, blocked -> active resumes", () => {
  assert.equal(validateParticipantTransition("waiting", "active").ok, true);
  assert.equal(validateParticipantTransition("blocked", "active").ok, true);
});

test("participant: removed is reachable from every non-terminal status", () => {
  for (const status of ["proposed", "ready", "active", "waiting", "blocked"] as const) {
    assert.equal(validateParticipantTransition(status, "removed").ok, true, `expected removed reachable from ${status}`);
  }
});

test("participant: a terminal status refuses every further transition, including a repeat removal", () => {
  for (const terminal of ["completed", "failed", "removed"] as const) {
    const result = validateParticipantTransition(terminal, "removed");
    assert.equal(result.ok, false);
  }
});

test("participant: an illegal jump (e.g. proposed -> completed) is refused", () => {
  const result = validateParticipantTransition("proposed", "completed");
  assert.equal(result.ok, false);
});

test("assignment: proposed -> claimed is legal in one step", () => {
  assert.equal(validateAssignmentTransition("proposed", "claimed").ok, true);
});

test("assignment: running -> submitted, submitted -> verified -> accepted", () => {
  assert.equal(validateAssignmentTransition("running", "submitted").ok, true);
  assert.equal(validateAssignmentTransition("submitted", "verified").ok, true);
  assert.equal(validateAssignmentTransition("verified", "accepted").ok, true);
});

test("assignment: submitted can also go straight to rejected (failed verification)", () => {
  assert.equal(validateAssignmentTransition("submitted", "rejected").ok, true);
});

test("assignment: cancelled is reachable from every non-terminal status this table allows", () => {
  for (const status of ["proposed", "ready", "claimed", "running", "waiting_for_input", "blocked"] as const) {
    assert.equal(validateAssignmentTransition(status, "cancelled").ok, true, `expected cancelled reachable from ${status}`);
  }
});

test("assignment: a terminal status refuses every further transition", () => {
  for (const terminal of ["accepted", "rejected", "cancelled", "failed"] as const) {
    assert.equal(validateAssignmentTransition(terminal, "running").ok, false);
  }
});

function assignment(overrides: Partial<MissionAssignment> = {}): MissionAssignment {
  return {
    id: "a-1",
    missionId: "m-1",
    assigneeParticipantId: null,
    title: "t",
    objective: "o",
    scope: { allowedPaths: ["."], prohibitedPaths: [] },
    dependencies: [],
    requiredEvidence: [],
    approvalPolicy: "auto",
    budget: { maxDurationMs: null, maxEstimatedTokens: null },
    status: "proposed",
    reviewerParticipantIds: [],
    dispatchKey: null,
    parentAssignmentId: null,
    originatingMessageId: null,
    delegatorParticipantId: null,
    delegationDepth: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

test("checkDependenciesSatisfied: no dependencies is trivially satisfied", () => {
  const result = checkDependenciesSatisfied(assignment({ dependencies: [] }), {});
  assert.equal(result.ok, true);
});

test("checkDependenciesSatisfied: a dependency that doesn't exist in the projection at all is never treated as satisfied", () => {
  const result = checkDependenciesSatisfied(assignment({ dependencies: ["ghost"] }), {});
  assert.equal(result.ok, false);
  assert.deepEqual(result.unsatisfied, ["ghost"]);
});

test("checkDependenciesSatisfied: only 'accepted' counts as done — 'verified' is not enough", () => {
  const dep = assignment({ id: "dep-1", status: "verified" });
  const result = checkDependenciesSatisfied(assignment({ dependencies: ["dep-1"] }), { "dep-1": dep });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unsatisfied, ["dep-1"]);
});

test("checkDependenciesSatisfied: an accepted dependency satisfies the check", () => {
  const dep = assignment({ id: "dep-1", status: "accepted" });
  const result = checkDependenciesSatisfied(assignment({ dependencies: ["dep-1"] }), { "dep-1": dep });
  assert.equal(result.ok, true);
});
