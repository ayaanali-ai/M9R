-- Real billing: one row per user's current Stripe subscription state.
-- plan-limits-service.ts already reads this exact shape (readCurrentSubscription
-- selects plan, tier, plan_id, price_id, status, created_at by user_id) and
-- gracefully treated its absence as "free" -- this migration is the table it
-- was always designed to read once billing shipped, not a new contract.
--
-- Written only by the Stripe webhook (service role); read by the signed-in
-- user's own cookie session. One user has at most one row -- a new checkout
-- for an existing subscriber updates the row rather than creating a second.

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_subscription_id text not null,
  price_id text not null,
  plan text not null default 'paid',
  tier text,
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id),
  unique (stripe_subscription_id)
);

create index if not exists subscriptions_stripe_customer_idx
  on public.subscriptions (stripe_customer_id);

alter table public.subscriptions enable row level security;

grant select on public.subscriptions to authenticated;

drop policy if exists "users read their own subscription" on public.subscriptions;
create policy "users read their own subscription" on public.subscriptions for select to authenticated
using (user_id = (select auth.uid()));

-- No insert/update/delete policy for authenticated: only the service-role
-- webhook handler ever writes this table, matching the existing convention
-- (subscriptions plan/status is never client-writable).
