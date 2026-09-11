import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { supabase } from "@/lib/supabase";
import { setItemStatus, recomputeContractStatus } from "@/lib/bridge/task-contract-service";
import { handleAgentError } from "@/app/api/agent/_shared";

/**
 * PATCH /api/bridge/task-contracts/[itemId] — an agent reports its own
 * item's status (in_progress, done, failed). Never reassigns -- that's a
 * separate, human-confirmed action (dashboard route), never something an
 * agent can do to its own item unilaterally.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { itemId } = await params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const status = body.status;
    if (status !== "in_progress" && status !== "done" && status !== "failed") {
      return NextResponse.json({ error: "status must be in_progress, done, or failed." }, { status: 400 });
    }
    // An agent may only report status on an item currently assigned to its
    // own connection -- never another connection's item.
    if (!supabase) return NextResponse.json({ error: "M9R backend is not configured." }, { status: 503 });
    const { data: item } = await supabase.from("task_contract_items").select("id, contract_id, assigned_connection_id").eq("id", itemId).maybeSingle();
    if (!item || item.assigned_connection_id !== agent.connectionId) {
      return NextResponse.json({ error: "That task item is not assigned to this connection." }, { status: 403 });
    }
    await setItemStatus({
      itemId,
      status,
      resultMessageId: typeof body.resultMessageId === "string" ? body.resultMessageId : undefined,
    });
    await recomputeContractStatus(String(item.contract_id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleAgentError(err);
  }
}
