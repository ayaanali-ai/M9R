import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBrowserSpaceLedger } from "../src/lib/native/browser-space-ledger";

test("browser spaces persist the exact owner-profile window identity", () => {
  const parent = resolve(".test-tmp"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "m9r-space-"));
  try {
    const first = createBrowserSpaceLedger(root);
    const bound = first.bind({ spaceId: "space-codex", stageName: "preview-agent-a123456789abcdef01234567", browser: "chrome", pid: 42, windowId: "0x123" });
    assert.equal(bound.windowId, "0x123");
    assert.deepEqual(createBrowserSpaceLedger(root).get("space-codex"), bound);
    first.remove("space-codex");
    assert.equal(createBrowserSpaceLedger(root).get("space-codex"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("browser spaces reject malformed identities instead of guessing", () => {
  const parent = resolve(".test-tmp"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "m9r-space-invalid-"));
  try {
    const ledger = createBrowserSpaceLedger(root);
    assert.throws(() => ledger.bind({ spaceId: "../escape", stageName: "stage", browser: "chrome", pid: 42, windowId: "0x123" }), /space id/i);
    assert.throws(() => ledger.bind({ spaceId: "space", stageName: "stage", browser: "chrome", pid: 0, windowId: "0x123" }), /PID/i);
    assert.throws(() => ledger.bind({ spaceId: "space", stageName: "stage", browser: "chrome", pid: 42, windowId: "0" }), /window identity/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
