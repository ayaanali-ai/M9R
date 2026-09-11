-- Auth identity is the Supabase user UUID, not an email address.
--
-- Supabase can legitimately recreate an auth account with the same email after
-- the prior account was deleted. Keeping a UNIQUE public.users(email) index
-- makes lazy profile provisioning fail with 23505, even though the two UUIDs
-- are distinct. Preserve the old row and its audit history; allow the new UUID
-- to receive its own public.users row instead of reassigning stale ownership.
drop index if exists public.idx_users_email;

-- Retain efficient case-insensitive support lookups without conflating email
-- with authorization or record ownership.
create index if not exists idx_users_email
  on public.users (lower(email));
