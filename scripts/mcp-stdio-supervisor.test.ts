import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runMcpStdioSupervisor } from "../src/lib/native/mcp-stdio-supervisor.ts";
import { createLocalStore } from "../src/lib/native/local-store.ts";
import { stopChildProcess } from "./runtime-child-shutdown.mjs";

const fixture = String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
let client;
let lastRoots;
readline.createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'initialize') {
  client = m.params.clientInfo;
  console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{listChanged:true}},serverInfo:{name:'m9r-fixture',version:'1'}}}));
  if (m.params.capabilities.roots) console.log(JSON.stringify({jsonrpc:'2.0',id:7,method:'roots/list'}));
 } else if (!m.method && m.id === 7) {
  lastRoots = m.result;
 } else if (m.method === 'tools/call' && m.params.name === 'crash_after_effect') {
  fs.appendFileSync(process.argv[1], 'effect\n');
  process.exit(12);
 } else if (m.method === 'tools/call' && m.params.name === 'slow_read') {
  setTimeout(() => console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{client}})), 150);
 } else if (m.id !== undefined) {
  console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[],client,lastRoots}}));
 }
});
`;

function harness(spawnWorker: () => ReturnType<typeof spawn>, attempts = 3, workerRevision?: () => string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: any[] = [];
  let buffer = "";
  output.on("data", chunk => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      messages.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const runtime = runMcpStdioSupervisor({ input, output, spawnWorker, maxAttempts: attempts,
    retryDelayMs: 5, handshakeTimeoutMs: 500, shutdownTimeoutMs: 500, workerRevision, refreshEveryMs: 10 });
  const send = (message: any) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const response = async (id: number, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = messages.find(m => m.id === id && !m.method);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`No response for ${id}`);
  };
  return { runtime, send, response, messages, input, output };
}

test("a healthy worker adopts an updated trusted runtime revision without closing the provider pipe", async () => {
  let revision = "first";
  let starts = 0;
  const h = harness(() => { starts++; return spawn(process.execPath, ["-e", fixture], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }, 3, () => revision);
  try {
    h.send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "arbitrary-local-provider", version: "1" } } });
    await h.response(1);
    h.send({ method: "notifications/initialized" });
    revision = "second";
    const deadline = Date.now() + 3000;
    while (starts < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(starts, 2, "healthy old code must refresh automatically, not wait for a crash or owner restart");
    h.send({ id: 2, method: "tools/list" });
    assert.equal((await h.response(2)).result.client.name, "arbitrary-local-provider");
    assert.equal(h.output.destroyed, false);
  } finally { await h.runtime.stop(); }
});

test("queues the first provider messages until the private worker handshake completes", async () => {
  const h = harness(() => spawn(process.execPath, ["-e", fixture], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }), 3);
  try {
    h.send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pipelined-provider", version: "1" } } });
    h.send({ method: "notifications/initialized" });
    h.send({ id: 2, method: "tools/list" });
    assert.equal((await h.response(1)).result.serverInfo.name, "m9r-fixture");
    assert.equal((await h.response(2)).result.client.name, "pipelined-provider");
  } finally { await h.runtime.stop(); }
});

test("an update waits for an in-flight tool response before retiring the private worker", async () => {
  let revision = "first";
  let starts = 0;
  const h = harness(() => { starts++; return spawn(process.execPath, ["-e", fixture], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }, 3, () => revision);
  try {
    h.send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "local-provider", version: "1" } } });
    await h.response(1);
    h.send({ method: "notifications/initialized" });
    h.send({ id: 2, method: "tools/call", params: { name: "slow_read", arguments: {} } });
    revision = "second";
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(starts, 1, "the active request must not be interrupted by a file update");
    assert.equal((await h.response(2)).result.client.name, "local-provider");
    const deadline = Date.now() + 3000;
    while (starts < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(starts, 2);
  } finally { await h.runtime.stop(); }
});

test("provider metadata survives a multibyte UTF-8 frame split across pipe chunks", async () => {
  const h = harness(() => spawn(process.execPath, ["-e", fixture], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }));
  try {
    const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "local-α-model", version: "1" },
    } }) + "\n");
    const split = frame.indexOf(Buffer.from("α")) + 1;
    h.input.write(frame.subarray(0, split));
    h.input.write(frame.subarray(split));
    await h.response(1);
    h.send({ method: "notifications/initialized" });
    h.send({ id: 2, method: "tools/list" });
    assert.equal((await h.response(2)).result.client.name, "local-α-model");
  } finally { await h.runtime.stop(); }
});

for (const provider of ["local-open-weight-model", "arbitrary-provider-not-in-a-catalog"]) {
  test(`keeps ${provider}'s connection and identity through worker loss without replaying effects`, async () => {
    const root = mkdtempSync(join(tmpdir(), "m9r-supervisor-"));
    const marker = join(root, "effects");
    let starts = 0;
    const h = harness(() => {
      starts++;
      return spawn(process.execPath, ["-e", fixture, marker], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    });
    try {
      h.send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: provider, version: "1" } } });
      assert.equal((await h.response(1)).result.serverInfo.name, "m9r-fixture");
      h.send({ method: "notifications/initialized" });
      h.send({ id: 2, method: "tools/call", params: { name: "crash_after_effect", arguments: { operationId: "retained-operation" } } });
      const lost = await h.response(2);
      assert.equal(lost.error.data.dispatchStatus, "unknown");
      assert.equal(lost.error.data.replayAllowed, false);
      h.send({ id: 3, method: "tools/list" });
      const recovered = await h.response(3);
      assert.equal(recovered.result.client.name, provider);
      assert.equal(readFileSync(marker, "utf8"), "effect\n");
      assert.equal(starts, 2);
      assert.equal(h.output.destroyed, false);
    } finally {
      await h.runtime.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("bounds failed worker starts and answers through the same outer connection", async () => {
  let starts = 0;
  const h = harness(() => {
    starts++;
    return spawn(join(tmpdir(), "m9r-nonexistent-fixture-executable"), [], { stdio: ["pipe", "pipe", "pipe"] });
  }, 2);
  try {
    h.send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "any-provider", version: "1" } } });
    const failure = await h.response(1);
    assert.equal(failure.error.data.dispatchStatus, "not-dispatched");
    assert.equal(starts, 2);
    assert.equal(h.output.destroyed, false);
  } finally { await h.runtime.stop(); }
});

