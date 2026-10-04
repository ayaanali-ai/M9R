import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listRoomMemory, saveRoomMemory } from "@/lib/shared-memory-service";
import { AgentJoinError } from "@/lib/agent-join-service";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ roomId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function handle(error: unknown) {
  if (error instanceof AgentJoinError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  console.error("Room memory error:", error instanceof Error ? error.message : error);
  return NextResponse.json({ error: "Room memory is temporarily unavailable." }, { status: 500 });
}

/** The room's own shared memory -- a guest who was admitted but never signed up for a workspace can still read this. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });
  try {
    const notes = await listRoomMemory(roomId);
    return NextResponse.json({ notes }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return handle(error); }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { roomId } = await context.params;
  if (!UUID.test(roomId)) return NextResponse.json({ error: "Room not found." }, { status: 404 });
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to save room memory." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  try {
    const result = await saveRoomMemory(roomId, user.id, body);
    return NextResponse.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) { return handle(error); }
}
