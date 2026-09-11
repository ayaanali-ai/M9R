import { MISSION_PROTOCOL_VERSIONS } from "@/lib/mission/mission-protocol-versions";

export const BRIDGE_PROTOCOL_VERSION = MISSION_PROTOCOL_VERSIONS.acpBridge;

export interface BridgeIdentity {
  bridgeInstanceId: string;
  workspaceId: string;
  ownerId: string;
  repositoryId: string | null;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  softwareVersion: string;
}

export interface BridgeHeartbeat {
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  bridgeInstanceId: string;
  sequence: number;
  sentAt: string;
  activeSessionIds: string[];
}

export function validateBridgeHeartbeat(value: unknown): value is BridgeHeartbeat {
  if (!value || typeof value !== "object") return false;
  const heartbeat = value as Partial<BridgeHeartbeat>;
  return heartbeat.protocolVersion === BRIDGE_PROTOCOL_VERSION
    && typeof heartbeat.bridgeInstanceId === "string"
    && heartbeat.bridgeInstanceId.length > 0
    && heartbeat.bridgeInstanceId.length <= 256
    && typeof heartbeat.sequence === "number"
    && Number.isInteger(heartbeat.sequence)
    && heartbeat.sequence >= 0
    && typeof heartbeat.sentAt === "string"
    && Number.isFinite(Date.parse(heartbeat.sentAt))
    && Array.isArray(heartbeat.activeSessionIds)
    && heartbeat.activeSessionIds.length <= 8
    && new Set(heartbeat.activeSessionIds).size === heartbeat.activeSessionIds.length
    && heartbeat.activeSessionIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256);
}
