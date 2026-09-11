-- Public Agent Resume: an opt-in, shareable, no-login page showing one
-- connection's real track record (reviewed tasks, approval rate). Nothing is
-- public until the owner explicitly enables it -- public_share_slug stays
-- null otherwise, and the public API/route only ever look up by that slug.

alter table public.agent_connections
  add column if not exists public_share_slug text unique,
  add column if not exists public_share_enabled_at timestamptz;

alter table public.agent_connections
  add constraint agent_connections_public_share_slug_format
  check (public_share_slug is null or public_share_slug ~ '^[a-z0-9]{10,24}$');
