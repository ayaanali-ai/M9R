-- Item #33: the actual safety mechanism, not the data model. Every function
-- here is SECURITY DEFINER and locked to service_role, matching the pattern
-- already established for m9r_native_store_credential/etc. -- these are the
-- only sanctioned way to move money in this schema; application code must
-- never UPDATE billing_balances directly.

-- Atomically attempts to reserve `p_estimate_cents` against a workspace's
-- available balance (balance_cents - reserved_cents). Single UPDATE with a
-- WHERE guard, not a read-then-write -- this is what actually prevents the
-- race condition two concurrent requests would otherwise hit: Postgres
-- serializes concurrent UPDATEs to the same row, so there is no window
-- where both can pass a check before either commits. Returns the created
-- reservation row, or null if the balance can't cover the estimate (the
-- row is never created in that case -- nothing to release).
create or replace function public.m9r_billing_reserve(
  p_workspace_id uuid,
  p_estimate_cents bigint,
  p_provider_id text default null,
  p_model text default null,
  p_session_id text default null
)
returns public.billing_reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated public.billing_balances;
  v_reservation public.billing_reservations;
begin
  if p_estimate_cents < 0 then
    raise exception 'estimate_cents must be non-negative';
  end if;

  update public.billing_balances
  set reserved_cents = reserved_cents + p_estimate_cents,
      updated_at = now()
  where workspace_id = p_workspace_id
    and (balance_cents - reserved_cents) >= p_estimate_cents
  returning * into v_updated;

  if not found then
    return null; -- insufficient available balance (or no balance row at all) -- refuse before dispatch, nothing held.
  end if;

  insert into public.billing_reservations (workspace_id, estimated_cost_cents, provider_id, model, session_id)
  values (p_workspace_id, p_estimate_cents, p_provider_id, p_model, p_session_id)
  returning * into v_reservation;

  insert into public.billing_transactions (workspace_id, type, amount_cents, balance_after_cents, related_reservation_id)
  values (p_workspace_id, 'reserve', -p_estimate_cents, v_updated.balance_cents - v_updated.reserved_cents, v_reservation.id);

  return v_reservation;
end;
$$;

-- Reconciles a held reservation against the real cost the provider actually
-- reported. Charges balance_cents for the actual amount (never the
-- estimate) and releases the estimate's hold on reserved_cents in the same
-- statement -- a request that errors after partial output still bills for
-- the tokens actually processed, since providers charge for consumption,
-- not success.
create or replace function public.m9r_billing_reconcile(
  p_reservation_id uuid,
  p_actual_cost_cents bigint
)
returns public.billing_balances
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.billing_reservations;
  v_updated public.billing_balances;
begin
  if p_actual_cost_cents < 0 then
    raise exception 'actual_cost_cents must be non-negative';
  end if;

  select * into v_reservation from public.billing_reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'No reservation with id %', p_reservation_id;
  end if;
  if v_reservation.status <> 'held' then
    raise exception 'Reservation % is already %, not held', p_reservation_id, v_reservation.status;
  end if;

  update public.billing_balances
  set balance_cents = balance_cents - p_actual_cost_cents,
      reserved_cents = reserved_cents - v_reservation.estimated_cost_cents,
      updated_at = now()
  where workspace_id = v_reservation.workspace_id
  returning * into v_updated;

  update public.billing_reservations
  set status = 'reconciled',
      actual_cost_cents = p_actual_cost_cents,
      reconciled_at = now()
  where id = p_reservation_id;

  insert into public.billing_transactions (workspace_id, type, amount_cents, balance_after_cents, related_reservation_id)
  values (v_reservation.workspace_id, 'reconcile', -p_actual_cost_cents, v_updated.balance_cents, p_reservation_id);

  return v_updated;
end;
$$;

-- Releases a reservation that never got a real request underway (rejected
-- before dispatch, or the caller decided not to proceed) -- full release,
-- zero cost, no billing_transactions row (nothing was ever charged).
create or replace function public.m9r_billing_release(p_reservation_id uuid)
returns public.billing_balances
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.billing_reservations;
  v_updated public.billing_balances;
begin
  select * into v_reservation from public.billing_reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'No reservation with id %', p_reservation_id;
  end if;
  if v_reservation.status <> 'held' then
    raise exception 'Reservation % is already %, not held', p_reservation_id, v_reservation.status;
  end if;

  update public.billing_balances
  set reserved_cents = reserved_cents - v_reservation.estimated_cost_cents,
      updated_at = now()
  where workspace_id = v_reservation.workspace_id
  returning * into v_updated;

  update public.billing_reservations
  set status = 'released'
  where id = p_reservation_id;

  return v_updated;
end;
$$;

-- Credits a workspace's balance. Callers must only invoke this after a
-- verified Stripe webhook (payment_intent.succeeded, or an auto-reload
-- charge succeeding) -- never on a client-reported "succeeded". Creates the
-- balance row on first funding (a workspace has no row until it funds).
create or replace function public.m9r_billing_fund(
  p_workspace_id uuid,
  p_amount_cents bigint
)
returns public.billing_balances
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated public.billing_balances;
begin
  if p_amount_cents <= 0 then
    raise exception 'amount_cents must be positive';
  end if;

  insert into public.billing_balances (workspace_id, balance_cents, reserved_cents)
  values (p_workspace_id, p_amount_cents, 0)
  on conflict (workspace_id) do update
    set balance_cents = public.billing_balances.balance_cents + excluded.balance_cents,
        updated_at = now()
  returning * into v_updated;

  insert into public.billing_transactions (workspace_id, type, amount_cents, balance_after_cents)
  values (p_workspace_id, 'fund', p_amount_cents, v_updated.balance_cents);

  return v_updated;
end;
$$;

revoke all on function public.m9r_billing_reserve(uuid, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.m9r_billing_reconcile(uuid, bigint) from public, anon, authenticated;
revoke all on function public.m9r_billing_release(uuid) from public, anon, authenticated;
revoke all on function public.m9r_billing_fund(uuid, bigint) from public, anon, authenticated;
grant execute on function public.m9r_billing_reserve(uuid, bigint, text, text, text) to service_role;
grant execute on function public.m9r_billing_reconcile(uuid, bigint) to service_role;
grant execute on function public.m9r_billing_release(uuid) to service_role;
grant execute on function public.m9r_billing_fund(uuid, bigint) to service_role;
