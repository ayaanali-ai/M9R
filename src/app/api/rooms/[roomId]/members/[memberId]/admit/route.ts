import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ roomId: string; memberId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(_request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to admit a room member." }, { status: 401 });
  const { roomId, memberId } = await context.params;
  if (!UUID.test(roomId) || !UUID.test(memberId)) return NextResponse.json({ error: "Room member not found." }, { status: 404 });
  const { data, error } = await db.rpc("admit_m9r_room_member", { p_room_id: roomId, p_member_id: memberId });
  if (error || !Array.isArray(data) || !data[0]) {
    const status = error?.code === "42501" ? 403 : error?.code === "P0002" ? 404 : 500;
    if (status === 500) console.error("Admit room member failed:", error?.message);
    return NextResponse.json({ error: status === 403 ? "You cannot admit members to this room." : status === 404 ? "Room member not found." : "Could not admit the room member." }, { status });
  }
  return NextResponse.json({ ok: true, membership: data[0] }, { headers: { "cache-control": "no-store" } });
}
