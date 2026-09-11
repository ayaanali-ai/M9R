-- Keep resident launch identity aligned with agent_connections.agent_kind.
-- The original Gate 11A tables used a fixed provider CHECK, which meant a
-- valid newly-connected provider could appear in the dashboard but could not
-- register a resident or receive a bounded launch grant.

alter table public.resident_instances
  drop constraint if exists resident_instances_provider_check;
alter table public.resident_instances
  add constraint resident_instances_provider_slug_check
  check (provider ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$');

alter table public.resident_provider_authorizations
  drop constraint if exists resident_provider_authorizations_provider_check;
alter table public.resident_provider_authorizations
  add constraint resident_provider_authorizations_provider_slug_check
  check (provider ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$');

alter table public.launch_grants
  drop constraint if exists launch_grants_provider_check;
alter table public.launch_grants
  add constraint launch_grants_provider_slug_check
  check (provider ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$');
