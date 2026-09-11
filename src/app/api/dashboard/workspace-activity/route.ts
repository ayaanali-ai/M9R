import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { listWorkspaceActivityFeed } from "@/lib/bridge/workspace-activity-feed-service";

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

/** GET the structured Activity feed: file reads/edits/creates/deletes,
 * permission requests, and human turn-interrupts, merged and time-sorted. */
export async function GET() {
  const ctx = await currentUserAndWorkspace();
  if (!ctx) return NextResponse.json({ events: [] });
  const events = await listWorkspaceActivityFeed(ctx.workspaceId);
  return NextResponse.json({ events }, { headers: { "cache-control": "no-store" } });
}
