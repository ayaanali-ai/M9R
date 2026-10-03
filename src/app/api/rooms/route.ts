import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { createClient } from "@/lib/supabase/server";
import { parseRoomName } from "@/lib/cross-machine-room-core";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to create a room." }, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const name = parseRoomName(body && typeof body === "object" && !Array.isArray(body) ? (body as { name?: unknown }).name : undefined);
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });

  try {
    const workspaceId = await resolveActiveOrDefaultProjectId(db, { id: user.id, email: user.email });
    const { data: membership, error: membershipError } = await db.from("workspace_members").select("role")
      .eq("workspace_id", workspaceId).eq("user_id", user.id).maybeSingle();
    if (membershipError) return NextResponse.json({ error: "Could not verify workspace membership." }, { status: 500 });
    if (!membership) return NextResponse.json({ error: "You are not a member of the active workspace." }, { status: 403 });

    // The creator becomes a member in an AFTER INSERT trigger, and rooms can only be read by members. Asking for the row back
    // in the same statement is therefore refused by row-level security, so insert first and read the room in a second step.
    const roomId = randomUUID();
    const { error } = await db.from("m9r_rooms").insert({ id: roomId, workspace_id: workspaceId, created_by: user.id, name: name.value });
    if (error) {
      console.error("Create room failed:", error.message);
      return NextResponse.json({ error: "Could not create the room." }, { status: 500 });
    }
    const { data: room, error: readError } = await db.from("m9r_rooms")
      .select("id, workspace_id, created_by, name, status, policy_version, created_at")
      .eq("id", roomId)
      .single();
    if (readError || !room) {
      console.error("Read new room failed:", readError?.message);
      return NextResponse.json({ error: "Could not create the room." }, { status: 500 });
    }
    return NextResponse.json({ room }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Create room failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not create the room." }, { status: 500 });
  }
}
