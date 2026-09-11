import { NextRequest, NextResponse } from "next/server";
import { setDashboardModerationBan, setDashboardModerationMute } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../_shared";

interface ActionBody {
  kind?: unknown;
  targetKind?: unknown;
  targetId?: unknown;
  conversationId?: unknown;
  active?: unknown;
  reason?: unknown;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as ActionBody | null;
  if ((body?.targetKind !== "user" && body?.targetKind !== "connection") || typeof body?.targetId !== "string" || !body.targetId.trim() || typeof body.active !== "boolean") {
    return NextResponse.json({ error: "kind, targetKind, targetId, and active are required." }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason : null;
  try {
    if (body.kind === "ban") {
      await setDashboardModerationBan({ targetKind: body.targetKind, targetId: body.targetId, banned: body.active, reason });
      return NextResponse.json({ ok: true });
    }
    if (body.kind === "mute") {
      const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
      await setDashboardModerationMute({ targetKind: body.targetKind, targetId: body.targetId, conversationId, muted: body.active, reason });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "kind must be 'ban' or 'mute'." }, { status: 400 });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
