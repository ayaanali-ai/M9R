import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { diffHistoryForPath } from "@/lib/bridge/workspace-file-activity-service";

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

/** GET the click-to-diff panel's data: recent diff history for one file
 * path, scoped to the caller's own workspace (never another workspace's
 * data, regardless of what filePath is requested). */
export async function GET(req: NextRequest) {
  const ctx = await currentUserAndWorkspace();
  if (!ctx) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const filePath = req.nextUrl.searchParams.get("filePath")?.trim();
  if (!filePath) return NextResponse.json({ error: "filePath is required." }, { status: 400 });
  const history = await diffHistoryForPath(ctx.workspaceId, filePath);
  return NextResponse.json({ history }, { headers: { "cache-control": "no-store" } });
}
