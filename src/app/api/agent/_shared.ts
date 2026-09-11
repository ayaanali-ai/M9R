import { NextRequest, NextResponse } from "next/server";
import { AgentJoinError } from "@/lib/agent-join-service";
import { PlanLimitError } from "@/lib/plan-limits-service";
import { ChatEvidenceError } from "@/lib/bridge/chat-evidence-service";

/**
 * Shared helpers for the /api/agent/* routes: base-URL resolution for claim
 * links and a single error mapper so every route reports failures the same way
 * without leaking request content.
 */

const FALLBACK_BASE_URL = "https://m9r.vercel.app";

/**
 * Resolve the public base URL for building claim links. Only trusts the
 * request's Host/X-Forwarded-Host headers outside production, where they are
 * attacker-controllable (this backs the unauthenticated /api/agent/register
 * claim link and the billing redirect URLs). In production, a missing
 * NEXT_PUBLIC_SITE_URL fails closed to the hardcoded fallback instead of
 * trusting request headers.
 */
export function resolveBaseUrl(req: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");

  if (process.env.NODE_ENV !== "production") {
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    if (host) {
      const proto = req.headers.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
      return `${proto}://${host}`;
    }
  }
  return FALLBACK_BASE_URL;
}

/** Map any error to a JSON response. Logs only the message, never request body. */
export function handleAgentError(err: unknown): NextResponse {
  if (err instanceof AgentJoinError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof PlanLimitError) {
    return NextResponse.json({ error: err.message, code: err.code, usage: err.usage }, { status: err.status });
  }
  if (err instanceof ChatEvidenceError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error("Agent route error:", err instanceof Error ? err.message : err);
  return NextResponse.json({ error: "Internal server error." }, { status: 500 });
}
