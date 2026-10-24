import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createCuaStageDriver as createCuaStageDriverCore, normalizeCuaSdk, topmostWindowAtScreenPoint, type CuaStageDriverDependencies, type CuaStageTimingEvent } from "../src/lib/native/cua-stage-driver";
import { createWindowsDesktopStageManager } from "../src/lib/native/windows-desktop-stage";
import { parseTaskStageAction } from "../src/lib/native/task-stage-actions";

const desktopId = "3ecb4a09-87d4-4f8b-9fd1-48bc9d8c14ae";
const windowId = "9223372036854775807";
const imageData = Buffer.from("stage-window-image").toString("base64");

function validCuaRuntimeExports(): Record<string, unknown> {
  class Window {}
  class Coordinates {}
  class CapturedCoordinates {}
  return {
    CuaDriver: { create() {}, connect() {} },
    ActionTarget: { Window },
    ClickPosition: { Coordinates, CapturedCoordinates },
    InputDeliveryMode: { Background: 0, Foreground: 1 },
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

test("normalizes named Cua exports nested under a bundled default namespace", () => {
  const source = validCuaRuntimeExports();
  const normalized = normalizeCuaSdk({ default: {
    cua_driver_sdk: { CuaDriver: source.CuaDriver },
    cua_driver_contract: Object.fromEntries(Object.entries(source).filter(([key]) => key !== "CuaDriver")),
  } }, "fixture-default");
  assert.equal(normalized.CuaDriver, source.CuaDriver);
  assert.equal(normalized.CursorMotionStyle?.Adaptive, 4);
  assert.equal(normalized.CursorMotionTiming?.Fitts, 1);
});

test("accepts a Cua runtime without optional cursor-motion enums", () => {
  const source = validCuaRuntimeExports();
  delete source.CursorMotionStyle;
  delete source.CursorMotionTiming;
  const normalized = normalizeCuaSdk(source, "fixture-missing-motion");
  assert.equal(normalized.CursorMotionStyle, undefined);
  assert.equal(normalized.CursorMotionTiming, undefined);
});

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

test("app captures expose bounded accessibility targets in screenshot coordinates", async () => withRoot(async (root) => {
  await registerStage(root);
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true,
    screenshotWidth: 200, screenshotHeight: 100, windowBounds: { x: 100, y: 50, width: 400, height: 200 },
    images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: [{ label: "Search\nfield", role: "Edit", enabled: true, frame: { x: 120, y: 70, w: 200, h: 40 } },
      { label: "Disabled", enabled: false, frame: { x: 120, y: 70, w: 200, h: 40 } }] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ state, calls: [] }) as never });
  assert.deepEqual((await driver.capture("stage")).controls, [{ label: "Search field", role: "Edit", rect: { x: 10, y: 10, width: 100, height: 20 } }]);
}));

test("a capture whose window has more than 200 accessible targets reports controlsTruncated, never a silent cut", async () => withRoot(async (root) => {
  await registerStage(root);
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true,
    screenshotWidth: 200, screenshotHeight: 100, windowBounds: { x: 100, y: 50, width: 400, height: 200 },
    images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: Array.from({ length: 201 }, (_, i) => ({ label: `item ${i}`, role: "text", enabled: true, frame: { x: 120, y: 70, w: 1, h: 1 } })) };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ state, calls: [] }) as never });
  const capture = await driver.capture("stage");
  assert.equal(capture.controls?.length, 200, "the cap itself is unchanged");
  assert.equal(capture.controlsTruncated, true, "a 201st element must set the truncation flag, not vanish silently");
}));

test("a capture whose window has exactly 200 accessible targets reports no truncation", async () => withRoot(async (root) => {
  await registerStage(root);
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true,
    screenshotWidth: 200, screenshotHeight: 100, windowBounds: { x: 100, y: 50, width: 400, height: 200 },
    images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: Array.from({ length: 200 }, (_, i) => ({ label: `item ${i}`, role: "text", enabled: true, frame: { x: 120, y: 70, w: 1, h: 1 } })) };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ state, calls: [] }) as never });
  const capture = await driver.capture("stage");
  assert.equal(capture.controls?.length, 200);
  assert.equal(capture.controlsTruncated, undefined, "hitting the cap exactly, with nothing left over, is not truncation");
}));

test("accessibility failure retains the same exact-window screenshot route", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, accessibilityError: new Error("custom UI tree unavailable") }) as never });
  assert.equal((await driver.capture("stage")).width, 200);
  const requests = calls.filter((call) => call.method === "getWindowState").map((call) => call.value as Record<string, unknown>);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.includeAccessibilityTree, true);
  assert.equal(requests[1]!.includeAccessibilityTree, false);
  assert.equal(requests[0]!.windowId, requests[1]!.windowId);
  assert.equal(calls.some((call) => call.method === "click" || call.method === "callTool"), false);
}));

test("stage key parsing accepts the case-insensitive names advertised by MCP", () => {
  assert.deepEqual(parseTaskStageAction({ kind: "press_key", key: "enter" }), { kind: "press_key", key: "Enter" });
  assert.deepEqual(parseTaskStageAction({ kind: "hotkey", keys: ["ctrl", "l"] }), { kind: "hotkey", keys: ["Ctrl", "l"] });
});

test("type with mode:\"replace\" actually replaces the field's value instead of silently appending text wherever focus is", async () => withRoot(async (root) => {
  // Before this fix, replace mode discarded the targeted field entirely and
  // fell through to the generic append path (type_text) -- the agent was
  // promised an exact-field replacement and got an append somewhere else,
  // with no error to reveal the mismatch.
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const state = {
    pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: [{ elementToken: "uia:field", enabled: true, role: "Edit", label: "Search", actions: ["click", "set_value"], frame: { x: 120, y: 70, w: 100, h: 20 } }],
  };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state }) as never });
  const identity = { handle: "codex", sessionId: "replace-mode-session" };
  await driver.typeText("stage", "new value", identity, { mode: "replace", x: 30, y: 15 });
  const setValue = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === "set_value")?.value as { args: Record<string, unknown> };
  assert.ok(setValue, "replace mode calls set_value directly on the exact field, not type_text");
  assert.equal(setValue.args.value, "new value");
  assert.equal(setValue.args.element_token, "uia:field");
  assert.equal(calls.some((call) => call.method === "callTool" && (call.value as { name?: string }).name === "type_text"), false,
    "replace mode never falls through to the generic append path");
}));

test("type with mode:\"replace\" refuses when the field at the point does not match the role/label the caller observed", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const state = {
    pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: [{ elementToken: "uia:field", enabled: true, role: "Edit", label: "Something else now", actions: ["click", "set_value"], frame: { x: 120, y: 70, w: 100, h: 20 } }],
  };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state }) as never });
  const identity = { handle: "codex", sessionId: "replace-mode-mismatch-session" };
  await assert.rejects(
    driver.typeText("stage", "new value", identity, { mode: "replace", x: 30, y: 15, expectedRole: "Edit", expectedLabel: "Search" }),
    /could not be confirmed as the same one/,
  );
  assert.equal(calls.some((call) => call.method === "callTool"), false, "no text is sent when the field cannot be confirmed");
}));

