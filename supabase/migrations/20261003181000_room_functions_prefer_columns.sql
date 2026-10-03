-- The room functions return tables whose column names (room_id, member_id, status, state, ...) clash with the columns of the
-- tables their bodies query. PL/pgSQL raises 'column reference "room_id" is ambiguous' on such a clash, so admit, accept-invite,
-- register-agent-seat and decide-disclosure failed on every call (found in the first live cross-user test).
-- Each function is re-created from its own current definition with '#variable_conflict use_column' as the first line of its
-- body. That only changes the cases that currently error: code that qualifies its names, or never clashes, resolves as before.
do $$
declare fn record; def text;
begin
  for fn in
    select p.oid, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname in (
      'accept_m9r_room_invite', 'act_m9r_room_handoff', 'act_m9r_room_lease', 'admit_m9r_room_member',
      'append_m9r_room_event', 'append_m9r_room_event_internal', 'create_m9r_disclosure_request', 'create_m9r_room_invite',
      'decide_m9r_disclosure_request', 'get_m9r_room_view', 'list_m9r_room_pending_members',
      'register_m9r_room_agent_seat', 'request_m9r_room_event_disclosure', 'request_m9r_room_join')
  loop
    def := pg_get_functiondef(fn.oid);
    continue when def like '%#variable_conflict%' or position('AS $function$' in def) = 0;
    execute replace(def, 'AS $function$', E'AS $function$\n#variable_conflict use_column');
  end loop;
end $$;
