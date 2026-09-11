/**
 * Workspace Identity — the durable "who is this workspace, why does it
 * exist" record (see supabase/migrations/20260830010000_workspace_identity.sql).
 * One row per workspace, human-set only. Agents read it through the brief
 * (service-role, see brief.ts); a human reads/writes it here through the
 * cookie-scoped client, so RLS -- not app code -- is what actually enforces
 * "only the workspace owner can set this."
 */

import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";

type Db = NonNullable<Awaited<ReturnType<typeof createClient>>>;

export class WorkspaceIdentityError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message);
  }
}

export interface WorkspaceIdentity {
  workspaceId: string;
  mission: string;
  setByUserId: string;
  createdAt: string;
  updatedAt: string;
}

function toIdentity(row: Record<string, unknown>): WorkspaceIdentity {
  return {
    workspaceId: String(row.workspace_id),
    mission: String(row.mission),
    setByUserId: String(row.set_by_user_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function requireUser(): Promise<{ db: Db; userId: string }> {
  const db = await createClient();
  if (!db) throw new WorkspaceIdentityError("Supabase is not configured.", "DB_NOT_CONFIGURED", 503);
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) throw new WorkspaceIdentityError("Sign in to manage workspace identity.", "UNAUTHENTICATED", 401);
  return { db, userId: user.id };
}

export async function getActiveWorkspaceIdentity(): Promise<WorkspaceIdentity | null> {
  const { db, userId } = await requireUser();
  const workspaceId = await resolveActiveOrDefaultProjectId(db, { id: userId });
  const { data, error } = await db
    .from("workspace_identity")
    .select("workspace_id, mission, set_by_user_id, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new WorkspaceIdentityError(`Could not load workspace identity: ${error.message}`, "READ_FAILED", 500);
  return data ? toIdentity(data) : null;
}

export async function setActiveWorkspaceIdentity(mission: string): Promise<WorkspaceIdentity> {
  const trimmed = mission.trim();
  if (!trimmed) throw new WorkspaceIdentityError("Mission cannot be empty.", "INVALID_MISSION", 400);
  if (trimmed.length > 2000) throw new WorkspaceIdentityError("Mission is too long (2000 characters max).", "INVALID_MISSION", 400);

  const { db, userId } = await requireUser();
  const workspaceId = await resolveActiveOrDefaultProjectId(db, { id: userId });
  const { data, error } = await db
    .from("workspace_identity")
    .upsert(
      { workspace_id: workspaceId, mission: trimmed, set_by_user_id: userId, updated_at: new Date().toISOString() },
      { onConflict: "workspace_id" },
    )
    .select("workspace_id, mission, set_by_user_id, created_at, updated_at")
    .single();
  if (error) throw new WorkspaceIdentityError(`Could not set workspace identity: ${error.message}`, "WRITE_FAILED", 500);
  return toIdentity(data);
}

/** Service-role read for the agent brief (brief.ts) -- no cookie session
 * exists on that path, only a bearer-authenticated agent's own workspaceId. */
export async function getWorkspaceIdentityForAgent(workspaceId: string): Promise<WorkspaceIdentity | null> {
  const { supabase } = await import("@/lib/supabase");
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("workspace_identity")
    .select("workspace_id, mission, set_by_user_id, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) return null;
  return data ? toIdentity(data) : null;
}
