import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabase } from "@/lib/supabase";
import { getUserPlan } from "@/lib/plan-limits-service";
import { BILLING_ENABLED } from "@/lib/billing-config";

/** GET /api/billing/status — the signed-in user's real plan/subscription state for Settings. */
export async function GET() {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to view billing." }, { status: 401 });

  const plan = await getUserPlan(db, user.id);
  let subscription: { tier: string | null; status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null = null;
  if (supabase) {
    const { data } = await supabase
      .from("subscriptions")
      .select("tier, status, current_period_end, cancel_at_period_end")
      .eq("user_id", user.id)
      .maybeSingle();
    if (data) {
      subscription = {
        tier: (data as { tier: string | null }).tier,
        status: (data as { status: string }).status,
        currentPeriodEnd: (data as { current_period_end: string | null }).current_period_end,
        cancelAtPeriodEnd: (data as { cancel_at_period_end: boolean }).cancel_at_period_end,
      };
    }
  }

  return NextResponse.json({ billingEnabled: BILLING_ENABLED, plan, subscription });
}
