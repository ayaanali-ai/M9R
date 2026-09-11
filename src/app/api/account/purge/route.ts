import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// POST /api/account/purge — soft-delete all of the signed-in user's workspace
// data (traces + rules). Reversible at the DB level (sets deleted_at), so this
// is a safe "clear my data" rather than a hard wipe.
//
// We deliberately do NOT delete the auth account here — removing an auth user
// requires the admin API and is handled out of band.
// ---------------------------------------------------------------------------

export async function POST() {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });

  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to manage your data." }, { status: 401 });

  const now = new Date().toISOString();
  const [traces, rules] = await Promise.all([
    db.from("traces").update({ deleted_at: now }).eq("user_id", user.id).is("deleted_at", null).select("id"),
    db.from("rules").update({ deleted_at: now }).eq("created_by", user.id).is("deleted_at", null).select("id"),
  ]);

  if (traces.error || rules.error) {
    console.error("purge failed:", traces.error?.message, rules.error?.message);
    return NextResponse.json({ error: "Failed to clear data. Please try again." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    deleted: { traces: traces.data?.length ?? 0, rules: rules.data?.length ?? 0 },
  });
}
