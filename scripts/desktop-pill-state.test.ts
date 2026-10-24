import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { clearDesktopPillState, readDesktopPillState, writeDesktopPillState } from "@/lib/native/desktop-pill-state";

const tempRoot = join(process.cwd(), ".test-tmp");
mkdirSync(tempRoot, { recursive: true });

test("desktop pill state is broker-owned, atomic, and cleared on shutdown", () => {
  const root = mkdtempSync(join(tempRoot, "m9r-desktop-pill-state-"));
  try {
    const state = {
      type: "ui-state" as const,
      agents: [{ id: "claude", provider: "claude", folder: "C:/demo", state: "idle" as const, doing: "" }],
      thread: [],
      approvals: [],
    };
    writeDesktopPillState(root, state);
    assert.deepEqual(readDesktopPillState(root), state);
    clearDesktopPillState(root);
    assert.equal(readDesktopPillState(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
