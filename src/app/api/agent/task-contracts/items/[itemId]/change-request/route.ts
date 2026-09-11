import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { requestAssignmentChange, type ChangeRequestReason } from "@/lib/bridge/task-contract-service";
import { handleAgentError } from "../../../../_shared";

const VALID_REASONS: ChangeRequestReason[] = ["wrong_scope", "blocked_by_dependency", "outside_capability", "already_done_by_other", "needs_split"];

/**
 * POST /api/agent/task-contracts/items/[itemId]/change-request
 *
 * Backs the `request_assignment_change` MCP tool (#4, resolved 2026-09-06).
 * Grants the calling agent exactly one capability: flag its own currently-
 * assigned item as needing a human's attention, then stop. Ownership is
 * enforced server-side inside requestAssignmentChange (itemId must resolve
 * to assigned_connection_id === this agent's own connectionId) -- never
 * trusted from the request body.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const { itemId } = await params;
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const rawReason = typeof body.reason === "string" ? body.reason : "";
    if (!VALID_REASONS.includes(rawReason as ChangeRequestReason)) {
      return NextResponse.json({ error: `reason must be one of: ${VALID_REASONS.join(", ")}` }, { status: 400 });
    }
    const reason = rawReason as ChangeRequestReason;
    const detail = typeof body.detail === "string" ? body.detail.trim().slice(0, 600) : "";
    if (!detail) return NextResponse.json({ error: "detail is required." }, { status: 400 });
    const suggestedConnectionId = typeof body.suggestedConnectionId === "string" ? body.suggestedConnectionId : null;

    const result = await requestAssignmentChange({
      itemId,
      requestedByConnectionId: agent.connectionId,
      reason,
      detail,
      suggestedConnectionId,
    });
    if (!result.ok) return NextResponse.json({ error: "This item is not currently assigned to you." }, { status: 403 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleAgentError(err);
  }
}
