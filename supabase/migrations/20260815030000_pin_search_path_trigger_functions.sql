-- Found during a whole-codebase security sweep: set_updated_at and
-- touch_workspace_rules_updated_at (both plain updated_at-touching triggers)
-- had no pinned search_path, flagged by the security advisor as
-- function_search_path_mutable -- the standard search-path-hijacking class
-- of issue for SECURITY DEFINER/trigger functions. Neither function
-- references anything outside its own NEW record (no table/function lookups
-- that could resolve against an attacker-controlled schema), so this is a
-- low-risk, zero-behavior-change fix -- verified live: the advisor warning
-- is gone and both functions still resolve now() correctly (pg_catalog is
-- always implicitly searched regardless of search_path).

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  NEW.updated_at = now();
  return NEW;
end;
$function$;

create or replace function public.touch_workspace_rules_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  NEW.updated_at = now();
  return NEW;
end;
$function$;
