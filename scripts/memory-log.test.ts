import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createMemoryLog } from "../src/lib/native/memory-log";

test("memory log is local, scoped, deletable, and survives a reload", async () => {
  const parent = resolve(process.cwd(), ".test-tmp", "memory-log");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "case-"));
  try {
    const log = createMemoryLog(root, () => new Date("2026-11-20T12:00:00.000Z"));
    const a = log.add("prefers terse commit messages");
    const b = log.add("deep in the pill redesign this week", "persona:ry", "codex");
    assert.ok(a && b);
    assert.equal(b!.author, "codex");
    assert.equal(a!.author, undefined);
    assert.deepEqual(log.list().map((e) => e.text), [b!.text, a!.text]);
    assert.deepEqual(log.list("persona:ry").map((e) => e.text), [b!.text]);

    // Persists asynchronously so a capture call never waits on disk.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const raw = readFileSync(join(root, "memory-log.jsonl"), "utf8");
    assert.match(raw, /prefers terse commit messages/);
    assert.match(raw, /persona:ry/);
    assert.match(raw, /"author":"codex"/);

    assert.equal(log.remove(a!.id), true);
    assert.equal(log.remove(a!.id), false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const raw2 = readFileSync(join(root, "memory-log.jsonl"), "utf8");
    assert.doesNotMatch(raw2, /prefers terse commit messages/);

    const reloaded = createMemoryLog(root);
    assert.deepEqual(reloaded.list().map((e) => e.text), [b!.text]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory log rejects empty text and invalid scope, and bounds total entries", () => {
  const parent = resolve(process.cwd(), ".test-tmp", "memory-log");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "case-"));
  try {
    const log = createMemoryLog(root);
    assert.equal(log.add("   "), undefined);
    assert.equal(log.add("real note", "not-a-scope" as never), undefined);
    for (let i = 0; i < 305; i++) log.add(`note ${i}`);
    assert.equal(log.list().length, 300);
    assert.equal(log.list()[0]!.text, "note 304");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
