import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { createTaskContract, listActiveItemsForConnection, dispatchContractItems } from "@/lib/bridge/task-contract-service";
import { handleAgentError } from "@/app/api/agent/_shared";

export const dynamic = "force-dynamic";

/**
 * POST /api/bridge/task-contracts — the first-mentioned agent proposes a
 * decomposition. Bearer-token only: `decomposedByConnectionId` is always the
 * authenticated caller's own connection, never taken from the request body.
 */
export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const anchorMessageId = typeof body.anchorMessageId === "string" ? body.anchorMessageId : null;
    const items = Array.isArray(body.items) ? body.items : [];
    if (!conversationId || items.length === 0) {
      return NextResponse.json({ error: "conversationId and at least one item are required." }, { status: 400 });
    }
    const parsedItems = items.map((raw) => {
      const item = raw as Record<string, unknown>;
      return {
        description: String(item.description ?? "").trim(),
        expectedFilePaths: Array.isArray(item.expectedFilePaths) ? item.expectedFilePaths.map(String) : [],
        assignedConnectionId: String(item.assignedConnectionId ?? ""),
      };
    });
    if (parsedItems.some((item) => !item.description || !item.assignedConnectionId)) {
      return NextResponse.json({ error: "Every item needs a description and an assignedConnectionId." }, { status: 400 });
    }
    const contract = await createTaskContract({
      workspaceId: agent.workspaceId,
      conversationId,
      anchorMessageId,
      decomposedByConnectionId: agent.connectionId,
      items: parsedItems,
    });
    // Wake each assigned agent with only its own piece. System-authored
    // notices (no sender connection) -- the one notice shape the bridge's
    // loop-prevention contract allows to wake a session.
    const dispatched = await dispatchContractItems(contract.id);
    return NextResponse.json({ ok: true, contract, dispatched }, { status: 201 });
  } catch (err) {
    return handleAgentError(err);
  }
}

/**
 * GET /api/bridge/task-contracts — this connection's own active sub-tasks
 * across every open contract. What a resident dispatches as the actual
 * prompt for a mentioned agent's turn.
 */
export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const items = await listActiveItemsForConnection(agent.connectionId);
    return NextResponse.json({ items });
  } catch (err) {
    return handleAgentError(err);
  }
}