test("point replacement climbs the actual parent chain rather than selecting a Text child or overlapping sibling", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: [
      { elementIndex: BigInt(1), elementToken: "uia:parent", role: "Edit", label: "Search", actions: ["click", "set_value"], frame: { x: 120, y: 70, w: 100, h: 20 } },
      { elementIndex: BigInt(2), parentIndex: BigInt(1), elementToken: "uia:child", role: "Text", frame: { x: 140, y: 72, w: 30, h: 15 } },
      { elementIndex: BigInt(3), elementToken: "uia:sibling", role: "Edit", actions: ["set_value"], frame: { x: 130, y: 70, w: 60, h: 20 } },
    ] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state }) as never });
  await driver.typeText("stage", "new", { handle: "codex", sessionId: "ancestor" }, { mode: "replace", x: 25, y: 15, expectedRole: "Edit", expectedLabel: "Search" });
  const call = calls.find((c) => c.method === "callTool" && (c.value as { name?: string }).name === "set_value");
  assert.equal((call?.value as { args: { element_token: string } }).args.element_token, "uia:parent");
  await driver.click("stage", 25, 15, { handle: "codex", sessionId: "ancestor" });
  const click = calls.find((c) => c.method === "callTool" && (c.value as { name?: string }).name === "click");
  assert.equal((click?.value as { args: { element_token: string } }).args.element_token, "uia:parent");
  state.elements[0]!.parentIndex = BigInt(2);
  state.elements[0]!.actions = [];
  const before = calls.filter((c) => c.method === "callTool" && (c.value as { name?: string }).name === "set_value").length;
  await assert.rejects(driver.typeText("stage", "unsafe", undefined, { mode: "replace", x: 25, y: 15 }), /No replaceable/);
  assert.equal(calls.filter((c) => c.method === "callTool" && (c.value as { name?: string }).name === "set_value").length, before);
}));

test("semantic click remembers the exact field and background insert preserves its existing Unicode value", async () => withRoot(async (root) => {
  const windowId = "12345";
  await registerStage(root, windowId);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const field = { elementIndex: BigInt(1), elementToken: "uia:field", role: "Edit", label: "Search", value: "existing 🌍", actions: ["click", "set_value"], frame: { x: 120, y: 70, w: 100, h: 20 } };
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }], elements: [field] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state }) as never });
  const identity = { handle: "codex", sessionId: "semantic-memory" };
  await driver.clickElement("stage", "uia:field", identity);
  await driver.typeText("stage", " plus", identity, { mode: "insert" });
  const call = calls.find((c) => c.method === "callTool" && (c.value as { name?: string }).name === "set_value");
  assert.ok(call, "semantic click must retain the field rather than using focus-only typing");
  assert.equal((call.value as { args: { value: string } }).args.value, "existing 🌍 plus");
  field.value = undefined as unknown as string;
  await assert.rejects(driver.typeText("stage", "unsafe", identity, { mode: "insert" }), /current value.*unavailable/i);
}));

test("background insertion tolerates a dynamic field label after a confirmed semantic click", async () => withRoot(async (root) => {
  const windowId = "12345";
  await registerStage(root, windowId);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const field = { elementIndex: BigInt(1), elementToken: "uia:dynamic-field", role: "Edit", label: "Search", value: "before", actions: ["click", "set_value"], frame: { x: 120, y: 70, w: 100, h: 20 } };
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }], elements: [field] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state }) as never });
  const identity = { handle: "codex", sessionId: "dynamic-label-session" };
  await driver.clickElement("stage", "uia:dynamic-field", identity);
  field.label = "Search (before)";
  await driver.typeText("stage", " +after", identity, { mode: "insert" });
  const call = calls.find((c) => c.method === "callTool" && (c.value as { name?: string }).name === "set_value");
  assert.equal((call?.value as { args: { value: string } }).args.value, "before +after",
    "insert mode must keep using the confirmed role/point even when the field display label changes with its value");
}));

test("semantic click on a ComboBox search field is remembered too, not just Edit/TextField/TextArea/Document (live bug, 2026-10-17)", async () => withRoot(async (root) => {
  // X/Twitter's own search box exposes UIA role "ComboBox", not "Edit" -- the field-memory
  // allowlist used to miss it entirely even though the driver confirmed it supports set_value,
  // so a confirmed semantic click there never got remembered as the active typing target.
  const windowId = "12345";
  await registerStage(root, windowId);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const field = { elementIndex: BigInt(1), elementToken: "uia:search", role: "ComboBox", label: "Search query", value: "", actions: ["click", "set_value"], frame: { x: 120, y: 70, w: 100, h: 20 } };
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }], elements: [field] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state }) as never });
  const identity = { handle: "codex", sessionId: "combobox-memory" };
  await driver.clickElement("stage", "uia:search", identity);
  await driver.typeText("stage", "new Tesla", identity, { mode: "insert" });
  const call = calls.find((c) => c.method === "callTool" && (c.value as { name?: string }).name === "set_value");
  assert.ok(call, "a confirmed click on a ComboBox-role field must be remembered, the same as Edit/TextField/TextArea/Document");
  assert.equal((call.value as { args: { value: string } }).args.value, "new Tesla");
}));

test("coordinate click background insertion also preserves existing value", async () => withRoot(async (root) => {
  const windowId = "12345";
  await registerStage(root, windowId);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: [{ elementIndex: BigInt(1), elementToken: "uia:field", role: "Edit", label: "Search", value: "before", actions: ["click", "set_value"], frame: { x: 120, y: 70, w: 100, h: 20 } }] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state }) as never });
  const identity = { handle: "codex", sessionId: "point-insert" };
  await driver.click("stage", 30, 15, identity, { confirmFocusForeground: false });
  await driver.typeText("stage", "after", identity, { mode: "insert" });
  const call = calls.find((c) => c.method === "callTool" && (c.value as { name?: string }).name === "set_value");
  assert.equal((call?.value as { args: { value: string } }).args.value, "beforeafter");
}));

test("a failed post-close screenshot is replaced by an exact closed-window postcondition, not a replay", async () => withRoot(async (root) => {
  const windowId = "12345";
  await registerStage(root, windowId);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const base = makeSdk({ calls, state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }] } });
  const native = stageDependencies(root);
  const driver = createCuaStageDriver({ stage: { ...native, invokeNative: async (request) => request.op === "windowStatus"
    ? { ok: true, windowState: "closed" } : native.invokeNative!(request) },
    loadSdk: async () => {
      const create = base.CuaDriver.create;
      return { ...base, CuaDriver: { ...base.CuaDriver, create: () => {
        const d = create(); const getState = d.getWindowState;
        d.getWindowState = async (request: unknown) => {
          if (calls.some((c) => c.method === "callTool" && (c.value as { name: string }).name === "hotkey")) throw new Error("window closed");
          return getState(request);
        };
        return d;
      } } } as never;
    } });
  const proof = await driver.hotkey("stage", ["Alt", "F4"]);
  assert.ok("postcondition" in proof);
  assert.equal(proof.outcome.status, "confirmed");
  assert.equal(calls.filter((c) => c.method === "callTool" && (c.value as { name: string }).name === "hotkey").length, 1);
}));

for (const kind of ["type_text", "drag"]) test(`AbortSignal reaches in-flight native ${kind} dispatch`, async () => withRoot(async (root) => {
  await registerStage(root);
  const controller = new AbortController();
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls,
    callToolHook: async (name, _args, signal) => {
      assert.equal(name, kind);
      assert.equal(signal, controller.signal);
      started();
      return new Promise<never>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    } }) as never });
  const action = kind === "drag" ? driver.drag("stage", 10, 10, 30, 30, undefined, { signal: controller.signal })
    : driver.typeText("stage", "long text", undefined, { signal: controller.signal });
  const rejected = assert.rejects(action, /explicit stop/);
  await dispatched;
  controller.abort(new Error("explicit stop"));
  await rejected;
}));

test("app capture includes independently owned popup surfaces without changing app coordinates", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const native = stageDependencies(root);
  const driver = createCuaStageDriver({ stage: { ...native, invokeNative: async (request) => request.op === "listOwnedPopups"
    ? { ok: true, windows: [{ pid: 4321, windowId: "55", title: "Menu", width: 120, height: 80 }] } : native.invokeNative!(request) },
    loadSdk: async () => makeSdk({ calls, stateForRequest: (request) => ({ pid: 4321, windowId: (request as { windowId: bigint }).windowId,
      screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }] }) }) as never });
  const capture = await driver.capture("stage");
  assert.equal(capture.popupCaptureStatus, "complete");
  assert.equal(capture.ownedPopups?.length, 1);
  assert.equal(capture.ownedPopups?.[0]?.coordinateSpace, "popup-local");
  assert.ok(capture.ownedPopups?.[0]?.dataUrl.startsWith("data:image/png;base64,"));
  const structure = await driver.readStructure("stage");
  assert.equal(structure.status, "partial");
  assert.equal(structure.fallbackCapture?.ownedPopups?.length, 1);
}));

