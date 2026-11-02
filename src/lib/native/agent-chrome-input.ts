import { setTimeout as delay } from "node:timers/promises";

export interface ChromePoint { x: number; y: number }
export function chromeKeyEvent(chord: string): Record<string, unknown> {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  const modifiers = parts.reduce((mask, value) => mask | ({ ctrl: 2, control: 2, alt: 1, shift: 8, meta: 4, win: 4 }[value.toLowerCase()] ?? 0), 0);
  if (!key || parts.some((value) => !/^(?:ctrl|control|alt|shift|meta|win)$/i.test(value))) throw new Error("Unsupported key chord.");
  const special: Record<string, [string, number]> = { enter: ["Enter", 13], return: ["Enter", 13], tab: ["Tab", 9], escape: ["Escape", 27], esc: ["Escape", 27],
    backspace: ["Backspace", 8], delete: ["Delete", 46], home: ["Home", 36], end: ["End", 35], pageup: ["PageUp", 33], pagedown: ["PageDown", 34],
    arrowleft: ["ArrowLeft", 37], arrowup: ["ArrowUp", 38], arrowright: ["ArrowRight", 39], arrowdown: ["ArrowDown", 40], space: [" ", 32] };
  const entry = special[key.toLowerCase()];
  const virtualKey = entry?.[1] ?? (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : /^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(key) ? 111 + Number(key.slice(1)) : undefined);
  if (virtualKey === undefined) throw new Error("Unsupported browser key.");
  const normalizedKey = entry?.[0] ?? key;
  return { key: normalizedKey, modifiers, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey,
    ...((modifiers & ~8) === 0 && normalizedKey.length === 1 ? { text: normalizedKey } : normalizedKey === "Enter" && modifiers === 0 ? { text: "\r" } : {}) };
}
export interface ChromeDragChannel {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  onDrag(listener: (data: Record<string, unknown>) => void): () => void;
  check(): Promise<void>;
}

/** Trusted CDP pointer gesture, with native HTML drag data when Chrome intercepts it.
 * Runs inside the broker's existing tab turn. Always releases input on cancellation.
 */
export async function dragChrome(channel: ChromeDragChannel, from: ChromePoint, to: ChromePoint): Promise<void> {
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) throw new Error("Invalid drag coordinates.");
  let dragData: Record<string, unknown> | undefined;
  const unsubscribe = channel.onDrag((data) => { dragData = data; });
  let pressed = false;
  try {
    await channel.check();
    await channel.send("Input.setInterceptDrags", { enabled: true });
    await channel.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...from });
    await channel.check();
    await channel.send("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 });
    pressed = true;
    for (let step = 1; step <= 12; step++) {
      await channel.check();
      await channel.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + (to.x - from.x) * step / 12, y: from.y + (to.y - from.y) * step / 12, button: "left", buttons: 1 });
      await delay(16);
    }
    await channel.check();
    if (dragData) {
      if (Array.isArray(dragData.files) && dragData.files.length) throw new Error("Dragging local files is not supported.");
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await channel.check();
        await channel.send("Input.dispatchDragEvent", { type, ...to, data: dragData });
      }
    }
    await channel.check();
    await channel.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 });
    pressed = false;
  } finally {
    unsubscribe();
    if (pressed) {
      await channel.send("Input.cancelDragging", {}).catch(() => undefined);
      await channel.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 }).catch(() => undefined);
    }
    await channel.send("Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
  }
}
