-- Add identity and roster fields to agent_connections for multiplayer AI
-- display_name, title, avatar_url, mascot_body, voice, speak_replies, soul (standing instructions)
-- section, chief_of_staff, managed_sections, peers (reachability allow-list)

alter table public.agent_connections
  add column if not exists display_name text,
  add column if not exists title text,
  add column if not exists avatar_url text,
  add column if not exists mascot_body text,
  add column if not exists voice text,
  add column if not exists speak_replies boolean default false,
  add column if not exists soul text,
  add column if not exists section text,
  add column if not exists chief_of_staff boolean default false,
  add column if not exists managed_sections text[] default '{}',
  add column if not exists peers text[];

comment on column public.agent_connections.display_name is 'Custom display name (e.g. "Ayaan's Codex"). Falls back to owner_name + agent_kind.';
comment on column public.agent_connections.title is 'Short role/title shown in roster (e.g. "Lead Engineer").';
comment on column public.agent_connections.avatar_url is 'Custom avatar image URL (stored in attachments).';
comment on column public.agent_connections.mascot_body is 'Mascot body variant for generated avatars.';
comment on column public.agent_connections.voice is 'TTS voice identifier (ElevenLabs, Fish Audio, Mac, Chatterbox).';
comment on column public.agent_connections.speak_replies is 'Whether to read replies aloud in voice mode.';
comment on column public.agent_connections.soul is 'Standing instructions (system prompt addition), up to 24KB.';
comment on column public.agent_connections.section is 'Team section for roster grouping (e.g. "engineering", "design").';
comment on column public.agent_connections.chief_of_staff is 'Whether this connection is the Chief of Staff for its section.';
comment on column public.agent_connections.managed_sections is 'Additional sections this Chief may coordinate (owner-granted).';
comment on column public.agent_connections.peers is 'Explicit allow-list of connection IDs this bot may reach. NULL = same section.';