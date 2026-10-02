// Desktop shell: the pill running in the Tauri window. State is the engine's feed (read by the Rust side, which already
// merges feed.json and web-activity.json); owner decisions go to the same commands the current overlay uses. No npm
// dependency: Tauri's invoke is on the window object.
//
// Not wired yet (the Rust side has no command for them, and the window sizing model differs from this UI's fixed panel):
// sending typed messages and the window hooks. Both arrive with the desktop shell step, with Rust changes.

import type { Decision, PillTransport } from "../core/transport";
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
    capabilities: { allowForADay: true },
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
    async send() {
      throw new Error("Sending from the desktop pill is not connected yet.");
    },
    async decide(approvalId: string, decision: Decision) {
      const need = feed?.needsYou?.find((n) => n.kind === "approval" && n.taskId === approvalId);
      const from = need && "from" in need ? need.from : undefined;
      const to = need && "to" in need ? need.to : undefined;
      await invoke("decide", { taskId: approvalId, action: decision === "deny" ? "deny" : decision === "allow_day" ? "allow_day" : "approve", from, to });
    },
  };
}
