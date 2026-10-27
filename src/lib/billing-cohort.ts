/**
 * The founding-500 cutover: counts how many subscribers are already locked
 * into the $17/mo founding price, live, at the moment someone checks out --
 * never a cached or client-supplied number. Once 500 are locked in, every
 * new checkout gets the $27/mo standard price instead, which that new
 * subscriber then keeps for life, same as the founding cohort kept theirs.
 */

import { supabase } from "@/lib/supabase";
import { FOUNDING_COHORT_SIZE, STRIPE_PRICE_FOUNDING, type BillingCohort } from "@/lib/stripe";

/** Active/trialing subscribers already on the founding price -- the only
 *  count that matters, since cancelled or past_due rows must not hold open
 *  a founding seat nobody is actually paying for. */
export async function foundingSubscriberCount(): Promise<number> {
  if (!supabase) return FOUNDING_COHORT_SIZE; // Unconfigured: fail closed to "sold out", never oversell.
  const { count, error } = await supabase
    .from("subscriptions")
    .select("user_id", { count: "exact", head: true })
    .eq("price_id", STRIPE_PRICE_FOUNDING)
    .in("status", ["active", "trialing"]);
  if (error) return FOUNDING_COHORT_SIZE;
  return count ?? FOUNDING_COHORT_SIZE;
}

export async function foundingSeatsRemaining(): Promise<number> {
  return Math.max(0, FOUNDING_COHORT_SIZE - await foundingSubscriberCount());
}

/** The cohort a *new* checkout right now would land in. A subscriber who
 *  already locked in the founding price keeps it regardless of this value --
 *  this only decides which price a brand-new subscription starts on. */
export async function currentCheckoutCohort(): Promise<BillingCohort> {
  return (await foundingSeatsRemaining()) > 0 ? "founding" : "standard";
}
