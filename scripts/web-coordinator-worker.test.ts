import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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

test("local Durable Object establishes a signed session, routes sealed frames, and rejects replay", { timeout: 90_000 }, async (context) => {
  const boundedFetch: typeof fetch = (input, init) => {
    const signals = [context.signal, AbortSignal.timeout(3_000)];
    if (init?.signal) signals.push(init.signal);
    return fetch(input, { ...init, signal: AbortSignal.any(signals) });
  };
  const port = await freePort();
  const persist = mkdtempSync(join(projectRoot, ".m9r-coordinator-worker-"));
  const tempProject = join(persist, "project");
  const tempService = join(tempProject, "services", "web-coordinator");
  const tempServiceSrc = join(tempService, "src");
  const tempNativeSrc = join(tempProject, "src", "lib", "native");
  mkdirSync(tempServiceSrc, { recursive: true });
  mkdirSync(tempNativeSrc, { recursive: true });
  for (const file of ["index.ts", "protocol.ts"]) {
    copyFileSync(resolve(projectRoot, "services/web-coordinator/src", file), join(tempServiceSrc, file));
  }
  for (const file of ["web-coordinator-core.ts", "web-coordinator-protocol.ts"]) {
    copyFileSync(resolve(projectRoot, "src/lib/native", file), join(tempNativeSrc, file));
  }
  const workerConfig = JSON.parse(readFileSync(resolve(projectRoot, "services/web-coordinator/wrangler.jsonc"), "utf8")) as Record<string, unknown>;
  delete workerConfig.$schema;
  const tempConfig = join(tempService, "wrangler.jsonc");
  writeFileSync(tempConfig, `${JSON.stringify(workerConfig, null, 2)}\n`, "utf8");
  const child = spawn(process.execPath, [
    resolve(projectRoot, "node_modules/wrangler/bin/wrangler.js"),
    "dev", "--local", "--config", tempConfig, "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(persist, "state"), "--log-level", "error",
  ], { cwd: tempProject, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_CONFIG_HOME: join(persist, "config"), XDG_DATA_HOME: join(persist, "data") } });
  const childExit = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-16_384); });
  child.stderr.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-16_384); });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    let ready = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await boundedFetch(`${baseUrl}/health`);
        if (response.status === 404) { ready = true; break; }
      } catch (error) {
        if (context.signal.aborted) throw error;
        /* local Wrangler is still starting */
      }
      await delay(200);
    }
    assert.equal(ready, true, `local Wrangler did not become ready: ${output}`);

    const alice = createCoordinatorIdentity();
    const bob = createCoordinatorIdentity();
    const now = Date.now();
    const descriptor = createCoordinatorSessionDescriptor(`test-${crypto.randomUUID()}`, [alice.member, bob.member], now, now + 60 * 60 * 1_000);
    const signed = assembleCoordinatorSession(descriptor, [signCoordinatorSession(alice, descriptor), signCoordinatorSession(bob, descriptor)]);
    const sender = createCoordinatorNodeClient(alice, { endpoint: baseUrl, fetcher: boundedFetch });
    const recipient = createCoordinatorNodeClient(bob, { endpoint: baseUrl, fetcher: boundedFetch });

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
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32" && child.pid) {
        const killed = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
        if (killed.error || killed.status !== 0) child.kill();
      } else {
        child.kill();
      }
    }
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(resolveExit, 10_000);
      void childExit.then(() => { clearTimeout(timer); resolveExit(); });
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      try { rmSync(persist, { recursive: true, force: true }); } catch { /* Windows may still release Miniflare files after the process exits. */ }
    }
  }
});
