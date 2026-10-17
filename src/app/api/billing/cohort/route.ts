import { NextResponse } from "next/server";
import { foundingSeatsRemaining } from "@/lib/billing-cohort";
import { FOUNDING_COHORT_SIZE } from "@/lib/stripe";

/**
 * GET /api/billing/cohort — the live, honest founding-500 count for the
 * pricing page. No auth required: this is the same transparency a visitor
 * sees before signing in, Everlane-style, not account-specific data.
 */
export async function GET() {
  const remaining = await foundingSeatsRemaining();
  return NextResponse.json({ remaining, total: FOUNDING_COHORT_SIZE });
}
