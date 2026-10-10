import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createCuaStageDriver as createCuaStageDriverCore, topmostWindowAtScreenPoint, type CuaStageDriverDependencies } from "../src/lib/native/cua-stage-driver";
import { createWindowsDesktopStageManager } from "../src/lib/native/windows-desktop-stage";
import { parseTaskStageAction } from "../src/lib/native/task-stage-actions";

const desktopId = "3ecb4a09-87d4-4f8b-9fd1-48bc9d8c14ae";
const windowId = "9223372036854775807";
const imageData = Buffer.from("stage-window-image").toString("base64");

function createCuaStageDriver(deps: CuaStageDriverDependencies = {}) {
  let connected: Awaited<ReturnType<NonNullable<CuaStageDriverDependencies["connectRuntime"]>>>;
  return createCuaStageDriverCore({
    ...deps,
    connectRuntime: async (sdk) => {
      const driver = sdk.CuaDriver.create(undefined);
      connected = deps.connectRuntime ? await deps.connectRuntime(sdk) : { driver, close: async () => driver.shutdown() };
      return connected;
    },
    windowAtPoint: deps.windowAtPoint ?? (async (x, y) => {
      const { windows } = await connected.driver.listWindows({ onScreenOnly: true });
      const window = topmostWindowAtScreenPoint(windows.filter((item) => item.pid !== connected.processId), x, y);
      return { pid: window.pid!, windowId: window.windowId };
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

test("foreground type delivery is an explicit retry after background refusal for the same exact window", async () => withRoot(async (root) => {
  await registerStage(root, "4567");
  const identity = { handle: "codex", sessionId: "terminal-session" };
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driverError = new Error("Background delivery is not available for target window class 'CASCADIA_HOSTING_WINDOW_CLASS' on this event kind (text_input).");
  const state = { pid: 4321, windowId: 4567n, screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 },
    images: [{ mimeType: "image/png", dataBase64: imageData }] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state,
    typeTextError: driverError,
    callToolResult: { isError: false, action: { effect: "confirmed", route: "global_input", summary: "foreground text delivered" } },
  }) as never });

  await assert.rejects(driver.typeText("stage", "echo M9R_TERM_OK", identity, "foreground"), /only after.*background.*refusal/i);
  await assert.rejects(driver.typeText("stage", "echo M9R_TERM_OK", identity), /Background delivery is not available/);
  await assert.rejects(driver.typeText("stage", "different command", identity, "foreground"), /only after.*background.*refusal/i);
  assert.equal(calls.some((item) => item.method === "callTool"), false, "foreground retry cannot change the refused text");
  assert.deepEqual(parseTaskStageAction({ kind: "type", text: "echo M9R_TERM_OK", deliveryMode: "foreground" }),
    { kind: "type", text: "echo M9R_TERM_OK", deliveryMode: "foreground" });
  assert.throws(() => parseTaskStageAction({ kind: "type", text: "echo M9R_TERM_OK", deliveryMode: "sideways" }), /Invalid stage text delivery mode/);

  const retried = await driver.typeText("stage", "echo M9R_TERM_OK", identity, "foreground");
  assert.equal(retried.outcome.status, "confirmed");
  const call = calls.find((item) => item.method === "callTool")?.value as { name: string; args: Record<string, unknown> };
  assert.equal(call.name, "type_text");
  assert.deepEqual(call.args.target, { kind: "window", pid: 4321, window_id: 4567 });
  assert.equal(call.args.text, "echo M9R_TERM_OK");
  assert.equal(call.args.delivery_mode, "foreground");
  assert.equal(typeof call.args.session, "string");
  await assert.rejects(driver.typeText("stage", "echo M9R_TERM_OK", identity, "foreground"), /only after.*background.*refusal/i);
}));

function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const fixtureRoot = resolve(process.cwd(), ".workcache", "native-test-fixtures");
  mkdirSync(fixtureRoot, { recursive: true });
  const root = mkdtempSync(join(fixtureRoot, "m9r-cua-stage-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("untitled taskbar controls use exact accessibility invocation and overlay-only movement", async () => withRoot(async (root) => {
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await registerOwnerPreview(root, identity);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const control = { label: "Start", pid: 123, windowPid: 123, windowId: "456", rect: { x: 0, y: 0, width: 50, height: 50 }, invoked: false };
  let invocations = 0;
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls, screenSize: { width: 1, height: 1 }, cursorState: { enabled: true, position: { x: 0, y: 0 } } }) as never,
    windowAtPoint: async () => ({ pid: 123, windowId: BigInt(456), shell: true }),
    pointControl: async (_x, _y, expected) => { if (expected) { assert.deepEqual(expected, control); invocations++; } return { ...control, invoked: Boolean(expected) }; } });
  await driver.captureDesktop("preview", identity);
  assert.equal((await driver.describeDesktopTarget("preview", 0, 0, identity))?.label, "Start");
  assert.equal((await driver.clickDesktop("preview", 0, 0, identity)).outcome.status, "unverified");
  assert.equal(invocations, 1);
  assert.equal(calls.some((c) => c.method === "getWindowState" || c.method === "click"), false);
  const move = calls.find((c) => c.method === "moveCursor")?.value as {
    x: number; y: number; target: { input?: { displayId?: string } }; session: string;
  };
  assert.deepEqual({ x: move.x, y: move.y, displayId: move.target.input?.displayId }, { x: 0, y: 0, displayId: "primary" });
  assert.equal(typeof move.session, "string");
  assert.equal(calls.some((c) => c.method === "callTool"), false, "the cursor uses the typed session API without generic tool or physical-pointer input");
  await assert.rejects(driver.typeTextDesktop("preview", "hello", identity), /No agent input window/);
}));

