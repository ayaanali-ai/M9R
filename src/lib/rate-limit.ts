import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";

export type RateLimitPolicy = {
  routeGroup: string;
  limit: number;
  windowSeconds: number;
};

type RateLimitRow = {
  allowed: boolean;
  remaining: number;
  reset_at: string;
};

function clientAddress(request: NextRequest): string {
  // `cf-connecting-ip` is set by Cloudflare's own edge on every request and overwritten on the way in, so a client cannot
  // forge it. `x-vercel-forwarded-for` and `x-forwarded-for` are ordinary request headers a caller can set to anything,
  // which let every request mint a fresh rate-limit key. This app runs on Cloudflare Workers, not Vercel, so the Vercel
  // header was never set by the platform here in the first place.
  const cf = request.headers.get("cf-connecting-ip");
  return (cf || "unidentified").split(",", 1)[0].trim().slice(0, 128);
}

function pseudonymousKey(request: NextRequest): string {
  const material = `${process.env.RATE_LIMIT_PEPPER ?? ""}\0${clientAddress(request)}`;
  return createHash("sha256").update(material).digest("hex");
}

/** Consume one durable rate-limit slot. Fails closed if enforcement is unavailable. */
export async function enforceRateLimit(
  request: NextRequest,
  policy: RateLimitPolicy,
): Promise<NextResponse | null> {
  if (!supabase) {
    return NextResponse.json({ error: "Request protection is unavailable." }, { status: 503 });
  }

  const { data, error } = await supabase.rpc("consume_api_rate_limit", {
    p_key_hash: pseudonymousKey(request),
    p_route_group: policy.routeGroup,
    p_window_seconds: policy.windowSeconds,
    p_request_limit: policy.limit,
  });

  if (error || !Array.isArray(data) || data.length !== 1) {
    console.error("Rate-limit enforcement failed:", error?.message ?? "invalid response");
    return NextResponse.json({ error: "Request protection is unavailable." }, { status: 503 });
  }

  const row = data[0] as RateLimitRow;
  if (row.allowed) return null;

  const resetMs = Date.parse(row.reset_at);
  const retryAfter = Number.isFinite(resetMs)
    ? Math.max(1, Math.ceil((resetMs - Date.now()) / 1000))
    : policy.windowSeconds;
  return NextResponse.json(
    { error: "Too many requests. Try again later." },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(policy.limit),
        "X-RateLimit-Remaining": "0",
      },
    },
  );
}

/** Delete expired pseudonymous counters so abuse controls do not become tracking storage. */
export async function cleanupExpiredRateLimits(retentionHours = 48): Promise<number> {
  if (!supabase) throw new Error("Rate-limit storage is unavailable.");
  const boundedHours = Math.min(Math.max(Math.trunc(retentionHours), 24), 168);
  const cutoff = new Date(Date.now() - boundedHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("api_rate_limit_buckets")
    .delete()
    .lt("window_started_at", cutoff)
    .select("key_hash");
  if (error) throw new Error(`Rate-limit cleanup failed: ${error.message}`);
  return data?.length ?? 0;
}
