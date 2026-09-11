import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabase } from "@/lib/supabase";
import { requireStripe } from "@/lib/stripe";
import { resolveBaseUrl } from "../../agent/_shared";

/**
 * POST /api/billing/portal — open the Stripe-hosted customer portal, where a
 * subscriber can update their payment method, switch monthly/annual,
 * download invoices, or cancel -- all self-service, no custom UI needed for
 * any of it. Cookie-authenticated; 404s honestly if this user has never
 * subscribed (there is no customer to open a portal for).
 */
export async function POST(req: NextRequest) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to manage billing." }, { status: 401 });
  if (!supabase) return NextResponse.json({ error: "Billing is not configured." }, { status: 503 });

  const { data } = await supabase.from("subscriptions").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
  const customerId = (data as { stripe_customer_id?: string } | null)?.stripe_customer_id;
  if (!customerId) return NextResponse.json({ error: "No subscription on file yet." }, { status: 404 });

  try {
    const stripe = requireStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${resolveBaseUrl(req)}/dashboard/settings`,
    });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("billing/portal failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not open billing portal." }, { status: 500 });
  }
}