function stageDependencies(root: string): NonNullable<CuaStageDriverDependencies["stage"]> {
  return {
    platform: "win32",
    root,
    terminal: true,
    env: {},
    invokeNative: async (request) => {
      if (request.op === "input") return { ok: false, error: "unsupported native-control window" };
      if (request.op === "currentDesktop") return { ok: true, desktop: { desktopId, isCurrent: true } };
      if (request.op === "inspectDesktop") return { ok: true, desktop: { desktopId: String(request.desktopId), isCurrent: true } };
      return { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId), desktopId, onCurrentDesktop: true } };
    },
  };
}

async function registerStage(root: string, registeredWindowId = windowId): Promise<void> {
  const manager = createWindowsDesktopStageManager(stageDependencies(root));
  await manager.register("stage", "4321", registeredWindowId);
}

async function registerOwnerPreview(root: string, identity = { handle: "codex", sessionId: "desktop-session" }): Promise<void> {
  const manager = createWindowsDesktopStageManager(stageDependencies(root));
  await manager.adoptCurrentDesktop("preview");
  const sessionTag = createHash("sha256").update(`${identity.handle}\0${identity.sessionId}`).digest("hex").slice(0, 8);
  manager.assignAgent("preview", { handle: identity.handle, sessionTag });
}

