import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createCuaStageDriver as createCuaStageDriverCore, topmostWindowAtScreenPoint, type CuaStageDriverDependencies } from "../src/lib/native/cua-stage-driver";
import { createWindowsDesktopStageManager, type NativeWindowStructureElement } from "../src/lib/native/windows-desktop-stage";
import { parseTaskStageAction } from "../src/lib/native/task-stage-actions";
import { DesktopInputNotDispatchedError, DesktopInputOutcomeUnknownError } from "../src/lib/native/desktop-input-errors";

const windowId = "9223372036854775807";
const imageData = Buffer.from("stage-window-image").toString("base64");
type NativeStageFixture = {
  state?: Record<string, unknown>;
  windows?: Array<Record<string, unknown>>;
  screenSize?: { width: number; height: number };
  desktopOrigin?: { x: number; y: number };
  foregroundWindow?: { pid: number; windowId: string; title?: string; className?: string; visible?: boolean; minimized?: boolean };
  responses?: Record<string, Record<string, unknown>>;
  responseSequences?: Record<string, Record<string, unknown>[]>;
  structureRevision?: number;
  calls: Array<Record<string, unknown>>;
};
const nativeStageFixtures = new Map<string, NativeStageFixture>();
function nativeFixture(root: string): NativeStageFixture {
  let fixture = nativeStageFixtures.get(root);
  if (!fixture) {
    fixture = { calls: [], structureRevision: 0 };
    nativeStageFixtures.set(root, fixture);
  }
  return fixture;
}
function setNativeFixture(root: string, fixture: Partial<NativeStageFixture>): void {
  Object.assign(nativeFixture(root), fixture);
}

test("native refs survive token-prefix rotation and revalidate changed control identity before dispatch", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{method: string; value?: unknown}> = [];
  const element = { elementIndex: BigInt(0), elementToken: "walk1:0", role: "Button", depth: 1, label: "Search", enabled: true,
    actions: ["invoke"], frame: { x: 120, y: 70, w: 40, h: 20 } };
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 }, elements: [element], images: [{mimeType:"image/png", dataBase64:imageData}] };
  const driver = createCuaStageDriver({stage:stageDependencies(root),loadSdk:async()=>makeSdk({ testRoot: root,calls,state}) as never});
  const snapshot = await driver.readStructure("stage");
  const readsAfterObservation = calls.filter(call => call.method === "getWindowState").length;
  element.elementToken = "walk2:0";
  assert.equal((await driver.describeElementTarget("stage", snapshot.elements[0]!.ref, {}))?.label, "Search");
  assert.equal(calls.filter(call => call.method === "getWindowState").length, readsAfterObservation,
    "the money gate reuses the label from the observation instead of rereading UIA");
  element.label = "Pay now";
  assert.equal((await driver.describeElementTarget("stage", snapshot.elements[0]!.ref, {}))?.label, "Search",
    "the ref describes exactly what was observed; the action itself revalidates the live control before dispatch");
  await assert.rejects(() => driver.clickElement("stage", snapshot.elements[0]!.ref, undefined,
    { expectedRole: "Button", expectedLabel: "Search" }), (error: unknown) => error instanceof DesktopInputNotDispatchedError,
    "the actual click still revalidates the live control before dispatch");
  element.label = "Search"; element.frame.x += 100;
  const refreshed = await driver.readStructure("stage");
  assert.equal((await driver.describeElementTarget("stage", refreshed.elements[0]!.ref, {}))?.label, "Search");
  await driver.clickElement("stage", refreshed.elements[0]!.ref, undefined,
    { expectedRole: "Button", expectedLabel: "Search" });
  assert.ok(nativeFixture(root).calls.some((call) => call.op === "invokeWindowElement"),
    "a moved but semantically identical control resolves at its current location instead of treating layout movement as identity loss");
  assert.equal(calls.some(call=>call.method==="callTool"),false,"resolution does not dispatch input");
  await driver.shutdown();
}));

test("explicit background click never falls through to the owner's physical pointer", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{method:string;value?:unknown}> = [];
  const driver=createCuaStageDriver({stage:stageDependencies(root),loadSdk:async()=>makeSdk({ testRoot: root,calls,
    callToolResult:{isError:true,errorCode:"background_unavailable",text:"background input is unavailable"}}) as never});
  await assert.rejects(driver.click("stage",42,24,undefined,{deliveryMode:"background"}),
    error => error instanceof DesktopInputNotDispatchedError && error.code === "background-unavailable");
  assert.equal(nativeFixture(root).calls.some(call => ["bringToForeground", "sendClick"].includes(String(call.op))), false);
  assert.equal(calls.some(call=>call.method==="click"),false,"the overlay SDK never dispatches app input");
  await driver.shutdown();
}));

test("foreground input remains available when owner-pointer presentation preservation is unavailable", async () => withRoot(async root => {
  await registerStage(root);
  const calls:Array<{method:string;value?:unknown}>=[];
  const driver=createCuaStageDriver({stage:stageDependencies(root),loadSdk:async()=>makeSdk({ testRoot: root,calls}) as never,
    ownerPointer:{get:async()=>{throw Error("native pointer operation missing")},restore:async()=>{throw Error("must not restore")}}});
  const result = await driver.click("stage",42,24,undefined,{confirmFocusForeground:true});
  assert.equal(result.outcome.status,"unverified");
  assert.ok(nativeFixture(root).calls.some(call => call.op === "sendClick"),"owner-pointer sampling is a courtesy, not an input gate");
  assert.equal(calls.some(call=>call.method==="callTool"),false);
  await driver.shutdown();
}));

test("foreground input dispatches immediately regardless of concurrent owner pointer movement, then restores the pointer", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const positions = [{ x: 10, y: 10 }, { x: 30, y: 30 }, { x: 30, y: 30 }];
  const restored: Array<{ x: number; y: number }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls }) as never,
    ownerPointer: { get: async () => positions.shift() ?? { x: 30, y: 30 }, restore: async (x, y) => { restored.push({ x, y }); } },
  });
  const result = await driver.click("stage", 42, 24, undefined, { confirmFocusForeground: true });
  assert.equal(result.outcome.foregroundConfirmed, true);
  assert.ok(nativeFixture(root).calls.some((call) => call.op === "sendClick"), "native input dispatches without waiting for the owner to go idle");
  assert.equal(restored.length, 1, "the owner's resting pointer position is restored exactly once after dispatch");
  await driver.shutdown();
}));

function createCuaStageDriver(deps: CuaStageDriverDependencies & { skipNativeFixturePreload?: boolean } = {}) {
  let connected: Awaited<ReturnType<NonNullable<CuaStageDriverDependencies["connectRuntime"]>>>;
  const injectedLoadSdk = deps.loadSdk;
  const preloadedSdk = deps.skipNativeFixturePreload ? undefined : injectedLoadSdk?.();
  if (preloadedSdk) void preloadedSdk.catch(() => undefined);
  return createCuaStageDriverCore({
    ...deps,
    ...(preloadedSdk ? { loadSdk: async () => await preloadedSdk } : {}),
    connectRuntime: async (sdk) => {
      const driver = sdk.CuaDriver.create(undefined);
      connected = deps.connectRuntime ? await deps.connectRuntime(sdk) : { driver, close: async () => driver.shutdown() };
      return connected;
    },
  });
}

test("native window capture owns its dimensions instead of inheriting retired Cua frame flags", async () => withRoot(async (root) => {
  await registerStage(root);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=";
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotWidth: 1, screenshotHeight: 1,
    windowBounds: { x: 100, y: 50, width: 1, height: 1 },
    images: [{ mimeType: "image/png", dataBase64: png }] };
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, state, calls }) as never });
  const capture = await driver.capture("stage");
  assert.equal(capture.width, 1);
  assert.equal(capture.height, 1);
  assert.ok(nativeFixture(root).calls.some(call => call.op === "captureWindow"));
  assert.equal(calls.some(call => call.method === "getWindowState"), false,"native capture does not depend on Cua snapshots");
}));

test("app captures expose bounded accessibility targets in screenshot coordinates", async () => withRoot(async (root) => {
  await registerStage(root);
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true,
    screenshotWidth: 200, screenshotHeight: 100, windowBounds: { x: 100, y: 50, width: 400, height: 200 },
    images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: [{ label: "Search\nfield", role: "Edit", enabled: true, frame: { x: 120, y: 70, w: 200, h: 40 } },
      { label: "Disabled", enabled: false, frame: { x: 120, y: 70, w: 200, h: 40 } }] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, state, calls: [] }) as never });
  assert.deepEqual((await driver.capture("stage")).controls, [{ label: "Search field", role: "Edit", rect: { x: 20, y: 20, width: 200, height: 40 } }]);
}));

test("targeted UIA value reads return one fresh non-password control without moving focus", async () => withRoot(async (root) => {
  await registerStage(root);
  setNativeFixture(root, { state: { elementsComplete: true, windowBounds: { x: 100, y: 50, width: 400, height: 200 },
    elements: [{ role: "Text", label: "Calculator result", className: "Text", automationId: "Result", enabled: true,
      actions: { readValue: true }, accessibleValue: "432", frame: { x: 120, y: 70, w: 100, h: 30 } }] } });
  const nativeStructure = await createWindowsDesktopStageManager(stageDependencies(root)).windowStructure(4321, windowId, { maxElements: 4096, maxDepth: 64 });
  assert.equal(nativeStructure.elements[0]?.actions?.readValue, true, "the native UIA structure advertises a readable value pattern");
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({
    testRoot: root, state: nativeFixture(root).state as Record<string, unknown>, calls: [],
  }) as never });
  const structure = await driver.readStructure("stage");
  assert.equal(structure.elements[0]?.canReadValue, true, "the provider-neutral app structure exposes targeted readback");
  assert.ok(structure.elements[0]?.actions?.includes("read_value"));
  const result = await driver.readElementValue("stage", structure.elements[0]!.ref,
    undefined, { expectedRole: "Text", expectedLabel: "Calculator result", maxChars: 32 });
  assert.deepEqual(result, { status: "read", value: "432", truncated: false });
  assert.equal(nativeFixture(root).calls.some((call) => ["bringToForeground", "sendClick", "sendText", "sendKeyCombo"].includes(String(call.op))), false,
    "targeted UIA readback is observational and does not take focus or dispatch input");
  await driver.shutdown();
}));

test("app structure exposes its absolute window frame separately from local element coordinates", async () => withRoot(async (root) => {
  await registerStage(root);
  const state = { pid: 4321, windowId: BigInt(windowId), appName: "Test App", windowTitle: "Window",
    screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: -1200, y: 80, width: 400, height: 200 },
    images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: [{ label: "Search", role: "Edit", enabled: true, frame: { x: -1180, y: 100, w: 200, h: 40 } }] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, state, calls: [] }) as never });
  const structure = await driver.readStructure("stage");
  assert.deepEqual(structure.screenRect, { x: -1200, y: 80, width: 400, height: 200 });
  assert.deepEqual(structure.elements[0]?.rect, { x: 20, y: 20, width: 200, height: 40 });
  await driver.shutdown();
}));

test("structure completeness does not imply offscreen content is absent", async () => withRoot(async (root) => {
  await registerStage(root);
  const state = { pid: 4321, windowId: BigInt(windowId), appName: "File Explorer", windowTitle: "Documents",
    screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 },
    images: [{ mimeType: "image/png", dataBase64: imageData }],
    elementsComplete: true,
    elements: [
      { elementIndex: BigInt(0), elementToken: "snapshot:scrollbar", role: "ScrollBar", depth: 1, enabled: true,
        min: 0, max: 100, frame: { x: 480, y: 55, w: 12, h: 180 } },
      { elementIndex: BigInt(1), elementToken: "snapshot:slider", role: "Slider", depth: 1, enabled: true,
        min: 0, max: 100, frame: { x: 200, y: 80, w: 100, h: 20 } },
    ],
  };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, state, calls: [] }) as never });
  const structure = await driver.readStructure("stage");
  assert.equal(structure.status, "complete", "the accessibility walk itself is complete");
  assert.deepEqual(structure.coverage, { scope: "window", visibleViewport: "observed", scrollability: "indicated", offscreenContent: "possible" });
  assert.equal(JSON.stringify(structure).includes("\"max\""), false, "raw range values are not exposed to the provider");
  await driver.shutdown();
}));

test("a complete structure without scroll evidence reports unknown, not no offscreen content", async () => withRoot(async (root) => {
  await registerStage(root);
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true,
    screenshotWidth: 200, screenshotHeight: 100, windowBounds: { x: 100, y: 50, width: 400, height: 200 },
    images: [{ mimeType: "image/png", dataBase64: imageData }], elementsComplete: true,
    elements: [{ elementIndex: BigInt(0), elementToken: "snapshot:button", role: "Button", depth: 1, enabled: true, actions: ["invoke"] }],
  };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, state, calls: [] }) as never });
  const structure = await driver.readStructure("stage");
  assert.equal(structure.status, "complete");
  assert.deepEqual(structure.coverage, { scope: "window", visibleViewport: "observed", scrollability: "unknown", offscreenContent: "unknown" });
  await driver.shutdown();
}));

test("desktop coverage aggregates generic scroll evidence per visible window", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const identity = { handle: "codex", sessionId: "desktop-session" };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls: [],
    windows: [{ pid: 4321, windowId: BigInt(windowId), appName: "File Explorer", title: "Documents",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, minimized: false, onCurrentSpace: true, zIndex: BigInt(1) }],
    state: { pid: 4321, windowId: BigInt(windowId), appName: "File Explorer", windowTitle: "Documents",
      screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 0, y: 0, width: 1920, height: 1080 }, elementsComplete: true,
      elements: [{ elementIndex: BigInt(0), elementToken: "snapshot:scrollbar", role: "ScrollBar", depth: 1, enabled: true,
        min: 0, max: 100, frame: { x: 1900, y: 0, w: 20, h: 100 } }],
      images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });
  const structure = await driver.readDesktopStructure("preview", identity);
  assert.deepEqual(structure.coverage, { scope: "desktop", visibleViewport: "observed", scrollability: "indicated", offscreenContent: "possible" });
  assert.deepEqual(structure.windows[0]?.coverage, { scope: "window", visibleViewport: "observed", scrollability: "indicated", offscreenContent: "possible" });
  await driver.shutdown();
}));

test("desktop structure keeps screenshot-local click bounds separate from absolute window placement bounds", async () => withRoot(async (root) => {
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await registerOwnerPreview(root, identity);
  setNativeFixture(root, {
    desktopOrigin: { x: -1920, y: 40 }, screenSize: { width: 1920, height: 1080 },
    windows: [{ pid: 4321, windowId: BigInt(windowId), appName: "editor.exe", title: "Document",
      bounds: { x: -1800, y: 60, width: 800, height: 600 }, isOnScreen: true, minimized: false, zIndex: BigInt(1) }],
  });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls: [] }) as never });
  const structure = await driver.readDesktopStructure("preview", identity);
  assert.deepEqual(structure.windows[0]?.rect, { x: 120, y: 20, width: 800, height: 600 });
  assert.deepEqual(structure.windows[0]?.screenRect, { x: -1800, y: 60, width: 800, height: 600 });
  await driver.shutdown();
}));

