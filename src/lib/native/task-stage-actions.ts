import { createCuaStageDriver, type CuaAgentCursorIdentity, type CuaStageTargetDescription } from "./cua-stage-driver";
import type { WindowsSystemControlRequest } from "./windows-desktop-stage";
import { requestedActionDelivery, selectActionDelivery } from "./multiplayer-action-policy";
import { DesktopInputNotDispatchedError } from "./desktop-input-errors";
import { StageInputNotDispatchedError } from "./stage-errors";
import { classifyWebActionRisk } from "./risk-core";
import { resolveSaveAsTarget } from "./stage-save-as";

type TaskStageActionBody =
  | { kind: "capture" }
  | { kind: "read_structure"; view: "app" | "desktop" }
  | { kind: "window_status"; view: "app" }
  | { kind: "stop" }
  | { kind: "window_state"; view: "app"; state: "minimized" | "maximized" | "restored" }
  | { kind: "click" | "cursor"; x: number; y: number; confirmFocusForeground?: boolean }
  | { kind: "double_click" | "middle_click" | "right_click"; x: number; y: number; confirmFocusForeground?: boolean }
  | { kind: "type"; text: string; mode?: "insert" | "replace"; x?: number; y?: number; expectedRole?: string; expectedLabel?: string; confirmFocusForeground?: boolean }
  | { kind: "type_then_enter"; text: string; confirmFocusForeground?: boolean }
  | { kind: "scroll"; x?: number; y?: number; direction: "up" | "down"; amount?: number; confirmFocusForeground?: boolean }
  | { kind: "drag"; fromX: number; fromY: number; toX: number; toY: number; durationMs?: number; confirmFocusForeground?: boolean }
  | { kind: "press_key"; key: string; confirmFocusForeground?: boolean }
  | { kind: "hotkey"; keys: string[]; confirmFocusForeground?: boolean }
  | { kind: "click_element"; ref: string; expectedRole?: string; expectedLabel?: string; confirmFocusForeground?: boolean }
  | { kind: "scroll_element"; ref: string; direction: "up" | "down" | "left" | "right"; granularity?: "small" | "large"; expectedRole?: string; expectedLabel?: string; confirmFocusForeground?: boolean }
  | { kind: "read_value"; ref: string; maxChars?: number; expectedRole?: string; expectedLabel?: string }
  | { kind: "replace_element"; ref: string; text: string; expectedRole?: string; expectedLabel?: string }
  | { kind: "append_element"; ref: string; text: string; separator?: "none" | "newline"; expectedRole?: string; expectedLabel?: string }
  | { kind: "scroll_delta"; x?: number; y?: number; deltaX: number; deltaY: number; unit: "pixel" | "line" | "page"; confirmFocusForeground?: boolean }
  | { kind: "window_frame"; x: number; y: number; width: number; height: number }
  | { kind: "snap"; position: "left" | "right" | "top" | "bottom" | "maximize"; confirmFocusForeground?: boolean }
  | { kind: "focus"; confirmFocusForeground?: boolean }
  | { kind: "invoke_menu"; path: string[] }
  | { kind: "clipboard_read"; includeText: boolean; confirmSharedClipboard?: boolean }
  | { kind: "clipboard_write"; text?: string; imagePath?: string; filePath?: string; confirmSharedClipboard: true }
  | { kind: "save_as"; path: string; createParentDirectories?: boolean; replaceExisting?: boolean }
  | ({ kind: "system_control" } & WindowsSystemControlRequest);
export type TaskStageAction = TaskStageActionBody & { view?: "desktop" | "app" | "popup" };

export interface TaskStageActionDeliveryProfile {
  capabilities: readonly string[];
  backgroundSafe: boolean;
  requiresPhysicalInput?: boolean;
  requiresForegroundTurn?: boolean;
}

/**
 * Describe the route this exact action can use. These are candidates, not
 * guarantees: semantic methods re-resolve their target at dispatch time and
 * fail closed when the live provider does not expose the needed pattern.
 */
