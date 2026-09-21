import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAppServerAdapter, codexAppServerCommand } from "@/lib/bridge/codex-app-server-adapter";
import type { AgentSessionHandle, InteractiveProviderEvent } from "@/lib/bridge/interactive-provider-adapter";

const FIXTURE = resolve(import.meta.dirname, "fixtures/fake-codex-app-server.mjs");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function assignment(extra: Record<string, unknown> = {}) {
  return { missionId: "channel-test", dispatchKey: "test", goal: "test", executionConstraints: {}, ...extra } as never;
}

async function start(options: { deniedFilePatterns?: string[]; promptTimeoutMs?: number; permissionTimeoutMs?: number } = {}) {
  const adapter = new CodexAppServerAdapter({ id: "codex-app-server-test", command: process.execPath, args: [FIXTURE], promptTimeoutMs: options.promptTimeoutMs, permissionTimeoutMs: options.permissionTimeoutMs });
  const cwd = mkdtempSync(join(tmpdir(), "codex-adapter-"));
  const server = await adapter.launchServer({ assignment: assignment({ deniedFilePatterns: options.deniedFilePatterns ?? [] }), environment: { workingDirectory: cwd, kind: "disposable" } });
  await adapter.initialize(server);
  const session = await adapter.createSession({ server, assignment: assignment() });
  return { adapter, server, session, cwd, stop: () => adapter.shutdown(server) };
}

async function collect(adapter: CodexAppServerAdapter, session: AgentSessionHandle, prompt: string, onEvent?: (event: InteractiveProviderEvent) => void | Promise<void>) {
  const events: InteractiveProviderEvent[] = [];
  for await (const event of adapter.prompt({ session, text: prompt })) {
    events.push(event);
    await onEvent?.(event);
  }
  return events;
}

const replyText = (events: InteractiveProviderEvent[]) => events.filter((event) => event.type === "provider.reply_text").map((event) => String(event.payload.text)).join("");

test("a normal turn streams reply text, reports usage, and completes; the thread id is the provider session ref", async () => {
  const { adapter, session, stop } = await start();
  try {
    assert.equal(session.providerSessionRef, "thread-1");
    const events = await collect(adapter, session, "hello");
    assert.equal(replyText(events), "ok");
    const types = events.map((event) => event.type);
    assert.ok(types.includes("provider.usage_updated"));
    assert.equal(types.at(-1), "provider.completed");
    assert.equal(events.at(-1)?.payload.stopReason, "end_turn");
  } finally { await stop(); }
});

test("a failed turn surfaces Codex's own error text, such as a usage limit", async () => {
  const { adapter, session, stop } = await start();
  try {
    const events = await collect(adapter, session, "fail-usage");
    const failed = events.find((event) => event.type === "provider.failed");
    assert.match(String(failed?.payload.reason), /usage limit/);
    assert.equal(events.some((event) => event.type === "provider.completed"), false);
  } finally { await stop(); }
});

test("an approved command sends a plain accept, never accept-for-session", async () => {
  const { adapter, session, stop } = await start();
  try {
    const events = await collect(adapter, session, "approval-command", async (event) => {
      if (event.payload.activityKind === "permission.requested" && event.payload.status === "waiting") {
        await adapter.respondToPermission({ session, requestId: String(event.payload.requestId), approved: true });
      }
    });
    assert.equal(replyText(events), "decision:accept");
    assert.ok(events.some((event) => event.payload.activityKind === "command.started"));
    assert.ok(events.some((event) => event.payload.activityKind === "command.completed" && event.payload.status === "succeeded"));
  } finally { await stop(); }
});

test("a declined command is reported to Codex as decline", async () => {
  const { adapter, session, stop } = await start();
  try {
    const events = await collect(adapter, session, "approval-command", async (event) => {
      if (event.payload.activityKind === "permission.requested" && event.payload.status === "waiting") {
        await adapter.respondToPermission({ session, requestId: String(event.payload.requestId), approved: false });
      }
    });
    assert.equal(replyText(events), "decision:decline");
  } finally { await stop(); }
});

test("an approval nobody answers times out as cancel instead of hanging the turn", async () => {
  const { adapter, session, stop } = await start({ permissionTimeoutMs: 200 });
  try {
    const events = await collect(adapter, session, "approval-command");
    assert.equal(replyText(events), "decision:cancel");
  } finally { await stop(); }
});

test("a file change matching the deny-list is refused without asking a human", async () => {
  const { adapter, session, stop } = await start({ deniedFilePatterns: ["secret/**"] });
  try {
    const events = await collect(adapter, session, "approval-file");
    assert.equal(replyText(events), "decision:decline");
    const denied = events.find((event) => event.payload.activityKind === "permission.requested");
    assert.equal(denied?.payload.status, "failed");
    assert.match(String(denied?.payload.summary), /file-permission policy/);
    assert.equal(events.some((event) => event.payload.status === "waiting"), false);
  } finally { await stop(); }
});

