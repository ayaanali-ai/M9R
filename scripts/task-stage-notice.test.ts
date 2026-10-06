import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { brokerKeyPath } from "../src/lib/native/web-broker-paths";
import { createLocalStore } from "../src/lib/native/local-store";
import { runHookRequest } from "../src/lib/native/hook-run";

const SESSION = "claude-session-stage-proof";
const STAGE = "agent-0123456789abcdef01234567";

test("the normal Claude inbox hook prepares its approved task stage before injecting the task", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-hook-task-stage-"));
  let received: { token?: string; taskId?: string } | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { token?: string; taskId?: string };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, stage: { name: STAGE, controlEnabled: false, approvedApps: [] } }));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const store = createLocalStore(root);
    const identity = store.issueIdentity("claude", "claude-code", SESSION);
    const task = store.addTask({
      from: "codex",
      to: "claude",
      goal: "Draft the launch post",
      origin: "human_typed",
      idempotencyKey: "stage-hook-task",
      targetSession: SESSION,
    }).task;
    writeFileSync(join(root, "task-stage-policy.json"), JSON.stringify({ version: 1, handles: ["claude"] }));
    const keyPath = brokerKeyPath(root);
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, "test-owner-broker-key\n");

    const output = await runHookRequest({
      event: "UserPromptSubmit",
      provider: "claude-code",
      input: { hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: root, prompt: "What is waiting for me?" },
    }, "m9r-hook", { M9R_HOME: root, M9R_WEB_BROKER_PORT: String(address.port), CODEX_HOME: root });

    const hookOutput = JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: string } };
    const context = hookOutput.hookSpecificOutput?.additionalContext ?? "";
    assert.match(context, new RegExp(task.id));
    assert.match(context, new RegExp(STAGE));
    assert.match(context, /Computer control is not enabled/);
    assert.deepEqual(received, { token: identity.token, taskId: task.id });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
