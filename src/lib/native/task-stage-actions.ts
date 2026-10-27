import { createCuaStageDriver, type CuaAgentCursorIdentity, type CuaStageTargetDescription } from "./cua-stage-driver";
import { classifyWebActionRisk } from "./risk-core";

type TaskStageActionBody =
  | { kind: "capture" }
  | { kind: "read_structure"; view: "app" | "desktop" }
  | { kind: "window_status"; view: "app" }
  | { kind: "stop" }
  | { kind: "window_state"; view: "app"; state: "minimized" | "maximized" | "restored" }
  | { kind: "click" | "cursor"; x: number; y: number; confirmFocusForeground?: boolean }
  | { kind: "double_click" | "middle_click" | "right_click"; x: number; y: number; confirmFocusForeground?: boolean }
  | { kind: "type"; text: string; mode?: "insert" | "replace"; x?: number; y?: number; expectedRole?: string; expectedLabel?: string; confirmFocusForeground?: boolean }
  | { kind: "scroll"; x: number; y: number; direction: "up" | "down"; confirmFocusForeground?: boolean }
  | { kind: "drag"; fromX: number; fromY: number; toX: number; toY: number; durationMs?: number; confirmFocusForeground?: boolean }
  | { kind: "press_key"; key: string; confirmFocusForeground?: boolean }
  | { kind: "hotkey"; keys: string[]; confirmFocusForeground?: boolean }
  | { kind: "click_element"; ref: string; expectedRole?: string; expectedLabel?: string; confirmFocusForeground?: boolean }
  | { kind: "replace_element"; ref: string; text: string; expectedRole?: string; expectedLabel?: string }
  | { kind: "scroll_delta"; x: number; y: number; deltaX: number; deltaY: number; unit: "pixel" | "line" | "page"; confirmFocusForeground?: boolean }
  | { kind: "window_frame"; x: number; y: number; width: number; height: number }
  | { kind: "focus"; confirmFocusForeground?: boolean }
  | { kind: "invoke_menu"; path: string[] }
  | { kind: "clipboard_read"; includeText: boolean; confirmSharedClipboard?: boolean }
  | { kind: "clipboard_write"; text?: string; imagePath?: string; filePath?: string; confirmSharedClipboard: true };
export type TaskStageAction = TaskStageActionBody & { view?: "desktop" | "app" };

const OWNER_PREVIEW_FOREGROUND_ACTIONS = new Set<TaskStageAction["kind"]>([
  "click", "double_click", "middle_click", "right_click", "type", "scroll", "drag",
  "press_key", "hotkey", "click_element", "scroll_delta",
]);

const KEY_NAMES = new Set([
  "Ctrl", "Control", "Alt", "Shift", "Meta", "Win", "Enter", "Return", "Escape", "Esc", "Tab", "Space",
  "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft",
  "ArrowRight", "Up", "Down", "Left", "Right", "CapsLock", "PrintScreen",
]);
const CANONICAL_KEYS = new Map([...KEY_NAMES].map((key) => [key.toLowerCase(), key]));

function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= 20
    && (/^[a-z0-9]$/i.test(value) || /^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(value) || CANONICAL_KEYS.has(value.toLowerCase()));
}

