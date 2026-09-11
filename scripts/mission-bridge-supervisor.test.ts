import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync("scripts/oathlock-terminal-bridge.ts", "utf8");

test("local terminal bridge supervises each provider child instead of leaving crashes orphaned", () => {
  assert.match(source, /createResidentSupervisor/);
  assert.match(source, /maxRestarts:\s*3/);
  assert.match(source, /missionBridgeSupervisor\.start\(\)/);
});

test("local terminal bridge shuts down the supervisor before closing its server", () => {
  assert.match(source, /missionBridgeSupervisor\?\.stop\(\)/);
  assert.match(source, /for \(const client of wss\.clients\)/);
});

test("local terminal bridge keeps the tsx CommonJS startup path free of top-level await", () => {
  assert.doesNotMatch(source, /^const connectedProviders = await connectedLocalProviders\(\)/m);
  assert.match(source, /async function startMissionBridgeChildren/);
});

/**
 * Was stdio: ["ignore","ignore","ignore"] -- headless, but a bridge that
 * silently refused to start a session (bad mention match, lookup failure,
 * ACP launch error) had its console.error go nowhere, with no terminal open
 * to see it. stdout/stderr are now piped into a real per-provider log file
 * instead -- still headless (windowsHide stays true, no visible console),
 * but now actually diagnosable.
 */
test("local mission bridge children do not surface visible Windows consoles, and their stdout/stderr are captured to a real log instead of being discarded", () => {
  assert.match(source, /stdio:\s*\[\s*["']ignore["']\s*,\s*["']pipe["']\s*,\s*["']pipe["']\s*\]/);
  assert.match(source, /windowsHide:\s*true/);
  assert.doesNotMatch(source, /stdio:\s*["']inherit["']/);
  assert.match(source, /createWriteStream\(resolve\(missionBridgeLogDir, `\$\{provider\}\.log`\), \{ flags: "a" \}\)/);
  assert.match(source, /child\.stdout\?\.on\("data"/);
  assert.match(source, /child\.stderr\?\.on\("data"/);
});
