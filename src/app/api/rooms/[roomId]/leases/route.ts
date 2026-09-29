import { NextRequest, NextResponse } from "next/server";
import { normalizeRoomLeaseRequest } from "@/lib/rooms/room-coordination";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ roomId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read unexpired coordination leases. RLS requires active room membership. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to view room leases." }, { status: 401 });
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });

  const { data, error } = await db.from("m9r_room_leases")
    .select("room_id, resource_key, holder_member_id, holder_seat_id, expires_at, version, preempted_member_id, preempted_seat_id, preempted_expires_at")
    .eq("room_id", roomId)
    .gt("expires_at", new Date().toISOString())
    .order("resource_key", { ascending: true })
    .limit(500);
  if (error) {
    console.error("List room leases failed:", error.message);
    return NextResponse.json({ error: "Room leases are unavailable." }, { status: 500 });
  }
  return NextResponse.json({ leases: data ?? [] }, { headers: { "cache-control": "no-store" } });
}

/** Claim, renew, release, or explicitly owner-preempt one bounded room resource lease. */
export async function POST(request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to change a room lease." }, { status: 401 });
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 16 * 1024) return NextResponse.json({ error: "Room lease request is too large." }, { status: 413 });
  let body: unknown;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 16 * 1024) return NextResponse.json({ error: "Room lease request is too large." }, { status: 413 });
    body = JSON.parse(raw) as unknown;
  } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const normalized = normalizeRoomLeaseRequest(body);
  if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });

  const leaseRequest = normalized.value;
  const { data, error } = await db.rpc("act_m9r_room_lease", {
    p_room_id: roomId,
    p_resource_key: leaseRequest.resourceKey,
    p_action: leaseRequest.action,
    p_actor_seat_id: leaseRequest.actorSeatId,
    p_ttl_ms: leaseRequest.ttlMs,
    p_preempt: leaseRequest.preempt,
    p_client_event_id: leaseRequest.clientEventId,
  });
  const result = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
  if (error || !result) {
    const status = error?.code === "42501" ? 403 : error?.code === "P0002" ? 404 : error?.code === "22023" ? 400 : 500;
    if (status === 500) console.error("Update room lease failed:", error?.message);
    return NextResponse.json({ error: status === 403 ? "You are not permitted to change this room lease."
      : status === 404 ? "Room not found."
        : status === 400 ? "Room lease request is invalid."
          : "Could not update the room lease." }, { status });
  }

  const lease = result.holder_member_id ? {
    room_id: roomId,
    resource_key: result.resource_key,
    holder_member_id: result.holder_member_id,
    holder_seat_id: result.holder_seat_id,
    expires_at: result.expires_at,
    version: result.version,
  } : null;
  const ok = result.ok === true;
  const status = ok ? 200 : result.reason === "lease_held" || result.reason === "lease_held_by_another_participant" ? 409 : 404;
  return NextResponse.json({ ok, reason: result.reason, lease }, { status, headers: { "cache-control": "no-store" } });
}
