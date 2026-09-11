import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listAuditLogEntries, verifyAuditLogChain } from "@/lib/audit-log";
import { getUserPlan, getPlanLimits } from "@/lib/plan-limits-service";
import { handleDashboardApiError } from "../_shared";

async function resolveWorkspaceAndUser(): Promise<{ workspaceId: string; userId: string } | null> {
  const auth = await createClient();
  if (!auth) return null;
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return null;
  const { data: workspace } = await auth.from("projects").select("id").eq("owner_id", user.id).order("created_at", { ascending: true }).limit(1).maybeSingle();
  const workspaceId = (workspace?.id as string | undefined) ?? null;
  return workspaceId ? { workspaceId, userId: user.id } : null;
}

/** Read-only: lists the workspace's tamper-evident audit trail, and — when
 *  ?verify=1 — independently recomputes the chain to confirm nothing was
 *  altered. Verification always runs over the FULL chain regardless of plan
 *  -- retention limits what a free workspace can see, never what OathLock
 *  can prove; the chain itself is never truncated or deleted. */
export async function GET(request: NextRequest) {
  const auth = await resolveWorkspaceAndUser();
  if (!auth) return NextResponse.json({ error: "Sign in to view the audit log." }, { status: 401 });
  const { workspaceId, userId } = auth;
  try {
    const db = await createClient();
    const plan = db ? await getUserPlan(db, userId) : "free";
    const retentionDays = getPlanLimits(plan).auditRetentionDays;

    let entries = await listAuditLogEntries(workspaceId, 500);
    let retentionLimited = false;
    if (retentionDays !== null) {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const visible = entries.filter((entry) => Date.parse(entry.createdAt) >= cutoff);
      retentionLimited = visible.length < entries.length;
      entries = visible;
    }

    if (request.nextUrl.searchParams.get("verify") === "1") {
      const verification = await verifyAuditLogChain(workspaceId);
      return NextResponse.json({ entries, verification, retentionDays, retentionLimited });
    }
    return NextResponse.json({ entries, retentionDays, retentionLimited });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
