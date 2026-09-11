import { NextResponse } from "next/server";
import { deleteDashboardConversations } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../_shared";

// POST /api/dashboard/conversations/batch — the sidebar's multi-select bar.
// One request for N channels so a partial failure (e.g. one core channel
// slipped into a selection somehow) is reportable per-id instead of the
// client firing N sequential requests it can't distinguish afterward.
// Delete-only: Archive was removed from this product entirely per direction
// (commit 4fe11bd), so this never grows an "archive" action.
const MAX_BATCH = 50;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { action?: unknown; ids?: unknown } | null;
  if (body?.action !== "delete") {
    return NextResponse.json({ error: "action must be \"delete\"." }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((value): value is string => typeof value === "string") : [];
  if (ids.length === 0) return NextResponse.json({ error: "ids must be a non-empty array." }, { status: 400 });
  if (ids.length > MAX_BATCH) return NextResponse.json({ error: `At most ${MAX_BATCH} channels can be changed at once.` }, { status: 400 });
  try {
    const result = await deleteDashboardConversations(ids);
    return NextResponse.json(result);
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
