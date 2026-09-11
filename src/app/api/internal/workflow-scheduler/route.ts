import { NextRequest, NextResponse } from "next/server";
import { sweepScheduledWorkflows } from "@/lib/mission/workflow-scheduler-service";
import { authorizedStaticBearer } from "@/lib/request-security";

/**
 * Fires every due schedule-triggered channel workflow (see vercel.json
 * crons). Never runs on end-user request; gated on CRON_SECRET, not an
 * agent bearer token -- same convention as stale-run-sweep.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "Scheduler is not configured." }, { status: 503 });
  if (!authorizedStaticBearer(req, secret)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const result = await sweepScheduledWorkflows();
  return NextResponse.json({ ok: true, ...result });
}
