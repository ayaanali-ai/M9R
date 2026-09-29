import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { projectRoomEventType } from "@/lib/rooms/room-event-export";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ roomId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type EventRow = { id: string; room_id: string; sequence: number; actor_user_id: string | null; actor_seat_id: string | null; kind: string; causal_event_ids: string[]; payload_digest: string; payload: unknown; created_at: string };

/** Exports minimized authenticated room events. It never upgrades a messages-only history to a complete trace. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to export a room." }, { status: 401 });
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });
  const { data, error } = await db.from("m9r_room_events").select("id, room_id, sequence, actor_user_id, actor_seat_id, kind, causal_event_ids, payload_digest, payload, created_at").eq("room_id", roomId).order("sequence", { ascending: true }).limit(10_000);
  if (error) {
    console.error("Export room events failed:", error.message);
    return NextResponse.json({ error: "Room export is unavailable." }, { status: 500 });
  }
  const events = ((data ?? []) as EventRow[]).map((event) => {
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
    const actorId = event.actor_seat_id ?? event.actor_user_id ?? "unknown";
    const type = projectRoomEventType(event.kind, payload);
    return {
      eventId: event.id,
      roomId: event.room_id,
      sequence: event.sequence,
      actorId,
      actorKind: event.actor_seat_id ? "agent" : "human",
      type,
      dependsOn: event.causal_event_ids ?? [],
      ...(typeof payload.recipientActorId === "string" ? { recipientActorId: payload.recipientActorId } : {}),
      ...(typeof payload.replyTo === "string" ? { replyTo: payload.replyTo } : {}),
      ...(type === "room.shared_target.confirmed" ? { target: payload.target } : {}),
      createdAt: event.created_at,
    };
  });
  const pageGroups = events.flatMap((event) => {
    const target = event.target as { pageGroupId?: unknown; origin?: unknown; path?: unknown; tabRef?: unknown } | undefined;
    return target && typeof target.pageGroupId === "string" && typeof target.origin === "string" && typeof target.path === "string" && typeof target.tabRef === "string"
      ? [{ pageGroupId: target.pageGroupId, origin: target.origin, path: target.path, ownerConfirmed: true as const, members: [{ actorId: event.actorId, tabRef: target.tabRef }] }]
      : [];
  });
  const groups = [...new Map(pageGroups.map((group) => [group.pageGroupId, group])).values()];
  const complete = events.length > 0 && events.every((event) => event.type !== "room.presence" || Boolean(event.target));
  return NextResponse.json({ schema: "m9r.room-log/0", roomId, exportedAt: new Date().toISOString(), source: "authenticated minimized room event history", traceCoverage: complete ? "complete" : "messages-only", pageGroups: groups, events }, { headers: { "cache-control": "no-store" } });
}
