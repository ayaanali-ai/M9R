import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { acquireFileLock, releaseLocksForConnection } from "@/lib/bridge/file-lock-service";
import { handleAgentError } from "@/app/api/agent/_shared";

export const dynamic = "force-dynamic";

/**
 * POST /api/bridge/file-locks — the Bridge asks to take the lock on one file
 * before an edit-shaped tool call is allowed through. Bearer-token only: an
 * agent can only ever lock on behalf of its own connection and workspace,
 * both taken from the authenticated token, never from the request body.
 *
 * Answers `{ ok: true }` to proceed, or `{ ok: false, conflict }` naming the
 * connection that already holds it so the caller can say who, not just no.
 */
export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const path = typeof body.path === "string" ? body.path.trim() : "";
    if (!path) return NextResponse.json({ error: "path is required." }, { status: 400 });
    const result = await acquireFileLock({
      workspaceId: agent.workspaceId,
      connectionId: agent.connectionId,
      conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
      path,
    });
    return NextResponse.json(result);
  } catch (err) {
    return handleAgentError(err);
  }
}

/**
 * DELETE /api/bridge/file-locks — release every lock this connection holds.
 * Called when a turn reaches a terminal stage, so a healthy turn frees its
 * files immediately rather than waiting out the TTL.
 */
export async function DELETE(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const released = await releaseLocksForConnection({
      workspaceId: agent.workspaceId,
      connectionId: agent.connectionId,
      reason: typeof body.reason === "string" ? body.reason.slice(0, 64) : "turn_ended",
    });
    return NextResponse.json({ ok: true, released });
  } catch (err) {
    return handleAgentError(err);
  }
}
