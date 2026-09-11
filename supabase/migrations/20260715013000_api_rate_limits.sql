-- Atomic, service-role-only API rate limiting for serverless route handlers.
create table if not exists public.api_rate_limit_buckets (
  key_hash text not null,
  route_group text not null,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 1 check (request_count > 0),
  primary key (key_hash, route_group)
);

alter table public.api_rate_limit_buckets enable row level security;
revoke all on public.api_rate_limit_buckets from anon, authenticated;

create or replace function public.consume_api_rate_limit(
  p_key_hash text,
  p_route_group text,
  p_window_seconds integer,
  p_request_limit integer
)
returns table(allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count integer;
  current_window timestamptz;
  window_size interval;
begin
  if length(p_key_hash) < 16 or length(p_route_group) < 1 then
    raise exception 'invalid rate-limit key';
  end if;
  if p_window_seconds < 1 or p_window_seconds > 86400 or p_request_limit < 1 or p_request_limit > 10000 then
    raise exception 'invalid rate-limit policy';
  end if;

  window_size := make_interval(secs => p_window_seconds);

  insert into public.api_rate_limit_buckets as bucket (
    key_hash, route_group, window_started_at, request_count
  ) values (
    p_key_hash, p_route_group, now(), 1
  )
  on conflict (key_hash, route_group) do update
  set
    window_started_at = case
      when bucket.window_started_at + window_size <= now() then now()
      else bucket.window_started_at
    end,
    request_count = case
      when bucket.window_started_at + window_size <= now() then 1
      else bucket.request_count + 1
    end
  returning request_count, window_started_at
  into current_count, current_window;

  return query select
    current_count <= p_request_limit,
    greatest(p_request_limit - current_count, 0),
    current_window + window_size;
end;
$$;

revoke all on function public.consume_api_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, text, integer, integer) to service_role;

create index if not exists api_rate_limit_buckets_window_idx
  on public.api_rate_limit_buckets (window_started_at);

comment on table public.api_rate_limit_buckets is
  'Stores pseudonymous, fixed-window API abuse counters; raw client IP addresses are never persisted.';
