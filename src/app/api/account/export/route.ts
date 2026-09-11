import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// GET /api/account/export — download everything in the signed-in user's
// workspace(s) as a single JSON file. Originally only covered the legacy
// trace-analyzer tables (traces, rules) -- extended to the tables the current
// product actually writes to (agent connections, runs, evidence, findings,
// workspace rules), scoped by the workspaces this user owns.
//
// Real, useful, and honest: it returns exactly what's stored, nothing more.
// Read-only, so unlike account/purge this carries no data-retention policy
// question -- exporting more of the real record is a pure improvement.
// ---------------------------------------------------------------------------

export async function GET() {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });

  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to export your data." }, { status: 401 });

  const { data: projectRows } = await db.from("projects").select("*").eq("owner_id", user.id).is("deleted_at", null);
  const projects = projectRows ?? [];
  const workspaceIds = projects.map((p) => (p as { id: string }).id);

  const [traces, rules, agentConnections, agentRuns, evidenceRecords, findings, workspaceRules] = await Promise.all([
    db.from("traces").select("*").eq("user_id", user.id).is("deleted_at", null),
    db.from("rules").select("*").eq("created_by", user.id).is("deleted_at", null),
    workspaceIds.length > 0 ? db.from("agent_connections").select("*").in("workspace_id", workspaceIds) : Promise.resolve({ data: [] }),
    workspaceIds.length > 0 ? db.from("agent_runs").select("*").in("workspace_id", workspaceIds) : Promise.resolve({ data: [] }),
    workspaceIds.length > 0 ? db.from("evidence_records").select("*").in("workspace_id", workspaceIds) : Promise.resolve({ data: [] }),
    workspaceIds.length > 0 ? db.from("findings").select("*").in("workspace_id", workspaceIds) : Promise.resolve({ data: [] }),
    workspaceIds.length > 0 ? db.from("workspace_rules").select("*").in("workspace_id", workspaceIds).is("deleted_at", null) : Promise.resolve({ data: [] }),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    account: { id: user.id, email: user.email },
    projects,
    agentConnections: agentConnections.data ?? [],
    agentRuns: agentRuns.data ?? [],
    evidenceRecords: evidenceRecords.data ?? [],
    findings: findings.data ?? [],
    workspaceRules: workspaceRules.data ?? [],
    traces: traces.data ?? [],
    rules: rules.data ?? [],
  };

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="oathlock-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
