import assert from "node:assert/strict";
import test from "node:test";
import { createMultiplayerRunCoordinator, type RunCoordinatorEvent } from "../src/lib/native/multiplayer-run-coordinator";
import type { MultiplayerRoster } from "../src/lib/native/multiplayer-contract";

const roster: MultiplayerRoster = {
  runId: "run-2",
  agents: [
    { agentId: "agent-1", branchId: "branch-1", provider: "codex" },
    { agentId: "agent-2", branchId: "branch-2", provider: "claude" },
    { agentId: "agent-3", branchId: "branch-3", provider: "opencode" },
  ],
};

function operation(operationId: string, agentId: string, branchId: string, kind: "mutate" | "observe" = "mutate") {
  return {
    runId: roster.runId,
    branchId,
    agentId,
    operationId,
    surfaceId: "surface-1",
    revision: 1,
    kind,
    createdAt: 100,
  } as const;
}

test("stopping one agent cancels its queued and running actions without stopping siblings", () => {
  const coordinator = createMultiplayerRunCoordinator(roster, { now: () => 200, idFactory: () => "cancel-agent" });
  const first = coordinator.queue(operation("op-1", "agent-1", "branch-1"));
  const sibling = coordinator.queue(operation("op-2", "agent-2", "branch-2"));
  assert.equal(first.ok, true);
  assert.equal(sibling.ok, true);
  assert.equal(coordinator.start("op-1"), true);
  const action = first.ok ? first.value : undefined;
  assert.ok(action);
  const events: RunCoordinatorEvent[] = [];
  coordinator.subscribe((event) => events.push(event));
  const stopped = coordinator.stopAgent("agent-1");
  assert.equal(stopped.ok, true);
  assert.equal(action.signal.aborted, true);
  assert.equal(action.isCurrent(), false);
  assert.equal(coordinator.complete("op-1"), false, "late completion after stop is fenced");
  assert.equal(coordinator.start("op-2"), true, "a sibling remains runnable");
  assert.ok(events.some((event) => event.kind === "cancellation-propagated" && event.recipientAgentIds.includes("agent-1")));
});

test("stopping a run cancels every queued action and prevents late wakeups", () => {
  const coordinator = createMultiplayerRunCoordinator(roster, { now: () => 300, idFactory: () => "cancel-run" });
  const actions = [
    coordinator.queue(operation("op-1", "agent-1", "branch-1")),
    coordinator.queue(operation("op-2", "agent-2", "branch-2")),
    coordinator.queue(operation("op-3", "agent-3", "branch-3", "observe")),
  ];
  const stop = coordinator.stopRun("Owner stopped the whole task.");
  assert.equal(stop.ok, true);
  assert.deepEqual(coordinator.snapshot().actions.map((item) => item.state), ["canceled", "canceled", "canceled"]);
  assert.equal(coordinator.start("op-1"), false);
  assert.equal(coordinator.queue(operation("op-late", "agent-1", "branch-1")).ok, false);
  assert.equal(coordinator.snapshot().stopped, true);
});

test("branch cancellation propagates as one idempotent event and does not cancel another branch", () => {
  const coordinator = createMultiplayerRunCoordinator(roster, { now: () => 400, idFactory: () => "cancel-branch" });
  coordinator.queue(operation("op-1", "agent-1", "branch-1"));
  coordinator.queue(operation("op-2", "agent-2", "branch-2"));
  const first = coordinator.stopBranch("branch-1");
  assert.equal(first.ok, true);
  assert.equal(coordinator.start("op-1"), false);
  assert.equal(coordinator.start("op-2"), true);
  const duplicate = first.ok
    ? coordinator.requestCancellation({
      schemaVersion: 1,
      cancellationId: first.value.cancellationId,
      scope: { scope: "branch", runId: roster.runId, branchId: "branch-1" },
      reason: "duplicate",
      requestedAt: 401,
    })
    : { ok: false as const, error: "missing cancellation" };
  assert.equal(duplicate.ok, true);
  if (duplicate.ok) assert.equal(duplicate.value.duplicate, true);
});

test("pausing an operation preserves its identity and resumes without cancellation", () => {
  const coordinator = createMultiplayerRunCoordinator(roster, { now: () => 500, idFactory: () => "pause-id" });
  const queued = coordinator.queue(operation("op-pause", "agent-1", "branch-1"));
  assert.equal(queued.ok, true);
  assert.equal(coordinator.start("op-pause"), true);
  const action = queued.ok ? queued.value : undefined;
  assert.ok(action);
  assert.equal(coordinator.pause("op-pause", "Owner is redirecting this task."), true);
  assert.equal(action.signal.aborted, false);
  assert.equal(action.isCurrent(), false);
  assert.equal(coordinator.snapshot().actions.find((item) => item.operationId === "op-pause")?.state, "paused");
  assert.equal(coordinator.resume("op-pause"), true);
  assert.equal(action.signal.aborted, false);
  assert.equal(action.isCurrent(), true);
  assert.equal(coordinator.complete("op-pause"), true);
});