function makeSdk(options: {
  state?: Record<string, unknown>;
  cursorState?: { enabled: boolean; position: { x: number; y: number } };
  actionResult?: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  windows?: Array<Record<string, unknown>>;
  screenSize?: { width: number; height: number };
  cursorVisible?: boolean;
  desktopMetadata?: Record<string, unknown>;
  sessionStateError?: Error;
  escalationError?: Error;
  windowStateError?: Error;
  typeTextError?: Error;
  callToolResult?: Record<string, unknown>;
  calls: Array<{ method: string; value?: unknown }>;
}) {
  const actionResult = options.actionResult ?? { effect: 0, route: 1, summary: "action confirmed" };
  const toolResult = options.toolResult ?? { text: "", images: [], isError: false, degraded: false, rawJson: "", action: actionResult };
  const driver = {
    async startSession(input: unknown) { options.calls.push({ method: "startSession", value: input }); },
    async setAgentCursorMotion(input: unknown) { options.calls.push({ method: "setAgentCursorMotion", value: input }); return { isError: false }; },
    async getWindowState(input: unknown) {
      options.calls.push({ method: "getWindowState", value: input });
      if (options.windowStateError) throw options.windowStateError;
      return options.state ?? {
        pid: 4321,
        windowId: BigInt(windowId),
        screenshotFrameValid: true,
        screenshotWidth: 200,
        screenshotHeight: 100,
        windowBounds: { x: 100, y: 50, width: 400, height: 200 },
        images: [{ mimeType: "image/png", dataBase64: imageData }],
      };
    },
    async getDesktopState(input: unknown) {
      options.calls.push({ method: "getDesktopState", value: input });
      return { text: "", images: [{ mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=" }],
        structuredJson: JSON.stringify(options.desktopMetadata ?? { captureId: "desktop-capture" }), isError: false, degraded: false, rawJson: "" };
    },
    async getScreenSize(input: unknown) {
      options.calls.push({ method: "getScreenSize", value: input });
      return { text: "", images: [], isError: false, degraded: false, rawJson: "",
        structuredJson: JSON.stringify(options.screenSize ?? { width: 1920, height: 1080 }) };
    },
    async getSessionState(input: unknown) {
      options.calls.push({ method: "getSessionState", value: input });
      if (options.sessionStateError) throw options.sessionStateError;
      return { desktopCaptureAuthorized: true };
    },
    async escalateSession(input: unknown) {
      options.calls.push({ method: "escalateSession", value: input });
      if (options.escalationError) throw options.escalationError;
      return { desktopCaptureAuthorized: true };
    },
    async parseVisualRegions(input: unknown) {
      options.calls.push({ method: "parseVisualRegions", value: input });
      return { text: "", images: [], isError: false, degraded: false, rawJson: "",
        structuredJson: JSON.stringify({ regions: [{ label: "Chrome", bounds: { x: 0, y: 0, width: 1, height: 1 } }] }) };
    },
    async setAgentCursorEnabled(input: unknown) { options.calls.push({ method: "setAgentCursorEnabled", value: input }); return { isError: false }; },
    async moveCursor(input: unknown) { options.calls.push({ method: "moveCursor", value: input }); return { isError: false }; },
    async callTool(name: string, argumentsJson: string) {
      options.calls.push({ method: "callTool", value: { name, args: JSON.parse(argumentsJson) } });
      return options.callToolResult ?? { isError: false };
    },
    async getAgentCursorState() {
      options.calls.push({ method: "getAgentCursorState" });
      const latest = [...options.calls].reverse().find((call) => call.method === "moveCursor" || call.method === "callTool");
      const lastMove = (latest?.method === "callTool" ? (latest.value as { args: unknown }).args : latest?.value) as {
        x?: number; y?: number; target?: { input?: { pid?: number; windowId?: bigint } };
      } | undefined;
      const windowTarget = lastMove?.target?.input;
      const state = options.state ?? { screenshotWidth: 200, screenshotHeight: 100,
        windowBounds: { x: 100, y: 50, width: 400, height: 200 } };
      const bounds = state.windowBounds as { x?: number; y?: number; width?: number; height?: number } | undefined;
      const screenshotWidth = Number(state.screenshotWidth ?? 200);
      const screenshotHeight = Number(state.screenshotHeight ?? 100);
      const position = windowTarget?.pid && bounds
        ? { x: (bounds.x ?? 0) + (lastMove?.x ?? 0) * (bounds.width ?? screenshotWidth) / screenshotWidth,
          y: (bounds.y ?? 0) + (lastMove?.y ?? 0) * (bounds.height ?? screenshotHeight) / screenshotHeight }
        : { x: lastMove?.x ?? 42, y: lastMove?.y ?? 24 };
      return { isError: false, structuredJson: JSON.stringify(options.cursorState ?? { enabled: true, position }) };
    },
    async getSession(input: unknown) { options.calls.push({ method: "getSession", value: input }); return { cursorVisible: options.cursorVisible ?? true }; },
    async listWindows(input: unknown) {
      options.calls.push({ method: "listWindows", value: input });
      return { windows: options.windows ?? [] };
    },
    async click(input: unknown) { options.calls.push({ method: "click", value: input }); return actionResult; },
    async pressKey(input: unknown) { options.calls.push({ method: "pressKey", value: input }); return toolResult; },
    async hotkey(input: unknown) { options.calls.push({ method: "hotkey", value: input }); return toolResult; },
    async typeText(input: unknown) { options.calls.push({ method: "typeText", value: input }); if (options.typeTextError) throw options.typeTextError; return toolResult; },
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
  class DesktopTarget {
    readonly input: { displayId: string };
    constructor(input: { displayId: string }) { this.input = input; options.calls.push({ method: "desktopTarget", value: input }); }
  }
  class CoordinatePosition {
    readonly inner: { x: number; y: number };
    constructor(input: { x: number; y: number }) { this.inner = input; }
  }
  class ElementPosition {
    readonly inner: { elementToken: string };
    constructor(input: { elementToken: string }) { this.inner = input; }
  }
  class CapturedPosition {
    readonly inner: { x: number; y: number; captureId: string };
    constructor(input: { x: number; y: number; captureId: string }) { this.inner = input; options.calls.push({ method: "capturedPosition", value: input }); }
  }
  return {
    CuaDriver: { create() { options.calls.push({ method: "create" }); return driver; } },
    ActionTarget: { Window: WindowTarget, Desktop: DesktopTarget },
    ClickPosition: { Coordinates: CoordinatePosition, Element: ElementPosition, CapturedCoordinates: CapturedPosition },
    InputDeliveryMode: { Background: 0, Foreground: 1 },
    EscalationReason: { NoWindowTarget: 3 },
    CaptureScope: { Desktop: 2 },
    ClickButton: { Left: 0, Right: 1, Middle: 2 },
    ScrollDirection: { Up: 0, Down: 1 },
    ScrollBy: { Line: 0 },
    VisualRegionKind: { Text: 0, Icon: 1 },
    CursorReducedMotion: { Auto: 0 },
    CursorMotionStyle: { Adaptive: 4 },
    CursorMotionTiming: { Fitts: 1 },
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

test("moves and verifies Cua's ghost cursor through the typed exact-window API", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls }) as never,
    now: () => new Date("2026-10-05T12:00:00.000Z"),
  });

  const result = await driver.moveCursor("stage", 42, 24);
  assert.deepEqual(result.cursor, { x: 42, y: 24, screenX: 184, screenY: 98, enabled: true, visible: true });
  const move = calls.find((call) => call.method === "moveCursor")?.value as {
    x: number; y: number; target: { input?: { pid?: number; windowId?: bigint } }; session: string;
  };
  assert.deepEqual({ x: move.x, y: move.y }, { x: 42, y: 24 }, "cursor coordinates remain in the exact window screenshot space");
  assert.deepEqual(move.target.input, { pid: 4321, windowId: BigInt(windowId) });
  assert.equal(typeof move.session, "string");
  assert.equal(calls.some((call) => call.method === "callTool"), false, "cursor motion uses the public typed driver method");
  assert.deepEqual(calls.map((call) => call.method).filter((method) => ["startSession", "endSession", "shutdown"].includes(method)), ["startSession", "endSession", "shutdown"]);
}));