test("semantic app actions use fresh structure and the shared driver primitives", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const state = {
    pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }],
    elements: [{ elementToken: "uia:field", enabled: true, role: "Edit", label: "Search", actions: ["click", "set_value"], frame: { x: 120, y: 70, w: 100, h: 20 } }],
  };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state }) as never });
  const identity = { handle: "codex", sessionId: "semantic-session" };

  await driver.clickElement("stage", "uia:field", identity, { confirmFocusForeground: true });
  await driver.replaceElement("stage", "uia:field", "replacement", identity);
  await driver.windowFrame("stage", 10, 20, 800, 600, identity);
  await driver.focusWindow("stage", identity, { confirmFocusForeground: true });
  await driver.invokeMenu("stage", ["Edit", "Select All"], identity);
  const clipboard = await driver.clipboardRead("stage", true, identity);
  await driver.clipboardWrite("stage", "replacement", identity);
  await driver.clipboardWrite("stage", "", identity, { imagePath: "C:\\Temp\\sample.png" });

  const click = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === "click")?.value as { args: Record<string, unknown> };
  assert.equal(click.args.delivery_mode, "foreground");
  const foregroundCalls = calls
    .filter((call) => call.method === "callTool")
    .map((call) => (call.value as { name?: string }).name);
  assert.ok(foregroundCalls.indexOf("bring_to_front") >= 0, "foreground input explicitly activates its exact target window");
  assert.ok(foregroundCalls.indexOf("bring_to_front") < foregroundCalls.indexOf("click"), "focus is established before foreground click delivery");
  assert.equal(calls.some((call) => call.method === "setWindowFrame"), true);
  assert.equal(calls.some((call) => call.method === "invokeMenu"), true);
  assert.equal(calls.some((call) => call.method === "clipboardRead"), true);
  assert.equal(calls.some((call) => call.method === "clipboardWrite"), true);
  assert.ok(calls.some((call) => call.method === "clipboardWrite" && (call.value as { imagePath?: string }).imagePath === "C:\\Temp\\sample.png"));
  assert.deepEqual(clipboard.clipboard, { text: "fixture clipboard" });
}));

test("click_element refuses token-prefix drift when no semantic identity hints were supplied", async () => withRoot(async (root) => {
  // Empirically confirmed live: the same, completely unchanged control got a
  // different full elementToken on two back-to-back read_structure calls (the
  // part before the last ":" changes on every independent getWindowState call;
  // the part after it, the element's stable tree position, did not). An exact
  // string match therefore fails for the overwhelming majority of real
  // click_element calls even though the target control plainly still exists --
  // A suffix is only a tree position, not a real identity. Acting on it without
  // the role/label from the original observation can click a different control.
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  let walk = 0;
  const driver = createCuaStageDriverCore({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls, windows: [] }) as never,
    connectRuntime: async (sdk) => {
      const inner = sdk.CuaDriver.create(undefined);
      return {
        driver: {
          ...inner,
          async getWindowState(input: Parameters<typeof inner.getWindowState>[0]) {
            walk += 1;
            return {
              pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
              windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }],
              elements: [{ elementToken: `s${String(walk).padStart(8, "0")}:8`, elementIndex: BigInt(8), depth: 0, enabled: true, role: "Button", label: "Line up", actions: ["click"], frame: { x: 120, y: 70, w: 20, h: 20 } }],
            };
          },
        } as never,
        processId: 1,
        close: async () => {},
      };
    },
  });
  const identity = { handle: "codex", sessionId: "token-drift-session" };
  const firstReadRef = (await driver.readStructure("stage", identity)).elements[0]!.ref;
  await assert.rejects(driver.clickElement("stage", firstReadRef, identity), /stale or disabled/i);
  assert.equal(calls.some((call) => call.method === "callTool" && (call.value as { name?: string }).name === "click"), false,
    "a position-only suffix must never dispatch a click without semantic identity hints");
}));

test("click_element refuses to click a different control that now occupies the same tree position, when expectedRole/expectedLabel are given", async () => withRoot(async (root) => {
  // The suffix match only proves the control is at the same TREE POSITION as
  // before, not that it is the SAME control -- if the tree genuinely changed
  // (a dialog opened, a row was removed) between the read and the click, a
  // different control can now sit at that exact position. Silently clicking
  // it would be worse than the old "stale" error it replaced. When the caller
  // supplies the role/label it actually saw, a position match that doesn't
  // also match those must be refused, not acted on.
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriverCore({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls, windows: [] }) as never,
    connectRuntime: async (sdk) => {
      const inner = sdk.CuaDriver.create(undefined);
      let walk = 0;
      return {
        driver: {
          ...inner,
          async getWindowState(input: Parameters<typeof inner.getWindowState>[0]) {
            walk += 1;
            // Walk 1 (the read): "Line up" is at tree position 8.
            // Walk 2 (the click): a DIFFERENT control, "Delete", now occupies position 8.
            const element = walk === 1
              ? { elementToken: "s00000001:8", elementIndex: BigInt(8), depth: 0, enabled: true, role: "Button", label: "Line up", actions: ["click"], frame: { x: 120, y: 70, w: 20, h: 20 } }
              : { elementToken: "s00000002:8", elementIndex: BigInt(8), depth: 0, enabled: true, role: "Button", label: "Delete", actions: ["click"], frame: { x: 120, y: 70, w: 20, h: 20 } };
            return {
              pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
              windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }],
              elements: [element],
            };
          },
        } as never,
        processId: 1,
        close: async () => {},
      };
    },
  });
  const identity = { handle: "codex", sessionId: "wrong-element-session" };
  const read = await driver.readStructure("stage", identity);
  const seen = read.elements[0]!;
  assert.equal(seen.label, "Line up");
  await assert.rejects(
    driver.clickElement("stage", seen.ref, identity, { expectedRole: seen.role, expectedLabel: seen.label }),
    /could not be confirmed as the same control/,
  );
  assert.equal(calls.some((call) => call.method === "callTool" && (call.value as { name?: string }).name === "click"), false,
    "no click is ever sent to the wrong control");
}));

test("click_element accepts a real driver-reported action string beyond click/invoke/press", async () => withRoot(async (root) => {
  // Confirmed live against the real Windows driver (WinForms + UI Automation): a
  // collapsed menu item/tree node/combo box commonly reports only "expand", never
  // "invoke"/"click"/"press" -- the original click/invoke/press-only regex would
  // have wrongly refused this real, legitimate click target.
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriverCore({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls, windows: [] }) as never,
    connectRuntime: async (sdk) => {
      const inner = sdk.CuaDriver.create(undefined);
      return {
        driver: {
          ...inner,
          async getWindowState() {
            return {
              pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
              windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }],
              elements: [{ elementToken: "s00000001:8", elementIndex: BigInt(8), depth: 0, enabled: true, role: "MenuItem", label: "System", actions: ["expand"], frame: { x: 120, y: 70, w: 20, h: 20 } }],
            };
          },
        } as never,
        processId: 1,
        close: async () => {},
      };
    },
  });
  const identity = { handle: "codex", sessionId: "expand-only-session" };
  const ref = (await driver.readStructure("stage", identity)).elements[0]!.ref;
  await driver.clickElement("stage", ref, identity);
  const click = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === "click");
  assert.ok(click, "an expand-only element is a real, legitimate click target and must not be refused");
}));

