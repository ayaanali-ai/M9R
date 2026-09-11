-- Durable human notifications and bounded Mission event search.
-- Both surfaces read the existing Mission event/delivery architecture; they
-- do not create a second conversation or execution log.

create table if not exists public.mission_notifications (
  id text primary key,
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  recipient_user_id text not null,
  recipient_participant_id text,
  source_message_id text,
  kind text not null check (kind in ('mention','question','blocker','review_request','approval_request','delivery_failed','runtime_waiting','mission_decision')),
  title text not null check (octet_length(title) <= 256),
  body text not null check (octet_length(body) <= 2048),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8192),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (workspace_id, recipient_user_id, mission_id, source_message_id, kind)
);

create index if not exists mission_notifications_inbox_idx
  on public.mission_notifications (workspace_id, recipient_user_id, read_at, created_at desc);

alter table public.mission_notifications enable row level security;
revoke all on public.mission_notifications from anon, authenticated;
grant select, insert, update on public.mission_notifications to service_role;

-- A bounded server-side search over the immutable Mission event stream. The
-- function is intentionally service-role-only; the application route supplies
-- the already authenticated workspace id and never exposes arbitrary SQL.
create or replace function public.search_mission_workspace(
  p_workspace_id text,
  p_query text,
  p_limit integer default 50
)
returns table (
  mission_id text,
  event_id text,
  event_type text,
  occurred_at timestamptz,
  actor jsonb,
  snippet text
)
language sql
security definer
set search_path = ''
stable
as $$
  with input as (
    select left(trim(coalesce(p_query, '')), 200) as query_text,
           plainto_tsquery('simple', left(trim(coalesce(p_query, '')), 200)) as query_vector
  )
  select
    e.mission_id,
    e.event_id,
    e.event_type,
    e.occurred_at,
    e.actor,
    left(coalesce(e.payload -> 'message' ->> 'body', e.payload ->> 'body', e.payload ->> 'summary', e.payload::text), 500) as snippet
  from public.mission_events e
  join public.missions m on m.id = e.mission_id
  cross join input
  where m.workspace_id = p_workspace_id
    and input.query_text <> ''
    and (
      to_tsvector('simple', e.payload::text) @@ input.query_vector
      or e.payload::text ilike '%' || replace(replace(replace(input.query_text, chr(92), chr(92) || chr(92)), '%', chr(92) || '%'), '_', chr(92) || '_') || '%' escape chr(92)
    )
  order by e.occurred_at desc, e.aggregate_version desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

revoke all on function public.search_mission_workspace(text, text, integer) from public, anon, authenticated;
grant execute on function public.search_mission_workspace(text, text, integer) to service_role;
