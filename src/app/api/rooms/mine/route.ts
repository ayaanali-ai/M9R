import { NextRequest, NextResponse } from "next/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// GET /api/rooms/mine — the signed-in user's active workspace IS their room
// now (the rooms→workspace pivot): resolve-or-lazily-create that workspace's
// one room and hand back its id, so the client can redirect straight there
// instead of showing a separate "create a room" form.
// ---------------------------------------------------------------------------

export async function GET(_request: NextRequest) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to open your room." }, { status: 401 });

  try {
    const workspaceId = await resolveActiveOrDefaultProjectId(db, { id: user.id, email: user.email });
    const { data: room, error } = await db.rpc("m9r_ensure_workspace_room", { p_workspace_id: workspaceId }).single();
    if (error || !room) {
      console.error("Ensure workspace room failed:", error?.message);
      return NextResponse.json({ error: "Could not open your room." }, { status: 500 });
    }
    const roomRow = room as { id: string; name: string; status: string };
    return NextResponse.json({ room: { id: roomRow.id, name: roomRow.name, status: roomRow.status } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Resolve workspace room failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not open your room." }, { status: 500 });
  }
}
