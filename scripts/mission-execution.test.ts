/**
 * Mission execution supervision — Phase 2D.2 pure-domain tests
 *
 * Covers: the starting -> running -> {completed|failed|cancelled|lease_lost}
 * state machine, terminal-state guards on every transition, and the pure
 * recovery classification a restarted Runtime consults.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  beginExecution,
  cancelExecution,
  classifyOutstandingIntentForRecovery,
  completeExecution,
  isTerminalExecutionState,
  markLeaseLost,
  markRunning,
  recordHeartbeat,
  type ExecutionRecord,
} from "../src/lib/mission/mission-execution.ts";

const T0 = "2026-07-27T00:00:00.000Z";
function minutesAfterT0(mins: number): string {
  return new Date(Date.parse(T0) + mins * 60_000).toISOString();
}

function fresh(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return beginExecution({
    executionId: "exec-1",
    instructionId: "intent-1",
    missionId: "m-1",
    workspaceId: "ws-1",
    dispatchKey: "primary",
    leaseId: "lease-1",
    fencingToken: 1,
    attempt: 1,
    now: T0,
    ...overrides,
  });
}

test("beginExecution starts in 'starting' with lastHeartbeatAt set", () => {
  const record = fresh();
  assert.equal(record.state, "starting");
  assert.equal(record.lastHeartbeatAt, T0);
  assert.equal(record.endedAt, null);
});

test("markRunning transitions starting -> running", () => {
  const result = markRunning(fresh(), minutesAfterT0(1));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.record.state, "running");
});

test("recordHeartbeat updates lastHeartbeatAt and the tracked fencing token without changing state", () => {
  const running = markRunning(fresh(), T0);
  assert.ok(running.ok);
  if (!running.ok) return;
  const heartbeat = recordHeartbeat(running.record, minutesAfterT0(2), 5);
  assert.equal(heartbeat.ok, true);
  if (heartbeat.ok) {
    assert.equal(heartbeat.record.state, "running");
    assert.equal(heartbeat.record.lastHeartbeatAt, minutesAfterT0(2));
    assert.equal(heartbeat.record.fencingToken, 5);
  }
});

test("completeExecution with success: true reaches 'completed'", () => {
  const running = markRunning(fresh(), T0);
  assert.ok(running.ok);
  if (!running.ok) return;
  const result = completeExecution(running.record, minutesAfterT0(3), { success: true, summary: "done" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.record.state, "completed");
    assert.equal(result.record.endedAt, minutesAfterT0(3));
    assert.deepEqual(result.record.outcome, { success: true, summary: "done" });
  }
});

test("completeExecution with success: false reaches 'failed'", () => {
  const running = markRunning(fresh(), T0);
  assert.ok(running.ok);
  if (!running.ok) return;
  const result = completeExecution(running.record, minutesAfterT0(3), { success: false, summary: "boom" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.record.state, "failed");
});

test("cancelExecution reaches 'cancelled' with a reason", () => {
  const result = cancelExecution(fresh(), minutesAfterT0(1), "mission cancelled upstream");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.record.state, "cancelled");
    assert.equal(result.record.terminationReason, "mission cancelled upstream");
  }
});

test("markLeaseLost reaches 'lease_lost' with a reason", () => {
  const result = markLeaseLost(fresh(), minutesAfterT0(1), "renewal failed");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.record.state, "lease_lost");
    assert.equal(result.record.terminationReason, "renewal failed");
  }
});

test("every transition refuses once the record is already terminal", () => {
  for (const terminal of ["completed", "failed", "cancelled", "lease_lost"] as const) {
    const record: ExecutionRecord = { ...fresh(), state: terminal, endedAt: T0 };
    assert.equal(isTerminalExecutionState(record.state), true);

    for (const attempt of [
      () => markRunning(record, minutesAfterT0(1)),
      () => recordHeartbeat(record, minutesAfterT0(1), 2),
      () => completeExecution(record, minutesAfterT0(1), { success: true, summary: "x" }),
      () => cancelExecution(record, minutesAfterT0(1), "x"),
      () => markLeaseLost(record, minutesAfterT0(1), "x"),
    ]) {
      const result = attempt();
      assert.equal(result.ok, false, `expected refusal from terminal state ${terminal}`);
      if (!result.ok) assert.equal(result.error.code, "execution_already_terminal");
    }
  }
});

test("classifyOutstandingIntentForRecovery: an invalid fence closes as stale", () => {
  const classification = classifyOutstandingIntentForRecovery(false);
  assert.equal(classification.action, "close_as_stale");
});

test("classifyOutstandingIntentForRecovery: a still-valid fence is revoked and closed, never silently resumed", () => {
  const classification = classifyOutstandingIntentForRecovery(true);
  assert.equal(classification.action, "revoke_and_close");
});
