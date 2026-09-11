import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { recordWorkSignal } from "@/lib/work-signal-service";
import { readSignalsSince } from "@/lib/work-signal-delivery";
import { handleAgentError } from "../_shared";

export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    if (!agent.scopes.includes("session:submit")) return NextResponse.json({ error: "Token lacks session:submit scope." }, { status: 403 });
    const body = await req.json() as Record<string, unknown>;
    const runId = typeof body.runId === "string" ? body.runId : null;
    const signal = await recordWorkSignal(agent, body, runId);
    return NextResponse.json({ ok: true, signal });
  } catch (error) { return handleAgentError(error); }
}

/** Cursor-based replay: GET ?since=<serverSequence>&limit=<n>. Resumes from this connection's own persisted cursor when `since` is omitted. */
export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    if (!agent.scopes.includes("session:submit")) return NextResponse.json({ error: "Token lacks session:submit scope." }, { status: 403 });
    const url = new URL(req.url);
    const page = await readSignalsSince(agent, { since: url.searchParams.get("since"), limit: url.searchParams.get("limit") });
    return NextResponse.json({ ok: true, ...page });
  } catch (error) { return handleAgentError(error); }
}
