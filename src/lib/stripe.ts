/**
 * Stripe client + the real M9R price. One product, one price per cohort --
 * no seats, no tiers, no annual toggle. $17/month is locked for life for the
 * first 500 subscribers; everyone after pays $27/month, also locked for that
 * cohort. Both prices already exist as live Stripe objects.
 * ----------------------------------------------------------------------------
 * Price IDs are not secret (they're safe to ship to the client and appear in
 * the Stripe dashboard URL bar), so they're plain constants rather than env
 * vars -- one less thing to misconfigure per environment. STRIPE_SECRET_KEY
 * and STRIPE_WEBHOOK_SECRET are the only real secrets, read from the
 * environment and never logged.
 */

import Stripe from "stripe";

export const STRIPE_PRICE_FOUNDING = "price_1URgeZRSegzd51KS4OxidJG7"; // M9R, $17/mo, locked for life, first 500
export const STRIPE_PRICE_STANDARD = "price_1URgeeRSegzd51KS2NsoEZIf"; // M9R, $27/mo, locked for that cohort

export const FOUNDING_COHORT_SIZE = 500;
export const FOUNDING_MONTHLY_PRICE_USD = 17;
export const STANDARD_MONTHLY_PRICE_USD = 27;

export type BillingCohort = "founding" | "standard";

const PRICE_IDS: Record<BillingCohort, string> = {
  founding: STRIPE_PRICE_FOUNDING,
  standard: STRIPE_PRICE_STANDARD,
};

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
