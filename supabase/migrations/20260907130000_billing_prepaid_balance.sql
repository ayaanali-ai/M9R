-- Item #33: prepaid balance billing -- the safe form of item #32's
-- "mechanism 2" (M9R holds its own funded relationship with model providers
-- so a workspace never needs its own API key). Real, validated demand: the
-- second-most-liked reply on the X thread that started this work
-- (Vignesh V, 150 likes) said plainly "the real ask is one bill and one
-- workspace for the whole team" -- this is that bill.
--
-- Core safety invariant: M9R never extends credit. Every cent spent against
-- a provider must already be reserved out of a balance the workspace funded
-- up front. balance_cents and reserved_cents are bigint (integer cents,
-- never floating point) everywhere in this schema -- a system charging
-- thousands of sub-cent-scale per-token amounts will accumulate real,
-- visible drift under floats. See M9R_MASTER_BUILD_PLAN.md item #33.

create table public.billing_balances (
  -- Bare uuid, no FK -- matching the existing workspace_id convention used
  -- across this schema (task_contracts, agent_connections, m9r_native_*).
  workspace_id uuid primary key,
  balance_cents bigint not null default 0,
  reserved_cents bigint not null default 0,
  updated_at timestamptz not null default now(),
  constraint billing_balances_non_negative check (balance_cents >= 0 and reserved_cents >= 0),
  constraint billing_balances_reserved_within_balance check (reserved_cents <= balance_cents)
);

comment on table public.billing_balances is
  'Item #33: one row per workspace. Available balance = balance_cents - reserved_cents, never balance_cents alone. Mutated only through m9r_billing_reserve/_reconcile/_release/_fund below -- never a direct UPDATE from application code.';

create table public.billing_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  estimated_cost_cents bigint not null check (estimated_cost_cents >= 0),
  actual_cost_cents bigint,
  status text not null default 'held' check (status in ('held', 'reconciled', 'released')),
  -- Model/provider/session context -- doubles as item #32 point 3's
  -- per-workspace performance-comparison data source, not a separate
  -- collection effort.
  provider_id text,
  model text,
  session_id text,
  created_at timestamptz not null default now(),
  reconciled_at timestamptz
);

create index billing_reservations_workspace_idx on public.billing_reservations (workspace_id, created_at desc);

comment on table public.billing_reservations is
  'Item #33: one row per reserve-then-reconcile cycle. estimated_cost_cents is held out of billing_balances.reserved_cents at creation; actual_cost_cents is filled in and the hold released at reconciliation.';

create table public.billing_transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  type text not null check (type in ('fund', 'reserve', 'reconcile', 'refund', 'adjustment')),
  amount_cents bigint not null,
  balance_after_cents bigint not null,
  related_reservation_id uuid references public.billing_reservations(id) on delete set null,
  created_at timestamptz not null default now()
);

create index billing_transactions_workspace_idx on public.billing_transactions (workspace_id, created_at desc);

comment on table public.billing_transactions is
  'Item #33: append-only audit ledger, never updated or deleted from application code. The real, verifiable record shown to a team lead; also the data source for item #32 point 3''s per-teammate/task cost attribution.';

create table public.billing_funding_sources (
  workspace_id uuid primary key,
  stripe_customer_id text not null,
  stripe_payment_method_id text,
  auto_reload_enabled boolean not null default false,
  auto_reload_threshold_cents bigint,
  auto_reload_amount_cents bigint,
  updated_at timestamptz not null default now()
);

comment on table public.billing_funding_sources is
  'Item #33: Stripe linkage for a workspace''s funded balance. No card data stored here -- only Stripe''s own customer/payment-method references.';

alter table public.billing_balances enable row level security;
alter table public.billing_reservations enable row level security;
alter table public.billing_transactions enable row level security;
alter table public.billing_funding_sources enable row level security;

-- Service-role only, matching every other financial/secret-adjacent table
-- in this schema -- no client-side policy. Reads for the dashboard (balance
-- display, transaction history) go through a server route using the
-- service role, never a direct client query.
