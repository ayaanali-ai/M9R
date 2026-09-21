import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  isMissionFeatureEnabled,
  MISSION_FEATURE_FLAGS,
  readMissionFeatureFlags,
} from "../src/lib/mission/mission-feature-flags.ts";
import { MISSION_PROTOCOL_VERSIONS } from "../src/lib/mission/mission-protocol-versions.ts";
import { buildCodexLaunchSpec } from "../src/lib/resident-provider-adapters.ts";

test("Mission feature flags fail closed and enable only explicit truthy values", () => {
  assert.deepEqual(readMissionFeatureFlags({}), {
    missionRelay: false,
    acpBridge: false,
    runtimeEvents: false,
    gitProvenance: false,
    channelMissionBinding: false,
    channelWorkflows: false,
    devMcpTools: false,
  });

  const flags = readMissionFeatureFlags({
    MISSION_RELAY_ENABLED: "1",
    ACP_BRIDGE_ENABLED: "true",
    MISSION_RUNTIME_EVENTS_ENABLED: " ON ",
    MISSION_GIT_PROVENANCE_ENABLED: "yes",
  });
  assert.deepEqual(flags, {
    missionRelay: true,
    acpBridge: true,
    runtimeEvents: true,
    gitProvenance: false,
    channelMissionBinding: false,
    channelWorkflows: false,
    devMcpTools: false,
  });
  assert.equal(isMissionFeatureEnabled("missionRelay", { [MISSION_FEATURE_FLAGS.missionRelay]: "TRUE" }), true);
});

test("Mission protocol versions are unique and centrally named", () => {
  const versions = Object.values(MISSION_PROTOCOL_VERSIONS);
  assert.equal(new Set(versions).size, versions.length);
  assert.equal(MISSION_PROTOCOL_VERSIONS.mission, "oathlock.mission.v1");
  assert.equal(MISSION_PROTOCOL_VERSIONS.relay, "oathlock.mission-relay.v1");
  assert.equal(MISSION_PROTOCOL_VERSIONS.acpBridge, "oathlock.acp-bridge.v1");
});

test("resident provider prompts permit bounded Mission requests without direct provider launches", () => {
  const spec = buildCodexLaunchSpec({
    grantId: "phase-0-grant",
    repositoryRoot: resolve(process.cwd()),
    task: "Inspect the bounded Mission contract.",
    allowedPaths: ["src"],
    prohibitedPaths: [".env", ".oathlock/local.json"],
    maxDurationMs: 60_000,
    executionMode: "read_only",
  }, "codex");

  assert.match(spec.stdin, /request bounded work from authorized Mission participants through (?:OathLock|M9R)'s collaboration protocol/i);
  assert.match(spec.stdin, /do not launch another provider directly/i);
  assert.doesNotMatch(spec.stdin, /Do not delegate to another agent\./);
});
