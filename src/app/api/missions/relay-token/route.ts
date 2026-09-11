import { NextRequest, NextResponse } from "next/server";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { isMissionFeatureEnabled } from "@/lib/mission/mission-feature-flags";
import { mintMissionRelayToken } from "@/lib/mission/mission-relay-token";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function websocketUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  throw new MissionApiError("MISSION_RELAY_PUBLIC_URL must be an http(s) or ws(s) URL.", "backend_not_configured", 503);
}

/** Mint a short-lived browser credential; the signing secret never leaves the server. */
export async function GET(req: NextRequest) {
  try {
    if (!isMissionFeatureEnabled("missionRelay")) throw new MissionApiError("Mission Relay is disabled for this deployment.", "conflict", 409);
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req), requireHuman: true });
    const publicUrl = process.env.MISSION_RELAY_PUBLIC_URL?.trim();
    if (!publicUrl || !process.env.MISSION_RELAY_TOKEN_SECRET) throw new MissionApiError("Mission Relay is not configured for this deployment.", "backend_not_configured", 503);
    const token = mintMissionRelayToken({ subject: principal.actor.id, kind: "human", workspaceId: principal.workspaceId, ttlSeconds: 300 });
    return NextResponse.json({ relayUrl: websocketUrl(publicUrl), workspaceId: principal.workspaceId, participantId: principal.actor.id, expiresInSeconds: 300, token }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleMissionApiError(error);
  }
}
