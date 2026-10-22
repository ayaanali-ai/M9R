import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hookPipePath, requestShutdown, startHookServer } from "@/lib/native/hook-server";
import { runHookRequest } from "@/lib/native/hook-run";
import { createLocalStore } from "@/lib/native/local-store";

const roundTrip = (path: string, line: string) => new Promise<string>((resolve) => {
  const s = connect(path);
  let out = "";
  s.on("connect", () => s.write(line));
  s.on("data", (d) => { out += d.toString("utf8"); });
  s.on("close", () => resolve(out));
  s.on("error", () => resolve("ERROR"));
});

test("the hook server answers one JSON line with the handler's text, shrugs off garbage, and stops on request", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-hs-"));
  const path = hookPipePath(root, process.platform, `t${process.pid}${Date.now() % 100000}`);
  let stopped = false;
  const server = startHookServer({ path, handle: (req) => `event=${req.event} provider=${req.provider} prompt=${req.input?.prompt ?? ""} home=${req.env?.M9R_HOME ?? ""}`, onShutdown: () => { stopped = true; } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await roundTrip(path, JSON.stringify({ event: "UserPromptSubmit", provider: "claude-code", input: { prompt: "hello \"quoted\"" }, env: { M9R_HOME: "X" } }) + "\n"), 'event=UserPromptSubmit provider=claude-code prompt=hello "quoted" home=X');
  assert.equal(await roundTrip(path, "this is not json\n"), "", "garbage gets an empty answer, never a crash");
  assert.equal(await requestShutdown(path), true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(stopped, true);
  server.close();
});

test("a hook call through the shared runner registers the session and prints the card, using the caller's M9R home", async () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-hr-"));
  const text = await runHookRequest({ event: "SessionStart", provider: "claude-code", input: { hook_event_name: "SessionStart", session_id: "abc", cwd: home }, env: { M9R_HOME: home } }, "unused");
  assert.match(text, /M9R connected as @claude/);
});

test("a resident-engine hook request carries the verified provider parent instead of the daemon parent", async () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-hr-binding-"));
  await runHookRequest({
    event: "SessionStart",
    provider: "codex",
    providerProcessId: 4545,
    input: { hook_event_name: "SessionStart", session_id: "codex-session", cwd: home },
    env: { M9R_HOME: home },
  }, "unused", {}, true);
  const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as { connectionClaims: Array<{ ownerProcessId?: number }> };
  assert.equal(state.connectionClaims[0]?.ownerProcessId, 4545);
});

test("an OpenCode poll carries the native stage contract after its task is claimed", async () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-opencode-stage-"));
  writeFileSync(join(home, "task-stage-policy.json"), JSON.stringify({ version: 1, handles: ["opencode"] }));
  await runHookRequest({
    event: "SessionStart",
    provider: "opencode",
    input: { hook_event_name: "SessionStart", session_id: "opencode-session", cwd: home },
    env: { M9R_HOME: home },
  }, "unused");
  createLocalStore(home).addTask({
    from: "you",
    to: "opencode",
    goal: "open the named app",
    origin: "human_typed",
    idempotencyKey: "opencode-stage-poll-envelope",
  });
  const text = await runHookRequest({
    event: "OpenCodePoll",
    provider: "opencode",
    input: { hook_event_name: "OpenCodePoll", session_id: "opencode-session", cwd: home },
    env: { M9R_HOME: home },
  }, "unused");
  const outer = JSON.parse(text) as { hookSpecificOutput?: { additionalContext?: string } };
  const envelope = JSON.parse(outer.hookSpecificOutput?.additionalContext ?? "{}") as { task_id?: string; prompt?: string };
  assert.equal(envelope.task_id, "T1");
  assert.match(envelope.prompt ?? "", /M9R desktop tools are available/);
  assert.match(envelope.prompt ?? "", /open the named app/);
});
