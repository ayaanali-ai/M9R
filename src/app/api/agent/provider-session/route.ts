import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { setProviderSession } from "@/lib/callsign-service";
import { handleAgentError } from "../_shared";

// POST /api/agent/provider-session: the bridge reports the provider's own session id for the session
// it just started, so the dashboard can show how to resume it natively. Bearer-authenticated; an agent
// can only set this on its own connection.
export async function POST(req: NextRequest) {
  try {
    const token = bearerFrom(req.headers.get("authorization"));
    if (!token) return NextResponse.json({ error: "Bearer token required." }, { status: 401 });
    const agent = await authenticateAgent(token);
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const body = (await req.json().catch(() => null)) as { provider_session_ref?: unknown } | null;
    if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    const result = await setProviderSession(agent, body.provider_session_ref);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleAgentError(err);
  }
}