export function taskStageActionDeliveryProfile(action: TaskStageAction): TaskStageActionDeliveryProfile {
  switch (action.kind) {
    case "capture": case "read_structure": case "read_value": case "window_status":
      return { capabilities: ["observe.accessibility"], backgroundSafe: true };
    case "cursor":
      return { capabilities: ["presence.cursor"], backgroundSafe: true };
    case "type":
      return { capabilities: [action.mode === "replace" ? "input.text.replace" : "input.text.insert"], backgroundSafe: true };
    case "replace_element":
      return { capabilities: ["input.text.replace"], backgroundSafe: true };
    case "append_element":
      return { capabilities: ["input.text.replace"], backgroundSafe: true };
    case "click_element":
      return { capabilities: ["input.click.element"], backgroundSafe: true };
    case "scroll_element":
      return { capabilities: ["input.scroll.element"], backgroundSafe: true };
    case "invoke_menu":
      return { capabilities: ["input.menu.invoke"], backgroundSafe: true };
    case "save_as":
      return { capabilities: ["file.save-as"], backgroundSafe: true };
    case "clipboard_read":
      return { capabilities: ["clipboard.read"], backgroundSafe: true };
    case "clipboard_write":
      return { capabilities: ["clipboard.write"], backgroundSafe: true };
    case "system_control":
      return action.control === "media"
        ? { capabilities: ["input.shared-os", "system.media"], backgroundSafe: false, requiresPhysicalInput: true }
        : { capabilities: ["system.background-api"], backgroundSafe: true };
    case "window_frame": case "snap":
      // The native implementation uses SetWindowPos with SWP_NOACTIVATE.
      return { capabilities: ["window.frame.no-activate"], backgroundSafe: true };
    case "window_state": case "focus":
      return { capabilities: ["window.foreground"], backgroundSafe: false, requiresForegroundTurn: true };
    case "click": case "double_click": case "middle_click": case "right_click": case "drag":
    case "scroll": case "scroll_delta": case "press_key": case "hotkey": case "type_then_enter":
      return { capabilities: ["input.shared-os"], backgroundSafe: false, requiresPhysicalInput: true };
    case "stop":
      return { capabilities: [], backgroundSafe: false };
  }
}

const KEY_NAMES = new Set([
  "Ctrl", "Control", "Alt", "Shift", "Meta", "Win", "Enter", "Return", "Escape", "Esc", "Tab", "Space",
  "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft",
  "ArrowRight", "Up", "Down", "Left", "Right", "CapsLock", "PrintScreen",
]);
const CANONICAL_KEYS = new Map([...KEY_NAMES].map((key) => [key.toLowerCase(), key]));

