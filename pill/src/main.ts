// Entry point: create the island, connect it to the host's transport, start the intro.

import "./style.css";
import { listen } from "@tauri-apps/api/event";
import { getTransport } from "./core/transport";
import { chromeRuntime, createExtensionTransport } from "./shells/extension";
import { createFrameHost } from "./shells/frame-host";
import { createDesktopTransport, tauriInvoke } from "./shells/desktop";
import { Island } from "./island/island";
import { State } from "./core/state";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;
  // The host decides how the pill reaches its data: an extension frame, the desktop window, or (developer) the mock.
  const runtime = chromeRuntime();
  const invoke = tauriInvoke();
  const base = window.__M9R_PILL_TRANSPORT__
    ?? (runtime ? createExtensionTransport(runtime) : invoke ? createDesktopTransport(invoke) : getTransport());
  // In a page frame the window hooks talk to the embedding content script; the desktop window handles its own.
  const frame = runtime && window.parent !== window ? createFrameHost(base) : null;
  const transport = frame ? frame.transport : base;
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
  frame?.onHostCommand((kind, data) => {
    if (kind === "open-message") island.openMessage();
    else if (kind === "talk") island.talk(data.active === true);
  });
  // A host that can persist settings (today: the desktop pill) hands back what it saved
  // last; a host with no such transport, or one with nothing saved yet, leaves defaults.
  try {
    const saved = await transport.loadSettings?.();
    if (saved) Object.assign(State.settings, saved);
  } catch { /* defaults still apply */ }
  island.applySettings();
  transport.subscribe((snapshot) => island.applySnapshot(snapshot));
  island.launch();
}

void main();
