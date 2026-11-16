import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMultiplayerRuntime } from "../src/lib/native/multiplayer-runtime";
import { createMultiplayerInboxDelivery } from "../src/lib/native/multiplayer-inbox-delivery";
import { createLocalStore } from "../src/lib/native/local-store";
import { renderA2AConversation } from "../src/lib/native/inbox-core";
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
    assert.equal(first.delivery.state, "queued");
    assert.equal(first.delivery.taskId, "T42");
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

test("task progress witnesses stop repeated no-progress provider wakeups and resume on new progress", () => {
  const delivered: string[] = [];
  const runtime = createMultiplayerRuntime({
    roster,
    now: () => 100,
    delivery: (message) => { delivered.push(message.messageId); return { ok: true, taskId: `T${delivered.length}`, created: true }; },
  });
  let previousMessageId: string | undefined;
  const send = (index: number, fingerprint: string, kind: "observation" | "operation-completed" = "observation") => {
    const result = runtime.sendFromHandle("codex", "codex", {
      to: "claude",
      taskId: "shared-task-1",
      conversationId: "shared-conversation-1",
      summary: `Status update ${index}`,
      idempotencyKey: `progress-${index}`,
      progressFingerprint: fingerprint,
      progressKind: kind,
      ...(previousMessageId ? { replyToMessageId: previousMessageId } : {}),
    });
    if (result.ok) previousMessageId = result.message.messageId;
    return result;
  };

  for (let index = 1; index <= 2; index += 1) {
    const result = send(index, "same-state");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.delivery.state, "queued");
  }
  const stalled = send(3, "same-state");
  assert.equal(stalled.ok, true);
  if (stalled.ok) assert.equal(stalled.delivery.state, "held-no-progress");
  assert.equal(delivered.length, 2);
  assert.equal(runtime.snapshot().tasks[0]?.state, "waiting-agent");

  const resumed = send(4, "new-state", "operation-completed");
  assert.equal(resumed.ok, true);
  if (resumed.ok) assert.equal(resumed.delivery.state, "queued");
  assert.equal(delivered.length, 3);
  assert.equal(runtime.snapshot().tasks[0]?.state, "active");
});

