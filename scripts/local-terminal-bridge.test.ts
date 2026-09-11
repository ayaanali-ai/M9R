import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_HOST,
  PROVIDER_LAUNCHERS,
  authorizeUpgrade,
  createBridgeToken,
  parseClientMessage,
  providerProcessSpec,
  resolveWorkspaceCwd,
} from "../src/lib/local-terminal-bridge-core.ts";

test("the bridge binds to loopback and preserves first-party provider launch metadata", () => {
  assert.equal(DEFAULT_BRIDGE_HOST, "127.0.0.1");
  assert.deepEqual(Object.keys(PROVIDER_LAUNCHERS), ["claude-code", "codex", "grok-build"]);
  assert.equal(PROVIDER_LAUNCHERS["claude-code"].command, "claude");
  assert.equal(PROVIDER_LAUNCHERS.codex.command, "codex");
  assert.equal(PROVIDER_LAUNCHERS["grok-build"].command, "grok");
});

test("every provider workspace launches an interactive local shell", () => {
  assert.deepEqual(providerProcessSpec("codex", "win32"), { command: "powershell.exe", args: ["-NoLogo"] });
  assert.deepEqual(providerProcessSpec("claude-code", "linux"), { command: "/bin/sh", args: ["-l"] });
});

test("bridge tokens are high entropy and URL-safe", () => {
  const first = createBridgeToken();
  const second = createBridgeToken();
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
});

test("runtime upgrades require the exact protocol and an approved OathLock origin without manual pairing", () => {
  assert.deepEqual(authorizeUpgrade({
    origin: "http://localhost:3000",
    protocols: [BRIDGE_PROTOCOL_VERSION],
    allowedOrigins: ["http://localhost:3000"],
  }), { ok: true });
  assert.equal(authorizeUpgrade({
    origin: "https://evil.example",
    protocols: [BRIDGE_PROTOCOL_VERSION],
    allowedOrigins: ["http://localhost:3000"],
  }).ok, false);
  assert.equal(authorizeUpgrade({
    origin: "http://localhost:3000",
    protocols: [],
    allowedOrigins: ["http://localhost:3000"],
  }).ok, false);
});

test("workspace cwd resolution cannot escape the configured repository root", () => {
  const root = process.platform === "win32" ? "C:\\repo" : "/repo";
  assert.equal(resolveWorkspaceCwd(root, "."), root);
  assert.throws(() => resolveWorkspaceCwd(root, "../outside"), /outside the configured repository/i);
});

test("client messages are bounded and validated before touching a PTY", () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "list" })), { type: "list" });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "spawn", provider: "codex", cwd: ".", cols: 100, rows: 30 })), {
    type: "spawn", provider: "codex", cwd: ".", cols: 100, rows: 30,
  });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "spawn", provider: "cursor", cwd: "." })), {
    type: "spawn", provider: "cursor", cwd: ".", cols: 100, rows: 30,
  });
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "spawn", provider: "Cursor Prime!", cwd: "." })), /invalid provider/i);
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "input", sessionId: "s1", data: "x".repeat(70_000) })), /too large/i);
  assert.throws(() => parseClientMessage("not json"), /valid JSON/i);
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "report-state", sessionId: "s1", state: "blocked" })), {
    type: "report-state", sessionId: "s1", state: "blocked",
  });
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "report-state", sessionId: "s1", state: "thinking-hard" })), /invalid terminal agent state/i);
});
