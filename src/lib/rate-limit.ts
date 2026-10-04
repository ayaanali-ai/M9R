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

/** The shared bucket primitive both the per-IP and per-identity limiters consume. Fails closed (unavailable = denied). */
async function consumeBucket(keyHash: string, policy: RateLimitPolicy): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number } | { allowed: false; unavailable: true }> {
  if (!supabase) return { allowed: false, unavailable: true };
  const { data, error } = await supabase.rpc("consume_api_rate_limit", {
    p_key_hash: keyHash,
    p_route_group: policy.routeGroup,
    p_window_seconds: policy.windowSeconds,
    p_request_limit: policy.limit,
  });
  if (error || !Array.isArray(data) || data.length !== 1) {
    console.error("Rate-limit enforcement failed:", error?.message ?? "invalid response");
    return { allowed: false, unavailable: true };
  }
  const row = data[0] as RateLimitRow;
  if (row.allowed) return { allowed: true };
  const resetMs = Date.parse(row.reset_at);
  const retryAfterSeconds = Number.isFinite(resetMs) ? Math.max(1, Math.ceil((resetMs - Date.now()) / 1000)) : policy.windowSeconds;
  return { allowed: false, retryAfterSeconds };
}

/** Consume one durable rate-limit slot. Fails closed if enforcement is unavailable. */
export async function enforceRateLimit(
  request: NextRequest,
  policy: RateLimitPolicy,
): Promise<NextResponse | null> {
  const result = await consumeBucket(pseudonymousKey(request), policy);
  if (result.allowed) return null;
  if ("unavailable" in result) return NextResponse.json({ error: "Request protection is unavailable." }, { status: 503 });
  return NextResponse.json(
    { error: "Too many requests. Try again later." },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSeconds),
        "X-RateLimit-Limit": String(policy.limit),
        "X-RateLimit-Remaining": "0",
      },
    },
  );
}

/**
 * Rate-limits agent-to-agent messaging by sender+recipient identity, not by IP. Two agents on the same machine (and
 * so the same cf-connecting-ip) must not share one bucket with each other or with ordinary dashboard traffic from
 * that address -- confirmed real risk: the owner explicitly asked that agents "can't spam each other" through the
 * pill, and an IP-keyed limiter would both fail to catch that (same-IP agents sharing a generous human-traffic
 * budget) and over-throttle unrelated human requests from the same address. Keyed on the (sender, recipient) pair
 * so a chatty exchange between two agents doesn't also burn the budget either one has with a third agent.
 */
export async function enforceAgentMessageRateLimit(
  senderConnectionId: string,
  recipientConnectionId: string | null,
): Promise<{ error: string; retryAfterSeconds: number } | null> {
  const key = createHash("sha256").update(`${process.env.RATE_LIMIT_PEPPER ?? ""}\0agent-message\0${senderConnectionId}\0${recipientConnectionId ?? "*broadcast*"}`).digest("hex");
  // 20 messages per minute to the same recipient (or broadcast) is generous for real back-and-forth coordination
  // and still catches a runaway loop (an agent re-asking the same question, or two agents ping-ponging) quickly.
  const result = await consumeBucket(key, { routeGroup: "agent-message", limit: 20, windowSeconds: 60 });
  if (result.allowed) return null;
  if ("unavailable" in result) return { error: "Message protection is temporarily unavailable. Try again in a moment.", retryAfterSeconds: 10 };
  return { error: "You're sending messages to this agent too quickly. Wait a moment before sending more.", retryAfterSeconds: result.retryAfterSeconds };
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