test("owner preview captures the whole current desktop and binds visible cursor clicks to that capture", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls,
    windows: [{ pid: 4321, windowId: BigInt(windowId), appName: "Explorer", title: "Program Manager",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }],
    state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });

  const capture = await driver.captureDesktop("preview", { handle: "codex", sessionId: "desktop-session" });
  assert.equal(capture.width, 1);
  assert.equal("captureId" in capture, false, "opaque capture handles stay inside the local driver");
  assert.equal((await driver.describeDesktopTarget("preview", 0, 0, { handle: "codex", sessionId: "desktop-session" }))?.label, "Chrome");
  const cursor = await driver.moveDesktopCursor("preview", 0, 0, { handle: "codex", sessionId: "desktop-session" });
  assert.equal(cursor.cursor.visible, true);
  const click = await driver.clickDesktop("preview", 0, 0, { handle: "codex", sessionId: "desktop-session" }, { count: 2 });
  assert.equal(click.outcome.status, "confirmed");
  await driver.typeTextDesktop("preview", "hello", { handle: "codex", sessionId: "desktop-session" });
  await driver.hotkeyDesktop("preview", ["Ctrl", "L"], { handle: "codex", sessionId: "desktop-session" });

  const desktopCapture = calls.find((call) => call.method === "getDesktopState")?.value as Record<string, unknown>;
  assert.equal(desktopCapture.maxImageDimension, 1024);
  assert.equal(calls.some((call) => call.method === "desktopTarget"), false, "the agent cursor never uses the desktop target that warps the real pointer");
  assert.ok(calls.some((call) => call.method === "windowTarget"), "desktop input resolves to one exact HWND");
  const clickInput = calls.find((call) => call.method === "click")?.value as Record<string, unknown>;
  assert.equal(clickInput.deliveryMode, 0, "owner-preview routes clicks to the exact window in the background");
  const cursorMove = calls.find((call) => call.method === "moveCursor")?.value as {
    x: number; y: number; target: { input?: { pid?: number; windowId?: bigint } }; session: string;
  };
  assert.deepEqual({ x: cursorMove.x, y: cursorMove.y }, { x: 100, y: 50 }, "screen point maps into the exact window screenshot coordinates");
  assert.deepEqual(cursorMove.target.input, { pid: 4321, windowId: BigInt(windowId) });
  assert.equal(typeof cursorMove.session, "string");
  const windowTarget = clickInput.target as { input?: { pid?: number; windowId?: bigint } };
  assert.deepEqual(windowTarget.input, { pid: 4321, windowId: BigInt(windowId) });
  assert.equal(calls.some((call) => call.method === "callTool"), false, "cursor movement never uses an untyped protocol scope");
  const clickPosition = clickInput.position as { inner?: { x?: number; y?: number } };
  assert.deepEqual(clickPosition.inner, { x: 100, y: 50 }, "captured desktop pixels map into exact-window screenshot pixels");
  assert.equal(clickInput.count, 2);
  assert.equal(calls.some((call) => call.method === "getWindowState"), true, "background input is bound to a verified window snapshot");
  const typed = calls.find((call) => call.method === "typeText")?.value as { target?: { input?: unknown } };
  const hotkey = calls.find((call) => call.method === "hotkey")?.value as { target?: { input?: unknown } };
  assert.deepEqual(typed.target?.input, { pid: 4321, windowId: BigInt(windowId) });
  assert.deepEqual(hotkey.target?.input, { pid: 4321, windowId: BigInt(windowId) });
  assert.equal(calls.some((call) => call.method === "capturedPosition"), false, "owner-preview never falls back to foreground desktop click input");
  await driver.shutdown();
}));

