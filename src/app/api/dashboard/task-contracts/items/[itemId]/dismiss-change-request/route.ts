import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { dismissAssignmentChange } from "@/lib/bridge/task-contract-service";
import { handleDashboardApiError } from "../../../../_shared";

/**
 * POST /api/dashboard/task-contracts/items/[itemId]/dismiss-change-request
 *
 * The "Keep as-is" resolution path for a #4 change request: clears the
 * request and returns the item to work, matching the other two resolution
 * paths' routes (reassign already existed; "Fail it" reuses the item's
 * ordinary status update, not a dedicated route).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const auth = await createClient();
    if (!auth) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
    const { data: { user } } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to resolve a change request." }, { status: 401 });

    const { itemId } = await params;
    await dismissAssignmentChange(itemId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleDashboardApiError(err);
  }
}
