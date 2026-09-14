import { NextRequest, NextResponse } from "next/server";
import { readAuthenticatedAgentActivity, bearerFrom } from "@/lib/agent-join-service";

/**
 * GET /api/agent/connection-status — read this token's prior use signal.
 * Unlike normal bearer routes this deliberately does not update last_used_at:
 * the caller is asking whether a real provider process has authenticated
 * before, not proving that this status probe itself is that process.
 */
export async function GET(req: NextRequest) {
  const activity = await readAuthenticatedAgentActivity(bearerFrom(req.headers.get("authorization")));
  if (!activity) return NextResponse.json({ error: "Invalid or inactive agent token." }, { status: 401 });
  return NextResponse.json({
    connectionId: activity.connectionId,
    agentKind: activity.agentKind,
    authenticated: Boolean(activity.lastUsedAt),
    lastUsedAt: activity.lastUsedAt,
    lastSeenAt: activity.lastSeenAt,
  }, { headers: { "cache-control": "no-store" } });
}
