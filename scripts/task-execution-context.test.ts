import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildQueueMessage } from "../src/lib/native/codex-delivery-core.ts";
import { handleHookEvent } from "../src/lib/native/hook-handler.ts";
import { createLocalStore, handleForProvider } from "../src/lib/native/local-store.ts";

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
      const task = store.addTask({ from: "owner", to: handle, targetSession: session,
        goal: "Read this and do not dispatch @another-agent.", origin: "human_typed", idempotencyKey: "plain-task" }).task;
      store.setDelivery(task.id, { state: "sending", threadId: session });
      const output = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: session,
        cwd: "C:/project", prompt: task.goal }, { provider, store, strictTargetIdentity: true, readIndex: () => null });
      const context = output?.hookSpecificOutput.additionalContext ?? "";
      assert.ok(context.includes(`[M9R ${task.id}]`), "task correlation belongs in hidden hook context");
      assert.ok(context.includes(identity.token), "context must supply the exact authenticated session credential");
      assert.equal(store.tasksFrom(handle).length, 0, "delivered task mentions cannot become fresh outbound work");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test(`${provider} heals a missing identity through trusted prompt metadata`, () => {
    const root = mkdtempSync(join(tmpdir(), "m9r-task-context-"));
    try {
      const store = createLocalStore(root);
      handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "session", cwd: "C:/project", prompt: "hello" },
        { provider, store, strictTargetIdentity: true, readIndex: () => null });
      assert.ok(store.identityTokenFor(handleForProvider(provider), "session"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
