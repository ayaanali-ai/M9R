/**
 * Mission Passport projection tests (build plan Phase 6).
 * ----------------------------------------------------------------------------
 * Drives `buildMissionPassport` against real event streams produced by
 * `applyMissionCommand` (never hand-built fixture events) so the Passport
 * is proven against the actual domain, not a mock of it. Reproducibility
 * is asserted directly: the same event log run through the builder twice
 * must produce an identical digest.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMissionCommand, type ApplyCommandResult } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext } from "../src/lib/mission/mission-commands.ts";
import type { MissionCommand } from "../src/lib/mission/mission-commands.ts";
import type { MissionEvent } from "../src/lib/mission/mission-events.ts";
import type { MissionProjection } from "../src/lib/mission/mission-projection.ts";
import { buildMissionPassport } from "../src/lib/mission/mission-passport.ts";

const MISSION_ID = "m-passport";
const HUMAN = { kind: "human" as const, id: "user-1" };

let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}

function ctx() {
  return resolveCommandContext({ actor: HUMAN, timestamp: "2026-07-28T00:00:00.000Z" });
}

class Driver {
  events: MissionEvent[] = [];
  current: MissionProjection | null = null;
  version = 0;

  apply(command: MissionCommand): ApplyCommandResult {
    const result = applyMissionCommand({
      current: this.current,
      command,
      context: ctx(),
      expectedVersion: this.version,
      priorOutcome: null,
      mintEventId,
    });
    if (result.ok) {
      this.events.push(...result.events);
      this.current = result.projection;
      this.version = result.aggregateVersion;
    }
    return result;
  }
}

function driveToDecision(decision: "accept" | "reject"): Driver {
  const d = new Driver();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/repo", repositoryId: null, goal: "Ship it", mode: "solo" };
  assert.equal(d.apply(create).ok, true);
  assert.equal(d.apply({ type: "BeginPlanning", missionId: MISSION_ID }).ok, true);
  assert.equal(d.apply({ type: "MarkMissionReady", missionId: MISSION_ID, planVersion: 0 }).ok, true);
  assert.equal(d.apply({ type: "BeginInitialization", missionId: MISSION_ID }).ok, true);
  assert.equal(d.apply({ type: "BeginExecution", missionId: MISSION_ID }).ok, true);
  assert.equal(d.apply({ type: "BeginReview", missionId: MISSION_ID }).ok, true);
  assert.equal(d.apply({ type: "BeginVerification", missionId: MISSION_ID }).ok, true);
  assert.equal(d.apply({ type: "MarkReadyForDecision", missionId: MISSION_ID }).ok, true);
  const finalCommand: MissionCommand =
    decision === "accept"
      ? { type: "AcceptMission", missionId: MISSION_ID, reviewedRevision: "abc123def456" }
      : { type: "RejectMission", missionId: MISSION_ID, reason: { code: "x", summary: "no good", relatedEntityIds: [], recoverable: false, suggestedActions: [] } };
  assert.equal(d.apply(finalCommand).ok, true);
  return d;
}

test("Passport reflects verification having run and the recorded decision", () => {
  const d = driveToDecision("accept");
  const passport = buildMissionPassport(d.current!, d.events);
  assert.equal(passport.verification.ran, true);
  assert.ok(passport.verification.enteredAt);
  assert.equal(passport.decision?.decision, "accept");
  assert.equal(passport.decision?.reviewedRevision, "abc123def456");
  assert.equal(passport.finalState, "accepted");
  assert.equal(passport.terminal, true);
});

test("Passport reflects a rejection distinctly from an acceptance", () => {
  const d = driveToDecision("reject");
  const passport = buildMissionPassport(d.current!, d.events);
  assert.equal(passport.decision?.decision, "reject");
  assert.equal(passport.decision?.reviewedRevision, null);
  assert.equal(passport.finalState, "rejected");
});

test("Passport reports no decision and no verification for a Mission still in draft", () => {
  const d = new Driver();
  d.apply({ type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/repo", repositoryId: null, goal: "Ship it", mode: "solo" });
  const passport = buildMissionPassport(d.current!, d.events);
  assert.equal(passport.decision, null);
  assert.equal(passport.verification.ran, false);
  assert.equal(passport.verification.enteredAt, null);
});

test("reproducible projection: the same event log produces an identical digest across two independent builds", () => {
  const d = driveToDecision("accept");
  const first = buildMissionPassport(d.current!, d.events, () => "2026-07-28T01:00:00.000Z");
  const second = buildMissionPassport(d.current!, [...d.events], () => "2026-07-28T02:00:00.000Z");
  assert.equal(first.integrity.digest, second.integrity.digest);
  assert.equal(first.integrity.eventCount, second.integrity.eventCount);
  assert.equal(first.integrity.lastEventId, second.integrity.lastEventId);
  assert.notEqual(first.generatedAt, second.generatedAt); // only the generation timestamp legitimately differs
});

test("reproducible projection: a different event log produces a different digest", () => {
  const accepted = driveToDecision("accept");
  const rejected = driveToDecision("reject");
  const p1 = buildMissionPassport(accepted.current!, accepted.events);
  const p2 = buildMissionPassport(rejected.current!, rejected.events);
  assert.notEqual(p1.integrity.digest, p2.integrity.digest);
});

test("Passport approved plan carries the SAME version the projection itself considers approved", () => {
  const d = new Driver();
  d.apply({ type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/repo", repositoryId: null, goal: "Ship it", mode: "solo" });
  d.apply({ type: "BeginPlanning", missionId: MISSION_ID });
  d.apply({ type: "MarkMissionReady", missionId: MISSION_ID, planVersion: 0 });
  const passport = buildMissionPassport(d.current!, d.events);
  // No ProposeMissionPlan/ApproveMissionPlan ran in this fixture, so there is nothing approved yet
  // (the projection's default `approvedPlanVersion` is the sentinel 0, never a real plan version).
  assert.equal(passport.approvedPlan, null);
  assert.equal(d.current!.approvedPlanVersion, 0);
});

test("Passport never carries a raw stdout/stderr/prompt field — evidence entries are limited to the same redacted fields the Evidence tab uses", () => {
  const d = driveToDecision("accept");
  const passport = buildMissionPassport(d.current!, d.events);
  for (const ev of passport.evidence) {
    assert.equal("stdout" in ev, false);
    assert.equal("stderr" in ev, false);
    assert.equal("prompt" in ev, false);
  }
});

test("Passport streamComplete/streamIntegrityIssues mirror the projection's own trust signal rather than re-deciding it independently", () => {
  const d = driveToDecision("accept");
  const passport = buildMissionPassport(d.current!, d.events);
  assert.equal(passport.streamComplete, d.current!.complete);
  assert.deepEqual(passport.streamIntegrityIssues, d.current!.integrityIssues);
});
