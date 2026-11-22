/**
 * Stripe client + the real M9R price (one flat per-computer subscription,
 * no seats, no tiers). Price IDs are not secret (they're safe to ship to
 * the client and appear in the Stripe dashboard URL bar), so they're plain
 * constants rather than env vars -- one less thing to misconfigure per
 * environment. STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are the only
 * real secrets, read from the environment and never logged.
 *
 * Two cohorts of the same product/price point, not two products: the first
 * FOUNDING_COHORT_LIMIT subscribers ever to check out get locked into the
 * founding price for as long as they stay subscribed; everyone after that
 * only ever sees the standard price. See foundingCohortRemaining() below --
 * Stripe has no native "first N customers" primitive, so this is enforced
 * by counting this app's own subscriptions table, not by anything in Stripe
 * itself.
 */

import Stripe from "stripe";

export const STRIPE_PRICE_FOUNDING = "price_1URgeZRSegzd51KS4OxidJG7"; // M9R per-computer, founding 500, $17/mo, locked for life
export const STRIPE_PRICE_STANDARD = "price_1URgeeRSegzd51KS2NsoEZIf"; // M9R per-computer, standard, $27/mo

export type BillingCohort = "founding" | "standard";

const PRICE_IDS: Record<BillingCohort, string> = {
  founding: STRIPE_PRICE_FOUNDING,
  standard: STRIPE_PRICE_STANDARD,
};

/** The first this many subscribers ever to check out keep the founding price
 *  for as long as they stay subscribed. Once reached, nobody new sees it
 *  again -- a cancelled founding seat is not reissued to someone else. */
export const FOUNDING_COHORT_LIMIT = 500;

export function priceIdFor(cohort: BillingCohort): string {
  return PRICE_IDS[cohort];
}

export function cohortForPriceId(priceId: string): BillingCohort | null {
  for (const cohort of Object.keys(PRICE_IDS) as BillingCohort[]) {
    if (PRICE_IDS[cohort] === priceId) return cohort;
  }
  return null;
}

let cachedClient: Stripe | null = null;

/** Lazily constructed so a deployment with no key configured fails at the
 *  point of use (a clear 503) rather than at module load / build time. */
export function requireStripe(): Stripe {
  if (cachedClient) return cachedClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured for this deployment.");
  cachedClient = new Stripe(key, { apiVersion: "2026-07-29.dahlia" });
  return cachedClient;
}
