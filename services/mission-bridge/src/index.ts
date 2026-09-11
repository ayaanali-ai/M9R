/**
 * Standalone CLI entry point for the cloud-hosted deployment path (Render,
 * or any other host with its own MISSION_AGENT_TOKEN/API-key-based agent
 * auth) — see services/mission-bridge/src/bridge-runtime.ts for the actual
 * logic, which this only wires up from env vars. The local-runtime path
 * (scripts/oathlock-terminal-bridge.ts) calls startMissionBridge directly
 * with config derived from the already-authenticated local CLI token
 * instead of going through this file at all.
 */

import { startMissionBridge, type MissionAcpSessionConfig } from "./bridge-runtime";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Mission ACP Bridge.`);
  return value;
}

if (process.env.ACP_BRIDGE_ENABLED?.trim().toLowerCase() !== "true") {
  throw new Error("ACP Bridge is fail-closed. Set ACP_BRIDGE_ENABLED=true before starting it.");
}

// A live ACP bridge without its OathLock dev tools can receive work but cannot
// report it back to the channel. That produces a misleading acknowledgement
// followed by a silent completed turn. Enable the messaging/evidence tool
// surface by default for the bridge, while preserving an explicit read-only
// opt-out for deployments that do not want provider-side channel tools.
if (process.env.MISSION_DEV_MCP_TOOLS_ENABLED?.trim().toLowerCase() !== "false") {
  process.env.MISSION_DEV_MCP_TOOLS_ENABLED = "true";
}

function configuredSessions(): MissionAcpSessionConfig[] {
  const raw = process.env.MISSION_ACP_SESSIONS_JSON?.trim();
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length > 8) throw new Error("MISSION_ACP_SESSIONS_JSON must be an array of at most eight sessions.");
  return parsed.map((value, index) => {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const text = (key: string, fallback = "") => typeof item[key] === "string" && String(item[key]).trim() ? String(item[key]).trim() : fallback;
    const sessionId = text("sessionId");
    const missionId = text("missionId");
    const participantId = text("participantId");
    const providerAdapterId = text("providerAdapterId");
    const dispatchKey = text("dispatchKey", `acp:${index}`);
    const goal = text("goal");
    if (!sessionId || !missionId || !participantId || !providerAdapterId || !goal) throw new Error(`Configured ACP session ${index} is missing required identity or goal fields.`);
    return {
      sessionId, missionId, participantId, providerAdapterId, dispatchKey, goal,
      workingDirectory: text("workingDirectory") || process.env.MISSION_REPOSITORY_ROOT?.trim() || process.cwd(),
      assignmentId: item.assignmentId == null ? null : text("assignmentId"),
      executionConstraints: item.executionConstraints && typeof item.executionConstraints === "object" && !Array.isArray(item.executionConstraints) ? item.executionConstraints as Record<string, unknown> : {},
    };
  });
}

const port = Number.parseInt(process.env.PORT ?? "10000", 10);

void startMissionBridge({
  workspaceId: required("MISSION_WORKSPACE_ID"),
  relayPublicUrl: required("MISSION_RELAY_PUBLIC_URL"),
  relayBridgeToken: required("MISSION_RELAY_BRIDGE_TOKEN"),
  appUrl: required("MISSION_APP_PUBLIC_URL"),
  agentToken: required("MISSION_AGENT_TOKEN"),
  bridgeInstanceId: process.env.MISSION_BRIDGE_INSTANCE_ID?.trim() || undefined,
  repositoryRoot: process.env.MISSION_REPOSITORY_ROOT?.trim() || undefined,
  repositoryId: process.env.MISSION_REPOSITORY_ID?.trim() || null,
  initialSessions: configuredSessions(),
  healthCheckPort: Number.isInteger(port) && port > 0 ? port : 10_000,
}).then((handle) => {
  console.log(`Mission ACP Bridge listening on ${port}.`);
  process.once("SIGTERM", () => { void handle.stop().then(() => process.exit(0)); });
  process.once("SIGINT", () => { void handle.stop().then(() => process.exit(0)); });
}).catch((error) => {
  console.error("Mission Bridge failed to start.", error instanceof Error ? error.message : error);
  process.exit(1);
});