test("window_frame reports the exact native frame and selected HWND", async () => withRoot(async (root) => {
  await registerStage(root);
  const requested = { x: 120, y: 80, width: 640, height: 480 };
  setNativeFixture(root, { responses: { setWindowFrame: { ok: true, rect: requested } } });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls: [] }) as never });
  const proof = await driver.windowFrame("stage", requested.x, requested.y, requested.width, requested.height);
  assert.equal(proof.outcome.status, "confirmed");
  assert.deepEqual(proof.outcome.windowFrame, { requested, actual: requested, verified: true });
  assert.ok(nativeFixture(root).calls.some((call) => call.op === "setWindowFrame" && call.pid === 4321
    && call.windowId === windowId && call.x === 120 && call.y === 80 && call.width === 640 && call.height === 480));
  await driver.shutdown();
}));

test("window_frame reports app or Windows size constraints as partial with the actual frame", async () => withRoot(async (root) => {
  await registerStage(root);
  const requested = { x: 120, y: 80, width: 1, height: 1 };
  const actual = { x: 120, y: 80, width: 320, height: 200 };
  setNativeFixture(root, { responses: { setWindowFrame: { ok: true, rect: actual } } });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls: [] }) as never });
  const proof = await driver.windowFrame("stage", requested.x, requested.y, requested.width, requested.height);
  assert.equal(proof.outcome.status, "partial");
  assert.deepEqual(proof.outcome.windowFrame, { requested, actual, verified: false });
  await driver.shutdown();
}));

test("snap docks the exact selected window to its fresh monitor work area and reports actual bounds", async () => withRoot(async (root) => {
  await registerStage(root);
  const workArea = { x: -1600, y: 40, width: 1600, height: 860 };
  const frame = { x: -800, y: 40, width: 800, height: 860 };
  setNativeFixture(root, { responses: {
    workArea: { ok: true, rect: workArea },
    setWindowFrame: { ok: true, rect: frame },
  } });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls: [] }) as never });
  const proof = await driver.snapWindow("stage", "right");
  assert.equal(proof.outcome.status, "confirmed");
  assert.deepEqual(proof.outcome.windowFrame, { requested: frame, actual: frame, verified: true });
  assert.ok(nativeFixture(root).calls.some((call) => call.op === "workArea" && call.pid === 4321 && call.windowId === windowId));
  assert.ok(nativeFixture(root).calls.some((call) => call.op === "setWindowFrame" && call.pid === 4321 && call.windowId === windowId));
  await driver.shutdown();
}));

test("native accessibility failure retains the exact-window screenshot route", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls, accessibilityError: new Error("custom UI tree unavailable") }) as never });
  assert.equal((await driver.capture("stage")).width, 200);
  const ops = nativeFixture(root).calls.map(call => call.op);
  assert.ok(ops.includes("inspectWindowStructure"));
  assert.ok(ops.includes("captureWindow"));
  assert.equal(calls.some((call) => call.method === "click" || call.method === "callTool"), false);
}));

test("stage key parsing accepts the case-insensitive names advertised by MCP", () => {
  assert.deepEqual(parseTaskStageAction({ kind: "press_key", key: "enter" }), { kind: "press_key", key: "Enter" });
  assert.deepEqual(parseTaskStageAction({ kind: "hotkey", keys: ["ctrl", "l"] }), { kind: "hotkey", keys: ["Ctrl", "l"] });
});

test("background text refusal is reported without activating the window or retrying through global input", async () => withRoot(async (root) => {
  await registerStage(root, "4567");
  const identity = { handle: "codex", sessionId: "terminal-session" };
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driverError = new Error("Background delivery is not available for target window class 'CASCADIA_HOSTING_WINDOW_CLASS' on this event kind (text_input).");
  const state = { pid: 4321, windowId: BigInt(4567), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 },
    images: [{ mimeType: "image/png", dataBase64: imageData }] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls, state,
    typeTextError: driverError,
  }) as never });
  // Background mode now tries the WM_CHAR channel (sendTextToWindow) before giving up; force
  // that to fail too, so this exercises the real "nothing works" fail-closed case rather than
  // the one the new channel is designed to resolve.
  setNativeFixture(root, { responses: { sendTextToWindow: { ok: false, dispatchState: "not-dispatched",
    error: "Windows declined to queue a WM_CHAR message for the target window." } } });

  await assert.rejects(driver.typeText("stage", "echo M9R_TERM_OK", identity, { deliveryMode: "background" }),
    error => error instanceof DesktopInputNotDispatchedError && error.code === "native-dispatch-unavailable");
  assert.throws(() => parseTaskStageAction({ kind: "type", text: "echo M9R_TERM_OK", deliveryMode: "foreground" }), /Invalid stage action fields/);
  assert.equal(nativeFixture(root).calls.some((item) => ["bringToForeground", "sendText"].includes(String(item.op))), false,
    "background refusal never retries with global foreground input");
}));

test("background text delivers through the WM_CHAR channel without touching real foreground input", async () => withRoot(async (root) => {
  await registerStage(root, "4567");
  const identity = { handle: "codex", sessionId: "terminal-session" };
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driverError = new Error("Background delivery is not available for target window class 'CASCADIA_HOSTING_WINDOW_CLASS' on this event kind (text_input).");
  const state = { pid: 4321, windowId: BigInt(4567), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 },
    images: [{ mimeType: "image/png", dataBase64: imageData }] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls, state,
    typeTextError: driverError,
  }) as never });

  const proof = await driver.typeText("stage", "echo M9R_TERM_OK", identity, { deliveryMode: "background" });
  assert.equal(proof.outcome.status, "unverifiable");
  assert.ok(nativeFixture(root).calls.some((item) => item.op === "sendTextToWindow" && item.pid === 4321 && item.windowId === "4567" && item.text === "echo M9R_TERM_OK"),
    "background mode dispatches the new WM_CHAR channel to the exact target window");
  assert.equal(nativeFixture(root).calls.some((item) => ["bringToForeground", "sendText"].includes(String(item.op))), false,
    "the background-safe channel never falls through to global foreground input");
  assert.equal(calls.some((call) => ["callTool", "typeText"].includes(call.method)), false,
    "Cua's own driver is never invoked once the native background channel succeeds");
}));

test("owner-preview preserves the clicked HWND for the next native text step", async () => withRoot(async (root) => {
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await registerOwnerPreview(root, identity);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const windows = [{ pid: 4321, windowId: BigInt(windowId), appName: "notepad.exe", title: "Untitled - Notepad",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }];
  const backgroundError = new Error("Background delivery is not available for target window class 'CASCADIA_HOSTING_WINDOW_CLASS' on this event kind (text_input).");
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls, windows, typeTextError: backgroundError,
      state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
        windowBounds: { x: 0, y: 0, width: 1920, height: 1080 }, images: [{ mimeType: "image/png", dataBase64: imageData }] },
    }) as never,
    windowAtPoint: async () => ({ pid: 4321, windowId: BigInt(windowId) }),
  });

  await driver.captureDesktop("preview", identity);
  await driver.clickDesktop("preview", 0, 0, identity);
  await driver.typeTextDesktop("preview", "hello", identity);
  const ops = nativeFixture(root).calls.map((call) => String(call.op));
  assert.ok(ops.includes("sendClick"));
  assert.ok(ops.includes("sendText"), "the click's exact HWND remains the target for subsequent typing");
  assert.ok(ops.includes("bringToForeground"), "the keyboard step acquires its own exact-window foreground lease");
  assert.equal(calls.some((call) => ["click", "typeText"].includes(call.method)), false, "app input stays on the native path");
}));

function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const fixtureRoot = resolve(process.cwd(), ".workcache", "native-test-fixtures");
  mkdirSync(fixtureRoot, { recursive: true });
  const root = mkdtempSync(join(fixtureRoot, "m9r-cua-stage-"));
  return run(root).finally(() => {
    nativeStageFixtures.delete(root);
    rmSync(root, { recursive: true, force: true });
  });
}

test("untitled taskbar controls use exact accessibility invocation and the overlay-only shell cursor scope", async () => withRoot(async (root) => {
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await registerOwnerPreview(root, identity);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const control = { label: "Start", pid: 123, windowPid: 123, windowId: "456", rect: { x: 0, y: 0, width: 50, height: 50 }, invoked: false };
  let invocations = 0;
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls, screenSize: { width: 1, height: 1 },
      state: { screenshotWidth: 1, screenshotHeight: 1, windowBounds: { x: 0, y: 0, width: 1, height: 1 } } }) as never,
    windowAtPoint: async () => ({ pid: 123, windowId: BigInt(456), shell: true, screenOrigin: { x: 0, y: 0 } }),
    pointControl: async (_x, _y, expected) => { if (expected) { assert.deepEqual(expected, control); invocations++; } return { ...control, invoked: Boolean(expected) }; } });
  await driver.showAgentCursor("preview", identity);
  await driver.captureDesktop("preview", identity);
  assert.equal((await driver.describeDesktopTarget("preview", 0, 0, identity))?.label, "Start");
  assert.equal((await driver.clickDesktop("preview", 0, 0, identity)).outcome.status, "unverified");
  assert.equal(invocations, 1);
  assert.equal(calls.some((c) => c.method === "click"), false, "shell actions never use Cua's window click endpoint");
  const cursorCall = calls.find((c) => c.method === "callTool")?.value as { name: string; args: Record<string, unknown> };
  assert.equal(cursorCall.name, "move_cursor");
  assert.deepEqual({ scope: cursorCall.args.scope, x: cursorCall.args.x, y: cursorCall.args.y }, { scope: "window", x: 0, y: 0 });
  assert.equal(typeof cursorCall.args.session, "string");
  assert.equal(calls.some((c) => c.method === "desktopTarget"), false, "a desktop target would move the owner's physical pointer");
  assert.equal(calls.some((c) => c.method === "moveCursor"), false, "the shell uses the overlay-only route because Cua omits shell HWNDs");
  await assert.rejects(driver.typeTextDesktop("preview", "hello", identity), /desktop-wide view has no input window/);
}));

