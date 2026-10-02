// Entry point: create the island, connect it to the host's transport, start the intro.

import "./style.css";
import { getTransport } from "./core/transport";
import { Island } from "./island/island";

function main() {
  const root = document.getElementById("root");
  if (!root) return;
  const transport = getTransport();
  const island = new Island(root, transport);
  island.applySettings();
  transport.subscribe((snapshot) => island.applySnapshot(snapshot));
  island.launch();
}

main();
