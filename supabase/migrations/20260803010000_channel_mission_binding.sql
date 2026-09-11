-- Buzz-parity chat: a channel may bind to exactly one repository and, once a
-- Mission is implicitly created from a message in that channel, exactly one
-- Mission. Both are nullable — existing channels are unaffected until an
-- operator sets a repository, and a channel with no repository never gets an
-- implicit Mission (mission-channel-binding.ts refuses rather than guesses).

alter table public.agent_conversations
  add column if not exists repository text,
  add column if not exists repository_id text,
  add column if not exists mission_id text references public.missions(id) on delete set null;

create unique index if not exists agent_conversations_mission_id_idx
  on public.agent_conversations (mission_id)
  where mission_id is not null;
