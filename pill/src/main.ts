// Entry point: create the island, connect it to the host's transport, start the intro.

import { listen } from "@tauri-apps/api/event";
import { getTransport } from "./core/transport";
import { createDesktopTransport, tauriInvoke } from "./shells/desktop";
import { Island } from "./island/island";
import { State } from "./core/state";

async function main() {
  await import("./style.css");
  const root = document.getElementById("root");
  if (!root) return;
  const invoke = tauriInvoke();
  if (!invoke) document.body.classList.add("pill-preview");
  // The pill is a broker-owned desktop surface. Browser-extension/frame transports
  // were retired with the extension route; a mock transport is kept only for
  // local component development outside the Tauri shell.
  const transport = window.__M9R_PILL_TRANSPORT__
    ?? (invoke ? createDesktopTransport(invoke) : getTransport());
  // Conversation is the default expanded view, but the app launches as the
  // same compact pill. Agents and Settings remain views in this Island shell.
  State.view = "prompt";
  const island = new Island(root, transport);
  if (invoke) {
    try {
      await listen<string>("hold-to-talk", ({ payload }) => {
        void invoke("log_debug", { msg: `hold-to-talk listener received: ${payload}` }).catch(() => {});
        if (payload === "pressed") island.talk(true);
        else if (payload === "released") island.talk(false);
      });
      void invoke("log_debug", { msg: "hold-to-talk listener registered" }).catch(() => {});
    } catch (error) {
      console.error("M9R could not register the desktop dictation hotkey listener", error);
      void invoke("log_debug", { msg: `hold-to-talk listener registration FAILED: ${String(error)}` }).catch(() => {});
    }
  } else {
    // No Tauri invoke at this point means no way to log_debug either -- but this itself is
    // the single most important fact if the desktop shell is somehow not being detected.
  }
  // A host that can persist settings (today: the desktop pill) hands back what it saved
  // last; a host with no such transport, or one with nothing saved yet, leaves defaults.
  try {
    const saved = await transport.loadSettings?.();
    if (saved) Object.assign(State.settings, saved);
  } catch { /* defaults still apply */ }
  island.applySettings();
  transport.subscribe((snapshot) => island.applySnapshot(snapshot));
  island.reveal();
}

void main();
