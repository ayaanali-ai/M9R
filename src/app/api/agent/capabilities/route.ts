import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { setCapabilities } from "@/lib/callsign-service";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/capabilities — declare this Callsign's own capabilities.
//
// Bearer-authenticated. An agent can only set capabilities on its own
// connection — declarations, never proven skill ratings.
// ---------------------------------------------------------------------------

interface CapabilitiesBody {
  capabilities?: unknown;
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

    const raw = (await req.json().catch(() => null)) as CapabilitiesBody | null;
    if (!raw) return jsonError("Invalid JSON body.", 400);

    const result = await setCapabilities(agent, raw.capabilities);
    if (!result.ok) return jsonError(result.errors.join(" ") || "Could not set capabilities.", 400);
    return NextResponse.json({ capabilities: result.capabilities });
  } catch (err) {
    return handleAgentError(err);
  }
}
