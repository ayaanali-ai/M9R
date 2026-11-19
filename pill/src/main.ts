// Entry point: create the island, connect it to the host's transport, start the intro.

import notchTemplate from "../notch-preview.html?raw";
import { listen } from "@tauri-apps/api/event";
import { getTransport } from "./core/transport";
import { createDesktopTransport, tauriInvoke } from "./shells/desktop";
import { Island } from "./island/island";
import { State } from "./core/state";

async function main() {
  const controls = new URLSearchParams(location.search).get("controls");
  if (!controls) {
    await import("./notch-preview.css");
    const notch = new DOMParser().parseFromString(notchTemplate, "text/html").querySelector("main");
    if (!notch) throw new Error("The bundled notch template is missing.");
    document.body.replaceChildren(notch);
    await import("./notch-preview.js");
    return;
  }
  await import("./style.css");
  const root = document.getElementById("root");
  if (!root) return;
  const invoke = tauriInvoke();
  // The pill is a broker-owned desktop surface. Browser-extension/frame transports
  // were retired with the extension route; a mock transport is kept only for
  // local component development outside the Tauri shell.
  const transport = window.__M9R_PILL_TRANSPORT__
    ?? (invoke ? createDesktopTransport(invoke) : getTransport());
  const island = new Island(root, transport);
  const chat = document.createElement("button");
  chat.className = "tab";
  chat.textContent = "Chat";
  chat.title = "Return to the main conversation";
  chat.onclick = () => location.assign(location.pathname);
  root.querySelector(".tabs")?.append(chat);
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
  island.setView(controls === "settings" ? "settings" : State.defaultView());
}

void main();
