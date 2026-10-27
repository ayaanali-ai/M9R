/**
 * Cursor/agent color resolution (owner decision, 2026-10-18): a workspace with more than one
 * distinct human in it colors by PERSON -- every agent a given person connected shares their one
 * permanent color, allocated via the `allocate_workspace_member_color` Postgres function so two
 * concurrent requests for the same new member can never race to different colors. A solo
 * workspace (exactly one human) colors by AGENT instead, using the existing static brand-color
 * map -- unchanged from before this file existed.
 *
 * This only resolves the color for one connection at a time; it does not decide where it's
 * displayed. The dashboard/pill-facing components resolve this through the shared connection
 * color hook, while native feed snapshots use the same allocator directly.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENT_BRAND_COLOR } from "@/lib/agent-brand-color";

const NEUTRAL_FALLBACK = "#9CA3AF";

export interface AgentColorTarget {
  workspaceId: string;
  /** The user_id that connected this agent (agent_connections.created_by). */
  connectedBy: string | null;
  agentKind: string;
}

/** How many distinct humans actually own a connection in this workspace right now -- the only
 *  thing that decides per-person vs per-agent coloring. Revoked connections don't count: someone
 *  who disconnected every agent they had isn't "in the room" for coloring purposes. */
export async function workspaceHumanCount(supabase: SupabaseClient, workspaceId: string): Promise<number> {
  const { data, error } = await supabase
    .from("agent_connections")
    .select("created_by")
    .eq("workspace_id", workspaceId)
    .is("revoked_at", null)
    .not("created_by", "is", null);
  if (error || !data) return 1; // Fail toward solo/per-agent coloring, never toward an unproven multi-person claim.
  return new Set((data as Array<{ created_by: string }>).map((row) => row.created_by)).size;
}

export async function resolveAgentColor(supabase: SupabaseClient, target: AgentColorTarget): Promise<string> {
  const humanCount = await workspaceHumanCount(supabase, target.workspaceId);
  if (humanCount > 1 && target.connectedBy) {
    const { data, error } = await supabase.rpc("allocate_workspace_member_color", {
      p_workspace_id: target.workspaceId,
      p_user_id: target.connectedBy,
    });
    if (!error && typeof data === "string" && data) return data;
    // A failed allocation call must not crash whatever is rendering a cursor/mark; fall through
    // to the same per-agent color a solo workspace would use, rather than throw.
  }
  return AGENT_BRAND_COLOR[target.agentKind] ?? NEUTRAL_FALLBACK;
}
