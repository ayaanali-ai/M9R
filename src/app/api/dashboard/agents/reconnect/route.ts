import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabase } from "@/lib/supabase";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";

/**
 * POST /api/dashboard/agents/reconnect — records "a human asked to reconnect
 * agents" for the caller's workspace. Cannot itself wake a dead process on
 * the human's machine (a server has no path into their computer) -- this
 * only writes a request the CLI's own poll loop picks up, so it only helps
 * when a bridge is stuck "failed" (exhausted its restart budget) while the
 * parent terminal runtime process is still alive and polling; if the whole
 * process is gone, nothing is listening for this at all.
 */
export async function POST() {
  const auth = await createClient();
  if (!auth) return NextResponse.json({ error: "Authentication is unavailable." }, { status: 503 });
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const workspaceId = await resolveActiveOrDefaultProjectId(auth, {
    id: user.id,
    email: user.email,
    name: (user.user_metadata?.name as string | undefined) ?? null,
  });
  if (!workspaceId) return NextResponse.json({ error: "No workspace is available for this account." }, { status: 404 });
  if (!supabase) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });

  // handled_at/handled_summary are cleared on every new request -- otherwise
  // a stale confirmation from a previous click could be shown as if it were
  // this one's result, which would be worse than no feedback at all.
  const { error } = await supabase.from("bridge_reconnect_requests").upsert(
    { workspace_id: workspaceId, requested_at: new Date().toISOString(), requested_by_user_id: user.id, handled_at: null, handled_summary: null },
    { onConflict: "workspace_id" },
  );
  if (error) return NextResponse.json({ error: "Could not record the reconnect request." }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/**
 * GET /api/dashboard/agents/reconnect — lets the dashboard button poll for
 * whether the local runtime actually picked up its request yet, instead of
 * a blind "Requested" that reverts to idle with no idea what happened.
 */
export async function GET() {
  const auth = await createClient();
  if (!auth) return NextResponse.json({ error: "Authentication is unavailable." }, { status: 503 });
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const workspaceId = await resolveActiveOrDefaultProjectId(auth, {
    id: user.id,
    email: user.email,
    name: (user.user_metadata?.name as string | undefined) ?? null,
  });
  if (!workspaceId) return NextResponse.json({ error: "No workspace is available for this account." }, { status: 404 });
  if (!supabase) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });

  const { data, error } = await supabase
    .from("bridge_reconnect_requests")
    .select("requested_at, handled_at, handled_summary")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Could not read the reconnect request." }, { status: 500 });
  return NextResponse.json({
    requestedAt: data?.requested_at ?? null,
    handledAt: data?.handled_at ?? null,
    summary: data?.handled_summary ?? null,
  });
}