test("owner-preview excludes the daemon's unlabeled overlay before snapshot and input", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const windows = [
    { pid: 999, windowId: BigInt(99), appName: "", title: "", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(99) },
    { pid: 4321, windowId: BigInt(windowId), appName: "Notepad", title: "Untitled", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) },
  ];
  const sdk = makeSdk({ calls, windows, state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true,
    screenshotWidth: 200, screenshotHeight: 100, windowBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    images: [{ mimeType: "image/png", dataBase64: imageData }] } });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => sdk as never,
    connectRuntime: async () => ({ driver: sdk.CuaDriver.create() as never, processId: 999, close: async () => {} }) });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  await driver.moveDesktopCursor("preview", 0, 0, identity);
  await driver.clickDesktop("preview", 0, 0, identity);
  await driver.typeTextDesktop("preview", "hello", identity);
  const snapshots = calls.filter((call) => call.method === "getWindowState");
  assert.ok(snapshots.length > 0);
  assert.ok(snapshots.every((call) => (call.value as { pid: number }).pid === 4321));
  assert.equal(calls.some((call) => call.method === "desktopTarget"), false);
  await driver.shutdown();
}));

test("desktop target description prefers the native control name over OCR, including money controls", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  for (const label of ["Start", "Pay now"]) {
    const calls: Array<{ method: string; value?: unknown }> = [];
    const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls,
      windows: [{ pid: 4321, windowId: BigInt(windowId), appName: "Explorer", title: "Desktop",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }],
      state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
        windowBounds: { x: 0, y: 0, width: 1920, height: 1080 }, images: [{ mimeType: "image/png", dataBase64: imageData }],
        elements: [{ label: "Window", role: "Window", enabled: true, frame: { x: 0, y: 0, w: 1920, h: 1080 } },
          { label, role: "Button", enabled: true, frame: { x: 950, y: 530, w: 40, h: 40 } }] },
    }) as never });
    const identity = { handle: "codex", sessionId: "desktop-session" };
    await driver.captureDesktop("preview", identity);
    assert.equal((await driver.describeDesktopTarget("preview", 0, 0, identity))?.label, label);
    assert.equal(calls.some((call) => call.method === "parseVisualRegions"), false);
    const snapshot = calls.find((call) => call.method === "getWindowState")?.value as { includeAccessibilityTree: boolean; maxElements: number };
    assert.equal(snapshot.includeAccessibilityTree, true);
    assert.equal(snapshot.maxElements, 512);
    await driver.shutdown();
  }
}));

