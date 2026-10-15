/**
 * Stripe client + the real M9R prices (Relationship Memory and Team).
 * ----------------------------------------------------------------------------
 * Price IDs are not secret (they're safe to ship to the client and appear in
 * the Stripe dashboard URL bar), so they're plain constants rather than env
 * vars -- one less thing to misconfigure per environment. STRIPE_SECRET_KEY
 * and STRIPE_WEBHOOK_SECRET are the only real secrets, read from the
 * environment and never logged.
 */

import Stripe from "stripe";

export const STRIPE_PRICE_MONTHLY = "price_1UOspWRSegzd51KSidxXe3VZ"; // M9R Relationship Memory, $7/mo
export const STRIPE_PRICE_ANNUAL = "price_1UOspXRSegzd51KSsSCyf4JO"; // M9R Relationship Memory, $70/yr

export const STRIPE_PRICE_TEAM_MONTHLY = "price_1UOsprRSegzd51KSCS63oCiu"; // M9R Team, $9/seat/mo, 7-day trial
export const STRIPE_PRICE_TEAM_ANNUAL = "price_1UOspsRSegzd51KSlez8jG76"; // M9R Team, $90/seat/yr, 7-day trial

export type BillingInterval = "monthly" | "annual";
export type BillingProduct = "memory" | "team";

const PRICE_IDS: Record<BillingProduct, Record<BillingInterval, string>> = {
  memory: { monthly: STRIPE_PRICE_MONTHLY, annual: STRIPE_PRICE_ANNUAL },
  team: { monthly: STRIPE_PRICE_TEAM_MONTHLY, annual: STRIPE_PRICE_TEAM_ANNUAL },
};

/** Team's trial is also set on the Stripe price; checkout passes it explicitly
 *  so the trial holds even where Checkout ignores price-level trial days. */
export const TEAM_TRIAL_DAYS = 7;

export function priceIdFor(product: BillingProduct, interval: BillingInterval): string {
  return PRICE_IDS[product][interval];
}

/** Kept for existing callers: resolves the Relationship Memory price. */
export function priceIdForInterval(interval: BillingInterval): string {
  return priceIdFor("memory", interval);
}

export function planForPriceId(priceId: string): { product: BillingProduct; interval: BillingInterval } | null {
  for (const product of Object.keys(PRICE_IDS) as BillingProduct[]) {
    for (const interval of Object.keys(PRICE_IDS[product]) as BillingInterval[]) {
      if (PRICE_IDS[product][interval] === priceId) return { product, interval };
    }
  }
  return null;
}

export function intervalForPriceId(priceId: string): BillingInterval | null {
  return planForPriceId(priceId)?.interval ?? null;
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
