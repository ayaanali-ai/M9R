import { NextRequest, NextResponse } from "next/server";
import { normalizeRoomEvent } from "@/lib/rooms/room-events";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ roomId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read the latest room facts or a bounded page after the supplied server sequence cursor. RLS hides other rooms. */
export async function GET(request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to read room activity." }, { status: 401 });
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });

  const url = new URL(request.url);
  const afterText = url.searchParams.get("after");
  const after = afterText === null ? 0 : Number(afterText);
  const limitText = url.searchParams.get("limit");
  const requestedLimit = limitText === null ? 100 : Number(limitText);
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return NextResponse.json({ error: "Room event cursor or limit is invalid." }, { status: 400 });
  }

  let query = db.from("m9r_room_events")
    .select("id, room_id, sequence, actor_user_id, actor_seat_id, kind, causal_event_ids, payload_digest, payload, created_at")
    .eq("room_id", roomId);
  if (after > 0) query = query.gt("sequence", after).order("sequence", { ascending: true });
  else query = query.order("sequence", { ascending: false });
  const { data, error } = await query.limit(requestedLimit);
  if (error) {
    console.error("Read room events failed:", error.message);
    return NextResponse.json({ error: "Room activity is unavailable." }, { status: 500 });
  }
  const events = (data ?? []) as Array<Record<string, unknown>>;
  if (after === 0) events.reverse();
  return NextResponse.json({ events }, { headers: { "cache-control": "no-store" } });
}

/** Append one minimized authenticated event; the client never chooses actor identity or writes raw page data. */
export async function POST(request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to append a room event." }, { status: 401 });
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 24 * 1024) return NextResponse.json({ error: "Room event request is too large." }, { status: 413 });
  let body: unknown;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 24 * 1024) return NextResponse.json({ error: "Room event request is too large." }, { status: 413 });
    body = JSON.parse(raw) as unknown;
  } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const normalized = normalizeRoomEvent(body);
  if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });
  const event = normalized.value;
  if (event.kind === "handoff") {
    return NextResponse.json({ error: "Handoffs must use the state-checked handoff endpoint." }, { status: 400 });
  }
  const { data, error } = await db.rpc("append_m9r_room_event", {
    p_room_id: roomId,
    p_kind: event.kind,
    p_actor_seat_id: event.actorSeatId,
    p_causal_event_ids: event.causalEventIds,
    p_payload_digest: event.payloadDigest,
    p_payload: event.payload,
    p_client_event_id: event.clientEventId,
  });
  if (error || !Array.isArray(data) || !data[0]) {
    const status = error?.code === "42501" ? 403 : error?.code === "P0002" ? 404 : error?.code === "22023" ? 400 : error?.code === "55P03" || error?.code === "40001" ? 409 : 500;
    if (status === 500) console.error("Append room event failed:", error?.message);
    return NextResponse.json({
      error: status === 403 ? "You are not allowed to append this room event."
        : status === 404 ? "Room not found."
      : status === 400 ? "Room event details are invalid."
        : status === 409 ? error?.code === "40001" && event.kind === "artifact"
          ? "This shared artifact changed since you opened it. Refresh, review the latest version, and reapply your edit."
          : "The task is currently leased to another room participant."
          : "Could not append the room event.",
    }, { status });
  }
  return NextResponse.json({ ok: true, event: data[0] }, { status: 200, headers: { "cache-control": "no-store" } });
}