test("desktop target description preserves native inspection failures", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const failure = new Error("get_window_state: target unavailable");
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, windowStateError: failure,
    windows: [{ pid: 4321, windowId: BigInt(windowId), appName: "Explorer", title: "Desktop",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }],
  }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  await assert.rejects(driver.describeDesktopTarget("preview", 0, 0, identity), (error) => error === failure);
  assert.equal(calls.some((call) => call.method === "parseVisualRegions"), false);
  await driver.shutdown();
}));

test("desktop hit testing chooses the documented frontmost HWND and refuses unknown or tied stacking", () => {
  const back = { pid: 100, windowId: BigInt(10), appName: "back.exe", title: "Back",
    bounds: { x: 0, y: 0, width: 500, height: 400 }, isOnScreen: true, minimized: false, zIndex: BigInt(1) };
  const front = { pid: 200, windowId: BigInt(20), appName: "front.exe", title: "Front",
    bounds: { x: 50, y: 50, width: 300, height: 250 }, isOnScreen: true, minimized: false, zIndex: BigInt(9) };
  assert.equal(topmostWindowAtScreenPoint([front, back], 100, 100).pid, 200, "higher zIndex is documented as closer to the front");
  assert.equal(topmostWindowAtScreenPoint([{ ...front, onCurrentSpace: false }, back], 100, 100).pid, 100,
    "a window on another virtual desktop cannot shadow the owner's current desktop target");
  assert.equal(topmostWindowAtScreenPoint([back, front], 400, 300).pid, 100, "a point outside the front window resolves to the back window");
  assert.throws(() => topmostWindowAtScreenPoint([{ ...back, zIndex: undefined }, front], 100, 100), /stacking order/);
  assert.throws(() => topmostWindowAtScreenPoint([back, { ...front, zIndex: BigInt(1) }], 100, 100), /ambiguous stacking order/);
});

test("owner-preview discards a stale HWND before sending keyboard input", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const windows: Array<Record<string, unknown>> = [{ pid: 4321, windowId: BigInt(windowId), appName: "notepad.exe", title: "Untitled - Notepad",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, windows,
    state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  await driver.clickDesktop("preview", 0, 0, identity);
  windows.splice(0, windows.length);
  await assert.rejects(() => driver.typeTextDesktop("preview", "hello", identity), /selected background window could not be verified/);
  assert.equal(calls.some((call) => call.method === "typeText"), false, "stale window identity is never sent to CUA input");
  await assert.rejects(() => driver.hotkeyDesktop("preview", ["Enter"], identity), /No agent input window is selected yet/);
  await driver.shutdown();
}));

test("owner-preview refuses keyboard input when the selected window moved to another virtual desktop", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const windows: Array<Record<string, unknown>> = [{ pid: 4321, windowId: BigInt(windowId), appName: "notepad.exe", title: "Untitled - Notepad",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, onCurrentSpace: true, zIndex: BigInt(1) }];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, windows,
    state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  await driver.clickDesktop("preview", 0, 0, identity);
  windows[0]!.onCurrentSpace = false;
  await assert.rejects(() => driver.typeTextDesktop("preview", "hello", identity), /selected background window could not be verified/);
  assert.equal(calls.some((call) => call.method === "typeText"), false, "a window on another desktop never receives owner-preview input");
  await driver.shutdown();
}));

