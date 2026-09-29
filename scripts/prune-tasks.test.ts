import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pruneTasks, type Task } from "../src/lib/native/inbox-core";
import { createLocalStore, MAX_STORED_TASKS } from "../src/lib/native/local-store";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-09-27T00:00:00Z");

function task(overrides: Partial<Task> & { id: string }): Task {
  const createdAt = overrides.createdAt ?? new Date(NOW - 30 * DAY).toISOString();
  const createdMs = Date.parse(createdAt);
  return {
    seq: 1, from: "a", to: "b", goal: "x", goalTruncated: false, pointers: [],
    origin: "human_typed", approval: "not_needed", replyDepth: 0, idempotencyKey: overrides.id,
    createdAt, deliveredAt: new Date(createdMs + DAY).toISOString(),
    resultSummary: "completed", resultShownAt: new Date(createdMs + 2 * DAY).toISOString(),
    ...overrides,
  };
}

test("pruneTasks never drops a task that is still pending, undelivered, or has an unseen answer, no matter how old", () => {
  const old = NOW - 60 * DAY;
  const tasks = [
    task({ id: "T1", createdAt: new Date(old).toISOString(), approval: "pending", deliveredAt: undefined }),
    task({ id: "T1-dismissed", createdAt: new Date(old).toISOString(), approval: "pending", dismissedAt: new Date(old).toISOString() }),
    task({ id: "T2", createdAt: new Date(old).toISOString(), deliveredAt: undefined }),
    task({ id: "T3", createdAt: new Date(old).toISOString(), resultSummary: "done", resultShownAt: undefined }),
  ];
  const kept = pruneTasks(tasks, { maxCount: 1, maxAgeMs: DAY, now: NOW });
  assert.deepEqual(kept.map((t) => t.id).sort(), ["T1", "T1-dismissed", "T2", "T3"]);
});

test("a delivered task with no result is still unresolved work, even if it is old or dismissed", () => {
  const inProgress = task({
    id: "in-progress",
    createdAt: new Date(NOW - 60 * DAY).toISOString(),
    resultSummary: undefined,
    resultShownAt: undefined,
    dismissedAt: new Date(NOW - 59 * DAY).toISOString(),
    delivery: { state: "queued", attempts: 1 },
  });
  assert.deepEqual(pruneTasks([inProgress], { maxCount: 0, maxAgeMs: DAY, now: NOW }), [inProgress]);
});

test("pruneTasks drops a fully-resolved task once it is older than maxAgeMs, and keeps one that is not old enough yet", () => {
  const tasks = [
    task({ id: "old-resolved", createdAt: new Date(NOW - 10 * DAY).toISOString() }),
    task({ id: "recent-resolved", createdAt: new Date(NOW - 1 * DAY).toISOString(), deliveredAt: new Date(NOW - 1 * DAY).toISOString() }),
  ];
  const kept = pruneTasks(tasks, { maxCount: 100, maxAgeMs: 7 * DAY, now: NOW });
  assert.deepEqual(kept.map((t) => t.id), ["recent-resolved"]);
});

test("a resolved task with an answer is not prunable until the sender has actually seen the answer", () => {
  const tasks = [task({ id: "T1", createdAt: new Date(NOW - 10 * DAY).toISOString(), resultSummary: "the answer", resultShownAt: undefined })];
  assert.deepEqual(pruneTasks(tasks, { maxCount: 100, maxAgeMs: DAY, now: NOW }).map((t) => t.id), ["T1"]);
  tasks[0].resultShownAt = new Date(NOW - 9 * DAY).toISOString();
  assert.deepEqual(pruneTasks(tasks, { maxCount: 100, maxAgeMs: DAY, now: NOW }), []);
});

test("even under budget pressure (too many resolved tasks are still too young to age out), unresolved tasks are never sacrificed to make room, and the most recent resolved ones win the remaining budget", () => {
  const tasks = [
    task({ id: "unresolved", createdAt: new Date(NOW - 1 * DAY).toISOString(), approval: "pending", deliveredAt: undefined }),
    ...Array.from({ length: 5 }, (_, i) => task({ id: `r${i}`, createdAt: new Date(NOW - (5 - i) * DAY).toISOString() })),
  ];
  const kept = pruneTasks(tasks, { maxCount: 3, maxAgeMs: 30 * DAY, now: NOW });
  assert.ok(kept.some((t) => t.id === "unresolved"), "the pending task survives even over budget");
  assert.equal(kept.length, 3, "budget is exceeded by exactly the unresolved task the prune refuses to drop");
  // the two most recently created resolved tasks are kept, not the oldest
  assert.deepEqual(kept.filter((t) => t.id !== "unresolved").map((t) => t.id).sort(), ["r3", "r4"]);
});

