import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
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

test("packaged broker bundle starts, serves authenticated status, and accepts owner shutdown", async () => {
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
    stdio: ["ignore", "ignore", "ignore"],
  });
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
    assert.equal(health, true, "packaged broker did not become healthy");
    const key = (await readFile(join(home, "web-broker.key"), "utf8")).trim();
    const status = await fetch(`http://127.0.0.1:${port}/web/status`, { headers: { "x-m9r-key": key } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).extensionReady, false);
    const shutdown = await fetch(`http://127.0.0.1:${port}/web/shutdown`, { method: "POST", headers: { "x-m9r-key": key } });
    assert.equal(shutdown.status, 200);
    for (let i = 0; i < 30 && !exited; i += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assert.equal(exited, true, "owner shutdown did not close the packaged broker process");
  } finally {
    if (!exited) child.kill();
    await rm(home, { recursive: true, force: true });
  }
});
