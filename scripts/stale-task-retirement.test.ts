import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "@/lib/native/local-store";
import { renderInboxInjection, type Task } from "@/lib/native/inbox-core";
import { canQueue } from "@/lib/native/codex-delivery-core";
import { stateLabel } from "@/lib/native/approval-commands";

test("stale queued, sending, and deferred work is permanently retired with history intact", () => {
  const fixture = join(process.cwd(), ".workcache", "native-test-fixtures");
  mkdirSync(fixture, { recursive: true });
  const root = mkdtempSync(join(fixture, "m9r-retire-"));
  let clock = new Date("2026-10-01T12:00:00Z");
  try {
    const store = createLocalStore(root, { now: () => clock });
    const tasks = (["deferred", "sending", "queued"] as const).map((state, index) => {
      const { task } = store.addTask({ from: "you", to: "codex", goal: `request ${index}`, origin: "human_typed", idempotencyKey: `retire-${index}` });
      store.setDelivery(task.id, { state });
      return store.getTask(task.id)!;
    });
    clock = new Date(clock.getTime() + 120_000);
    assert.equal(store.retireStaleTasks(60_000), 3);
    assert.equal(store.retireStaleTasks(60_000), 0);
    const restarted = createLocalStore(root, { now: () => clock });
    for (const previous of tasks) {
      const task = restarted.getTask(previous.id)!;
      assert.ok(task.retiredAt);
      assert.equal(stateLabel(task), "retired from live delivery; history retained");
      assert.deepEqual(task.delivery, previous.delivery);
      // A task still on a non-terminal receipt (accepted/dispatched/provider_received/started) when it
      // ages out can never be resolved by any later result, so retirement now closes its receipt out as
      // "uncertain" instead of leaving it looking like a live, in-flight turn forever.
      assert.notEqual(previous.receipt?.state, "uncertain", "the fixture's starting state must be non-terminal for this assertion to mean anything");
      assert.equal(task.receipt?.state, "uncertain");
      assert.equal(task.receipt?.history.at(-1)?.source, "system");
      assert.equal(task.goal, previous.goal);
      assert.equal(canQueue(task), false);
      assert.equal(restarted.claimCodexDelivery(task.id), undefined);
      assert.deepEqual(restarted.claimInboxTasks("codex", "new-m9r-context", [task.id]), []);
      restarted.setDelivery(task.id, { state: "deferred" });
      assert.deepEqual(restarted.getTask(task.id)!.delivery, previous.delivery);
    }
    assert.equal(renderInboxInjection(restarted.snapshot().tasks, 0, { now: clock.getTime(), maxAgeMs: Infinity }).includedIds.length, 0);
    assert.equal(restarted.snapshot().tasks.length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a task already paused, retryable, failed, or canceled when it ages out keeps its own receipt state", () => {
  const fixture = join(process.cwd(), ".workcache", "native-test-fixtures");
  mkdirSync(fixture, { recursive: true });
  const root = mkdtempSync(join(fixture, "m9r-retire-terminal-"));
  let clock = new Date("2026-10-01T12:00:00Z");
  try {
    const store = createLocalStore(root, { now: () => clock });
    const { task: pausedTask } = store.addTask({ from: "you", to: "codex", goal: "paused work", origin: "human_typed", idempotencyKey: "retire-paused" });
    store.pauseTask(pausedTask.id);
    const { task: failedTask } = store.addTask({ from: "you", to: "codex", goal: "failed work", origin: "human_typed", idempotencyKey: "retire-failed" });
    store.recordTaskFailure(failedTask.id, "provider crashed");
    clock = new Date(clock.getTime() + 120_000);
    assert.equal(store.retireStaleTasks(60_000), 2);
    assert.equal(store.getTask(pausedTask.id)?.receipt?.state, "paused");
    assert.equal(store.getTask(failedTask.id)?.receipt?.state, "failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retiring a task drops its raw stageTiming detail but keeps the aggregate summary", () => {
  // stageTiming is live diagnostic detail for a task still in flight; once
  // retired it never serves that purpose again, but nothing previously
  // stopped it from being written to disk forever. Confirmed live on
  // 2026-11-13: it alone accounted for ~59% of a 5.9 MB state.json, and
  // every write to this store pays for the whole file's size -- the direct
  // cause of that night's multi-minute lock-contention failures.
  const fixture = join(process.cwd(), ".workcache", "native-test-fixtures");
  mkdirSync(fixture, { recursive: true });
  const root = mkdtempSync(join(fixture, "m9r-retire-stagetiming-"));
  let clock = new Date("2026-10-01T12:00:00Z");
  try {
    const store = createLocalStore(root, { now: () => clock });
    const { task } = store.addTask({ from: "you", to: "codex", goal: "draw a shape", origin: "human_typed", idempotencyKey: "retire-stagetiming" });
    store.setDelivery(task.id, { state: "deferred" });
    const at = clock.toISOString();
    store.recordStageTiming(task.id, { phase: "action", startedAt: at, endedAt: at, durationMs: 5, status: "error", detail: "a real action error" });
    store.flushStageTiming();
    const beforeRetirement = store.getTask(task.id)!;
    assert.ok(beforeRetirement.stageTiming && beforeRetirement.stageTiming.length > 0, "the fixture must actually have raw stageTiming to prove it gets dropped");
    const summaryBefore = beforeRetirement.stageTimingSummary;
    assert.ok(summaryBefore?.action?.errorCount === 1, "the aggregate summary must already hold the same evidence the raw array holds");

    clock = new Date(clock.getTime() + 120_000);
    assert.equal(store.retireStaleTasks(60_000), 1);

    const retired = store.getTask(task.id)!;
    assert.deepEqual(retired.stageTiming, [], "raw per-event detail is dropped on retirement");
    assert.deepEqual(retired.stageTimingSummary, summaryBefore, "the aggregate summary survives retirement unchanged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid and future task timestamps never enter the generic inbox", () => {
  const base = { id: "T1", seq: 1, from: "you", to: "codex", goal: "do work", origin: "human_typed", approval: "not_needed" };
  for (const createdAt of ["invalid", "2030-01-01T00:00:00Z"]) {
    const result = renderInboxInjection([{ ...base, createdAt } as Task], 0, { now: Date.parse("2026-01-01T00:00:00Z") });
    assert.deepEqual(result.includedIds, []);
  }
});
