import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const driverSource = readFileSync(resolve("src/lib/native/cua-stage-driver.ts"), "utf8");
const stageSource = readFileSync(resolve("src/lib/native/windows-desktop-stage.ts"), "utf8");

test("production desktop dispatch uses M9R native input and keeps Cua cursor presentation-only", () => {
  assert.doesNotMatch(driverSource, /M9R_ENABLE_CUA_COMPAT/);
  for (const method of ["click", "pressKey", "hotkey", "typeText", "scroll", "drag"]) {
    assert.doesNotMatch(driverSource, new RegExp(`(?:runtime\\.driver|_driver)\\.${method}\\s*\\(`), `${method} must not call the vendored driver directly`);
  }
  assert.match(driverSource, /runtime\.driver\.callTool\("move_cursor"/);
  const nativeDispatches = ["sendClick", "sendKeyCombo", "sendText", "sendScroll", "sendDrag"];
  for (const method of nativeDispatches) assert.match(stageSource, new RegExp(`async function ${method}\\b`));
  assert.match(driverSource, /nativeForeground:\s*nativeStageInput/);
  assert.match(driverSource, /DesktopInputNotDispatchedError/);
});

test("retired extension browser routes fail explicitly while native desktop tools remain registered", () => {
  const mcp = readFileSync(resolve("src/lib/native/computer-use-mcp.ts"), "utf8");
  const server = readFileSync(resolve("src/lib/native/mcp-server.ts"), "utf8");
  assert.doesNotMatch(mcp, /registerTool\("m9r_browser_(?:open|tabs)"/);
  assert.match(mcp, /const RETIRED_BROWSER_ROUTE = "The extension-backed browser route is retired/);
  assert.match(mcp, /if \(target === "browser-tab"\) throw new Error\(RETIRED_BROWSER_ROUTE\)/);
  assert.match(mcp, /server\.registerTool\("m9r_computer_action"/);
  assert.match(mcp, /server\.registerTool\("m9r_computer_observe"/);
  assert.doesNotMatch(mcp, /deps\.web\.(?:run|runBatch)\s*\(/);
  assert.doesNotMatch(server, /WEB_EXTENSION_ROUTE_ENABLED/);
});
