import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// GET /api/auth/debug — DEV-ONLY auth diagnostics.
//
// Reveals whether the SERVER (cookie-based @supabase/ssr) sees a session, and
// whether Supabase auth cookies are present on the request. Pair with the
// browser session check on /auth to spot a client/server disagreement (the
// classic "localStorage signed-in, cookies signed-out" split).
//
// Never returns tokens, secrets, or cookie values — only booleans + id/email.
// Disabled (404) outside development so it can't leak in production.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const cookieStore = await cookies();
  const authCookieNames = cookieStore
    .getAll()
    .map((c) => c.name)
    .filter((name) => name.startsWith("sb-") && name.includes("auth-token"));

  const supabase = await createClient();
  const configured = Boolean(supabase);
  const { data, error } = supabase
    ? await supabase.auth.getUser()
    : { data: { user: null }, error: null };

  return NextResponse.json({
    authenticated: Boolean(data.user),
    userId: data.user?.id ?? null,
    email: data.user?.email ?? null,
    supabaseConfigured: configured,
    authCookiePresent: authCookieNames.length > 0,
    authCookieCount: authCookieNames.length,
    path: req.nextUrl.pathname,
    error: error?.message ?? null,
  });
}
