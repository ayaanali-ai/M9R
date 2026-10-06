import { createCuaStageDriver, type CuaAgentCursorIdentity } from "./cua-stage-driver";

export type TaskStageAction =
  | { kind: "capture" }
  | { kind: "click" | "cursor"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "scroll"; x: number; y: number; direction: "up" | "down" }
  | { kind: "drag"; fromX: number; fromY: number; toX: number; toY: number };

/** Reject extra fields so an action cannot carry a desktop name, HWND, or command. */
export function parseTaskStageAction(value: unknown): TaskStageAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stage action.");
  const action = value as Record<string, unknown>;
  const fields: Record<string, string[]> = { capture: [], click: ["x", "y"], cursor: ["x", "y"],
    type: ["text"], scroll: ["x", "y", "direction"], drag: ["fromX", "fromY", "toX", "toY"] };
  if (typeof action.kind !== "string" || !Object.hasOwn(fields, action.kind)) throw new Error("Unsupported stage action.");
  const required = fields[action.kind]!;
  if (Object.keys(action).some((key) => key !== "kind" && !required.includes(key))
    || required.some((key) => !Object.hasOwn(action, key))) throw new Error("Invalid stage action fields.");
  for (const key of ["x", "y", "fromX", "fromY", "toX", "toY"]) {
    if (key in action && (!Number.isSafeInteger(action[key]) || (action[key] as number) < 0 || (action[key] as number) > 16383)) {
      throw new Error("Invalid stage action coordinates.");
    }
  }
  if (action.kind === "type" && (typeof action.text !== "string" || !action.text.length || action.text.length > 500
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(action.text))) throw new Error("Invalid stage input text.");
  if (action.kind === "scroll" && action.direction !== "up" && action.direction !== "down") throw new Error("Invalid scroll direction.");
  return action as TaskStageAction;
}

export async function runTaskStageAction(driver: ReturnType<typeof createCuaStageDriver>, name: string, action: TaskStageAction, identity: CuaAgentCursorIdentity) {
  switch (action.kind) {
    case "capture": return { capture: await driver.capture(name, identity) };
    case "cursor": return driver.moveCursor(name, action.x, action.y, identity);
    case "click": return driver.click(name, action.x, action.y, identity);
    case "type": return driver.typeText(name, action.text, identity);
    case "scroll": return driver.scroll(name, action.x, action.y, action.direction, identity);
    case "drag": return driver.drag(name, action.fromX, action.fromY, action.toX, action.toY, identity);
  }
}
