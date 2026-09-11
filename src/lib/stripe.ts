/**
 * Stripe client + the two real OathLock Pro prices.
 * ----------------------------------------------------------------------------
 * Price IDs are not secret (they're safe to ship to the client and appear in
 * the Stripe dashboard URL bar), so they're plain constants rather than env
 * vars -- one less thing to misconfigure per environment. STRIPE_SECRET_KEY
 * and STRIPE_WEBHOOK_SECRET are the only real secrets, read from the
 * environment and never logged.
 */

import Stripe from "stripe";

export const STRIPE_PRICE_MONTHLY = "price_1U1HVPAmlDtcg1JoKv8MYDCv"; // OathLock Pro, $14/mo
export const STRIPE_PRICE_ANNUAL = "price_1U1HVPAmlDtcg1JoVcnQBqL6"; // OathLock Pro, $132/yr ($11/mo)

export type BillingInterval = "monthly" | "annual";

export function priceIdForInterval(interval: BillingInterval): string {
  return interval === "annual" ? STRIPE_PRICE_ANNUAL : STRIPE_PRICE_MONTHLY;
}

export function intervalForPriceId(priceId: string): BillingInterval | null {
  if (priceId === STRIPE_PRICE_ANNUAL) return "annual";
  if (priceId === STRIPE_PRICE_MONTHLY) return "monthly";
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
