import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runMcpStdioSupervisor } from "../src/lib/native/mcp-stdio-supervisor.ts";

const fixture = String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
let client;
readline.createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'initialize') {
  client = m.params.clientInfo;
  console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{listChanged:true}},serverInfo:{name:'m9r-fixture',version:'1'}}}));
 } else if (m.method === 'tools/call' && m.params.name === 'crash_after_effect') {
  fs.appendFileSync(process.argv[1], 'effect\n');
  process.exit(12);
 } else if (m.id !== undefined) {
  console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[],client}}));
 }
});
`;

function harness(spawnWorker: () => ReturnType<typeof spawn>, attempts = 3) {
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
    retryDelayMs: 5, handshakeTimeoutMs: 500, shutdownTimeoutMs: 500 });
  const send = (message: any) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const response = async (id: number, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = messages.find(m => m.id === id);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`No response for ${id}`);
  };
  return { runtime, send, response, messages, output };
}

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
