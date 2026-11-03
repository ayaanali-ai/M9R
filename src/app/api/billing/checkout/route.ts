import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabase } from "@/lib/supabase";
import { requireStripe, priceIdFor, cohortForPriceId, FOUNDING_COHORT_LIMIT, type BillingCohort } from "@/lib/stripe";
import { BILLING_ENABLED } from "@/lib/billing-config";
import { resolveBaseUrl } from "../../agent/_shared";

/**
 * How many subscribers have ever locked in the founding price. Counted from
 * this app's own subscriptions table, not from Stripe -- Stripe has no
 * "first N customers" primitive. Deliberately counts every row that was
 * EVER founding-priced, including a since-cancelled one: a cancelled
 * founding seat is not reissued to the next person in line, matching
 * "the first 500 people", not "the 500 currently active founding payers".
 *
 * Not perfectly race-proof under truly simultaneous checkouts at the exact
 * 500th seat -- there is no atomic reservation here, just a count-then-
 * decide read. Two people finishing checkout in the same instant around the
 * boundary could both land on the founding price. Acceptable for a launch
 * at this scale; revisit with a real reservation (e.g. a unique sequence
 * column claimed inside the same transaction as the row insert) before this
 * matters at higher signup volume.
 */
async function foundingCohortRemaining(): Promise<number> {
  if (!supabase) return 0;
  const { count } = await supabase
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("price_id", priceIdFor("founding"));
  return Math.max(0, FOUNDING_COHORT_LIMIT - (count ?? 0));
}

/**
 * POST /api/billing/checkout — start a Stripe Checkout session for the one
 * M9R per-computer subscription. Cookie-authenticated. Reuses an existing
 * Stripe customer if this user already has one on file (from a prior
 * subscription attempt) instead of creating a duplicate customer per
 * checkout. The cohort (founding vs. standard price) is decided here, from
 * the current founding-seat count -- never trusted from the request body.
 */
export async function POST(req: NextRequest) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "Sign in to upgrade." }, { status: 401 });
  if (!BILLING_ENABLED) {
    return NextResponse.json({ error: "Billing is temporarily paused while Stripe is being repaired." }, { status: 503 });
  }

  try {
    // A returning subscriber (already has a row, even a cancelled one) never
    // gets bumped from founding to standard just because the cohort filled
    // up after they first joined -- re-read their own existing price_id
    // first, and only fall through to the live cohort count for a genuinely
    // new subscriber.
    let existingCustomerId: string | null = null;
    let existingCohort: BillingCohort | null = null;
    if (supabase) {
      const { data } = await supabase.from("subscriptions").select("stripe_customer_id, price_id").eq("user_id", user.id).maybeSingle();
      const row = data as { stripe_customer_id?: string; price_id?: string } | null;
      existingCustomerId = row?.stripe_customer_id ?? null;
      existingCohort = row?.price_id ? cohortForPriceId(row.price_id) : null;
    }
    const cohort: BillingCohort = existingCohort ?? (await foundingCohortRemaining() > 0 ? "founding" : "standard");
    const priceId = priceIdFor(cohort);

    const stripe = requireStripe();
    const baseUrl = resolveBaseUrl(req);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      customer: existingCustomerId ?? undefined,
      customer_email: existingCustomerId ? undefined : user.email,
      client_reference_id: user.id,
      subscription_data: {
        metadata: { user_id: user.id, cohort },
      },
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
