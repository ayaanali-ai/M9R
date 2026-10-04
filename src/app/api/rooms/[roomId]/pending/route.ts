import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { personNames } from "@/lib/rooms/person-names";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ roomId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// GET /api/rooms/[roomId]/pending — join requests waiting on the room's
// creator or a workspace owner/admin to admit. Guests never see this list;
// only whoever can actually admit someone can fetch it.
// ---------------------------------------------------------------------------

export async function GET(_request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to view pending requests." }, { status: 401 });
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });
  const { data, error } = await db.rpc("list_m9r_room_pending_members", { p_room_id: roomId });
  if (error) {
    const status = error.code === "42501" ? 403 : 500;
    if (status === 500) console.error("List pending room members failed:", error.message);
    return NextResponse.json({ error: status === 403 ? "You cannot view this room's pending requests." : "Could not list pending requests." }, { status });
  }
  const rows = (Array.isArray(data) ? data : []) as Array<{ member_id: string; user_id: string; requested_at: string; guest_display_name: string | null; guest_email: string | null }>;
  // The host decides who comes in, so each request shows who is asking.
  const names = await personNames(rows.map((row) => row.user_id));
  const pending = rows.map((row) => ({
    memberId: row.member_id,
    userId: row.user_id,
    displayName: names.get(row.user_id) ?? row.guest_display_name ?? null,
    guestEmail: row.guest_email ?? null,
    requestedAt: row.requested_at,
  }));
  return NextResponse.json({ pending }, { headers: { "cache-control": "no-store" } });
}
