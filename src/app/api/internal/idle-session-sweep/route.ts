import { NextRequest, NextResponse } from "next/server";
import { sweepIdleSessionArchiveProposals } from "@/lib/bridge/session-service";
import { authorizedStaticBearer } from "@/lib/request-security";

/**
 * Flags idle "waiting" sessions for archive proposal across every workspace
 * (see vercel.json crons). Before this, that flagging only ran as a side
 * effect of GET /api/dashboard/live-sessions, so a workspace with nobody
 * currently viewing the dashboard never got its idle sessions flagged.
 * Gated on CRON_SECRET, not an agent bearer token -- same convention as
 * stale-run-sweep.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "Sweep is not configured." }, { status: 503 });
  if (!authorizedStaticBearer(req, secret)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const result = await sweepIdleSessionArchiveProposals();
  return NextResponse.json({ ok: true, ...result });
}
