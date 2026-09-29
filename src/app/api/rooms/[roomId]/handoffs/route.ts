import { NextRequest, NextResponse } from "next/server";
import { normalizeRoomHandoffRequest } from "@/lib/rooms/room-coordination";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ roomId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Run one authenticated, state-checked handoff transition. Acceptance atomically transfers task assignment and lease. */
export async function POST(request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to change a room handoff." }, { status: 401 });
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 16 * 1024) return NextResponse.json({ error: "Room handoff request is too large." }, { status: 413 });
  let body: unknown;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 16 * 1024) return NextResponse.json({ error: "Room handoff request is too large." }, { status: 413 });
    body = JSON.parse(raw) as unknown;
  } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const normalized = normalizeRoomHandoffRequest(body);
  if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });
  const handoff = normalized.value;

  const { data, error } = await db.rpc("act_m9r_room_handoff", {
    p_room_id: roomId,
    p_handoff_id: handoff.handoffId,
    p_task_id: handoff.taskId,
    p_action: handoff.action,
    p_actor_seat_id: handoff.actorSeatId,
    p_recipient_actor_id: handoff.recipientActorId,
    p_context: handoff.context,
    p_done_criteria: handoff.doneCriteria,
    p_response: handoff.response,
    p_client_event_id: handoff.clientEventId,
  });
  if (error || !Array.isArray(data) || !data[0]) {
    const status = error?.code === "42501" ? 403 : error?.code === "P0002" ? 404
      : error?.code === "22023" ? 400 : error?.code === "55P03" ? 409 : 500;
    if (status === 500) console.error("Update room handoff failed:", error?.message);
    return NextResponse.json({ error: status === 403 ? "You are not permitted to make this handoff transition."
      : status === 404 ? "The shared task or room was not found."
        : status === 400 ? "Room handoff request is invalid."
          : status === 409 ? "The task lease changed; refresh the room before retrying."
            : "Could not update the room handoff." }, { status });
  }
  return NextResponse.json({ result: data[0] }, { headers: { "cache-control": "no-store" } });
}
