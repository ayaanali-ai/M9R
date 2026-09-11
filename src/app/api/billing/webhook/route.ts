import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { supabase } from "@/lib/supabase";
import { requireStripe, intervalForPriceId } from "@/lib/stripe";

export const dynamic = "force-dynamic";

/**
 * POST /api/billing/webhook — Stripe's own callback, never a user request.
 * Signature-verified against STRIPE_WEBHOOK_SECRET (never trusts the body
 * without it). This is the ONLY writer of public.subscriptions -- checkout
 * and portal sessions never touch the row directly, so plan state always
 * reflects what Stripe actually confirmed, not what the client claimed.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook is not configured." }, { status: 503 });
  if (!supabase) return NextResponse.json({ error: "Billing is not configured." }, { status: 503 });

  const signature = req.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing signature." }, { status: 400 });

  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    const stripe = requireStripe();
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    console.error("billing/webhook signature verification failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id ?? (session.metadata?.user_id as string | undefined);
        const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (!userId || !customerId || !subscriptionId) break;

        const stripe = requireStripe();
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await upsertSubscription(userId, customerId, subscription);
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = (subscription.metadata?.user_id as string | undefined) ?? await userIdForSubscription(subscription.id);
        const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
        if (!userId) break;
        await upsertSubscription(userId, customerId, subscription);
        break;
      }
      default:
        break;
    }
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("billing/webhook handling failed:", error instanceof Error ? error.message : error);
    // Non-2xx tells Stripe to retry -- safe here since upsertSubscription is
    // idempotent (unique on stripe_subscription_id).
    return NextResponse.json({ error: "Webhook handling failed." }, { status: 500 });
  }
}

async function userIdForSubscription(subscriptionId: string): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.from("subscriptions").select("user_id").eq("stripe_subscription_id", subscriptionId).maybeSingle();
  return (data as { user_id?: string } | null)?.user_id ?? null;
}

async function upsertSubscription(userId: string, customerId: string, subscription: Stripe.Subscription): Promise<void> {
  if (!supabase) return;
  const priceId = subscription.items.data[0]?.price?.id ?? "";
  const tier = intervalForPriceId(priceId);
  const currentPeriodEnd = subscription.items.data[0]?.current_period_end;

  const { error } = await supabase.from("subscriptions").upsert(
    {
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      price_id: priceId,
      plan: subscription.status === "active" || subscription.status === "trialing" ? "paid" : "free",
      tier,
      status: subscription.status,
      current_period_end: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) console.error("upsertSubscription failed:", error.message, error.code);
}
