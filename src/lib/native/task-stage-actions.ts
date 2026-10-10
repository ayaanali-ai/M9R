import { createCuaStageDriver, type CuaAgentCursorIdentity, type CuaStageTargetDescription } from "./cua-stage-driver";
import { classifyWebActionRisk } from "./risk-core";

type TaskStageActionBody =
  | { kind: "capture" }
  | { kind: "click" | "cursor"; x: number; y: number }
  | { kind: "double_click" | "right_click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "scroll"; x: number; y: number; direction: "up" | "down" }
  | { kind: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: "press_key"; key: string }
  | { kind: "hotkey"; keys: string[] };
export type TaskStageAction = TaskStageActionBody & { view?: "desktop" | "app" };

const KEY_NAMES = new Set([
  "Ctrl", "Control", "Alt", "Shift", "Meta", "Win", "Enter", "Return", "Escape", "Esc", "Tab", "Space",
  "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft",
  "ArrowRight", "Up", "Down", "Left", "Right", "CapsLock", "PrintScreen",
]);

function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= 20
    && (/^[a-z0-9]$/i.test(value) || /^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(value) || KEY_NAMES.has(value));
}

/** Reject extra fields so an action cannot carry a desktop name, HWND, or command. */
export function parseTaskStageAction(value: unknown): TaskStageAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stage action.");
  const action = value as Record<string, unknown>;
  const fields: Record<string, string[]> = { capture: [], click: ["x", "y"], double_click: ["x", "y"], right_click: ["x", "y"], cursor: ["x", "y"],
    type: ["text"], scroll: ["x", "y", "direction"], drag: ["fromX", "fromY", "toX", "toY"], press_key: ["key"], hotkey: ["keys"] };
  if (typeof action.kind !== "string" || !Object.hasOwn(fields, action.kind)) throw new Error("Unsupported stage action.");
  const required = fields[action.kind]!;
  if (Object.keys(action).some((key) => key !== "kind" && key !== "view" && !required.includes(key))
    || required.some((key) => !Object.hasOwn(action, key))) throw new Error("Invalid stage action fields.");
  if (action.view !== undefined && action.view !== "desktop" && action.view !== "app") throw new Error("Invalid stage action view.");
  for (const key of ["x", "y", "fromX", "fromY", "toX", "toY"]) {
    if (key in action && (!Number.isSafeInteger(action[key]) || (action[key] as number) < 0 || (action[key] as number) > 16383)) {
      throw new Error("Invalid stage action coordinates.");
    }
  }
  if (action.kind === "type" && (typeof action.text !== "string" || !action.text.length || action.text.length > 500
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(action.text))) throw new Error("Invalid stage input text.");
  if (action.kind === "scroll" && action.direction !== "up" && action.direction !== "down") throw new Error("Invalid scroll direction.");
  if (action.kind === "press_key" && !validKey(action.key)) throw new Error("Invalid key name.");
  if (action.kind === "hotkey" && (!Array.isArray(action.keys) || action.keys.length < 1 || action.keys.length > 4
    || !action.keys.every(validKey))) throw new Error("A hotkey must contain 1–4 supported key names.");
  return action as TaskStageAction;
}

export async function runTaskStageAction(driver: ReturnType<typeof createCuaStageDriver>, name: string, action: TaskStageAction,
  identity: CuaAgentCursorIdentity, mode: "background" | "owner-preview" = "owner-preview") {
  const desktopWide = mode === "owner-preview" && action.view !== "app";
  const capture = () => desktopWide ? driver.captureDesktop(name, identity) : driver.capture(name, identity);
  const cursor = (x: number, y: number) => desktopWide ? driver.moveDesktopCursor(name, x, y, identity) : driver.moveCursor(name, x, y, identity);
  const click = (x: number, y: number, options: { button?: "left" | "right"; count?: 1 | 2 } = {}) => desktopWide
    ? driver.clickDesktop(name, x, y, identity, options) : driver.click(name, x, y, identity, options);
  switch (action.kind) {
    case "capture": return { capture: await capture() };
    case "cursor": return cursor(action.x, action.y);
    case "click": return click(action.x, action.y);
    case "double_click": return click(action.x, action.y, { count: 2 });
    case "right_click": return click(action.x, action.y, { button: "right" });
    case "type": return desktopWide ? driver.typeTextDesktop(name, action.text, identity) : driver.typeText(name, action.text, identity);
    case "scroll": return desktopWide ? driver.scrollDesktop(name, action.x, action.y, action.direction, identity)
      : driver.scroll(name, action.x, action.y, action.direction, identity);
    case "drag": return desktopWide ? driver.dragDesktop(name, action.fromX, action.fromY, action.toX, action.toY, identity)
      : driver.drag(name, action.fromX, action.fromY, action.toX, action.toY, identity);
    case "press_key": return desktopWide ? driver.pressKeyDesktop(name, action.key, identity) : driver.pressKey(name, action.key, identity);
    case "hotkey": return desktopWide ? driver.hotkeyDesktop(name, action.keys, identity) : driver.hotkey(name, action.keys, identity);
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