test("late host replies cannot answer a new worker's server request", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-supervisor-"));
  const h = harness(() => spawn(process.execPath, ["-e", fixture, join(root, "effects")], { stdio: ["pipe", "pipe", "pipe"] }));
  try {
    h.send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: { roots: {} }, clientInfo: { name: "local-model", version: "1" } } });
    await h.response(1);
    h.send({ method: "notifications/initialized" });
    h.send({ id: 2, method: "tools/call", params: { name: "crash_after_effect" } });
    await h.response(2);
    h.send({ id: 3, method: "tools/list" });
    await h.response(3);
    const requests = h.messages.filter(m => m.method === "roots/list");
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].id, requests[1].id);
    h.send({ id: requests[0].id, result: { roots: ["stale"] } });
    h.send({ id: 4, method: "tools/list" });
    assert.equal((await h.response(4)).result.lastRoots, undefined);
    h.send({ id: requests[1].id, result: { roots: ["current"] } });
    h.send({ id: 5, method: "tools/list" });
    assert.deepEqual((await h.response(5)).result.lastRoots, { roots: ["current"] });
  } finally { await h.runtime.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("closing during initialization cancels the private worker promptly", async () => {
  const input = new PassThrough();
  const runtime = runMcpStdioSupervisor({ input, output: new PassThrough(),
    spawnWorker: () => spawn(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] }),
    handshakeTimeoutMs: 4000, shutdownTimeoutMs: 20 });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  const started = Date.now();
  await runtime.stop();
  assert.ok(Date.now() - started < 500, "shutdown must cancel initialization rather than waiting for its deadline");
});

test("the real M9R entry recovers an isolated local provider without rotating its identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-real-supervisor-"));
  const store = createLocalStore(root);
  const identity = store.issueIdentity("local-model", "custom-open-weight-provider", "local-session");
  const parent = spawn(process.execPath, ["--experimental-transform-types", "--import", "./scripts/register-alias.mjs", "scripts/m9r-mcp.ts"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, M9R_HOME: root, M9R_MCP_WORKER: "" },
  });
  const messages: any[] = [];
  const events: any[] = [];
  let output = "";
  let diagnostics = "";
  const startupErrors: string[] = [];
  parent.stdout.on("data", chunk => {
    output += chunk.toString();
    while (output.includes("\n")) {
      const end = output.indexOf("\n");
      messages.push(JSON.parse(output.slice(0, end))); output = output.slice(end + 1);
    }
  });
  parent.stderr.on("data", chunk => {
    diagnostics += chunk.toString();
    while (diagnostics.includes("\n")) {
      const end = diagnostics.indexOf("\n");
      const line = diagnostics.slice(0, end); diagnostics = diagnostics.slice(end + 1);
      if (line.startsWith("M9R MCP lifecycle ")) events.push(JSON.parse(line.slice("M9R MCP lifecycle ".length)));
      else startupErrors.push(line.replaceAll(identity.token, "[redacted-test-credential]"));
    }
  });
  async function request(id: number, method: string, params: object) {
    parent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const message = messages.find(x => x.id === id && !x.method);
      if (message) return message;
      if (parent.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Isolated MCP entry did not answer (exit ${parent.exitCode}); ${startupErrors.join(" ").slice(0, 1000)}`);
  }
  try {
    assert.ok((await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "local-open-weight-runtime", version: "1" } })).result);
    parent.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const args = { name: "m9r_whoami", arguments: { token: identity.token } };
    assert.match((await request(2, "tools/call", args)).result.content[0].text, /@local-model \(custom-open-weight-provider\)/);
    const workerPid = events.find(x => x.kind === "ready")?.workerPid;
    assert.ok(Number.isSafeInteger(workerPid));
    // This PID is the private worker spawned by our isolated test parent. No
    // installed provider/runtime process participates in this fault injection.
    process.kill(workerPid, "SIGTERM");
    const deadline = Date.now() + 3000;
    while (!events.some(x => x.kind === "lost") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(events.some(x => x.kind === "lost"));
    const recovered = await request(3, "tools/call", args);
    assert.match(recovered.result.content[0].text, /@local-model \(custom-open-weight-provider\)/);
    assert.ok(events.some(x => x.kind === "ready" && x.generation === 2));
    assert.ok(store.verifyIdentity(identity.token));
  } finally { await stopChildProcess(parent); rmSync(root, { recursive: true, force: true }); }
});
