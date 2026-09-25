import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { assembleCoordinatorSession, createCoordinatorIdentity, createCoordinatorNodeClient, createCoordinatorSessionDescriptor, signCoordinatorSession } from "@/lib/native/web-coordinator-client";

const projectRoot = process.cwd();

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

test("local Durable Object establishes a signed session, routes sealed frames, and rejects replay", { timeout: 90_000 }, async () => {
  const port = await freePort();
  const persist = mkdtempSync(join(tmpdir(), "m9r-coordinator-worker-"));
  const child = spawn(process.execPath, [
    resolve(projectRoot, "node_modules/wrangler/bin/wrangler.js"),
    "dev", "--local", "--config", "services/web-coordinator/wrangler.jsonc", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persist, "--log-level", "error",
  ], { cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_CONFIG_HOME: persist, XDG_DATA_HOME: persist } });
  const childExit = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    let ready = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.status === 404) { ready = true; break; }
      } catch { /* local Wrangler is still starting */ }
      await delay(200);
    }
    assert.equal(ready, true, `local Wrangler did not become ready: ${output}`);

    const alice = createCoordinatorIdentity();
    const bob = createCoordinatorIdentity();
    const now = Date.now();
    const descriptor = createCoordinatorSessionDescriptor(`test-${crypto.randomUUID()}`, [alice.member, bob.member], now, now + 60 * 60 * 1_000);
    const signed = assembleCoordinatorSession(descriptor, [signCoordinatorSession(alice, descriptor), signCoordinatorSession(bob, descriptor)]);
    const sender = createCoordinatorNodeClient(alice, { endpoint: baseUrl });
    const recipient = createCoordinatorNodeClient(bob, { endpoint: baseUrl });

    await sender.registerSession(signed);
    await sender.registerSession(signed);
    const sent = await sender.send(signed, bob.member.ownerId, { operation: "read", page: "https://example.test" }, { sequence: 1, kind: "web.command" });
    const replay = await fetch(`${baseUrl}/v1/sessions/${descriptor.sessionId}/frames`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sent.frame) });
    assert.equal(replay.status, 409);
    const received = await recipient.receive(signed);
    assert.deepEqual(received.map((message) => message.payload), [{ operation: "read", page: "https://example.test" }]);

    const forged = { ...signed, descriptor: { ...descriptor, expiresAt: descriptor.expiresAt + 1 } };
    const rejected = await fetch(`${baseUrl}/v1/sessions/${descriptor.sessionId}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(forged) });
    assert.equal(rejected.status, 400);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(resolveExit, 10_000);
      void childExit.then(() => { clearTimeout(timer); resolveExit(); });
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      try { rmSync(persist, { recursive: true, force: true }); } catch { /* Windows may still release Miniflare files after the process exits. */ }
    }
  }
});
