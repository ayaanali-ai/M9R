import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DESKTOP_PILL_MAX_AGE_MS, desktopPillHeartbeatPath, desktopPillRunning, readDesktopPillRunning } from "@/lib/native/desktop-pill-presence";
import { createWebUiBridge, type UiState } from "@/lib/native/web-ui-bridge";

const beat = (at: number, visible = true) => JSON.stringify({ pid: 1, at, visible });

test("only a fresh, visible heartbeat counts as the desktop pill running", () => {
  const now = 1_000_000;
  assert.equal(desktopPillRunning(beat(now - 1_000), now), true);
  assert.equal(desktopPillRunning(beat(now - DESKTOP_PILL_MAX_AGE_MS), now), true);
  assert.equal(desktopPillRunning(beat(now - DESKTOP_PILL_MAX_AGE_MS - 1), now), false, "three missed beats: it is gone");
  assert.equal(desktopPillRunning(beat(now - 1_000, false), now), false, "hidden (full-screen app, or hidden on purpose)");
  assert.equal(desktopPillRunning(beat(now + 60_000), now), false, "a timestamp from the future is not trusted");
  for (const bad of ["", "not json", "{}", '{"at":"x","visible":true}', '{"at":1e999,"visible":true}', "null", "[]"]) assert.equal(desktopPillRunning(bad, now), false, bad);
  assert.equal(desktopPillRunning(null, now), false);
});

test("the broker reads the heartbeat file, and a missing file means not running", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-presence-"));
  try {
    assert.equal(readDesktopPillRunning(root), false);
    writeFileSync(desktopPillHeartbeatPath(root), beat(Date.now()));
    assert.equal(readDesktopPillRunning(root), true);
    writeFileSync(desktopPillHeartbeatPath(root), beat(Date.now() - 60_000));
    assert.equal(readDesktopPillRunning(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the ui-state carries desktopPill only while it is true, and a change is pushed to the subscriber once", async () => {
  const pushed: UiState[] = [];
  const ui = createWebUiBridge({ debounceMs: 5 });
  ui.handleExtensionMessage({ type: "ui-subscribe" }, (state) => { pushed.push(state); return true; });
  const initial = pushed.length;
  assert.equal("desktopPill" in ui.snapshot(), false, "absent by default, so older consumers see the same shape");
  ui.setDesktopPill(true);
  ui.setDesktopPill(true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ui.snapshot().desktopPill, true);
  assert.equal(pushed.length, initial + 1, "an unchanged value does not push again");
  assert.equal(pushed.at(-1)?.desktopPill, true);
  ui.setDesktopPill(false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal("desktopPill" in ui.snapshot(), false);
  assert.equal(pushed.length, initial + 2);
  ui.close();
});
