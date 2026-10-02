// Entry point: create the island, connect it to the host's transport, start the intro.

import "./style.css";
import { getTransport } from "./core/transport";
import { chromeRuntime, createExtensionTransport } from "./shells/extension";
import { createDesktopTransport, tauriInvoke } from "./shells/desktop";
import { Island } from "./island/island";

function main() {
  const root = document.getElementById("root");
  if (!root) return;
  // The host decides how the pill reaches its data: an extension frame, the desktop window, or (developer) the mock.
  const runtime = chromeRuntime();
  const invoke = tauriInvoke();
  const transport = window.__M9R_PILL_TRANSPORT__
    ?? (runtime ? createExtensionTransport(runtime) : invoke ? createDesktopTransport(invoke) : getTransport());
  const island = new Island(root, transport);
  island.applySettings();
  transport.subscribe((snapshot) => island.applySnapshot(snapshot));
  island.launch();
}

main();
