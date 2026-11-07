import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTaskLog } from "../src/lib/native/approval-commands";
import { createLocalStore } from "../src/lib/native/local-store";

test("task evidence records only validated build ids for the runtime that executed the task", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-task-build-evidence-"));
  const store = createLocalStore(root);
  const out: string[] = [];
  const err: string[] = [];
  const buildId = "ab".repeat(32);
  try {
    store.addTask({ from: "you", to: "claude", goal: "Run the assigned multiplayer check.", origin: "human_typed", idempotencyKey: "task-build-evidence" });
    assert.equal(store.recordTaskRuntimeBuild("T1", buildId), true);
    assert.equal(store.recordTaskRuntimeBuild("T1", "not-a-build-id"), false);
    assert.equal(store.recordTaskRuntimeBuild("T999", buildId), false);

    assert.equal(runTaskLog({ env: {}, out: (line) => out.push(line), err: (line) => err.push(line), confirm: async () => true }, root, "T1"), 0);
    const report = JSON.parse(out[0] ?? "null") as { task: { runtimeBuildIds: string[] } };
    assert.deepEqual(report.task.runtimeBuildIds, [buildId]);
    assert.deepEqual(err, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
