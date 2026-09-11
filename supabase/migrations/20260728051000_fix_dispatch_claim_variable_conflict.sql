-- `mission_id` and `dispatch_key` are output parameters of the established
-- claim RPC and also column names used in its queries. Keep the public return
-- contract and body stable while embedding the PL/pgSQL compiler directive
-- that resolves those identifiers as table columns.
do $migration$
declare
  v_definition text;
  v_corrected text;
begin
  select pg_get_functiondef(
    'public.claim_mission_dispatch_candidates_atomic(jsonb,jsonb,timestamptz,bigint,text[])'::regprocedure
  )
  into v_definition;

  if position('#variable_conflict use_column' in v_definition) > 0 then
    return;
  end if;

  v_corrected := replace(
    v_definition,
    E'AS $function$\n',
    E'AS $function$\n#variable_conflict use_column\n'
  );

  if v_corrected = v_definition then
    raise exception 'dispatch_claim_function_definition_marker_not_found';
  end if;

  execute v_corrected;
end;
$migration$;
