import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "../src/lib/native/local-store";

test("stage operation claims and final receipts survive LocalStore recreation and reject id reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-operation-receipt-"));
  try {
    const firstStore = createLocalStore(root);
    const identity = firstStore.issueIdentity("codex", "codex", "session-one");
    const task = firstStore.addTask({ from: "you", to: "codex", goal: "Use stage", origin: "human_typed", idempotencyKey: "stage-receipt" }).task;
    const operation = { handle: "codex", sessionId: identity.sessionId, taskId: task.id, operationId: "mcp-call-1", fingerprint: "a".repeat(64) };

    assert.equal(firstStore.claimStageOperation(operation).state, "claimed");
    assert.equal(createLocalStore(root).claimStageOperation(operation).state, "in_progress");
    assert.equal(firstStore.settleStageOperation({ ...operation, state: "applied" }), true);

    const restartedStore = createLocalStore(root);
    assert.equal(restartedStore.claimStageOperation(operation).state, "applied");
    assert.equal(restartedStore.claimStageOperation({ ...operation, fingerprint: "b".repeat(64) }).state, "conflict");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted stage operation remains uncertain and cannot be reclaimed", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-operation-uncertain-"));
  try {
    const store = createLocalStore(root);
    const identity = store.issueIdentity("codex", "codex", "session-one");
    const task = store.addTask({ from: "you", to: "codex", goal: "Use stage", origin: "human_typed", idempotencyKey: "stage-uncertain" }).task;
    const operation = { handle: "codex", sessionId: identity.sessionId, taskId: task.id, operationId: "mcp-call-2", fingerprint: "c".repeat(64) };

    assert.equal(store.claimStageOperation(operation).state, "claimed");
    assert.equal(store.settleStageOperation({ ...operation, state: "uncertain" }), true);
    assert.equal(createLocalStore(root).claimStageOperation(operation).state, "uncertain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
