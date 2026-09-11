-- Real file/attachment upload for workspace channels and DMs. The lightning
-- icon in the composer used to only insert canned /-command text into the
-- draft -- no actual upload path existed anywhere. mission_message_attachments
-- was considered for reuse but its mission_id column has a hard FK to
-- public.missions(id), which most conversations never get a row in (Mission
-- binding is opt-in and lazy, see mission-channel-binding.ts) -- so it would
-- foreign-key-violation on every plain channel/DM upload. This table keys
-- directly off conversation_messages, the table channel messages actually
-- live in.

create table if not exists public.conversation_message_attachments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  message_id uuid not null references public.conversation_messages(id) on delete cascade,
  uploader_user_id uuid not null,
  name text not null check (octet_length(name) between 1 and 256),
  media_type text not null check (octet_length(media_type) between 1 and 128),
  size_bytes bigint not null check (size_bytes between 0 and 26214400),
  storage_path text not null check (octet_length(storage_path) between 1 and 2048),
  created_at timestamptz not null default now()
);

create index if not exists conversation_attachments_message_idx on public.conversation_message_attachments (message_id);
create index if not exists conversation_attachments_conversation_idx on public.conversation_message_attachments (conversation_id, created_at desc);

alter table public.conversation_message_attachments enable row level security;
revoke all on public.conversation_message_attachments from anon, authenticated;
grant select, insert, update, delete on public.conversation_message_attachments to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'conversation-media', 'conversation-media', false, 26214400,
  array['image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain','text/markdown','application/json','audio/mpeg','audio/ogg','audio/wav']
)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
