// Desktop shell: the pill running in the Tauri window. State is the engine's feed (read by the Rust side, which already
// merges feed.json and web-activity.json); owner decisions go to the same commands the current overlay uses. No npm
// dependency: Tauri's invoke is on the window object.
//
// Typed messages go through the overlay's `send_message` command, which hands them to the engine's own human-typed send.
// The window hooks tell the Rust side where the island is (everything around it is click-through), when it has folded
// away (the window shrinks to a wake strip) and when the message field needs the keyboard. They apply when the overlay
// runs in one-pill mode (M9R_PILL_NEXT=1); the Rust side validates every value.

import type { Decision, PillTransport, SessionRow } from "../core/transport";
import { fromFeed, type Feed } from "./convert";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function tauriInvoke(): Invoke | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" ? internals.invoke : null;
}

const POLL_MS = 1000;

export function createDesktopTransport(invoke: Invoke): PillTransport {
  let feed: Feed | null = null;

  return {
    capabilities: { allowForADay: true, linkSessions: true },
    async listSessions(handle) {
      const raw = await invoke("list_sessions", { handle });
      const rows = typeof raw === "string" ? JSON.parse(raw) : [];
      return (Array.isArray(rows) ? rows : []).flatMap((r: Partial<SessionRow>) => typeof r?.sessionId === "string" ? [{ sessionId: r.sessionId, cwd: typeof r.cwd === "string" ? r.cwd : undefined, lastSeenAt: String(r.lastSeenAt ?? "") }] : []);
    },
    async linkSession(offer, toSession) {
      if (!offer.fromSession) throw new Error("This message has no session to link from.");
      await invoke("link_sessions", { fromHandle: offer.from, fromSession: offer.fromSession, toHandle: offer.to, toSession });
    },
    subscribe(listener) {
      let last = "";
      const tick = async () => {
        try {
          const raw = (await invoke("read_feed")) as string | null;
          if (raw && raw !== last) {
            last = raw;
            feed = JSON.parse(raw) as Feed;
            listener(fromFeed(feed));
          }
        } catch { /* feed missing or mid-write: keep the last good state and try again */ }
      };
      void tick();
      const timer = setInterval(() => void tick(), POLL_MS);
      return () => clearInterval(timer);
    },
    async send(text) {
      const reply = await invoke("send_message", { text });
      return typeof reply === "string" ? reply.trim().slice(0, 300) : undefined;
    },
    setIslandRect(x, y, width, height) {
      void invoke("pill_set_rect", { x, y, width, height }).catch(() => { /* a rejected rectangle keeps the last good one */ });
    },
    setCollapsed(collapsed) {
      void invoke("pill_set_collapsed", { collapsed }).catch(() => { /* the window keeps its size */ });
    },
    focusWindow(focused) {
      void invoke("pill_set_focus", { focused }).catch(() => { /* typing falls back to clicking the field */ });
    },
    async decide(approvalId: string, decision: Decision) {
      const need = feed?.needsYou?.find((n) => n.kind === "approval" && n.taskId === approvalId);
      const from = need && "from" in need ? need.from : undefined;
      const to = need && "to" in need ? need.to : undefined;
      await invoke("decide", { taskId: approvalId, action: decision === "deny" ? "deny" : decision === "allow_day" ? "allow_day" : "approve", from, to });
    },
  };
}
