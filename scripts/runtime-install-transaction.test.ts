import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
