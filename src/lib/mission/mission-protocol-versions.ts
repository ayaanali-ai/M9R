/**
 * Version identifiers reserved by the realtime Mission execution plan.
 *
 * Keeping these names in one module prevents relay, bridge, runtime-event,
 * message, and Git provenance payloads from inventing incompatible strings as
 * the implementation is built phase by phase.
 */
export const MISSION_PROTOCOL_VERSIONS = {
  mission: "oathlock.mission.v1",
  message: "oathlock.mission-message.v1",
  relay: "oathlock.mission-relay.v1",
  runtimeEvent: "oathlock.mission-runtime-event.v1",
  acpBridge: "oathlock.acp-bridge.v1",
  gitProvenance: "oathlock.mission-git-provenance.v1",
} as const;

export type MissionProtocolName = keyof typeof MISSION_PROTOCOL_VERSIONS;
export type MissionProtocolVersion = (typeof MISSION_PROTOCOL_VERSIONS)[MissionProtocolName];
