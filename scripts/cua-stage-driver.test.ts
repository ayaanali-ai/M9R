import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCuaStageDriver as createCuaStageDriverCore, type CuaStageDriverDependencies } from "../src/lib/native/cua-stage-driver";
import { createWindowsDesktopStageManager } from "../src/lib/native/windows-desktop-stage";

const desktopId = "3ecb4a09-87d4-4f8b-9fd1-48bc9d8c14ae";
const windowId = "9223372036854775807";
const imageData = Buffer.from("stage-window-image").toString("base64");

function createCuaStageDriver(deps: CuaStageDriverDependencies = {}) {
  return createCuaStageDriverCore({
    ...deps,
    connectRuntime: deps.connectRuntime ?? (async (sdk) => {
      const driver = sdk.CuaDriver.create(undefined);
      return { driver, close: async () => driver.shutdown() };
    }),
  });
}

test("Windows optional frame-valid flag accepts matching PNG metadata and rejects invalid frames", async () => withRoot(async (root) => {
  await registerStage(root);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=";
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotWidth: 1, screenshotHeight: 1,
    images: [{ mimeType: "image/png", dataBase64: png }] };
  const driver = (extra: Record<string, unknown>) => createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ state: { ...state, ...extra }, calls: [] }) as never });
  assert.equal((await driver({}).capture("stage")).width, 1);
  await assert.rejects(driver({ screenshotFrameValid: false }).capture("stage"), /valid stage window snapshot/);
  await assert.rejects(driver({ screenshotWidth: 2 }).capture("stage"), /matching PNG dimensions/);
  await assert.rejects(driver({ images: [{ mimeType: "image/png", dataBase64: imageData }] }).capture("stage"), /matching PNG dimensions/);
}));

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
    invokeNative: async (request) => request.op === "input" ? { ok: false, error: "unsupported native-control window" } : ({
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
  actionResult?: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  windows?: Array<Record<string, unknown>>;
  cursorVisible?: boolean;
  calls: Array<{ method: string; value?: unknown }>;
}) {
  const actionResult = options.actionResult ?? { effect: 0, route: 1, summary: "action confirmed" };
  const toolResult = options.toolResult ?? { text: "", images: [], isError: false, degraded: false, rawJson: "", action: actionResult };
  const driver = {
    async startSession(input: unknown) { options.calls.push({ method: "startSession", value: input }); },
    async setAgentCursorMotion(input: unknown) { options.calls.push({ method: "setAgentCursorMotion", value: input }); return { isError: false }; },
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
    async getSession(input: unknown) { options.calls.push({ method: "getSession", value: input }); return { cursorVisible: options.cursorVisible ?? true }; },
    async listWindows(input: unknown) {
      options.calls.push({ method: "listWindows", value: input });
      return { windows: options.windows ?? [] };
    },
    async click(input: unknown) { options.calls.push({ method: "click", value: input }); return actionResult; },
    async typeText(input: unknown) { options.calls.push({ method: "typeText", value: input }); return toolResult; },
    async scroll(input: unknown) { options.calls.push({ method: "scroll", value: input }); return toolResult; },
    async drag(input: unknown) { options.calls.push({ method: "drag", value: input }); return toolResult; },
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
  class CoordinatePosition {
    readonly inner: { x: number; y: number };
    constructor(input: { x: number; y: number }) { this.inner = input; }
  }
  class ElementPosition {
    readonly inner: { elementToken: string };
    constructor(input: { elementToken: string }) { this.inner = input; }
  }
  return {
    CuaDriver: { create() { options.calls.push({ method: "create" }); return driver; } },
    ActionTarget: { Window: WindowTarget },
    ClickPosition: { Coordinates: CoordinatePosition, Element: ElementPosition },
    InputDeliveryMode: { Background: 0 },
    ScrollDirection: { Up: 0, Down: 1 },
    ScrollBy: { Line: 0 },
    CursorReducedMotion: { Auto: 0 },
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
  assert.deepEqual(result.cursor, { x: 42, y: 24, enabled: true, visible: true });
  const target = calls.find((call) => call.method === "windowTarget")?.value as { pid: number; windowId: bigint };
  assert.equal(target.pid, 4321);
  assert.equal(target.windowId, BigInt(windowId));
  const move = calls.find((call) => call.method === "moveCursor")?.value as { x: number; y: number; target: unknown };
  assert.equal(move.x, 42);
  assert.equal(move.y, 24);
  assert.ok(move.target);
  assert.deepEqual(calls.map((call) => call.method).filter((method) => ["startSession", "endSession", "shutdown"].includes(method)), ["startSession", "endSession", "shutdown"]);
}));

