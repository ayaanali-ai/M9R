import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const driverSource = readFileSync(resolve("src/lib/native/cua-stage-driver.ts"), "utf8");
const stageSource = readFileSync(resolve("src/lib/native/windows-desktop-stage.ts"), "utf8");

test("production desktop dispatch has one native input engine", () => {
  assert.match(driverSource, /const allowCuaCompatibility = deps\.stage\?\.env\?\.M9R_ENABLE_CUA_COMPAT === "1"/);
  assert.match(driverSource, /if \(allowCuaCompatibility && !deps\.ownerPointer\)/);
  for (const method of ["click", "pressKey", "hotkey", "typeText", "scroll", "drag"]) {
    assert.doesNotMatch(driverSource, new RegExp(`(?:runtime\\.driver|_driver)\\.${method}\\s*\\(`), `${method} must not call the vendored driver directly`);
  }
  const nativeDispatches = ["sendClick", "sendKeyCombo", "sendText", "sendScroll", "sendDrag"];
  for (const method of nativeDispatches) assert.match(stageSource, new RegExp(`async function ${method}\\b`));
  assert.match(driverSource, /nativeForeground:\s*nativeStageInput/);
  assert.match(driverSource, /DesktopInputNotDispatchedError/);
});

test("retired browser and isolated routes are not registered", () => {
  const mcp = readFileSync(resolve("src/lib/native/computer-use-mcp.ts"), "utf8");
  const server = readFileSync(resolve("src/lib/native/mcp-server.ts"), "utf8");
  assert.doesNotMatch(mcp, /registerTool\("m9r_browser_(?:open|tabs)"/);
  assert.match(server, /const WEB_EXTENSION_ROUTE_ENABLED = false/);
  assert.match(server, /extension-backed browser route is retired/i);
});
