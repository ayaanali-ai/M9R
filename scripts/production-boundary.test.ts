import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("the shipped desktop runtime has one broker-owned provider entrypoint", () => {
  const broker = read("scripts/m9r-web-broker.ts");
  assert.match(broker, /createManagedProviderOwner/);
  assert.doesNotMatch(broker, /createWebLiveSessions/);
  assert.match(broker, /legacy browser-extension[\s\S]*intentionally not enabled/);
});

test("the canonical desktop pill cannot fall back to legacy feed or session-link commands", () => {
  const desktop = read("pill/src/shells/desktop.ts");
  const tauri = read("overlay/src-tauri/src/main.rs");
  assert.doesNotMatch(desktop, /read_feed|list_sessions|link_sessions/);
  assert.doesNotMatch(tauri.match(/generate_handler!\[[\s\S]*?\]/)?.[0] ?? "", /read_feed|list_sessions|link_sessions|\bdecide\b/);
  assert.match(desktop, /read_pill_state/);
  assert.match(desktop, /pill_decide/);
});

test("the installer refuses the retired provider-hook transport", () => {
  const installer = read("scripts/install-m9r.ps1");
  const builder = read("scripts/build-engine.mjs");
  assert.match(installer, /legacy browser-extension\/provider-hook transport is retired/i);
  assert.match(builder, /legacy provider hook path has been removed/i);
});
