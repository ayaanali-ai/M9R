/**
 * Phase 0 feature gates for the realtime Mission execution plan.
 *
 * These are intentionally server-side and opt-in. A flag only makes a later
 * phase's code path available; it does not grant authority, bypass Mission
 * commands, or replace the existing legacy compatibility paths.
 */

export const MISSION_FEATURE_FLAGS = {
  missionRelay: "MISSION_RELAY_ENABLED",
  acpBridge: "ACP_BRIDGE_ENABLED",
  runtimeEvents: "MISSION_RUNTIME_EVENTS_ENABLED",
  gitProvenance: "MISSION_GIT_PROVENANCE_ENABLED",
  channelMissionBinding: "MISSION_CHANNEL_BINDING_ENABLED",
  channelWorkflows: "MISSION_CHANNEL_WORKFLOWS_ENABLED",
  devMcpTools: "MISSION_DEV_MCP_TOOLS_ENABLED",
} as const;

export type MissionFeatureFlag = keyof typeof MISSION_FEATURE_FLAGS;
export type MissionFeatureFlags = Record<MissionFeatureFlag, boolean>;
export type MissionFeatureFlagEnvironment = Readonly<Record<string, string | undefined>>;

function isEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

/** Read all Mission flags without exposing the process environment to callers. */
export function readMissionFeatureFlags(env: MissionFeatureFlagEnvironment = process.env): MissionFeatureFlags {
  return {
    missionRelay: isEnabled(env[MISSION_FEATURE_FLAGS.missionRelay]),
    acpBridge: isEnabled(env[MISSION_FEATURE_FLAGS.acpBridge]),
    runtimeEvents: isEnabled(env[MISSION_FEATURE_FLAGS.runtimeEvents]),
    gitProvenance: isEnabled(env[MISSION_FEATURE_FLAGS.gitProvenance]),
    channelMissionBinding: isEnabled(env[MISSION_FEATURE_FLAGS.channelMissionBinding]),
    channelWorkflows: isEnabled(env[MISSION_FEATURE_FLAGS.channelWorkflows]),
    devMcpTools: isEnabled(env[MISSION_FEATURE_FLAGS.devMcpTools]),
  };
}

/** Check one flag using the same fail-closed parsing as the full reader. */
export function isMissionFeatureEnabled(flag: MissionFeatureFlag, env: MissionFeatureFlagEnvironment = process.env): boolean {
  return isEnabled(env[MISSION_FEATURE_FLAGS[flag]]);
}