test("age-based cleanup runs even far under maxCount: a large count budget does not exempt an old resolved task", () => {
  const tasks = [task({ id: "T1", createdAt: new Date(NOW - 400 * DAY).toISOString() })];
  assert.deepEqual(pruneTasks(tasks, { maxCount: 2000, maxAgeMs: DAY, now: NOW }), []);
});

test("a recent task is kept regardless of how small maxCount is, as long as the age cutoff has room for it", () => {
  const tasks = [task({ id: "T1", createdAt: new Date(NOW - 1 * DAY).toISOString(), deliveredAt: new Date(NOW - 1 * DAY).toISOString() })];
  assert.deepEqual(pruneTasks(tasks, { maxCount: 2000, maxAgeMs: 7 * DAY, now: NOW }).map((t) => t.id), ["T1"]);
});

test("the local store backpressures new work at capacity without changing task ids or dropping existing work", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-task-capacity-"));
  try {
    const tasks = Array.from({ length: MAX_STORED_TASKS }, (_, index): Task => ({
      id: `T${index + 1}`, seq: index + 1, from: "codex", to: "claude", goal: "still waiting",
      goalTruncated: false, pointers: [], origin: "human_typed", approval: "not_needed", replyDepth: 0,
      idempotencyKey: `waiting-${index + 1}`, createdAt: new Date(NOW - DAY).toISOString(),
    }));
    const initial = {
      version: 1, nextTaskNo: MAX_STORED_TASKS + 1, nextSeq: { claude: MAX_STORED_TASKS }, tasks, cursors: {}, endpoints: {}, events: [],
      rules: [], nextRuleNo: 1, sessions: [], links: [], nextLinkNo: 1, identities: [],
    };
    const statePath = join(root, "state.json");
    writeFileSync(statePath, JSON.stringify(initial));
    const original = readFileSync(statePath);
    const store = createLocalStore(root, { now: () => new Date(NOW) });

    assert.throws(
      () => store.addTask({ from: "codex", to: "claude", goal: "new work", origin: "human_typed", idempotencyKey: "overflow" }),
      { name: "LocalTaskCapacityError" },
    );
    assert.deepEqual(readFileSync(statePath), original, "rejected work must not consume an id, cursor, or rewrite existing state");
    assert.equal(store.getTask(`T${MAX_STORED_TASKS}`)?.goal, "still waiting");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adding work contracts a 3,000-task file while retaining pending and unread user work", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-task-growth-"));
  try {
    const tasks = Array.from({ length: 3000 }, (_, index): Task => task({
      id: `T${index + 1}`,
      seq: index + 1,
      from: "codex",
      to: "claude",
      goal: `review room handoff ${"x".repeat(30)}`,
      idempotencyKey: `room-${index + 1}`,
      createdAt: new Date(NOW - ((index % 6) + 1) * DAY).toISOString(),
      deliveredAt: new Date(NOW - ((index % 6) + 1) * DAY).toISOString(),
      resultSummary: "complete",
      resultShownAt: new Date(NOW - ((index % 6) + 1) * DAY).toISOString(),
    }));
    tasks[0] = { ...tasks[0], approval: "pending", deliveredAt: undefined, resultSummary: undefined, resultShownAt: undefined };
    tasks[1] = { ...tasks[1], resultSummary: "unread", resultShownAt: undefined };
    const initial = {
      version: 1, nextTaskNo: 3001, nextSeq: { claude: 3000 }, tasks, cursors: {}, endpoints: {}, events: [],
      rules: [], nextRuleNo: 1, sessions: [], links: [], nextLinkNo: 1, identities: [],
    };
    const statePath = join(root, "state.json");
    writeFileSync(statePath, JSON.stringify(initial));
    const beforeBytes = readFileSync(statePath).byteLength;
    const store = createLocalStore(root, { now: () => new Date(NOW) });

    const added = store.addTask({ from: "codex", to: "claude", goal: "new room task", origin: "human_typed", idempotencyKey: "new-room-task" });
    const afterBytes = readFileSync(statePath).byteLength;
    const retained = store.tasksFor("claude");
    assert.ok(beforeBytes > 800_000, `fixture should exercise a large full-state rewrite (${beforeBytes} bytes)`);
    assert.ok(afterBytes < beforeBytes, `${beforeBytes} bytes should contract after pruning to ${afterBytes} bytes`);
    assert.equal(retained.length, MAX_STORED_TASKS);
    assert.ok(retained.some((item) => item.id === "T1"), "pending approval work remains stored");
    assert.ok(retained.some((item) => item.id === "T2"), "unread result remains stored");
    assert.ok(retained.some((item) => item.id === added.task.id), "new work is stored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
