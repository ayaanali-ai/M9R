-- Lets a workspace owner override which model a connected Codex or Claude
-- Code agent uses, instead of it being silently locked to whatever the
-- provider CLI's own local config file happens to have (the exact gap that
-- caused a Codex bridge to silently fail every turn tonight: its local
-- config pinned an expensive model the account's plan didn't support, and
-- there was no way to see or change that from OathLock at all).
alter table public.agent_connections
  add column if not exists model text null;

alter table public.agent_connections
  add constraint agent_connections_model_length check (model is null or char_length(model) <= 80);