test("background text refusal is retried only through the driver's explicit foreground route", async () => withRoot(async (root) => {
  await registerStage(root, "4567");
  const identity = { handle: "codex", sessionId: "terminal-session" };
  const calls: Array<{ method: string; value?: unknown }> = [];
  const refusal = { text: "Background delivery is not available for target window class 'CASCADIA_HOSTING_WINDOW_CLASS' on this event kind (text_input). No text was sent.", images: [], isError: true, errorCode: "background_unavailable", degraded: false, rawJson: "" };
  const state = { pid: 4321, windowId: BigInt(4567), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 },
    images: [{ mimeType: "image/png", dataBase64: imageData }] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state,
    callToolResultByName: { type_text: refusal },
  }) as never });

  await assert.rejects(driver.typeText("stage", "echo M9R_TERM_OK", identity),
    /Background delivery is not available.*No text was sent/i);
  assert.throws(() => parseTaskStageAction({ kind: "type", text: "echo M9R_TERM_OK", deliveryMode: "foreground" }), /Invalid stage action fields/);
  assert.equal(calls.filter((item) => item.method === "callTool" && (item.value as { name?: string }).name === "type_text").length, 2,
    "only the driver's explicit foreground retry follows a structured background refusal");
}));

test("owner-preview clears its remembered app target after background text is refused", async () => withRoot(async (root) => {
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await registerOwnerPreview(root, identity);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const windows = [{ pid: 4321, windowId: BigInt(windowId), appName: "notepad.exe", title: "Untitled - Notepad",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isOnScreen: true, zIndex: BigInt(1) }];
  const refusal = { text: "Background delivery is not available for target window class 'CASCADIA_HOSTING_WINDOW_CLASS' on this event kind (text_input). No text was sent.", images: [], isError: true, errorCode: "background_unavailable", degraded: false, rawJson: "" };
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls, windows, callToolResultByName: { type_text: refusal },
      state: { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
        windowBounds: { x: 0, y: 0, width: 1920, height: 1080 }, images: [{ mimeType: "image/png", dataBase64: imageData }] },
    }) as never,
    windowAtPoint: async () => ({ pid: 4321, windowId: BigInt(windowId) }),
  });

  await driver.captureDesktop("preview", identity);
  await driver.clickDesktop("preview", 0, 0, identity);
  await assert.rejects(driver.typeTextDesktop("preview", "hello", identity), /No text was sent/);
  await assert.rejects(driver.typeTextDesktop("preview", "hello", identity), /No agent input window is selected yet/);
  assert.equal(calls.filter((call) => call.method === "callTool" && (call.value as { name?: string }).name === "type_text").length, 2);
}));

function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const fixtureRoot = resolve(process.cwd(), ".test-tmp", "native-test-fixtures");
  mkdirSync(fixtureRoot, { recursive: true });
  const root = mkdtempSync(join(fixtureRoot, "m9r-cua-stage-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("untitled taskbar controls use exact accessibility invocation and the overlay-only shell cursor scope", async () => withRoot(async (root) => {
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await registerOwnerPreview(root, identity);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const control = { label: "Start", pid: 123, windowPid: 123, windowId: "456", rect: { x: 0, y: 0, width: 50, height: 50 }, invoked: false };
  let invocations = 0;
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls, screenSize: { width: 1, height: 1 },
      state: { screenshotWidth: 1, screenshotHeight: 1, windowBounds: { x: 0, y: 0, width: 1, height: 1 } } }) as never,
    windowAtPoint: async () => ({ pid: 123, windowId: BigInt(456), shell: true, screenOrigin: { x: 0, y: 0 } }),
    pointControl: async (_x, _y, expected) => { if (expected) { assert.deepEqual(expected, control); invocations++; } return { ...control, invoked: Boolean(expected) }; } });
  await driver.captureDesktop("preview", identity);
  assert.equal((await driver.describeDesktopTarget("preview", 0, 0, identity))?.label, "Start");
  assert.equal((await driver.clickDesktop("preview", 0, 0, identity)).outcome.status, "unverified");
  assert.equal(invocations, 1);
  assert.equal(calls.some((c) => c.method === "getWindowState" || c.method === "click"), false);
  const cursorCall = calls.find((c) => c.method === "callTool")?.value as { name: string; args: Record<string, unknown> };
  assert.equal(cursorCall.name, "move_cursor");
  assert.deepEqual({ scope: cursorCall.args.scope, x: cursorCall.args.x, y: cursorCall.args.y }, { scope: "window", x: 0, y: 0 });
  assert.equal(typeof cursorCall.args.session, "string");
  assert.equal(calls.some((c) => c.method === "desktopTarget"), false, "a desktop target would move the owner's physical pointer");
  assert.equal(calls.some((c) => c.method === "moveCursor"), false, "the shell uses the overlay-only route because Cua omits shell HWNDs");
  await assert.rejects(driver.typeTextDesktop("preview", "hello", identity), /No agent input window/);
}));

test("desktop structure composes visible windows without exposing native handles", async () => withRoot(async (root) => {
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await registerOwnerPreview(root, identity);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const notepadId = BigInt(456);
  const browserId = BigInt(789);
  const windows = [
    { pid: 4321, windowId: notepadId, appName: "notepad.exe", title: "Untitled - Notepad",
      bounds: { x: 100, y: 50, width: 800, height: 500 }, isOnScreen: true, zIndex: BigInt(20), onCurrentSpace: true },
    { pid: 8765, windowId: browserId, appName: "chrome.exe", title: "Browser test",
      bounds: { x: 300, y: 140, width: 1000, height: 700 }, isOnScreen: true, zIndex: BigInt(10), onCurrentSpace: true },
    { pid: 9999, windowId: BigInt(999), appName: "m9r-overlay.exe", title: "M9R",
      bounds: { x: 0, y: 0, width: 100, height: 40 }, isOnScreen: true, zIndex: BigInt(30), onCurrentSpace: true },
  ];
  const driver = createCuaStageDriver({ stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls, windows, screenSize: { width: 1920, height: 1080 },
      stateForRequest: (input) => {
        const window = windows.find((item) => item.windowId === (input as { windowId?: bigint }).windowId)!;
        return {
          pid: window.pid, windowId: window.windowId, screenshotFrameValid: true,
          screenshotWidth: 200, screenshotHeight: 100, windowBounds: window.bounds,
          images: [{ mimeType: "image/png", dataBase64: imageData }], elements: [
            { elementIndex: 1, elementToken: `raw-${window.pid}-secret`, parentIndex: undefined, depth: 0,
              role: "Window", label: window.title, enabled: true, frame: window.bounds, actions: ["focus"] },
            { elementIndex: 2, elementToken: `raw-${window.pid}-button-secret`, parentIndex: 1, depth: 1,
              role: "Button", label: "Safe action", enabled: true,
              frame: { x: window.bounds.x + 20, y: window.bounds.y + 20, w: 120, h: 32 }, actions: ["click"] },
          ], elementsComplete: true,
        };
      },
    }) as never });

  const structure = await driver.readDesktopStructure("preview", identity);
  assert.equal(structure.scope, "desktop");
  assert.equal(structure.status, "partial", "the shell is intentionally a same-capture visual fallback");
  assert.equal(structure.windows.length, 2, "the M9R overlay is not presented as an agent target");
  assert.equal(structure.windows[0]?.frontmost, true);
  assert.equal(structure.elements.length, 4);
  assert.equal(structure.windows[0]?.elements[1]?.parentRef, structure.windows[0]?.elements[0]?.ref);
  assert.ok(structure.fallbackCapture.controls?.some((control) => control.role === "desktop-window"));
  assert.doesNotMatch(JSON.stringify(structure), /pid|windowId|elementToken|raw-.*secret/i);
  assert.equal(calls.filter((call) => call.method === "getDesktopState").length, 1);
  assert.equal(calls.filter((call) => call.method === "listWindows").length, 1);
  assert.equal(calls.filter((call) => call.method === "getWindowState").length, 2);
}));