test("a server request M9R does not support is answered with an error, so the turn is not left waiting", async () => {
  const { adapter, session, stop } = await start();
  try {
    const events = await collect(adapter, session, "unknown-request");
    assert.equal(replyText(events), "survived");
  } finally { await stop(); }
});

test("cancelTurn uses the native interrupt and the turn ends as cancelled", async () => {
  const { adapter, session, stop } = await start();
  try {
    const turn = collect(adapter, session, "slow");
    await sleep(300);
    await adapter.cancelTurn({ session });
    const events = await turn;
    assert.equal(events.at(-1)?.type, "provider.completed");
    assert.equal(events.at(-1)?.payload.stopReason, "cancelled");
  } finally { await stop(); }
});

test("steer adds input to the running turn through turn/steer", async () => {
  const { adapter, session, stop } = await start();
  try {
    const turn = collect(adapter, session, "slow");
    await sleep(300);
    await adapter.steer({ session, text: "use tabs" });
    const events = await turn;
    assert.equal(replyText(events), "steered:use tabs");
    await assert.rejects(adapter.steer({ session, text: "too late" }), /no active turn/i);
  } finally { await stop(); }
});

test("a second prompt while one is running is rejected", async () => {
  const { adapter, session, stop } = await start();
  try {
    const turn = collect(adapter, session, "slow");
    await sleep(300);
    await assert.rejects(collect(adapter, session, "another"), /already has an active prompt/);
    await adapter.cancelTurn({ session });
    await turn;
  } finally { await stop(); }
});

test("a server crash mid-turn fails the turn with the real reason and marks the server dead", async () => {
  const { adapter, server, session, stop } = await start();
  try {
    const events = await collect(adapter, session, "crash");
    const failed = events.find((event) => event.type === "provider.failed");
    assert.match(String(failed?.payload.reason), /exited/);
    assert.equal(adapter.getServerHealth(server).state, "dead");
  } finally { await stop(); }
});

test("a turn that never finishes is abandoned at the prompt timeout", async () => {
  const { adapter, session, stop } = await start({ promptTimeoutMs: 300 });
  try {
    const events = await collect(adapter, session, "slow");
    assert.match(String(events.at(-1)?.payload.reason), /did not finish within 300ms/);
  } finally { await stop(); }
});

test("resumeSession reopens the same thread id", async () => {
  const { adapter, server, stop } = await start();
  try {
    const resumed = await adapter.resumeSession({ server, providerSessionRef: "thread-abc", assignment: assignment() });
    assert.equal(resumed.providerSessionRef, "thread-abc");
    assert.equal(replyText(await collect(adapter, resumed, "hello")), "ok");
  } finally { await stop(); }
});

test("codexAppServerCommand honors CODEX_PATH, then the Windows npm shim, then the bare name", () => {
  assert.deepEqual(codexAppServerCommand({ CODEX_PATH: "C:/x/codex.cmd" }, "win32", () => false), { command: "C:/x/codex.cmd", shell: true });
  assert.deepEqual(codexAppServerCommand({ CODEX_PATH: "/opt/codex" }, "linux", () => false), { command: "/opt/codex", shell: false });
  assert.deepEqual(codexAppServerCommand({ APPDATA: "C:/Users/t/AppData/Roaming" }, "win32", () => true), { command: resolve("C:/Users/t/AppData/Roaming", "npm", "codex.cmd"), shell: true });
  assert.deepEqual(codexAppServerCommand({}, "win32", () => false), { command: "codex", shell: true });
  assert.deepEqual(codexAppServerCommand({}, "linux", () => false), { command: "codex", shell: false });
});

test("the default registry keeps ACP for Codex unless M9R_CODEX_APP_SERVER=1", async () => {
  const { createDefaultAcpProviderRegistry } = await import("@/lib/bridge/acp-provider-registry");
  const prior = process.env.M9R_CODEX_APP_SERVER;
  try {
    delete process.env.M9R_CODEX_APP_SERVER;
    assert.equal(createDefaultAcpProviderRegistry().get("codex-acp")?.constructor.name, "AcpStdioProviderAdapter");
    process.env.M9R_CODEX_APP_SERVER = "1";
    assert.equal(createDefaultAcpProviderRegistry().get("codex-acp")?.constructor.name, "CodexAppServerAdapter");
  } finally {
    if (prior === undefined) delete process.env.M9R_CODEX_APP_SERVER; else process.env.M9R_CODEX_APP_SERVER = prior;
  }
});
