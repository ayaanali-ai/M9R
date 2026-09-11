import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { parsePushSubscription } from "@/lib/push-subscription";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../missions/_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req), requireHuman: true });
    if (!principal.userId) throw new MissionApiError("A human user is required.", "human_required", 403);
    const subscription = parsePushSubscription(await req.json().catch(() => null));
    if (!subscription) throw new MissionApiError("A valid HTTPS push subscription is required.", "validation_error", 400);
    if (!supabase) throw new MissionApiError("M9R is not configured.", "backend_not_configured", 503);

    const { error } = await supabase.from("push_subscriptions").upsert({
      user_id: principal.userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      user_agent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,endpoint" });
    if (error) throw new Error(`Failed to save push subscription: ${error.message}`);
    return NextResponse.json({ subscribed: true }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleMissionApiError(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req), requireHuman: true });
    if (!principal.userId) throw new MissionApiError("A human user is required.", "human_required", 403);
    const body = await req.json().catch(() => null) as { endpoint?: unknown } | null;
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
    try {
      if (!endpoint || new URL(endpoint).protocol !== "https:") throw new Error("invalid endpoint");
    } catch {
      throw new MissionApiError("A valid HTTPS push endpoint is required.", "validation_error", 400);
    }
    if (!supabase) throw new MissionApiError("M9R is not configured.", "backend_not_configured", 503);
    const { error } = await supabase.from("push_subscriptions").delete().eq("user_id", principal.userId).eq("endpoint", endpoint);
    if (error) throw new Error(`Failed to remove push subscription: ${error.message}`);
    return NextResponse.json({ subscribed: false }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleMissionApiError(error);
  }
}
