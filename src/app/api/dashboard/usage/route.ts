import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { aggregateMissionUsage } from "@/lib/mission/mission-usage";
import { createSupabaseMissionUsageLedger } from "@/lib/mission/mission-usage-store-supabase";
import { isMissingOptionalTableError } from "@/lib/dashboard-optional-fallback";

async function currentWorkspaceId(request: NextRequest): Promise<string | null> {
  const db = await createClient();
  if (!db) return null;
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  const requestedWorkspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim() || null;
  let query = db.from("projects").select("id").eq("owner_id", user.id);
  if (requestedWorkspaceId) query = query.eq("id", requestedWorkspaceId);
  else query = query.order("created_at", { ascending: true }).limit(1);
  const { data: workspace } = await query.maybeSingle();
  return typeof workspace?.id === "string" ? workspace.id : null;
}

export async function GET(request: NextRequest) {
  const workspaceId = await currentWorkspaceId(request);
  if (!workspaceId) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const nowMs = Date.now();
  try {
    const since = new Date(nowMs - 7 * 24 * 60 * 60 * 1_000).toISOString();
    const ledger = createSupabaseMissionUsageLedger();
    await ledger.reconcileFromRuntimeEvents({ workspaceId, since });
    const snapshots = await ledger.list({ workspaceId, since });
    return NextResponse.json({ usage: aggregateMissionUsage(snapshots, nowMs) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (isMissingOptionalTableError(error)) {
      return NextResponse.json({ usage: null, unavailable: true, reason: "migration_required" }, { headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ error: "Could not read provider usage telemetry." }, { status: 500 });
  }
}
