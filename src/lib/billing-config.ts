/**
 * Billing is deliberately opt-in while Stripe is being repaired.
 *
 * The flag is public configuration, not a secret. Keeping the default false
 * means a missing deployment variable cannot accidentally turn the paywall on.
 * Set NEXT_PUBLIC_M9R_BILLING_ENABLED=true only after Stripe checkout,
 * webhook, and entitlement behavior have been re-verified.
 */
export const BILLING_ENABLED = process.env.NEXT_PUBLIC_M9R_BILLING_ENABLED === "true";