test("desktop structure folds native whole-screen UIA into the same capture", async () => withRoot(async (root) => {
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await registerOwnerPreview(root, identity);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const stage = stageDependencies(root);
  const invokeNative = stage.invokeNative!;
  stage.invokeNative = async (request) => {
    if (request.op === "inspectDesktopStructure") return { ok: true, desktopStructure: {
      scope: "desktop", status: "complete", truncated: false,
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
      elements: [{ ref: "desktop-ui-element-1", label: "Start", role: "button", className: "Start", depth: 1,
        enabled: true, focused: false, rect: { x: 10, y: 1040, width: 48, height: 40 } }],
    } } as never;
    return invokeNative(request);
  };
  const driver = createCuaStageDriver({ stage,
    loadSdk: async () => makeSdk({ calls, windows: [], screenSize: { width: 1920, height: 1080 },
      state: { screenshotWidth: 192, screenshotHeight: 108, windowBounds: { x: 0, y: 0, width: 1920, height: 1080 },
        images: [{ mimeType: "image/png", dataBase64: imageData }] } }) as never,
  });
  const structure = await driver.readDesktopStructure("preview", identity);
  assert.equal(structure.status, "complete");
  assert.equal(structure.shell.status, "complete");
  assert.equal(structure.shell.elements?.[0]?.label, "Start");
  assert.equal(structure.elements[0]?.windowRef, "desktop-shell");
  assert.ok(structure.elements[0]?.rect);
  assert.doesNotMatch(JSON.stringify(structure), /pid|windowId|elementToken/i);
  assert.equal(calls.filter((call) => call.method === "getDesktopState").length, 1);
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
  stateForRequest?: (request: unknown) => Record<string, unknown>;
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
  accessibilityError?: Error;
  typeTextError?: Error;
  callToolResult?: Record<string, unknown>;
  callToolResultByName?: Record<string, Record<string, unknown>>;
  callToolHook?: (name: string, args: string, signal?: AbortSignal) => Promise<never>;
  motionError?: Error;
  calls: Array<{ method: string; value?: unknown }>;
}) {
  const actionResult = options.actionResult ?? { effect: 0, route: 1, summary: "action confirmed" };
  const toolResult = options.toolResult ?? { text: "", images: [], isError: false, degraded: false, rawJson: "", action: actionResult };
  const driver = {
    async metadata() { options.calls.push({ method: "metadata" }); return { driverVersion: "0.34.0", embedded: false }; },
    async startSession(input: unknown) { options.calls.push({ method: "startSession", value: input }); },
    async setAgentCursorMotion(input: unknown) { options.calls.push({ method: "setAgentCursorMotion", value: input }); if (options.motionError) throw options.motionError; return { isError: false }; },
    async getWindowState(input: unknown) {
      options.calls.push({ method: "getWindowState", value: input });
      if (options.stateForRequest) return options.stateForRequest(input);
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
    async moveCursor(input: unknown) { options.calls.push({ method: "moveCursor", value: input }); return { isError: false }; },
    async callTool(name: string, argumentsJson: string, asyncOptions?: { signal: AbortSignal }) {
      options.calls.push({ method: "callTool", value: { name, args: JSON.parse(argumentsJson) } });
      if (options.callToolHook) return options.callToolHook(name, argumentsJson, asyncOptions?.signal);
      return options.callToolResultByName?.[name] ?? options.callToolResult ?? toolResult;
    },
    async getAgentCursorState() {
      options.calls.push({ method: "getAgentCursorState" });
      const latest = [...options.calls].reverse().find((call) => call.method === "moveCursor" || call.method === "callTool");
      const lastMove = (latest?.method === "callTool" ? (latest.value as { args: unknown }).args : latest?.value) as {
        x?: number; y?: number; target?: { input?: { pid?: number; windowId?: bigint } };
      } | undefined;
      const windowTarget = lastMove?.target?.input;
      const position = windowTarget?.pid
        // The typed Cua window target reports its agent cursor in the
        // window-local screenshot coordinate space. Desktop/shell calls use
        // desktop coordinates; keep the fixture aligned with the native
        // contract so scaled captures exercise the real verification path.
        ? { x: lastMove?.x ?? 42, y: lastMove?.y ?? 24 }
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
    async setWindowFrame(input: unknown) { options.calls.push({ method: "setWindowFrame", value: input }); return toolResult; },
    async invokeMenu(input: unknown) { options.calls.push({ method: "invokeMenu", value: input }); return toolResult; },
    async clipboardRead(input: unknown) {
      options.calls.push({ method: "clipboardRead", value: input });
      return { ...toolResult, structuredJson: JSON.stringify({ text: "fixture clipboard" }) };
    },
    async clipboardWrite(input: unknown) { options.calls.push({ method: "clipboardWrite", value: input }); return toolResult; },
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
  assert.equal(request.includeAccessibilityTree, true);
  assert.deepEqual(capture.controls, []);
  assert.equal(request.includeScreenshot, true);
  assert.deepEqual(calls.map((call) => call.method).filter((method) => ["startSession", "endSession", "shutdown"].includes(method)), ["startSession", "endSession", "shutdown"]);
}));

test("reads the exact app accessibility tree without exposing driver metadata", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const structure = await createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls, state: {
      pid: 4321,
      windowId: BigInt(windowId),
      appName: "notepad.exe",
      windowTitle: "Untitled",
      elementsComplete: true,
      elements: [
        { elementIndex: BigInt(1), depth: 0, role: "Document", label: "Editor", elementToken: "driver-token-root", actions: ["focus"] },
        { elementIndex: BigInt(2), parentIndex: BigInt(1), depth: 1, role: "Edit", label: "Document", elementToken: "driver-token-edit", enabled: true, actions: ["click", "set_value"] },
      ],
      screenshotFrameValid: true,
      screenshotWidth: 200,
      screenshotHeight: 100,
      windowBounds: { x: 100, y: 50, width: 400, height: 200 },
      images: [{ mimeType: "image/png", dataBase64: imageData }],
    } }) as never,
    now: () => new Date("2026-10-05T12:00:00.000Z"),
  }).readStructure("stage");
  assert.equal(structure.status, "complete");
  assert.equal(structure.appName, "notepad.exe");
  assert.equal(structure.windowTitle, "Untitled");
  assert.deepEqual(structure.elements[1], {
    ref: "driver-token-edit", parentRef: "driver-token-root", depth: 1, role: "Edit", label: "Document", enabled: true,
    actions: ["click", "set_value"], canReplaceValue: true,
  });
  assert.equal("pid" in structure, false);
  assert.equal("windowId" in structure, false);
  assert.equal(structure.fallbackCapture, undefined);
  assert.deepEqual(calls.map((call) => call.method).filter((method) => ["startSession", "getWindowState", "endSession", "shutdown"].includes(method)),
    ["startSession", "getWindowState", "endSession", "shutdown"]);
}));

test("returns a same-capture visual fallback when the exact app tree is incomplete", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const structure = await createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls, state: {
      pid: 4321,
      windowId: BigInt(windowId),
      appName: "custom-app.exe",
      windowTitle: "Partial tree",
      elementsComplete: false,
      elements: [{ elementIndex: BigInt(1), depth: 0, role: "Window", label: "Partial tree", elementToken: "partial-root" }],
      screenshotFrameValid: true,
      screenshotWidth: 200,
      screenshotHeight: 100,
      windowBounds: { x: 100, y: 50, width: 400, height: 200 },
      images: [{ mimeType: "image/png", dataBase64: imageData }],
    } }) as never,
    now: () => new Date("2026-10-05T12:00:00.000Z"),
  }).readStructure("stage");
  assert.equal(structure.status, "partial");
  assert.equal(structure.elements[0]?.ref, "partial-root");
  assert.equal(structure.fallbackCapture?.dataUrl, `data:image/png;base64,${imageData}`);
  assert.equal(calls.filter((call) => call.method === "getWindowState").length, 1, "a partial tree keeps its same-call screenshot fallback");
}));

