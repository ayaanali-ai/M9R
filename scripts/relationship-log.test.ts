import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createRelationshipLog } from "../src/lib/native/relationship-log";

function tempRoot() {
  const parent = resolve(process.cwd(), ".test-tmp", "relationship-log");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "case-"));
}

test("relationship log is pair-keyed regardless of argument order, and summarizes counts plus recent notes", async () => {
  const root = tempRoot();
  try {
    const log = createRelationshipLog(root, () => new Date("2026-11-21T12:00:00.000Z"));
    log.relate("codex", "claude-code", "handoff", "Picked up the pill redesign cleanly.");
    log.relate("claude-code", "codex", "correction", "Had to fix a missing scope check.");
    log.relate("codex", "claude-code", "praise", "Nice catch on the race condition.");

    const summary = log.summary("claude-code", "codex");
    assert.equal(summary.pair, "claude-code|codex");
    assert.deepEqual(summary.counts, { handoff: 1, correction: 1, praise: 1, friction: 0 });
    assert.equal(summary.recentNotes.length, 3);
    assert.equal(summary.recentNotes[0]!.kind, "praise");

    await new Promise((resolve) => setTimeout(resolve, 0));
    const raw = readFileSync(join(root, "relationship-log.jsonl"), "utf8");
    assert.match(raw, /"pair":"claude-code\|codex"/);

    const reloaded = createRelationshipLog(root);
    assert.deepEqual(reloaded.summary("codex", "claude-code").counts, summary.counts);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relationship log rejects self-pairs, empty notes, invalid kinds, and bounds total entries", () => {
  const root = tempRoot();
  try {
    const log = createRelationshipLog(root);
    assert.equal(log.relate("codex", "codex", "handoff", "n/a"), undefined);
    assert.equal(log.relate("codex", "claude-code", "handoff", "   "), undefined);
    assert.equal(log.relate("codex", "claude-code", "nonsense" as never, "note"), undefined);

    const empty = log.summary("a", "b");
    assert.deepEqual(empty.counts, { handoff: 0, correction: 0, praise: 0, friction: 0 });
    assert.deepEqual(empty.recentNotes, []);

    for (let i = 0; i < 505; i++) log.relate("codex", "claude-code", "handoff", `note ${i}`);
    const summary = log.summary("codex", "claude-code");
    assert.equal(summary.counts.handoff, 500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