function stageDependencies(root: string): NonNullable<CuaStageDriverDependencies["stage"]> {
  return {
    platform: "win32",
    root,
    terminal: true,
    // The cursor runtime is injected for its presentation-only overlay.
    env: { M9R_ENABLE_CUA_COMPAT: "1" },
    invokeNative: async (request) => {
      const fixture = nativeFixture(root);
      fixture.calls.push({ ...request });
      const queued = fixture.responseSequences?.[String(request.op)]?.shift();
      if (queued) return queued as never;
      const configured = fixture.responses?.[String(request.op)];
      if (configured) return configured as never;
      if (["currentDesktop", "createDesktop", "inspectDesktop", "activateDesktop", "moveWindowToDesktop"].includes(String(request.op))) {
        return { ok: false, error: "Windows desktop operations are retired." };
      }
      const matchingWindow = fixture.windows?.find((window) => Number(window.pid) === Number(request.pid)
        && String(window.windowId) === String(request.windowId));
      const captureBounds = matchingWindow?.bounds as { x?: number; y?: number; width?: number; height?: number } | undefined
        ?? fixture.state?.windowBounds as { x?: number; y?: number; width?: number; height?: number } | undefined
        ?? { x: 100, y: 50, width: 200, height: 100 };
      if (request.op === "captureWindow") {
        const state = fixture.state;
        const image = (state?.images as Array<{ dataBase64?: string }> | undefined)?.[0]?.dataBase64 ?? imageData;
        return { ok: true, capture: {
          dataUrl: `data:image/png;base64,${image}`,
          width: Number(captureBounds.width ?? state?.screenshotWidth ?? 200),
          height: Number(captureBounds.height ?? state?.screenshotHeight ?? 100),
          originX: Number(captureBounds.x ?? 100), originY: Number(captureBounds.y ?? 50),
        } };
      }
      if (request.op === "captureDesktop") {
        const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=";
        return { ok: true, capture: { dataUrl: `data:image/png;base64,${image}`,
          width: fixture.screenSize?.width ?? 1920, height: fixture.screenSize?.height ?? 1080,
          originX: fixture.desktopOrigin?.x ?? 0, originY: fixture.desktopOrigin?.y ?? 0 } };
      }
      if (request.op === "windowRect") {
        return { ok: true, rect: captureBounds };
      }
      if (request.op === "inspectDesktopStructure") {
        const source = (fixture.state?.elements as Array<Record<string, unknown>> | undefined) ?? [];
        const elements = source.flatMap((element, index) => {
          const frame = (element.frame ?? element.rect ?? {}) as { x?: number; y?: number; w?: number; h?: number; width?: number; height?: number };
          const width = Number(frame.width ?? frame.w ?? 0), height = Number(frame.height ?? frame.h ?? 0);
          if (width <= 0 || height <= 0) return [];
          return [{ ref: `desktop-ui-element-${index + 1}`, label: String(element.label ?? ""), role: String(element.role ?? ""),
            className: String(element.className ?? ""), depth: Number(element.depth ?? 1), enabled: element.enabled !== false,
            focused: element.focused === true, rect: { x: Number(frame.x ?? 0), y: Number(frame.y ?? 0), width, height } }];
        });
        return { ok: true, desktopStructure: { scope: "desktop", status: fixture.state?.elementsComplete === true ? "complete" : "partial",
          truncated: false, screen: { x: 0, y: 0, width: fixture.screenSize?.width ?? 1920, height: fixture.screenSize?.height ?? 1080 }, elements } };
      }
      if (request.op === "inspectPointControl" || request.op === "invokePointControl") {
        const x = Number(request.x), y = Number(request.y);
        const source = (fixture.state?.elements as Array<Record<string, unknown>> | undefined) ?? [];
        const candidates = source.flatMap((element) => {
          const frame = (element.frame ?? element.rect ?? {}) as { x?: number; y?: number; w?: number; h?: number; width?: number; height?: number };
          const left = Number(frame.x ?? 0), top = Number(frame.y ?? 0);
          const width = Number(frame.width ?? frame.w ?? 0), height = Number(frame.height ?? frame.h ?? 0);
          const label = String(element.label ?? "");
          if (element.enabled === false || !label.trim() || width <= 0 || height <= 0
            || x < left || y < top || x >= left + width || y >= top + height) return [];
          return [{ element, label, rect: { x: left, y: top, width, height }, area: width * height }];
        }).sort((a, b) => a.area - b.area);
        const hit = candidates[0];
        if (!hit) return { ok: false, error: "No named enabled accessibility control at the exact point." };
        const window = fixture.windows?.find((item) => Number(item.pid) === Number(hit.element.pid ?? 4321))
          ?? { pid: 4321, windowId: BigInt(windowId) };
        const control = { label: hit.label, pid: Number(hit.element.pid ?? window.pid),
          windowId: String(hit.element.windowId ?? window.windowId), windowPid: Number(hit.element.windowPid ?? window.pid),
          rect: hit.rect, invoked: request.op === "invokePointControl", confirmed: request.op === "invokePointControl" };
        return { ok: true, control };
      }
      if (request.op === "inspectWindowStructure") {
        const state = fixture.state;
        fixture.structureRevision = (fixture.structureRevision ?? 0) + 1;
        const structureRevision = fixture.structureRevision;
        const source = (state?.elements as Array<Record<string, unknown>> | undefined) ?? [];
        const elements = source.map((element, index) => {
          const frame = (element.frame ?? element.rect ?? {}) as { x?: number; y?: number; w?: number; h?: number; width?: number; height?: number };
          const actionNames = Array.isArray(element.actions) ? element.actions.map(String) : [];
          const actions = element.actions && !Array.isArray(element.actions) && typeof element.actions === "object"
            ? element.actions as Record<string, unknown> : {};
          return {
            // Native refs are snapshot-qualified, so a later tree read can
            // never make an old provider ref silently point at a new element.
            ref: `window-ui-element-${structureRevision}-${index + 1}`, path: [index], depth: Number(element.depth ?? 1),
            role: String(element.role ?? ""), label: String(element.label ?? ""),
            className: String(element.className ?? ""), automationId: String(element.automationId ?? ""),
            ...(Array.isArray(element.runtimeId) ? { runtimeId: element.runtimeId as number[] } : {}),
            enabled: element.enabled !== false, focused: element.focused === true,
            rect: { x: Number(frame.x ?? 100), y: Number(frame.y ?? 50),
              width: Number(frame.width ?? frame.w ?? 10), height: Number(frame.height ?? frame.h ?? 10) },
            actions: {
              invoke: actionNames.some((name) => ["invoke", "click"].includes(name)) || actions.invoke === true,
              select: actionNames.includes("select") || actions.select === true,
              toggle: actionNames.includes("toggle") || actions.toggle === true,
              legacy: actionNames.includes("legacy") || actions.legacy === true,
              setValue: actionNames.includes("set_value") || actions.setValue === true || actions.set_value === true,
              readValue: actionNames.includes("read_value") || actions.readValue === true || actions.read_value === true,
              scroll: actionNames.includes("scroll") || actions.scroll === true,
            },
            scroll: (element.scroll ?? null) as NativeWindowStructureElement["scroll"],
          };
        });
        return { ok: true, windowStructure: { scope: "window", windowId: String(request.windowId),
          status: state?.elementsComplete === true ? "complete" : "partial", truncated: false, elements } };
      }
      if (request.op === "invokeWindowElement") {
        const input = request as Record<string, unknown>;
        const path = input.path as number[] | undefined;
        const element = (fixture.state?.elements as Array<Record<string, unknown>> | undefined)?.[path?.[0] ?? -1];
        const actions = Array.isArray(element?.actions) ? element.actions.map(String) : [];
        const elementActions = element?.actions && !Array.isArray(element.actions) && typeof element.actions === "object"
          ? element.actions as Record<string, unknown> : {};
        const canRun = input.action === "setValue" ? actions.includes("set_value") || elementActions.setValue === true
          : input.action === "readValue" ? actions.includes("read_value") || elementActions.readValue === true
            : input.action === "scroll" ? actions.includes("scroll")
            : actions.some((name) => ["invoke", "click", "select", "toggle", "expand"].includes(name));
        const sameIdentity = element && String(element.role ?? "") === input.expectedRole
          && String(element.label ?? "") === input.expectedLabel
          && String(element.className ?? "") === input.expectedClassName
          && String(element.automationId ?? "") === input.expectedAutomationId;
        if (!sameIdentity) return { ok: false, dispatchState: "not-dispatched", error: "The native semantic target changed; no semantic input was sent." };
        if (canRun && input.action === "readValue") return { ok: true, semanticAction: {
          dispatched: false, read: true, value: String(element?.accessibleValue ?? ""), truncated: false,
        } };
        return canRun
          ? { ok: true, semanticAction: { dispatched: true, mechanism: "test-uia",
            ...(input.action === "setValue" ? { valueConfirmed: fixture.state?.valueConfirmed !== false } : {}),
            ...(input.action === "scroll" ? { scrollBefore: { horizontal: null, vertical: Number(fixture.state?.scrollBeforePercent ?? 20) },
              scrollAfter: { horizontal: null, vertical: Number(fixture.state?.scrollAfterPercent ?? 25) }, moved: fixture.state?.scrollMoved !== false } : {}) } }
          : { ok: true, semanticAction: { dispatched: false, reason: input.action === "scroll" ? "scroll-pattern-unavailable" : "activation-pattern-unavailable" } };
      }
      if (request.op === "listVisibleWindows") {
        const source = fixture.windows;
        const windows = (source ?? [{ pid: 4321, windowId: BigInt(windowId), title: "Stage window",
          appName: "test-app.exe", bounds: { x: 100, y: 50, width: 400, height: 200 }, isOnScreen: true, minimized: false, zIndex: BigInt(1) }])
          .map((window, index) => {
            const bounds = (window.bounds ?? {}) as { x?: number; y?: number; width?: number; height?: number };
            return { pid: Number(window.pid), windowId: String(window.windowId), title: String(window.title ?? ""),
              width: Number(bounds.width ?? window.width ?? 800), height: Number(bounds.height ?? window.height ?? 600),
              x: Number(bounds.x ?? window.x ?? 100), y: Number(bounds.y ?? window.y ?? 50), zOrder: index,
              className: String(window.className ?? ""), processName: String(window.processName ?? window.appName ?? "test-app.exe"),
              processPath: null, appUserModelId: null };
          });
        return { ok: true, windows };
      }
      if (request.op === "currentForegroundWindow") {
        return { ok: true, foregroundWindow: fixture.foregroundWindow ?? { pid: 4321, windowId, title: "Stage window", className: "TestWindow", visible: true, minimized: false } };
      }
      if (request.op === "foregroundWindow") {
        return { ok: true, foregroundWindow: fixture.foregroundWindow ?? { pid: Number(request.pid), windowId: String(request.windowId) } };
      }
      if (request.op === "windowAtPoint") {
        const x = Number(request.x), y = Number(request.y);
        const source = fixture.windows?.length ? fixture.windows : [{ pid: 4321, windowId: BigInt(windowId), title: "Stage window",
          bounds: { x: 0, y: 0, width: 400, height: 300 }, isOnScreen: true, minimized: false, zIndex: BigInt(1) }];
        const window = [...source].reverse().find((candidate) => {
          const bounds = (candidate.bounds ?? {}) as { x?: number; y?: number; width?: number; height?: number };
          const left = Number(bounds.x ?? candidate.x ?? 0), top = Number(bounds.y ?? candidate.y ?? 0);
          const width = Number(bounds.width ?? candidate.width ?? 0), height = Number(bounds.height ?? candidate.height ?? 0);
          return x >= left && y >= top && x < left + width && y < top + height;
        });
        return window ? { ok: true, pointWindow: { pid: Number(window.pid), windowId: String(window.windowId),
          screenOrigin: { x: Number((window.bounds as { x?: number } | undefined)?.x ?? window.x ?? 0),
            y: Number((window.bounds as { y?: number } | undefined)?.y ?? window.y ?? 0) } } }
          : { ok: false, error: "No test window contains the requested point." };
      }
      if (request.op === "desktopStructure") return { ok: false, error: "Unexpected legacy desktopStructure operation." };
      if (["bringToForeground", "sendClick", "sendDrag", "sendScroll", "sendKeyCombo", "sendText"].includes(String(request.op))) {
        return { ok: true };
      }
      return { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId) } };
    },
  };
}

async function registerStage(root: string, registeredWindowId = windowId): Promise<void> {
  nativeFixture(root);
  const manager = createWindowsDesktopStageManager(stageDependencies(root));
  await manager.register("stage", "4321", registeredWindowId);
}

async function registerOwnerPreview(root: string, identity = { handle: "codex", sessionId: "desktop-session" }): Promise<void> {
  nativeFixture(root);
  const manager = createWindowsDesktopStageManager(stageDependencies(root));
  await manager.ensureStage("preview");
  const sessionTag = createHash("sha256").update(`${identity.handle}\0${identity.sessionId}`).digest("hex").slice(0, 8);
  manager.assignAgent("preview", { handle: identity.handle, sessionTag });
}

function makeSdk(options: {
  testRoot?: string;
  state?: Record<string, unknown>;
  cursorState?: { enabled: boolean; position: { x: number; y: number } };
  actionResult?: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  windows?: Array<Record<string, unknown>>;
  screenSize?: { width: number; height: number };
  cursorVisible?: boolean;
  cursorVisibleSequence?: boolean[];
  desktopMetadata?: Record<string, unknown>;
  sessionStateError?: Error;
  escalationError?: Error;
  windowStateError?: Error;
  accessibilityError?: Error;
  typeTextError?: Error;
  typeTextErrors?: Error[];
  callToolResult?: Record<string, unknown>;
  callToolErrors?: Record<string, Error>;
  moveCursorError?: Error;
  moveCursorBarrier?: (input: unknown) => Promise<void>;
  calls: Array<{ method: string; value?: unknown }>;
}) {
  // Legacy CUA expectations in this file were formerly also the only source
  // of test UI state. Mirror those fixtures into the native Windows test seam
  // so every assertion now exercises M9R's production perception/dispatch
  // contract; the SDK mock remains solely for cursor-overlay behavior.
  if (options.testRoot) setNativeFixture(options.testRoot, {
    ...(options.state ? { state: options.state } : {}),
    ...(options.windows ? { windows: options.windows } : {}),
    ...(options.screenSize ? { screenSize: options.screenSize } : {}),
  });
  const actionResult = options.actionResult ?? { effect: 0, route: 1, summary: "action confirmed" };
  const toolResult = options.toolResult ?? { text: "", images: [], isError: false, degraded: false, rawJson: "", action: actionResult };
  const driver = {
    async startSession(input: unknown) {
      options.calls.push({ method: "startSession", value: input });
      return { state: {}, active: true, revived: false,
        ...(typeof input === "object" && input !== null && "cursorMotion" in input
          ? { cursorMotion: (input as { cursorMotion: unknown }).cursorMotion } : {}) };
    },
    async setAgentCursorMotion(input: unknown) { options.calls.push({ method: "setAgentCursorMotion", value: input }); return { isError: false }; },
    async getWindowState(input: unknown) {
      options.calls.push({ method: "getWindowState", value: input });
      if (options.accessibilityError && (input as { includeAccessibilityTree?: boolean }).includeAccessibilityTree) throw options.accessibilityError;
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
    async moveCursor(input: unknown) {
      options.calls.push({ method: "moveCursor", value: input });
      await options.moveCursorBarrier?.(input);
      if (options.moveCursorError) return { isError: true, text: options.moveCursorError.message };
      return { isError: false };
    },
    async callTool(name: string, argumentsJson: string) {
      options.calls.push({ method: "callTool", value: { name, args: JSON.parse(argumentsJson) } });
      if (options.callToolErrors?.[name]) throw options.callToolErrors[name];
      return options.callToolResult ?? { isError: false };
    },
    async getAgentCursorState() {
      options.calls.push({ method: "getAgentCursorState" });
      const latest = [...options.calls].reverse().find((call) => call.method === "moveCursor" || call.method === "callTool");
      const lastMove = (latest?.method === "callTool" ? (latest.value as { args: unknown }).args : latest?.value) as {
        x?: number; y?: number; target?: { input?: { pid?: number; windowId?: bigint } };
      } | undefined;
      // Cua reports a window-target cursor in the same window-local screenshot
      // space the caller moved it in (see cua-stage-driver.ts's own comment on
      // this): moveCursor/getAgentCursorState round-trip in window-local
      // pixels, never desktop-screen pixels, for a real window target. This
      // fixture previously rescaled the reported position into desktop-screen
      // space via windowBounds whenever a window target was present, which
      // does not match that documented real-driver behavior and made every
      // position-confirmation check in production code fail against a
      // correctly-moved cursor (Package 3 diagnosis, M9R Source of Truth 5.0).
      const position = { x: lastMove?.x ?? 42, y: lastMove?.y ?? 24 };
      return { isError: false, structuredJson: JSON.stringify(options.cursorState ?? { enabled: true, position }) };
    },
    async getSession(input: unknown) {
      options.calls.push({ method: "getSession", value: input });
      return { cursorVisible: options.cursorVisibleSequence?.shift() ?? options.cursorVisible ?? true };
    },
    async listWindows(input: unknown) {
      options.calls.push({ method: "listWindows", value: input });
      return { windows: options.windows ?? [] };
    },
    async click(input: unknown) {
      options.calls.push({ method: "click", value: input });
      if (options.callToolResult) options.calls.push({ method: "callTool", value: { name: "click", args: { delivery_mode: "background" } } });
      return (options.callToolResult ?? actionResult) as never;
    },
    async pressKey(input: unknown) { options.calls.push({ method: "pressKey", value: input }); return toolResult; },
    async hotkey(input: unknown) { options.calls.push({ method: "hotkey", value: input }); return toolResult; },
    async typeText(input: unknown) {
      options.calls.push({ method: "typeText", value: input });
      const error = options.typeTextErrors?.shift() ?? options.typeTextError;
      if (error) throw error;
      return (options.callToolResult ?? toolResult) as never;
    },
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
  const sdk = {
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
    CursorMotionTiming: { Native: 0 },
  };
  const fixtureState = {
    pid: 4321,
    windowId: BigInt(windowId),
    screenshotFrameValid: true,
    screenshotWidth: 200,
    screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 200, height: 100 },
    images: [{ mimeType: "image/png", dataBase64: imageData }],
    ...options.state,
  };
  const responses: Record<string, Record<string, unknown>> = {};
  if (options.accessibilityError) responses.inspectWindowStructure = { ok: false, error: options.accessibilityError.message };
  if (options.windowStateError) responses.captureWindow = { ok: false, error: options.windowStateError.message };
  if (options.testRoot) setNativeFixture(options.testRoot, {
    state: fixtureState,
    ...(options.windows ? { windows: options.windows } : {}),
    ...(options.screenSize ? { screenSize: options.screenSize } : {}),
    ...(Object.keys(responses).length ? { responses } : {}),
  });
  return sdk;
}

test("native capture stays scoped to the registered HWND without starting the cursor runtime", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls }) as never,
    now: () => new Date("2026-10-05T12:00:00.000Z"),
  });

  const capture = await driver.capture("stage");
  assert.equal(capture.dataUrl, `data:image/png;base64,${imageData}`);
  assert.equal(capture.width, 200);
  assert.equal(capture.height, 100);
  assert.equal(capture.capturedAt, "2026-10-05T12:00:00.000Z");
  const native = nativeFixture(root).calls;
  assert.ok(native.some(call => call.op === "inspect" && call.pid === 4321 && call.windowId === windowId));
  assert.ok(native.some(call => call.op === "captureWindow" && call.pid === 4321 && call.windowId === windowId));
  assert.deepEqual(capture.controls, []);
  assert.equal(calls.some(call => ["startSession", "getWindowState", "click"].includes(call.method)), false);
}));

