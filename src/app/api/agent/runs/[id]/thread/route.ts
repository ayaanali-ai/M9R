import { NextRequest, NextResponse } from "next/server";
import { listDispatchesForRun } from "@/lib/dispatch-service";
import { listResponsesForRun } from "@/lib/response-service";
import { buildRunThread } from "@/lib/run-thread";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/agent/runs/[id]/thread — the same thread + coordination data the
 * full Run Room page reads, exposed for the Watchfloor's compact Bounded
 * Assistance summary so both surfaces call one source of truth instead of
 * each re-deriving it. Cookie-authenticated (owner-scoped via the signed-in
 * user's client, same as /dashboard/runs/[id]) -- not the agent-token API.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: runId } = await params;
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Not configured." }, { status: 503 });

  const { data: run, error: runError } = await db.from("agent_runs").select("run_mode, parent_run_id, agent_kind").eq("id", runId).maybeSingle();
  if (runError) return NextResponse.json({ error: "Could not read run." }, { status: 500 });
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });

  const [dispatches, responses] = await Promise.all([listDispatchesForRun(runId), listResponsesForRun(runId)]);
  const row = run as { run_mode?: string | null; parent_run_id?: string | null; agent_kind?: string | null };
  const thread = buildRunThread(dispatches, responses, { sourceAgentKind: row.agent_kind });
  return NextResponse.json({
    thread,
    runMode: row.run_mode ?? "solo",
    parentRunId: row.parent_run_id ?? null,
  });
}
