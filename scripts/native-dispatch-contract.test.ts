import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const driverSource = readFileSync(resolve("src/lib/native/cua-stage-driver.ts"), "utf8");
const stageSource = readFileSync(resolve("src/lib/native/windows-desktop-stage.ts"), "utf8");

test("production desktop dispatch uses M9R native input and its own cursor presentation path", () => {
  assert.doesNotMatch(driverSource, /M9R_ENABLE_CUA_COMPAT/);
  for (const method of ["click", "pressKey", "hotkey", "typeText", "scroll", "drag"]) {
    assert.doesNotMatch(driverSource, new RegExp(`(?:runtime\\.driver|_driver)\\.${method}\\s*\\(`), `${method} must not call the vendored driver directly`);
  }
  assert.match(driverSource, /async function updateM9rCursorOverlay/);
  assert.match(driverSource, /async function presentM9rCursor/);
  assert.match(driverSource, /createAgentCursorOverlayHost/);
  assert.doesNotMatch(driverSource, /(?:runtime\.driver|_driver)\.(?:moveCursor|setAgentCursorEnabled)\s*\(/,
    "cursor movement and visibility are not delegated to CUA");
  assert.doesNotMatch(driverSource, /runtime\.driver\.callTool\("move_cursor"/,
    "the CUA move_cursor tool is not part of the live presentation path");
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

test("background stage app selection documents attach-only behavior", () => {
  const server = readFileSync(resolve("src/lib/native/mcp-server.ts"), "utf8");
  const start = server.indexOf('server.registerTool("m9r_stage_app"');
  const end = server.indexOf('server.registerTool("m9r_stage_action"', start);
  assert.ok(start >= 0 && end > start, "stage app tool registration is present");
  const stageAppTool = server.slice(start, end);
  assert.match(stageAppTool, /mode=background, operation=launch is attach-only/);
  assert.match(stageAppTool, /without starting, presenting, or focusing an app/);
  assert.match(stageAppTool, /refuses when there are zero or multiple matches/);
});
