import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { supabase } from "@/lib/supabase";
import { handleAgentError } from "../_shared";

/**
 * GET /api/agent/bridge-commands — the poll target for a remote "reconnect
 * my agents" request. Requires a Bearer agent token (any connected provider
 * for the workspace can poll this; there is nothing provider-specific about
 * a reconnect). Read-only: the CLI decides for itself whether
 * reconnectRequestedAt is newer than the last one it already handled --
 * this route has no notion of "consumed", so a repeated poll is always safe.
 */
export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    if (!supabase) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });

    const { data, error } = await supabase
      .from("bridge_reconnect_requests")
      .select("requested_at, handled_at, handled_summary")
      .eq("workspace_id", agent.workspaceId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Could not read bridge commands." }, { status: 500 });

    return NextResponse.json({
      reconnectRequestedAt: data?.requested_at ?? null,
      reconnectHandledAt: data?.handled_at ?? null,
      reconnectHandledSummary: data?.handled_summary ?? null,
    });
  } catch (err) {
    return handleAgentError(err);
  }
}

/**
 * POST /api/agent/bridge-commands — the local runtime reporting back that it
 * actually handled a reconnect request, and what it found. Without this the
 * dashboard button had no way to know whether anything happened at all; see
 * checkReconnectRequest in oathlock-terminal-bridge.ts for the caller.
 */
export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    if (!supabase) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });

    const body = await req.json().catch(() => ({})) as { handledAt?: unknown; summary?: unknown };
    const handledAt = typeof body.handledAt === "string" && !Number.isNaN(Date.parse(body.handledAt)) ? body.handledAt : new Date().toISOString();
    const summary = typeof body.summary === "string" ? body.summary.slice(0, 500) : null;

    const { error } = await supabase
      .from("bridge_reconnect_requests")
      .update({ handled_at: handledAt, handled_summary: summary })
      .eq("workspace_id", agent.workspaceId);
    if (error) return NextResponse.json({ error: "Could not record the reconnect result." }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleAgentError(err);
  }
}
