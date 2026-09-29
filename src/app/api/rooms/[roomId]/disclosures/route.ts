import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { normalizeRoomEvent } from "@/lib/rooms/room-events";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ roomId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLASSES = new Set(["room_content", "own_messages", "own_files_named", "account_facts"]);

export async function POST(request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to request a disclosure." }, { status: 401 });
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const agentSeatId = typeof value.agentSeatId === "string" ? value.agentSeatId.trim() : "";
  const askedBy = typeof value.askedBy === "string" ? value.askedBy.trim() : "";
  const subject = typeof value.subject === "string" ? value.subject.trim() : "";
  const dataClass = typeof value.dataClass === "string" ? value.dataClass : "";
  const audience = typeof value.audience === "string" ? value.audience : "";
  const proposedText = typeof value.proposedText === "string" ? value.proposedText : "";
  const event = value.proposedEvent === undefined ? null : normalizeRoomEvent(value.proposedEvent);
  if (event && (!event.ok || event.value.actorSeatId !== agentSeatId || ["action", "handoff"].includes(event.value.kind))) {
    return NextResponse.json({ error: "Proposed agent event is invalid." }, { status: 400 });
  }
  if (!UUID.test(agentSeatId) || !askedBy || askedBy.length > 128 || !subject || subject.length > 200 || !CLASSES.has(dataClass) || !audience || audience.length > 256 || (!event && (!proposedText || proposedText.length > 4_000))) return NextResponse.json({ error: "Disclosure details are invalid." }, { status: 400 });
  const expiry = new Date(Date.now() + 10 * 60_000).toISOString();
  const details = {
    p_room_id: roomId, p_agent_seat_id: agentSeatId, p_asked_by: askedBy, p_subject: subject, p_data_class: dataClass,
    p_audience: audience, p_proposed_text_digest: createHash("sha256").update(proposedText).digest("hex"),
    p_expires_at: expiry,
  };
  const { data, error } = event && event.ok
    ? await db.rpc("request_m9r_room_event_disclosure", {
      p_room_id: roomId, p_agent_seat_id: agentSeatId, p_asked_by: askedBy, p_subject: subject, p_data_class: dataClass,
      p_audience: audience, p_proposed_payload: event.value.payload, p_expires_at: expiry,
    })
    : await db.rpc("create_m9r_disclosure_request", details);
  if (error || !Array.isArray(data) || !data[0]) {
    const status = error?.code === "42501" ? 403 : error?.code === "P0002" ? 404 : 500;
    if (status === 500) console.error("Create disclosure request failed:", error?.message);
    return NextResponse.json({ error: status === 403 ? "The room owner scope does not permit this disclosure." : status === 404 ? "Room not found." : "Could not create the disclosure request." }, { status });
  }
  const result = data[0] as { state?: string; request_id?: string; receipt_id?: string | null };
  return NextResponse.json({ ok: true, held: result.state === "pending", request: result }, { status: result.state === "allowed" ? 200 : 202, headers: { "cache-control": "no-store" } });
}
