import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ roomId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// GET /api/rooms/[roomId] — the room's name/status and the caller's own
// membership state ('none' | 'requested' | 'invited' | 'active' | ...), by
// room ID alone. Guessing a room ID must reveal neither existence nor
// content: a caller with no membership row and no admin standing gets the
// same 404 a nonexistent room would.
// ---------------------------------------------------------------------------

export async function GET(_request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to view this room." }, { status: 401 });
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });
  const { data, error } = await db.rpc("get_m9r_room_view", { p_room_id: roomId });
  if (error || !Array.isArray(data) || !data[0]) {
    if (error && error.code !== "P0002") console.error("Get room view failed:", error.message);
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }
  const view = data[0] as { room_id: string; name: string; status: string; my_status: string };
  return NextResponse.json({
    room: { id: view.room_id, name: view.name, status: view.status },
    membership: { status: view.my_status },
  }, { headers: { "cache-control": "no-store" } });
}
