import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ roomId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Register one agent seat for the authenticated room member; disclosure requests must use this bound id. */
export async function POST(request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to register a room agent." }, { status: 401 });
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const agentKind = typeof value.agentKind === "string" ? value.agentKind.trim() : "";
  const agentLabel = typeof value.agentLabel === "string" ? value.agentLabel.trim() : "";
  if (!agentKind || agentKind.length > 80 || !agentLabel || agentLabel.length > 120) return NextResponse.json({ error: "Agent seat details are invalid." }, { status: 400 });
  const { data, error } = await db.rpc("register_m9r_room_agent_seat", { p_room_id: roomId, p_agent_kind: agentKind, p_agent_label: agentLabel });
  if (error || !Array.isArray(data) || !data[0]) {
    const status = error?.code === "42501" ? 403 : error?.code === "P0002" ? 404 : 500;
    if (status === 500) console.error("Register room agent failed:", error?.message);
    return NextResponse.json({ error: status === 403 ? "You are not an active member of this room." : status === 404 ? "Room not found." : "Could not register the room agent." }, { status });
  }
  return NextResponse.json({ ok: true, seat: data[0] }, { status: 201, headers: { "cache-control": "no-store" } });
}
