import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { parseWatchdogLockPid, parseWatchdogLockStartedAt, shouldStartWatchdog, shouldRelaunch, stillHoldsWatchdogLock, WATCHDOG_LOCK_MAX_AGE_MS } from "@/lib/oathlock-watchdog";

test("parseWatchdogLockPid reads a valid lock and rejects anything malformed", () => {
  assert.equal(parseWatchdogLockPid(JSON.stringify({ pid: 4242, startedAt: "x" })), 4242);
  assert.equal(parseWatchdogLockPid(null), null);
  assert.equal(parseWatchdogLockPid("not json"), null);
  assert.equal(parseWatchdogLockPid(JSON.stringify({ pid: "4242" })), null);
  assert.equal(parseWatchdogLockPid(JSON.stringify({ pid: -1 })), null);
  assert.equal(parseWatchdogLockPid(JSON.stringify({ pid: 1.5 })), null);
});

test("shouldStartWatchdog starts fresh when there is no lock, or the locked pid is dead, and refuses when a live one already holds it", () => {
  assert.equal(shouldStartWatchdog(null, () => true), true);
  assert.equal(shouldStartWatchdog(999, () => false), true);
  assert.equal(shouldStartWatchdog(999, () => true), false);
});

test("parseWatchdogLockStartedAt reads a valid timestamp and rejects anything malformed", () => {
  assert.equal(parseWatchdogLockStartedAt(JSON.stringify({ pid: 1, startedAt: "2026-08-21T00:00:00.000Z" })), Date.parse("2026-08-21T00:00:00.000Z"));
  assert.equal(parseWatchdogLockStartedAt(null), null);
  assert.equal(parseWatchdogLockStartedAt("not json"), null);
  assert.equal(parseWatchdogLockStartedAt(JSON.stringify({ pid: 1 })), null);
  assert.equal(parseWatchdogLockStartedAt(JSON.stringify({ startedAt: "nonsense" })), null);
});

test("shouldStartWatchdog ignores a live pid once the lock is implausibly old, since Windows recycles pids", () => {
  const now = Date.now();
  // A hard-killed watchdog leaves its lock behind; the pid can later belong to
  // an unrelated process, which would otherwise block relaunches forever.
  assert.equal(shouldStartWatchdog(999, () => true, now - WATCHDOG_LOCK_MAX_AGE_MS - 1, now), true);
  assert.equal(shouldStartWatchdog(999, () => true, now - 60_000, now), false);
  assert.equal(shouldStartWatchdog(999, () => true, null, now), false);
  assert.equal(shouldStartWatchdog(999, () => false, now - 60_000, now), true);
});

test("stillHoldsWatchdogLock tells the startup-race loser it no longer owns the slot", () => {
  assert.equal(stillHoldsWatchdogLock(JSON.stringify({ pid: 4242 }), 4242), true);
  assert.equal(stillHoldsWatchdogLock(JSON.stringify({ pid: 4243 }), 4242), false);
  assert.equal(stillHoldsWatchdogLock(null, 4242), false);
  assert.equal(stillHoldsWatchdogLock("not json", 4242), false);
});

/**
 * The regression this guards: a watchdog that found the slot already held
 * returned from runWatchdog() but the OS process kept running, so every
 * spurious relaunch left another live-but-idle node process behind (four were
 * found running at once on a real machine). Returning is not enough -- the
 * process itself has to be gone.
 */
test("a watchdog started while the slot is already held exits instead of lingering", async (t) => {
  const repoRoot = resolvePath(import.meta.dirname, "..");
  const dir = await mkdtemp(join(tmpdir(), "oathlock-watchdog-"));
  // The CLI resolves both its "@/" imports and its lock file from the cwd, so
  // the child runs in a throwaway directory with its own loader shim. That
  // keeps the test away from the repo's real watchdog lock.
  await writeFile(join(dir, "alias.mjs"), [
    `import { existsSync } from "node:fs";`,
    `import { fileURLToPath, pathToFileURL } from "node:url";`,
    `import { resolve as resolvePath, extname } from "node:path";`,
    `const ROOT = ${JSON.stringify(repoRoot)};`,
    `export async function resolve(specifier, context, nextResolve) {`,
    `  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {`,
    `    const relative = fileURLToPath(new URL(specifier, context.parentURL));`,
    `    if (!extname(relative) && existsSync(relative + ".ts")) return nextResolve(pathToFileURL(relative + ".ts").href, context);`,
    `  }`,
    `  if (specifier.startsWith("@/")) {`,
    `    let full = resolvePath(ROOT, "src", specifier.slice(2));`,
    `    if (!extname(full)) full += ".ts";`,
    `    return nextResolve(pathToFileURL(full).href, context);`,
    `  }`,
    `  return nextResolve(specifier, context);`,
    `}`,
  ].join("\n"));
  await writeFile(join(dir, "boot.mjs"), `import { register } from "node:module";\nregister("./alias.mjs", import.meta.url);\n`);
  await mkdir(join(dir, ".oathlock"), { recursive: true });
  // This test process is unquestionably alive, so the slot reads as held.
  await writeFile(join(dir, ".oathlock", "watchdog.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--import", "./boot.mjs",
    join(repoRoot, "scripts", "m9r-cli.ts"),
    "watchdog", "run",
  ], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  const exited = await new Promise<number | null | "timeout">((resolveResult) => {
    const timer = setTimeout(() => resolveResult("timeout"), 20_000);
    child.once("exit", (code) => { clearTimeout(timer); resolveResult(code); });
  });
  if (exited === "timeout") {
    child.kill("SIGKILL");
    assert.fail("watchdog did not exit within 20s while the slot was already held");
  }
  assert.equal(exited, 0, `watchdog exited non-zero. stderr:\n${stderr}`);
  t.diagnostic(`stood-down watchdog exited with code ${exited}`);
});

test("shouldRelaunch only fires once consecutive failures reach the threshold, not on the first miss", () => {
  assert.equal(shouldRelaunch(1, 3), false);
  assert.equal(shouldRelaunch(2, 3), false);
  assert.equal(shouldRelaunch(3, 3), true);
  assert.equal(shouldRelaunch(4, 3), true);
  assert.equal(shouldRelaunch(0, 3), false);
});
