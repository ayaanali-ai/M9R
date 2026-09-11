-- Item #32: Supabase Vault lives in the `vault` schema, which supabase-js
-- cannot call directly via .rpc() (only `public`-schema functions are
-- exposed that way). These are the minimal SECURITY DEFINER wrappers that
-- let application code store/read/delete a credential without ever handling
-- the encryption itself -- Vault (pgsodium-backed) does that.
--
-- All three are locked to service_role only: they read or write a
-- decrypted secret, so there is no legitimate path for a client-authenticated
-- (anon/authenticated) role to call any of them directly.

create or replace function public.m9r_native_store_credential(
  p_workspace_id uuid,
  p_provider_env_var text,
  p_secret text,
  p_created_by uuid
) returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing_vault_id uuid;
  v_new_vault_id uuid;
  v_row_id uuid;
begin
  select vault_secret_id into v_existing_vault_id
  from public.m9r_native_provider_credentials
  where workspace_id = p_workspace_id and provider_env_var = p_provider_env_var;

  if v_existing_vault_id is not null then
    -- Rotation: update the existing vault secret in place rather than
    -- orphaning it -- a stale, undeletable vault row for every key rotation
    -- would be a real leak of old secret material with no cleanup path.
    perform vault.update_secret(v_existing_vault_id, p_secret);
    v_new_vault_id := v_existing_vault_id;
  else
    v_new_vault_id := vault.create_secret(p_secret, p_workspace_id::text || ':' || p_provider_env_var, 'M9R native harness provider credential');
  end if;

  insert into public.m9r_native_provider_credentials (workspace_id, provider_env_var, vault_secret_id, created_by_user_id)
  values (p_workspace_id, p_provider_env_var, v_new_vault_id, p_created_by)
  on conflict (workspace_id, provider_env_var)
  do update set vault_secret_id = excluded.vault_secret_id
  returning id into v_row_id;

  return v_row_id;
end;
$$;

create or replace function public.m9r_native_get_credentials(p_workspace_id uuid)
returns table(provider_env_var text, decrypted_value text)
language sql
security definer
set search_path = public, vault
as $$
  select c.provider_env_var, s.decrypted_secret
  from public.m9r_native_provider_credentials c
  join vault.decrypted_secrets s on s.id = c.vault_secret_id
  where c.workspace_id = p_workspace_id;
$$;

create or replace function public.m9r_native_delete_credential(p_workspace_id uuid, p_provider_env_var text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_vault_id uuid;
begin
  select vault_secret_id into v_vault_id
  from public.m9r_native_provider_credentials
  where workspace_id = p_workspace_id and provider_env_var = p_provider_env_var;

  if v_vault_id is not null then
    delete from vault.secrets where id = v_vault_id;
  end if;

  delete from public.m9r_native_provider_credentials
  where workspace_id = p_workspace_id and provider_env_var = p_provider_env_var;
end;
$$;

revoke all on function public.m9r_native_store_credential(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.m9r_native_get_credentials(uuid) from public, anon, authenticated;
revoke all on function public.m9r_native_delete_credential(uuid, text) from public, anon, authenticated;
grant execute on function public.m9r_native_store_credential(uuid, text, text, uuid) to service_role;
grant execute on function public.m9r_native_get_credentials(uuid) to service_role;
grant execute on function public.m9r_native_delete_credential(uuid, text) to service_role;
