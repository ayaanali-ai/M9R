import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { generateAgentToken, hashSecret } from "@/lib/agent-join";
import { supabase } from "@/lib/supabase";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mint a native-events-only machine credential from an already human-approved connection. */
export async function POST(request: NextRequest) {
  const agent = await authenticateAgent(bearerFrom(request.headers.get("authorization")));
  if (!agent || !agent.scopes.includes("session:submit")) return NextResponse.json({ error: "Approved connection required." }, { status: 401 });
  if (!supabase) return NextResponse.json({ error: "Backend unavailable." }, { status: 503 });
  const body = await request.json().catch(() => null) as { deviceId?: unknown } | null;
  if (typeof body?.deviceId !== "string" || !UUID.test(body.deviceId)) return NextResponse.json({ error: "Invalid device ID." }, { status: 400 });
  const token = generateAgentToken();
  const { error } = await supabase.from("native_devices").upsert({
    workspace_id: agent.workspaceId, connection_id: agent.connectionId, device_id: body.deviceId,
    token_hash: hashSecret(token), revoked_at: null, last_seen_at: null,
  }, { onConflict: "connection_id,device_id" });
  if (error) return NextResponse.json({ error: "Could not create machine credential." }, { status: 500 });
  return NextResponse.json({ deviceId: body.deviceId, workspaceId: agent.workspaceId, token }, { headers: { "cache-control": "no-store" } });
}
