import { NextResponse } from "next/server";
import { getAgentRunForUser, listLinkedRunIds } from "@/lib/agent-run-service";
import { listDispatchesForRun } from "@/lib/dispatch-service";
import { listResponsesForRun } from "@/lib/response-service";
import { listFindingsForRun, listFindingsAdoptedByRun } from "@/lib/finding-service";
import { humanReviewFromEvents, REVIEW_DECISION_EVENT_TYPE, type RunReviewEventRow } from "@/lib/run-review-decision-service";
import { buildWorkgraph } from "@/lib/workgraph";
import { createClient } from "@/lib/supabase/server";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/runs/[id]/workgraph — the durable relationship map for one
// run: its Dispatches, Responses, published/adopted Findings, review
// decision, and Linked Runs. Cookie-authenticated, RLS-scoped throughout.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: runId } = await params;
    const run = await getAgentRunForUser(runId);
    if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });

    const db = await createClient();
    const reviewEvents = db
      ? await db
          .from("agent_run_events")
          .select("event_type, message, created_at")
          .eq("run_id", runId)
          .eq("event_type", REVIEW_DECISION_EVENT_TYPE)
          .order("created_at", { ascending: false })
          .limit(5)
      : { data: [] as RunReviewEventRow[] };

    const [dispatches, responses, publishedFindings, adoptedFindings, linkedRunIds, adoptionRows] = await Promise.all([
      listDispatchesForRun(runId),
      listResponsesForRun(runId),
      listFindingsForRun(runId),
      listFindingsAdoptedByRun(runId),
      listLinkedRunIds(runId),
      db
        ? db.from("result_adoptions").select("id, launch_grant_id, decision, plan_effect").eq("run_id", runId).order("created_at")
        : Promise.resolve({ data: [] as Array<{ id: string; launch_grant_id: string; decision: string; plan_effect: string }> }),
    ]);

    const humanReview = humanReviewFromEvents((reviewEvents.data ?? []) as RunReviewEventRow[]);

    const graph = buildWorkgraph({
      runId,
      runLabel: run.task_title || `Run ${runId.slice(0, 8)}`,
      dispatches,
      responses,
      publishedFindings,
      adoptedFindings,
      humanReviewDecision: humanReview.decision,
      linkedRunIds,
      resultAdoptions: (adoptionRows.data ?? []).map((row) => ({
        id: row.id,
        launchGrantId: row.launch_grant_id,
        decision: row.decision,
        planEffect: row.plan_effect,
      })),
    });

    return NextResponse.json(graph);
  } catch (err) {
    return handleAgentError(err);
  }
}
