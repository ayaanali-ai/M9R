import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseTaskStageAction } from "../src/lib/native/task-stage-actions";
import { approveStageApp, listApprovedStageApps, readApprovedStageApp } from "../src/lib/native/task-stage-apps";
import { readTaskStagePolicy, setTaskStagePermission } from "../src/lib/native/task-desktop-stage";

test("stage action boundary accepts bounded operations and rejects alternate targets and commands", () => {
  for (const action of [{ kind: "capture" }, { kind: "click", x: 0, y: 20 }, { kind: "cursor", x: 1, y: 2 },
    { kind: "type", text: "hello" }, { kind: "scroll", x: 1, y: 2, direction: "down" }, { kind: "drag", fromX: 1, fromY: 2, toX: 3, toY: 4 }]) {
    assert.deepEqual(parseTaskStageAction(action), action);
  }
  for (const action of [null, [], { kind: "activate" }, { kind: "capture", windowId: "123" }, { kind: "click", x: -1, y: 0 },
    { kind: "click", x: 16384, y: 0 }, { kind: "click", x: 1.5, y: 0 }, { kind: "type", text: "" }, { kind: "type", text: "\0" },
    { kind: "type", text: "x".repeat(501) }, { kind: "scroll", x: 1, y: 2, direction: "left" }, { kind: "drag", fromX: 1 }]) {
    assert.throws(() => parseTaskStageAction(action));
  }
});

test("preparation permission never implies computer control; owner revocation removes both", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-policy-"));
  try {
    setTaskStagePermission(root, "codex", true, { terminal: true, env: {} });
    assert.deepEqual(readTaskStagePolicy(root), { handles: ["codex"] });
    setTaskStagePermission(root, "codex", true, { terminal: true, env: {} }, true);
    assert.deepEqual(readTaskStagePolicy(root), { handles: ["codex"], controlHandles: ["codex"] });
    setTaskStagePermission(root, "codex", false, { terminal: true, env: {} });
    assert.deepEqual(readTaskStagePolicy(root), { handles: [] });
    assert.throws(() => setTaskStagePermission(root, "codex", true, { terminal: true, env: { CODEX_THREAD_ID: "agent" } }, true));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approved apps have fixed owner arguments, no model command line, and executable drift is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-app-"));
  try {
    const exe = join(root, "fixture.exe"); writeFileSync(exe, "fake exe for hashing only");
    assert.deepEqual(listApprovedStageApps(root), []);
    assert.throws(() => approveStageApp(root, "fixture", exe, [], { terminal: true, env: { OPENCODE: "1" } }), /Only the owner/);
    assert.throws(() => approveStageApp(root, "fixture", "relative.exe", [], { terminal: true, env: {} }));
    approveStageApp(root, "fixture", exe, ["fixed-owner-value"], { terminal: true, env: {} });
    assert.deepEqual(listApprovedStageApps(root), ["fixture"]);
    assert.deepEqual(readApprovedStageApp(root, "fixture").args, ["fixed-owner-value"]);
    assert.throws(() => readApprovedStageApp(root, "missing"), /not been approved/);
    writeFileSync(exe, "changed executable");
    assert.throws(() => readApprovedStageApp(root, "fixture"), /changed/);
    assert.equal(readFileSync(join(root, "task-stage-apps.json"), "utf8").includes("fixed-owner-value"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
