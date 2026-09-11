import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { reassignTaskItem } from "@/lib/bridge/task-contract-service";
import { handleDashboardApiError } from "../../../../_shared";

/**
 * POST /api/dashboard/task-contracts/items/[itemId]/reassign — the human-confirmed
 * half of reassignment. Decomposition is final once posted (confirmed with
 * the human, 2026-09-02): an agent can only request a change, never
 * reassign on its own authority. This route is that confirmation step --
 * loop-safety (no-repeat, hard cap) is enforced inside reassignTaskItem
 * regardless of who calls it, not re-implemented here.
 *
 * Nested under /items/[itemId] rather than /task-contracts/[itemId] directly
 * (moved 2026-09-05) -- Next.js requires every dynamic segment at the same
 * path level to share one slug name, and this route's sibling
 * /task-contracts/[contractId]/whispers needs a differently-named segment
 * (it takes a contract id, not an item id), so the two were split under
 * distinct static prefixes instead of colliding.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const auth = await createClient();
    if (!auth) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
    const { data: { user } } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to confirm a reassignment." }, { status: 401 });

    const { itemId } = await params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const newConnectionId = typeof body.newConnectionId === "string" ? body.newConnectionId : "";
    if (!newConnectionId) return NextResponse.json({ error: "newConnectionId is required." }, { status: 400 });

    const result = await reassignTaskItem({ itemId, newConnectionId });
    return NextResponse.json(result);
  } catch (err) {
    return handleDashboardApiError(err);
  }
}
