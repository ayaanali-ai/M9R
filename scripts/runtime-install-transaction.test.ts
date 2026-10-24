import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasPendingRuntimeTransaction, installRuntimeTransaction, pruneCompletedRuntimeTransactions, recoverRuntimeTransactions } from "@/lib/native/runtime-install-transaction";
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
    let failure: unknown;
    try {
      installRuntimeTransaction(bin, files, (from, to) => {
        copyFileSync(from, to); if (++calls === 3) throw new Error("simulated third-component failure"); return [];
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /previous runtime was restored/);
    assert.match(failure.message, /simulated third-component failure/);
    assert.equal(readFileSync(files[0]!.to, "utf8"), "old-engine");
    assert.equal(readFileSync(files[1]!.to, "utf8"), "old-broker");
    assert.equal(existsSync(files[2]!.to), false);
    assert.deepEqual(readdirSync(join(home, "runtime-backups")), [], "a verified rollback leaves no stale prior-runtime snapshot");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a successful runtime update removes its temporary prior-generation snapshot", () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-runtime-commit-cleanup-"));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const from = join(home, "source-engine");
  const to = join(bin, "m9r-engine");
  writeFileSync(from, "new runtime");
  writeFileSync(to, "old runtime");
  const backupRoot = join(home, "runtime-backups");
  try {
    installRuntimeTransaction(bin, [{ from, to }], (source, target) => {
      copyFileSync(source, target);
      return [];
    });

    assert.equal(readFileSync(to, "utf8"), "new runtime");
    assert.deepEqual(readdirSync(backupRoot), [], "no committed old runtime generation remains on disk");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("completed cleanup verifies nested Windows manifest paths", () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-runtime-nested-cleanup-"));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const from = join(home, "source-engine");
  const to = join(bin, "components", "m9r-engine");
  writeFileSync(from, "new nested runtime");
  mkdirSync(join(bin, "components"), { recursive: true });
  writeFileSync(to, "old nested runtime");
  const backupRoot = join(home, "runtime-backups");
  try {
    installRuntimeTransaction(bin, [{ from, to }], (source, target) => {
      copyFileSync(source, target);
      return [];
    });

    assert.equal(readFileSync(to, "utf8"), "new nested runtime");
    assert.deepEqual(readdirSync(backupRoot), [], "nested committed generations must be pruned after verification");
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

test("retention prunes only old committed snapshots and preserves recovery evidence", () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-runtime-retention-"));
  const bin = join(home, "bin");
  const backupRoot = join(home, "runtime-backups");
  mkdirSync(bin, { recursive: true });
  mkdirSync(backupRoot, { recursive: true });
  const makeJournal = (status: string, targetDir = bin, ageMinutes = 0) => {
    const transaction = join(backupRoot, randomUUID());
    mkdirSync(transaction, { recursive: true });
    writeFileSync(join(transaction, "transaction.json"), JSON.stringify({ status, targetDir, files: [] }));
    const time = new Date(Date.now() - ageMinutes * 60_000);
    utimesSync(transaction, time, time);
    utimesSync(join(transaction, "transaction.json"), time, time);
    return transaction;
  };
  try {
    const old1 = makeJournal("committed", bin, 500);
    const old2 = makeJournal("committed", bin, 400);
    const keep1 = makeJournal("committed", bin, 300);
    const keep2 = makeJournal("committed", bin, 200);
    const keep3 = makeJournal("committed", bin, 100);
    const applying = makeJournal("applying", bin, 600);
    const failed = makeJournal("rollback_failed", bin, 700);
    const foreign = makeJournal("committed", join(home, "other-bin"), 800);
    const malformed = join(backupRoot, randomUUID());
    mkdirSync(malformed, { recursive: true });
    writeFileSync(join(malformed, "transaction.json"), "not json");
    const unsafeManifest = makeJournal("committed", bin, 900);
    writeFileSync(join(unsafeManifest, "transaction.json"), JSON.stringify({
      status: "committed",
      targetDir: bin,
      files: [{ path: "../outside", sha256: "a".repeat(64), existed: false, previousSha256: null }],
    }));
    const unexpectedContent = makeJournal("committed", bin, 1_000);
    writeFileSync(join(unexpectedContent, "owner-data.txt"), "preserve");

    const pruned = pruneCompletedRuntimeTransactions(bin, 3);

    assert.deepEqual(pruned.sort(), [old1, old2].sort());
    assert.equal(existsSync(old1), false);
    assert.equal(existsSync(old2), false);
    for (const retained of [keep1, keep2, keep3, applying, failed, foreign, malformed, unsafeManifest, unexpectedContent]) {
      assert.equal(existsSync(retained), true, retained);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("default cleanup removes verified rolled-back transactions but preserves failed recovery evidence", () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-runtime-rolled-back-cleanup-"));
  const bin = join(home, "bin");
  const backupRoot = join(home, "runtime-backups");
  mkdirSync(bin, { recursive: true });
  mkdirSync(backupRoot, { recursive: true });
  const makeJournal = (status: string) => {
    const transaction = join(backupRoot, randomUUID());
    mkdirSync(transaction, { recursive: true });
    writeFileSync(join(transaction, "transaction.json"), JSON.stringify({ status, targetDir: bin, files: [] }));
    return transaction;
  };
  try {
    const rolledBack = makeJournal("rolled_back");
    const rollbackFailed = makeJournal("rollback_failed");

    const removed = pruneCompletedRuntimeTransactions(bin);

    assert.deepEqual(removed, [rolledBack]);
    assert.equal(existsSync(rolledBack), false);
    assert.equal(existsSync(rollbackFailed), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("completed cleanup preserves snapshot data that is not in the transaction manifest", () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-runtime-unexpected-snapshot-data-"));
  const bin = join(home, "bin");
  const backupRoot = join(home, "runtime-backups");
  const transaction = join(backupRoot, randomUUID());
  const previous = join(transaction, "previous");
  mkdirSync(bin, { recursive: true });
  mkdirSync(previous, { recursive: true });
  const expectedPrevious = join(previous, "engine");
  const ownerData = join(previous, "owner-notes.txt");
  writeFileSync(expectedPrevious, "previous engine bytes");
  writeFileSync(ownerData, "preserve unrelated data");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  writeFileSync(join(transaction, "transaction.json"), JSON.stringify({
    status: "committed",
    targetDir: bin,
    files: [{
      path: "engine",
      sha256: hash("current engine bytes"),
      existed: true,
      previousSha256: hash("previous engine bytes"),
    }],
  }));

  try {
    assert.deepEqual(pruneCompletedRuntimeTransactions(bin), []);
    assert.equal(readFileSync(expectedPrevious, "utf8"), "previous engine bytes");
    assert.equal(readFileSync(ownerData, "utf8"), "preserve unrelated data");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
