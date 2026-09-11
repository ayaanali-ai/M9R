import { NextResponse } from "next/server";
import { manualArchiveSession } from "@/lib/bridge/session-service";
import { handleDashboardApiError } from "../../../_shared";

// Archives a session -- covers both "human confirms the agent's proposal"
// and "human archives manually, without waiting for a proposal". Both are
// the same action underneath: a human decided, either way.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await manualArchiveSession(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
