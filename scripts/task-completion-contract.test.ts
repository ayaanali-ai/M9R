import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { createLocalStore } from "../src/lib/native/local-store";
import { taskCompletionReport } from "../src/lib/native/task-completion-contract";
import { nextLogicalTaskContext, logicalTaskHandoff } from "../src/lib/native/logical-task-context";

test("incomplete work is preserved without a completed receipt or successful result", () => {
  const temp = resolve(".test-tmp"); mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, "completion-"));
  try {
    const store = createLocalStore(root);
    const identity = store.issueIdentity("codex", "codex", "completion-session");
    const { task } = store.addTask({ from: "you", to: "codex", goal: "Finish both requirements", origin: "human_typed", idempotencyKey: "completion", targetSession: identity.sessionId });
    store.markDelivered([task.id], identity.sessionId);
    assert.equal(store.recordTaskResult(identity.token, task.id, "First requirement done.", { status: "incomplete", remainingWork: ["Verify the second requirement"] }).ok, true);
    const saved = store.getTask(task.id)!;
    assert.equal(saved.receipt?.state, "paused");
    assert.equal(saved.resultSummary, undefined);
    assert.notEqual(saved.delivery?.state, "done");
    assert.deepEqual(saved.completion?.remainingWork, ["Verify the second requirement"]);
    const context = nextLogicalTaskContext({ ...saved, id: "T2", goal: "continue" }, saved, true);
    const handoff = logicalTaskHandoff({ ...saved, logicalContext: context });
    assert.match(handoff, /Verify the second requirement/);
    assert.equal(context.workId, saved.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy provider admissions of incomplete work cannot become success", () => {
  for (const summary of ["I could not complete the requested change.", "Blocked on the exact target.", "Remaining work: verify the document.", "The task is incomplete."]) {
    assert.equal(taskCompletionReport(summary).status, "incomplete", summary);
    assert.equal(taskCompletionReport(summary, { status: "completed", remainingWork: [] }).status, "incomplete");
  }
  assert.equal(taskCompletionReport("Both requested changes are complete and verified.").status, "completed");
  assert.throws(() => taskCompletionReport("done", { status: "completed", remainingWork: ["Required check"] }));
});