test("uses one bounded exact-window screenshot fallback when accessibility is unavailable", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const structure = await createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls, accessibilityError: new Error("UIA unavailable") }) as never,
    now: () => new Date("2026-10-05T12:00:00.000Z"),
  }).readStructure("stage");
  assert.equal(structure.status, "unavailable");
  assert.equal(structure.elements.length, 0);
  assert.equal(structure.fallbackCapture?.dataUrl, `data:image/png;base64,${imageData}`);
  const requests = calls.filter((call) => call.method === "getWindowState").map((call) => call.value as Record<string, unknown>);
  // A freshly-opened window's accessibility surface can take a moment to become queryable; this
  // is retried a bounded number of times before falling back to a plain screenshot, so a
  // persistent failure produces the retry attempts (tree requested) plus the one final fallback
  // request (tree not requested) -- never an unbounded loop.
  assert.equal(requests.length, 4);
  assert.ok(requests.slice(0, 3).every((request) => request.includeAccessibilityTree === true));
  assert.equal(requests[3]!.includeAccessibilityTree, false);
  assert.ok(requests.every((request) => request.windowId === requests[0]!.windowId));
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
  const clickCall = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === "click")?.value as { args: Record<string, unknown> };
  const clickInput = clickCall.args;
  assert.equal(clickInput.delivery_mode, "background", "owner-preview asks the driver for background delivery first");
  const cursorMove = calls.find((call) => call.method === "moveCursor")?.value as {
    x: number; y: number; target: { input?: { pid?: number; windowId?: bigint } }; session: string;
  };
  assert.deepEqual({ x: cursorMove.x, y: cursorMove.y }, { x: 100, y: 50 }, "screen point maps into the exact window screenshot coordinates");
  assert.deepEqual(cursorMove.target.input, { pid: 4321, windowId: BigInt(windowId) });
  assert.equal(typeof cursorMove.session, "string");
  assert.deepEqual({ pid: clickInput.pid, window_id: clickInput.window_id }, { pid: 4321, window_id: Number(windowId) });
  assert.deepEqual({ x: clickInput.x, y: clickInput.y }, { x: 100, y: 50 }, "captured desktop pixels map into exact-window screenshot pixels");
  assert.equal(clickInput.count, 2);
  assert.equal(calls.some((call) => call.method === "callTool" && (call.value as { name?: string }).name === "move_cursor"), false,
    "cursor movement never uses the desktop-scoped physical pointer");
  assert.equal(calls.some((call) => call.method === "getWindowState"), true, "background input is bound to a verified window snapshot");
  const typed = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === "type_text")?.value as { args: Record<string, unknown> };
  const hotkey = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === "hotkey")?.value as { args: Record<string, unknown> };
  assert.deepEqual({ pid: typed.args.pid, window_id: typed.args.window_id }, { pid: 4321, window_id: Number(windowId) });
  assert.deepEqual({ pid: hotkey.args.pid, window_id: hotkey.args.window_id }, { pid: 4321, window_id: Number(windowId) });
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

test("owner-preview does not retain a keyboard target after an unconfirmed accessibility click", async () => withRoot(async (root) => {
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
  await assert.rejects(() => driver.typeTextDesktop("preview", "hello", identity), /No agent input window is selected yet/);
  assert.equal(calls.some((call) => call.method === "typeText"), false);
  assert.equal(calls.filter((call) => call.method === "callTool" && (call.value as { name: string }).name === "set_value").length, 0);
  await driver.shutdown();
}));

test("registered clicks request the full accessibility walk before choosing a deep target", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls,
    state: {
      pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
      windowBounds: { x: 100, y: 50, width: 400, height: 200 },
      elements: [{ elementToken: "snapshot:deep-button", depth: 24, role: "Button", label: "Deep button", enabled: true,
        frame: { x: 150, y: 75, w: 100, h: 50 }, actions: ["click"] }],
      images: [{ mimeType: "image/png", dataBase64: imageData }],
    },
  }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.click("stage", 50, 25, identity);
  const deepWalk = calls.map((call) => call.value as Record<string, unknown> | undefined)
    .find((value) => value?.includeScreenshot === true && value?.includeAccessibilityTree === true && value?.maxDepth === 24);
  assert.equal(deepWalk?.maxElements, 512);
  const click = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === "click");
  assert.equal((click?.value as { args?: { element_token?: string } } | undefined)?.args?.element_token, "snapshot:deep-button");
}));

test("a later Cua click clears the native child-control selection and malformed state falls back safely", async () => withRoot(async (root) => {
  const base = stageDependencies(root);
  const nativeInputCalls: string[] = [];
  const stage = { ...base, invokeNative: async (request: Record<string, unknown>) => {
    if (request.op === "input") {
      nativeInputCalls.push(String(request.kind));
      return { ok: true, input: { childWindowId: "child-1" } };
    }
    return base.invokeNative!(request);
  } };
  const manager = createWindowsDesktopStageManager(stage);
  await manager.register("stage", "4321", windowId);
  const roomDesktopId = manager.list()[0]!.roomDesktopId;
  writeFileSync(join(root, `stage-input-${roomDesktopId}.json`), "{not-json", "utf8");
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage, loadSdk: async () => makeSdk({ calls }) as never });
  const identity = { handle: "codex", sessionId: "desktop-session" };

  await driver.typeText("stage", "safe", identity);
  assert.deepEqual(nativeInputCalls, [], "corrupt native selection state must not be sent to the native child-control path");
  assert.equal(calls.some((call) => call.method === "callTool" && (call.value as { name?: string }).name === "type_text"), true);

  await driver.click("stage", 10, 10, identity);
  assert.deepEqual(nativeInputCalls, ["click"]);
  await driver.click("stage", 10, 10, identity, { confirmFocusForeground: true });
  await driver.typeText("stage", "after-cua-click", identity);
  assert.deepEqual(nativeInputCalls, ["click"], "a later Cua click must not reuse the earlier native child-control selection");
  assert.equal(existsSync(join(root, `stage-input-${roomDesktopId}.json`)), false);
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
    const action = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === method)?.value as { args: Record<string, unknown> };
    assert.deepEqual({ pid: action.args.pid, window_id: action.args.window_id }, { pid: 4321, window_id: Number(windowId) });
    assert.equal(action.args.delivery_mode, "background", `${method} asks the driver for background delivery first`);
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
  assert.deepEqual(sessions, ["Codex", "Claude"], "native cursor badges use stable provider labels");
  assert.ok(sessions.every((session) => !session.includes("@") && !/[0-9a-f]{8}/i.test(session)), "native cursor badges must not expose session IDs or derived tags");
  assert.ok(sessions.every((session) => session.length <= 28), "public cursor labels fit Cua's visible badge limit");
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

test("shows the clean provider cursor before the first movement", async () => withRoot(async (root) => {
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls }) as never });

  const shown = await driver.showAgentCursor("preview-stage", { handle: "opencode", sessionId: "private-session-id" });
  assert.deepEqual(shown, { label: "OpenCode", visible: true });
  assert.deepEqual(calls.map((call) => call.method), ["create", "startSession", "setAgentCursorMotion", "setAgentCursorEnabled", "getScreenSize", "callTool", "getAgentCursorState", "getSession"]);
  assert.equal(JSON.stringify(calls).includes("private-session-id"), false, "cursor setup calls must not expose the provider session ID");
  await driver.shutdown();
}));

test("concurrent provider cursor starts occupy distinct overlay positions without physical-pointer input", async () => withRoot(async (root) => {
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls }) as never });
  // Start all providers together: allocation must reserve slots atomically even
  // while the Cua calls are still in flight.
  await Promise.all(["codex", "claude", "opencode"].map((handle) =>
    driver.showAgentCursor("preview-stage", { handle, sessionId: handle })));
  const moves = calls.filter((call) => call.method === "callTool").map((call) => (call.value as { name: string; args: { scope: string; x: number; y: number } }));
  assert.equal(new Set(moves.map((move) => `${move.args.x}:${move.args.y}`)).size, 3);
  assert.ok(moves.every((move) => move.name === "move_cursor" && move.args.scope === "window"));
  assert.equal(calls.some((call) => call.method === "moveCursor"), false);
  await driver.shutdown();
}));

test("optional cursor motion failure does not block the logical cursor or stage boot", async () => withRoot(async (root) => {
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, motionError: new Error("motion style unavailable") }) as never });

  const shown = await driver.showAgentCursor("preview-stage", { handle: "codex", sessionId: "motion-failure-session" });
  assert.deepEqual(shown, { label: "Codex", visible: true });
  assert.deepEqual(calls.map((call) => call.method), ["create", "startSession", "setAgentCursorMotion", "setAgentCursorEnabled", "getScreenSize", "callTool", "getAgentCursorState", "getSession"]);
  await driver.shutdown();
}));

