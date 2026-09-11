-- Durable Mission collaboration surfaces beyond the immutable message stream.
-- Reactions and memberships are current-state records; edits/deletes and canvas
-- revisions retain their complete history. Voice media never enters Postgres.

create table if not exists public.mission_channels (
  mission_id text primary key references public.missions(id) on delete cascade,
  workspace_id text not null,
  visibility text not null default 'workspace' check (visibility in ('workspace', 'private')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mission_channel_members (
  mission_id text not null references public.missions(id) on delete cascade,
  participant_id text not null,
  added_by text not null,
  added_at timestamptz not null default now(),
  primary key (mission_id, participant_id)
);

create table if not exists public.mission_message_reactions (
  mission_id text not null references public.missions(id) on delete cascade,
  message_id text not null,
  participant_id text not null,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (mission_id, message_id, participant_id, emoji)
);

create table if not exists public.mission_message_revisions (
  id uuid primary key default gen_random_uuid(),
  mission_id text not null references public.missions(id) on delete cascade,
  message_id text not null,
  editor_participant_id text not null,
  version integer not null check (version > 0),
  body text,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  unique (mission_id, message_id, version),
  check ((deleted and body is null) or (not deleted and body is not null and octet_length(body) between 1 and 12000))
);

create table if not exists public.mission_message_attachments (
  id uuid primary key default gen_random_uuid(),
  mission_id text not null references public.missions(id) on delete cascade,
  message_id text not null,
  uploader_participant_id text not null,
  name text not null check (octet_length(name) between 1 and 256),
  media_type text not null check (octet_length(media_type) between 1 and 128),
  size_bytes bigint not null check (size_bytes between 0 and 26214400),
  url text not null check (octet_length(url) between 1 and 2048),
  created_at timestamptz not null default now()
);

create table if not exists public.mission_canvases (
  id uuid primary key default gen_random_uuid(),
  mission_id text not null references public.missions(id) on delete cascade,
  title text not null check (octet_length(title) between 1 and 160),
  created_by text not null,
  current_version integer not null default 0 check (current_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mission_canvas_editors (
  canvas_id uuid not null references public.mission_canvases(id) on delete cascade,
  participant_id text not null,
  added_by text not null,
  added_at timestamptz not null default now(),
  primary key (canvas_id, participant_id)
);

create table if not exists public.mission_canvas_versions (
  canvas_id uuid not null references public.mission_canvases(id) on delete cascade,
  version integer not null check (version > 0),
  editor_participant_id text not null,
  content jsonb not null check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 262144),
  created_at timestamptz not null default now(),
  primary key (canvas_id, version)
);

create table if not exists public.mission_huddles (
  id uuid primary key default gen_random_uuid(),
  mission_id text not null references public.missions(id) on delete cascade,
  started_by text not null,
  started_at timestamptz not null default now(),
  ended_by text,
  ended_at timestamptz,
  check ((ended_at is null and ended_by is null) or (ended_at is not null and ended_by is not null))
);

create unique index if not exists mission_one_live_huddle_idx on public.mission_huddles (mission_id) where ended_at is null;
create index if not exists mission_reactions_message_idx on public.mission_message_reactions (mission_id, message_id);
create index if not exists mission_revisions_message_idx on public.mission_message_revisions (mission_id, message_id, version desc);
create index if not exists mission_attachments_message_idx on public.mission_message_attachments (mission_id, message_id);
create index if not exists mission_canvases_mission_idx on public.mission_canvases (mission_id, updated_at desc);

alter table public.mission_channels enable row level security;
alter table public.mission_channel_members enable row level security;
alter table public.mission_message_reactions enable row level security;
alter table public.mission_message_revisions enable row level security;
alter table public.mission_message_attachments enable row level security;
alter table public.mission_canvases enable row level security;
alter table public.mission_canvas_editors enable row level security;
alter table public.mission_canvas_versions enable row level security;
alter table public.mission_huddles enable row level security;

revoke all on public.mission_channels, public.mission_channel_members,
  public.mission_message_reactions, public.mission_message_revisions,
  public.mission_message_attachments, public.mission_canvases,
  public.mission_canvas_editors, public.mission_canvas_versions,
  public.mission_huddles from anon, authenticated;
grant select, insert, update, delete on public.mission_channels, public.mission_channel_members,
  public.mission_message_reactions, public.mission_message_revisions,
  public.mission_message_attachments, public.mission_canvases,
  public.mission_canvas_editors, public.mission_canvas_versions,
  public.mission_huddles to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'mission-media', 'mission-media', false, 26214400,
  array['image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain','text/markdown','application/json','audio/mpeg','audio/ogg','audio/wav']
)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
