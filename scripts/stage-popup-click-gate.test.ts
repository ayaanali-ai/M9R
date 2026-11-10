import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCuaStageDriver } from "../src/lib/native/cua-stage-driver";
import { createLocalStore } from "../src/lib/native/local-store";
import { createTaskDesktopStageService } from "../src/lib/native/task-desktop-stage";
import { createWindowsDesktopStageManager, type WindowsStageDependencies } from "../src/lib/native/windows-desktop-stage";
import { setOwnerWorkMode } from "../src/lib/native/owner-work-mode";

// Regression for the production stall recorded in the T189-T193 task traces:
// with an app-bound owner-preview stage and the app's own owned dialog
// (Save As, Open, a confirm prompt...) in front, every popup-targeted click
// was refused before dispatch with "The owner-preview stage is bound to an app
// window. Refresh the desktop stage before sending desktop-wide input." The
// click money gate described popup-local points through the desktop-wide
// route, which correctly refuses an app-bound stage. Nothing re-routed it.
//
// Everything here is the real service, real stage driver, and real stage
// manager. Only the native-host IPC (`invokeNative`) is simulated: one app
// window plus one owned popup that is the actual foreground window.

const APP = { pid: 4321, windowId: "7001" };
const POPUP = { pid: 4321, windowId: "7002" };
const APP_BOUNDS = { x: 100, y: 50, width: 800, height: 600 };
const POPUP_BOUNDS = { x: 300, y: 200, width: 400, height: 300 };
// Popup controls, in SCREEN coordinates, as UIA would report them.
const SAVE_BUTTON = { label: "Save", rect: { x: 600, y: 450, width: 80, height: 28 } };
const PAY_BUTTON = { label: "Pay $49.00 now", rect: { x: 320, y: 450, width: 120, height: 28 } };
const pngPixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=";

type NativeCall = Record<string, unknown>;

function nativeHost(state: { popups: Array<{ pid: number; windowId: string }>; foreground: { pid: number; windowId: string } }, calls: NativeCall[]) {
  const boundsFor = (windowId: unknown) => String(windowId) === POPUP.windowId ? POPUP_BOUNDS : APP_BOUNDS;
  return async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
    calls.push({ ...request });
    switch (request.op) {
      case "inspect":
        return { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId), processGeneration: "00000000000a1b2c" } };
      case "listVisibleWindows":
        return { ok: true, windows: [{ ...APP, title: "notes.txt - Notepad", className: "Notepad", processName: "chrome.exe",
          x: APP_BOUNDS.x, y: APP_BOUNDS.y, width: APP_BOUNDS.width, height: APP_BOUNDS.height, zOrder: 1, processPath: null, appUserModelId: null }] };
      case "listOwnedWindows":
        return { ok: true, windows: [{ ...APP, title: "notes.txt - Notepad", width: APP_BOUNDS.width, height: APP_BOUNDS.height }] };
      case "currentForegroundWindow":
        return { ok: true, foregroundWindow: { ...state.foreground, title: "Save As", className: "#32770", visible: true, minimized: false } };
      case "foregroundWindow":
        return { ok: true, foregroundWindow: { ...state.foreground } };
      case "windowStatus":
        return { ok: true, windowState: "visible" };
      case "windowRect":
        return { ok: true, rect: boundsFor(request.windowId) };
      case "presentOwnerWindow":
        return { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId) } };
      case "listOwnedPopups":
        return { ok: true, windows: state.popups };
      case "captureWindow": {
        const bounds = boundsFor(request.windowId);
        return { ok: true, capture: { dataUrl: `data:image/png;base64,${pngPixel}`, width: bounds.width, height: bounds.height, originX: bounds.x, originY: bounds.y } };
      }
      case "captureDesktop":
        return { ok: true, capture: { dataUrl: `data:image/png;base64,${pngPixel}`, width: 1920, height: 1080, originX: 0, originY: 0 } };
      case "inspectWindowStructure":
        return { ok: true, windowStructure: { scope: "window", windowId: String(request.windowId), status: "complete", truncated: false, elements: [] } };
      case "inspectPointControl":
      case "invokePointControl": {
        const x = Number(request.x), y = Number(request.y);
        const hit = [SAVE_BUTTON, PAY_BUTTON].find((control) => x >= control.rect.x && y >= control.rect.y
          && x < control.rect.x + control.rect.width && y < control.rect.y + control.rect.height);
        if (!hit) return { ok: false, error: "No named enabled accessibility control at the exact point." };
        return { ok: true, control: { label: hit.label, pid: POPUP.pid, windowPid: POPUP.pid, windowId: POPUP.windowId, rect: hit.rect,
          invoked: request.op === "invokePointControl", confirmed: request.op === "invokePointControl" } };
      }
      case "postClickToWindow":
        return { ok: true, dispatchState: "dispatched", route: "PostMessageW", target: "exact-window" };
      case "bringToForeground": case "sendClick": case "sendKeyCombo": case "sendText": case "sendScroll": case "sendDrag":
        return { ok: true };
      default:
        return { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId) } };
    }
  };
}

