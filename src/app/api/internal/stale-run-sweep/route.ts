import { NextRequest, NextResponse } from "next/server";
import { sweepStaleRuns } from "@/lib/agent-run-service";
import { authorizedStaticBearer } from "@/lib/request-security";

/**
 * Finalizes agent_runs left in a non-terminal status by a CLI process that
 * died mid-run (see vercel.json crons). Never runs on end-user request;
 * gated on CRON_SECRET, not an agent bearer token -- same convention as
 * work-signal-sweep.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "Sweep is not configured." }, { status: 503 });
  if (!authorizedStaticBearer(req, secret)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const result = await sweepStaleRuns();
  return NextResponse.json({ ok: true, ...result });
}
