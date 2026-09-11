import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { requireOwnRun } from "@/lib/agent-run-service";
import { recordAdoption } from "@/lib/finding-service";
import type { AdoptionConfirmation } from "@/lib/finding";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/findings/[id]/adopt — a later run cites an available Finding.
//
// Bearer-authenticated (agent). Only Findings already in "available"
// (human-reviewed) state can be adopted (enforced in finding-service.ts) —
// an agent cannot adopt its own unreviewed observation.
// ---------------------------------------------------------------------------

interface AdoptBody {
  run_id?: unknown;
  confirmation?: unknown;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

const CONFIRMATIONS = new Set(["confirmed", "needs_review", "contradicted"]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: findingId } = await params;
    const token = bearerFrom(req.headers.get("authorization"));
    if (!token) return jsonError("Bearer token required.", 401);
    const agent = await authenticateAgent(token);
    if (!agent) return jsonError("Invalid or missing agent token.", 401);

    const raw = (await req.json().catch(() => null)) as AdoptBody | null;
    if (!raw) return jsonError("Invalid JSON body.", 400);
    const runId = typeof raw.run_id === "string" ? raw.run_id : "";
    if (!runId) return jsonError("run_id is required.", 400);
    const run = await requireOwnRun(agent, runId);

    const confirmation =
      typeof raw.confirmation === "string" && CONFIRMATIONS.has(raw.confirmation)
        ? (raw.confirmation as AdoptionConfirmation)
        : null;

    const result = await recordAdoption({ findingId, workspaceId: run.workspace_id, adoptingRunId: runId, confirmation });
    if (!result.ok) return jsonError(result.error ?? "Could not record the adoption.", 400);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleAgentError(err);
  }
}
