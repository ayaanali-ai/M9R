-- Ephemeral, private, room-member-only tab frames for C3 live view.
-- The broadcast is never persisted to room events or Postgres; each subscriber
-- gets RLS authorization from the active room membership row.
drop policy if exists "active m9r room members can read live tab broadcasts" on realtime.messages;
create policy "active m9r room members can read live tab broadcasts"
on realtime.messages for select to authenticated
using (
  extension = 'broadcast'
  and realtime.topic() ~ '^m9r-room-live:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists (
    select 1 from public.m9r_room_members m
    where m.room_id = substring(realtime.topic() from 15)::uuid
      and m.user_id = (select auth.uid()) and m.status = 'active'
  )
);

drop policy if exists "active m9r room members can publish live tab broadcasts" on realtime.messages;
create policy "active m9r room members can publish live tab broadcasts"
on realtime.messages for insert to authenticated
with check (
  extension = 'broadcast'
  and realtime.topic() ~ '^m9r-room-live:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists (
    select 1 from public.m9r_room_members m
    where m.room_id = substring(realtime.topic() from 15)::uuid
      and m.user_id = (select auth.uid()) and m.status = 'active'
  )
);
