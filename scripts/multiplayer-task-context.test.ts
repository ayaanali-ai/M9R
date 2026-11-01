import assert from "node:assert/strict";
import test from "node:test";
import { createTaskContext, taskContextSchema } from "../src/lib/native/multiplayer-task-context";

const participants = [
  { agentId: "agent-1", branchId: "branch-1", provider: "codex" },
  { agentId: "agent-2", branchId: "branch-2", provider: "claude" },
] as const;

test("pause, resume, and redirect preserve one durable task and advance its plan", () => {
  const task = createTaskContext({ taskId: "task-1", conversationId: "conversation-1", runId: "run-1", participants, now: 100 });
  const paused = task.applyControl({ controlId: "control-pause", taskId: "task-1", kind: "pause", summary: "Owner is redirecting", requestedAt: 110 });
  assert.equal(paused.ok, true);
  assert.equal(task.snapshot().state, "paused-owner");
  const resumed = task.applyControl({ controlId: "control-resume", taskId: "task-1", kind: "resume", summary: "Continue the same work", requestedAt: 120 });
  assert.equal(resumed.ok, true);
  const redirected = task.applyControl({ controlId: "control-redirect", taskId: "task-1", kind: "redirect", summary: "Use the other tab", requestedAt: 130 });
  assert.equal(redirected.ok, true);
  assert.equal(task.snapshot().planRevision, 1);
  assert.equal(task.snapshot().taskId, "task-1");
});

test("duplicate progress enters waiting-agent instead of looping forever", () => {
  const task = createTaskContext({ taskId: "task-2", conversationId: "conversation-2", runId: "run-2", participants, now: 100 });
  for (let index = 0; index < 4; index += 1) {
    const result = task.recordProgress({ witnessId: `witness-${index}`, kind: "observation", stateFingerprint: "same-state", summary: "No new observable state", at: 110 + index });
    assert.equal(result.ok, true);
  }
  assert.equal(task.snapshot().state, "waiting-agent");
  assert.equal(task.snapshot().progress.noProgressStreak, 3);
  const changed = task.recordProgress({ witnessId: "witness-new", kind: "artifact-changed", stateFingerprint: "new-state", summary: "A new artifact was produced", at: 120 });
  assert.equal(changed.ok, true);
  assert.equal(task.snapshot().progress.noProgressStreak, 0);
});

test("dynamic assignments are idempotent and prevent silent double ownership", () => {
  const task = createTaskContext({ taskId: "task-3", conversationId: "conversation-3", runId: "run-3", participants, now: 100 });
  const first = task.claimAssignment({ assignmentId: "assignment-1", workKey: "research", agentId: "agent-1", planRevision: 0, status: "claimed", summary: "Research the source", updatedAt: 101 });
  assert.equal(first.ok, true);
  const duplicate = task.claimAssignment({ assignmentId: "assignment-1", workKey: "research", agentId: "agent-1", planRevision: 0, status: "claimed", summary: "Research the source", updatedAt: 101 });
  assert.equal(duplicate.ok, true);
  if (duplicate.ok) assert.equal(duplicate.duplicate, true);
  const conflict = task.claimAssignment({ assignmentId: "assignment-2", workKey: "research", agentId: "agent-2", planRevision: 0, status: "claimed", summary: "Research the source too", updatedAt: 102 });
  assert.equal(conflict.ok, false);
  assert.equal(task.snapshot().assignments.length, 1);
});

test("task snapshots are strict and never retain arbitrary prompt or credential fields", () => {
  const task = createTaskContext({ taskId: "task-4", conversationId: "conversation-4", runId: "run-4", participants, now: 100 });
  const snapshot = task.snapshot();
  assert.equal(taskContextSchema.safeParse(snapshot).success, true);
  assert.equal("prompt" in snapshot, false);
  assert.equal("password" in snapshot, false);
});

test("waiting for the owner and completion are explicit terminal transitions", () => {
  const task = createTaskContext({ taskId: "task-5", conversationId: "conversation-5", runId: "run-5", participants, now: 100 });
  assert.equal(task.requestUserInput(101).state, "waiting-user");
  assert.equal(task.applyControl({ controlId: "control-continue", taskId: "task-5", kind: "continuation", summary: "The owner answered", requestedAt: 102 }).ok, true);
  assert.equal(task.complete(103).state, "completed");
  const late = task.applyControl({ controlId: "control-late", taskId: "task-5", kind: "resume", summary: "Resume late", requestedAt: 104 });
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.code, "terminal");
});

