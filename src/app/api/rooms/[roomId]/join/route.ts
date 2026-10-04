import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ roomId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to request room admission." }, { status: 401 });
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });
  // Only an anonymous guest's own typed name/email is ever accepted here -- a signed-in member
  // already has a real profile, and these two fields exist purely to identify a guest to the host.
  let guestDisplayName: string | null = null;
  let guestEmail: string | null = null;
  if (user.is_anonymous) {
    const body = await request.json().catch(() => null) as { displayName?: unknown; email?: unknown } | null;
    if (typeof body?.displayName === "string") guestDisplayName = body.displayName.slice(0, 80);
    if (typeof body?.email === "string") guestEmail = body.email.slice(0, 320);
  }
  const { data, error } = await db.rpc("request_m9r_room_join", {
    p_room_id: roomId,
    p_guest_display_name: guestDisplayName,
    p_guest_email: guestEmail,
  });
  if (error || !Array.isArray(data) || !data[0]) {
    const status = error?.code === "42501" ? 403 : error?.code === "P0002" ? 404 : 500;
    if (status === 500) console.error("Request room admission failed:", error?.message);
    return NextResponse.json({ error: status === 403 ? "You are not allowed to request this room." : status === 404 ? "Room not found." : "Could not request room admission." }, { status });
  }
  return NextResponse.json({ ok: true, membership: data[0], quietUntilInvited: true }, { status: 202, headers: { "cache-control": "no-store" } });
}
