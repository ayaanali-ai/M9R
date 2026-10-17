-- Security fix, confirmed live 2026-10-11: m9r_save_room_memory checked that p_actor was an active
-- room member, but never checked that p_actor was actually the caller. Any signed-in user could call
-- this RPC directly (it was granted to `authenticated`) with any other active member's user id and
-- plant a note marked source='human', reviewed=true, attributed to that member -- a direct prompt-
-- injection path into that workspace's agents. The app itself only ever calls this function with the
-- service-role client (src/lib/shared-memory-service.ts:138), never as a signed-in user, so the
-- `authenticated` grant was pure unnecessary exposure -- revoking it alone closes the direct-RPC
-- exploit. The actor check below is added defense-in-depth for the same reason the function's own
-- original comment said the caller's auth.uid() should be the actor; it explicitly skips the check
-- when auth.uid() is null (the real, service-role call path) so this changes no existing behavior.
create or replace function public.m9r_save_room_memory(p_room_id uuid, p_actor uuid, p_title text, p_body text, p_content_hash text) returns public.workspace_memory_notes
language plpgsql security definer set search_path = public as $$
declare ws uuid; result workspace_memory_notes%rowtype;
begin
  if auth.uid() is not null and p_actor <> auth.uid() then
    raise exception using errcode = '42501', message = 'Actor must be the calling user.';
  end if;
  if not exists (select 1 from m9r_room_members where room_id = p_room_id and user_id = p_actor and status = 'active') then
    raise exception using errcode = '42501', message = 'Not an active member of this room.';
  end if;
  select workspace_id into ws from m9r_rooms where id = p_room_id;
  if ws is null then raise exception using errcode = 'P0002', message = 'Room not found.'; end if;
  insert into workspace_memory_notes (workspace_id, room_id, title, body, content_hash, source, author_user_id, reviewed)
  values (ws, p_room_id, p_title, p_body, p_content_hash, 'human', p_actor, true)
  returning * into result;
  return result;
end;
$$;

-- The app only calls this via the service-role client; no signed-in user should ever be able to
-- invoke it directly.
revoke all on function public.m9r_save_room_memory(uuid, uuid, text, text, text) from public, anon, authenticated;
