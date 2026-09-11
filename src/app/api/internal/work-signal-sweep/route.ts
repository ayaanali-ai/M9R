import { NextRequest, NextResponse } from "next/server";
import { sweepStaleOutbox } from "@/lib/work-signal-delivery";
import { handleAgentError } from "../../agent/_shared";
import { cleanupExpiredRateLimits } from "@/lib/rate-limit";
import { authorizedStaticBearer } from "@/lib/request-security";

/**
 * Delivery worker: invoked on a schedule (see vercel.json crons) to downgrade
 * outbox rows whose owning connection never acknowledged them in time. Never
 * runs on end-user request; gated on CRON_SECRET, not an agent bearer token.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "Sweep is not configured." }, { status: 503 });
  if (!authorizedStaticBearer(req, secret)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const [result, rateLimitBucketsDeleted] = await Promise.all([
      sweepStaleOutbox(),
      cleanupExpiredRateLimits(),
    ]);
    return NextResponse.json({ ok: true, ...result, rateLimitBucketsDeleted });
  } catch (error) { return handleAgentError(error); }
}
