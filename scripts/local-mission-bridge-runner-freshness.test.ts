import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const runnerSource = readFileSync("src/lib/bridge/local-mission-bridge-runner.ts", "utf8");
const bridgeRuntimeSource = readFileSync("services/mission-bridge/src/bridge-runtime.ts", "utf8");

/**
 * Confirmed live this session: the resident-run self-restart (checkBuildFreshness
 * in oathlock-cli.ts) restarted correctly on a rebuild, but this long-lived child
 * -- the one actually holding live ACP sessions -- kept running stale code
 * underneath it. Fixing that naively (exit the instant staleness is detected)
 * would have reintroduced the exact "ACP connection closed" failure confirmed
 * live tonight: killing a process mid-turn tears down real, in-flight work with
 * no warning. The fix has to defer the exit while a turn is active, not just
 * exist at all.
 */
test("the bridge-runtime handle exposes hasActiveWork so a caller can tell if a turn is in flight", () => {
  assert.match(bridgeRuntimeSource, /hasActiveWork\(\): boolean;/);
  assert.match(bridgeRuntimeSource, /function hasActiveWork\(\): boolean \{\s*return activeWorkspacePrompts\.size > 0;/);
  assert.match(bridgeRuntimeSource, /return \{ controller, bridgeInstanceId, startSession, stop, hasActiveWork, events: bridgeEvents \};/);
});

test("the runner's freshness watcher defers a detected-stale restart while hasActiveWork() is true, instead of exiting immediately", () => {
  const start = runnerSource.indexOf("function watchBuildFreshness");
  const end = runnerSource.indexOf("startLocalMissionBridge(repositoryRoot)", start);
  assert.ok(start >= 0 && end > start, "watchBuildFreshness must remain a standalone, locatable function");
  const block = runnerSource.slice(start, end);
  assert.match(block, /hasActiveWork\(\) && !deferredTooLong/);
  assert.match(block, /return;/);
});

test("deferral is bounded, not an unbounded wait -- a continuously busy bridge still restarts eventually", () => {
  assert.match(runnerSource, /const STALE_BUILD_MAX_DEFER_MS = 10 \* 60_000;/);
  assert.match(runnerSource, /deferredTooLong = Date\.now\(\) - staleSince >= STALE_BUILD_MAX_DEFER_MS/);
});

test("watchBuildFreshness only starts once the bridge handle actually exists, not before", () => {
  const start = runnerSource.indexOf("startLocalMissionBridge(repositoryRoot)");
  const end = runnerSource.indexOf("process.once(\"SIGTERM\"", start);
  assert.ok(start >= 0 && end > start, "bridge startup block must remain explicit");
  const block = runnerSource.slice(start, end);
  assert.match(block, /watchBuildFreshness\(result\.handle\.hasActiveWork\);/);
});
