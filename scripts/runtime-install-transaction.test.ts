import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasPendingRuntimeTransaction, installRuntimeTransaction, recoverRuntimeTransactions } from "@/lib/native/runtime-install-transaction";
import { createHash, randomUUID } from "node:crypto";

test("interrupted updates restore verified backups and reject tampering before replacement", () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-runtime-recovery-"));
  const bin = join(home, "bin"); mkdirSync(bin);
  const transaction = join(home, "runtime-backups", randomUUID());
  mkdirSync(join(transaction, "previous"), { recursive: true });
  const target = join(bin, "engine");
  const previous = join(transaction, "previous", "engine");
  writeFileSync(target, "new"); writeFileSync(previous, "old");
  const record = { status: "applying", targetDir: bin, files: [{ path: "engine", existed: true, previousSha256: createHash("sha256").update("old").digest("hex") }] };
  const journal = join(transaction, "transaction.json");
  writeFileSync(journal, JSON.stringify(record));
  try {
    assert.equal(hasPendingRuntimeTransaction(bin), true);
    writeFileSync(previous, "tampered");
    assert.throws(() => recoverRuntimeTransactions(bin, () => { throw new Error("must not replace"); }), /backup hash mismatch/);
    assert.equal(readFileSync(target, "utf8"), "new");
    writeFileSync(previous, "old");
    recoverRuntimeTransactions(bin, (from, to) => { copyFileSync(from, to); return []; });
    assert.equal(readFileSync(target, "utf8"), "old");
    assert.equal(hasPendingRuntimeTransaction(bin), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a failed component replacement restores all previous runtime files", () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-runtime-rollback-"));
  const bin = join(home, "bin"); mkdirSync(bin);
  const files = ["engine", "broker", "new-host"].map((name) => ({ from: join(home, name), to: join(bin, name) }));
  for (const file of files) writeFileSync(file.from, "new");
  writeFileSync(files[0]!.to, "old-engine"); writeFileSync(files[1]!.to, "old-broker");
  let calls = 0;
  try {
    assert.throws(() => installRuntimeTransaction(bin, files, (from, to) => {
      copyFileSync(from, to); if (++calls === 3) throw new Error("simulated third-component failure"); return [];
    }), /previous runtime was restored/);
    assert.equal(readFileSync(files[0]!.to, "utf8"), "old-engine");
    assert.equal(readFileSync(files[1]!.to, "utf8"), "old-broker");
    assert.equal(existsSync(files[2]!.to), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runtime update replaces changed files, skips identical files, and removes obsolete owned files transactionally", () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-runtime-reconcile-"));
  const bin = join(home, "bin"); mkdirSync(bin);
  const engineSource = join(home, "engine-source");
  const brokerSource = join(home, "broker-source");
  const engine = join(bin, "engine");
  const broker = join(bin, "broker");
  const oldHook = join(bin, "m9r-hook-old.exe");
  writeFileSync(engineSource, "engine-v2");
  writeFileSync(brokerSource, "broker-v1");
  writeFileSync(engine, "engine-v1");
  writeFileSync(broker, "broker-v1");
  writeFileSync(oldHook, "old-hook");
  const replaced: string[] = [];
  try {
    const changed = installRuntimeTransaction(bin, [
      { from: engineSource, to: engine },
      { from: brokerSource, to: broker },
    ], (from, to) => { replaced.push(to); copyFileSync(from, to); return []; }, [oldHook]);
    assert.deepEqual(replaced, [engine], "only the changed engine is replaced");
    assert.equal(readFileSync(engine, "utf8"), "engine-v2");
    assert.equal(readFileSync(broker, "utf8"), "broker-v1");
    assert.equal(existsSync(oldHook), false, "obsolete owned runtime files are removed");
    const backupRoot = join(home, "runtime-backups");
    assert.equal(existsSync(backupRoot) ? readdirSync(backupRoot).length : 0, 0, "successful updates leave no prior runtime snapshot behind");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a locked stable target aborts and rolls the full package back without creating retired siblings", () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-runtime-locked-"));
  const bin = join(home, "bin"); mkdirSync(bin);
  const sourceA = join(home, "a-source"); const sourceB = join(home, "b-source");
  const targetA = join(bin, "a.exe"); const targetB = join(bin, "b.exe");
  writeFileSync(sourceA, "new-a"); writeFileSync(sourceB, "new-b");
  writeFileSync(targetA, "old-a"); writeFileSync(targetB, "old-b");
  let replaceCalls = 0;
  try {
    assert.throws(() => installRuntimeTransaction(bin, [
      { from: sourceA, to: targetA },
      { from: sourceB, to: targetB },
    ], (from, to) => {
      if (++replaceCalls === 2) throw new Error(`locked: ${to}`);
      copyFileSync(from, to);
      return [];
    }), /previous runtime was restored/);
    assert.equal(readFileSync(targetA, "utf8"), "old-a");
    assert.equal(readFileSync(targetB, "utf8"), "old-b");
    assert.deepEqual(readdirSync(bin).sort(), ["a.exe", "b.exe"]);
    const backupRoot = join(home, "runtime-backups");
    assert.equal(existsSync(backupRoot) ? readdirSync(backupRoot).length : 0, 0, "a clean rollback removes temporary package snapshots");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a stale target changed during staging is preserved and the package update rolls back", () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-runtime-stale-race-"));
  const bin = join(home, "bin"); mkdirSync(bin);
  const source = join(home, "engine-source");
  const engine = join(bin, "engine.exe");
  const obsolete = join(bin, "m9r-engine.exe.m9r-retired-previous");
  writeFileSync(source, "new-engine");
  writeFileSync(engine, "old-engine");
  writeFileSync(obsolete, "M9R-owned-old-image");
  try {
    assert.throws(() => installRuntimeTransaction(bin, [{ from: source, to: engine }], (from, to) => {
      copyFileSync(from, to);
      writeFileSync(obsolete, "user-modified-after-plan");
      return [];
    }, [obsolete]), /target changed during update/);
    assert.equal(readFileSync(engine, "utf8"), "old-engine", "earlier file replacements roll back");
    assert.equal(readFileSync(obsolete, "utf8"), "user-modified-after-plan", "a changed stale file is never deleted");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("invalid or missing sources cannot partially update a runtime", () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-runtime-preflight-"));
  const bin = join(home, "bin"); mkdirSync(bin);
  const from = join(home, "source"); const to = join(bin, "engine");
  writeFileSync(from, "new"); writeFileSync(to, "old");
  try {
    assert.throws(() => installRuntimeTransaction(bin, [{ from, to }, { from: join(home, "missing"), to: join(bin, "broker") }], () => { throw new Error("must not replace"); }));
    assert.equal(readFileSync(to, "utf8"), "old");
    assert.throws(() => installRuntimeTransaction(bin, [{ from, to: join(home, "outside") }], () => []), /outside/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
