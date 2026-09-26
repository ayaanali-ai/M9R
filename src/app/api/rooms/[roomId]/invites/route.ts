import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateRoomInviteToken, hashRoomInviteToken, parseRoomInviteEmail, ROOM_INVITE_TTL_MS } from "@/lib/cross-machine-room-core";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ roomId: string }> };
type CreatedRoomInvite = { id: string; room_id: string; invited_email: string; status: string; created_at: string; expires_at: string };

export async function POST(request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to invite someone to a room." }, { status: 401 });

  const { roomId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId)) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const email = parseRoomInviteEmail(body && typeof body === "object" && !Array.isArray(body) ? (body as { email?: unknown }).email : undefined);
  if (!email.ok) return NextResponse.json({ error: email.error }, { status: 400 });

  const token = generateRoomInviteToken();
  const tokenHash = hashRoomInviteToken(token);
  const { data, error } = await db.rpc("create_m9r_room_invite", {
    p_room_id: roomId,
    p_invited_email: email.value,
    p_token_hash: tokenHash,
    p_expires_at: new Date(Date.now() + ROOM_INVITE_TTL_MS).toISOString(),
  });
  if (error || !Array.isArray(data) || !data[0]) {
    const status = error?.code === "42501" ? 403 : error?.code === "P0002" ? 404 : error?.code === "22023" ? 400 : 500;
    if (status === 500) console.error("Create room invite failed:", error?.message);
    return NextResponse.json({ error: status === 403 ? "You cannot invite people to this room." : status === 404 ? "Room not found." : status === 400 ? "Invite details are invalid." : "Could not create the room invite." }, { status });
  }

  // Return the bearer secret once to the authenticated inviter. The database
  // stores only tokenHash; acceptance is intentionally a later step.
  const invite = data[0] as CreatedRoomInvite;
  return NextResponse.json({ invite: {
    id: invite.id,
    room_id: invite.room_id,
    invited_email: invite.invited_email,
    status: invite.status,
    created_at: invite.created_at,
    expires_at: invite.expires_at,
    token,
  } }, { status: 201, headers: { "cache-control": "no-store" } });
}
