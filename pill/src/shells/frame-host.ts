// The pill's side of the in-page frame protocol. The page's content script mounts this document in a frame inside a
// closed shadow root and talks to it only after it proves itself: the host says hello with a one-time nonce (carried in
// this document's URL), the frame answers "ready", and the host hands over a private message port. Sizes go to the parent
// window; nothing the owner types does. The frame is exactly as big as the island, so the page underneath stays clickable.

import type { PillTransport } from "../core/transport";

/** Room around the island for its shadow and glow. */
const PAD = 16;
/** While the island is folded away only the wake strip exists. */
const WAKE = { w: 240, h: 6 };

export interface FrameHost {
  /** The transport with the window hooks the island calls, wired to the parent frame. */
  transport: PillTransport;
  /** Messages the page's content script sends over the private port (opening the message view from the keyboard). */
  onHostCommand(fn: (kind: string, data: { active?: boolean }) => void): void;
}

export function createFrameHost(inner: PillTransport, win: Window = window): FrameHost {
  const nonce = new URL(win.location.href).searchParams.get("n") || "";
  const commands = new Set<(kind: string, data: { active?: boolean }) => void>();
  let hostPort: MessagePort | null = null;
  let rect: { w: number; h: number } | null = null;
  let collapsed = false;
  let lastSent = "";

  const toParent = (payload: Record<string, unknown>) => {
    try { win.parent.postMessage({ m9r: "frame", nonce, ...payload }, "*"); } catch { /* the page is gone */ }
  };

  const sendSize = () => {
    const w = collapsed || !rect ? WAKE.w : Math.ceil(rect.w) + PAD * 2;
    const h = collapsed || !rect ? WAKE.h : Math.ceil(rect.h) + PAD;
    const key = `${w}x${h}`;
    if (key === lastSent) return;
    lastSent = key;
    toParent({ kind: "size", w, h });
  };

  win.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { m9r?: string; nonce?: string } | null;
    if (event.source !== win.parent || !data || data.nonce !== nonce) return;
    if (data.m9r === "host-hello") {
      lastSent = "";
      toParent({ kind: "ready" });
      sendSize();
      return;
    }
    if (data.m9r === "host-port" && event.ports?.[0]) {
      try { hostPort?.close(); } catch { /* already closed */ }
      hostPort = event.ports[0];
      hostPort.onmessage = (m: MessageEvent) => {
        const d = m.data as { m9r?: string; nonce?: string; kind?: string; active?: unknown } | null;
        if (d && d.m9r === "host" && d.nonce === nonce && typeof d.kind === "string") for (const fn of commands) fn(d.kind, { active: d.active === true });
      };
      hostPort.start?.();
      sendSize();
    }
  });

  // Alt+M and Alt+N are handled by the page's content script. While focus is inside this frame the page never sees the
  // keys, so the frame forwards them (the same rule the older frames follow).
  const hotkeyOf = (ev: KeyboardEvent) => (ev.altKey && !ev.ctrlKey && !ev.metaKey ? (ev.code === "KeyM" ? "m" : ev.code === "KeyN" ? "n" : "") : "");
  win.addEventListener("keydown", (ev) => {
    const key = hotkeyOf(ev as KeyboardEvent);
    if (key && !(ev as KeyboardEvent).repeat) toParent({ kind: "hotkey", key, down: true });
  }, true);
  win.addEventListener("keyup", (ev) => {
    const e = ev as KeyboardEvent;
    if (e.key === "Alt" || hotkeyOf(e)) toParent({ kind: "hotkey", key: e.code === "KeyN" ? "n" : "m", down: false });
  }, true);

  return {
    transport: {
      ...inner,
      setIslandRect(_x, _y, w, h) {
        rect = { w, h };
        sendSize();
      },
      setCollapsed(next) {
        collapsed = next;
        sendSize();
      },
      setSuppressed(on) {
        toParent({ kind: "suppress", on });
      },
    },
    onHostCommand(fn) { commands.add(fn); },
  };
}