/** Reject extra fields so an action cannot carry a desktop name, HWND, or command. */
export function parseTaskStageAction(value: unknown): TaskStageAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stage action.");
  const action = value as Record<string, unknown>;
  const fields: Record<string, string[]> = { capture: [], stop: [], read_structure: [], window_status: [], click: ["x", "y"], double_click: ["x", "y"], middle_click: ["x", "y"], right_click: ["x", "y"], cursor: ["x", "y"],
    type: ["text", "mode", "x", "y", "expectedRole", "expectedLabel"], scroll: ["x", "y", "direction"], drag: ["fromX", "fromY", "toX", "toY", "durationMs"], press_key: ["key"], hotkey: ["keys"],
    click_element: ["ref", "expectedRole", "expectedLabel"], replace_element: ["ref", "text", "expectedRole", "expectedLabel"], scroll_delta: ["x", "y", "deltaX", "deltaY", "unit"],
    window_frame: ["x", "y", "width", "height"], window_state: ["state"], focus: [], invoke_menu: ["path"], clipboard_read: ["includeText", "confirmSharedClipboard"], clipboard_write: ["text", "imagePath", "filePath", "confirmSharedClipboard"] };
  if (typeof action.kind !== "string" || !Object.hasOwn(fields, action.kind)) throw new Error("Unsupported stage action.");
  const allowedFields = fields[action.kind]!;
  const requiredFields = action.kind === "type" ? ["text"] : action.kind === "read_structure" ? ["view"]
    : action.kind === "scroll_delta" ? ["x", "y", "deltaX", "deltaY", "unit"] : action.kind === "window_frame" ? allowedFields
      : action.kind === "clipboard_read" ? ["includeText"] : action.kind === "clipboard_write" ? ["confirmSharedClipboard"] : action.kind === "click_element" ? ["ref"]
        : action.kind === "replace_element" ? ["ref", "text"] : allowedFields;
  const commonOptionalFields = ["view", "confirmFocusForeground"];
  if (Object.keys(action).some((key) => key !== "kind" && !commonOptionalFields.includes(key) && !allowedFields.includes(key))
    || requiredFields.some((key) => !Object.hasOwn(action, key))) throw new Error("Invalid stage action fields.");
  if (action.view !== undefined && action.view !== "desktop" && action.view !== "app") throw new Error("Invalid stage action view.");
  if (action.kind === "read_structure" && action.view !== "app" && action.view !== "desktop") throw new Error("Structure observation requires an exact app or desktop view.");
  if (action.kind === "window_state" && (action.view !== "app" || !["minimized", "maximized", "restored"].includes(String(action.state)))) throw new Error("Invalid exact-app window state.");
  if (["click_element", "replace_element", "window_frame", "window_status", "focus", "invoke_menu", "clipboard_read", "clipboard_write"].includes(action.kind)
    && action.view !== "app") throw new Error("This semantic stage action requires the exact app view.");
  if (action.kind === "click_element" || action.kind === "replace_element") {
    if (typeof action.ref !== "string" || !/^[A-Za-z0-9._:-]{1,512}$/.test(action.ref)) throw new Error("Invalid accessibility element reference.");
  }
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
  if (action.kind === "type" && (typeof action.text !== "string" || !action.text.length || action.text.length > 500
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(action.text))) throw new Error("Invalid stage input text.");
  if (action.kind === "type" && action.mode !== undefined && action.mode !== "insert" && action.mode !== "replace") throw new Error("Invalid text mode.");
  if (action.kind === "type" && action.mode === "replace" && (action.x === undefined || action.y === undefined)) throw new Error("Replace text requires an exact field point.");
  if ((action.kind === "type" || action.kind === "click_element" || action.kind === "replace_element")
    && ["expectedRole", "expectedLabel"].some((key) => action[key] !== undefined && (typeof action[key] !== "string" || (action[key] as string).length > 160))) throw new Error("Invalid expected field metadata.");
  if (action.kind === "scroll" && action.direction !== "up" && action.direction !== "down") throw new Error("Invalid scroll direction.");
  if (action.kind === "scroll_delta" && (action.unit !== "pixel" && action.unit !== "line" && action.unit !== "page")) throw new Error("Invalid scroll unit.");
  if (action.kind === "scroll_delta" && (!Number.isSafeInteger(action.deltaX) || !Number.isSafeInteger(action.deltaY)
    || Math.abs(action.deltaX as number) > 16383 || Math.abs(action.deltaY as number) > 16383
    || ((action.deltaX as number) === 0 && (action.deltaY as number) === 0)
    || ((action.deltaX as number) !== 0 && (action.deltaY as number) !== 0))) throw new Error("Invalid scroll delta.");
  if (action.kind === "drag" && action.durationMs !== undefined
    && (typeof action.durationMs !== "number" || !Number.isSafeInteger(action.durationMs) || action.durationMs < 1 || action.durationMs > 10_000)) {
    throw new Error("Invalid drag duration.");
  }
  if ((action.kind === "replace_element" || (action.kind === "clipboard_write" && action.text !== undefined)) && (typeof action.text !== "string" || !action.text.length || action.text.length > 500)) throw new Error("Invalid stage input text.");
  if (action.kind === "clipboard_write") {
    if (["text", "imagePath", "filePath"].filter((key) => action[key] !== undefined).length !== 1) throw new Error("Clipboard write requires exactly one payload.");
    for (const key of ["imagePath", "filePath"]) if (action[key] !== undefined
      && (typeof action[key] !== "string" || !/^[a-z]:[\\/]/i.test(action[key] as string) || /[\u0000-\u001f]/.test(action[key] as string) || (action[key] as string).length > 1024)) throw new Error("Clipboard paths must be bounded absolute local paths.");
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
  identity: CuaAgentCursorIdentity, mode: "background" | "owner-preview" = "owner-preview", signal?: AbortSignal) {
  // Launch/adoption is intentionally non-stealing, but an owner-visible app input must
  // still be delivered to the selected window. Otherwise the native/background route can
  // report success while the app remains behind another window and the next action lands
  // nowhere useful. An explicit false remains an opt-out for callers that deliberately
  // request background-capable delivery.
  const requestedFocus = "confirmFocusForeground" in action ? action.confirmFocusForeground : undefined;
  const confirmFocusForeground = requestedFocus
    ?? (mode === "owner-preview" && action.view === "app" && OWNER_PREVIEW_FOREGROUND_ACTIONS.has(action.kind) ? true : undefined);
  const stageOptions = <T extends Record<string, unknown>>(options: T): T | undefined => {
    const normalized = { ...options, deliveryMode: mode, ...(signal ? { signal } : {}) } as Record<string, unknown>;
    for (const key of Object.keys(normalized)) if (normalized[key] === undefined) delete normalized[key];
    return Object.keys(normalized).length ? normalized as T : undefined;
  };
  const desktopWide = mode === "owner-preview" && action.view !== "app";
  const capture = () => desktopWide ? driver.captureDesktop(name, identity) : driver.capture(name, identity);
  const cursor = (x: number, y: number) => desktopWide ? driver.moveDesktopCursor(name, x, y, identity) : driver.moveCursor(name, x, y, identity);
  const click = (x: number, y: number, options: { button?: "left" | "middle" | "right"; count?: 1 | 2; confirmFocusForeground?: boolean } = {}) => {
    const normalized = { ...options, deliveryMode: mode, ...(signal ? { signal } : {}) };
    if (normalized.confirmFocusForeground === undefined) delete normalized.confirmFocusForeground;
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
      if (desktopWide) return options
        ? driver.typeTextDesktop(name, action.text, identity, options)
        : driver.typeTextDesktop(name, action.text, identity);
      return options
        ? driver.typeText(name, action.text, identity, options)
        : driver.typeText(name, action.text, identity);
    }
    case "scroll": return desktopWide ? driver.scrollDesktop(name, action.x, action.y, action.direction, identity, stageOptions({ confirmFocusForeground }))
      : driver.scroll(name, action.x, action.y, action.direction, identity, stageOptions({ confirmFocusForeground }));
    case "scroll_delta": return desktopWide ? driver.scrollDeltaDesktop(name, action.x, action.y, action.deltaX, action.deltaY, action.unit, identity, stageOptions({ confirmFocusForeground }))
      : driver.scrollDelta(name, action.x, action.y, action.deltaX, action.deltaY, action.unit, identity, stageOptions({ confirmFocusForeground }));
    case "drag": return desktopWide ? driver.dragDesktop(name, action.fromX, action.fromY, action.toX, action.toY, identity, stageOptions({ durationMs: action.durationMs, confirmFocusForeground }))
      : driver.drag(name, action.fromX, action.fromY, action.toX, action.toY, identity, stageOptions({ durationMs: action.durationMs, confirmFocusForeground }));
    case "press_key": return desktopWide ? driver.pressKeyDesktop(name, action.key, identity, stageOptions({ confirmFocusForeground })) : driver.pressKey(name, action.key, identity, stageOptions({ confirmFocusForeground }));
    case "hotkey": return desktopWide ? driver.hotkeyDesktop(name, action.keys, identity, stageOptions({ confirmFocusForeground })) : driver.hotkey(name, action.keys, identity, stageOptions({ confirmFocusForeground }));
    case "click_element": return driver.clickElement(name, action.ref, identity, stageOptions({ confirmFocusForeground, expectedRole: action.expectedRole, expectedLabel: action.expectedLabel }));
    case "replace_element": return driver.replaceElement(name, action.ref, action.text, identity,
      stageOptions({ expectedRole: action.expectedRole, expectedLabel: action.expectedLabel, confirmFocusForeground }));
    case "window_frame": return driver.windowFrame(name, action.x, action.y, action.width, action.height, identity,
      stageOptions({ confirmFocusForeground }));
    case "focus": return driver.focusWindow(name, identity, stageOptions({ confirmFocusForeground: action.confirmFocusForeground }));
    case "invoke_menu": return driver.invokeMenu(name, action.path, identity, stageOptions({ confirmFocusForeground }));
    case "clipboard_read": return driver.clipboardRead(name, action.includeText, identity, stageOptions({ confirmFocusForeground }));
    case "clipboard_write": return driver.clipboardWrite(name, action.text ?? "", identity,
      action.imagePath || action.filePath ? { imagePath: action.imagePath, filePath: action.filePath } : undefined,
      stageOptions({ confirmFocusForeground }));
  }
}

/**
 * Money carve-out for stage clicks. The owner pre-approves everything else an agent may do on its
 * registered window, but a click that looks like it moves or commits money always waits for the owner.
 * Same label patterns as the web broker's click gate; fail-closed when the target has no readable label,
 * because an unidentified control must never be assumed harmless.
 */
export function stageClickNeedsApproval(target: CuaStageTargetDescription | undefined): { hold: boolean; label?: string } {
  const label = target?.label?.trim() || undefined;
  if (!label) return { hold: true };
  const risk = classifyWebActionRisk({ action: "click", targetLabel: label });
  return { hold: risk.risky && risk.category === "money", label };
}