test("native action timings separate observation, targeting, dispatch, and the refreshed observation", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const timings: Array<{ phase: string; stageName?: string; durationMs: number; status: string }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls }) as never,
    onTiming: (event) => timings.push(event),
  });

  const result = await driver.click("stage", 42, 24);
  assert.equal(result.outcome.status, "unverified", "instrumentation must not turn OS delivery into semantic success");
  const phases = timings.map(({ phase }) => phase);
  for (const phase of ["window-capture", "accessibility-read", "target-resolution", "input-dispatch", "post-action-observation"]) {
    assert.ok(phases.includes(phase), `missing measured phase: ${phase}`);
  }
  const dispatchIndex = phases.indexOf("input-dispatch");
  const postObservationIndex = phases.indexOf("post-action-observation");
  assert.ok(dispatchIndex >= 0 && postObservationIndex > dispatchIndex, "the refreshed observation follows actual input delivery");
  assert.ok(timings.every((event) => event.stageName === "stage" && Number.isFinite(event.durationMs)
    && event.durationMs >= 0 && ["ok", "error"].includes(event.status)));
  assert.equal(nativeFixture(root).calls.filter((call) => call.op === "sendClick").length, 1,
    "timing instrumentation must preserve the existing single-dispatch behavior");
  await driver.shutdown();
}));

test("moves and verifies Cua's ghost cursor through the typed exact-window API", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls }) as never,
    now: () => new Date("2026-10-05T12:00:00.000Z"),
  });

  const identity = { handle: "codex", sessionId: "cursor-move" };
  await driver.showAgentCursor("stage", identity);
  const result = await driver.moveCursor("stage", 42, 24, identity);
  assert.deepEqual(result.cursor, { x: 42, y: 24, screenX: 142, screenY: 74, enabled: true, visible: true });
  const move = calls.filter((call) => call.method === "moveCursor").at(-1)?.value as {
    x: number; y: number; target: { input?: { pid?: number; windowId?: bigint } }; session: string;
  };
  assert.deepEqual({ x: move.x, y: move.y }, { x: 21, y: 12 }, "native capture pixels are converted into Cua's exact window screenshot space");
  assert.deepEqual(move.target.input, { pid: 4321, windowId: BigInt(windowId) });
  assert.equal(typeof move.session, "string");
  const coordinateReads = calls.filter((call) => call.method === "getWindowState").map((call) => call.value as Record<string, unknown>);
  assert.ok(coordinateReads.some((input) => input.includeAccessibilityTree === false && input.includeScreenshot === true
    && input.maxImageDimension === 0), "the coordinate conversion uses Cua's own current screenshot metadata");
  assert.equal(calls.some((call) => ["click", "typeText", "pressKey", "hotkey", "scroll", "drag"].includes(call.method)), false,
    "app input does not use the overlay adapter");
  assert.deepEqual(calls.map((call) => call.method).filter((method) => ["startSession", "endSession"].includes(method)), ["startSession"],
    "the overlay session supports cursor presentation only and is not involved in app input");
}));

test("native click waits for the matching overlay position when cursor presentation is healthy", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  let releaseMove!: () => void;
  let announceMove!: () => void;
  const moveStarted = new Promise<void>((resolve) => { announceMove = resolve; });
  const moveGate = new Promise<void>((resolve) => { releaseMove = resolve; });
  let moveCompleted = false;
  const stage = stageDependencies(root);
  const invokeNative = stage.invokeNative!;
  stage.invokeNative = async (request) => {
    if (request.op === "sendClick") assert.equal(moveCompleted, true, "native pointer delivery must follow its visible cursor move");
    return invokeNative(request);
  };
  const driver = createCuaStageDriver({ stage,
    loadSdk: async () => makeSdk({ testRoot: root, calls, moveCursorBarrier: async (input) => {
      const point = input as { x?: number; y?: number };
      if (point.x === 21 && point.y === 12) {
        announceMove();
        await moveGate;
        moveCompleted = true;
      }
    } }) as never,
  });
  const identity = { handle: "codex", sessionId: "cursor-follows-click" };
  await driver.showAgentCursor("stage", identity);
  const click = driver.click("stage", 42, 24, identity);
  await moveStarted;
  assert.equal(nativeFixture(root).calls.some((call) => call.op === "sendClick"), false,
    "the real click cannot overtake an in-flight overlay move");
  releaseMove();
  await click;
  assert.equal(nativeFixture(root).calls.filter((call) => call.op === "sendClick").length, 1);
  await driver.shutdown();
}));

test("a stalled overlay move is bounded and cannot block native input", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls, moveCursorBarrier: async () => new Promise<void>(() => {}) }) as never,
  });
  const identity = { handle: "codex", sessionId: "cursor-overlay-stall" };
  await driver.showAgentCursor("stage", identity);
  const result = await driver.click("stage", 42, 24, identity);
  assert.equal(result.outcome.status, "unverified");
  assert.equal(nativeFixture(root).calls.filter((call) => call.op === "sendClick").length, 1,
    "a presentation-only compositor stall does not suppress a valid native click");
  await driver.shutdown();
}));

test("cursor moves for one agent identity are serialized to preserve action order", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  let releaseFirst!: () => void;
  let announceFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls, moveCursorBarrier: async (input) => {
      if ((input as { x?: number }).x === 5) { announceFirst(); await firstGate; }
    } }) as never,
  });
  const identity = { handle: "codex", sessionId: "cursor-ordered" };
  await driver.showAgentCursor("stage", identity);
  const first = driver.moveCursor("stage", 10, 20, identity);
  await firstStarted;
  const second = driver.moveCursor("stage", 80, 30, identity);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.filter((call) => call.method === "moveCursor").map((call) => (call.value as { x: number }).x), [20, 5],
    "the next overlay move waits behind the currently moving cursor");
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls.filter((call) => call.method === "moveCursor").map((call) => (call.value as { x: number }).x), [20, 5, 40]);
  await driver.shutdown();
}));

test("a background refusal of the ghost-cursor overlay is a clean typed refusal, never an uncertain plain error", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const moveCursorError = new Error("Background delivery is not available for target window class 'Chrome_WidgetWin_1' on this event kind (mouse_move).");
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls, moveCursorError }) as never });
  const identity = { handle: "codex", sessionId: "cursor-refusal" };
  await driver.showAgentCursor("stage", identity);
  await assert.rejects(driver.moveCursor("stage", 42, 24, identity), (error: unknown) =>
    error instanceof DesktopInputNotDispatchedError && error.code === "background-unavailable");
  await driver.shutdown();
}));

test("owner preview captures the whole current desktop and binds visible cursor clicks to that capture", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls,
    windows: [{ pid: 4321, windowId: BigInt(windowId), appName: "Explorer", title: "Program Manager",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }],
    state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      elements: [{ label: "Chrome", role: "Button", enabled: true, frame: { x: 0, y: 0, w: 40, h: 40 } }],
      images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });

  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.showAgentCursor("preview", identity);
  const capture = await driver.captureDesktop("preview", identity);
  assert.equal(capture.width, 1920);
  assert.equal(capture.height, 1080);
  assert.equal("captureId" in capture, false, "opaque capture handles stay inside the local driver");
  assert.equal((await driver.describeDesktopTarget("preview", 0, 0, identity))?.label, "Chrome");
  const cursor = await driver.moveDesktopCursor("preview", 0, 0, identity);
  assert.equal(cursor.cursor.visible, true);
  const click = await driver.clickDesktop("preview", 0, 0, identity, { count: 2 });
  assert.equal(click.outcome.status, "unverified");
  await driver.typeTextDesktop("preview", "hello", identity);
  await driver.hotkeyDesktop("preview", ["Ctrl", "L"], identity);

  assert.equal(calls.some((call) => call.method === "getDesktopState"), false, "desktop perception is native");
  assert.equal(calls.some((call) => call.method === "desktopTarget"), false, "the agent cursor never uses the desktop target that warps the real pointer");
  const nativeClick = nativeFixture(root).calls.find((call) => call.op === "sendClick");
  assert.ok(nativeClick, "desktop app input uses the native exact-HWND sender");
  assert.equal(nativeClick?.pid, 4321);
  assert.equal(nativeClick?.windowId, windowId);
  const cursorMove = calls.filter((call) => call.method === "moveCursor").at(-1)?.value as {
    x: number; y: number; target: { input?: { pid?: number; windowId?: bigint } }; session: string;
  };
  assert.deepEqual({ x: cursorMove.x, y: cursorMove.y }, { x: 0, y: 0 }, "the cursor follows the hit window in its own screenshot space");
  assert.deepEqual(cursorMove.target.input, { pid: 4321, windowId: BigInt(windowId) });
  assert.equal(typeof cursorMove.session, "string");
  assert.equal(nativeFixture(root).calls.filter((call) => call.op === "sendText").length, 1);
  assert.equal(nativeFixture(root).calls.filter((call) => call.op === "sendKeyCombo").length, 1);
  assert.equal(calls.some((call) => ["click", "typeText", "hotkey", "capturedPosition"].includes(call.method)), false,
    "the overlay adapter does not dispatch input or capture the desktop");
  await driver.shutdown();
}));

test("desktop pointer actions reproject through the hit window's screenshot size", async () => withRoot(async (root) => {
  const identity = { handle: "codex", sessionId: "restored-window-mapping" };
  await registerOwnerPreview(root, identity);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const window = { pid: 4321, windowId: BigInt(windowId), processName: "notepad.exe", title: "Untitled",
    bounds: { x: 100, y: 50, width: 400, height: 200 }, isOnScreen: true, minimized: false, zIndex: BigInt(1) };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls,
    windows: [window], screenSize: { width: 1920, height: 1080 },
    state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: window.bounds, images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });

  await driver.captureDesktop("preview", identity);
  await driver.clickDesktop("preview", 300, 150, identity, { button: "right" });
  await driver.scrollDesktop("preview", 300, 150, "down", identity);
  await driver.scrollDeltaDesktop("preview", 300, 150, 0, -3, "line", identity);

  for (const operation of ["sendClick", "sendScroll"]) {
    const callsForOperation = nativeFixture(root).calls.filter((call) => call.op === operation);
    assert.equal(callsForOperation.length, operation === "sendScroll" ? 2 : 1);
    for (const call of callsForOperation) {
      assert.ok(Math.abs(Number(call.x) - 300) <= 2, `${operation} x should stay at the observed desktop point, got ${call.x}`);
      assert.ok(Math.abs(Number(call.y) - 150) <= 2, `${operation} y should stay at the observed desktop point, got ${call.y}`);
    }
  }
  await driver.shutdown();
}));

test("owner-preview desktop drag can cross into another window while retaining the exact drag-start HWND", async () => withRoot(async (root) => {
  const identity = { handle: "codex", sessionId: "cross-window-drag" };
  await registerOwnerPreview(root, identity);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const first = { pid: 4321, windowId: BigInt(windowId), processName: "notepad.exe", title: "Source",
    bounds: { x: 100, y: 50, width: 400, height: 200 }, isOnScreen: true, minimized: false, zIndex: BigInt(1) };
  const second = { pid: 5678, windowId: BigInt(7777), processName: "explorer.exe", title: "Destination",
    bounds: { x: 500, y: 50, width: 400, height: 200 }, isOnScreen: true, minimized: false, zIndex: BigInt(2) };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls,
    windows: [first, second], screenSize: { width: 1920, height: 1080 },
    state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: first.bounds, images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });

  await driver.captureDesktop("preview", identity);
  await driver.dragDesktop("preview", 300, 150, 600, 150, identity);

  const drag = nativeFixture(root).calls.find((call) => call.op === "sendDrag");
  assert.ok(drag, "owner-preview sends one physical drag across the observed endpoints");
  assert.equal(drag?.pid, first.pid);
  assert.equal(drag?.windowId, windowId, "the drag remains bound to the exact window under its start point");
  assert.ok(Math.abs(Number(drag?.fromX) - 300) <= 2);
  assert.ok(Math.abs(Number(drag?.fromY) - 150) <= 2);
  assert.ok(Math.abs(Number(drag?.toX) - 600) <= 2);
  assert.ok(Math.abs(Number(drag?.toY) - 150) <= 2);
  await driver.shutdown();
}));

test("owner-preview excludes the daemon's unlabeled overlay before snapshot and input", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const windows = [
    { pid: 999, windowId: BigInt(99), appName: "", title: "", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(99) },
    { pid: 4321, windowId: BigInt(windowId), appName: "Notepad", title: "Untitled", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) },
  ];
  const sdk = makeSdk({ testRoot: root, calls, windows, state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true,
    screenshotWidth: 200, screenshotHeight: 100, windowBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    images: [{ mimeType: "image/png", dataBase64: imageData }] } });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => sdk as never,
    connectRuntime: async () => ({ driver: sdk.CuaDriver.create() as never, processId: 999, close: async () => {} }) });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.showAgentCursor("preview", identity);
  await driver.captureDesktop("preview", identity);
  await driver.moveDesktopCursor("preview", 0, 0, identity);
  await driver.clickDesktop("preview", 0, 0, identity);
  await driver.typeTextDesktop("preview", "hello", identity);
  const inspected = nativeFixture(root).calls.filter((call) => call.op === "inspect");
  assert.ok(inspected.length > 0);
  assert.ok(inspected.every((call) => call.pid === 4321 && call.windowId === windowId));
  assert.equal(calls.some((call) => call.method === "desktopTarget"), false);
  await driver.shutdown();
}));

test("desktop target description uses exact UIA point inspection for readable labels", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  for (const label of ["Start", "Pay now"]) {
    const calls: Array<{ method: string; value?: unknown }> = [];
    const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls,
      windows: [{ pid: 4321, windowId: BigInt(windowId), appName: "Explorer", title: "Desktop",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }],
      state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
        windowBounds: { x: 0, y: 0, width: 1920, height: 1080 }, images: [{ mimeType: "image/png", dataBase64: imageData }],
        elements: [{ label: "Window", role: "Window", enabled: true, frame: { x: 0, y: 0, w: 1920, h: 1080 } },
          { label, role: "Button", enabled: true, frame: { x: 950, y: 530, w: 40, h: 40 } }] },
    }) as never });
    const identity = { handle: "codex", sessionId: "desktop-session" };
    await driver.captureDesktop("preview", identity);
    assert.equal((await driver.describeDesktopTarget("preview", 970, 550, identity))?.label, label);
    assert.equal(calls.some((call) => call.method === "parseVisualRegions"), false);
    assert.deepEqual(nativeFixture(root).calls.find((call) => call.op === "inspectPointControl") && {
      op: nativeFixture(root).calls.find((call) => call.op === "inspectPointControl")?.op,
      x: nativeFixture(root).calls.find((call) => call.op === "inspectPointControl")?.x,
      y: nativeFixture(root).calls.find((call) => call.op === "inspectPointControl")?.y,
    }, { op: "inspectPointControl", x: 970, y: 550 });
    assert.equal(nativeFixture(root).calls.some((call) => call.op === "inspectWindowStructure"), false,
      "a one-point money-label check does not walk the full window tree");
    await driver.shutdown();
  }
}));

