import { NextResponse } from "next/server";
import { dismissArchiveProposal } from "@/lib/bridge/session-service";
import { handleDashboardApiError } from "../../../_shared";

// "Keep this open" -- clears a pending archive proposal without archiving.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await dismissArchiveProposal(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
