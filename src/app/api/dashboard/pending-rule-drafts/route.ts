import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { supabase } from "@/lib/supabase";
import { isMissingOptionalTableError } from "@/lib/dashboard-optional-fallback";

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

interface PendingRuleDraft {
  id: string;
  title: string;
  body: string;
  announcementMessageId: string | null;
  createdAt: string;
}

/**
 * GET lists every "needs_review" rule draft that has already announced
 * itself in the message feed (has an announcement_message_id -- see
 * importWorkspaceRuleDrafts in workspace-rules-service.ts). Decisions reuse
 * the existing /api/agent/rules/promote and /api/workspace-rules/[id] DELETE
 * routes, unchanged -- this endpoint only tells the Watchfloor which
 * message id needs an inline card.
 */
export async function GET() {
  const ctx = await currentUserAndWorkspace();
  if (!ctx || !supabase) return NextResponse.json({ drafts: [] });
  try {
    const { data, error } = await supabase.from("workspace_rules")
      .select("id, title, body, announcement_message_id, created_at")
      .eq("workspace_id", ctx.workspaceId)
      .eq("status", "needs_review")
      .not("announcement_message_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) throw error;
    const drafts: PendingRuleDraft[] = (data ?? []).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      body: String(row.body),
      announcementMessageId: (row.announcement_message_id as string | null) ?? null,
      createdAt: String(row.created_at),
    }));
    return NextResponse.json({ drafts }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (isMissingOptionalTableError(error)) return NextResponse.json({ drafts: [], unavailable: true }, { headers: { "cache-control": "no-store" } });
    return NextResponse.json({ error: "Could not read pending rule drafts." }, { status: 500 });
  }
}
