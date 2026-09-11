-- Buzz-parity tamper-evident audit log (closes GAP #1 from the OathLock-vs-Buzz
-- crate audit: crates/buzz-audit chains every entry to the previous entry of
-- the same community via SHA-256, serialized by a per-community lock, so
-- deleting or reordering a middle row breaks the chain and is detectable).
--
-- Same shape, ported to Postgres: one head row per workspace holds the
-- running (seq, hash); appending locks that head row `for update` (the same
-- serialization pattern apply_mission_command_atomic already uses on
-- public.missions), computes entry_hash = sha256(prev_hash || canonical
-- payload), and only then inserts + advances the head — all inside one
-- transaction, so a crash mid-append can never leave a gap or a dangling
-- head pointer.

-- pgcrypto's digest() is what append_audit_log_entry's hash computation needs.
create extension if not exists pgcrypto;

create table if not exists public.audit_log_heads (
  workspace_id uuid primary key references public.projects(id) on delete cascade,
  last_seq bigint not null default 0,
  last_hash text
);

create table if not exists public.audit_log_entries (
  workspace_id uuid not null references public.projects(id) on delete cascade,
  seq bigint not null,
  entry_hash text not null,
  prev_hash text,
  action text not null,
  actor_kind text not null check (actor_kind in ('human', 'agent', 'system')),
  actor_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (workspace_id, seq)
);

create index if not exists audit_log_entries_workspace_created_idx
  on public.audit_log_entries (workspace_id, created_at desc);

-- Appends one entry and returns it. security definer + search_path pinned,
-- same discipline as apply_mission_command_atomic — this is the ONLY path
-- allowed to write audit_log_entries; app code never inserts directly, so
-- the hash chain can't be bypassed by a buggy caller.
create or replace function public.append_audit_log_entry(
  p_workspace_id uuid,
  p_action text,
  p_actor_kind text,
  p_actor_id text,
  p_payload jsonb
)
returns table (seq bigint, entry_hash text, prev_hash text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last_seq bigint;
  v_last_hash text;
  v_next_seq bigint;
  v_entry_hash text;
  v_created_at timestamptz;
begin
  insert into public.audit_log_heads (workspace_id, last_seq, last_hash)
  values (p_workspace_id, 0, null)
  on conflict (workspace_id) do nothing;

  select last_seq, last_hash into v_last_seq, v_last_hash
  from public.audit_log_heads
  where workspace_id = p_workspace_id
  for update;

  v_next_seq := v_last_seq + 1;
  v_created_at := clock_timestamp();

  -- The hash covers everything that makes this entry unique and ordered:
  -- the previous hash (chaining), workspace, seq, action, actor, payload,
  -- and timestamp -- so an attacker who edits any field of a stored row,
  -- or a row's position, breaks the chain from that point forward.
  v_entry_hash := encode(
    digest(
      coalesce(v_last_hash, '') || '|' || p_workspace_id::text || '|' || v_next_seq::text || '|' ||
      p_action || '|' || p_actor_kind || '|' || coalesce(p_actor_id, '') || '|' ||
      p_payload::text || '|' || v_created_at::text,
      'sha256'
    ),
    'hex'
  );

  insert into public.audit_log_entries (workspace_id, seq, entry_hash, prev_hash, action, actor_kind, actor_id, payload, created_at)
  values (p_workspace_id, v_next_seq, v_entry_hash, v_last_hash, p_action, p_actor_kind, p_actor_id, p_payload, v_created_at);

  update public.audit_log_heads set last_seq = v_next_seq, last_hash = v_entry_hash where workspace_id = p_workspace_id;

  return query select v_next_seq, v_entry_hash, v_last_hash, v_created_at;
end;
$$;

-- Recomputes every entry's hash from its own stored fields, independent of
-- append_audit_log_entry's write path, and confirms prev_hash linkage --
-- this is what actually proves tamper-evidence. Deliberately done in SQL,
-- not reconstructed in application code from a re-serialized jsonb payload:
-- jsonb's own text canonicalization (key ordering, whitespace) is exactly
-- what payload::text produced at write time, so recomputing here with the
-- identical expression is the only way to avoid false "tampered" verdicts
-- caused by a cross-language reserialization mismatch rather than real
-- tampering.
create or replace function public.verify_audit_log_chain(p_workspace_id uuid)
returns table (ok boolean, entries_checked bigint, broken_at_seq bigint, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_expected_prev text := null;
  v_recomputed text;
  v_count bigint := 0;
begin
  for v_row in
    select seq, entry_hash, prev_hash, action, actor_kind, actor_id, payload, created_at
    from public.audit_log_entries
    where workspace_id = p_workspace_id
    order by seq asc
  loop
    v_count := v_count + 1;

    if (v_row.prev_hash is distinct from v_expected_prev) then
      return query select false, v_count, v_row.seq, format('prev_hash mismatch at seq %s', v_row.seq);
      return;
    end if;

    v_recomputed := encode(
      digest(
        coalesce(v_expected_prev, '') || '|' || p_workspace_id::text || '|' || v_row.seq::text || '|' ||
        v_row.action || '|' || v_row.actor_kind || '|' || coalesce(v_row.actor_id, '') || '|' ||
        v_row.payload::text || '|' || v_row.created_at::text,
        'sha256'
      ),
      'hex'
    );

    if (v_recomputed <> v_row.entry_hash) then
      return query select false, v_count, v_row.seq, format('entry_hash mismatch at seq %s', v_row.seq);
      return;
    end if;

    v_expected_prev := v_row.entry_hash;
  end loop;

  return query select true, v_count, null::bigint, null::text;
end;
$$;