test("restored task progress keeps no-progress protection active across broker restart", () => {
  const priorMessages = Array.from({ length: 4 }, (_, index) => ({
    messageId: `prior-message-${index + 1}`,
    taskId: "shared-task-restore",
    conversationId: "shared-conversation-restore",
    progressFingerprint: "same-state",
    progressKind: "observation" as const,
    summary: "The same page is still visible.",
    createdAt: index + 1,
  }));
  let deliveryCount = 0;
  const runtime = createMultiplayerRuntime({
    roster,
    now: () => 10,
    knownMessageReferences: priorMessages.map((message) => ({
      messageId: message.messageId,
      agentId: "agent-codex",
      recipientAgentIds: ["agent-claude"],
      taskId: message.taskId,
      conversationId: message.conversationId,
      replyDepth: 0,
    })),
    priorMessages,
    delivery: () => { deliveryCount += 1; return { ok: true, taskId: "T-restored" }; },
  });
  const result = runtime.sendFromHandle("claude", "claude-code", {
    to: "codex",
    taskId: "shared-task-restore",
    conversationId: "shared-conversation-restore",
    summary: "Still no change.",
    idempotencyKey: "after-restart",
    progressFingerprint: "same-state",
    progressKind: "observation",
    replyToMessageId: "prior-message-4",
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.delivery.state, "held-no-progress");
  assert.equal(deliveryCount, 0);
});

test("runtime control pauses a task without canceling its run", () => {
  const runtime = createMultiplayerRuntime({ roster, now: () => 100 });
  const sent = runtime.sendFromHandle("codex", "codex", {
    to: "claude", taskId: "task-2", summary: "Work together.",
    progressFingerprint: "work-plan-1", progressKind: "observation",
  });
  assert.equal(sent.ok, true);
  const result = runtime.applyControl({ controlId: "control-1", taskId: "task-2", kind: "pause", summary: "Owner is redirecting.", requestedAt: 110 });
  assert.equal(result.ok, true);
  assert.equal(result.context?.state, "paused-owner");
});

test("task-scoped replies inherit their parent thread and taskless roots are refused", () => {
  const runtime = createMultiplayerRuntime({ roster, now: () => 100 });
  const first = runtime.sendFromHandle("codex", "codex", {
    to: "claude", taskId: "shared-task-3", summary: "Can you verify this observation?",
    progressFingerprint: "page-state-1", progressKind: "observation",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const reply = runtime.sendFromHandle("claude", "claude-code", {
    to: "codex",
    taskId: "shared-task-3",
    summary: "I verified it against the current state.",
    replyToMessageId: first.message.messageId,
    idempotencyKey: "taskless-reply-1",
    progressFingerprint: "page-state-2",
    progressKind: "postcondition-verified",
  });
  assert.equal(reply.ok, true);
  if (reply.ok) {
    assert.equal(reply.message.conversationId, first.message.conversationId);
    assert.equal(reply.message.replyDepth, 1);
  }
  const sameSummaryAfterProgress = runtime.sendFromHandle("codex", "codex", {
    to: "claude",
    taskId: "shared-task-3",
    summary: "Can you verify this observation?",
    replyToMessageId: reply.ok ? reply.message.messageId : first.message.messageId,
    progressFingerprint: "page-state-after-peer-check",
    progressKind: "operation-completed",
  });
  assert.equal(sameSummaryAfterProgress.ok, true);
  if (sameSummaryAfterProgress.ok) assert.equal(sameSummaryAfterProgress.duplicate, false);
  const taskless = runtime.sendFromHandle("codex", "codex", { to: "claude", summary: "A separate quick question." });
  assert.equal(taskless.ok, false);
  if (!taskless.ok) assert.match(taskless.error, /must belong to a shared task/);
  const missingWitness = runtime.sendFromHandle("codex", "codex", { to: "claude", taskId: "shared-task-3", summary: "No evidence attached." });
  assert.equal(missingWitness.ok, false);
  if (!missingWitness.ok) assert.match(missingWitness.error, /progressFingerprint and progressKind/);
});

test("a reply stays bound to the thread's own task even when the replier passes its own different per-recipient task id", () => {
  // M9R creates one inbox task per recipient from a single owner broadcast --
  // there is no shared "room id" the model is told to use, so each agent only
  // knows its own private task id (e.g. Claude's T448 vs Codex's T445 for the
  // "same" conversation). Live repro: Codex's reply carried its own task id
  // and M9R rejected it as bound to a different task, forcing Claude to take
  // over Codex's half of the work instead of the handoff completing cleanly.
  const runtime = createMultiplayerRuntime({ roster, now: () => 100 });
  const first = runtime.sendFromHandle("claude", "claude-code", {
    to: "codex", taskId: "T448", summary: "Proposal: Charleston, $700. Your take?",
    progressFingerprint: "trip-proposal-1", progressKind: "observation",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const reply = runtime.sendFromHandle("codex", "codex", {
    to: "claude",
    taskId: "T445",
    summary: "Agreed: Charleston, $700.",
    replyToMessageId: first.message.messageId,
    idempotencyKey: "trip-reply-1",
    progressFingerprint: "trip-agreement-1",
    progressKind: "observation",
  });
  assert.equal(reply.ok, true);
  if (reply.ok) {
    assert.equal(reply.message.taskId, "T448");
    assert.equal(reply.message.conversationId, first.message.conversationId);
    assert.equal(reply.message.replyDepth, 1);
  }
});

test("legacy taskless messages can only continue through an exact known parent", () => {
  const runtime = createMultiplayerRuntime({
    roster,
    now: () => 100,
    knownMessageReferences: [{
      messageId: "legacy-root-message",
      agentId: "agent-codex",
      recipientAgentIds: ["agent-claude"],
      replyDepth: 0,
    }],
  });
  const reply = runtime.sendFromHandle("claude", "claude-code", {
    to: "codex",
    summary: "I am continuing the exact legacy thread.",
    replyToMessageId: "legacy-root-message",
    idempotencyKey: "legacy-reply-1",
  });
  assert.equal(reply.ok, true);
  if (reply.ok) {
    assert.equal(reply.message.replyToMessageId, "legacy-root-message");
    assert.equal(reply.message.taskId, undefined);
    assert.equal(reply.message.conversationId, undefined);
    assert.equal(reply.message.replyDepth, 1);
  }
  const newRoot = runtime.sendFromHandle("codex", "codex", {
    to: "claude",
    summary: "A new taskless root must still be refused.",
  });
  assert.equal(newRoot.ok, false);
});

test("owner broker queues one durable peer conversation item and returns its real task id", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-a2a-owner-"));
  const store = createLocalStore(root);
  const identity = store.issueIdentity("codex", "codex", "codex-session");
  const claudeIdentity = store.issueIdentity("claude", "claude-code", "claude-session");
  let deliveryCount = 0;
  const inboxDelivery = createMultiplayerInboxDelivery({
    store,
    agents: roster.agents.map((agent) => ({ handle: agent.handle!, agentId: agent.agentId })),
    sessionIdOf: (handle) => handle === "codex" ? "codex-session" : "claude-session",
  });
  const runtime = createMultiplayerRuntime({
    roster,
    initialTaskContexts: store.listMultiplayerTaskContexts(),
    persistTaskContext: (context) => { store.setMultiplayerTaskContext(context); },
    delivery: (message, context) => {
      deliveryCount += 1;
      return inboxDelivery(message, context);
    },
  });
  try {
    const input = {
      action: "a2a",
      token: identity.token,
      to: "claude",
      summary: "Verify the structured sidecar.",
      taskId: "task-owner-1",
      idempotencyKey: "owner-sidecar-1",
      details: { source: "owner test", verified: true },
      progressFingerprint: "owner-observed-1",
      progressKind: "observation",
    } as const;
    const first = applyAgentMcpStoreMutation(store, input, runtime);
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.duplicate, false);
    assert.deepEqual(first.body.recipientAgentIds, ["agent-claude"]);
    assert.equal(typeof (first.body.message as { messageId?: unknown } | undefined)?.messageId, "string");
    assert.equal(first.body.taskId, "T1");
    assert.deepEqual(first.body.delivery, { state: "queued", taskId: "T1", created: true });
    const stored = store.getTask("T1");
    assert.equal(stored?.coordination?.intent, "message");
    assert.equal(stored?.a2a?.conversationId, (first.body.message as { conversationId: string }).conversationId);
    assert.equal(stored?.a2a?.messageId, first.body.messageId);
    assert.equal(stored?.fromSession, "codex-session");
    assert.equal(stored?.delivery?.state, "deferred");
    assert.equal(stored?.a2a?.wireMessage?.details?.verified, true);

    const claim = applyAgentMcpStoreMutation(store, {
      action: "claim_work",
      token: identity.token,
      taskId: "task-owner-1",
      assignmentId: "sidecar-claim-1",
      workKey: "sidecar-verify",
      summary: "Verify the owner broker sidecar and inspect its durable receipt.",
    }, runtime);
    assert.equal(claim.status, 200);
    assert.equal((claim.body.context as { assignments: Array<{ agentId: string; status: string }> }).assignments[0]?.agentId, "agent-codex");
    const conflictingClaim = applyAgentMcpStoreMutation(store, {
      action: "claim_work",
      token: claudeIdentity.token,
      taskId: "task-owner-1",
      assignmentId: "sidecar-claim-2",
      workKey: "sidecar-verify",
      summary: "Verify the same owner broker sidecar.",
    }, runtime);
    assert.equal(conflictingClaim.status, 409);
    const sharedState = applyAgentMcpStoreMutation(store, { action: "task_state", token: claudeIdentity.token, taskId: "task-owner-1" }, runtime);
    assert.equal(sharedState.status, 200);
    assert.equal((sharedState.body.context as { assignments: Array<{ assignmentId: string }> }).assignments[0]?.assignmentId, "sidecar-claim-1");
    const replayed = inboxDelivery(first.body.message as import("../src/lib/native/multiplayer-contract").A2AMessage);
    assert.deepEqual(replayed, { ok: true, taskId: "T1", created: false, state: "already-present" });
    const firstMessage = first.body.message as { messageId: string; conversationId: string };
    const reply = applyAgentMcpStoreMutation(store, {
      action: "a2a",
      token: claudeIdentity.token,
      to: "codex",
      summary: "I verified the sidecar against the shared task state.",
      taskId: "task-owner-1",
      conversationId: firstMessage.conversationId,
      replyToMessageId: firstMessage.messageId,
      idempotencyKey: "claude-sidecar-reply-1",
      progressFingerprint: "claude-verified-1",
      progressKind: "postcondition-verified",
    }, runtime);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.delivery?.state, "queued");
    assert.equal(reply.body.taskId, "T2");
    assert.equal(store.getTask("T2")?.fromSession, "claude-session");
    assert.equal(store.getTask("T2")?.a2a?.replyToMessageId, firstMessage.messageId);
    const claudeTranscript = renderA2AConversation(store.snapshot().tasks, stored!.a2a!.conversationId, { handle: "claude", sessionId: "claude-session" });
    const codexTranscript = renderA2AConversation(store.snapshot().tasks, stored!.a2a!.conversationId, { handle: "codex", sessionId: "codex-session" });
    assert.match(claudeTranscript.text, /Verify the structured sidecar/);
    assert.match(claudeTranscript.text, /I verified the sidecar/);
    assert.match(claudeTranscript.text, /"verified":true/);
    assert.match(codexTranscript.text, /Verify the structured sidecar/);
    assert.match(codexTranscript.text, /I verified the sidecar/);
    assert.equal(renderA2AConversation(store.snapshot().tasks, stored!.a2a!.conversationId, { handle: "opencode", sessionId: "opencode-session" }).count, 0);

    const completedWork = applyAgentMcpStoreMutation(store, {
      action: "complete_work",
      token: identity.token,
      taskId: "task-owner-1",
      assignmentId: "sidecar-claim-1",
    }, runtime);
    assert.equal(completedWork.status, 200);
    assert.equal((completedWork.body.context as { assignments: Array<{ status: string }> }).assignments[0]?.status, "completed");
    const wrongOwnerRelease = applyAgentMcpStoreMutation(store, {
      action: "release_work",
      token: claudeIdentity.token,
      taskId: "task-owner-1",
      assignmentId: "sidecar-claim-1",
    }, runtime);
    assert.equal(wrongOwnerRelease.status, 409);

    const duplicate = applyAgentMcpStoreMutation(store, input, runtime);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.messageId, first.body.messageId);
    assert.equal(deliveryCount, 2);
    assert.equal(store.snapshot().tasks.length, 2);

    const restartedStore = createLocalStore(root);
    const persistedTasks = restartedStore.snapshot().tasks;
    const restartedInboxDelivery = createMultiplayerInboxDelivery({
      store: restartedStore,
      agents: roster.agents.map((agent) => ({ handle: agent.handle!, agentId: agent.agentId })),
      sessionIdOf: (handle) => handle === "codex" ? "codex-session" : "claude-session",
    });
    const restoredRuntime = createMultiplayerRuntime({
      roster,
      initialTaskContexts: restartedStore.listMultiplayerTaskContexts(),
      persistTaskContext: (context) => { restartedStore.setMultiplayerTaskContext(context); },
      knownMessages: persistedTasks.flatMap((task) => task.a2a?.wireMessage ? [task.a2a.wireMessage] : []),
      knownMessageReferences: persistedTasks.flatMap((task) => task.a2a ? [{
        messageId: task.a2a.messageId,
        agentId: task.a2a.senderAgentId,
        recipientAgentIds: [task.a2a.recipientAgentId],
        taskId: task.a2a.taskId,
        conversationId: task.a2a.conversationId,
        replyDepth: task.a2a.replyDepth,
      }] : []),
      priorMessages: persistedTasks.flatMap((task) => task.a2a?.progressFingerprint && task.a2a.progressKind ? [{
        messageId: task.a2a.messageId,
        taskId: task.a2a.taskId,
        conversationId: task.a2a.conversationId,
        progressFingerprint: task.a2a.progressFingerprint,
        progressKind: task.a2a.progressKind,
        summary: task.a2a.summary,
        createdAt: Date.parse(task.createdAt),
      }] : []),
      delivery: restartedInboxDelivery,
    });
    const restoredState = restoredRuntime.readTaskContext(claudeIdentity, "task-owner-1");
    assert.equal(restoredState.ok, true);
    assert.equal(restoredState.context?.assignments[0]?.status, "completed");
    const retryAfterRestart = restoredRuntime.sendFromHandle("codex", "codex", input);
    assert.equal(retryAfterRestart.ok, true);
    if (retryAfterRestart.ok) {
      assert.equal(retryAfterRestart.duplicate, true);
      assert.equal(retryAfterRestart.message.messageId, first.body.messageId);
      assert.deepEqual(retryAfterRestart.delivery, { state: "already-present", taskId: "T1", created: false });
    }
    assert.equal(store.snapshot().tasks.length, 2, "a broker restart retry must not create a second recipient turn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a delegation always has durable message identity instead of an inline turn on an unrelated active broadcast", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-a2a-durable-"));
  const store = createLocalStore(root);
  let inlineTurns = 0;
  const options = { store, agents: roster.agents.map(agent => ({ handle: agent.handle!, agentId: agent.agentId })),
    sessionIdOf: (handle: string) => `${handle}-session`,
    wakeRecipient: () => { inlineTurns++; return { ok: true }; } };
  const runtime = createMultiplayerRuntime({ roster, delivery: createMultiplayerInboxDelivery(options) });
  try {
    const oldSender = store.addTask({ from: "you", to: "claude", goal: "Old shared work", origin: "human_typed", idempotencyKey: "old-sender", broadcastId: "old-broadcast" }).task;
    const oldRecipient = store.addTask({ from: "you", to: "codex", goal: "Old shared work", origin: "human_typed", idempotencyKey: "old-recipient", broadcastId: "old-broadcast" }).task;
    const current = store.addTask({ from: "you", to: "claude", goal: "Current independent work", origin: "human_typed", idempotencyKey: "current-sender", broadcastId: "current-broadcast" }).task;
    const sent = runtime.sendFromHandle("claude", "claude-code", { to: "codex", taskId: current.id, summary: "Please check this new result", kind: "delegate",
      progressFingerprint: "new-result", progressKind: "postcondition-verified" });
    assert.equal(sent.ok, true);
    if (!sent.ok) return;
    const stored = store.getTask(sent.delivery.taskId!)!;
    assert.equal(stored.a2a?.messageId, sent.message.messageId);
    assert.equal(stored.a2a?.taskId, current.id);
    assert.equal(stored.targetSession, "codex-session");
    assert.equal(inlineTurns, 0);
    assert.equal(store.getTask(oldRecipient.id)?.deliveredAt, undefined);
    assert.equal(store.getTask(oldSender.id)?.resultSummary, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a shared-broadcast conversation stays durable and retries do not create another message or assignment", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-a2a-broadcast-"));
  const store = createLocalStore(root);
  const runtime = createMultiplayerRuntime({ roster, delivery: createMultiplayerInboxDelivery({ store,
    agents: roster.agents.map(agent => ({ handle: agent.handle!, agentId: agent.agentId })),
    sessionIdOf: handle => handle === "codex" ? "codex-session" : "claude-session" }) });
  try {
    const sender = store.addTask({ from: "you", to: "claude", goal: "Shared work", origin: "human_typed", idempotencyKey: "sender", broadcastId: "shared" }).task;
    const recipient = store.addTask({ from: "you", to: "codex", goal: "Shared work", origin: "human_typed", idempotencyKey: "recipient", broadcastId: "shared" }).task;
    const message = { to: "codex", taskId: sender.id, summary: "Please verify the result independently", kind: "verification-request" as const,
      progressFingerprint: "artifact-ready", progressKind: "artifact-changed" as const, idempotencyKey: "one-check" };
    const sent = runtime.sendFromHandle("claude", "claude-code", message);
    assert.equal(sent.ok, true);
    if (!sent.ok) return;
    assert.equal(sent.delivery.created, true);
    assert.notEqual(sent.delivery.taskId, recipient.id);
    const stored = store.getTask(sent.delivery.taskId!)!;
    assert.equal(stored.coordination?.intent, "message", "the inbox record is conversation context, not a second ownership claim");
    assert.equal(stored.a2a?.taskId, sender.id);
    assert.equal(stored.delivery?.state, "deferred");
    assert.equal(stored.targetSession, "codex-session");
    const retry = runtime.sendFromHandle("claude", "claude-code", message);
    assert.equal(retry.ok, true);
    if (retry.ok) { assert.equal(retry.duplicate, true); assert.equal(retry.delivery.taskId, stored.id); }
    assert.equal(store.tasksFor("codex").length, 2);
    assert.equal(store.getTask(recipient.id)?.resultSummary, undefined);
    assert.equal(store.getTask(recipient.id)?.deliveredAt, undefined, "persisting peer context does not start or replay the owner's assignment");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a teammate delegation still creates a new task when the recipient has no matching broadcast", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-a2a-no-broadcast-"));
  const store = createLocalStore(root);
  const inboxDelivery = createMultiplayerInboxDelivery({
    store,
    agents: roster.agents.map((agent) => ({ handle: agent.handle!, agentId: agent.agentId })),
    sessionIdOf: (handle) => handle === "codex" ? "codex-session" : "claude-session",
  });
  const runtime = createMultiplayerRuntime({ roster, delivery: inboxDelivery });
  try {
    // Claude has an active broadcast-tagged task, but Codex was never part of that broadcast --
    // a genuine first-time delegation must still create a task for Codex, not be suppressed.
    store.addTask({
      from: "you", to: "claude", goal: "solo broadcast", origin: "human_typed",
      idempotencyKey: "solo-claude-1", broadcastId: "bcast-solo",
    });
    const result = runtime.sendFromHandle("claude", "claude-code", {
      to: "codex", taskId: "shared-room-2", summary: "Please pick a number.", kind: "delegate",
      progressFingerprint: "p-2", progressKind: "observation", idempotencyKey: "delegate-2",
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.delivery.created, true);
    assert.equal(store.tasksFor("codex").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

