import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { updateAgentRunStatus } from "@/lib/agent-run-service";
import { handleAgentError } from "../../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/run/status — update a run's phase/status (telemetry only).
//
// Bearer-token only. Accepts run_id, status, current_phase, optional message,
// optional rules_loaded_count. The message is redacted before storage — no
// source code, tokens, claim URLs, setup codes, or local.json ever persist.
// A token can only update a run started by its own connection.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) {
      return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    }
    if (!agent.scopes.includes("session:submit")) {
      return NextResponse.json({ error: "Token lacks session:submit scope." }, { status: 403 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const runId = typeof body.run_id === "string" ? body.run_id : "";
    if (!runId) {
      return NextResponse.json({ error: "run_id is required." }, { status: 400 });
    }

    const result = await updateAgentRunStatus(agent, {
      runId,
      status: typeof body.status === "string" ? body.status : null,
      currentPhase: typeof body.current_phase === "string" ? body.current_phase : null,
      message: typeof body.message === "string" ? body.message : null,
      rulesLoadedCount:
        typeof body.rules_loaded_count === "number" ? body.rules_loaded_count : null,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return handleAgentError(err);
  }
}
