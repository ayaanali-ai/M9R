import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWindowsDesktopStageManager } from "../src/lib/native/windows-desktop-stage";

const stageDesktop = "3ecb4a09-87d4-4f8b-9fd1-48bc9d8c14ae";
const ownerDesktop = "c0999999-87d4-4f8b-9fd1-48bc9d8c14ae";
const anchor = { pid: 4_321, windowId: "9223372036854775807", desktopId: stageDesktop, onCurrentDesktop: false };

function withRoot(run: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "m9r-windows-stage-"));
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("registers a machine-local stage from an exact window and persists its GUID", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {}, now: () => new Date("2026-10-04T12:00:00Z"),
    invokeNative: async (request) => ({ ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } }),
  });
  const registered = await manager.register("My Stage", "4321", anchor.windowId);
  assert.equal(registered.name, "my-stage");
  assert.equal(registered.desktopId, stageDesktop);
  assert.deepEqual(registered.anchor, { pid: 4_321, windowId: anchor.windowId });
  assert.deepEqual(manager.list(), [registered]);
  assert.match(readFileSync(join(root, "windows-stages.json"), "utf8"), /"version": 1/);
}));

test("re-registering a known desktop refreshes its anchor without changing its identity", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {}, now: () => new Date("2026-10-04T12:00:00Z"),
    invokeNative: async (request) => ({ ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } }),
  });
  const original = await manager.register("stage", "4321", "123");
  const refreshed = await manager.register("stage", "9876", "456");
  assert.equal(refreshed.desktopId, original.desktopId);
  assert.equal(refreshed.registeredAt, original.registeredAt);
  assert.deepEqual(refreshed.anchor, { pid: 9_876, windowId: "456" });
}));

test("moves only the exact PID/window pair to the registered desktop and verifies the destination", async () => withRoot(async (root) => {
  const requests: Record<string, unknown>[] = [];
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => {
      requests.push(request);
      if (request.op === "move") return { ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } };
      const desktopId = Number(request.pid) === anchor.pid ? stageDesktop : ownerDesktop;
      return { ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId), desktopId, onCurrentDesktop: true } };
    },
  });
  await manager.register("stage", "4321", anchor.windowId);
  const result = await manager.moveWindow("stage", "7777", "0x1fff");
  assert.equal(result.fromDesktopId, ownerDesktop);
  assert.equal(result.window.desktopId, stageDesktop);
  assert.deepEqual(requests.at(-1), { op: "move", pid: 7_777, windowId: "0x1fff", desktopId: stageDesktop });
}));

test("requires an interactive owner terminal and rejects agent initiated stage changes", async () => withRoot(async (root) => {
  const noTerminal = createWindowsDesktopStageManager({ platform: "win32", root, terminal: false, env: {} });
  await assert.rejects(() => noTerminal.register("stage", "1", "2"), /owner at an interactive terminal/);
  const agent = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: { CODEX_THREAD_ID: "thread" } });
  await assert.rejects(() => agent.register("stage", "1", "2"), /Agents cannot register stages/);
  await assert.rejects(() => agent.moveWindow("stage", "1", "2"), /Agents cannot register stages/);
}));

test("refuses stale anchors, desktop id drift, and failed post-move verification", async () => withRoot(async (root) => {
  let anchorDesktop = stageDesktop;
  let targetDesktop = ownerDesktop;
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => {
      if (request.op === "move") return { ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId), desktopId: targetDesktop } };
      const desktopId = Number(request.pid) === anchor.pid ? anchorDesktop : targetDesktop;
      return { ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId), desktopId } };
    },
  });
  await manager.register("stage", "4321", anchor.windowId);
  anchorDesktop = ownerDesktop;
  await assert.rejects(() => manager.inspectStage("stage"), /anchor moved to another desktop/);
  await assert.rejects(() => manager.moveWindow("stage", "7777", "999"), /did not confirm/);
  assert.equal(manager.list()[0]?.desktopId, stageDesktop, "failed live checks must not silently rewrite the saved stage");
}));

test("fails closed on a corrupt registry and forgetting removes only the local mapping", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => ({ ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } }),
  });
  await manager.register("stage", "4321", anchor.windowId);
  const path = join(root, "windows-stages.json");
  const saved = readFileSync(path, "utf8");
  writeFileSync(path, "{broken", "utf8");
  assert.throws(() => manager.list(), /registry is corrupt/);
  writeFileSync(path, saved, "utf8");
  const forgotten = manager.forget("stage");
  assert.equal(forgotten.desktopId, stageDesktop);
  assert.deepEqual(manager.list(), []);
}));

test("rejects malformed process ids, handles, and stage names before native calls", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async () => { throw new Error("native helper should not be called"); },
  });
  await assert.rejects(() => manager.register("../desktop", "10", "0x10"), /Stage names/);
  await assert.rejects(() => manager.register("stage", "0", "0x10"), /PID must be a positive/);
  await assert.rejects(() => manager.register("stage", "10", "0x00"), /Window id must be a non-zero/);
}));
