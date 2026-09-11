-- OathLock authentication foundation. Run after supabase-oathlock-phase1.sql.
-- Auth identities map 1:1 to public.users so existing ownership policies work.

create or replace function public.handle_new_oathlock_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Mirror the auth identity into public.users so ownership policies work.
  insert into public.users (id, auth_user_id, email, name)
  values (
    new.id,
    new.id,
    coalesce(new.email, ''),
    new.raw_user_meta_data ->> 'name'
  )
  on conflict (id) do update
    set auth_user_id = excluded.auth_user_id,
        email = excluded.email;

  -- Give every new user a default workspace. Guarded by NOT EXISTS instead of
  -- ON CONFLICT: the unique index is partial (slug IS NOT NULL AND deleted_at IS
  -- NULL), and an ON CONFLICT arbiter whose predicate doesn't match that index
  -- exactly raises an error here — which would abort the whole signup.
  if not exists (
    select 1 from public.projects
    where owner_id = new.id and deleted_at is null
  ) then
    insert into public.projects (owner_id, name, slug, description)
    values (new.id, 'Default workspace', 'default', 'Your private OathLock workspace');
  end if;
  return new;
exception
  -- Bulletproofing: provisioning must NEVER block account creation. If anything
  -- here fails, log a warning and let signup succeed — the app self-heals the
  -- user row + default workspace on first use (see projects-service.ts).
  when others then
    raise warning 'handle_new_oathlock_user failed for %: %', new.id, sqlerrm;
    return new;
end;
$$;

revoke all on function public.handle_new_oathlock_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_oathlock on auth.users;
create trigger on_auth_user_created_oathlock
  after insert on auth.users
  for each row execute procedure public.handle_new_oathlock_user();

-- Allow a signed-in user to create their OWN public.users row. The base schema
-- only granted select/update, so app-side self-healing (ensureUserRow) could not
-- create a missing row when the service-role key wasn't configured. This closes
-- that gap; the WITH CHECK keeps users from creating rows for anyone else.
drop policy if exists "Users can insert own user row" on public.users;
create policy "Users can insert own user row" on public.users
  for insert to authenticated with check (id = auth.uid());

-- Data API access is explicit; RLS remains the authorization layer.
grant select, insert, update on public.users to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.traces to authenticated;
grant select, insert on public.blackbox_reports to authenticated;
grant select, insert, update, delete on public.rules to authenticated;
grant select on public.rule_applications to authenticated;
grant select on public.security_signals to authenticated;