function validKey(value: unknown): value is string {
  // Letters and digits already pass through as a single literal character to
  // the underlying driver; ordinary punctuation shortcut keys (;, =, ,, -, .,
  // /, `, [, ], \, ') are the same single-character case and were simply
  // missing from the allowed set, which made every punctuation shortcut
  // (e.g. Ctrl+/, Ctrl+-) unavailable even though nothing downstream rejects
  // them.
  return typeof value === "string" && value.length <= 20
    && (/^[a-z0-9;=,\-./`[\]\\']$/i.test(value) || /^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(value) || CANONICAL_KEYS.has(value.toLowerCase()));
}

/** Reject extra fields so an action cannot carry a desktop name, HWND, or command. */
export function parseTaskStageAction(value: unknown): TaskStageAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stage action.");
  const action = value as Record<string, unknown>;
  const fields: Record<string, string[]> = { capture: [], stop: [], read_structure: [], window_status: [], click: ["x", "y"], double_click: ["x", "y"], middle_click: ["x", "y"], right_click: ["x", "y"], cursor: ["x", "y"],
    type: ["text", "mode", "x", "y", "expectedRole", "expectedLabel"], type_then_enter: ["text"], scroll: ["x", "y", "direction", "amount"], drag: ["fromX", "fromY", "toX", "toY", "durationMs"], press_key: ["key"], hotkey: ["keys"],
    click_element: ["ref", "expectedRole", "expectedLabel"], scroll_element: ["ref", "direction", "granularity", "expectedRole", "expectedLabel"],
    read_value: ["ref", "maxChars", "expectedRole", "expectedLabel"],
    replace_element: ["ref", "text", "expectedRole", "expectedLabel"],
    append_element: ["ref", "text", "separator", "expectedRole", "expectedLabel"], scroll_delta: ["x", "y", "deltaX", "deltaY", "unit"],
    window_frame: ["x", "y", "width", "height"], snap: ["position"], window_state: ["state"], focus: [], invoke_menu: ["path"], clipboard_read: ["includeText", "confirmSharedClipboard"], clipboard_write: ["text", "imagePath", "filePath", "confirmSharedClipboard"],
    system_control: ["control", "action", "value", "step"], save_as: ["path", "createParentDirectories", "replaceExisting"] };
  if (typeof action.kind !== "string" || !Object.hasOwn(fields, action.kind)) throw new Error("Unsupported stage action.");
  const allowedFields = fields[action.kind]!;
  const requiredFields = action.kind === "system_control" ? ["control", "action"] : action.kind === "type" ? ["text"] : action.kind === "save_as" ? ["path"] : action.kind === "read_structure" ? ["view"]
    // A scroll targets one already-exact window (or, on the desktop, the
    // point that picks which window) -- x/y are a convenience for the
    // common "scroll wherever this already-selected window is" case, not
    // a requirement; only direction is.
    : action.kind === "scroll" ? ["direction"]
    // Same reasoning as scroll: x/y are a convenience, not a requirement.
    : action.kind === "scroll_delta" ? ["deltaX", "deltaY", "unit"] : action.kind === "window_frame" ? allowedFields
      // durationMs is explicitly optional on the drag action type (defaults
      // downstream to the driver's own pacing) -- it must not be required
      // here just because it's in the drag action's allowed-fields list.
      : action.kind === "drag" ? ["fromX", "fromY", "toX", "toY"]
      : action.kind === "clipboard_read" ? ["includeText"] : action.kind === "clipboard_write" ? ["confirmSharedClipboard"] : action.kind === "click_element" ? ["ref"]
        : action.kind === "replace_element" || action.kind === "append_element" ? ["ref", "text"] : action.kind === "scroll_element" ? ["ref", "direction"]
          : action.kind === "read_value" ? ["ref"] : allowedFields;
  const commonOptionalFields = ["view", "confirmFocusForeground"];
  if (Object.keys(action).some((key) => key !== "kind" && !commonOptionalFields.includes(key) && !allowedFields.includes(key))
    || requiredFields.some((key) => !Object.hasOwn(action, key))) throw new Error("Invalid stage action fields.");
  if (action.view !== undefined && action.view !== "desktop" && action.view !== "app" && action.view !== "popup") throw new Error("Invalid stage action view.");
  // "popup" targets the exact app's currently owned popup window (a Windows
  // error dialog, a Save-As box) instead of the app's own window -- only
  // meaningful for the small set of actions that dispatch input by point or
  // key, not for the semantic/structural ones that assume the registered app.
  if (action.view === "popup" && !["click", "double_click", "middle_click", "right_click", "type", "press_key", "hotkey", "capture"].includes(action.kind)) {
    throw new Error("A popup view is only valid for capture and direct popup input actions.");
  }
  if (action.kind === "read_structure" && action.view !== "app" && action.view !== "desktop") throw new Error("Structure observation requires an exact app or desktop view.");
  if (action.kind === "window_state" && (action.view !== "app" || !["minimized", "maximized", "restored"].includes(String(action.state)))) throw new Error("Invalid exact-app window state.");
  if (["click_element", "scroll_element", "read_value", "replace_element", "append_element", "type_then_enter", "window_frame", "snap", "window_status", "focus", "invoke_menu", "clipboard_read", "clipboard_write", "save_as"].includes(action.kind)
    && action.view !== "app") throw new Error("This semantic stage action requires the exact app view.");
  if (action.kind === "snap" && !["left", "right", "top", "bottom", "maximize"].includes(String(action.position))) throw new Error("Invalid snap position.");
  if (action.kind === "click_element" || action.kind === "scroll_element" || action.kind === "read_value" || action.kind === "replace_element" || action.kind === "append_element") {
    if (typeof action.ref !== "string" || !/^[A-Za-z0-9._:-]{1,512}$/.test(action.ref)) throw new Error("Invalid accessibility element reference.");
  }
  if (action.kind === "read_value" && action.maxChars !== undefined
    && (!Number.isSafeInteger(action.maxChars) || (action.maxChars as number) < 1 || (action.maxChars as number) > 4096)) {
    throw new Error("Accessible value reads must be limited to 1–4096 characters.");
  }
  if (action.kind === "read_value" && action.confirmFocusForeground === true) {
    throw new Error("Accessible value reads are observational and do not accept foreground input.");
  }
  if (action.kind === "scroll_element" && (!(["up", "down", "left", "right"] as unknown[]).includes(action.direction)
    || (action.granularity !== undefined && action.granularity !== "small" && action.granularity !== "large"))) throw new Error("Invalid accessibility scroll direction or granularity.");
  for (const key of ["x", "y", "fromX", "fromY", "toX", "toY"]) {
    if (action.kind === "window_frame" && (key === "x" || key === "y")) continue;
    if (key in action && (!Number.isSafeInteger(action[key]) || (action[key] as number) < 0 || (action[key] as number) > 16383)) {
      throw new Error("Invalid stage action coordinates.");
    }
  }
  if (action.kind === "window_frame") {
    for (const key of ["x", "y"]) if (!Number.isSafeInteger(action[key]) || (action[key] as number) < -16383 || (action[key] as number) > 16383) throw new Error("Invalid window frame coordinates.");
    for (const key of ["width", "height"]) if (!Number.isSafeInteger(action[key]) || (action[key] as number) < 1 || (action[key] as number) > 16383) throw new Error("Invalid window frame dimensions.");
  }
  if (action.kind === "type" && (typeof action.text !== "string" || action.text.length > 5_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(action.text))) throw new Error("Invalid stage input text.");
  if (action.kind === "type_then_enter" && (typeof action.text !== "string" || !action.text.length || action.text.length > 5_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(action.text))) throw new Error("Invalid stage input text.");
  if (action.kind === "type" && action.mode !== undefined && action.mode !== "insert" && action.mode !== "replace") throw new Error("Invalid text mode.");
  if (action.kind === "type" && action.mode === "replace" && (action.x === undefined || action.y === undefined)) throw new Error("Replace text requires an exact field point.");
  if ((action.kind === "type" || action.kind === "click_element" || action.kind === "read_value" || action.kind === "replace_element" || action.kind === "append_element")
    && ["expectedRole", "expectedLabel"].some((key) => action[key] !== undefined && (typeof action[key] !== "string" || (action[key] as string).length > 160))) throw new Error("Invalid expected field metadata.");
  if (action.kind === "scroll" && action.direction !== "up" && action.direction !== "down") throw new Error("Invalid scroll direction.");
  if (action.kind === "scroll_delta" && (action.unit !== "pixel" && action.unit !== "line" && action.unit !== "page")) throw new Error("Invalid scroll unit.");
  if (action.kind === "scroll_delta" && (!Number.isSafeInteger(action.deltaX) || !Number.isSafeInteger(action.deltaY)
    || Math.abs(action.deltaX as number) > 16383 || Math.abs(action.deltaY as number) > 16383
    || ((action.deltaX as number) === 0 && (action.deltaY as number) === 0)
    || ((action.deltaX as number) !== 0 && (action.deltaY as number) !== 0))) throw new Error("Invalid scroll delta.");
  if (action.kind === "system_control") {
    const control = action.control;
    const choice = action.action;
    if (!["display_brightness", "output_audio", "media", "microphone"].includes(String(control))) throw new Error("Invalid system-control category.");
    const allowed = control === "media" ? ["play_pause", "next", "previous"]
      : control === "display_brightness" ? ["get", "set", "increase", "decrease"]
        : ["get", "set", "increase", "decrease", "mute", "unmute"];
    if (!allowed.includes(String(choice))) throw new Error(`Unsupported ${String(control)} action.`);
    if (choice === "set" && (!Number.isSafeInteger(action.value) || (action.value as number) < 0 || (action.value as number) > 100)) throw new Error("Set level requires an integer from 0 to 100.");
    if (choice !== "set" && action.value !== undefined) throw new Error("Only a set action accepts an explicit level.");
    if (["increase", "decrease"].includes(String(choice))) {
      if (action.step !== undefined && (!Number.isSafeInteger(action.step) || (action.step as number) < 1 || (action.step as number) > 50)) throw new Error("Level step must be from 1 to 50.");
    } else if (action.step !== undefined) throw new Error("Only increase and decrease accept a step.");
  }
  if (action.kind === "scroll_element" && ["expectedRole", "expectedLabel"].some((key) => action[key] !== undefined && (typeof action[key] !== "string" || (action[key] as string).length > 160))) {
    throw new Error("Invalid expected scroll-container metadata.");
  }
  if (action.kind === "drag" && action.durationMs !== undefined
    && (typeof action.durationMs !== "number" || !Number.isSafeInteger(action.durationMs) || action.durationMs < 1 || action.durationMs > 10_000)) {
    throw new Error("Invalid drag duration.");
  }
  if (action.kind === "replace_element" && (typeof action.text !== "string" || action.text.length > 5_000)) throw new Error("Invalid stage input text.");
  if (action.kind === "append_element" && (typeof action.text !== "string" || action.text.length < 1 || action.text.length > 5_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(action.text)
    || (action.separator !== undefined && action.separator !== "none" && action.separator !== "newline"))) throw new Error("Invalid append text or separator.");
  if (action.kind === "clipboard_write" && action.text !== undefined && (typeof action.text !== "string" || !action.text.length || action.text.length > 5_000)) throw new Error("Invalid stage input text.");
  if (action.kind === "clipboard_write") {
    if (["text", "imagePath", "filePath"].filter((key) => action[key] !== undefined).length !== 1) throw new Error("Clipboard write requires exactly one payload.");
    for (const key of ["imagePath", "filePath"]) if (action[key] !== undefined
      && (typeof action[key] !== "string" || !/^[a-z]:[\\/]/i.test(action[key] as string) || /[\u0000-\u001f]/.test(action[key] as string) || (action[key] as string).length > 1024)) throw new Error("Clipboard paths must be bounded absolute local paths.");
  }
  if (action.kind === "save_as") {
    if (typeof action.path !== "string" || action.path.length > 32_760) throw new Error("Invalid absolute Save As path.");
    resolveSaveAsTarget(action.path);
    for (const key of ["createParentDirectories", "replaceExisting"]) if (action[key] !== undefined && typeof action[key] !== "boolean") {
      throw new Error(`Invalid Save As ${key} flag.`);
    }
  }
  if (action.kind === "invoke_menu" && (!Array.isArray(action.path) || action.path.length < 1 || action.path.length > 16 || !action.path.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 160))) throw new Error("Invalid menu path.");
  if (action.kind === "clipboard_read" && typeof action.includeText !== "boolean") throw new Error("Invalid clipboard read flag.");
  if (action.kind === "clipboard_read" && action.includeText && action.confirmSharedClipboard !== true) throw new Error("Reading clipboard text requires explicit shared-clipboard confirmation.");
  if (action.kind === "clipboard_write" && action.confirmSharedClipboard !== true) throw new Error("Writing the shared clipboard requires explicit confirmation.");
  if (action.confirmFocusForeground !== undefined && typeof action.confirmFocusForeground !== "boolean") throw new Error("Invalid foreground-delivery flag.");
  if (action.kind === "press_key" && !validKey(action.key)) throw new Error("Invalid key name.");
  if (action.kind === "hotkey" && (!Array.isArray(action.keys) || action.keys.length < 1 || action.keys.length > 4
    || !action.keys.every(validKey))) throw new Error("A hotkey must contain 1–4 supported key names.");
  if (action.kind === "press_key") return { ...action, key: CANONICAL_KEYS.get((action.key as string).toLowerCase()) ?? action.key } as TaskStageAction;
  if (action.kind === "hotkey") return { ...action, keys: (action.keys as string[]).map((key) => CANONICAL_KEYS.get(key.toLowerCase()) ?? key) } as TaskStageAction;
  return action as TaskStageAction;
}

export async function runTaskStageAction(driver: ReturnType<typeof createCuaStageDriver>, name: string, action: TaskStageAction,
  identity: CuaAgentCursorIdentity, mode: "background" | "owner-preview" = "owner-preview", signal?: AbortSignal,
  dispatchPolicy: { semanticOnly?: boolean } = {}) {
  const requestedFocus = "confirmFocusForeground" in action ? action.confirmFocusForeground : undefined;
  const profile = taskStageActionDeliveryProfile(action);
  const mediaKeyRequest = action.kind === "system_control" && action.control === "media";
  // An explicit foreground request (or the inherently global media-key
  // action) may enter the native owner-authorization path for this one action.
  // Merely being in owner-preview/background mode never counts as an active
  // lease or approval.
  const requiresExclusive = profile.requiresPhysicalInput === true || profile.requiresForegroundTurn === true;
  const requested = requestedActionDelivery(mode === "background", requestedFocus === true, mediaKeyRequest || requiresExclusive);
  const delivery = selectActionDelivery({
    target: { capabilities: [...profile.capabilities] },
    requested,
    targetVisible: mode === "owner-preview",
    targetBackgroundSafe: profile.backgroundSafe,
    requiresPhysicalInput: profile.requiresPhysicalInput,
    requiresForegroundTurn: profile.requiresForegroundTurn,
    allowForegroundEscalation: mode === "owner-preview" || requestedFocus === true || mediaKeyRequest
      || requiresExclusive,
  });
  if (!delivery.ok) throw new DesktopInputNotDispatchedError(delivery.reason,
    delivery.code === "foreground-lease-required" ? "foreground-lease" : "background-unavailable");
  const confirmFocusForeground = requestedFocus;
  // Keep owner-preview tasks on the visible route for the demo workflow. A
  // background route remains available when the caller explicitly selects it;
  // exclusive input always uses the owner-preview route.
  const actionDeliveryMode: "background" | "owner-preview" = delivery.mode === "exclusive-input" ? "owner-preview" : mode;
  const allowForegroundEscalation = mode === "owner-preview" || requestedFocus === true || mediaKeyRequest;
  const stageOptions = <T extends Record<string, unknown>>(options: T): T | undefined => {
    const normalized = { ...options, deliveryMode: actionDeliveryMode,
      ...(allowForegroundEscalation ? { allowForegroundEscalation: true } : {}), ...(signal ? { signal } : {}) } as Record<string, unknown>;
    for (const key of Object.keys(normalized)) if (normalized[key] === undefined) delete normalized[key];
    return Object.keys(normalized).length ? normalized as T : undefined;
  };
  const popupTargeted = action.view === "popup";
  const desktopWide = mode === "owner-preview" && action.view !== "app" && !popupTargeted;
  const capture = () => popupTargeted ? driver.capturePopup(name) : desktopWide ? driver.captureDesktop(name, identity) : driver.capture(name, identity);
  const cursor = (x: number, y: number) => desktopWide ? driver.moveDesktopCursor(name, x, y, identity) : driver.moveCursor(name, x, y, identity);
  const click = (x: number, y: number, options: { button?: "left" | "middle" | "right"; count?: 1 | 2; confirmFocusForeground?: boolean } = {}) => {
    const normalized = { ...options, deliveryMode: actionDeliveryMode,
      ...(allowForegroundEscalation ? { allowForegroundEscalation: true } : {}), ...(signal ? { signal } : {}) };
    if (normalized.confirmFocusForeground === undefined) delete normalized.confirmFocusForeground;
    if (popupTargeted) return driver.clickPopup(name, x, y, normalized);
    return desktopWide
      ? driver.clickDesktop(name, x, y, identity, normalized) : driver.click(name, x, y, identity, normalized);
  };
  switch (action.kind) {
    case "capture": return { capture: await capture() };
    case "read_structure":
      return action.view === "app"
        ? driver.readStructure(name, identity)
        : driver.readDesktopStructure(name, identity);
    case "window_status": throw new Error("Window status is handled by the stage service before recovery.");
    case "stop": throw new Error("Stop is handled outside the stage action queue.");
    case "window_state": return driver.windowState(name, action.state);
    case "cursor": return cursor(action.x, action.y);
    case "click": return click(action.x, action.y, { confirmFocusForeground });
    case "double_click": return click(action.x, action.y, { count: 2, confirmFocusForeground });
    case "middle_click": return click(action.x, action.y, { button: "middle", confirmFocusForeground });
    case "right_click": return click(action.x, action.y, { button: "right", confirmFocusForeground });
    case "type": {
      const options = stageOptions({ confirmFocusForeground, mode: action.mode,
        x: action.x, y: action.y, expectedRole: action.expectedRole, expectedLabel: action.expectedLabel });
      if (popupTargeted) return driver.typeTextPopup(name, action.text, options ?? stageOptions({})!);
      if (desktopWide) return driver.typeTextDesktop(name, action.text, identity, options);
      return driver.typeText(name, action.text, identity, options);
    }
    case "type_then_enter": {
      if (action.view !== "app") throw new DesktopInputNotDispatchedError(
        "Type-then-Enter requires one exact app-window target; no input was sent.", "target-identity");
      const options = stageOptions({ confirmFocusForeground });
      const typed = options
        ? await driver.typeText(name, action.text, identity, options)
        : await driver.typeText(name, action.text, identity);
      // typeText resolving without throwing is not proof it actually landed --
      // "suspected-noop" and "unverifiable" mean the driver could not confirm
      // the text was accepted. Pressing Enter anyway can submit a stale or
      // empty form; stop here and report a partial batch instead.
      if (typed.outcome.status === "suspected-noop" || typed.outcome.status === "unverifiable") {
        return { ...typed, batchOutcome: { status: "partial", completedSteps: 1, totalSteps: 2,
          stoppedAt: "enter", message: "Typing was not confirmed as accepted; Enter was not sent to avoid submitting a stale or empty field." } };
      }
      try {
        const entered = options
          ? await driver.pressKey(name, "Enter", identity, options)
          : await driver.pressKey(name, "Enter", identity);
        return { ...entered, batchOutcome: { status: "complete", completedSteps: 2, totalSteps: 2 } };
      } catch (error) {
        if (!(error instanceof DesktopInputNotDispatchedError) && !(error instanceof StageInputNotDispatchedError)) throw error;
        return { ...typed, batchOutcome: { status: "partial", completedSteps: 1, totalSteps: 2,
          stoppedAt: "enter", message: error.message.slice(0, 500) } };
      }
    }
    case "scroll":
      // Multiple windows can be open on the desktop, so there is no single
      // exact target to default to there the way there is for one already-
      // selected app window -- a desktop-wide scroll still needs a point.
      if (desktopWide && (action.x === undefined || action.y === undefined)) {
        throw new Error("A desktop-wide scroll needs an exact point; omitting x/y is only supported for the selected app's own window.");
      }
      return desktopWide ? driver.scrollDesktop(name, action.x!, action.y!, action.direction, identity, stageOptions({ confirmFocusForeground, amount: action.amount }))
        : driver.scroll(name, action.x, action.y, action.direction, identity, stageOptions({ confirmFocusForeground, amount: action.amount }));
    case "scroll_delta":
      if (desktopWide && (action.x === undefined || action.y === undefined)) {
        throw new Error("A desktop-wide scroll needs an exact point; omitting x/y is only supported for the selected app's own window.");
      }
      return desktopWide ? driver.scrollDeltaDesktop(name, action.x!, action.y!, action.deltaX, action.deltaY, action.unit, identity, stageOptions({ confirmFocusForeground }))
        : driver.scrollDelta(name, action.x, action.y, action.deltaX, action.deltaY, action.unit, identity, stageOptions({ confirmFocusForeground }));
    case "drag": return desktopWide ? driver.dragDesktop(name, action.fromX, action.fromY, action.toX, action.toY, identity, stageOptions({ durationMs: action.durationMs, confirmFocusForeground }))
      : driver.drag(name, action.fromX, action.fromY, action.toX, action.toY, identity, stageOptions({ durationMs: action.durationMs, confirmFocusForeground }));
    case "press_key": return popupTargeted ? driver.pressKeyPopup(name, action.key, stageOptions({ confirmFocusForeground })!)
      : desktopWide ? driver.pressKeyDesktop(name, action.key, identity, stageOptions({ confirmFocusForeground })) : driver.pressKey(name, action.key, identity, stageOptions({ confirmFocusForeground }));
    case "hotkey": return popupTargeted ? driver.hotkeyPopup(name, action.keys, stageOptions({ confirmFocusForeground })!)
      : desktopWide ? driver.hotkeyDesktop(name, action.keys, identity, stageOptions({ confirmFocusForeground })) : driver.hotkey(name, action.keys, identity, stageOptions({ confirmFocusForeground }));
    case "click_element": return driver.clickElement(name, action.ref, identity, stageOptions({ confirmFocusForeground, expectedRole: action.expectedRole, expectedLabel: action.expectedLabel }));
    case "scroll_element": return driver.scrollElement(name, action.ref, action.direction, identity,
      stageOptions({ confirmFocusForeground, expectedRole: action.expectedRole, expectedLabel: action.expectedLabel, granularity: action.granularity }));
    case "read_value": return { readValue: await driver.readElementValue(name, action.ref, identity,
      { expectedRole: action.expectedRole, expectedLabel: action.expectedLabel, maxChars: action.maxChars }) };
    case "replace_element": return driver.replaceElement(name, action.ref, action.text, identity,
      stageOptions({ expectedRole: action.expectedRole, expectedLabel: action.expectedLabel, confirmFocusForeground,
        ...(dispatchPolicy.semanticOnly ? { semanticOnly: true } : {}) }));
    case "append_element": return driver.appendElement(name, action.ref, action.text, action.separator ?? "none", identity,
      stageOptions({ expectedRole: action.expectedRole, expectedLabel: action.expectedLabel }));
    case "window_frame": return driver.windowFrame(name, action.x, action.y, action.width, action.height, identity,
      stageOptions({ confirmFocusForeground }));
    case "snap": return driver.snapWindow(name, action.position, identity, stageOptions({ confirmFocusForeground }));
    case "focus": return driver.focusWindow(name, identity, stageOptions({ confirmFocusForeground: action.confirmFocusForeground }));
    case "invoke_menu": return driver.invokeMenu(name, action.path, identity, stageOptions({ confirmFocusForeground }));
    case "clipboard_read": return driver.clipboardRead(name, action.includeText, identity, stageOptions({ confirmFocusForeground }));
    case "clipboard_write": return driver.clipboardWrite(name, action.text ?? "", identity,
      action.imagePath || action.filePath ? { imagePath: action.imagePath, filePath: action.filePath } : undefined,
      stageOptions({ confirmFocusForeground }));
    case "save_as": return driver.saveAs(name, action.path, { createParentDirectories: action.createParentDirectories,
      replaceExisting: action.replaceExisting, signal });
    case "system_control": return driver.systemControl({ control: action.control, action: action.action,
      ...(action.value === undefined ? {} : { value: action.value }), ...(action.step === undefined ? {} : { step: action.step }) }, signal);
  }
}

/**
 * Money carve-out for stage clicks. The owner pre-approves everything else an agent may do on its
 * registered window, but a click that looks like it moves or commits money always waits for the owner.
 * Same label patterns as the web broker's click gate. The label is the money signal; a control without
 * one (an icon, thumbnail or canvas) carries none, so it is not held.
 */
export function stageClickNeedsApproval(target: CuaStageTargetDescription | undefined): { hold: boolean; label?: string } {
  const label = target?.label?.trim() || undefined;
  if (!label) return { hold: false };
  const risk = classifyWebActionRisk({ action: "click", targetLabel: label });
  return { hold: risk.risky && risk.category === "money", label };
}
