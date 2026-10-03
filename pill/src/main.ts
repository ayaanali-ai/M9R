// Entry point: create the island, connect it to the host's transport, start the intro.

import "./style.css";
import { getTransport } from "./core/transport";
import { chromeRuntime, createExtensionTransport } from "./shells/extension";
import { createFrameHost } from "./shells/frame-host";
import { createDesktopTransport, tauriInvoke } from "./shells/desktop";
import { Island } from "./island/island";

function main() {
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
  frame?.onHostCommand((kind, data) => {
    if (kind === "open-message") island.openMessage();
    else if (kind === "talk") island.talk(data.active === true);
  });
  island.applySettings();
  transport.subscribe((snapshot) => island.applySnapshot(snapshot));
  island.launch();
}

main();
