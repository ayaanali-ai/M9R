import { NextResponse } from "next/server";
import { listCallsignsForUser, buildServiceRecordForAgentKind } from "@/lib/callsign-service";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/callsigns — connected Callsigns + Service Record, for the
// signed-in human (dashboard). Cookie-authenticated, RLS-scoped.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const callsigns = await listCallsignsForUser();
    const withServiceRecord = await Promise.all(
      callsigns.map(async (c) => ({
        ...c,
        serviceRecord: await buildServiceRecordForAgentKind(c.workspaceId, c.agentKind),
      })),
    );
    return NextResponse.json({ callsigns: withServiceRecord });
  } catch (err) {
    return handleAgentError(err);
  }
}
