-- Room-scoped shared memory: reuses the existing workspace_memory_notes table and its
-- 10 MiB-per-workspace quota/enforcement triggers (20261002020000_workspace_shared_memory.sql)
-- exactly as-is -- no new memory system, no new quota mechanism. A room's notes are the
-- host's own workspace memory, just scoped to the room so a guest only sees that room's
-- notes, not the host's whole workspace. Upgrading the host's workspace to paid raises the
-- same quota row the notes already count against; nothing to migrate.

alter table public.workspace_memory_notes
  add column room_id uuid references public.m9r_rooms(id) on delete cascade;

-- A note is scoped to at most one of a channel or a room, never both; that keeps every
-- existing conversation_id-based authorization check (assertChannel, the existing select
-- policy) meaningful for channel notes without having to also reason about room_id there.
alter table public.workspace_memory_notes
  add constraint workspace_memory_notes_single_scope check (not (conversation_id is not null and room_id is not null));

create index if not exists workspace_memory_room_recent on public.workspace_memory_notes (room_id, created_at desc) where room_id is not null;

-- The original dedupe key (workspace_id, conversation_id, content_hash) would otherwise treat every
-- room-scoped note (conversation_id always null) as sharing one dedupe bucket with the workspace's
-- general notes and with every OTHER room in the same workspace -- the same wording saved in two
-- different rooms would wrongly collide. Add room_id into the key so each room dedupes on its own.
drop index if exists workspace_memory_dedupe;
create unique index workspace_memory_dedupe on public.workspace_memory_notes(workspace_id, coalesce(conversation_id::text, ''), coalesce(room_id::text, ''), content_hash);

-- Authorization lives here (SECURITY DEFINER), the same pattern as m9r_review_memory_note and
-- append_m9r_room_event: the API route uses the cookie session (so auth.uid() is the real caller)
-- but the insert itself needs service-level privilege, so the check happens inside the function.
drop function if exists public.m9r_save_room_memory(uuid, uuid, text, text, text);
create function public.m9r_save_room_memory(p_room_id uuid, p_actor uuid, p_title text, p_body text, p_content_hash text) returns public.workspace_memory_notes
language plpgsql security definer set search_path = public as $$
declare ws uuid; result workspace_memory_notes%rowtype;
begin
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
revoke all on function public.m9r_save_room_memory(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.m9r_save_room_memory(uuid, uuid, text, text, text) to authenticated;

-- Separate, additive policy (Postgres ORs multiple permissive policies together) so the
-- existing workspace-membership policy above is untouched. An active room member -- host,
-- invited teammate, or an anonymous guest who was admitted -- reads only that room's notes,
-- with no requirement to be a workspace_members row at all.
drop policy if exists "room members read their room's shared notes" on public.workspace_memory_notes;
create policy "room members read their room's shared notes" on public.workspace_memory_notes for select to authenticated using (
  room_id is not null and exists (
    select 1 from public.m9r_room_members rm where rm.room_id = workspace_memory_notes.room_id and rm.user_id = auth.uid() and rm.status = 'active'
  )
);
