import { setTimeout as delay } from "node:timers/promises";

export interface ChromePoint { x: number; y: number }
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
