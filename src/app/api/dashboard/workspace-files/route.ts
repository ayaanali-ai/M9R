import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { listWorkspaceFileSummary } from "@/lib/bridge/workspace-file-activity-service";

async function currentUserAndWorkspace(): Promise<{ userId: string; workspaceId: string } | null> {
  const db = await createClient();
  if (!db) return null;
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  let workspaceId: string;
  try {
    workspaceId = await resolveActiveOrDefaultProjectId(db, { id: user.id, email: user.email });
  } catch {
    return null;
  }
  return { userId: user.id, workspaceId };
}

/** GET the Files panel's tree data: one row per file any connected agent has
 * actually touched in this workspace, most recent activity only (see
 * listWorkspaceFileSummary's own doc comment for why this can never be a
 * live disk listing). */
export async function GET() {
  const ctx = await currentUserAndWorkspace();
  if (!ctx) return NextResponse.json({ files: [] });
  const files = await listWorkspaceFileSummary(ctx.workspaceId);
  return NextResponse.json({ files }, { headers: { "cache-control": "no-store" } });
}
