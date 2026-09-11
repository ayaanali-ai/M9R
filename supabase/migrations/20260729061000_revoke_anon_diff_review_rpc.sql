-- Supabase grants newly exposed public functions to API roles automatically.
-- Keep the owner-only decision RPC unavailable to unauthenticated callers.

revoke execute on function public.decide_launch_diff_review(uuid, text, timestamptz) from anon;
