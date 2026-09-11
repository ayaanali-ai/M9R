import { NextResponse } from "next/server";
import { cancelAgentRun, getAgentRunForUser } from "@/lib/agent-run-service";
import { createClient } from "@/lib/supabase/server";
import { handleAgentError } from "../../../_shared";

/**
 * POST /api/agent/runs/[id]/cancel — the human stops a run that's still
 * live (started/working/blocked/waiting_for_human), before it finished.
 * Distinct from a review decision (reviewed/needs_follow_up/not_accepted),
 * which requires evidence to already exist; a run can be cancelled with no
 * evidence at all. Ownership check is cookie-scoped (getAgentRunForUser,
 * RLS SELECT), same as /review; the write itself goes through
 * cancelAgentRun's service-role client, not the cookie client -- writing
 * agent_runs directly through the cookie client silently no-ops under RLS.
 */

const LIVE_STATUSES = new Set(["started", "working", "blocked", "waiting_for_human"]);

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const db = await createClient();
    if (!db) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to cancel this run." }, { status: 401 });

    const { id } = await params;
    const run = await getAgentRunForUser(id);
    if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
    if (!LIVE_STATUSES.has(run.status)) {
      return NextResponse.json({ error: "This run has already finished and can't be cancelled." }, { status: 409 });
    }

    await cancelAgentRun(id);
    return NextResponse.json({ ok: true, status: "cancelled" });
  } catch (err) {
    return handleAgentError(err);
  }
}
