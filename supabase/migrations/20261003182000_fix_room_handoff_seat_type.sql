-- Found in the live cross-user test: accepting a handoff failed with 'operator does not exist: uuid = text'.
-- m9r_room_events.actor_seat_id is text, while m9r_room_agent_seats.id and m9r_room_leases.holder_seat_id are uuid.
-- The accept branch compared them directly in two places; compare as text instead. Proposing and completing were unaffected.
do $$
declare def text; patched text;
begin
  select pg_get_functiondef(p.oid) into def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'act_m9r_room_handoff';
  patched := replace(def, 's.id = proposal_row.actor_seat_id', 's.id::text = proposal_row.actor_seat_id');
  patched := replace(patched, 'lease_row.holder_seat_id is distinct from proposal_row.actor_seat_id', 'lease_row.holder_seat_id::text is distinct from proposal_row.actor_seat_id');
  if patched = def or patched like '%s.id = proposal_row.actor_seat_id%' or patched like '%holder_seat_id is distinct from proposal_row.actor_seat_id%' then
    raise exception 'act_m9r_room_handoff was not patched as expected';
  end if;
  execute patched;
end $$;
