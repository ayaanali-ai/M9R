-- Stage 1 (Live Session Endpoint): a durable address for each provider an owner has connected in a
-- workspace. Reconnecting gets a new agent_connections row every time, so the endpoint is what stays
-- stable: it rebinds to the newest connection and bumps session_generation (spec D2).
-- Additive only. agent_connections stays authoritative for tokens, liveness and status.

create table if not exists public.endpoints (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  owner_user_id uuid,
  kind text not null default 'agent_session' check (kind in ('human', 'agent_session', 'agent_service')),
  provider text not null check (char_length(provider) between 1 and 40),
  alias text not null check (alias ~ '^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$'),
  current_connection_id uuid references public.agent_connections(id) on delete set null,
  session_generation integer not null default 1 check (session_generation >= 1),
  status text not null default 'active' check (status in ('active', 'suspended', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One endpoint per (workspace, owner, provider) in Stage 1; owner may be null on legacy connections.
create unique index if not exists endpoints_owner_provider_uniq
  on public.endpoints (workspace_id, coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid), provider);
create unique index if not exists endpoints_owner_alias_uniq
  on public.endpoints (workspace_id, coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid), alias);
create unique index if not exists endpoints_current_connection_uniq
  on public.endpoints (current_connection_id) where current_connection_id is not null;
create index if not exists endpoints_workspace_idx on public.endpoints (workspace_id, status);

alter table public.endpoints enable row level security;
-- No policies: read and written only through the service role behind the agent and dashboard APIs.

-- Bind on connect: a new connection rebinds its endpoint (creating it the first time).
create or replace function public.bind_endpoint_for_connection() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  owner_key uuid := coalesce(new.created_by, '00000000-0000-0000-0000-000000000000'::uuid);
  provider_slug text := left(regexp_replace(lower(new.agent_kind), '[^a-z0-9-]', '-', 'g'), 40);
begin
  if new.status <> 'active' then
    return new;
  end if;
  insert into public.endpoints (workspace_id, owner_user_id, provider, alias, current_connection_id)
  values (new.workspace_id, new.created_by, provider_slug, provider_slug, new.id)
  on conflict (workspace_id, coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid), provider)
  do update set current_connection_id = excluded.current_connection_id,
                session_generation = public.endpoints.session_generation + 1,
                status = 'active',
                updated_at = now();
  return new;
exception when others then
  -- Never let endpoint bookkeeping block a claim approval.
  raise warning 'bind_endpoint_for_connection failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists agent_connections_bind_endpoint on public.agent_connections;
create trigger agent_connections_bind_endpoint
  after insert on public.agent_connections
  for each row execute function public.bind_endpoint_for_connection();

-- Unbind on revoke: the endpoint stays (durable address) but has no live session until a new connection binds.
create or replace function public.unbind_endpoint_for_connection() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'active' and new.status <> 'active' then
    update public.endpoints set current_connection_id = null, updated_at = now()
    where current_connection_id = new.id;
  end if;
  return new;
exception when others then
  raise warning 'unbind_endpoint_for_connection failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists agent_connections_unbind_endpoint on public.agent_connections;
create trigger agent_connections_unbind_endpoint
  after update of status on public.agent_connections
  for each row execute function public.unbind_endpoint_for_connection();

-- Backfill: one endpoint per (workspace, owner, provider) from existing connections. The bound connection is the
-- newest active one; the generation counts how many connections that endpoint has had.
insert into public.endpoints (workspace_id, owner_user_id, provider, alias, current_connection_id, session_generation, status, created_at)
select g.workspace_id, g.created_by, g.provider_slug, g.provider_slug,
       (select c.id from public.agent_connections c
         where c.workspace_id = g.workspace_id
           and coalesce(c.created_by, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(g.created_by, '00000000-0000-0000-0000-000000000000'::uuid)
           and left(regexp_replace(lower(c.agent_kind), '[^a-z0-9-]', '-', 'g'), 40) = g.provider_slug
           and c.status = 'active'
         order by c.last_seen_at desc nulls last, c.created_at desc limit 1),
       g.connections, 'active', g.first_created
from (
  select workspace_id, created_by,
         left(regexp_replace(lower(agent_kind), '[^a-z0-9-]', '-', 'g'), 40) as provider_slug,
         count(*)::int as connections, min(created_at) as first_created
  from public.agent_connections
  group by 1, 2, 3
) g
where g.provider_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$'
on conflict do nothing;
