/**
 * Autonomous mention-triggered spawning (the local ACP bridge started by
 * `oathlock terminal runtime`) is now the intended default experience, not
 * an experimental opt-in — per an explicit founder decision after this
 * product was compared against Buzz's own mention-triggers-work model.
 * Locks in: the gate defaults to enabled, an explicit "false" still opts
 * out, and the deeper AcpSessionController check (several layers down,
 * reads process.env directly) is kept consistent rather than silently
 * disagreeing with the outer gate's decision.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

test("the local bridge gate defaults to enabled and only opts out on an explicit false", () => {
  const src = read("src/lib/bridge/local-mission-bridge-bootstrap.ts");
  const fn = src.slice(src.indexOf("export async function startLocalMissionBridge"));
  assert.match(fn, /ACP_BRIDGE_ENABLED\?\.trim\(\)\.toLowerCase\(\) === "false"/, "must opt OUT on an explicit false");
  assert.doesNotMatch(fn, /!== "true"/, "must not require an explicit true to enable");
});

test("the outer gate sets the literal env var so the deeper AcpSessionController check agrees with it", () => {
  const src = read("src/lib/bridge/local-mission-bridge-bootstrap.ts");
  const fn = src.slice(src.indexOf("export async function startLocalMissionBridge"));
  assert.match(fn, /process\.env\.ACP_BRIDGE_ENABLED = "true"/);
  // The set must happen after the opt-out check, not before (an explicit
  // false must still win).
  const optOutIndex = fn.indexOf('=== "false"');
  const setIndex = fn.indexOf('process.env.ACP_BRIDGE_ENABLED = "true"');
  assert.ok(optOutIndex > -1 && setIndex > optOutIndex, "opt-out check must run before the default is applied");
});

test("the local bridge enables OathLock messaging tools by default, with an explicit read-only opt-out", () => {
  const src = read("src/lib/bridge/local-mission-bridge-bootstrap.ts");
  const fn = src.slice(src.indexOf("export async function startLocalMissionBridge"));
  assert.match(fn, /MISSION_DEV_MCP_TOOLS_ENABLED\?\.trim\(\)\.toLowerCase\(\) !== "false"/);
  assert.match(fn, /process\.env\.MISSION_DEV_MCP_TOOLS_ENABLED = "true"/);
});

test("the standalone bridge enables OathLock messaging tools by default too", () => {
  const src = read("services/mission-bridge/src/index.ts");
  assert.match(src, /MISSION_DEV_MCP_TOOLS_ENABLED\?\.trim\(\)\.toLowerCase\(\) !== "false"/);
  assert.match(src, /process\.env\.MISSION_DEV_MCP_TOOLS_ENABLED = "true"/);
});

test("a local provider bridge renews the server-side presence lease", () => {
  const bridge = read("services/mission-bridge/src/bridge-runtime.ts");
  assert.match(bridge, /\/api\/agent\/presence\/heartbeat/);
  assert.match(bridge, /HEARTBEAT_PROTOCOL_VERSION/);
  assert.match(bridge, /executionOrigin: "linked"/);
  assert.match(bridge, /presenceTimer = setInterval/);
  assert.match(bridge, /refreshOwnConnectionId/);
});

test("the machine runtime reconciles provider profiles after startup", () => {
  const supervisor = read("src/lib/resident-supervisor.ts");
  const bridge = read("scripts/oathlock-terminal-bridge.ts");
  assert.match(supervisor, /syncProfiles\(profiles: string\[\]\)/);
  assert.match(bridge, /missionBridgeSyncTimer = setInterval/);
  assert.match(bridge, /missionBridgeSupervisor\?\.syncProfiles/);
  assert.match(read("src/lib/bridge/local-mission-bridge-bootstrap.ts"), /local-\$\{local\.provider\}-\$\{randomUUID\(\)\}/);
});

test("CLI init keeps the local runtime explicitly optional and experimental", () => {
  const cli = read("src/lib/oathlock-cli-core.ts");
  assert.match(cli, /browser multiplayer is ready/i);
  assert.match(cli, /optional and experimental/i);
  assert.match(cli, /npx m9r-cli terminal runtime/);
  assert.match(cli, /ACP_BRIDGE_ENABLED=false/, "the opt-out path must still be documented");
});

test("USAGE text does not market the experimental terminal runtime as the product", () => {
  const cli = read("src/lib/oathlock-cli-core.ts");
  const usage = cli.slice(cli.indexOf("const USAGE ="));
  assert.match(usage, /optional|experimental/i);
  assert.match(usage, /ACP_BRIDGE_ENABLED=false/);
  assert.match(usage, /browser|Watchfloor/i);
});