test("missing cursor-motion exports do not block the logical cursor or stage boot", async () => withRoot(async (root) => {
  const calls: Array<{ method: string; value?: unknown }> = [];
  const sdk = makeSdk({ calls }) as Record<string, unknown>;
  delete sdk.CursorMotionStyle;
  delete sdk.CursorMotionTiming;
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => sdk as never });

  const shown = await driver.showAgentCursor("preview-stage", { handle: "codex", sessionId: "missing-motion-session" });
  assert.deepEqual(shown, { label: "Codex", visible: true });
  assert.equal(calls.some((call) => call.method === "setAgentCursorMotion"), false);
  assert.equal(calls.some((call) => call.method === "setAgentCursorEnabled"), true);
  await driver.shutdown();
}));

test("cursor acquisition exposes privacy-safe phase timings without leaking session identity", async () => withRoot(async (root) => {
  await registerStage(root);
  const events: CuaStageTimingEvent[] = [];
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    onTiming: (event) => events.push(event),
    loadSdk: async () => makeSdk({ calls: [] }) as never,
  });
  await driver.moveCursor("stage", 42, 24, { handle: "codex", sessionId: "latency-secret-session" });
  assert.ok(events.some((event) => event.phase === "sdk-load"));
  assert.ok(events.some((event) => event.phase === "host-connect"));
  assert.ok(events.some((event) => event.phase === "runtime-acquire"));
  assert.ok(events.some((event) => event.phase === "session-start" && event.stageName === "stage"));
  assert.ok(events.some((event) => event.phase === "cursor-motion" && event.stageName === "stage"));
  assert.ok(events.every((event) => Number.isFinite(event.durationMs as number)));
  assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.startedAt)) && !Number.isNaN(Date.parse(event.endedAt))));
  assert.ok(events.every((event) => event.status === "ok"));
  assert.ok(events.filter((event) => event.phase === "session-start" || event.phase === "cursor-motion").every((event) => event.stageName === "stage"));
  assert.equal(events.some((event) => JSON.stringify(event).includes("latency-secret-session")), false);
  await driver.shutdown();
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
  assert.deepEqual(calls.map((call) => call.method).filter((method) => ["startSession", "endSession", "shutdown"].includes(method)), [], "window enumeration must not create throwaway Cua sessions");
  const all = await driver.listVisibleWindows({ onScreenOnly: false });
  assert.ok(all.some((window) => window.windowId === "102"), "restoration discovery includes windows outside the visible screen");
  assert.equal(calls.filter((call) => call.method === "shutdown").length, 0, "launch polling must keep its host alive");
  await driver.shutdown();
  assert.equal(calls.filter((call) => call.method === "shutdown").length, 1);
}));

test("read_structure recovers from a cached connection that died after a successful connect, without retrying twice on every call", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  let instancesCreated = 0;
  let connectionIsDead = false;
  const driver = createCuaStageDriverCore({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls }) as never,
    connectRuntime: async (sdk) => {
      instancesCreated += 1;
      const isFirstInstance = instancesCreated === 1;
      const inner = sdk.CuaDriver.create(undefined);
      return {
        driver: {
          ...inner,
          async getWindowState(input: Parameters<typeof inner.getWindowState>[0]) {
            if (isFirstInstance && connectionIsDead) throw new Error("write EPIPE: the connection is gone");
            return inner.getWindowState(input);
          },
        } as never,
        processId: instancesCreated,
        close: async () => { calls.push({ method: "shutdown" }); },
      };
    },
  });
  const identity = { handle: "codex", sessionId: "desktop-session" };
  await driver.readStructure("stage", identity);
  assert.equal(instancesCreated, 1, "the first call connects once and caches the runtime");
  await driver.readStructure("stage", identity);
  assert.equal(instancesCreated, 1, "a healthy cached runtime is reused, not reconnected on every call");
  // The host process crashes, or the pipe drops, sometime after the connection
  // was already established and cached -- this is the actual bug: without
  // detecting it, every call for the rest of this broker's life would keep
  // reusing the now-dead connection and failing, for any app, with no way to
  // recover short of restarting the whole broker. read_structure never mutates
  // anything, so it is safe to retry once against a fresh connection rather than
  // probing liveness on every single access (which was tried and measured to
  // slow down launch()'s tight window-discovery polling loop enough to blow
  // through its 70s client timeout -- reacting to a real failure is both safer
  // and faster than checking for one that usually has not happened).
  connectionIsDead = true;
  const recovered = await driver.readStructure("stage", identity);
  assert.equal(instancesCreated, 2, "a dead cached runtime is detected on real failure and replaced with a fresh one");
  assert.notEqual(recovered.status, "unavailable", "the retried call succeeds on the freshly reconnected runtime instead of failing outright");
}));

test("targets click at exact window-local coordinates with driver delivery fallback", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls }) as never });
  const proof = await driver.click("stage", 42, 24);
  assert.equal(proof.outcome.status, "confirmed");
  assert.equal(proof.capture.width, 200);
  const click = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === "click")?.value as { args: Record<string, unknown> };
  assert.deepEqual({ pid: click.args.pid, window_id: click.args.window_id }, { pid: 4321, window_id: Number(windowId) });
  assert.deepEqual({ x: click.args.x, y: click.args.y }, { x: 42, y: 24 });
  assert.equal(click.args.delivery_mode, "background");
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
  const click = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === "click")?.value as { args: Record<string, unknown> };
  assert.deepEqual(click.args.element_token, "button");
  assert.equal(click.args.delivery_mode, "background");
}));

test("middle_click in app view is actually sent as a middle click, not silently downgraded to left", async () => withRoot(async (root) => {
  // Before this fix, the app-view click mapped any button other than "right"
  // to "left" -- middle_click was sent to the driver as an ordinary left
  // click with no error, even though the desktop-wide click already handled
  // "middle" correctly right next to it.
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const state = { pid: 4321, windowId: BigInt(windowId), screenshotFrameValid: true,
    screenshotWidth: 200, screenshotHeight: 100, windowBounds: { x: 0, y: 0, width: 200, height: 100 },
    images: [{ mimeType: "image/png", dataBase64: imageData }], elements: [] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state }) as never });
  await driver.click("stage", 42, 24, undefined, { button: "middle" });
  const click = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === "click")?.value as { args: Record<string, unknown> };
  assert.equal(click.args.button, "middle");
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
  const request = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === "type_text")?.value as { args: Record<string, unknown> };
  assert.equal(request.args.text, secretLikeText);
  assert.equal(request.args.delay_ms, 30, "legacy driver typing uses the shared human-paced default");
  assert.deepEqual({ pid: request.args.pid, window_id: request.args.window_id }, { pid: 4321, window_id: Number(windowId) });
  assert.equal(proof.outcome.status, "confirmed");
  assert.doesNotMatch(JSON.stringify(proof), /local-only fixture text/);
  await driver.typeText("stage", "foreground", undefined, { confirmFocusForeground: true, delayMs: 45 });
  const foreground = calls.filter((call) => call.method === "callTool" && (call.value as { name?: string }).name === "type_text").at(-1)?.value as { args: Record<string, unknown> };
  assert.equal(foreground.args.delivery_mode, "foreground");
  assert.equal(foreground.args.delay_ms, 45);
  await assert.rejects(() => driver.typeText("stage", ""), /1–500 characters/);
  await assert.rejects(() => driver.typeText("stage", "x".repeat(501)), /1–500 characters/);
  await assert.rejects(() => driver.typeText("stage", "hello", undefined, { delayMs: 201 }), /Text delay must be a whole number/);
}));

