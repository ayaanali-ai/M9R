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

test("startup settles orphaned owner work and strips transport room context from goals", () => {
  const root = mkdtempSync(join(resolve(".test-tmp"), "orphan-"));
  try {
    const store = createLocalStore(root);
    const identity = store.issueIdentity("codex", "codex", "orphan-session");
    const { task } = store.addTask({ from: "you", to: "codex", goal: "Open Chrome\n\nAlso in this room, not addressed by this message: @claude. They are listening.", origin: "human_typed", idempotencyKey: "orphan", targetSession: identity.sessionId });
    assert.equal(task.goal, "Open Chrome");
    store.markDelivered([task.id], identity.sessionId);
    store.setDelivery(task.id, { state: "queued", threadId: identity.sessionId });
    assert.equal(store.reconcileOrphanedOwnerTasks(["opencode"]), 0);
    assert.equal(store.reconcileOrphanedOwnerTasks(["codex"]), 1);
    assert.equal(store.getTask(task.id)?.receipt?.state, "failed");
    assert.deepEqual(store.getTask(task.id)?.completion?.remainingWork, ["Open Chrome"]);
    assert.equal(store.reconcileOrphanedOwnerTasks(["codex"]), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy provider admissions of incomplete work cannot become success", () => {
  for (const summary of ["I could not complete the requested change.", "Blocked on the exact target.", "Remaining work: verify the document.", "The task is incomplete."]) {
    assert.equal(taskCompletionReport(summary).status, "incomplete", summary);
    assert.equal(taskCompletionReport(summary, { status: "completed", remainingWork: [] }).status, "completed");
  }
  assert.equal(taskCompletionReport("Both requested changes are complete and verified.").status, "incomplete");
  assert.equal(taskCompletionReport("Both requested changes are complete and verified.", { status: "completed", remainingWork: [] }).status, "completed");
  assert.equal(taskCompletionReport("I couldn't switch to the Codex desktop app.").status, "incomplete");
  assert.throws(() => taskCompletionReport("done", { status: "completed", remainingWork: ["Required check"] }));
});
