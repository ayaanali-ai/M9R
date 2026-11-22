import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWindowsDesktopStageManager } from "../src/lib/native/windows-desktop-stage";
import { agentInputStreamId } from "../src/lib/native/agent-input-stream";
import { createMultiplayerDispatchFence } from "../src/lib/native/multiplayer-dispatch-fence";
import { createLocalStore } from "../src/lib/native/local-store";

test("manager routes two streams through separate persistent channels and retains the default channel", async () => {
  const opened: Array<string | undefined> = [];
  const closed: Array<string | undefined> = [];
  const entered = new Set<string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = createWindowsDesktopStageManager({ platform: "win32", terminal: true, env: {},
    nativeHostFactory: (streamId) => {
      opened.push(streamId);
      return { invoke: async () => { if (streamId) { entered.add(streamId); await gate; } return { ok: true, position: { x: 1, y: 2 } }; },
        close: () => { closed.push(streamId); } };
    } });
  const one = agentInputStreamId({ handle: "codex", sessionId: "one" });
  const two = agentInputStreamId({ handle: "claude", sessionId: "two" });
  try {
    assert.deepEqual(await manager.getOwnerCursorPosition(), { x: 1, y: 2 });
    const calls = [manager.withInputStream(one, () => manager.getOwnerCursorPosition()), manager.withInputStream(two, () => manager.getOwnerCursorPosition())];
    assert.equal(entered.size, 2, "both channel requests are in flight before either transport returns");
    release(); await Promise.all(calls);
    await manager.withInputStream(one, () => manager.getOwnerCursorPosition());
    assert.deepEqual(opened, [undefined, one, two], "task calls reuse the session channel rather than spawning a helper each time");
    manager.closeInputStream(one);
    assert.deepEqual(closed, [one]);
    await manager.withInputStream(two, () => manager.getOwnerCursorPosition());
  } finally { release(); manager.close(); }
  assert.deepEqual(new Set(closed), new Set([undefined, one, two]));
  assert.throws(() => manager.withInputStream(one, () => manager.getOwnerCursorPosition()), /closed/);
});

test("target-window mouse messages use independent agent input-stream helpers concurrently", async () => {
  const opened: Array<string | undefined> = [];
  const dispatched: Array<{ streamId: string | undefined; op: string }> = [];
  const entered = new Set<string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = createWindowsDesktopStageManager({ platform: "win32", terminal: true, env: {},
    nativeHostFactory: (streamId) => {
      opened.push(streamId);
      return { invoke: async (request) => {
        dispatched.push({ streamId, op: String(request.op) });
        if (streamId) { entered.add(streamId); await gate; }
        return { ok: true, dispatchState: "dispatched", route: "PostMessageW", target: "exact-window" };
      }, close: () => undefined };
    } });
  const one = agentInputStreamId({ handle: "codex", sessionId: "mouse-one" });
  const two = agentInputStreamId({ handle: "claude", sessionId: "mouse-two" });
  try {
    const calls = [
      manager.withInputStream(one, () => manager.postClickToWindow(123, "456", 20, 30)),
      manager.withInputStream(two, () => manager.postScrollToWindow(123, "456", 40, 50, -1)),
    ];
    assert.deepEqual(entered, new Set([one, two]), "both agent-owned native helpers have active requests before either finishes");
    release();
    assert.deepEqual(await Promise.all(calls), [
      { route: "PostMessageW", target: "exact-window", dispatched: true },
      { route: "PostMessageW", target: "exact-window", dispatched: true },
    ]);
    assert.deepEqual(opened, [undefined, one, two], "owner metadata uses the default helper while each agent action uses its own persistent helper");
    assert.deepEqual(dispatched, [
      { streamId: one, op: "postClickToWindow" },
      { streamId: two, op: "postScrollToWindow" },
    ]);
  } finally { release(); manager.close(); }
});

test("shared HWND binding requires the owner broker's mutation fence", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-shared-window-"));
  const native = async () => ({ ok: true, window: { pid: 123, windowId: "456" } });
  const exclusive = createWindowsDesktopStageManager({ root, platform: "win32", terminal: true, env: {}, invokeNative: native });
  const store = createLocalStore(root);
  const fence = createMultiplayerDispatchFence({ store });
  const shared = createWindowsDesktopStageManager({ root, platform: "win32", terminal: true, env: {}, invokeNative: native, sharedWindowFence: fence });
  try {
    await exclusive.register("agent-one", "123", "456");
    await assert.rejects(exclusive.register("agent-two", "123", "456"), /already claimed/);
    await shared.ensureStage("agent-two");
    shared.assignAgent("agent-two", { handle: "claude", sessionTag: "abcdef12", taskId: "T2" });
    await assert.rejects(shared.attachSharedWindow("agent-two", "123", "456"), /unfenced stage/);
    await shared.register("agent-one", "123", "456");
    await shared.attachSharedWindow("agent-two", "123", "456");
    assert.equal(shared.list().filter((stage) => stage.anchor?.windowId === "456").length, 2);
  } finally { exclusive.close(); shared.close(); rmSync(root, { recursive: true, force: true }); }
});
