import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hashRoomInviteToken } from "@/lib/cross-machine-room-core";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to accept a room invite." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const token = body && typeof body === "object" && !Array.isArray(body) ? (body as { token?: unknown }).token : undefined;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(token)) return NextResponse.json({ error: "A valid invite token is required." }, { status: 400 });
  const { data, error } = await db.rpc("accept_m9r_room_invite", { p_token_hash: hashRoomInviteToken(token) });
  if (error || !Array.isArray(data) || !data[0]) {
    const status = error?.code === "42501" ? 403 : ["P0002", "P0003", "P0004"].includes(error?.code ?? "") ? 410 : 500;
    if (status === 500) console.error("Accept room invite failed:", error?.message);
    return NextResponse.json({ error: status === 403 ? "This invite is for a different signed-in email." : status === 410 ? "This invite is invalid, expired, or already used." : "Could not accept the room invite." }, { status });
  }
  return NextResponse.json({ ok: true, membership: data[0] }, { headers: { "cache-control": "no-store" } });
}
