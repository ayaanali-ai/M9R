import { supabase } from "@/lib/supabase";
import type { MissionPrincipal } from "./mission-principal";
import { MissionApiError } from "./mission-application-errors";

export interface MissionSearchResultDto {
  missionId: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
  actor: { kind: string; id: string } | null;
  snippet: string;
}

export async function searchMissionWorkspace(principal: MissionPrincipal, query: string, limit = 50): Promise<{ query: string; results: MissionSearchResultDto[] }> {
  const normalized = query.trim().slice(0, 200);
  if (normalized.length < 2) throw new MissionApiError("Search needs at least two characters.", "validation_error", 400);
  if (!supabase) throw new MissionApiError("M9R is not configured.", "backend_not_configured", 503);
  const { data, error } = await supabase.rpc("search_mission_workspace", {
    p_workspace_id: principal.workspaceId,
    p_query: normalized,
    p_limit: Math.min(Math.max(limit, 1), 100),
  });
  if (error) throw new Error(`Failed to search Mission workspace: ${error.message}`);
  return {
    query: normalized,
    results: (data ?? []).map((row: Record<string, unknown>) => {
      const actor = row.actor && typeof row.actor === "object" && !Array.isArray(row.actor) ? row.actor as Record<string, unknown> : null;
      return {
        missionId: String(row.mission_id),
        eventId: String(row.event_id),
        eventType: String(row.event_type),
        occurredAt: String(row.occurred_at),
        actor: actor && typeof actor.kind === "string" && typeof actor.id === "string" ? { kind: actor.kind, id: actor.id } : null,
        snippet: String(row.snippet ?? ""),
      };
    }),
  };
}