test("shows a distinct agent label on each native cursor and uses distance-based glide motion", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls }) as never });
  const identities = [
    { handle: "codex", sessionId: "codex-session-a" },
    { handle: "claude-code", sessionId: "claude-session-b" },
  ] as const;

  for (const identity of identities) await driver.moveCursor("stage", 42, 24, identity);

  const sessions = calls.filter((call) => call.method === "startSession").map((call) => (call.value as { session: string }).session);
  assert.equal(new Set(sessions).size, 2, "each verified agent session gets a separate Cua overlay identity");
  assert.match(sessions[0]!, /^@codex-[0-9a-f]{8}$/);
  assert.match(sessions[1]!, /^@claude-code-[0-9a-f]{8}$/);
  assert.ok(sessions.every((session) => session.length <= 28), "the complete identity and suffix fit Cua's visible badge limit");
  const motion = calls.filter((call) => call.method === "setAgentCursorMotion").map((call) => call.value as Record<string, unknown>);
  assert.deepEqual(motion.map(({ session, glideDurationMs, arcSize, spring }) => ({ session, glideDurationMs, arcSize, spring })), sessions.map((session) => ({
    session, glideDurationMs: 0, arcSize: 0.25, spring: 0.72,
  })));
  assert.equal(calls.filter((call) => call.method === "moveCursor").length, 2);
  for (const identity of identities) await driver.closeAgentCursor(identity);
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

test("does not report an agent cursor move as successful when the OS overlay is absent", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, cursorVisible: false }) as never });
  await assert.rejects(() => driver.moveCursor("stage", 42, 24, { handle: "codex", sessionId: "overlay-missing" }), /desktop overlay is visible/);
  await driver.shutdown();
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

test("lists only eligible visible app windows and keeps the result local and bounded", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const windows = [
    { pid: 4321, windowId: BigInt(101), appName: "notepad.exe", title: "C5 fixture", bounds: { x: 10, y: 20, width: 800, height: 600 }, isOnScreen: true, minimized: false },
    { pid: 4321, windowId: BigInt(102), appName: "hidden.exe", title: "Hidden", bounds: { x: 0, y: 0, width: 800, height: 600 }, isOnScreen: false, minimized: false },
    { pid: 4321, windowId: BigInt(103), appName: "tiny.exe", title: "Tiny", bounds: { x: 0, y: 0, width: 10, height: 20 }, isOnScreen: true, minimized: false },
    { pid: process.pid, windowId: BigInt(104), appName: "m9r.exe", title: "Agent child", bounds: { x: 0, y: 0, width: 800, height: 600 }, isOnScreen: true, minimized: false },
    { pid: 4321, windowId: BigInt(105), appName: "m9r-overlay.exe", title: "M9R", bounds: { x: 0, y: 0, width: 800, height: 600 }, isOnScreen: true, minimized: false },
    { pid: 4321, windowId: BigInt(107), appName: "pill-shell.exe", title: "M9R", bounds: { x: 0, y: 0, width: 800, height: 600 }, isOnScreen: true, minimized: false },
    { pid: 7777, windowId: BigInt(106), appName: "browser.exe", title: "A\nprivate title", bounds: { x: 0, y: 0, width: 900, height: 700 }, isOnScreen: true, minimized: false },
  ];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, windows }) as never });
  const options = await driver.listWindows("stage");
  assert.deepEqual(options, [
    { pid: 4321, windowId: "101", appName: "notepad.exe", title: "C5 fixture", width: 800, height: 600 },
    { pid: 7777, windowId: "106", appName: "browser.exe", title: "A private title", width: 900, height: 700 },
  ]);
  assert.deepEqual(calls.find((call) => call.method === "listWindows")?.value, { onScreenOnly: true });
  assert.deepEqual(calls.map((call) => call.method).filter((method) => ["startSession", "endSession", "shutdown"].includes(method)), ["startSession", "endSession", "shutdown"]);
}));

test("targets click at exact window-local coordinates with background-only delivery", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls }) as never });
  const proof = await driver.click("stage", 42, 24);
  assert.equal(proof.outcome.status, "confirmed");
  assert.equal(proof.capture.width, 200);
  const click = calls.find((call) => call.method === "click")?.value as { target: { input: unknown }; position: { inner: unknown }; deliveryMode: number; session: string };
  assert.deepEqual(click.target.input, { pid: 4321, windowId: BigInt(windowId) });
  assert.deepEqual(click.position.inner, { x: 42, y: 24 });
  assert.equal(click.deliveryMode, 0);
  assert.equal(calls.filter((call) => call.method === "getWindowState").length, 3, "the input uses a fresh accessibility hit-test and is followed by a fresh window snapshot");
}));

