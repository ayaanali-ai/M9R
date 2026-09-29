import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(".");

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.listen(0, "127.0.0.1", resolveListen).once("error", reject));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

function rootTag(root) {
  const normalized = root.replaceAll("/", "\\").toLowerCase().replace(/\\+$/, "");
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(normalized, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function ownerPipePath(home) {
  const user = userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_");
  return `\\\\.\\pipe\\m9r-owner-${user}-${rootTag(home)}`;
}

async function ownerRequest(path, request) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let response = "";
    const finish = (error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(JSON.parse(response));
    };
    socket.setTimeout(2_000, () => finish(new Error("owner pipe timeout")));
    socket.once("error", finish);
    socket.on("data", (chunk) => { response += chunk.toString("utf8"); });
    socket.on("end", () => finish());
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
  });
}

async function ownerRequestRetry(path, request) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await ownerRequest(path, request);
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw lastError;
}

test("packaged broker rejects unauthenticated management and keeps its owner pipe read-only", async () => {
  const build = spawnSync(process.execPath, [resolve(root, "scripts/build-cli.mjs")], { cwd: root, encoding: "utf8", timeout: 120_000 });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const bundle = resolve(root, "cli/dist/m9r-web-broker.cjs");
  const extensionManifest = JSON.parse(await readFile(resolve(root, "cli/dist/extension/manifest.json"), "utf8"));
  assert.ok(extensionManifest.key, "packaged extension must carry its fixed development ID");
  await assert.rejects(access(resolve(root, "cli/dist/extension/store-assets")));
  const home = await mkdtemp(join(tmpdir(), "m9r-web-broker-package-"));
  const port = await freePort();
  const child = spawn(process.execPath, [bundle, "--home", home, "--port", String(port)], {
    cwd: root,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-8_192); });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-8_192); });
  let exited = false;
  child.once("exit", () => { exited = true; });
  try {
    let health = false;
    for (let i = 0; i < 60; i += 1) {
      if (child.exitCode !== null) break;
      health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok).catch(() => false);
      if (health) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.ok(health, `packaged broker did not become healthy (exit=${child.exitCode}, signal=${child.signalCode}):\n${childOutput}`);
    const status = await fetch(`http://127.0.0.1:${port}/web/status`);
    assert.equal(status.status, 401);
    const pipeMutation = await ownerRequestRetry(ownerPipePath(home), { method: "POST", path: "/web/shutdown", body: {} });
    assert.equal(pipeMutation.ok, false);
    assert.match(pipeMutation.error, /read-only/);
    const shutdownResponse = await fetch(`http://127.0.0.1:${port}/web/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(shutdownResponse.status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200, "unauthenticated shutdown must not stop the packaged broker");
    assert.equal(exited, false);
  } finally {
    if (!exited) {
      child.kill();
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
    if (process.platform === "win32") {
      for (const group of ["CodexSandboxUsers", "CodexSandboxOffline"]) {
        spawnSync("icacls", [join(home, "web-broker.key"), "/remove:d", group], { windowsHide: true, stdio: "ignore" });
      }
      spawnSync("icacls", [join(home, "web-broker.key"), "/grant:r", `${userInfo().username}:(F)`], { windowsHide: true, stdio: "ignore" });
    }
    await rm(home, { recursive: true, force: true });
  }
});

const standaloneBroker = resolve(root, "engine/dist/m9r-web-broker.exe");
test("standalone broker runs without Node in PATH and rejects owner-pipe mutations", {
  skip: process.platform !== "win32" || !existsSync(standaloneBroker)
    ? "build the Windows engine release first"
    : false,
}, async () => {
  const systemDirectory = process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : "C:\\Windows\\System32";
  const childEnv = { ...process.env, PATH: systemDirectory };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_PATH;
  const nodeLookup = spawnSync("where.exe", ["node.exe"], { env: childEnv, encoding: "utf8", windowsHide: true });
  assert.notEqual(nodeLookup.status, 0, `test PATH unexpectedly resolves Node: ${nodeLookup.stdout}`);

  const home = await mkdtemp(join(tmpdir(), "m9r-web-broker-sea-"));
  const port = await freePort();
  const child = spawn(standaloneBroker, ["--home", home, "--port", String(port)], {
    cwd: root,
    env: childEnv,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-8_192); });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-8_192); });
  let exited = false;
  child.once("exit", () => { exited = true; });
  try {
    let health = false;
    for (let i = 0; i < 60; i += 1) {
      if (child.exitCode !== null) break;
      health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok).catch(() => false);
      if (health) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.equal(health, true, `standalone broker did not become healthy without Node on PATH (exit=${child.exitCode}, signal=${child.signalCode}):\n${childOutput}`);
    const status = await fetch(`http://127.0.0.1:${port}/web/status`);
    assert.equal(status.status, 401);
    const pipeMutation = await ownerRequestRetry(ownerPipePath(home), { method: "POST", path: "/web/shutdown", body: {} });
    assert.equal(pipeMutation.ok, false);
    assert.match(pipeMutation.error, /read-only/);
    const shutdownResponse = await fetch(`http://127.0.0.1:${port}/web/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(shutdownResponse.status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200, "unauthenticated shutdown must not stop the standalone broker");
    assert.equal(exited, false);
  } finally {
    if (!exited) {
      child.kill();
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
    for (const group of ["CodexSandboxUsers", "CodexSandboxOffline"]) {
      spawnSync("icacls", [join(home, "web-broker.key"), "/remove:d", group], { windowsHide: true, stdio: "ignore" });
    }
    spawnSync("icacls", [join(home, "web-broker.key"), "/grant:r", `${userInfo().username}:(F)`], { windowsHide: true, stdio: "ignore" });
    await rm(home, { recursive: true, force: true });
  }
});
