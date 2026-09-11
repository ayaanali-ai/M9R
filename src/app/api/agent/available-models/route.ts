import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { setAvailableModels } from "@/lib/callsign-service";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/available-models — report this connection's own real,
// live ACP model options (see AgentSessionHandle.availableModels).
//
// Bearer-authenticated. An agent can only set this on its own connection.
// Best-effort self-report, never a guessed/hardcoded catalog: this is what
// lets the dashboard's model-override control render a real dropdown.
// ---------------------------------------------------------------------------

interface AvailableModelsBody {
  available_models?: unknown;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const token = bearerFrom(req.headers.get("authorization"));
    if (!token) return jsonError("Bearer token required.", 401);
    const agent = await authenticateAgent(token);
    if (!agent) return jsonError("Invalid or missing agent token.", 401);

    const raw = (await req.json().catch(() => null)) as AvailableModelsBody | null;
    if (!raw) return jsonError("Invalid JSON body.", 400);

    const result = await setAvailableModels(agent, raw.available_models ?? null);
    if (!result.ok) return jsonError(result.errors.join(" ") || "Could not set available models.", 400);
    return NextResponse.json({ available_models: result.availableModels });
  } catch (err) {
    return handleAgentError(err);
  }
}
