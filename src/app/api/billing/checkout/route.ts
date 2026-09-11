import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabase } from "@/lib/supabase";
import { requireStripe, priceIdForInterval, type BillingInterval } from "@/lib/stripe";
import { resolveBaseUrl } from "../../agent/_shared";

/**
 * POST /api/billing/checkout — start a Stripe Checkout session for M9R
 * Pro. Cookie-authenticated. Reuses an existing Stripe customer if this user
 * already has one on file (from a prior subscription attempt) instead of
 * creating a duplicate customer per checkout.
 */
export async function POST(req: NextRequest) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "Sign in to upgrade." }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { interval?: unknown };
  const interval: BillingInterval = body.interval === "annual" ? "annual" : "monthly";
  const priceId = priceIdForInterval(interval);

  try {
    const stripe = requireStripe();
    const baseUrl = resolveBaseUrl(req);

    // Reuse the customer already on file for this user, if any (service-role
    // read: the subscriptions table has no client-facing insert/update path,
    // only select for the owning user -- but a service key can still read it
    // directly, same trust tier as every other service-role lookup keyed by
    // an already-authenticated user id).
    let existingCustomerId: string | null = null;
    if (supabase) {
      const { data } = await supabase.from("subscriptions").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
      existingCustomerId = (data as { stripe_customer_id?: string } | null)?.stripe_customer_id ?? null;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      customer: existingCustomerId ?? undefined,
      customer_email: existingCustomerId ? undefined : user.email,
      client_reference_id: user.id,
      subscription_data: { metadata: { user_id: user.id } },
      success_url: `${baseUrl}/dashboard/settings?upgraded=1`,
      cancel_url: `${baseUrl}/dashboard/settings`,
      allow_promotion_codes: true,
    });

    if (!session.url) return NextResponse.json({ error: "Could not start checkout." }, { status: 502 });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("billing/checkout failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not start checkout." }, { status: 500 });
  }
}