test("desktop target description treats an unreadable point as unlabeled without invoking an unrelated route", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls,
    windows: [{ pid: 4321, windowId: BigInt(windowId), appName: "Explorer", title: "Desktop",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }],
  }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  assert.equal(await driver.describeDesktopTarget("preview", 0, 0, identity), undefined);
  assert.equal(calls.some((call) => call.method === "parseVisualRegions"), false);
  assert.equal(nativeFixture(root).calls.some((call) => call.op === "inspectWindowStructure"), false);
  await driver.shutdown();
}));

test("desktop hit testing chooses the documented frontmost HWND and refuses unknown or tied stacking", () => {
  const back = { pid: 100, windowId: BigInt(10), appName: "back.exe", title: "Back",
    bounds: { x: 0, y: 0, width: 500, height: 400 }, isOnScreen: true, minimized: false, zIndex: BigInt(1) };
  const front = { pid: 200, windowId: BigInt(20), appName: "front.exe", title: "Front",
    bounds: { x: 50, y: 50, width: 300, height: 250 }, isOnScreen: true, minimized: false, zIndex: BigInt(9) };
  assert.equal(topmostWindowAtScreenPoint([front, back], 100, 100).pid, 200, "higher zIndex is documented as closer to the front");
  assert.equal(topmostWindowAtScreenPoint([{ ...front, onCurrentSpace: false }, back], 100, 100).pid, 200,
    "retired desktop-affinity metadata cannot hide a valid topmost HWND");
  assert.equal(topmostWindowAtScreenPoint([back, front], 400, 300).pid, 100, "a point outside the front window resolves to the back window");
  assert.throws(() => topmostWindowAtScreenPoint([{ ...back, zIndex: undefined }, front], 100, 100), /stacking order/);
  assert.throws(() => topmostWindowAtScreenPoint([back, { ...front, zIndex: BigInt(1) }], 100, 100), /ambiguous stacking order/);
});

test("owner-preview discards a stale HWND before sending keyboard input", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const windows: Array<Record<string, unknown>> = [{ pid: 4321, windowId: BigInt(windowId), appName: "notepad.exe", title: "Untitled - Notepad",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls, windows,
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
  await assert.rejects(() => driver.hotkeyDesktop("preview", ["Enter"], identity), /desktop-wide view has no input window/);
  await driver.shutdown();
}));

test("owner-preview ignores legacy desktop-affinity metadata and keeps using the exact selected HWND", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const nativeOps: string[] = [];
  const stage = stageDependencies(root);
  const baseInvoke = stage.invokeNative!;
  stage.invokeNative = async (request) => { nativeOps.push(String(request.op)); return baseInvoke(request); };
  const windows: Array<Record<string, unknown>> = [{ pid: 4321, windowId: BigInt(windowId), appName: "notepad.exe", title: "Untitled - Notepad",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, onCurrentSpace: true, zIndex: BigInt(1) }];
  const driver = createCuaStageDriver({ stage, loadSdk: async () => makeSdk({ testRoot: root, calls, windows,
    state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  await driver.clickDesktop("preview", 0, 0, identity);
  windows[0]!.onCurrentSpace = false;
  await assert.doesNotReject(() => driver.typeTextDesktop("preview", "hello", identity));
  assert.ok(nativeOps.includes("sendText"), "obsolete desktop metadata does not block exact-window input");
  await driver.shutdown();
}));

test("owner-preview clears the keyboard target when an agent cursor session closes", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls,
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
  await assert.rejects(() => driver.typeTextDesktop("preview", "hello", identity), /desktop-wide view has no input window/);
  assert.equal(calls.some((call) => call.method === "typeText"), false, "a recreated cursor session must click a window again before typing");
  await driver.shutdown();
}));

test("owner-preview refuses ambiguous or missing window targets without sending foreground input", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  await assert.rejects(() => driver.clickDesktop("preview", 0, 0, identity), /selected desktop point is outside the exact window snapshot/);
  assert.equal(calls.some((call) => call.method === "click"), false);
  await assert.rejects(() => driver.typeTextDesktop("preview", "hello", identity), /desktop-wide view has no input window/);
  assert.equal(calls.some((call) => call.method === "typeText"), false);
  await driver.shutdown();
}));

test("owner-preview keeps exact HWND identity after unverified SendInput click for continuation", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls,
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
  assert.equal(click.outcome.status, "unverified", "OS dispatch and app effect remain distinct signals");
  await driver.typeTextDesktop("preview", "hello", identity);
  const ops = nativeFixture(root).calls.map((call) => String(call.op));
  assert.ok(ops.includes("sendText"), "the following action can proceed against the exact still-visible HWND");
  assert.ok(ops.includes("bringToForeground"), "the following keyboard action performs its own focus step");
  assert.equal(calls.some((call) => call.method === "typeText"), false, "the overlay SDK never dispatches application text");
  await driver.shutdown();
}));

test("owner-preview types to a reinspected accessibility field without relying on click focus", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const field = { elementToken: "snapshot:field", label: "Text editor", role: "Document", enabled: true,
    actions: ["set_value"], frame: { x: 0, y: 0, w: 1920, h: 1080 } };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls,
    actionResult: { effect: 3, route: 1, summary: "click remains unverified" },
    windows: [{ pid: 4321, windowId: BigInt(12345), appName: "notepad.exe", title: "Untitled - Notepad",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }],
    state: { pid: 4321, windowId: BigInt(12345), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 0, y: 0, width: 1920, height: 1080 }, elements: [field],
      images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  assert.equal((await driver.clickDesktop("preview", 0, 0, identity)).outcome.status, "unverified");
  await driver.typeTextDesktop("preview", "hello", identity);
  assert.ok(nativeFixture(root).calls.some((call) => call.op === "sendText" && call.pid === 4321),
    "the exact focused document window receives native text input");
  assert.equal(calls.some((call) => call.method === "typeText" || call.method === "callTool"), false,
    "application text never uses the cursor adapter");
  field.label = "Different editor";
  await assert.doesNotReject(driver.typeTextDesktop("preview", "continues in the same exact window", identity));
  assert.equal(nativeFixture(root).calls.filter((call) => call.op === "sendText").length, 2);
  await driver.shutdown();
}));

test("owner-preview falls back to exact-window foreground typing when Chrome rejects background ValuePattern input", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const field = { elementToken: "snapshot:search", label: "Search", role: "Edit", enabled: true,
    actions: ["set_value"], frame: { x: 0, y: 0, w: 1920, h: 1080 } };
  const backgroundError = new Error("Background delivery is not available for target window class 'Chrome_WidgetWin_1' on this event kind (text_input).");
  const driver = createCuaStageDriver({ stage: stageDependencies(root), ownerPointer: {
    get: async () => ({ x: 100, y: 100 }), restore: async () => undefined,
  }, loadSdk: async () => makeSdk({ testRoot: root, calls,
    callToolErrors: { set_value: backgroundError },
    typeTextErrors: [backgroundError],
    windows: [{ pid: 4321, windowId: BigInt(12345), appName: "chrome.exe", title: "New tab",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, minimized: false }],
    state: { pid: 4321, windowId: BigInt(12345), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 0, y: 0, width: 1920, height: 1080 }, elements: [field],
      images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.captureDesktop("preview", identity);
  await driver.clickDesktop("preview", 0, 0, identity);
  const proof = await driver.typeTextDesktop("preview", "Strawberry Park latest video", identity, { deliveryMode: "owner-preview" });
  assert.equal(proof.outcome.status, "unverified");
  assert.ok(nativeFixture(root).calls.some((call) => call.op === "bringToForeground"), "owner-preview brings the exact window forward before physical keyboard input");
  assert.ok(nativeFixture(root).calls.some((call) => call.op === "sendText"), "owner-preview dispatches one native exact-window text action");
  assert.equal(calls.some((call) => ["callTool", "typeText"].includes(call.method)), false,
    "the overlay adapter never dispatches text or focuses an app");
  await driver.shutdown();
}));

test("an explicit background text request never steals focus when no semantic field action is available", async () => withRoot(async (root) => {
  await registerStage(root, "12345");
  const calls: Array<{ method: string; value?: unknown }> = [];
  const field = { elementToken: "snapshot:search", label: "Search", role: "Edit", enabled: true,
    actions: ["set_value"], frame: { x: 0, y: 0, w: 1920, h: 1080 } };
  const backgroundError = new Error("Background delivery is not available for target window class 'Chrome_WidgetWin_1' on this event kind (text_input).");
  const driver = createCuaStageDriver({ stage: stageDependencies(root), ownerPointer: {
    get: async () => ({ x: 100, y: 100 }), restore: async () => undefined,
  }, loadSdk: async () => makeSdk({ testRoot: root, calls,
    callToolErrors: { set_value: backgroundError },
    typeTextErrors: [backgroundError],
    state: { pid: 4321, windowId: BigInt(12345), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 0, y: 0, width: 1920, height: 1080 }, elements: [field],
      images: [{ mimeType: "image/png", dataBase64: imageData }] },
  }) as never });
  // Background mode now tries the WM_CHAR channel (sendTextToWindow) before giving up; force
  // that to fail too, so this still exercises the true "nothing works" fail-closed case.
  setNativeFixture(root, { responses: { sendTextToWindow: { ok: false, dispatchState: "not-dispatched",
    error: "Windows declined to queue a WM_CHAR message for the target window." } } });
  await assert.rejects(driver.typeText("stage", "Strawberry Park latest video", undefined, { deliveryMode: "background" }),
    error => error instanceof DesktopInputNotDispatchedError && error.code === "native-dispatch-unavailable");
  assert.equal(nativeFixture(root).calls.some((call) => ["bringToForeground", "sendText"].includes(String(call.op))), false);
  assert.equal(calls.some((call) => ["bring_to_front", "typeText"].includes(call.method)), false);
  await driver.shutdown();
}));

test("owner-preview scroll and drag use the exact window under the cursor", async () => withRoot(async (root) => {
  await registerOwnerPreview(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls,
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

  assert.ok(nativeFixture(root).calls.some((call) => call.op === "sendScroll" && call.pid === 4321));
  assert.ok(nativeFixture(root).calls.some((call) => call.op === "sendDrag" && call.pid === 4321));
  assert.equal(calls.some((call) => ["scroll", "drag", "capturedPosition"].includes(call.method)), false);
  await driver.shutdown();
}));

test("refuses to move the ghost cursor when the stage frame has no screen bounds", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const stage = stageDependencies(root);
  const baseInvoke = stage.invokeNative!;
  stage.invokeNative = async (request) => request.op === "windowRect"
    ? { ok: true, rect: { x: 100, y: 50, width: 0, height: 200 } }
    : baseInvoke(request);
  const driver = createCuaStageDriver({
    stage,
    loadSdk: async () => makeSdk({ testRoot: root, calls, state: {
      pid: 4321,
      windowId: BigInt(windowId),
      screenshotFrameValid: true,
      screenshotWidth: 200,
      screenshotHeight: 100,
      images: [{ mimeType: "image/png", dataBase64: imageData }],
    } }) as never,
  });

  await assert.rejects(() => driver.moveCursor("stage", 42, 24, { handle: "codex", sessionId: "no-bounds" }));
  assert.equal(calls.some((call) => call.method === "setAgentCursorEnabled" || call.method === "moveCursor"), false);
  await driver.shutdown();
}));

test("shows a distinct agent label on each native cursor and configures adaptive motion", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });
  const identities = [
    { handle: "codex", sessionId: "codex-session-a" },
    { handle: "claude-code", sessionId: "claude-session-b" },
  ] as const;

  for (const identity of identities) {
    await driver.showAgentCursor("stage", identity);
    await driver.moveCursor("stage", 42, 24, identity);
  }

  const sessionStarts = calls.filter((call) => call.method === "startSession").map((call) => call.value as { session: string; cursorMotion?: Record<string, unknown> });
  const sessions = sessionStarts.map(({ session }) => session);
  assert.equal(new Set(sessions).size, 2, "each verified agent session gets a separate Cua overlay identity");
  assert.deepEqual(sessions, ["Codex", "Claude"], "the visible Cua label contains only the provider name; internal session identity stays private");
  assert.ok(sessions.every((session) => session.length <= 28), "the provider label fits Cua's visible badge limit");
  assert.deepEqual(sessionStarts.map(({ cursorMotion }) => cursorMotion), sessions.map(() => ({
    style: 4,
    timing: 0,
    glideDurationMs: 140,
    effects: { trail: true, glow: true },
    dwellAfterClickMs: 80,
    idleHideMs: 0,
  })));
  assert.equal(calls.filter((call) => call.method === "setAgentCursorMotion").length, 0,
    "the persistent cursor policy is applied atomically during session start");
  assert.equal(calls.filter((call) => call.method === "moveCursor").length, 4,
    "each agent cursor is primed in its target window and follows its requested point");
  assert.equal(calls.some((call) => call.method === "callTool"), false, "the exact-window cursor API is used for app windows");
  assert.equal(calls.some((call) => ["click", "typeText", "pressKey", "hotkey", "scroll", "drag"].includes(call.method)), false);
  for (const identity of identities) await driver.closeAgentCursor(identity);
}));

test("reapplies the never-hide cursor setting after an idle session refresh", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  let at = new Date("2026-11-05T12:00:00.000Z");
  const driver = createCuaStageDriver({ stage: stageDependencies(root), now: () => at,
    loadSdk: async () => makeSdk({ testRoot: root, calls }) as never,
  });
  const identity = { handle: "codex", sessionId: "cursor-never-hide-refresh" };
  await driver.showAgentCursor("stage", identity);
  at = new Date(at.getTime() + 60_001);
  await driver.showAgentCursor("stage", identity);
  const settings = calls.filter((call) => call.method === "startSession")
    .map((call) => (call.value as { cursorMotion?: { idleHideMs?: number } }).cursorMotion);
  assert.equal(settings.length, 2, "a refreshed CUA session must reassert cursor visibility policy");
  assert.ok(settings.every((setting) => setting?.idleHideMs === 0), "idleHideMs=0 means the overlay remains visible during long task pauses");
  await driver.shutdown();
}));

test("primes an idle agent cursor inside the current foreground window without moving the owner pointer", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });
  await driver.showAgentCursor("stage", { handle: "codex", sessionId: "cursor-starts-on-window" });

  const initialMove = calls.find((call) => call.method === "moveCursor")?.value as { x?: number; y?: number; target?: { input?: unknown }; session?: string };
  assert.deepEqual({ x: initialMove?.x, y: initialMove?.y, target: initialMove?.target?.input, session: initialMove?.session },
    { x: 20, y: 10, target: { pid: 4321, windowId: BigInt(windowId) }, session: "Codex" },
    "the idle marker starts inside the verified foreground window in Cua screenshot coordinates");
  assert.equal(nativeFixture(root).calls.some((call) => ["sendClick", "sendDrag", "restoreCursorPosition"].includes(String(call.op))), false,
    "priming an overlay never moves or restores the owner's physical pointer");
  await driver.shutdown();
}));

