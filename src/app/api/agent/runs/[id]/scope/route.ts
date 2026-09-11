import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { requireOwnRun } from "@/lib/agent-run-service";
import { publishDispatch, listLatestScopeByRunForWorkspace } from "@/lib/dispatch-service";
import { detectCollisions } from "@/lib/collision";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/runs/[id]/scope — announce declared file scope for a run.
//
// Bearer-authenticated (agent). Publishes a SCOPE_ANNOUNCED Dispatch (the only
// place declared scope is stored — see dispatch.ts) and deterministically
// checks for overlap against every other run's most recently announced scope
// in the same workspace. No model call — a plain string-set intersection.
// ---------------------------------------------------------------------------

interface ScopeBody {
  paths?: unknown;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: runId } = await params;
    const token = bearerFrom(req.headers.get("authorization"));
    if (!token) return jsonError("Bearer token required.", 401);
    const agent = await authenticateAgent(token);
    if (!agent) return jsonError("Invalid or missing agent token.", 401);

    await requireOwnRun(agent, runId);

    const raw = (await req.json().catch(() => null)) as ScopeBody | null;
    if (!raw) return jsonError("Invalid JSON body.", 400);
    const paths = Array.isArray(raw.paths) ? raw.paths.filter((p): p is string => typeof p === "string") : [];
    if (paths.length === 0) return jsonError("paths must be a non-empty array of file paths.", 400);

    const publishResult = await publishDispatch({
      workspaceId: agent.workspaceId,
      runId,
      type: "SCOPE_ANNOUNCED",
      sender: agent.agentKind ?? "agent",
      summary: `scope announced: ${paths.length} path${paths.length === 1 ? "" : "s"}`,
      scope: paths,
    });
    if (!publishResult.ok) return jsonError(publishResult.errors.join(" ") || "Could not announce scope.", 400);

    const latestScope = await listLatestScopeByRunForWorkspace(agent.workspaceId);
    // Our own just-announced scope may not have made it into the read yet
    // (eventual read-after-write on some setups) — use what we just validated.
    latestScope.set(runId, { sender: agent.agentKind ?? "agent", scope: paths });

    const collisions = detectCollisions(
      [...latestScope.entries()].map(([id, v]) => ({ runId: id, sender: v.sender, scope: v.scope })),
    ).filter((c) => c.runIds.includes(runId));

    return NextResponse.json({ ok: true, collisions });
  } catch (err) {
    return handleAgentError(err);
  }
}
