import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabase } from "@/lib/supabase";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { handleDashboardApiError } from "../../../_shared";

export interface TaskContractWhisper {
  id: string;
  body: string;
  kind: string;
  senderConnectionId: string | null;
  createdAt: string;
}

/**
 * GET /api/dashboard/task-contracts/[contractId]/whispers — the raw
 * agent-to-agent chatter a Task Card's "Whispers" drawer expands into.
 * Deliberately lazy (only fetched when a human opens the drawer, not
 * alongside the card itself in pending-decisions) -- this is exactly the
 * "kept out of the main feed by default" data item #4's spec calls for, so
 * it should not cost a request on every poll tick for every contract that
 * exists, only the one a human actually asks to see.
 *
 * Scoped to messages authored by the contract's own decomposer and assigned
 * agents, from the contract's creation onward -- broad enough to show the
 * real negotiation (the decomposer's coordinating reply, each item's
 * in-progress chatter) without pulling in unrelated conversation traffic
 * that happens to share the same channel.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ contractId: string }> }) {
  try {
    const auth = await createClient();
    if (!auth) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
    const { data: { user } } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    if (!supabase) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });

    const workspaceId = await resolveActiveOrDefaultProjectId(auth, { id: user.id, email: user.email, name: null });
    const { contractId } = await params;

    const { data: contract, error: contractError } = await supabase.from("task_contracts")
      .select("id, workspace_id, conversation_id, decomposed_by_connection_id, created_at")
      .eq("id", contractId).maybeSingle();
    if (contractError) throw contractError;
    if (!contract || String(contract.workspace_id) !== workspaceId) {
      return NextResponse.json({ error: "Task contract not found." }, { status: 404 });
    }

    const { data: items, error: itemsError } = await supabase.from("task_contract_items")
      .select("assigned_connection_id").eq("contract_id", contractId);
    if (itemsError) throw itemsError;

    const connectionIds = new Set<string>();
    if (contract.decomposed_by_connection_id) connectionIds.add(String(contract.decomposed_by_connection_id));
    for (const item of items ?? []) {
      if (item.assigned_connection_id) connectionIds.add(String(item.assigned_connection_id));
    }
    if (connectionIds.size === 0) return NextResponse.json({ whispers: [] as TaskContractWhisper[] });

    const { data: messages, error: messagesError } = await supabase.from("conversation_messages")
      .select("id, body, kind, sender_connection_id, created_at")
      .eq("conversation_id", contract.conversation_id)
      .in("sender_connection_id", [...connectionIds])
      .gte("created_at", contract.created_at as string)
      .order("created_at", { ascending: true })
      .limit(200);
    if (messagesError) throw messagesError;

    const whispers: TaskContractWhisper[] = (messages ?? []).map((row) => ({
      id: String(row.id),
      body: String(row.body),
      kind: String(row.kind),
      senderConnectionId: (row.sender_connection_id as string | null) ?? null,
      createdAt: String(row.created_at),
    }));
    return NextResponse.json({ whispers }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return handleDashboardApiError(err);
  }
}
