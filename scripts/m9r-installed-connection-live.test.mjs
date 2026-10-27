import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const installedBin = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".m9r", "bin");
const engine = process.env.M9R_ENGINE_UNDER_TEST || join(installedBin, process.platform === "win32" ? "m9r-engine.exe" : "m9r-engine");
const hook = join(installedBin, process.platform === "win32" ? "m9r-hook.exe" : "m9r-hook-native");
const hookUnderTest = process.env.M9R_HOOK_UNDER_TEST || hook;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function stopChild(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(25);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch { /* the process may have exited between the checks */ }
    const killDeadline = Date.now() + 2000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < killDeadline) await sleep(25);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, `${label} child must exit during test cleanup`);
}

function runHook(home, provider, input) {
  const result = spawnSync(hookUnderTest, ["SessionStart", provider], {
    cwd: resolve("."),
    env: { ...process.env, M9R_HOME: home },
    input: JSON.stringify(input),
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  return { stdout: result.stdout ?? "", status: result.status, error: result.error };
}

function readState(home) {
  return JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
}

async function waitForJson(messages, id, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const found = messages.find((message) => message.id === id && !message.method);
    if (found) return found;
    if (child.exitCode !== null) break;
    await sleep(20);
  }
  throw new Error(`installed MCP did not answer request ${id}`);
}

test("installed provider connection binds without a credential and survives private-worker reconnect", async () => {
  assert.ok(process.platform === "win32", "this acceptance harness targets the installed Windows runtime");
  assert.ok(existsSync(engine), "the installed engine must be present");

  const home = mkdtempSync(join(tmpdir(), "m9r-item6-installed-live-"));
  const providerSession = "11111111-1111-4111-8111-111111111111";
  const providerInput = {
    hook_event_name: "SessionStart",
    session_id: providerSession,
    canonical_session_id: providerSession,
    cwd: resolve("."),
  };
  let feed = null;
  let mcp = null;
  try {
    feed = spawn(engine, ["feed", "--watch", "--serve-hooks"], {
      cwd: resolve("."),
      env: { ...process.env, M9R_HOME: home },
      stdio: "ignore",
      windowsHide: true,
    });

    let hookResult = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      hookResult = runHook(home, "codex", providerInput);
      if (hookResult.stdout.trim()) break;
      await sleep(250);
    }
    assert.ok(hookResult?.stdout.trim(), "the installed native hook must return the SessionStart response");
    assert.doesNotMatch(hookResult.stdout, /session token|identity token|bearer/i, "the provider-facing bootstrap must not print a credential");
    const stateAfterHook = readState(home);
    assert.equal(stateAfterHook.identities.length, 1, "SessionStart must register exactly one provider identity");
    assert.equal(stateAfterHook.connectionClaims.length, 1, "SessionStart must issue exactly one private connection claim");
    assert.equal(stateAfterHook.connectionClaims[0].ownerProcessId, process.pid, "the claim must bind to the exact provider host process");

    mcp = spawn(engine, ["mcp"], {
      cwd: resolve("."),
      env: { ...process.env, M9R_HOME: home, M9R_PROVIDER: "codex" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const messages = [];
    const lifecycle = [];
    let stdout = "";
    let stderr = "";
    mcp.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      while (stdout.includes("\n")) {
        const end = stdout.indexOf("\n");
        const line = stdout.slice(0, end);
        stdout = stdout.slice(end + 1);
        if (line.trim()) messages.push(JSON.parse(line));
      }
    });
    mcp.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      while (stderr.includes("\n")) {
        const end = stderr.indexOf("\n");
        const line = stderr.slice(0, end);
        stderr = stderr.slice(end + 1);
        if (line.startsWith("M9R MCP lifecycle ")) lifecycle.push(JSON.parse(line.slice("M9R MCP lifecycle ".length)));
      }
    });
    const request = async (id, method, params) => {
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return waitForJson(messages, id, mcp);
    };

    assert.equal((await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codex-live-acceptance", version: "1" } })).result?.serverInfo?.name, "m9r-mcp");
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = await request(2, "tools/list", {});
    for (const tool of listed.result?.tools ?? []) {
      const required = tool.inputSchema?.required ?? [];
      assert.equal(required.includes("token"), false, `${tool.name} must not require a per-call token`);
    }

    const first = await request(3, "tools/call", { name: "m9r_whoami", arguments: {} });
    const firstText = first.result?.content?.[0]?.text ?? "";
    assert.match(firstText, /@codex \(codex\)/, "the no-credential call must resolve the bound provider identity");
    assert.match(firstText, new RegExp(providerSession), "the identity must remain bound to the same provider session");
    assert.equal(readState(home).connectionBindings.length, 1, "the first MCP call must persist one private connection binding");

    const ready = lifecycle.find((event) => event.kind === "ready");
    assert.ok(ready?.workerPid, "the supervisor must report a private worker before reconnect");
    process.kill(ready.workerPid, "SIGTERM");
    const lostDeadline = Date.now() + 5000;
    while (!lifecycle.some((event) => event.kind === "lost") && Date.now() < lostDeadline) await sleep(20);
    assert.ok(lifecycle.some((event) => event.kind === "lost"), "the private worker loss must be observed");

    const second = await request(4, "tools/call", { name: "m9r_whoami", arguments: {} });
    const secondText = second.result?.content?.[0]?.text ?? "";
    assert.match(secondText, /@codex \(codex\)/, "the reconnected no-credential call must resolve the identity");
    assert.match(secondText, new RegExp(providerSession), "reconnect must preserve the exact provider session");
    assert.ok(lifecycle.some((event) => event.kind === "ready" && event.generation === 2), "the supervisor must create a replacement private worker");
  } finally {
    await stopChild(mcp, "installed MCP");
    await stopChild(feed, "installed feed");
    rmSync(home, { recursive: true, force: true });
  }
});

test("packaged provider-only MCP recovery retires a dead competing claim without a new session", async () => {
  assert.ok(process.platform === "win32", "this acceptance harness targets the installed Windows runtime");
  assert.ok(existsSync(engine), "the installed engine must be present");

  const home = mkdtempSync(join(tmpdir(), "m9r-item6-packaged-recovery-"));
  const oldSession = "22222222-2222-4222-8222-222222222222";
  const currentSession = "33333333-3333-4333-8333-333333333333";
  const oldProviderInput = {
    hook_event_name: "SessionStart",
    session_id: oldSession,
    canonical_session_id: oldSession,
    cwd: resolve("."),
  };
  let mcp = null;
  try {
    let oldHook = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      oldHook = runHook(home, "claude-code", oldProviderInput);
      if (oldHook.stdout.trim()) break;
      await sleep(250);
    }
    assert.ok(oldHook?.stdout.trim(), "the packaged hook must issue the initial private claim");

    const state = readState(home);
    const oldClaim = state.connectionClaims.find((claim) => claim.sessionId === oldSession);
    assert.ok(oldClaim, "the old session claim must be present");
    // Use a real process that was alive while both claims were issued, then
    // terminate it. This exercises the packaged runtime's actual Windows
    // liveness probe instead of relying on a guessed invalid PID.
    const exitedOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const exitedOwnerPid = exitedOwner.pid;
    assert.ok(exitedOwnerPid, "the dead-owner fixture must have a PID");
    await stopChild(exitedOwner, "dead-owner fixture");
    assert.throws(() => process.kill(exitedOwnerPid, 0), "the dead-owner fixture must no longer be observable");
    oldClaim.ownerProcessId = exitedOwnerPid;

    // SessionStart continuation is intentionally same-PID and reuses the
    // existing claim. To exercise provider-only recovery with two distinct
    // sessions, add the current session as the state shape produced by the
    // second provider process. The current test process is the real parent of
    // the packaged MCP child, so its PID is the exact selector for recovery.
    const issuedAt = new Date().toISOString();
    state.identities.push({
      token: "packaged-current-session-token",
      handle: "claude",
      provider: "claude-code",
      sessionId: currentSession,
      issuedAt,
    });
    state.connectionClaims.push({
      claimId: "packaged-current-session-claim",
      handle: "claude",
      provider: "claude-code",
      sessionId: currentSession,
      cwd: resolve("."),
      ownerProcessId: process.pid,
      issuedAt,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    assert.equal(state.connectionClaims.length, 2, "the old and current claims must exist before the simulated old process exits");
    writeFileSync(join(home, "state.json"), JSON.stringify(state), "utf8");

    const providerOnlyEnv = { ...process.env };
    delete providerOnlyEnv.M9R_CONNECTION_PROCESS_ID;
    delete providerOnlyEnv.M9R_CONNECTION_BINDING_ID;
    delete providerOnlyEnv.M9R_MCP_WORKER;

    mcp = spawn(engine, ["mcp"], {
      cwd: resolve("."),
      // Start the packaged supervisor as the provider child.  It must infer
      // this test process as the provider parent, then explicitly carry that
      // identity into its private worker.  Starting with M9R_MCP_WORKER=1
      // would intentionally skip the supervisor's parent-PID resolution and
      // would test the worker contract without the real provider boundary.
      env: { ...providerOnlyEnv, M9R_HOME: home, M9R_PROVIDER: "claude-code" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const messages = [];
    let stdout = "";
    mcp.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      while (stdout.includes("\n")) {
        const end = stdout.indexOf("\n");
        const line = stdout.slice(0, end);
        stdout = stdout.slice(end + 1);
        if (line.trim()) messages.push(JSON.parse(line));
      }
    });
    const request = async (id, method, params) => {
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return waitForJson(messages, id, mcp);
    };

    assert.equal((await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "packaged-recovery", version: "1" } })).result?.serverInfo?.name, "m9r-mcp");
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const result = await request(2, "tools/call", { name: "m9r_whoami", arguments: {} });
    const text = result.result?.content?.[0]?.text ?? "";
    assert.match(text, new RegExp(currentSession), `the existing provider-only connection must recover the current session; mcpPid=${mcp.pid}; state=${JSON.stringify(readState(home))}`);
    assert.deepEqual(readState(home).connectionClaims.map((claim) => claim.sessionId), [currentSession]);
  } finally {
    await stopChild(mcp, "packaged recovery MCP");
    rmSync(home, { recursive: true, force: true });
  }
});
