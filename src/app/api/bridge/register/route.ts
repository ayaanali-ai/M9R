import { NextRequest, NextResponse } from "next/server";
import { getMissionConversation } from "@/lib/mission/mission-application-service";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { BRIDGE_PROTOCOL_VERSION } from "@/lib/bridge/bridge-protocol";
import { createSupabaseMissionBridgeStore } from "@/lib/bridge/bridge-store";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../missions/_shared";

export const dynamic = "force-dynamic";

function boundedString(value: unknown, field: string, max: number): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max) throw new MissionApiError(`${field} is required and bounded to ${max} characters.`, "validation_error", 400);
  return result;
}

// POST /api/bridge/register — register a machine-local Bridge and its current
// Mission sessions. Provider credentials never cross this route.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) ?? (typeof body.workspaceId === "string" ? body.workspaceId : null) });
    if (body.protocolVersion !== BRIDGE_PROTOCOL_VERSION) throw new MissionApiError("Unsupported Bridge protocol version.", "validation_error", 400);
    const bridgeInstanceId = boundedString(body.bridgeInstanceId, "bridgeInstanceId", 256);
    const softwareVersion = boundedString(body.softwareVersion, "softwareVersion", 128);
    const repositoryId = body.repositoryId == null ? null : boundedString(body.repositoryId, "repositoryId", 256);
    const supportedProviders = Array.isArray(body.supportedProviders) ? body.supportedProviders.map((provider: unknown) => boundedString(provider, "supportedProviders[]", 128)).slice(0, 32) : [];
    const store = createSupabaseMissionBridgeStore();
    const now = new Date().toISOString();
    const instance = await store.registerInstance({
      id: bridgeInstanceId,
      workspaceId: principal.workspaceId,
      ownerId: principal.actor.id,
      repositoryId,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      softwareVersion,
      supportedProviders,
      now,
    });

    const rawSessions = Array.isArray(body.sessions) ? body.sessions.slice(0, 8) : [];
    const sessions = [];
    for (const raw of rawSessions) {
      const missionId = boundedString(raw?.missionId, "sessions[].missionId", 256);
      const participantId = boundedString(raw?.participantId, "sessions[].participantId", 256);
      if (principal.kind === "agent" && principal.actor.id !== participantId) throw new MissionApiError("An agent Bridge may register only its own Mission participant.", "conflict", 409);
      const conversation = await getMissionConversation(principal, missionId);
      const participant = conversation.participants.find((candidate) => candidate.id === participantId);
      if (!participant || participant.status !== "active") throw new MissionApiError("Bridge session participant is not active in the Mission.", "validation_error", 400);
      sessions.push(await store.registerSession({
        sessionId: boundedString(raw?.sessionId, "sessions[].sessionId", 256),
        bridgeInstanceId,
        workspaceId: principal.workspaceId,
        missionId,
        participantId,
        providerAdapterId: boundedString(raw?.providerAdapterId, "sessions[].providerAdapterId", 128),
        providerSessionRef: raw?.providerSessionRef == null ? null : boundedString(raw.providerSessionRef, "sessions[].providerSessionRef", 512),
        capabilities: raw?.capabilities && typeof raw.capabilities === "object" && !Array.isArray(raw.capabilities) ? raw.capabilities : {},
        now,
      }));
    }
    return NextResponse.json({ instance, sessions }, { status: 201 });
  } catch (err) {
    return handleMissionApiError(err);
  }
}
