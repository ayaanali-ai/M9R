import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildQueueMessage } from "../src/lib/native/codex-delivery-core.ts";
import { handleHookEvent, routeTypedMentions } from "../src/lib/native/hook-handler.ts";
import { createLocalStore, handleForProvider } from "../src/lib/native/local-store.ts";
import { resolveHookSessionMetadata } from "../src/lib/native/task-execution-context.ts";

test("visible task delivery contains exactly the owner's task", () => {
  const goal = "Open my browser and read this page.";
  const text = buildQueueMessage({ id: "T777", from: "owner", goal }, "test-credential-that-must-stay-in-context");
  assert.ok(text === goal, "transport IDs and credentials must stay outside visible task text");
});

for (const provider of ["local-open-weight-model", "arbitrary-provider", "claude-code", "codex"]) {
  test(`${provider} gets a verified internal context for its plainly delivered task`, () => {
    const root = mkdtempSync(join(tmpdir(), "m9r-task-context-"));
    try {
      const store = createLocalStore(root);
      const handle = handleForProvider(provider);
      const session = "session-owned-by-provider";
      const identity = store.issueIdentity(handle, provider, session);
      store.registerEndpoint({ provider, sessionId: session, cwd: "C:/project" });
      store.registerEndpoint({ provider: "another-agent", sessionId: "teammate-session", cwd: "C:/project" });
      const task = store.addTask({ from: "owner", to: handle, targetSession: session,
        goal: "Read this and do not dispatch @another-agent.", origin: "human_typed", idempotencyKey: "plain-task" }).task;
      store.setDelivery(task.id, { state: "sending", threadId: session });
      const output = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: session,
        cwd: "C:/project", prompt: task.goal }, { provider, store, strictTargetIdentity: true, readIndex: () => null });
      const context = output?.hookSpecificOutput.additionalContext ?? "";
      assert.match(context, /M9R assigned one approved work item/i);
      assert.match(context, /m9r_result/);
      assert.doesNotMatch(context, new RegExp(task.id));
      assert.doesNotMatch(context, new RegExp(identity.token));
      assert.deepEqual(routeTypedMentions({ session_id: session, cwd: "C:/project", prompt: task.goal },
        { provider, store, pathExists: () => false }), { acks: [], tasks: [] },
        "a hook-free adapter must not reinterpret a delivered task's mentions as fresh owner instructions");
      assert.equal(store.tasksFrom(handle).length, 0, "delivered task mentions cannot become fresh outbound work");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test(`${provider} heals a missing identity through trusted prompt metadata`, () => {
    const root = mkdtempSync(join(tmpdir(), "m9r-task-context-"));
    try {
      const store = createLocalStore(root);
      handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "session", cwd: "C:/project", prompt: "hello" },
        { provider, store, strictTargetIdentity: true, sessionMetadataVerified: true, readIndex: () => null });
      assert.ok(store.identityTokenFor(handleForProvider(provider), "session"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("an incidental session id cannot bootstrap task ownership", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-task-context-"));
  try {
    const store = createLocalStore(root);
    const task = store.addTask({ from: "owner", to: "arbitrary-provider", goal: "approved work", origin: "human_typed", idempotencyKey: "untrusted-id" }).task;
    handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "app-process-id", prompt: "continue" },
      { provider: "arbitrary-provider", store, strictTargetIdentity: true, readIndex: () => null });
    assert.equal(store.identityTokenFor("arbitrary-provider", "app-process-id"), null);
    assert.equal(store.getTask(task.id)?.deliveredSession, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("adapter session resolution uses the registered transcript identity instead of an app-process id", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-task-context-"));
  try {
    const store = createLocalStore(root);
    store.issueIdentity("arbitrary-provider", "arbitrary-provider", "real-session");
    assert.deepEqual(resolveHookSessionMetadata(store, "arbitrary-provider", "arbitrary-provider",
      { session_id: "app-process-id", transcript_path: "C:/transcripts/real-session.jsonl" }), { sessionId: "real-session", verified: true });
    assert.deepEqual(resolveHookSessionMetadata(store, "local-model", "local-model",
      { session_id: "incidental", canonical_session_id: "local-protocol-session" }), { sessionId: "local-protocol-session", verified: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("direct task binding serializes identical tasks for any provider and refuses ownership transfer", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-task-context-"));
  try {
    const store = createLocalStore(root);
    const identity = store.issueIdentity("local-model", "arbitrary-provider", "first-session");
    const other = store.issueIdentity("local-model", "arbitrary-provider", "second-session");
    const add = (key: string) => store.addTask({ from: "owner", to: "local-model", goal: "same task", origin: "human_typed", idempotencyKey: key }).task;
    const first = add("first"), second = add("second");
    store.setDelivery(first.id, { state: "sending" });
    store.setDelivery(second.id, { state: "sending" });
    assert.equal(store.bindTaskToSession(first.id, identity.token), true);
    assert.equal(store.bindTaskToSession(first.id, other.token), false);
    assert.equal(store.bindTaskToSession(second.id, identity.token), false);
    const independent = store.addTask({ from: "owner", to: "local-model", goal: "unrelated approved work",
      origin: "human_typed", idempotencyKey: "independent" }).task;
    assert.equal(store.bindTaskToSession(independent.id, identity.token), true,
      "an unanswered historical task must not permanently block unrelated work with unambiguous context");
    store.setResult(first.id, "completed");
    assert.equal(store.bindTaskToSession(second.id, identity.token), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ordinary prompt recovery does not undo an explicit identity revocation", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-task-context-"));
  try {
    const store = createLocalStore(root);
    store.issueIdentity("local-model", "local-model", "session");
    store.revokeIdentity("session");
    handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "session", prompt: "continue" },
      { provider: "local-model", store, strictTargetIdentity: true, sessionMetadataVerified: true, readIndex: () => null });
    assert.equal(store.identityTokenFor("local-model", "session"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a provider Stop event cannot report the same unrelated final answer for every waiting task", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-task-context-"));
  try {
    const store = createLocalStore(root);
    store.issueIdentity("local-model", "local-model", "session");
    const tasks = ["first", "second"].map(key => store.addTask({ from: "owner", to: "local-model", goal: key,
      origin: "human_typed", idempotencyKey: key }).task);
    for (const task of tasks) store.setDelivery(task.id, { state: "queued", threadId: "session" });
    const context = { provider: "local-model", store, lastAnswer: () => "an unrelated answer" };
    handleHookEvent({ hook_event_name: "Stop", session_id: "session" }, context);
    assert.ok(tasks.every(task => !store.getTask(task.id)?.resultSummary), "a turn ending is not task-correlated success evidence");
    handleHookEvent({ hook_event_name: "Stop", session_id: "session", task_id: tasks[0].id }, context);
    assert.equal(store.getTask(tasks[0].id)?.resultSummary, "an unrelated answer");
    assert.equal(store.getTask(tasks[1].id)?.resultSummary, undefined, "only the adapter's explicit task reference may be answered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
