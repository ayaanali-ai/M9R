import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMultiplayerRuntime } from "../src/lib/native/multiplayer-runtime";
import { createLocalStore } from "../src/lib/native/local-store";
import { applyAgentMcpStoreMutation } from "../src/lib/native/web-broker-server";

const roster = {
  runId: "run-runtime",
  agents: [
    { agentId: "agent-codex", branchId: "branch-codex", provider: "codex", handle: "codex" },
    { agentId: "agent-claude", branchId: "branch-claude", provider: "claude-code", handle: "claude" },
  ],
};

test("owner runtime accepts one structured teammate message and invokes delivery once", async () => {
  const delivered: string[] = [];
  const runtime = createMultiplayerRuntime({ roster, now: () => 100 });
  runtime.setDelivery((message) => { delivered.push(message.messageId); return { ok: true }; });
  const first = runtime.sendFromHandle("codex", "codex", {
    to: "claude", taskId: "task-1", summary: "Please verify the current page.", kind: "delegate",
    progressFingerprint: "page-1", progressKind: "observation", idempotencyKey: "handoff-1",
  });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.duplicate, false);
    assert.deepEqual(first.recipientAgentIds, ["agent-claude"]);
    assert.equal(runtime.snapshot().tasks[0]?.taskId, "task-1");
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  const duplicate = runtime.sendFromHandle("codex", "codex", {
    to: "claude", taskId: "task-1", summary: "Please verify the current page.", kind: "delegate", idempotencyKey: "handoff-1",
    progressFingerprint: "page-1", progressKind: "observation",
  });
  assert.equal(duplicate.ok, true);
  if (duplicate.ok) assert.equal(duplicate.duplicate, true);
  assert.equal(delivered.length, 1);
});

test("runtime control pauses a task without canceling its run", () => {
  const runtime = createMultiplayerRuntime({ roster, now: () => 100 });
  const sent = runtime.sendFromHandle("codex", "codex", { to: "claude", taskId: "task-2", summary: "Work together." });
  assert.equal(sent.ok, true);
  const result = runtime.applyControl({ controlId: "control-1", taskId: "task-2", kind: "pause", summary: "Owner is redirecting.", requestedAt: 110 });
  assert.equal(result.ok, true);
  assert.equal(result.context?.state, "paused-owner");
});

test("owner broker returns a complete structured A2A response for MCP callers", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-a2a-owner-"));
  const store = createLocalStore(root);
  const identity = store.issueIdentity("codex", "codex", "codex-session");
  const runtime = createMultiplayerRuntime({ roster });
  try {
    const input = {
      action: "a2a",
      token: identity.token,
      to: "claude",
      summary: "Verify the structured sidecar.",
      taskId: "task-owner-1",
      idempotencyKey: "owner-sidecar-1",
      progressFingerprint: "owner-observed-1",
      progressKind: "observation",
    } as const;
    const first = applyAgentMcpStoreMutation(store, input, runtime);
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.duplicate, false);
    assert.deepEqual(first.body.recipientAgentIds, ["agent-claude"]);
    assert.equal(typeof (first.body.message as { messageId?: unknown } | undefined)?.messageId, "string");

    const duplicate = applyAgentMcpStoreMutation(store, input, runtime);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.messageId, first.body.messageId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