test("owner-preview clears the keyboard target when an agent cursor session closes", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls,
    windows: [{ pid: 4321, windowId: BigInt(windowId), appName: "notepad.exe", title: "Untitled - Notepad",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }],
    state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  await driver.clickDesktop("preview", 0, 0, identity);
  await driver.closeAgentCursor(identity);
  await assert.rejects(() => driver.typeTextDesktop("preview", "hello", identity), /No agent input window is selected yet/);
  assert.equal(calls.some((call) => call.method === "typeText"), false, "a recreated cursor session must click a window again before typing");
  await driver.shutdown();
}));

test("owner-preview refuses ambiguous or missing window targets without sending foreground input", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  await assert.rejects(() => driver.clickDesktop("preview", 0, 0, identity), /No visible application window is under that desktop point/);
  assert.equal(calls.some((call) => call.method === "click"), false);
  await assert.rejects(() => driver.typeTextDesktop("preview", "hello", identity), /No agent input window is selected yet/);
  assert.equal(calls.some((call) => call.method === "typeText"), false);
  await driver.shutdown();
}));

test("owner-preview does not retain a keyboard target after an unconfirmed background click", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls,
    actionResult: { effect: 3, route: 1, summary: "click may not have reached the app" },
    windows: [{ pid: 4321, windowId: BigInt(windowId), appName: "notepad.exe", title: "Untitled - Notepad",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }],
    state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  const click = await driver.clickDesktop("preview", 0, 0, identity);
  assert.equal(click.outcome.status, "suspected-noop");
  await assert.rejects(() => driver.typeTextDesktop("preview", "hello", identity), /No agent input window is selected yet/);
  assert.equal(calls.some((call) => call.method === "typeText"), false, "unconfirmed click cannot authorize later typing");
  await driver.shutdown();
}));

test("owner-preview types to a reinspected accessibility field without relying on click focus", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const field = { elementToken: "snapshot:field", label: "Text editor", role: "Document", enabled: true,
    actions: ["set_value"], frame: { x: 0, y: 0, w: 1920, h: 1080 } };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls,
    actionResult: { effect: 3, route: 1, summary: "click remains unverified" },
    windows: [{ pid: 4321, windowId: BigInt(12345), appName: "notepad.exe", title: "Untitled - Notepad",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }],
    state: { pid: 4321, windowId: BigInt(12345), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 0, y: 0, width: 1920, height: 1080 }, elements: [field],
      images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  assert.equal((await driver.clickDesktop("preview", 0, 0, identity)).outcome.status, "suspected-noop");
  await driver.typeTextDesktop("preview", "hello", identity);
  const sent = calls.find((call) => call.method === "callTool" && (call.value as { name: string }).name === "set_value")?.value as { args: Record<string, unknown> };
  assert.equal(sent.args.element_token, "snapshot:field");
  assert.equal(sent.args.value, "hello");
  assert.equal(sent.args.pid, 4321);
  assert.equal(calls.some((call) => call.method === "typeText"), false);
  field.label = "Different editor";
  await assert.rejects(driver.typeTextDesktop("preview", "must not write", identity), /text field changed/);
  assert.equal(calls.filter((call) => call.method === "callTool" && (call.value as { name: string }).name === "set_value").length, 1);
  await driver.shutdown();
}));

test("owner-preview scroll and drag use the exact window under the cursor", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls,
    windows: [{ pid: 4321, windowId: BigInt(windowId), appName: "Explorer", title: "Program Manager",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }],
    state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  await driver.scrollDesktop("preview", 0, 0, "down", identity);
  await driver.dragDesktop("preview", 0, 0, 0, 0, identity);

  for (const method of ["scroll", "drag"]) {
    const action = calls.find((call) => call.method === method)?.value as { target?: { input?: unknown }; deliveryMode?: number };
    assert.deepEqual(action.target?.input, { pid: 4321, windowId: BigInt(windowId) });
    assert.equal(action.deliveryMode, undefined, `${method} does not use a foreground delivery mode`);
  }
  assert.equal(calls.some((call) => call.method === "capturedPosition"), false);
  await driver.shutdown();
}));

