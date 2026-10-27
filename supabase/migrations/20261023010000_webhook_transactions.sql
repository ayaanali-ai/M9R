-- A receipt and its effect commit together. No browser role may write billing or webhook receipts.
begin;
create table if not exists public.webhook_receipts (
  provider text not null check (provider in ('stripe', 'github')),
  delivery_id text not null,
  created_at timestamptz not null default now(),
  primary key (provider, delivery_id)
);
alter table public.webhook_receipts enable row level security;
revoke all on public.webhook_receipts from public, anon, authenticated;
grant select, insert on public.webhook_receipts to service_role;

alter table public.subscriptions add column if not exists stripe_event_created bigint;
grant select, insert, update on public.subscriptions to service_role;
grant select, update on public.github_repo_bindings to service_role;

create or replace function public.apply_stripe_subscription_event(
  p_event_id text, p_event_created bigint, p_subscription jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  target_user uuid := (p_subscription->>'user_id')::uuid;
  inserted_count integer;
begin
  if target_user is null or p_event_id is null or length(p_event_id) not between 1 and 255
    or p_event_created is null or p_event_created < 0 then raise exception 'Invalid billing event'; end if;
  -- Serialize all events for one user, including the first subscription row.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_user::text, 0));
  insert into public.webhook_receipts(provider, delivery_id) values ('stripe', p_event_id)
    on conflict do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then return false; end if;
  insert into public.subscriptions as existing(user_id, stripe_customer_id, stripe_subscription_id, price_id,
    plan, tier, status, current_period_end, cancel_at_period_end, updated_at, stripe_event_created)
  values (target_user, p_subscription->>'stripe_customer_id', p_subscription->>'stripe_subscription_id',
    p_subscription->>'price_id', p_subscription->>'plan', p_subscription->>'tier', p_subscription->>'status',
    (p_subscription->>'current_period_end')::timestamptz, (p_subscription->>'cancel_at_period_end')::boolean,
    now(), p_event_created)
  on conflict(user_id) do update set
    stripe_customer_id = excluded.stripe_customer_id,
    stripe_subscription_id = excluded.stripe_subscription_id,
    price_id = excluded.price_id, plan = excluded.plan, tier = excluded.tier, status = excluded.status,
    current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
    updated_at = excluded.updated_at, stripe_event_created = excluded.stripe_event_created
  where existing.stripe_event_created is null
    or existing.stripe_event_created <= excluded.stripe_event_created;
  get diagnostics inserted_count = row_count;
  return inserted_count > 0;
end;
$$;
revoke execute on function public.apply_stripe_subscription_event(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.apply_stripe_subscription_event(text, bigint, jsonb) to service_role;

create or replace function public.post_github_delivery(p_delivery_id text, p_repo_full_name text, p_body text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  binding public.github_repo_bindings%rowtype;
  inserted_count integer;
begin
  if p_delivery_id is null or length(p_delivery_id) not between 1 and 100 then
    raise exception 'Invalid GitHub delivery identity';
  end if;
  -- Multiple workspaces can bind the same repository. Never guess which owner receives it.
  begin
    select * into strict binding from public.github_repo_bindings where repo_full_name = p_repo_full_name for share;
  exception when no_data_found then return false;
  end;
  insert into public.webhook_receipts(provider, delivery_id) values ('github', p_delivery_id)
    on conflict do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then return false; end if;
  insert into public.conversation_messages(workspace_id, conversation_id, sender_connection_id,
    sender_user_id, sender_kind, sender_display_name, recipient_connection_id, kind, body)
  values(binding.workspace_id, binding.conversation_id, null, null, 'system', 'GitHub', null, 'message', p_body);
  return true;
end;
$$;
revoke execute on function public.post_github_delivery(text, text, text) from public, anon, authenticated;
grant execute on function public.post_github_delivery(text, text, text) to service_role;
commit;