test("coalesces delayed cursor moves to the latest target while native actions continue", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  let releaseFirstMove!: () => void;
  let announceFirstMove!: () => void;
  let announceLatestMove!: () => void;
  const firstMoveStarted = new Promise<void>((resolve) => { announceFirstMove = resolve; });
  const latestMoveStarted = new Promise<void>((resolve) => { announceLatestMove = resolve; });
  const firstMoveGate = new Promise<void>((resolve) => { releaseFirstMove = resolve; });
  let moveCount = 0;
  const timings: Array<{ phase: string; status: string; detail?: string }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), onTiming: (event) => timings.push(event),
    loadSdk: async () => makeSdk({ testRoot: root, calls, moveCursorBarrier: async (input) => {
      const x = (input as { x?: number }).x;
      if (x === 10 || x === 30) {
        moveCount += 1;
        if (moveCount === 1) {
          announceFirstMove();
          await firstMoveGate;
        } else if (moveCount === 2) announceLatestMove();
      }
    } }) as never,
  });
  const identity = { handle: "codex", sessionId: "cursor-latest-target" };
  await driver.showAgentCursor("stage", identity);
  const firstClick = driver.click("stage", 20, 20, identity);
  await firstMoveStarted;
  const secondClick = driver.click("stage", 60, 60, identity);
  await secondClick;
  assert.equal(nativeFixture(root).calls.filter((call) => call.op === "sendClick").length, 2,
    "the second native action is not held behind a slow presentation move");

  releaseFirstMove();
  await latestMoveStarted;
  await firstClick;
  const moves = calls.filter((call) => call.method === "moveCursor").slice(-2).map((call) => {
    const value = call.value as { x: number; y: number };
    return { x: value.x, y: value.y };
  });
  assert.deepEqual(moves, [{ x: 10, y: 10 }, { x: 30, y: 30 }], "only the latest queued presentation target follows the in-flight move");
  assert.ok(timings.some((event) => event.phase === "cursor-position" && event.status === "error"
    && event.detail?.includes("presentation=timed-out")), "a cursor move that misses the action budget is recorded as unaligned");
  await driver.shutdown();
}));

test("owner desktop capture does not use legacy capture-scope session escalation", async () => withRoot(async (root) => {
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await registerOwnerPreview(root, identity);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root,
      calls,
      sessionStateError: new Error("session has no capture policy; call start_session first"),
      escalationError: new Error("legacy capture-scope escalation is unavailable for this session"),
    }) as never,
  });

  const capture = await driver.captureDesktop("preview", identity);

  assert.equal(capture.width, 1920);
  assert.equal(capture.height, 1080);
  assert.equal(calls.some((call) => ["startSession", "getDesktopState", "getSessionState", "escalateSession"].includes(call.method)), false,
    "native desktop capture does not start or depend on the cursor presentation adapter");
  await driver.shutdown();
}));

test("warm native actions do not depend on a compositor probe or start a CUA app-input session", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  let at = Date.now();
  let loads = 0;
  const driver = createCuaStageDriver({ stage: stageDependencies(root), now: () => new Date(at),
    loadSdk: async () => { loads++; return makeSdk({ testRoot: root, calls, cursorVisible: false }) as never; } });
  const identity = { handle: "codex", sessionId: "warm-runtime" };
  await driver.click("stage", 42, 24, identity);
  await driver.click("stage", 42, 24, identity);
  assert.equal(loads, 1);
  assert.equal(calls.filter((c) => c.method === "startSession").length, 0);
  assert.equal(calls.filter((c) => c.method === "setAgentCursorMotion").length, 0);
  assert.equal(calls.filter((c) => c.method === "getSession" || c.method === "getAgentCursorState").length, 0);
  assert.equal(calls.filter((c) => c.method === "click").length, 0, "native input does not use the overlay adapter");
  assert.equal(nativeFixture(root).calls.filter((c) => c.op === "sendClick").length, 2,
    "native clicks continue when no overlay session is present");
  at += 60_001;
  await driver.capture("stage", identity);
  assert.equal(calls.filter((c) => c.method === "startSession").length, 0, "native observation does not require an overlay session");
  await driver.shutdown();
}));

test("parallel identities from the same provider get distinct native sessions without exposing identity digests", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });
  const identities = [{ handle: "codex", sessionId: "one" }, { handle: "codex", sessionId: "two" }];
  await Promise.all(identities.map((identity) => driver.showAgentCursor("stage", identity)));
  const labels = calls.filter((call) => call.method === "startSession").map((call) => (call.value as { session: string }).session);
  assert.deepEqual(labels, ["Codex", "Codex 2"]);
  await driver.closeAgentCursor(identities[1]!);
  assert.equal((calls.filter((call) => call.method === "endSession").at(-1)?.value as { session: string }).session, "Codex 2");
  await driver.shutdown();
}));

test("refuses out-of-bounds cursor input before enabling or moving the ghost cursor", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls }) as never,
  });

  await assert.rejects(() => driver.moveCursor("stage", 200, 24), /inside the current stage window snapshot/);
  assert.equal(calls.some((call) => call.method === "setAgentCursorEnabled" || call.method === "moveCursor"), false);
  assert.equal(calls.some((call) => call.method === "shutdown"), false, "rejecting a local coordinate does not need an overlay process");
}));

test("does not report an agent cursor move as successful when the OS overlay is absent", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls, cursorVisible: false }) as never });
  const result = await driver.showAgentCursor("stage", { handle: "codex", sessionId: "overlay-missing" });
  assert.equal(result.visible, false, "a missing visual overlay is reported honestly without blocking native task actions");
  await driver.shutdown();
}));

test("accepts a cursor overlay that becomes visible during the bounded compositor poll", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    cursorVisiblePoll: { attempts: 6, intervalMs: 1 },
    loadSdk: async () => makeSdk({ testRoot: root, calls, cursorVisibleSequence: [false, false, true] }) as never,
  });
  const result = await driver.showAgentCursor("stage", { handle: "codex", sessionId: "overlay-delayed" });
  assert.equal(result.visible, true);
  assert.equal(calls.filter((call) => call.method === "getSession").length, 3);
  await driver.shutdown();
}));

test("fails closed after the bounded cursor visibility poll is exhausted", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    cursorVisiblePoll: { attempts: 3, intervalMs: 1 },
    loadSdk: async () => makeSdk({ testRoot: root, calls, cursorVisible: false }) as never,
  });
  const result = await driver.showAgentCursor("stage", { handle: "codex", sessionId: "overlay-timeout" });
  assert.equal(result.visible, false, "an exhausted visibility poll is not a successful visual confirmation");
  assert.equal(calls.filter((call) => call.method === "getSession").length, 3);
  await driver.shutdown();
}));

test("records compositor visibility as a separate privacy-safe timing phase", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const timings: Array<{ phase: string; status: string; durationMs: number; stageName?: string; detail?: string }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    onTiming: (event) => timings.push(event),
    loadSdk: async () => makeSdk({ testRoot: root, calls, cursorVisible: false }) as never,
  });
  const result = await driver.showAgentCursor!("stage", { handle: "codex", sessionId: "overlay-diagnostic" });
  assert.equal(result.visible, false);
  const visibility = timings.find((event) => event.phase === "cursor-visible");
  assert.deepEqual(visibility && { phase: visibility.phase, status: visibility.status, stageName: visibility.stageName }, {
    phase: "cursor-visible", status: "error", stageName: "stage",
  });
  assert.equal(typeof visibility?.durationMs, "number");
  assert.match(visibility?.detail ?? "", /^attempts=6;maxAttempts=6;intervalMs=150$/);
  await driver.shutdown();
}));

test("a missing overlay never replaces the shared input runtime", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  let loads = 0;
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    cursorVisiblePoll: { attempts: 2, intervalMs: 1 },
    loadSdk: async () => {
      loads += 1;
      return makeSdk({ testRoot: root, calls, cursorVisible: loads > 1 }) as never;
    },
  });
  const result = await driver.showAgentCursor!("stage", { handle: "codex", sessionId: "overlay-recovered" });
  assert.equal(result.visible, false);
  assert.equal(loads, 1, "presentation cannot dispose another action's connection");
  await driver.shutdown();
}));

test("bounds cursor visibility poll configuration", () => {
  assert.throws(() => createCuaStageDriver({ cursorVisiblePoll: { attempts: 0, intervalMs: 1 } }), /cursor visibility poll/);
  assert.throws(() => createCuaStageDriver({ cursorVisiblePoll: { attempts: 21, intervalMs: 1 } }), /cursor visibility poll/);
  assert.throws(() => createCuaStageDriver({ cursorVisiblePoll: { attempts: 3, intervalMs: 5_000 } }), /cursor visibility poll/);
});

test("native capture ignores stale Cua snapshot metadata and stays bound to the registered HWND", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls, state: {
      pid: 9999,
      windowId: BigInt(windowId),
      screenshotFrameValid: true,
      screenshotWidth: 200,
      screenshotHeight: 100,
      images: [{ mimeType: "image/png", dataBase64: imageData }],
    } }) as never,
  });

  const capture = await driver.capture("stage");
  assert.equal(capture.width, 200);
  const native = nativeFixture(root).calls;
  assert.ok(native.some(call => call.op === "captureWindow" && call.pid === 4321 && call.windowId === windowId));
  assert.equal(calls.some((call) => call.method === "getWindowState"), false,
    "Cua snapshot metadata cannot retarget or veto native capture");
  await driver.shutdown();
}));

test("lists only eligible visible app windows from the native inventory", async () => withRoot(async (root) => {
  await registerStage(root);
  const nativeOps: string[] = [];
  const windows = [
    { pid: 4321, windowId: "101", processName: "notepad.exe", className: "Notepad", title: "C5 fixture", x: 10, y: 20, width: 800, height: 600, zOrder: 0 },
    { pid: process.pid, windowId: "104", processName: "m9r.exe", className: "M9R", title: "Agent child", x: 0, y: 0, width: 800, height: 600, zOrder: 1 },
    { pid: 4321, windowId: "105", processName: "m9r-overlay.exe", className: "M9ROverlay", title: "Overlay", x: 0, y: 0, width: 800, height: 600, zOrder: 2 },
    { pid: 4321, windowId: "107", processName: "pill-shell.exe", className: "M9R", title: "M9R", x: 0, y: 0, width: 800, height: 600, zOrder: 3 },
    { pid: 7777, windowId: "106", processName: "browser.exe", className: "Chrome_WidgetWin_1", title: "A\nprivate title", x: 0, y: 0, width: 900, height: 700, zOrder: 4 },
  ];
  const driver = createCuaStageDriver({ stage: { ...stageDependencies(root), invokeNative: async (request) => {
    nativeOps.push(String(request.op));
    if (request.op === "listVisibleWindows") return { ok: true, windows };
    if (request.op === "inspect") return { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId) } };
    throw new Error(`Unexpected native operation: ${String(request.op)}`);
  } }, skipNativeFixturePreload: true, loadSdk: async () => { throw new Error("window inventory must not use Cua Driver"); } });
  const options = await driver.listWindows("stage");
  assert.deepEqual(options, [
    { pid: 4321, windowId: "101", appName: "notepad.exe", title: "C5 fixture", width: 800, height: 600, isOnScreen: true, minimized: false, zIndex: "0" },
    { pid: 7777, windowId: "106", appName: "browser.exe", title: "A private title", width: 900, height: 700, isOnScreen: true, minimized: false, zIndex: "4" },
  ]);
  assert.equal(nativeOps.includes("listVisibleWindows"), true);
  const all = await driver.listVisibleWindows({ onScreenOnly: false });
  assert.equal(all.some((window) => window.windowId === "102"), false, "hidden windows never enter owner-visible discovery");
  await driver.shutdown();
}));

test("window discovery reads the native owner inventory without starting the cursor runtime or silently capping windows", async () => withRoot(async (root) => {
  const calls: string[] = [];
  const windows = Array.from({ length: 300 }, (_, index) => ({
    pid: 500_000 + index,
    windowId: String(10_000 + index),
    title: `Document ${index}`,
    width: 900,
    height: 700,
    zOrder: index,
    className: "Chrome_WidgetWin_1",
    processName: "chrome.exe",
  }));
  const driver = createCuaStageDriver({
    stage: { ...stageDependencies(root), invokeNative: async (request) => {
      calls.push(String(request.op));
      if (request.op === "listVisibleWindows") return { ok: true, windows };
      throw new Error(`Unexpected native operation: ${String(request.op)}`);
    } },
    skipNativeFixturePreload: true,
    loadSdk: async () => { throw new Error("window discovery must not start the cursor overlay runtime"); },
  });
  const listed = await driver.listVisibleWindows();
  assert.equal(listed.length, windows.length);
  assert.equal(calls.includes("listVisibleWindows"), true);
  assert.equal(calls.some((op) => ["currentDesktop", "createDesktop", "inspectDesktop", "activateDesktop", "moveWindowToDesktop"].includes(op)), false,
    "inventory reads do not depend on Windows desktop identity or switching");
  await driver.shutdown();
}));

test("targets click at exact window-local coordinates through native foreground input", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });
  const proof = await driver.click("stage", 42, 24);
  assert.equal(proof.outcome.status, "unverified");
  assert.equal(proof.capture.width, 200);
  const click = nativeFixture(root).calls.find((call) => call.op === "sendClick");
  assert.equal(click?.pid, 4321);
  assert.equal(click?.windowId, windowId);
  assert.equal(click?.x, 142);
  assert.equal(click?.y, 74);
  assert.equal(calls.some((call) => call.method === "click"), false, "app input does not pass through Cua Driver");
}));

test("click uses native exact-window point targeting when no semantic target is named", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true,
    screenshotWidth: 200, screenshotHeight: 100, windowBounds: { x: 0, y: 0, width: 200, height: 100 }, images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: [
      { elementToken: "root", frame: { x: 0, y: 0, w: 200, h: 100 } },
      { elementToken: "disabled", enabled: false, frame: { x: 40, y: 20, w: 5, h: 5 } },
      { elementToken: "button", frame: { x: 20, y: 10, w: 70, h: 30 } },
    ] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls, state }) as never });
  await driver.click("stage", 42, 24);
  const native = nativeFixture(root).calls;
  assert.ok(native.some((call) => call.op === "sendClick"), "unnamed UIA nodes remain reachable through the exact native point");
  assert.equal(calls.some((call) => call.method === "click"), false);
}));

