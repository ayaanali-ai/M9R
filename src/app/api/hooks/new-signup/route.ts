import { NextRequest, NextResponse } from "next/server";
import { notifySignup } from "@/lib/notify";
import { enforceRateLimit } from "@/lib/rate-limit";

// ---------------------------------------------------------------------------
// POST /api/hooks/new-signup — Supabase Database Webhook receiver.
//
// Fires on every INSERT into auth.users (email signups AND OAuth), so it can't
// be spoofed or missed the way a client-form hook would be. Configure it in
// Supabase: Database → Webhooks → Create a new hook
//   • Table: auth.users, Events: Insert
//   • Type: HTTP Request → POST → https://<your-domain>/api/hooks/new-signup
//   • HTTP Headers: add  x-signup-secret: <same value as SIGNUP_WEBHOOK_SECRET>
//
// Requires SIGNUP_WEBHOOK_SECRET (shared secret) and a Discord/Slack webhook URL
// (SIGNUP_WEBHOOK_URL, falling back to LEAD_WEBHOOK_URL).
// ---------------------------------------------------------------------------

// Supabase Database Webhook payload shape (only the fields we read).
type SignupHookPayload = {
  type?: string;
  table?: string;
  record?: {
    email?: string | null;
    raw_user_meta_data?: Record<string, unknown> | null;
    app_metadata?: { provider?: string } | null;
    created_at?: string | null;
  } | null;
};

export async function POST(req: NextRequest) {
  const limited = await enforceRateLimit(req, {
    routeGroup: "webhook:new-signup",
    limit: 120,
    windowSeconds: 60,
  });
  if (limited) return limited;

  const secret = process.env.SIGNUP_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[new-signup] SIGNUP_WEBHOOK_SECRET not set; rejecting.");
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }
  if (req.headers.get("x-signup-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let payload: SignupHookPayload;
  try {
    payload = (await req.json()) as SignupHookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  // Only react to new user rows; ignore anything else Supabase might send.
  if (payload.type !== "INSERT" || !payload.record) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const record = payload.record;
  const email = record.email?.trim() || "unknown email";
  const meta = record.raw_user_meta_data ?? {};
  const name = (typeof meta.name === "string" && meta.name.trim()) || null;
  const provider = record.app_metadata?.provider || "email";

  await notifySignup(
    `🎉 New M9R signup: ${name ? `${name} · ` : ""}${email} · via ${provider}`,
  );

  return NextResponse.json({ ok: true });
}
