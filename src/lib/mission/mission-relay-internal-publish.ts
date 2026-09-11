import type { RelayServerFrameType } from "./mission-relay-protocol";

/**
 * Item #21 Phase 6's resolved relay-ingest gap: the one way a stateless
 * Next.js API route (an MCP tool call landing as an HTTP request, not a
 * live relay socket) can push a frame into a room. Calls the Mission
 * Relay's own `/internal/*` HTTP surface (services/mission-relay/src/server.ts),
 * authenticated with the same MISSION_RELAY_TOKEN_SECRET both processes
 * already hold -- no new secret provisioned.
 */

function relayBaseUrl(): string {
  const configured = process.env.MISSION_RELAY_PUBLIC_URL?.trim() || "https://m9r-mission-relay.onrender.com";
  return configured.replace(/\/+$/, "");
}

function internalSecret(): string {
  const secret = process.env.MISSION_RELAY_TOKEN_SECRET?.trim();
  if (!secret) throw new Error("Mission Relay is not configured (MISSION_RELAY_TOKEN_SECRET missing).");
  return secret;
}

export interface LivePtySessionRoom {
  channelId: string;
  ownerConnectionId: string;
  status: "running" | "exited";
}

/** Resolves a live terminal session's own room -- the server-side half of item #21 Phase 6's security boundary ("verifies the sending connection and the target session are in the same room"). Returns null if the session doesn't exist or its owner is offline (see Phase 6's named risk (c): the caller must turn this into a real error, never a silent no-op). */
export async function lookupLivePtySessionRoom(workspaceId: string, sessionId: string): Promise<LivePtySessionRoom | null> {
  const url = `${relayBaseUrl()}/internal/pty-session/${encodeURIComponent(sessionId)}?workspaceId=${encodeURIComponent(workspaceId)}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${internalSecret()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not reach the Mission Relay (HTTP ${response.status}).`);
  return await response.json() as LivePtySessionRoom;
}

/** Publishes one server-originated frame into a live room. Throws rather than swallowing a failure -- a handoff (or any future internal-ingest caller) that silently dropped would violate Phase 6's own named risk (c): "return a real error to the tool rather than silently dropping." */
export async function publishInternalRelayFrame(input: { workspaceId: string; channelId: string; type: RelayServerFrameType; payload: Record<string, unknown> }): Promise<void> {
  const response = await fetch(`${relayBaseUrl()}/internal/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${internalSecret()}`, "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Could not publish to the Mission Relay (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }
}
