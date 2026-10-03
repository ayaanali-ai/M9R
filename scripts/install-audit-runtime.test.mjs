import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

test("the packaged broker runs from persistent storage with no CLI or npm cache beside it", async () => {
  const temporary = mkdtempSync(resolve(".m9r-install-audit-"));
  const home = join(temporary, "home");
  const project = join(temporary, "project");
  mkdirSync(project);
  const source = resolve("cli/dist/m9r-web-broker.cjs");
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
  const directory = join(home, "bin", "broker", digest);
  mkdirSync(directory, { recursive: true });
  const entry = join(directory, "m9r-web-broker.cjs");
  copyFileSync(source, entry);
  // This fixture key belongs only to this test. Retain it in memory because
  // production ACLs correctly prevent the Codex sandbox reading it afterward.
  const key = randomBytes(32).toString("hex");
  const keyPath = join(home, "web-broker.key");
  writeFileSync(keyPath, key, { mode: 0o600 });
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [entry, "web", "serve", "--home", home, "--port", String(port), "--project-root", project], {
    cwd: project, windowsHide: true, stdio: "ignore",
  });
  let spawnError;
  child.on("error", error => { spawnError = error; });
  const stopped = new Promise(resolve => child.once("close", resolve));
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnError) throw spawnError;
      healthy = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }).then(response => response.ok).catch(() => false);
      if (healthy) break;
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(healthy, true, "the copied bundle must start without sibling CLI modules or dependencies");
    const response = await fetch(`http://127.0.0.1:${port}/web/status`, { headers: { "x-m9r-key": key } });
    assert.equal(response.ok, true, "the running broker must authenticate its local owner");
  } finally {
    child.kill();
    await stopped;
    if (process.platform === "win32") spawnSync("icacls", [keyPath, "/reset"], { windowsHide: true, stdio: "ignore" });
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("routine commands do not start an experimental runtime", () => {
  const source = readFileSync("scripts/m9r-cli.ts", "utf8");
  assert.doesNotMatch(source, /ensureRuntimeAfterAgentCommand|runtimeTrigger|autostartConsented/);
  assert.match(source, /join\(root, "bin", "broker", digest\)/);
});

test("the Windows CMD launcher runs its script under a Restricted parent without changing policy", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(resolve(".m9r-launcher-audit-"));
  try {
    copyFileSync("scripts/install-m9r.cmd", join(directory, "install-m9r.cmd"));
    writeFileSync(join(directory, "install-m9r.ps1"), 'Write-Output "launcher-ok"\n');
    const command = `& '${join(directory, "install-m9r.cmd").replaceAll("'", "''")}'; if ((Get-ExecutionPolicy -Scope Process) -ne 'Restricted') { exit 2 }; exit $LASTEXITCODE`;
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Restricted", "-Command", command], { windowsHide: true, encoding: "utf8", timeout: 10000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /launcher-ok/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
