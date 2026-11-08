import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "../src/lib/native/local-store";
import { createManagedA2ADelivery } from "../src/lib/native/managed-a2a-delivery";
import { createMultiplayerRuntime } from "../src/lib/native/multiplayer-runtime";
import { parseA2AMessage } from "../src/lib/native/multiplayer-contract";
import type { MultiplayerRoster } from "../src/lib/native/multiplayer-contract";

const roster: MultiplayerRoster = {
  runId: "managed-a2a-run",
  agents: [
    { agentId: "agent-codex", branchId: "branch-codex", provider: "codex", handle: "codex" },
    { agentId: "agent-claude", branchId: "branch-claude", provider: "claude-code", handle: "claude" },
  ],
};
const managedAgents = [{ handle: "codex" }, { handle: "claude" }];

test("managed A2A messages become session-pinned delegated tasks and link the reply", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-managed-a2a-roundtrip-"));
  const store = createLocalStore(root);
  const sessions: Record<string, string | undefined> = { codex: "codex-session-1", claude: "claude-session-1" };
  try {
    const ownerTask = store.addTask({
      from: "you", to: "codex", goal: "Check the page and ask Claude to verify one detail.",
      origin: "human_typed", idempotencyKey: "managed-a2a-owner-task", targetSession: "codex-session-1",
    }).task;
    store.markDelivered([ownerTask.id], "codex-session-1");

    const delivery = createManagedA2ADelivery({
      agents: managedAgents,
      store,
      sessionIdOf: (handle) => sessions[handle],
    });
    const runtime = createMultiplayerRuntime({ roster, delivery, now: () => 1_000 });
    const request = runtime.sendFromHandle("codex", "codex", {
      to: "claude", taskId: ownerTask.id, kind: "verification-request",
      summary: "Verify the visible page heading.", idempotencyKey: "managed-a2a-request",
    });
    assert.equal(request.ok, true);
    if (!request.ok) return;
    assert.equal(request.delivery?.state, "queued");
    const requestTaskId = request.delivery?.taskIds[0];
    assert.ok(requestTaskId);
    const requestTask = store.getTask(requestTaskId)!;
    assert.equal(requestTask.from, "codex");
    assert.equal(requestTask.to, "claude");
    assert.equal(requestTask.fromSession, sessions.codex);
    assert.equal(requestTask.targetSession, sessions.claude);
    assert.equal(requestTask.parentTaskId, ownerTask.id);
    assert.equal(requestTask.replyDepth, 1);
    assert.equal(requestTask.approval, "approved");
    assert.match(requestTask.goal, /kind=verification-request/);

    store.markDelivered([requestTaskId], sessions.claude);
    const reply = runtime.sendFromHandle("claude", "claude-code", {
      to: "codex", replyToMessageId: request.message.messageId,
      summary: "The heading is Example Domain.", idempotencyKey: "managed-a2a-reply",
    });
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    assert.equal(reply.message.taskId, ownerTask.id);
    assert.equal(reply.message.conversationId, request.message.conversationId);
    assert.equal(reply.message.replyDepth, 1, "A2A depth counts message exchanges; task depth also includes the owner-to-agent delegation");
    assert.equal(reply.delivery?.state, "queued");

    const replyTaskId = reply.delivery?.taskIds[0];
    assert.ok(replyTaskId);
    const replyTask = store.getTask(replyTaskId)!;
    assert.equal(replyTask.from, "claude");
    assert.equal(replyTask.to, "codex");
    assert.equal(replyTask.fromSession, sessions.claude);
    assert.equal(replyTask.targetSession, sessions.codex);
    assert.equal(replyTask.parentTaskId, requestTaskId);
    assert.equal(replyTask.replyToTaskId, requestTaskId);
    assert.equal(replyTask.replyDepth, 2);
    assert.equal(replyTask.approval, "approved");

    store.markDelivered([replyTaskId], sessions.codex);
    assert.ok(store.getTask(requestTaskId)?.answerPushedAt, "the original handoff is marked answered only after the reply reaches its pinned sender session");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed A2A delivery refuses when either provider session is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-managed-a2a-no-session-"));
  const store = createLocalStore(root);
  let claudeSession: string | undefined;
  try {
    const parent = store.addTask({
      from: "you", to: "codex", goal: "Coordinate one safe check.", origin: "human_typed",
      idempotencyKey: "managed-a2a-no-session-parent", targetSession: "codex-session",
    }).task;
    store.markDelivered([parent.id], "codex-session");
    const runtime = createMultiplayerRuntime({
      roster,
      delivery: createManagedA2ADelivery({
        agents: managedAgents,
        store,
        sessionIdOf: (handle) => handle === "codex" ? "codex-session" : claudeSession,
      }),
    });
    const input = { to: "claude", taskId: parent.id, summary: "Check the current page.", idempotencyKey: "managed-a2a-retry-after-connect" };
    const result = runtime.sendFromHandle("codex", "codex", input);
    assert.equal(result.ok, true, "the structured message can be recorded even if its provider delivery is blocked");
    if (!result.ok) return;
    assert.equal(result.delivery?.state, "failed");
    assert.match(result.delivery?.error ?? "", /No active managed provider session for @claude/);
    assert.equal(store.snapshot().tasks.length, 1, "no unpinned teammate task is created");

    claudeSession = "claude-session";
    const retry = runtime.sendFromHandle("codex", "codex", input);
    assert.equal(retry.ok, true);
    if (!retry.ok) return;
    assert.equal(retry.duplicate, true);
    assert.equal(retry.delivery?.state, "queued", "the same accepted message is retried once its recipient session becomes available");
    assert.equal(store.snapshot().tasks.length, 2);
    assert.equal(store.getTask(retry.delivery!.taskIds[0]!)?.targetSession, "claude-session");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed A2A delivery refuses to create approval-pending work outside an owner-authorized task", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-managed-a2a-no-parent-"));
  const store = createLocalStore(root);
  try {
    const runtime = createMultiplayerRuntime({
      roster,
      delivery: createManagedA2ADelivery({
      agents: managedAgents,
        store,
        sessionIdOf: (handle) => `${handle}-session`,
      }),
    });
    const result = runtime.sendFromHandle("codex", "codex", {
      to: "claude", summary: "Check the current page outside a delegated run.",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.delivery?.state, "failed");
    assert.match(result.delivery?.error ?? "", /No active owner-approved M9R task/);
    assert.equal(store.snapshot().tasks.length, 0, "the refused message must not leave a task waiting invisibly for approval");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an A2A reply fails closed when its parent task mapping has been evicted", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-managed-a2a-stale-parent-"));
  const store = createLocalStore(root);
  try {
    store.addTask({
      from: "you", to: "codex", goal: "Coordinate one safe check.", origin: "human_typed",
      idempotencyKey: "managed-a2a-stale-parent", targetSession: "codex-session",
    });
    const delivery = createManagedA2ADelivery({
      agents: managedAgents,
      store,
      sessionIdOf: (handle) => `${handle}-session`,
    });
    const parentMessageId = "message-from-old-runtime";
    const unmatchedReply = parseA2AMessage({
      schemaVersion: 1, runId: roster.runId, branchId: "branch-claude", agentId: "agent-claude",
      messageId: "reply-with-stale-parent", recipient: { kind: "agent", agentId: "agent-codex" },
      kind: "help-result", priority: "normal", idempotencyKey: "reply-with-stale-parent",
      createdAt: 100, summary: "The requested check is complete.", replyToMessageId: parentMessageId, replyDepth: 1,
    });
    const result = delivery(unmatchedReply);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /no longer available for a safe reply/);
    assert.equal(store.snapshot().tasks.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
