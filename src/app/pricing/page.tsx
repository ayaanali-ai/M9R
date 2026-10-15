import type { Metadata } from "next";
import ReferencePricing from "@/components/reference/ReferencePricing";

export const metadata: Metadata = {
  title: "Pricing — M9R",
  description: "Free at $0. Relationship Memory at $7/month or $70/year. Team at $9 per seat per month or $90 per seat per year, with a 7-day free trial.",
};

export default function Pricing() {
  return <ReferencePricing />;
}
