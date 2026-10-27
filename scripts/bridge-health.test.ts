import assert from "node:assert/strict";
import test from "node:test";
import { missionBridgeLogIsUnhealthy } from "@/lib/bridge/bridge-health";

test("a live sibling bridge's duplicate-lock refusal and clean exit is not a provider crash", () => {
  const observedLog = [
    "[2026-10-12T23:30:49.784Z] Mission ACP Bridge (A live Mission Bridge already holds the lock) -- exiting, the existing process stays up.",
    "[2026-10-12T23:30:50.050Z] [supervisor] child exited with code 0",
  ].join("\n");

  assert.equal(missionBridgeLogIsUnhealthy(observedLog), false);
});

test("a genuine bridge startup failure after the latest healthy start remains unhealthy", () => {
  const log = [
    "[2026-10-12T23:30:00.000Z] Mission ACP Bridge is running locally (provider connection).",
    "[2026-10-12T23:30:10.000Z] Mission ACP Bridge did not start (workspace_unresolvable).",
    "[2026-10-12T23:30:10.250Z] [supervisor] child exited with code 0",
  ].join("\n");

  assert.equal(missionBridgeLogIsUnhealthy(log), true);
});

test("a duplicate runner clean exit cannot mask a preceding Relay authentication failure", () => {
  const log = [
    "[2026-10-13T04:43:50.000Z] Mission ACP Bridge is running locally (provider connection).",
    "[2026-10-13T04:43:51.000Z] Mission Relay rejected Bridge authentication.",
    "[2026-10-13T04:43:55.761Z] Mission ACP Bridge (A live Mission Bridge already holds the lock) -- exiting, the existing process stays up.",
    "[2026-10-13T04:43:56.033Z] [supervisor] child exited with code 0",
  ].join("\n");

  assert.equal(missionBridgeLogIsUnhealthy(log), true);
});

test("Relay authentication rejection is unhealthy even before supervisor exit", () => {
  assert.equal(
    missionBridgeLogIsUnhealthy("[2026-10-13T04:43:51.000Z] Mission Relay rejected Bridge authentication."),
    true,
  );
});

test("a duplicate runner clean exit cannot mask a preceding explicit startup failure", () => {
  const log = [
    "[2026-10-13T04:43:55.000Z] Mission ACP Bridge did not start (workspace_unresolvable).",
    "[2026-10-13T04:43:56.000Z] Mission ACP Bridge (A live Mission Bridge already holds the lock) -- exiting, the existing process stays up.",
    "[2026-10-13T04:43:56.250Z] [supervisor] child exited with code 0",
  ].join("\n");

  assert.equal(missionBridgeLogIsUnhealthy(log), true);
});

test("an unexpected non-zero runner exit is unhealthy, while an unclassified clean exit is not proof of failure", () => {
  assert.equal(missionBridgeLogIsUnhealthy("[2026-10-12T23:30:10.250Z] [supervisor] child exited with code 3221226505"), true);
  assert.equal(missionBridgeLogIsUnhealthy("[2026-10-12T23:30:10.250Z] [supervisor] child exited with code 0"), false);
});
