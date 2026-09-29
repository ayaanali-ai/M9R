import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ roomId: string; requestId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, context: RouteContext) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to decide a disclosure." }, { status: 401 });
  const { roomId, requestId } = await context.params;
  if (!UUID.test(roomId) || !UUID.test(requestId)) return NextResponse.json({ error: "Disclosure request not found." }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const decision = body && typeof body === "object" && !Array.isArray(body) ? (body as { decision?: unknown }).decision : undefined;
  if (decision !== "approve" && decision !== "deny") return NextResponse.json({ error: "Decision must be approve or deny." }, { status: 400 });
  const { data, error } = await db.rpc("decide_m9r_disclosure_request", { p_request_id: requestId, p_decision: decision });
  if (error || !Array.isArray(data) || !data[0]) {
    const status = error?.code === "42501" ? 403 : error?.code === "P0002" ? 404 : 500;
    if (status === 500) console.error("Decide disclosure request failed:", error?.message);
    return NextResponse.json({ error: status === 403 ? "You cannot decide this disclosure." : status === 404 ? "Disclosure request not found." : "Could not decide the disclosure request." }, { status });
  }
  return NextResponse.json({ ok: true, receipt: data[0], roomId }, { headers: { "cache-control": "no-store" } });
}
