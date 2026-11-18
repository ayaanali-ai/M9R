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

test("task delivery describes actual stage modes and typed dispatch recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-hook-task-stage-"));
  let received: { token?: string; taskId?: string } | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { token?: string; taskId?: string };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, stage: { name: STAGE, controlEnabled: false } }));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const store = createLocalStore(root);
    store.issueIdentity("claude", "claude-code", SESSION);
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
    assert.match(context, /owner-preview/);
    assert.match(context, /delivery has not started desktop work/);
    assert.match(context, /do not wait for the user to name tools or provide command syntax/);
    assert.match(context, /mode "background" to attach to the unique existing window/);
    assert.match(context, /Never substitute a new window, provider-owned browser, or another app/);
    assert.match(context, /avoid interrupting them[\s\S]*select background mode even if they do not use the literal word/);
    assert.match(context, /For a request to append text[\s\S]*Do not use replace_element or replace-mode typing/);
    assert.match(context, /reads and preserves the current complete value/);
    assert.match(context, /view "app" for the selected app window and view "desktop" for desktop-wide inspection or interaction/);
    assert.match(context, /continue from that exact result instead of assuming the app was already selected/);
    assert.match(context, /background[\s\S]*never creates or switches a Windows virtual desktop/);
    assert.match(context, /A fresh capture by itself does not establish whether the preceding input was sent/);
    assert.match(context, /never blindly replay a possibly delivered action/);
    assert.match(context, /latest, newest, or most recent[\s\S]*authoritative source[\s\S]*search rank and first-visible position alone are not proof/);
    assert.match(context, /an ad, preview, loading state, or unrelated queued item does not satisfy it/);
    assert.match(context, /Report the observed title\/date and distinguish verified results from missing evidence/);
    assert.match(context, /For an exact-path save[\s\S]*current app-owned Save As dialog/);
    assert.match(context, /Set replaceExisting to true only when the user authorized replacing that exact file/);
    assert.match(context, /After saving, reopen the exact requested file and compare its contents or visible output/);
    assert.doesNotMatch(context, /YouTube|Spotify/);
    assert.doesNotMatch(context, /isolated Windows desktop/);
    assert.match(context, /Preserve existing windows and tabs unless the user asks to change them/);
    assert.equal(received, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
