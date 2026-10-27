-- Supabase is changing the default Data API exposure for new objects in the
-- public schema on 2026-10-30.  Make that fail-closed behavior explicit now
-- so a later platform default change cannot create an accidental API surface,
-- and so fresh environments behave like the current production environment.
--
-- Existing tables/functions/sequences are not changed by ALTER DEFAULT
-- PRIVILEGES.  Each migration must declare its own intended grants below the
-- object definition.

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke all on functions from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;

-- workspace_member_colors predates this guard and was relying on the old
-- project-wide defaults.  Preserve its intended contract explicitly: members
-- may read through the RLS policy, allocation happens through the RPC, and
-- service-role maintenance retains full access.  Anonymous clients and direct
-- client writes are not part of the contract.
revoke all on table public.workspace_member_colors from public, anon;
revoke all on table public.workspace_member_colors from authenticated;
grant select on table public.workspace_member_colors to authenticated;
grant all on table public.workspace_member_colors to service_role;
