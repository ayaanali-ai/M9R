import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveAgentColor } from "@/lib/agent-color";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/color?connectionId=... — the resolved cursor/mark color for
// one connection: per-person if this workspace has more than one distinct
// human connected, per-agent (the static brand map) if it's solo. Cookie-
// authenticated, RLS-scoped -- a connection outside the caller's own
// workspace membership simply won't be found, same as every other read here.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const connectionId = req.nextUrl.searchParams.get("connectionId");
    if (!connectionId) return NextResponse.json({ error: "connectionId is required." }, { status: 400 });

    const db = await createClient();
    if (!db) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });
    const { data: { user } } = await db.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

    const { data: connection, error } = await db
      .from("agent_connections")
      .select("workspace_id, created_by, agent_kind")
      .eq("id", connectionId)
      .maybeSingle();
    if (error || !connection) {
      // RLS already scopes this select to the caller's own workspaces; a connection that
      // genuinely doesn't exist and one the caller just isn't a member of look identical here
      // on purpose, same as every other per-row lookup in this API.
      return NextResponse.json({ color: null }, { status: 404 });
    }

    const color = await resolveAgentColor(db, {
      workspaceId: connection.workspace_id as string,
      connectedBy: connection.created_by as string | null,
      agentKind: connection.agent_kind as string,
    });
    return NextResponse.json({ color });
  } catch (err) {
    return handleAgentError(err);
  }
}
