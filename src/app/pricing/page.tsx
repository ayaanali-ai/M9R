import type { Metadata } from "next";
import ReferencePricing from "@/components/reference/ReferencePricing";
import { FOUNDING_COHORT_SIZE, FOUNDING_MONTHLY_PRICE_USD, STANDARD_MONTHLY_PRICE_USD } from "@/lib/stripe";

export const metadata: Metadata = {
  title: "Pricing — M9R",
  description: `$${FOUNDING_MONTHLY_PRICE_USD}/month per computer, locked for life for the first ${FOUNDING_COHORT_SIZE}. $${STANDARD_MONTHLY_PRICE_USD}/month after, also locked for that cohort. No seats, no tiers.`,
};

export default function Pricing() {
  return <ReferencePricing />;
}
