import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";

/** Resolve the active workspace from the authenticated cookie, never request input. */
export async function dashboardWorkspaceContext(): Promise<{ userId: string; workspaceId: string } | null> {
  const db = await createClient();
  if (!db) return null;
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  const workspaceId = await resolveActiveOrDefaultProjectId(db, { id: user.id, email: user.email });
  return workspaceId ? { userId: user.id, workspaceId } : null;
}