test("native input dispatch uses exact HWND SendInput primitives instead of Cua action calls", async () => withRoot(async (root) => {
  await registerStage(root);
  const nativeCalls: Record<string, unknown>[] = [];
  const base = stageDependencies(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: { ...base, invokeNative: async (request) => {
    if (["bringToForeground", "sendClick", "sendText", "sendScroll"].includes(String(request.op))) nativeCalls.push(request);
    return base.invokeNative!(request);
  } }, loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });
  await driver.click("stage", 42, 24);
  await driver.typeText("stage", "hello");
  await driver.scroll("stage", 42, 24, "down");
  const dispatched = nativeCalls.filter((call) => ["sendClick", "sendText", "sendScroll"].includes(String(call.op)));
  assert.deepEqual(dispatched.map((call) => call.op), ["sendClick", "sendText", "sendScroll"]);
  for (const call of dispatched) {
    assert.equal(call.pid, 4321);
    assert.equal(call.windowId, windowId);
    assert.equal("desktopId" in call, false, "OS desktop identity is not part of native HWND dispatch");
  }
  assert.equal(calls.some((call) => ["click", "typeText", "scroll"].includes(call.method)), false);
}));

test("desktop coordinate clicks use UIA ElementFromPoint for overlapping controls, not the smallest tree rectangle", async () => withRoot(async (root) => {
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await registerOwnerPreview(root, identity);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const control = { label: "Video player", pid: 4321, windowId, windowPid: 4321,
    rect: { x: 80, y: 30, width: 500, height: 300 }, invoked: false };
  const fixture = nativeFixture(root);
  fixture.responses = {
    inspectPointControl: { ok: true, control },
    invokePointControl: { ok: true, control: { ...control, invoked: true, confirmed: true } },
  };
  const windows = [{ pid: 4321, windowId: BigInt(windowId), processName: "chrome.exe", title: "Video",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }];
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 0, y: 0, width: 1920, height: 1080 }, images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: [
      { elementToken: "video", label: "Video player", role: "Pane", enabled: true, frame: { x: 20, y: 10, w: 160, h: 80 } },
      { elementToken: "suggestion", label: "Search suggestion", role: "ListItem", enabled: true, frame: { x: 80, y: 30, w: 40, h: 20 } },
    ] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls, windows, state }) as never });

  await driver.captureDesktop("preview", identity);
  const result = await driver.clickDesktop("preview", 100, 50, identity);
  assert.equal(result.outcome.status, "unverified");
  const invoke = fixture.calls.find((call) => call.op === "invokePointControl");
  assert.equal(invoke?.label, "Video player", "the native point hit-test, not overlapping rectangle area, chooses the semantic control");
  assert.equal(fixture.calls.some((call) => call.op === "inspectWindowStructure"), false,
    "coordinate dispatch does not walk the full UIA tree to guess the target");
  assert.equal(fixture.calls.some((call) => call.op === "sendClick"), false,
    "the exact accessible control is invoked headlessly when UIA can name it");
  assert.equal(calls.some((call) => call.method === "callTool"), false, "the cursor overlay is not an input transport");
  await driver.shutdown();
}));

test("types bounded text through native input to the exact focused window without echoing it in the result", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const secretLikeText = "local-only fixture text";
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });
  const proof = await driver.typeText("stage", secretLikeText);
  const request = nativeFixture(root).calls.find((call) => call.op === "sendText");
  assert.equal(request?.text, secretLikeText);
  assert.equal(request?.pid, 4321);
  assert.equal(request?.windowId, windowId);
  assert.equal(proof.outcome.status, "unverified");
  assert.doesNotMatch(JSON.stringify(proof), /local-only fixture text/);
  assert.equal(calls.some((call) => call.method === "typeText"), false);
  await assert.rejects(() => driver.typeText("stage", ""), /1–5000 characters/);
  await assert.rejects(() => driver.typeText("stage", "x".repeat(5001)), /1–5000 characters/);
}));

test("scroll and drag use native screen coordinates and validate bounds before dispatch", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });
  await driver.scroll("stage", 42, 24, "down");
  const native = nativeFixture(root).calls;
  const scroll = native.find((call) => call.op === "sendScroll");
  assert.equal(scroll?.x, 142);
  assert.equal(scroll?.y, 74);
  assert.equal(scroll?.amount, -3);
  assert.equal(scroll?.pid, 4321);
  assert.equal(scroll?.windowId, windowId);
  const identity = { handle: "codex", sessionId: "window-drag-cursor" };
  await driver.showAgentCursor("stage", identity);
  await driver.drag("stage", 10, 20, 100, 80, identity);
  const drag = native.find((call) => call.op === "sendDrag");
  assert.deepEqual({ fromX: drag?.fromX, fromY: drag?.fromY, toX: drag?.toX, toY: drag?.toY },
    { fromX: 110, fromY: 70, toX: 200, toY: 130 });
  assert.equal(drag?.pid, 4321);
  assert.equal(drag?.windowId, windowId);
  assert.deepEqual(calls.filter((call) => call.method === "moveCursor").map((call) => (call.value as { x: number; y: number }).x), [20, 5, 50],
    "the presentation cursor follows the registered-window drag from its grab point to its drop point");
  const callsBeforeInvalid = native.filter((call) => call.op === "sendDrag").length;
  await assert.rejects(() => driver.drag("stage", 10, 20, 200, 80, identity), /Both drag points must fall inside/);
  assert.equal(native.filter((call) => call.op === "sendDrag").length, callsBeforeInvalid);
  assert.equal(calls.some((call) => ["scroll", "drag"].includes(call.method)), false);
}));

test("a clean native input refusal is typed as not dispatched", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  setNativeFixture(root, { responses: { sendClick: { ok: false, dispatchState: "not-dispatched", error: "OS rejected test click" } } });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });
  await assert.rejects(() => driver.click("stage", 42, 24), error =>
    error instanceof DesktopInputNotDispatchedError && error.code === "native-dispatch-unavailable");
  assert.equal(calls.some((call) => call.method === "click"), false);
}));

test("a native input failure without dispatch certainty is typed uncertain and is not replayed", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  setNativeFixture(root, { responses: { sendClick: { ok: false, error: "helper disconnected during SendInput" } } });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });
  await assert.rejects(driver.click("stage", 42, 24), (error: unknown) =>
    error instanceof DesktopInputOutcomeUnknownError);
  assert.equal(nativeFixture(root).calls.filter(call => call.op === "sendClick").length, 1,
    "uncertain OS delivery is observed rather than replayed");
  assert.equal(calls.some((call) => call.method === "click"), false);
}));

test("describeTarget reports the exact native point-control label for the money gate", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true,
    screenshotWidth: 200, screenshotHeight: 100, windowBounds: { x: 0, y: 0, width: 200, height: 100 },
    images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: [
      { frame: { x: 0, y: 0, w: 200, h: 100 } },
      { elementToken: "pay", label: "Pay $49 now", role: "button", frame: { x: 20, y: 10, w: 70, h: 30 } },
    ] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls, state }) as never });
  assert.deepEqual(await driver.describeTarget("stage", 42, 24),
    { label: "Pay $49 now", rect: { x: 20, y: 10, width: 70, height: 30 } });
  assert.equal(await driver.describeTarget("stage", 199, 99), undefined, "a point with no named native control describes nothing");
  await assert.rejects(() => driver.describeTarget("stage", 200, 24), /inside the current stage window snapshot/);
  assert.equal(calls.some((call) => ["click", "typeText", "scroll", "drag"].includes(call.method)), false, "describing never acts");
}));

test("native UI Automation click dispatch is headless and reports verification separately", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls, state: { elements: [{ role: "Button", label: "Open", enabled: true,
      actions: ["invoke"], frame: { x: 120, y: 58, w: 60, h: 24 } }] } }) as never });

  const result = await driver.click("stage", 20, 10, undefined, { deliveryMode: "background" });
  assert.equal(result.outcome.status, "unverified");
  assert.match(result.outcome.summary ?? "", /Native UI Automation activated/);
  assert.equal(nativeFixture(root).calls.filter(call => call.op === "invokePointControl").length, 1);
  assert.equal(nativeFixture(root).calls.some(call => ["bringToForeground", "sendClick"].includes(String(call.op))), false);
  assert.equal(calls.some(call => ["click", "callTool"].includes(call.method)), false,
    "the overlay SDK does not dispatch app input");
  await driver.shutdown();
}));

test("explicit background click never falls through to foreground input", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });

  await assert.rejects(() => driver.click("stage", 42, 24, undefined, { deliveryMode: "background" }),
    error => error instanceof DesktopInputNotDispatchedError && error.code === "background-unavailable");
  assert.equal(nativeFixture(root).calls.some(call => ["bringToForeground", "sendClick"].includes(String(call.op))), false);
  assert.equal(calls.some(call => call.method === "click"), false);
  await driver.shutdown();
}));

test("owner-preview click uses the native foreground lease when no semantic action exists", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });

  const result = await driver.click("stage", 42, 24);
  assert.equal(result.outcome.status, "unverified");
  assert.equal(nativeFixture(root).calls.filter(call => call.op === "bringToForeground").length, 1);
  assert.equal(nativeFixture(root).calls.filter(call => call.op === "sendClick").length, 1);
  assert.equal(calls.some(call => call.method === "click"), false);
  await driver.shutdown();
}));

test("an exact UIA ref with no advertised activation pattern still uses native point-click fallback", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls, state: { elements: [{ role: "Button", label: "Open item",
      className: "CustomControl", automationId: "open-item", enabled: true, actions: ["focus"],
      frame: { x: 120, y: 70, w: 60, h: 24 } }] } }) as never });

  const observation = await driver.readStructure("stage");
  const result = await driver.clickElement("stage", observation.elements[0]!.ref, undefined,
    { expectedRole: "Button", expectedLabel: "Open item" });
  assert.equal(result.outcome.status, "unverified");
  const native = nativeFixture(root).calls;
  assert.ok(native.some(call => call.op === "invokeWindowElement"), "M9R tries the semantic route first");
  assert.ok(native.some(call => call.op === "sendClick"), "unsupported UIA patterns do not veto a physical click on the exact live point");
  assert.equal(calls.some(call => call.method === "click"), false, "the native fallback does not route through Cua input dispatch");
  await driver.shutdown();
}));

test("UIA scroll-container refs expose progress and move one headless increment with post-action evidence", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls, state: { elements: [{ role: "List", label: "Installed apps",
      className: "ItemsView", automationId: "InstalledAppsList", enabled: true, actions: ["scroll"],
      scroll: { horizontal: { scrollable: false, percent: null, viewSize: null },
        vertical: { scrollable: true, percent: 20, viewSize: 35 } },
      frame: { x: 120, y: 70, w: 400, h: 300 } }] } }) as never });

  const observation = await driver.readStructure("stage");
  assert.equal(observation.elements[0]?.actions?.includes("scroll"), true);
  assert.equal(observation.elements[0]?.scroll?.vertical.percent, 20);
  const result = await driver.scrollElement("stage", observation.elements[0]!.ref, "down");
  assert.equal(result.outcome.status, "confirmed");
  assert.match(result.outcome.summary ?? "", /one small down increment; position 25\.0%/);
  const native = nativeFixture(root).calls;
  const request = native.find((call) => call.op === "invokeWindowElement" && call.action === "scroll");
  assert.equal(request?.direction, "down");
  assert.equal(request?.granularity, "small");
  assert.equal(native.some((call) => ["bringToForeground", "sendScroll"].includes(String(call.op))), false,
    "the semantic ScrollPattern route does not touch the physical pointer or target focus");
  await driver.shutdown();
}));

test("scroll-element fallback is one observed wheel notch when UIA has no ScrollPattern", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls, state: { elements: [{ role: "Pane", label: "Custom list",
      className: "CustomList", enabled: true, actions: ["focus"], frame: { x: 120, y: 70, w: 80, h: 60 } }] } }) as never });

  const observation = await driver.readStructure("stage");
  const result = await driver.scrollElement("stage", observation.elements[0]!.ref, "down");
  assert.equal(result.outcome.status, "unverified");
  const native = nativeFixture(root).calls;
  const wheel = native.find((call) => call.op === "sendScroll");
  assert.equal(wheel?.amount, -1);
  assert.equal(native.filter((call) => call.op === "sendScroll").length, 1);
  await driver.shutdown();
}));

test("a UIA scroll request with no progress is reported as partial and is not replayed through wheel input", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls, state: { scrollBeforePercent: 100, scrollAfterPercent: 100, scrollMoved: false,
      elements: [{ role: "List", label: "Installed apps", className: "ItemsView", enabled: true, actions: ["scroll"],
        scroll: { horizontal: { scrollable: false, percent: null, viewSize: null },
          vertical: { scrollable: true, percent: 100, viewSize: 35 } }, frame: { x: 120, y: 70, w: 80, h: 60 } }] } }) as never });

  const observation = await driver.readStructure("stage");
  const result = await driver.scrollElement("stage", observation.elements[0]!.ref, "down");
  assert.equal(result.outcome.status, "partial");
  assert.match(result.outcome.summary ?? "", /no position change/);
  const native = nativeFixture(root).calls;
  assert.equal(native.filter((call) => call.op === "invokeWindowElement" && call.action === "scroll").length, 1);
  assert.equal(native.some((call) => call.op === "sendScroll"), false,
    "an accepted semantic request that reports no progress is reconciled, never blindly replayed through wheel input");
  await driver.shutdown();
}));

test("a missing cursor overlay never blocks native click dispatch", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const identity = { handle: "codex", sessionId: "desktop-session" };
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });

  const result = await driver.click("stage", 42, 24, identity);
  assert.equal(result.outcome.status, "unverified");
  assert.equal(nativeFixture(root).calls.filter(call => call.op === "sendClick").length, 1);
  assert.equal(calls.some(call => call.method === "click"), false);
  await driver.shutdown();
}));

test("replace-mode text uses exact UI Automation ValuePattern before physical fallback", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ testRoot: root, calls, state: { elements: [{ role: "Edit", label: "Search", enabled: true,
      actions: ["set_value"], frame: { x: 120, y: 58, w: 120, h: 30 } }] } }) as never });

  const result = await driver.typeText("stage", "new value", undefined, { mode: "replace", x: 20, y: 10 });
  assert.equal(result.outcome.status, "unverified");
  const invoke = nativeFixture(root).calls.find(call => call.op === "invokeWindowElement") as Record<string, unknown> | undefined;
  assert.equal(invoke?.action, "setValue");
  assert.equal(invoke?.text, "new value");
  assert.equal(nativeFixture(root).calls.some(call => ["bringToForeground", "sendClick", "sendKeyCombo", "sendText"].includes(String(call.op))), false);
  await driver.shutdown();
}));

test("an independently fenced field refuses recreated UIA identity and never uses caret fallback", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const field = { role: "Edit", label: "Title", className: "Edit", automationId: "Title", runtimeId: [42, 1], enabled: true,
    actions: ["set_value"], frame: { x: 120, y: 58, w: 120, h: 30 } };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls,
    state: { elementsComplete: true, elements: [field] } }) as never });
  const observed = await driver.readStructure("stage");
  field.runtimeId = [42, 2];
  await assert.rejects(driver.replaceElement("stage", observed.elements[0]!.ref, "wrong epoch", undefined, { semanticOnly: true }),
    error => error instanceof DesktopInputNotDispatchedError);
  assert.equal(nativeFixture(root).calls.some(call => call.op === "invokeWindowElement"), false);
  const fresh = await driver.readStructure("stage");
  setNativeFixture(root, { responses: { invokeWindowElement: { ok: true, semanticAction: { dispatched: false, reason: "provider no longer supports value replacement" } } } });
  await assert.rejects(driver.replaceElement("stage", fresh.elements[0]!.ref, "no fallback", undefined, { semanticOnly: true }),
    error => error instanceof DesktopInputNotDispatchedError);
  assert.equal(nativeFixture(root).calls.some(call => ["bringToForeground", "sendClick", "sendKeyCombo", "sendText"].includes(String(call.op))), false);
  await driver.shutdown();
}));