async function withPopupStage(run: (input: {
  act: (action: Record<string, unknown>) => Promise<unknown>;
  calls: NativeCall[];
  state: { popups: Array<{ pid: number; windowId: string }>; foreground: { pid: number; windowId: string } };
  manager: ReturnType<typeof createWindowsDesktopStageManager>;
  stageName: string;
  approvals: string[];
}) => Promise<void>): Promise<void> {
  const fixtureRoot = join(process.cwd(), ".workcache", "native-test-fixtures");
  mkdirSync(fixtureRoot, { recursive: true });
  const root = mkdtempSync(join(fixtureRoot, "m9r-popup-gate-"));
  setOwnerWorkMode(root, "agents-free");
  const calls: NativeCall[] = [];
  // The app starts in front with no dialog; the dialog opens mid-task below.
  const state: { popups: Array<{ pid: number; windowId: string }>; foreground: { pid: number; windowId: string } } = { popups: [], foreground: { ...APP } };
  const stageDeps: WindowsStageDependencies = { platform: "win32", root, terminal: true, env: {}, invokeNative: nativeHost(state, calls) as never };
  const manager = createWindowsDesktopStageManager(stageDeps);
  // The cursor overlay is presentation-only; no Cua runtime is available here.
  const rawDriver = createCuaStageDriver({ manager, stage: stageDeps,
    loadSdk: async () => { throw new Error("cursor overlay unavailable in this test"); } });
  // Match the desktop-stage test harness: the owner broker grants the native
  // foreground lease around an explicitly owner-preview action.
  const driver = new Proxy(rawDriver, { get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === "function" ? (...args: unknown[]) => manager.withForegroundAuthorization(async () => {}, () => value(...args)) : value;
  } });
  const store = createLocalStore(root);
  const identity = store.issueIdentity("codex", "codex", "session-popup");
  const { task } = store.addTask({ from: "you", to: "codex", goal: "Save the note", origin: "human_typed", idempotencyKey: "popup-gate", targetSession: "session-popup" });
  const approvals: string[] = [];
  const service = createTaskDesktopStageService({ store, manager, driver, stage: stageDeps,
    readPolicy: () => ({ handles: ["codex"], controlHandles: ["codex"] }),
    // Reuse an already-open window (the same path the owner-preview launch
    // takes for an existing app): no process is spawned.
    resolveStageAppForTest: () => ({ executable: join(root, "chrome.exe"), args: [] }),
    approvals: () => ({ requestApproval: async (request: { step: string }) => { approvals.push(request.step); return false; } }) as never,
  });
  try {
    // Bind directly to the already-visible app window. Launch discovery is a
    // separate behavior and must not spawn/poll a fake process in this test.
    const prepared = await service.prepare(identity.token, task.id, "owner-preview", { bindForeground: true });
    assert.ok(prepared.name, "the visible app window was bound to the task");
    // The app now opens its own dialog (File > Save As), which takes the foreground.
    state.popups = [POPUP];
    state.foreground = { ...POPUP };
    await run({ act: (action) => service.act(identity.token, task.id, action, "owner-preview"), calls, state, manager, stageName: prepared.name, approvals });
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// Popup-local point of the Save button's center, in the popup's own snapshot
// (popup snapshot == popup bounds size in this fixture).
const saveLocal = { x: SAVE_BUTTON.rect.x + 40 - POPUP_BOUNDS.x, y: SAVE_BUTTON.rect.y + 14 - POPUP_BOUNDS.y };
const payLocal = { x: PAY_BUTTON.rect.x + 60 - POPUP_BOUNDS.x, y: PAY_BUTTON.rect.y + 14 - POPUP_BOUNDS.y };

test("a popup click on an app-bound owner-preview stage reaches the app's owned dialog instead of being refused as desktop-wide input", async () => withPopupStage(async ({ act, calls, manager, stageName }) => {
  assert.ok(manager.list().find((stage) => stage.name === stageName)?.anchor, "precondition: the stage is bound to the app window");
  const result = await act({ kind: "click", view: "popup", x: saveLocal.x, y: saveLocal.y }) as { outcome?: { status?: string } };
  assert.ok(result, "the popup click resolved instead of throwing the 'bound to an app window' refusal");
  const clicks = calls.filter((call) => call.op === "postClickToWindow");
  assert.equal(clicks.length, 1, "exactly one click was dispatched");
  assert.equal(String(clicks[0]!.windowId), POPUP.windowId, "the click went to the owned popup HWND, not the parent app window");
  assert.deepEqual({ x: clicks[0]!.x, y: clicks[0]!.y }, { x: SAVE_BUTTON.rect.x + 40, y: SAVE_BUTTON.rect.y + 14 },
    "the popup-local point mapped to the Save button's screen position");
  assert.ok(calls.some((call) => call.op === "inspectPointControl" && Number(call.x) === SAVE_BUTTON.rect.x + 40),
    "the money gate described the target in the popup's own coordinate space");
  assert.equal(calls.some((call) => call.op === "captureDesktop"), false, "the desktop-wide route was never used for a popup click");
}));

test("the popup click money gate still holds a payment-shaped control inside the dialog", async () => withPopupStage(async ({ act, calls, approvals }) => {
  await assert.rejects(act({ kind: "click", view: "popup", x: payLocal.x, y: payLocal.y }), /did not approve clicking/);
  assert.equal(approvals.length, 1, "the owner was asked to approve the payment-shaped popup control");
  assert.match(approvals[0]!, /Pay \$49\.00 now/, "the approval names the real popup control, read from the popup's coordinates");
  assert.equal(calls.some((call) => call.op === "sendClick"), false, "no click is sent when approval is declined");
}));

test("a popup click after a desktop observation re-binds the selected app and resolves its owned popup", async () => withPopupStage(async ({ act, calls, manager, stageName }) => {
  await act({ kind: "capture", view: "desktop" });
  assert.equal(manager.list().find((stage) => stage.name === stageName)?.anchor, null, "precondition: the desktop observation detached the app binding");
  await act({ kind: "click", view: "popup", x: saveLocal.x, y: saveLocal.y });
  assert.ok(manager.list().find((stage) => stage.name === stageName)?.anchor, "the selected app was re-bound for popup input");
  const clicks = calls.filter((call) => call.op === "postClickToWindow");
  assert.equal(clicks.length, 1);
  assert.equal(String(clicks[0]!.windowId), POPUP.windowId);
}));

test("with no owned popup open, a popup click still fails closed with no input sent", async () => withPopupStage(async ({ act, calls, state }) => {
  state.popups = [];
  state.foreground = { ...APP };
  await assert.rejects(act({ kind: "click", view: "popup", x: saveLocal.x, y: saveLocal.y }), /owns no popup window right now/);
  assert.equal(calls.some((call) => ["sendClick", "sendKeyCombo", "sendText"].includes(String(call.op))), false);
}));

test("with two owned popups and neither in the foreground, a popup click refuses instead of guessing", async () => withPopupStage(async ({ act, calls, state }) => {
  state.popups = [POPUP, { pid: POPUP.pid, windowId: "7003" }];
  state.foreground = { ...APP };
  await assert.rejects(act({ kind: "click", view: "popup", x: saveLocal.x, y: saveLocal.y }), /More than one owned popup is open/);
  assert.equal(calls.some((call) => call.op === "sendClick"), false);
}));
