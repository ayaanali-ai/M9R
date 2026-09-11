import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function PATCH() {
  const supabase = await createClient();
  if (!supabase) {
    return NextResponse.json({ error: "Authentication unavailable." }, { status: 503 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const completedAt = new Date().toISOString();
  const { error } = await supabase.from("user_settings").upsert(
    {
      user_id: user.id,
      walkthrough_completed: true,
      walkthrough_completed_at: completedAt,
      updated_at: completedAt,
    },
    { onConflict: "user_id" },
  );

  if (error) {
    return NextResponse.json({
      ok: true,
      persistence: "local",
      reason: "User settings persistence is unavailable.",
    });
  }

  return NextResponse.json({ ok: true, persistence: "settings" });
}
