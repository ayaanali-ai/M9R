-- Tracks infrastructure that already exists live but was never captured in a
-- migration file (found via a security audit: the ensure_rls event trigger
-- was flagged as "callable by anon/authenticated" with no migration history
-- explaining what it is). It's a real, active event trigger -- fires on every
-- CREATE TABLE in public and auto-enables RLS -- that's been the actual
-- reason several newer tables (audit_log_entries, workspace_bans, etc.)
-- showed up as "RLS enabled, no policy" in the advisor rather than fully
-- open: this is what enabled RLS on them in the first place, with no
-- migration recording it. Capturing it here so a from-scratch migration
-- replay reproduces the same protection instead of silently missing it.
--
-- SECURITY DEFINER + a pinned search_path (pg_catalog) matches how it's
-- already deployed; event trigger functions run under the trigger's own
-- privileges when fired by DDL, so revoking direct EXECUTE below doesn't
-- affect the trigger firing -- it only removes the (already
-- non-functional -- pg_event_trigger_ddl_commands() errors outside a real
-- DDL event context) ability to call it directly as an ordinary RPC.

create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path = 'pg_catalog'
as $function$
declare
  cmd record;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
     if cmd.schema_name is not null and cmd.schema_name in ('public') and cmd.schema_name not in ('pg_catalog', 'information_schema') and cmd.schema_name not like 'pg_toast%' and cmd.schema_name not like 'pg_temp%' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
        raise log 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      exception
        when others then
          raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
     else
        raise log 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     end if;
  end loop;
end;
$function$;

do $$
begin
  if not exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    create event trigger ensure_rls on ddl_command_end
      when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      execute function public.rls_auto_enable();
  end if;
end
$$;

revoke all on function public.rls_auto_enable() from public, anon, authenticated;
grant execute on function public.rls_auto_enable() to service_role, postgres;
