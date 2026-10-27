import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const installedBin = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".m9r", "bin");
const engine = process.env.M9R_ENGINE_UNDER_TEST || join(installedBin, process.platform === "win32" ? "m9r-engine.exe" : "m9r-engine");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedProviderClaim(home, ownerProcessId) {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  writeFileSync(join(home, "state.json"), JSON.stringify({
    version: 1,
    nextTaskNo: 1,
    nextSeq: {},
    tasks: [],
    cursors: {},
    endpoints: {},
    events: [],
    rules: [],
    nextRuleNo: 1,
    sessions: [],
    links: [],
    nextLinkNo: 1,
    identities: [{
      token: "packaged-env-regression-token",
      handle: "claude",
      provider: "claude-code",
      sessionId: "packaged-env-session",
      issuedAt,
    }],
    stageOperations: [],
    computerOperations: [],
    connectionClaims: [{
      claimId: "packaged-env-regression-claim",
      handle: "claude",
      provider: "claude-code",
      sessionId: "packaged-env-session",
      ownerProcessId,
      issuedAt,
      expiresAt,
    }],
    connectionBindings: [],
    cursorColors: {},
  }), "utf8");
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const deadline = Date.now() + 3000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(20);
}

async function callWhoami(home, provider, command = engine, extraEnv = {}) {
  const child = spawn(command, ["mcp"], {
    env: { ...process.env, M9R_HOME: home, ...(provider ? { M9R_PROVIDER: provider } : {}), ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const messages = [];
  const lifecycle = [];
  let buffer = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    while (stderr.includes("\n")) {
      const end = stderr.indexOf("\n");
      const line = stderr.slice(0, end);
      stderr = stderr.slice(end + 1);
      if (line.startsWith("M9R MCP lifecycle ")) lifecycle.push(JSON.parse(line.slice("M9R MCP lifecycle ".length)));
    }
  });
  const waitFor = async (id) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const found = messages.find((message) => message.id === id);
      if (found) return found;
      if (child.exitCode !== null) break;
      await sleep(20);
    }
    throw new Error(`packaged MCP did not answer request ${id}`);
  };
  const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  try {
    send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m9r-env-regression", version: "1" } });
    await waitFor(1);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    send(2, "tools/call", { name: "m9r_whoami", arguments: {} });
    const first = await waitFor(2);
    const firstText = first.result?.content?.[0]?.text ?? "";
    const ready = lifecycle.find((event) => event.kind === "ready");
    if (extraEnv.M9R_MCP_WORKER !== "1") {
      assert.ok(ready?.workerPid, `packaged MCP must publish a worker PID; stderr=${stderr}`);
    }
    return { child, lifecycle, firstText, workerPid: ready?.workerPid, send, waitFor };
  } catch (error) {
    await stop(child);
    throw error;
  }
}

test("packaged MCP keeps provider binding mode across a private worker reconnect", async (t) => {
  if (!existsSync(engine)) {
    t.skip(`packaged engine not found at ${engine}`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "m9r-packaged-env-regression-"));
  let probe;
  try {
    // The claim owner is this test process, which is the packaged supervisor's
    // immediate parent. This proves the compiled entry carries its resolved
    // provider/PID identity into the private worker before reconnecting it.
    seedProviderClaim(home, process.pid);
    probe = await callWhoami(home, "claude-code");
    assert.match(probe.firstText, /@claude \(claude-code\), session packaged-env-session/);
    assert.doesNotMatch(probe.firstText, /session token is required/i);

    process.kill(probe.workerPid, "SIGTERM");
    const lostDeadline = Date.now() + 5000;
    while (!probe.lifecycle.some((event) => event.kind === "lost") && Date.now() < lostDeadline) await sleep(20);
    assert.ok(probe.lifecycle.some((event) => event.kind === "lost"), "the first worker must be observed as lost");

    probe.send(3, "tools/call", { name: "m9r_whoami", arguments: {} });
    const second = await probe.waitFor(3);
    const secondText = second.result?.content?.[0]?.text ?? "";
    assert.match(secondText, /@claude \(claude-code\), session packaged-env-session/);
    assert.doesNotMatch(secondText, /session token is required/i);
    assert.ok(probe.lifecycle.some((event) => event.kind === "ready" && event.generation === 2), "the second worker must be ready");
  } finally {
    await stop(probe?.child);
    rmSync(home, { recursive: true, force: true });
  }
});

test("installed native MCP shim forwards provider configuration and its parent identity", async (t) => {
  const hook = join(installedBin, process.platform === "win32" ? "m9r-hook.exe" : "m9r-hook-native");
  if (!existsSync(hook)) {
    t.skip(`installed native hook not found at ${hook}`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "m9r-installed-hook-env-regression-"));
  let probe;
  try {
    // The native shim is the real command registered in provider MCP configs.
    // Its child engine must receive both M9R_PROVIDER and the shim's verified
    // provider-parent PID; otherwise the live connection falls back to the
    // legacy token path or refuses to bind.
    seedProviderClaim(home, process.pid);
    probe = await callWhoami(home, "claude-code", hook);
    assert.match(probe.firstText, /@claude \(claude-code\), session packaged-env-session/);
    assert.doesNotMatch(probe.firstText, /session token is required/i);
  } finally {
    await stop(probe?.child);
    rmSync(home, { recursive: true, force: true });
  }
});

test("packaged MCP without provider configuration remains safely unbound instead of requiring a typed token", async (t) => {
  if (!existsSync(engine)) {
    t.skip(`packaged engine not found at ${engine}`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "m9r-packaged-legacy-control-"));
  let probe;
  try {
    probe = await callWhoami(home);
    assert.match(probe.firstText, /Automatic M9R provider binding did not become ready/i);
    assert.doesNotMatch(probe.firstText, /session token is required/i);
  } finally {
    await stop(probe?.child);
    rmSync(home, { recursive: true, force: true });
  }
});

test("a packaged refreshed worker recovers one active claim when its old supervisor lost metadata", async (t) => {
  if (!existsSync(engine)) {
    t.skip(`packaged engine not found at ${engine}`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "m9r-packaged-worker-recovery-"));
  let probe;
  try {
    // This is the live upgrade shape: an older provider-owned outer process
    // starts a private worker with only the internal worker marker, while the
    // current worker image is installed underneath it. There is one active
    // claim, so recovery is deterministic and must not require a token.
    seedProviderClaim(home, 999999);
    probe = await callWhoami(home, undefined, engine, { M9R_MCP_WORKER: "1" });
    assert.match(probe.firstText, /@claude \(claude-code\), session packaged-env-session/);
    assert.doesNotMatch(probe.firstText, /session token is required/i);
  } finally {
    await stop(probe?.child);
    rmSync(home, { recursive: true, force: true });
  }
});
