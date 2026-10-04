import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { personNames } from "@/lib/rooms/person-names";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ roomId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Return only admitted, minimized room identities and active agent seats. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to view room members." }, { status: 401 });
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });

  const { data: memberRows, error: memberError } = await db.from("m9r_room_members")
    .select("id, user_id, role, joined_at, guest_display_name")
    .eq("room_id", roomId)
    .eq("status", "active")
    .order("joined_at", { ascending: true })
    .limit(100);
  if (memberError) {
    console.error("List room members failed:", memberError.message);
    return NextResponse.json({ error: "Room members are unavailable." }, { status: 500 });
  }

  const rows = memberRows ?? [];
  const memberIds = rows.map((member) => member.id);
  let seats: Array<{ id: string; member_id: string; agent_kind: string; agent_label: string }> = [];
  if (memberIds.length > 0) {
    const { data, error } = await db.from("m9r_room_agent_seats")
      .select("id, member_id, agent_kind, agent_label")
      .eq("room_id", roomId)
      .eq("status", "active")
      .in("member_id", memberIds)
      .limit(200);
    if (error) {
      console.error("List room agent seats failed:", error.message);
      return NextResponse.json({ error: "Room agent identities are unavailable." }, { status: 500 });
    }
    seats = data ?? [];
  }

  const names = await personNames(rows.map((member) => member.user_id as string));
  const members = rows.map((member) => ({
    actorId: `member:${member.id}`,
    // Admitted members see each other by name; someone with no profile name at all falls back to a short, neutral label.
    userId: member.user_id as string,
    displayName: member.user_id === user.id ? "You" : names.get(member.user_id as string) ?? member.guest_display_name ?? "Room member",
    role: member.role,
    isYou: member.user_id === user.id,
    joinedAt: member.joined_at,
    agents: seats.filter((seat) => seat.member_id === member.id).map((seat) => ({
      actorId: `seat:${seat.id}`,
      label: seat.agent_label,
      provider: seat.agent_kind,
    })),
  }));
  return NextResponse.json({ members }, { headers: { "cache-control": "no-store" } });
}
