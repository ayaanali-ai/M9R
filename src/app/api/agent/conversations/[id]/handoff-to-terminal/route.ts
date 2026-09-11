import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { lookupLivePtySessionRoom, publishInternalRelayFrame } from "@/lib/mission/mission-relay-internal-publish";
import { handleAgentError } from "../../../_shared";
import { TERMINAL_ENABLED } from "@/lib/terminal-config";

const MAX_TEXT_LENGTH = 2000;

/**
 * POST /api/agent/conversations/[id]/handoff-to-terminal
 *
 * Backs the `handoff_to_terminal` MCP tool (#21 Phase 6). Render, don't
 * inject (the spec's own explicit security decision): this never writes
 * into the target PTY's stdin, it only asks the Mission Relay to fan a
 * `pty.handoff` card out to that session's viewers. TerminalPane.tsx
 * renders it as a bordered card with an explicit "Send to terminal"
 * button that -- when clicked -- emits an ordinary pty.input frame from
 * the human's own client, going through the already-verified input path
 * with the human as the authenticated principal. No new privilege exists
 * anywhere in this path.
 *
 * The whole security boundary is the same-room check below: this refuses
 * unless the calling agent's own conversation and the target session's own
 * room are the same one. Do not remove it because sessions already feel
 * workspace-scoped -- a workspace can have many rooms.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Checked before auth: while the terminal view is gated off there is no
    // pane for a handoff card to land on, so this is unavailable rather than
    // merely unauthorized.
    if (!TERMINAL_ENABLED) {
      return NextResponse.json({ error: "The terminal multiplayer view is not enabled on this deployment." }, { status: 404 });
    }
    const { id: conversationId } = await params;
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const targetSessionId = typeof body.targetSessionId === "string" ? body.targetSessionId.trim() : "";
    if (!targetSessionId) return NextResponse.json({ error: "targetSessionId is required." }, { status: 400 });
    const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT_LENGTH) : "";
    if (!text) return NextResponse.json({ error: "text is required." }, { status: 400 });
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : null;

    // Named risk (c) in the spec, verbatim: "the target owner being offline
    // means the pane doesn't exist -- return a real error to the tool
    // rather than silently dropping." lookupLivePtySessionRoom returning
    // null covers both "never existed" and "owner disconnected," which is
    // the right merge -- an agent can't tell those apart usefully anyway.
    const room = await lookupLivePtySessionRoom(agent.workspaceId, targetSessionId);
    if (!room) {
      return NextResponse.json({ error: "That terminal session isn't live right now (it may not exist, or its owner may be offline)." }, { status: 404 });
    }
    // The whole security boundary, per the spec: same room only.
    if (room.channelId !== conversationId) {
      return NextResponse.json({ error: "That terminal session isn't in this conversation." }, { status: 403 });
    }

    const idempotencyKey = req.headers.get("idempotency-key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : null);
    const handoffId = idempotencyKey ?? `handoff-${agent.connectionId}-${targetSessionId}-${Date.now()}`;

    await publishInternalRelayFrame({
      workspaceId: agent.workspaceId,
      channelId: room.channelId,
      type: "pty.handoff",
      payload: {
        sessionId: targetSessionId,
        fromConnectionId: agent.connectionId,
        fromLabel: agent.agentKind ?? "Agent",
        text,
        reason,
        handoffId,
      },
    });

    return NextResponse.json({ ok: true, handoffId });
  } catch (err) {
    return handleAgentError(err);
  }
}
