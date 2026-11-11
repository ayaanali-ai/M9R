import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createObservationModalityLedger } from "../src/lib/native/observation-modality-ledger";
import { runObservationStats, type ApprovalIo } from "../src/lib/native/approval-commands";

async function withRoot(run: (root: string) => void | Promise<void>): Promise<void> {
  const parent = resolve(process.cwd(), ".test-tmp", "observation-modality-ledger");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "case-"));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function io(): ApprovalIo & { lines: string[]; errLines: string[] } {
  const lines: string[] = []; const errLines: string[] = [];
  return { out: (line: string) => { lines.push(line); }, err: (line: string) => { errLines.push(line); },
    confirm: () => Promise.resolve(true), env: {}, lines, errLines };
}

test("observation-modality counts survive a reload, the same way workflow preferences do", () => withRoot(async (root) => {
  const ledger = createObservationModalityLedger(root, () => new Date("2026-11-11T12:00:00.000Z"));
  ledger.record("tree-only");
  ledger.record("tree-only");
  ledger.record("tree-incomplete-fallback");
  ledger.record("explicit-visual");
  assert.deepEqual(ledger.snapshot(), { observations: 4, explicitVisual: 1, treeIncompleteFallback: 1, treeOnly: 2, updatedAt: "2026-11-11T12:00:00.000Z" });

  // The ledger persists asynchronously so recording an observation never waits on disk.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reloaded = createObservationModalityLedger(root);
  assert.deepEqual(reloaded.snapshot(), { observations: 4, explicitVisual: 1, treeIncompleteFallback: 1, treeOnly: 2, updatedAt: "2026-11-11T12:00:00.000Z" });

  const raw = readFileSync(join(root, "observation-modality-stats.json"), "utf8");
  assert.doesNotMatch(raw, /secret|password|prompt/i);
}));

test("m9r-cli observation-stats reports the real counts to the owner's terminal", () => withRoot(async (root) => {
  const ledger = createObservationModalityLedger(root, () => new Date("2026-11-11T12:00:00.000Z"));
  ledger.record("tree-only");
  ledger.record("tree-only");
  ledger.record("tree-only");
  ledger.record("tree-incomplete-fallback");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const term = io();
  assert.equal(runObservationStats(term, root), 0);
  assert.match(term.lines.join("\n"), /4 desktop observation\(s\) recorded/);
  assert.match(term.lines.join("\n"), /tree-only \(no screenshot needed\):\s+3 \(75\.0%\)/);
  assert.match(term.lines.join("\n"), /tree-incomplete screenshot fallback:\s+1 \(25\.0%\)/);
}));

test("m9r-cli observation-stats refuses an agent context, same as task-log", () => withRoot((root) => {
  const term: ApprovalIo & { lines: string[]; errLines: string[] } = { ...io(), confirm: undefined };
  assert.equal(runObservationStats(term, root), 1);
  assert.match(term.errLines.join("\n"), /available only to the owner at a terminal/);
}));

test("reading observation-stats before any observation happened reports zero, not an error", () => withRoot((root) => {
  const term = io();
  assert.equal(runObservationStats(term, root), 0);
  assert.match(term.lines.join("\n"), /No desktop observations recorded yet/);
}));