test("popup replace mode resolves the exact enabled UIA edit and sets its value on the popup HWND", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const popupWindows = [
    { pid: 4321, windowId: BigInt(windowId), title: "Editor", appName: "editor.exe", bounds: { x: 100, y: 50, width: 600, height: 400 }, isOnScreen: true },
    { pid: 4321, windowId: BigInt("1234"), title: "Save As", appName: "editor.exe", bounds: { x: 300, y: 200, width: 400, height: 300 }, isOnScreen: true },
  ];
  const popupElements = [{ role: "Edit", label: "File name", className: "Edit", automationId: "FileName", enabled: true,
    actions: ["set_value"], frame: { x: 320, y: 250, width: 220, height: 24 } }];
  setNativeFixture(root, {
    windows: popupWindows,
    responses: { listOwnedPopups: { ok: true, windows: [{ pid: 4321, windowId: "1234" }] } },
    state: { elements: popupElements },
  });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls,
    state: { elements: popupElements }, windows: popupWindows }) as never });

  const observed = await driver.capturePopup("stage");
  assert.equal(observed.controls?.some((control) => control.role === "Edit" && control.label === "File name"), true,
    "the popup screenshot is accompanied by its accessible field labels and coordinates");
  const result = await driver.typeTextPopup("stage", "M9R-demo-smoke.txt", { mode: "replace", x: 70, y: 60,
    expectedRole: "Edit", expectedLabel: "File name", deliveryMode: "owner-preview" });
  assert.equal(result.outcome.status, "unverified", "ValuePattern delivery is not mistaken for a saved-file effect");
  const native = nativeFixture(root).calls;
  const invoke = native.find((call) => call.op === "invokeWindowElement") as Record<string, unknown> | undefined;
  assert.equal(invoke?.windowId, "1234", "the live semantic action is scoped to the owned popup HWND");
  assert.equal(invoke?.action, "setValue");
  assert.equal(invoke?.text, "M9R-demo-smoke.txt");
  assert.equal(native.some((call) => ["sendClick", "sendKeyCombo", "sendText"].includes(String(call.op))), false,
    "the accessible filename field uses UIA ValuePattern without unnecessary physical input");
  await driver.shutdown();
}));

test("generic Save As creates only the requested parent folder and verifies the exact persisted path without pointer input", async () => withRoot(async root => {
  await registerStage(root);
  const target = join(root, "M9R Benchmark", "F1-Run1", "house.png");
  const popup = { pid: 4321, windowId: "1234" };
  const noPopups = { ok: true, windows: [] };
  const elements = [
    { role: "Edit", label: "File name", className: "Edit", automationId: "FileName", enabled: true,
      actions: ["set_value"], rect: { x: 320, y: 250, width: 220, height: 24 } },
    { role: "Button", label: "&Save", className: "Button", automationId: "1", enabled: true,
      actions: ["invoke"], rect: { x: 500, y: 550, width: 80, height: 28 } },
  ];
  setNativeFixture(root, {
    windows: [
      { pid: 4321, windowId: BigInt(windowId), title: "Paint", appName: "mspaint.exe", bounds: { x: 100, y: 50, width: 600, height: 400 }, isOnScreen: true },
      { pid: 4321, windowId: BigInt(popup.windowId), title: "Save As", appName: "mspaint.exe", bounds: { x: 300, y: 200, width: 600, height: 400 }, isOnScreen: true },
    ],
    state: { elements, elementsComplete: true, windowBounds: { x: 100, y: 50, width: 600, height: 400 } },
    responseSequences: { listOwnedPopups: [
      { ok: true, windows: [popup] }, { ok: true, windows: [popup] }, { ok: true, windows: [popup] },
      noPopups, noPopups, noPopups,
    ] },
  });
  const base = stageDependencies(root);
  const deps = { ...base, invokeNative: async (request: Record<string, unknown>) => {
    const response = await base.invokeNative!(request);
    if (request.op === "invokeWindowElement" && request.action === "activate" && request.expectedLabel === "&Save") {
      mkdirSync(join(root, "M9R Benchmark", "F1-Run1"), { recursive: true });
      writeFileSync(target, "paint-bytes", { flag: "wx" });
    }
    return response;
  } };
  const driver = createCuaStageDriver({ stage: deps, loadSdk: async () => makeSdk({ testRoot: root, state: nativeFixture(root).state, calls: [] }) as never });
  const result = await driver.saveAs("stage", target, { createParentDirectories: true });
  assert.equal(result.saveAs?.path, target);
  assert.equal(result.saveAs?.directory, join(root, "M9R Benchmark", "F1-Run1"));
  assert.equal(result.saveAs?.fileName, "house.png");
  assert.equal(result.saveAs?.persisted, true, JSON.stringify(result.outcome));
  assert.equal(result.saveAs?.directoryCreated, true);
  assert.equal(readFileSync(target, "utf8"), "paint-bytes");
  const nativeCalls = nativeFixture(root).calls;
  const setValue = nativeCalls.find(call => call.op === "invokeWindowElement" && call.action === "setValue");
  assert.equal(setValue?.text, target, "the model supplies one absolute path; M9R owns exact path resolution");
  assert.equal(nativeCalls.some(call => ["bringToForeground", "sendClick", "sendKeyCombo", "sendText"].includes(String(call.op))), false,
    "the structured Save As operation uses exact UIA targets without moving the owner's cursor or taking focus");
  await driver.shutdown();
}));

test("generic Save As does not activate Save when the filename field fails exact value readback", async () => withRoot(async root => {
  await registerStage(root);
  const target = join(root, "folder", "requested.txt");
  const popup = { pid: 4321, windowId: "1234" };
  setNativeFixture(root, {
    windows: [
      { pid: 4321, windowId: BigInt(windowId), title: "Editor", appName: "editor.exe", bounds: { x: 100, y: 50, width: 600, height: 400 }, isOnScreen: true },
      { pid: 4321, windowId: BigInt(popup.windowId), title: "Save As", appName: "editor.exe", bounds: { x: 300, y: 200, width: 600, height: 400 }, isOnScreen: true },
    ],
    state: { elements: [
      { role: "Edit", label: "File name:", className: "Edit", automationId: "FileName", enabled: true, actions: ["set_value"] },
      { role: "Button", label: "&Save", className: "Button", automationId: "1", enabled: true, actions: ["invoke"] },
    ], elementsComplete: true, valueConfirmed: false, windowBounds: { x: 100, y: 50, width: 600, height: 400 } },
    responses: { listOwnedPopups: { ok: true, windows: [popup] } },
  });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, state: nativeFixture(root).state, calls: [] }) as never });
  const result = await driver.saveAs("stage", target, { createParentDirectories: true });
  assert.equal(result.saveAs?.persisted, false);
  assert.match(result.outcome.summary ?? "", /did not confirm the exact requested path/);
  assert.equal(nativeFixture(root).calls.some(call => call.op === "invokeWindowElement" && call.action === "activate"), false,
    "Save is never pressed when the live filename field did not confirm the requested absolute path");
  assert.equal(existsSync(target), false);
  await driver.shutdown();
}));

test("generic Save As preserves an existing exact destination unless replacement was authorized", async () => withRoot(async root => {
  await registerStage(root);
  const target = join(root, "existing.txt");
  writeFileSync(target, "keep-existing", { flag: "wx" });
  const popup = { pid: 4321, windowId: "1234" };
  const elements = [
    { role: "Edit", label: "File name", className: "Edit", automationId: "FileName", enabled: true, actions: ["set_value"] },
    { role: "Button", label: "Save", className: "Button", automationId: "1", enabled: true, actions: ["invoke"] },
  ];
  setNativeFixture(root, {
    windows: [
      { pid: 4321, windowId: BigInt(windowId), title: "Editor", appName: "editor.exe", bounds: { x: 100, y: 50, width: 600, height: 400 }, isOnScreen: true },
      { pid: 4321, windowId: BigInt(popup.windowId), title: "Save As", appName: "editor.exe", bounds: { x: 300, y: 200, width: 600, height: 400 }, isOnScreen: true },
    ],
    state: { elements, elementsComplete: true, windowBounds: { x: 100, y: 50, width: 600, height: 400 } },
    responses: { listOwnedPopups: { ok: true, windows: [popup] } },
  });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, state: nativeFixture(root).state, calls: [] }) as never });
  const result = await driver.saveAs("stage", target);
  assert.equal(result.saveAs?.persisted, false);
  assert.match(result.outcome.summary ?? "", /preserved because replacement was not authorized/);
  assert.equal(readFileSync(target, "utf8"), "keep-existing");
  assert.equal(nativeFixture(root).calls.some(call => call.op === "invokeWindowElement"), false,
    "no file-dialog value or button is touched before explicit overwrite authorization");
  await driver.shutdown();
}));

test("popup caret insertion sends native text to the selected popup window", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  setNativeFixture(root, {
    windows: [
      { pid: 4321, windowId: BigInt(windowId), title: "Editor", appName: "editor.exe", bounds: { x: 100, y: 50, width: 600, height: 400 }, isOnScreen: true },
      { pid: 4321, windowId: BigInt("1234"), title: "Save As", appName: "editor.exe", bounds: { x: 300, y: 200, width: 400, height: 300 }, isOnScreen: true },
    ],
    foregroundWindow: { pid: 4321, windowId: "1234", title: "Save As", className: "Dialog", visible: true, minimized: false },
    responses: { listOwnedPopups: { ok: true, windows: [{ pid: 4321, windowId: "1234" }] } },
  });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });

  const result = await driver.typeTextPopup("stage", "M9R-demo-smoke.txt", { mode: "insert", deliveryMode: "owner-preview" });
  assert.equal(result.outcome.foregroundConfirmed, true);
  assert.ok(nativeFixture(root).calls.some((call) => call.op === "sendText" && call.windowId === "1234"),
    "native text input carries the exact popup PID/HWND rather than the parent app identity");
  assert.equal(nativeFixture(root).calls.some((call) => call.op === "sendText" && call.windowId === windowId), false);
  await driver.shutdown();
}));

test("popup replacement reports a typed pre-dispatch refusal when its live UIA tree cannot be read", async () => withRoot(async root => {
  await registerStage(root);
  const popupWindows = [
    { pid: 4321, windowId: BigInt(windowId), title: "Editor", appName: "editor.exe", bounds: { x: 100, y: 50, width: 600, height: 400 }, isOnScreen: true },
    { pid: 4321, windowId: BigInt("1234"), title: "Save As", appName: "editor.exe", bounds: { x: 300, y: 200, width: 400, height: 300 }, isOnScreen: true },
  ];
  setNativeFixture(root, {
    windows: popupWindows,
    calls: [],
    responses: {
      listOwnedPopups: { ok: true, windows: [{ pid: 4321, windowId: "1234" }] },
      inspectWindowStructure: { ok: false, error: "Tree unavailable" },
    },
  });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, windows: popupWindows, calls: [] }) as never });

  await assert.rejects(() => driver.typeTextPopup("stage", "M9R-demo-smoke.txt", { mode: "replace", x: 70, y: 60 }),
    error => error instanceof DesktopInputNotDispatchedError && /no input was sent/i.test(error.message));
  assert.equal(nativeFixture(root).calls.some((call) => ["invokeWindowElement", "sendClick", "sendKeyCombo", "sendText"].includes(String(call.op))), false,
    "tree-read failure is reported before any semantic or physical input");
  await driver.shutdown();
}));

test("popup Enter that closes Save As keeps its dispatched receipt and refreshes the parent app", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const popupList = { ok: true, windows: [{ pid: 4321, windowId: "1234" }] };
  const noPopups = { ok: true, windows: [] };
  setNativeFixture(root, {
    windows: [
      { pid: 4321, windowId: BigInt(windowId), title: "Editor", appName: "editor.exe", bounds: { x: 100, y: 50, width: 600, height: 400 }, isOnScreen: true },
      { pid: 4321, windowId: BigInt("1234"), title: "Save As", appName: "editor.exe", bounds: { x: 300, y: 200, width: 400, height: 300 }, isOnScreen: true },
    ],
    foregroundWindow: { pid: 4321, windowId: "1234", title: "Save As", className: "Dialog", visible: true, minimized: false },
    responseSequences: { listOwnedPopups: [popupList, popupList, noPopups, noPopups] },
  });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });

  const result = await driver.pressKeyPopup("stage", "Enter", { deliveryMode: "owner-preview" });
  assert.equal(result.outcome.status, "unverified");
  assert.match(result.outcome.summary ?? "", /parent app and its current owned popups were recaptured/);
  assert.equal(nativeFixture(root).calls.filter((call) => call.op === "sendKeyCombo" && call.windowId === "1234").length, 1,
    "Enter is dispatched once to the modal");
  assert.equal(result.capture.ownedPopups?.length, 0, "the returned refreshed parent capture reflects the closed modal");
  assert.equal(result.capture.width, 600, "the fallback evidence is the parent app capture, not a false popup capture");
  await driver.shutdown();
}));

test("multiple owned popups resolve by foreground identity, not enumeration order", async () => withRoot(async root => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  setNativeFixture(root, {
    windows: [
      { pid: 4321, windowId: BigInt(windowId), title: "Editor", appName: "editor.exe", bounds: { x: 100, y: 50, width: 600, height: 400 }, isOnScreen: true },
      { pid: 4321, windowId: BigInt("1234"), title: "Save As", appName: "editor.exe", bounds: { x: 300, y: 200, width: 400, height: 300 }, isOnScreen: true },
      { pid: 4321, windowId: BigInt("5678"), title: "Replace?", appName: "editor.exe", bounds: { x: 330, y: 220, width: 300, height: 180 }, isOnScreen: true },
    ],
    foregroundWindow: { pid: 4321, windowId: "5678", title: "Replace?", className: "Dialog", visible: true, minimized: false },
    responses: { listOwnedPopups: { ok: true, windows: [{ pid: 4321, windowId: "1234" }, { pid: 4321, windowId: "5678" }] } },
  });
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ testRoot: root, calls }) as never });

  await driver.capturePopup("stage");
  assert.ok(nativeFixture(root).calls.some((call) => call.op === "captureWindow" && call.windowId === "5678"),
    "the active conflict prompt is selected using the OS foreground identity");
  assert.equal(nativeFixture(root).calls.some((call) => call.op === "captureWindow" && call.windowId === "1234"), false,
    "an arbitrary list-order popup is never captured as the target");
  await driver.shutdown();
}));
