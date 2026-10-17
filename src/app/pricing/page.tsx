import type { Metadata } from "next";
import ReferencePricing from "@/components/reference/ReferencePricing";

export const metadata: Metadata = {
  title: "Pricing — M9R",
  description: "$17/month per computer, locked for life for the first 500. $27/month after, also locked for that cohort. No seats, no tiers.",
};

export default function Pricing() {
  return <ReferencePricing />;
}
