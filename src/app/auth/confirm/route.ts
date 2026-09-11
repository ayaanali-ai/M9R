import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeRelativePath } from "@/lib/safe-redirect";

/**
 * `url.origin` (from a bare `new URL(request.url)`) reflects whatever host
 * the Node process itself sees the request arrive on -- behind Render's
 * proxy that's an internal address, not the public domain. Confirmed live:
 * a real magic-link confirm redirected to "https://localhost:10000/...",
 * which no real browser can reach, silently breaking every sign-in.
 * `x-forwarded-host`/`x-forwarded-proto` (already the pattern used by
 * agent.md/route.ts, skill.md/route.ts, and _shared.ts's resolveBaseUrl)
 * carry the real public origin the request was actually made to.
 */
function publicOrigin(request: Request, fallback: string): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (host) {
    const proto = request.headers.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
    return `${proto}://${host}`;
  }
  return fallback;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = publicOrigin(request, url.origin);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  // `next` is attacker-controllable — only honor safe, same-origin relative paths.
  const destination = safeRelativePath(url.searchParams.get("next"));
  const supabase = await createClient();

  if (!supabase) {
    const errorUrl = new URL("/auth", origin);
    errorUrl.searchParams.set("error", "configuration");
    return NextResponse.redirect(errorUrl);
  }

  const result = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
      : { error: new Error("Missing authentication confirmation parameters.") };

  if (result.error) {
    const errorUrl = new URL("/auth", origin);
    errorUrl.searchParams.set("error", "confirmation");
    return NextResponse.redirect(errorUrl);
  }

  return NextResponse.redirect(new URL(destination, origin));
}
