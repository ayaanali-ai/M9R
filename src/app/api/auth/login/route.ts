import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabase as admin } from "@/lib/supabase";
import { enforceRateLimit } from "@/lib/rate-limit";
import { normalizeUsername, validateUsername } from "@/lib/username";

const INVALID = "Invalid username, email, or password.";

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, {
    routeGroup: "auth:password-login",
    limit: 10,
    windowSeconds: 60,
  });
  if (limited) return limited;

  const body = await request.json().catch(() => null) as { identifier?: unknown; password?: unknown } | null;
  const identifier = typeof body?.identifier === "string" ? body.identifier.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!identifier || !password || password.length > 1024) {
    return NextResponse.json({ error: INVALID }, { status: 400 });
  }

  let email = identifier;
  if (!identifier.includes("@")) {
    const checked = validateUsername(normalizeUsername(identifier));
    if (!checked.ok || !admin) return NextResponse.json({ error: INVALID }, { status: 401 });
    const { data } = await admin
      .from("users")
      .select("email")
      .ilike("username", checked.username)
      .maybeSingle();
    if (!data?.email) return NextResponse.json({ error: INVALID }, { status: 401 });
    email = data.email as string;
  }

  const auth = await createClient();
  if (!auth) return NextResponse.json({ error: "Authentication unavailable." }, { status: 503 });
  const { error } = await auth.auth.signInWithPassword({ email, password });
  if (error) return NextResponse.json({ error: INVALID }, { status: 401 });
  return NextResponse.json({ ok: true });
}
