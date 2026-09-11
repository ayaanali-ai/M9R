import { NextRequest, NextResponse } from "next/server";
import { supabase as admin } from "@/lib/supabase";
import { enforceRateLimit } from "@/lib/rate-limit";
import { validateUsername } from "@/lib/username";

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, { routeGroup: "auth:username-check", limit: 20, windowSeconds: 60 });
  if (limited) return limited;
  const body = await request.json().catch(() => null) as { username?: unknown } | null;
  const checked = validateUsername(typeof body?.username === "string" ? body.username : "");
  if (!checked.ok) return NextResponse.json({ available: false, error: checked.error }, { status: 400 });
  if (!admin) return NextResponse.json({ error: "Username check unavailable." }, { status: 503 });
  const { data, error } = await admin.from("users").select("id").ilike("username", checked.username).limit(1);
  if (error) return NextResponse.json({ error: "Username check unavailable." }, { status: 503 });
  return NextResponse.json({ available: !data?.length });
}
