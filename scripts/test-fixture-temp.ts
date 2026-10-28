import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Test-only fixture roots must never be created in the repository. A killed
 * test process cannot run its `finally` blocks, so roots carry a marker and
 * are swept on the next run once they are old and their recorded owner is no
 * longer alive. This keeps interrupted suites from turning the checkout into
 * a second temp directory while never touching an unmarked user directory.
 */
const FIXTURE_PARENT = resolve(tmpdir(), "m9r-test-fixtures");
const STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const MARKER = ".m9r-test-fixture.json";
const roots = new Set<string>();
let lifecycleInstalled = false;

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isDirectChild(path: string): boolean {
  return resolve(path).startsWith(`${FIXTURE_PARENT}${process.platform === "win32" ? "\\" : "/"}`)
    && resolve(path).split(/[\\/]/).length === FIXTURE_PARENT.split(/[\\/]/).length + 1;
}

function sweepStaleRoots(): void {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  let entries: string[];
  try { entries = readdirSync(FIXTURE_PARENT); } catch { return; }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith("m9r-") || name.includes("..")) continue;
    const root = join(FIXTURE_PARENT, name);
    if (!isDirectChild(root)) continue;
    try {
      const info = lstatSync(root);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const markerPath = join(root, MARKER);
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { kind?: unknown; pid?: unknown; createdAt?: unknown };
      if (marker.kind !== "m9r-test-fixture" || typeof marker.createdAt !== "string") continue;
      const createdAt = Date.parse(marker.createdAt);
      if (!Number.isFinite(createdAt) || now - createdAt < STALE_AFTER_MS) continue;
      if (typeof marker.pid === "number" && processAlive(marker.pid)) continue;
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Unknown or locked directories are not evidence that M9R owns them.
      // Leave them alone; the next test run can try again.
    }
  }
}

function cleanupRoots(): void {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort during process exit */ }
  }
  roots.clear();
}

function installLifecycle(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  sweepStaleRoots();
  process.once("exit", cleanupRoots);
}

export function createTestFixtureRoot(prefix = "m9r-web-broker-"): string {
  installLifecycle();
  const root = mkdtempSync(join(FIXTURE_PARENT, prefix));
  writeFileSync(join(root, MARKER), JSON.stringify({
    kind: "m9r-test-fixture",
    pid: process.pid,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
  }) + "\n", "utf8");
  roots.add(root);
  return root;
}

export function removeTestFixtureRoot(root: string): void {
  roots.delete(root);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* a later sweep handles a locked fixture */ }
}