test("refuses to move the ghost cursor when the stage frame has no screen bounds", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls, state: {
      pid: 4321,
      windowId: BigInt(windowId),
      screenshotFrameValid: true,
      screenshotWidth: 200,
      screenshotHeight: 100,
      images: [{ mimeType: "image/png", dataBase64: imageData }],
    } }) as never,
  });

  await assert.rejects(() => driver.moveCursor("stage", 42, 24), /valid screen bounds/);
  assert.equal(calls.some((call) => call.method === "setAgentCursorEnabled" || call.method === "moveCursor"), false);
  await driver.shutdown();
}));

test("shows a distinct agent label on each native cursor and configures adaptive motion", async () => withRoot(async (root) => {
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
  assert.deepEqual(motion.map(({ session, style, timing, effects, dwellAfterClickMs, idleHideMs }) => ({
    session, style, timing, effects, dwellAfterClickMs, idleHideMs,
  })), sessions.map((session) => ({
    session,
    style: 4,
    timing: 1,
    effects: { trail: true, glow: true },
    dwellAfterClickMs: 100,
    idleHideMs: 60_000,
  })));
  assert.equal(calls.filter((call) => call.method === "moveCursor").length, 2);
  assert.equal(calls.some((call) => call.method === "callTool"), false);
  for (const identity of identities) await driver.closeAgentCursor(identity);
}));

test("owner desktop capture does not use legacy capture-scope session escalation", async () => withRoot(async (root) => {
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await registerOwnerPreview(root, identity);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({
      calls,
      sessionStateError: new Error("session has no capture policy; call start_session first"),
      escalationError: new Error("legacy capture-scope escalation is unavailable for this session"),
    }) as never,
  });

  const capture = await driver.captureDesktop("preview", identity);

  assert.equal(capture.width, 1);
  assert.equal(capture.height, 1);
  assert.ok(calls.some((call) => call.method === "startSession"));
  assert.ok(calls.some((call) => call.method === "getDesktopState"));
  assert.equal(calls.some((call) => call.method === "getSessionState" || call.method === "escalateSession"), false,
    "modern per-action desktop capture must not depend on the deprecated legacy capture policy");
  await driver.shutdown();
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
  assert.deepEqual(calls.map((call) => call.method).filter((method) => ["startSession", "endSession", "shutdown"].includes(method)), ["startSession", "endSession"]);
  const all = await driver.listVisibleWindows({ onScreenOnly: false });
  assert.ok(all.some((window) => window.windowId === "102"), "restoration discovery includes windows outside the visible screen");
  assert.equal(calls.filter((call) => call.method === "shutdown").length, 0, "launch polling must keep its host alive");
  await driver.shutdown();
  assert.equal(calls.filter((call) => call.method === "shutdown").length, 1);
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

test("describeTarget reports the smallest enabled control label for the money gate", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true,
    screenshotWidth: 200, screenshotHeight: 100, windowBounds: { x: 0, y: 0, width: 200, height: 100 },
    images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: [
      { frame: { x: 0, y: 0, w: 200, h: 100 } },
      { elementToken: "pay", label: "Pay $49 now", role: "button", frame: { x: 20, y: 10, w: 70, h: 30 } },
    ] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state }) as never });
  assert.deepEqual(await driver.describeTarget("stage", 42, 24),
    { label: "Pay $49 now", role: "button", rect: { x: 20, y: 10, width: 70, height: 30 } });
  assert.equal(await driver.describeTarget("stage", 199, 99), undefined, "a point on no tokened control describes nothing");
  await assert.rejects(() => driver.describeTarget("stage", 200, 24), /inside the current stage window snapshot/);
  assert.equal(calls.some((call) => ["click", "typeText", "scroll", "drag"].includes(call.method)), false, "describing never acts");
}));
