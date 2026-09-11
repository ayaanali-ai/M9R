import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { readUsageLimitCooldown, recordUsageLimitCooldown } from "@/lib/bridge/usage-limit-cooldown-service";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// GET/POST /api/agent/conversations/[id]/usage-limit-cooldown -- the durable
// half of the bridge's in-memory usage-limit cooldown. GET is called once per
// conversation, the first time a resident process touches it after starting,
// to recover a cooldown a restart would otherwise silently forget. POST is
// called whenever bridge-runtime.ts's recordUsageLimitCooldownIfApplicable
// sets one. Both are best-effort from the bridge's side: a failed persist
// must never block the in-memory cooldown that already protects this run.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: conversationId } = await params;
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const cooldown = await readUsageLimitCooldown(agent, conversationId);
    return NextResponse.json({ cooldown });
  } catch (err) {
    return handleAgentError(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: conversationId } = await params;
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const cooldownUntil = typeof body.cooldownUntil === "string" ? body.cooldownUntil : "";
    const reason = typeof body.reason === "string" ? body.reason : "";
    if (!cooldownUntil || Number.isNaN(Date.parse(cooldownUntil))) return NextResponse.json({ error: "cooldownUntil must be a valid ISO timestamp." }, { status: 400 });
    if (!reason) return NextResponse.json({ error: "reason is required." }, { status: 400 });
    await recordUsageLimitCooldown(agent, { conversationId, cooldownUntil, reason });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleAgentError(err);
  }
}
