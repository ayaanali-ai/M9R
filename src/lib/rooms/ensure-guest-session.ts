"use client";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A room URL must work for a guest with no account at all. Rather than show them a
 * signup form, mint a silent anonymous Supabase session the first time they land on
 * a room link -- invisible to them, but it satisfies the same auth.uid()-based RLS
 * and RPCs a signed-in member goes through. Requires "Allow anonymous sign-ins" to be
 * enabled on the Supabase project (Authentication -> Sign In / Providers); that toggle
 * cannot be flipped from this migration/RPC surface, only from the project dashboard.
 */
export async function ensureGuestSession(db: SupabaseClient): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: { session } } = await db.auth.getSession();
  if (session) return { ok: true };
  const { error } = await db.auth.signInAnonymously();
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
