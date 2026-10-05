import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCuaStageDriver, type CuaStageDriverDependencies } from "../src/lib/native/cua-stage-driver";
import { createWindowsDesktopStageManager } from "../src/lib/native/windows-desktop-stage";

const desktopId = "3ecb4a09-87d4-4f8b-9fd1-48bc9d8c14ae";
const windowId = "9223372036854775807";
const imageData = Buffer.from("stage-window-image").toString("base64");

function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "m9r-cua-stage-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function stageDependencies(root: string): NonNullable<CuaStageDriverDependencies["stage"]> {
  return {
    platform: "win32",
    root,
    terminal: true,
    env: {},
    invokeNative: async (request) => ({
      ok: true,
      window: {
        pid: Number(request.pid),
        windowId: String(request.windowId),
        desktopId,
        onCurrentDesktop: true,
      },
    }),
  };
}

async function registerStage(root: string): Promise<void> {
  const manager = createWindowsDesktopStageManager(stageDependencies(root));
  await manager.register("stage", "4321", windowId);
}

function makeSdk(options: {
  state?: Record<string, unknown>;
  cursorState?: { enabled: boolean; position: { x: number; y: number } };
  calls: Array<{ method: string; value?: unknown }>;
}) {
  const driver = {
    async startSession(input: unknown) { options.calls.push({ method: "startSession", value: input }); },
    async getWindowState(input: unknown) {
      options.calls.push({ method: "getWindowState", value: input });
      return options.state ?? {
        pid: 4321,
        windowId: BigInt(windowId),
        screenshotFrameValid: true,
        screenshotWidth: 200,
        screenshotHeight: 100,
        images: [{ mimeType: "image/png", dataBase64: imageData }],
      };
    },
    async setAgentCursorEnabled(input: unknown) { options.calls.push({ method: "setAgentCursorEnabled", value: input }); return { isError: false }; },
    async moveCursor(input: unknown) { options.calls.push({ method: "moveCursor", value: input }); return { isError: false }; },
    async getAgentCursorState() {
      options.calls.push({ method: "getAgentCursorState" });
      return { isError: false, structuredJson: JSON.stringify(options.cursorState ?? { enabled: true, position: { x: 42, y: 24 } }) };
    },
    async endSession(input: unknown) { options.calls.push({ method: "endSession", value: input }); },
    async shutdown() { options.calls.push({ method: "shutdown" }); },
  };
  class WindowTarget {
    readonly input: { pid: number; windowId: bigint };
    constructor(input: { pid: number; windowId: bigint }) {
      this.input = input;
      options.calls.push({ method: "windowTarget", value: input });
    }
  }
  return {
    CuaDriver: { create() { options.calls.push({ method: "create" }); return driver; } },
    ActionTarget: { Window: WindowTarget },
  };
}

test("captures only the registered window and reliably closes the Cua session", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls }) as never,
    now: () => new Date("2026-10-05T12:00:00.000Z"),
  });

  const capture = await driver.capture("stage");
  assert.equal(capture.dataUrl, `data:image/png;base64,${imageData}`);
  assert.equal(capture.width, 200);
  assert.equal(capture.height, 100);
  assert.equal(capture.capturedAt, "2026-10-05T12:00:00.000Z");
  const request = calls.find((call) => call.method === "getWindowState")?.value as Record<string, unknown>;
  assert.equal(request.pid, 4321);
  assert.equal(request.windowId, BigInt(windowId));
  assert.equal(request.includeAccessibilityTree, false);
  assert.equal(request.includeScreenshot, true);
  assert.deepEqual(calls.map((call) => call.method).filter((method) => ["startSession", "endSession", "shutdown"].includes(method)), ["startSession", "endSession", "shutdown"]);
}));

test("moves and verifies Cua's window-scoped ghost cursor using captured screenshot pixels", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls }) as never,
    now: () => new Date("2026-10-05T12:00:00.000Z"),
  });

  const result = await driver.moveCursor("stage", 42, 24);
  assert.deepEqual(result.cursor, { x: 42, y: 24, enabled: true });
  const target = calls.find((call) => call.method === "windowTarget")?.value as { pid: number; windowId: bigint };
  assert.equal(target.pid, 4321);
  assert.equal(target.windowId, BigInt(windowId));
  const move = calls.find((call) => call.method === "moveCursor")?.value as { x: number; y: number; target: unknown };
  assert.equal(move.x, 42);
  assert.equal(move.y, 24);
  assert.ok(move.target);
  assert.deepEqual(calls.map((call) => call.method).filter((method) => ["startSession", "endSession", "shutdown"].includes(method)), ["startSession", "endSession", "shutdown"]);
}));

test("refuses out-of-bounds cursor input before enabling or moving the ghost cursor", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls }) as never,
  });

  await assert.rejects(() => driver.moveCursor("stage", 200, 24), /inside the current stage window snapshot/);
  assert.equal(calls.some((call) => call.method === "setAgentCursorEnabled" || call.method === "moveCursor"), false);
  assert.ok(calls.some((call) => call.method === "shutdown"));
}));

test("rejects stale or unverified Cua snapshots and still shuts down", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls, state: {
      pid: 9999,
      windowId: BigInt(windowId),
      screenshotFrameValid: true,
      screenshotWidth: 200,
      screenshotHeight: 100,
      images: [{ mimeType: "image/png", dataBase64: imageData }],
    } }) as never,
  });

  await assert.rejects(() => driver.capture("stage"), /different window/);
  assert.ok(calls.some((call) => call.method === "endSession"));
  assert.ok(calls.some((call) => call.method === "shutdown"));
}));
