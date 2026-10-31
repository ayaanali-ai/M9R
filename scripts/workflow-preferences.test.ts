import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveUniversalIntent } from "../src/lib/native/universal-intent-resolver";
import { createWorkflowPreferenceLedger } from "../src/lib/native/workflow-preferences";

test("workflow learning is bounded, local, and survives a reload", async () => {
  const parent = resolve(process.cwd(), ".test-tmp", "workflow-preferences");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "case-"));
  try {
    const intent = resolveUniversalIntent("Fill the current form, but do not advance or submit.");
    const ledger = createWorkflowPreferenceLedger(root, () => new Date("2026-10-31T12:00:00.000Z"));
    ledger.recordIntent(intent);
    ledger.recordActionPattern("semantic-target");
    ledger.recordActionPattern("reobserve-after-mutation");
    ledger.recordProviderStrength("Codex", "desktop");
    assert.deepEqual(ledger.snapshot().map((record) => record.key), [
      "no-advance", "no-submit", "prefer-start-search", "prefer-structure",
    ]);

    // The ledger persists asynchronously so an intent tool never waits on disk.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const raw = readFileSync(join(root, "workflow-preferences.json"), "utf8");
    assert.doesNotMatch(raw, /Fill the current form|secret|password/i);
    assert.match(raw, /no-advance/);
    assert.match(raw, /prefer-structure/);
    assert.match(raw, /semantic-target/);
    assert.match(raw, /"provider":"codex"/);

    const reloaded = createWorkflowPreferenceLedger(root);
    assert.equal(reloaded.snapshot().find((record) => record.key === "no-submit")?.count, 1);
    assert.equal(reloaded.snapshot().find((record) => record.key === "prefer-start-search")?.count, 1);
    assert.equal(reloaded.actionPatterns().find((record) => record.pattern === "semantic-target")?.count, 1);
    assert.equal(reloaded.providerStrengths().find((record) => record.provider === "codex")?.capability, "desktop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

