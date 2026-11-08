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
  runtime.setDelivery((message) => { delivered.push(message.messageId); return { ok: true, taskId: "T42" }; });
  const first = runtime.sendFromHandle("codex", "codex", {
    to: "claude", taskId: "task-1", summary: "Please verify the current page.", kind: "delegate",
    progressFingerprint: "page-1", progressKind: "observation", idempotencyKey: "handoff-1",
  });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.duplicate, false);
    assert.deepEqual(first.recipientAgentIds, ["agent-claude"]);
    assert.deepEqual(first.delivery, { state: "queued", taskIds: ["T42"] });
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

test("an identical retry reuses its message identity and retries failed durable delivery", () => {
  let deliveries = 0;
  const runtime = createMultiplayerRuntime({ roster, now: () => 100 });
  runtime.setDelivery(() => { deliveries += 1; return { ok: false, error: "task store at capacity" }; });
  const input = { to: "claude", taskId: "task-failed-delivery", summary: "Verify the current page." };
  const first = runtime.sendFromHandle("codex", "codex", input);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.delivery, { state: "failed", taskIds: [], error: "task store at capacity" });
  const retry = runtime.sendFromHandle("codex", "codex", input);
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.duplicate, true);
  assert.equal(retry.message.messageId, first.message.messageId);
  assert.deepEqual(retry.delivery, first.delivery);
  assert.equal(deliveries, 2, "a failed delivery is retried idempotently; the receiver task store prevents duplicates");
});

test("async teammate delivery changes from pending to durable queued on an idempotent retry", async () => {
  let finishDelivery: ((value: { ok: boolean; taskIds: readonly string[] }) => void) | undefined;
  const runtime = createMultiplayerRuntime({ roster, now: () => 100 });
  runtime.setDelivery(() => new Promise((resolve) => { finishDelivery = resolve; }));
  const input = { to: "claude", taskId: "async-delivery-task", summary: "Verify the current page.", idempotencyKey: "async-handoff-1" };
  const first = runtime.sendFromHandle("codex", "codex", input);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.delivery?.state, "pending");
  finishDelivery?.({ ok: true, taskIds: ["T52"] });
  await new Promise((resolve) => setImmediate(resolve));
  const retry = runtime.sendFromHandle("codex", "codex", input);
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.delivery, { state: "queued", taskIds: ["T52"] });
});

test("messages without a caller idempotency key dedupe retries only inside the short retry window", () => {
  const messageIds: string[] = [];
  let clock = 100;
  const runtime = createMultiplayerRuntime({ roster, now: () => clock });
  runtime.setDelivery((message) => { messageIds.push(message.messageId); return { ok: true, taskId: `T${messageIds.length}` }; });
  const input = { to: "claude", taskId: "repeatable-task", summary: "Please verify the visible page." };
  const first = runtime.sendFromHandle("codex", "codex", input);
  clock += 30_000;
  const second = runtime.sendFromHandle("codex", "codex", input);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.notEqual(first.message.messageId, second.message.messageId);
  assert.equal(messageIds.length, 2, "repeating wording after the default retry window is a new message");
});

test("structured replies inherit task context and derive bounded depth from their parent", () => {
  const runtime = createMultiplayerRuntime({ roster, now: () => 100 });
  const first = runtime.sendFromHandle("codex", "codex", {
    to: "claude", taskId: "shared-task", conversationId: "shared-conversation", summary: "Check the page.", replyDepth: 2,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const reply = runtime.sendFromHandle("claude", "claude-code", {
    to: "codex", replyToMessageId: first.message.messageId, summary: "The page shows Example Domain.", replyDepth: 0,
  });
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  assert.equal(reply.message.taskId, "shared-task");
  assert.equal(reply.message.conversationId, "shared-conversation");
  assert.equal(reply.message.replyDepth, 3, "the provider cannot reset exchange depth by passing zero");

  const overLimit = runtime.sendFromHandle("codex", "codex", {
    to: "claude", taskId: "bounded-task", summary: "Last allowed request.", replyDepth: 8,
  });
  assert.equal(overLimit.ok, true);
  if (!overLimit.ok) return;
  const refused = runtime.sendFromHandle("claude", "claude-code", {
    to: "codex", replyToMessageId: overLimit.message.messageId, summary: "Would exceed depth.",
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /bounded reply depth/);
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

