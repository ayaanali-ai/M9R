import assert from "node:assert/strict";
import test from "node:test";
import { transitionMissionExecution, type MissionExecutionRecord } from "@/lib/mission/mission-execution-registry";

function started(): MissionExecutionRecord {
  return {
    executionId: "intent-1",
    missionId: "mission-1",
    workspaceId: "workspace-1",
    assignmentId: "assignment-1",
    dispatchIntentId: "intent-1",
    dispatchKey: "assignment-1",
    providerAdapterId: "codex",
    leaseId: "lease-1",
    fencingToken: "4",
    attempt: 1,
    status: "started",
    startedAt: "2026-07-26T00:00:00.000Z",
    terminalAt: null,
    terminalReason: null,
    resultDigest: null,
    evidenceIds: [],
    correlationId: "corr-1",
    causationId: null,
  };
}

test("execution registry accepts one terminal transition and exact terminal replay", () => {
  const first = transitionMissionExecution(started(), "completed", {
    timestamp: "2026-07-26T00:01:00.000Z",
    resultDigest: "sha256:result",
    evidenceIds: ["evidence-1"],
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.record.status, "completed");
  assert.deepEqual(first.record.evidenceIds, ["evidence-1"]);

  const replay = transitionMissionExecution(first.record, "completed", {
    timestamp: "2026-07-26T00:02:00.000Z",
    resultDigest: "sha256:result",
  });
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.record, first.record);
});

test("execution registry refuses a conflicting second terminal result", () => {
  const complete = transitionMissionExecution(started(), "completed", {
    timestamp: "2026-07-26T00:01:00.000Z",
    resultDigest: "sha256:result",
  });
  assert.equal(complete.ok, true);
  if (!complete.ok) return;
  const conflict = transitionMissionExecution(complete.record, "failed", {
    timestamp: "2026-07-26T00:02:00.000Z",
    reason: "late provider failure",
  });
  assert.deepEqual(conflict, { ok: false, code: "execution_already_terminal" });
});