test("explicit foreground delivery reaches every shared Cua input primitive that exposes it", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls }) as never });

  await driver.typeText("stage", "foreground text", undefined, { confirmFocusForeground: true });
  await driver.pressKey("stage", "Enter", undefined, { confirmFocusForeground: true });
  await driver.hotkey("stage", ["Ctrl", "A"], undefined, { confirmFocusForeground: true });
  await driver.scroll("stage", 42, 24, "down", undefined, { confirmFocusForeground: true });
  await driver.drag("stage", 10, 20, 100, 80, undefined, { confirmFocusForeground: true });

  for (const name of ["type_text", "press_key", "hotkey", "scroll", "drag"]) {
    const action = calls.filter((call) => call.method === "callTool" && (call.value as { name?: string }).name === name).at(-1)?.value as { args: Record<string, unknown> } | undefined;
    assert.equal(action?.args.delivery_mode, "foreground", `${name} must use the driver's foreground delivery field when explicitly requested`);
  }
  const foregroundActivations = calls.filter((call) => call.method === "callTool" && (call.value as { name?: string }).name === "bring_to_front");
  assert.equal(foregroundActivations.length, 5, "each foreground input primitive activates its exact target before dispatch");
}));

test("foreground delivery captures and restores the owner's real pointer position", async () => withRoot(async (root) => {
  // Owner-cursor-isolation fix: the owner's pointer must end up exactly where it was before the
  // agent's real SendInput ran, regardless of where the action itself moved it.
  await registerStage(root);
  const positions = [{ x: 500, y: 400 }, { x: 500, y: 400 }]; // unchanged between the two reads: no owner activity
  let restoreCall: { x: number; y: number } | undefined;
  const ownerPointer = {
    get: async () => positions.shift() ?? { x: 500, y: 400 },
    restore: async (x: number, y: number) => { restoreCall = { x, y }; },
  };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls: [] }) as never, ownerPointer });
  await driver.typeText("stage", "sample", undefined, { confirmFocusForeground: true });
  assert.deepEqual(restoreCall, { x: 500, y: 400 }, "the owner's pointer must be restored to its exact pre-action position");
}));

test("foreground delivery refuses to report a clean result when pointer restoration fails", async () => withRoot(async (root) => {
  await registerStage(root);
  const driver = createCuaStageDriver({
    stage: stageDependencies(root),
    loadSdk: async () => makeSdk({ calls: [] }) as never,
    ownerPointer: {
      get: async () => ({ x: 500, y: 400 }),
      restore: async () => { throw new Error("restore blocked"); },
    },
  });

  await assert.rejects(
    () => driver.typeText("stage", "sample", undefined, { confirmFocusForeground: true }),
    /pointer restoration.*could not be confirmed|outcome is uncertain/i,
  );
}));

test("foreground delivery waits once for a natural gap when the owner is actively moving the real pointer, instead of grabbing control", async () => withRoot(async (root) => {
  await registerStage(root);
  const positions = [{ x: 500, y: 400 }, { x: 540, y: 420 }]; // moved well past the noise threshold between reads: real owner activity
  let getCalls = 0;
  const ownerPointer = {
    get: async () => { getCalls += 1; return positions.shift() ?? { x: 540, y: 420 }; },
    restore: async () => {},
  };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls: [] }) as never, ownerPointer });
  const started = Date.now();
  await driver.typeText("stage", "sample", undefined, { confirmFocusForeground: true });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 300, `expected the extra wait for detected owner activity (~300ms total), took ${elapsed}ms`);
  assert.equal(getCalls, 2, "activity is detected from exactly two reads, not a retry loop");
}));

test("scroll and drag use window-local screenshot coordinates and validate bounds before dispatch", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls }) as never });
  await driver.scroll("stage", 42, 24, "down");
  const scroll = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === "scroll")?.value as { args: Record<string, unknown> };
  assert.deepEqual({ x: scroll.args.x, y: scroll.args.y, direction: scroll.args.direction, by: scroll.args.by, amount: scroll.args.amount }, { x: 42, y: 24, direction: "down", by: "line", amount: 3 });
  assert.deepEqual({ pid: scroll.args.pid, window_id: scroll.args.window_id }, { pid: 4321, window_id: Number(windowId) });
  await driver.drag("stage", 10, 20, 100, 80);
  const drag = calls.find((call) => call.method === "callTool" && (call.value as { name?: string }).name === "drag")?.value as { args: Record<string, unknown> };
  assert.deepEqual({ from_x: drag.args.from_x, from_y: drag.args.from_y, to_x: drag.args.to_x, to_y: drag.args.to_y, duration_ms: drag.args.duration_ms, steps: drag.args.steps }, { from_x: 10, from_y: 20, to_x: 100, to_y: 80, duration_ms: 500, steps: 10 });
  assert.deepEqual({ pid: drag.args.pid, window_id: drag.args.window_id }, { pid: 4321, window_id: Number(windowId) });
  const callsBeforeInvalid = calls.filter((call) => call.method === "callTool" && (call.value as { name?: string }).name === "drag").length;
  await assert.rejects(() => driver.drag("stage", 10, 20, 200, 80), /Both drag points must fall inside/);
  assert.equal(calls.filter((call) => call.method === "callTool" && (call.value as { name?: string }).name === "drag").length, callsBeforeInvalid);
}));

test("surfaces a persistent Cua Driver refusal after the bounded foreground retry", async () => withRoot(async (root) => {
  await registerStage(root);
  const calls: Array<{ method: string; value?: unknown }> = [];
  const refusal = { text: "background input is unavailable", images: [], isError: true, errorCode: "background_unavailable", degraded: false, rawJson: "" };
  const foregroundReady = { text: "", images: [], isError: false, degraded: false, rawJson: "", action: { effect: 0, summary: "window foreground" } };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls,
    callToolResultByName: { bring_to_front: foregroundReady, type_text: refusal },
  }) as never });
  const identity = { handle: "codex", sessionId: "cursor-cleanup-session" };
  await assert.rejects(() => driver.typeText("stage", "sample", identity), /background input is unavailable/);
  assert.equal(calls.filter((call) => call.method === "callTool" && (call.value as { name?: string }).name === "type_text").length, 2);
  const cursorStateCalls = calls.filter((call) => call.method === "setAgentCursorEnabled");
  const lastCursorState = cursorStateCalls.at(-1)?.value as { session?: string; enabled?: boolean };
  assert.equal(lastCursorState.enabled, false, "a failed action leaves the agent cursor in a deliberate hidden state");
  assert.equal(lastCursorState.session, "Codex");
  await driver.shutdown();
  assert.ok(calls.some((call) => call.method === "shutdown"));
}));

test("an explicitly background stage refuses foreground escalation after a Cua refusal", async () => withRoot(async (root) => {
  await registerStage(root, "4568");
  const identity = { handle: "codex", sessionId: "strict-background-session" };
  const calls: Array<{ method: string; value?: unknown }> = [];
  const refusal = { text: "Background delivery is not available for target window class 'CASCADIA_HOSTING_WINDOW_CLASS' on this event kind (text_input). No text was sent.", images: [], isError: true, errorCode: "background_unavailable", degraded: false, rawJson: "" };
  const state = { pid: 4321, windowId: BigInt(4568), screenshotFrameValid: true, screenshotWidth: 200, screenshotHeight: 100,
    windowBounds: { x: 100, y: 50, width: 400, height: 200 }, images: [{ mimeType: "image/png", dataBase64: imageData }] };
  const driver = createCuaStageDriver({ stage: stageDependencies(root), loadSdk: async () => makeSdk({ calls, state,
    callToolResultByName: { type_text: refusal },
  }) as never });

  await assert.rejects(driver.typeText("stage", "hello", identity, { deliveryMode: "background" }), /no foreground fallback.*no input was sent/i);
  assert.equal(calls.filter((call) => call.method === "callTool" && (call.value as { name?: string }).name === "type_text").length, 1,
    "strict background mode makes one background attempt and never retries it as foreground input");
  assert.equal(calls.some((call) => call.method === "callTool" && (call.value as { name?: string }).name === "bring_to_front"), false,
    "strict background mode never steals the owner's foreground window");
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