test("click resolves the smallest enabled control in the exact-window snapshot", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true,
    screenshotWidth: 200, screenshotHeight: 100, windowBounds: { x: 0, y: 0, width: 200, height: 100 }, images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: [
      { elementToken: "root", frame: { x: 0, y: 0, w: 200, h: 100 } },
      { elementToken: "disabled", enabled: false, frame: { x: 40, y: 20, w: 5, h: 5 } },
      { elementToken: "button", frame: { x: 20, y: 10, w: 70, h: 30 } },
    ] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state }) as never });
  await driver.click("stage", 42, 24);
  const click = calls.find((call) => call.method === "click")?.value as { position: { inner: unknown }; deliveryMode: number };
  assert.deepEqual(click.position.inner, { elementToken: "button" });
  assert.equal(click.deliveryMode, 0);
}));

test("native child input retains exact anchor and screenshot geometry without foreground delivery", async () => withRoot(async (root) => {
  await registerStage(root);
  const nativeCalls: Record<string, unknown>[] = [];
  const base = stageDependencies(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: { ...base, invokeNative: async (request) => {
    if (request.op !== "input") return base.invokeNative!(request);
    nativeCalls.push(request);
    return { ok: true, input: { childWindowId: "12345" } };
  } }, loadSdk: async () => makeSdk({ calls }) as never });
  await driver.click("stage", 42, 24);
  await driver.typeText("stage", "hello");
  await driver.scroll("stage", 42, 24, "down");
  assert.deepEqual(nativeCalls.map((call) => call.kind), ["click", "type", "scroll"]);
  for (const call of nativeCalls) {
    assert.equal(call.pid, 4321);
    assert.equal(call.windowId, windowId);
    assert.equal(call.desktopId, desktopId);
    assert.equal(call.imageWidth, 200);
    assert.equal(call.imageHeight, 100);
  }
  assert.equal(calls.some((call) => ["click", "typeText", "scroll"].includes(call.method)), false);
}));

test("types bounded text to the exact focused window without echoing it in the result", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const secretLikeText = "local-only fixture text";
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls }) as never });
  const proof = await driver.typeText("stage", secretLikeText);
  const request = calls.find((call) => call.method === "typeText")?.value as { text: string; target: { input: unknown } };
  assert.equal(request.text, secretLikeText);
  assert.deepEqual(request.target.input, { pid: 4321, windowId: BigInt(windowId) });
  assert.equal(proof.outcome.status, "confirmed");
  assert.doesNotMatch(JSON.stringify(proof), /local-only fixture text/);
  await assert.rejects(() => driver.typeText("stage", ""), /1–500 characters/);
  await assert.rejects(() => driver.typeText("stage", "x".repeat(501)), /1–500 characters/);
}));

test("scroll and drag use window-local screenshot coordinates and validate bounds before dispatch", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls }) as never });
  await driver.scroll("stage", 42, 24, "down");
  const scroll = calls.find((call) => call.method === "scroll")?.value as { x: number; y: number; direction: number; by: number; amount: bigint; target: { input: unknown } };
  assert.deepEqual({ x: scroll.x, y: scroll.y, direction: scroll.direction, by: scroll.by, amount: scroll.amount }, { x: 42, y: 24, direction: 1, by: 0, amount: BigInt(3) });
  assert.deepEqual(scroll.target.input, { pid: 4321, windowId: BigInt(windowId) });
  await driver.drag("stage", 10, 20, 100, 80);
  const drag = calls.find((call) => call.method === "drag")?.value as { fromX: number; fromY: number; toX: number; toY: number; durationMs: bigint; steps: bigint; target: { input: unknown } };
  assert.deepEqual({ fromX: drag.fromX, fromY: drag.fromY, toX: drag.toX, toY: drag.toY, durationMs: drag.durationMs, steps: drag.steps }, { fromX: 10, fromY: 20, toX: 100, toY: 80, durationMs: BigInt(500), steps: BigInt(10) });
  assert.deepEqual(drag.target.input, { pid: 4321, windowId: BigInt(windowId) });
  const callsBeforeInvalid = calls.filter((call) => call.method === "drag").length;
  await assert.rejects(() => driver.drag("stage", 10, 20, 200, 80), /Both drag points must fall inside/);
  assert.equal(calls.filter((call) => call.method === "drag").length, callsBeforeInvalid);
}));

test("surfaces a Cua Driver background refusal instead of retrying with foreground input", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const refusal = { text: "background input is unavailable", images: [], isError: true, errorCode: "background_unavailable", degraded: false, rawJson: "" };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, toolResult: refusal }) as never });
  await assert.rejects(() => driver.typeText("stage", "sample"), /background input is unavailable/);
  assert.equal(calls.some((call) => call.method === "click"), false);
  assert.ok(calls.some((call) => call.method === "shutdown"));
}));
