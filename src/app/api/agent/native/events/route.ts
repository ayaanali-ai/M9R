import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { supabase } from "@/lib/supabase";
import { hashSecret } from "@/lib/agent-join";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(["agent_connected", "task_created", "task_delivered", "task_approved", "task_result"]);

/** Redacted metadata only. Prompt text, output, paths and arbitrary notes are rejected.
 * The uploader selects a workspace from the task/session working directory
 * and a consented repo-root binding before calling this endpoint.
 */
export async function POST(request: NextRequest) {
  if (!supabase) return NextResponse.json({ error: "Backend unavailable." }, { status: 503 });
  const rawToken = bearerFrom(request.headers.get("authorization"));
  const machine = rawToken ? await supabase.from("native_devices")
    .select("workspace_id, connection_id, device_id")
    .eq("token_hash", hashSecret(rawToken)).is("revoked_at", null).maybeSingle() : null;
  const agent = machine?.data ? null : await authenticateAgent(rawToken);
  if (!machine?.data && !agent) return NextResponse.json({ error: "Invalid or missing token." }, { status: 401 });
  if (machine?.data) {
    const { data: connection } = await supabase.from("agent_connections").select("status")
      .eq("id", machine.data.connection_id).maybeSingle();
    if (connection?.status !== "active") return NextResponse.json({ error: "Connection inactive." }, { status: 401 });
  }
  const raw = await request.text();
  if (raw.length > 65_536) return NextResponse.json({ error: "Batch too large." }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid batch." }, { status: 400 });
  const { deviceId, events } = body as { deviceId?: unknown; events?: unknown };
  if (typeof deviceId !== "string" || !UUID.test(deviceId) || !Array.isArray(events) || events.length < 1 || events.length > 100) {
    return NextResponse.json({ error: "Invalid device or batch size." }, { status: 400 });
  }
  if (machine?.data && machine.data.device_id !== deviceId) return NextResponse.json({ error: "Wrong device." }, { status: 403 });
  const rows = [];
  for (const value of events) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return NextResponse.json({ error: "Invalid event." }, { status: 400 });
    const event = value as Record<string, unknown>;
    if (Object.keys(event).some((key) => !["id", "seq", "kind", "taskId", "handle", "occurredAt"].includes(key))) {
      return NextResponse.json({ error: "Event contains unsupported fields." }, { status: 400 });
    }
    if (typeof event.id !== "string" || !UUID.test(event.id) || typeof event.kind !== "string" || !KINDS.has(event.kind)
      || typeof event.seq !== "number" || !Number.isSafeInteger(event.seq) || event.seq < 0
      || (event.taskId != null && (typeof event.taskId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(event.taskId)))
      || (event.handle != null && (typeof event.handle !== "string" || !/^[a-z0-9-]{1,80}$/.test(event.handle)))
      || typeof event.occurredAt !== "string" || !Number.isFinite(Date.parse(event.occurredAt))) {
      return NextResponse.json({ error: "Invalid event metadata." }, { status: 400 });
    }
    rows.push({ workspace_id: machine?.data?.workspace_id ?? agent!.workspaceId, connection_id: machine?.data?.connection_id ?? agent!.connectionId, device_id: deviceId,
      event_id: event.id, seq: event.seq, kind: event.kind, task_id: event.taskId ?? null,
      handle: event.handle ?? null, occurred_at: event.occurredAt });
  }
  const { error } = await supabase.from("native_events").upsert(rows, { onConflict: "device_id,event_id", ignoreDuplicates: true });
  if (error) return NextResponse.json({ error: "Could not store events." }, { status: 500 });
  if (machine?.data) await supabase.from("native_devices").update({ last_seen_at: new Date().toISOString() })
    .eq("connection_id", machine.data.connection_id).eq("device_id", deviceId);
  return NextResponse.json({ accepted: rows.length });
}
