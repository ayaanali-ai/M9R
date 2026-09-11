-- Real bug found live: listConversationsForDashboard's "no roster rows yet
-- means visible to everyone" grandfather rule used ROW COUNT as its signal
-- for "was this channel's human membership ever set up." That's wrong the
-- moment the roster is later emptied by attrition -- confirmed live: the
-- workspace's only member created a channel (seeding a 1-row roster), then
-- left it (deleting that row), and the channel silently became visible to
-- "everyone" again (i.e. them) instead of staying left. Zero rows meant
-- "never restricted" and "everyone just left" identically.
--
-- This column is the real signal instead: set once, the first time a
-- channel's human roster is ever written to (creation or a leave), and
-- never unset. Visibility now checks this flag, not row count.
alter table public.agent_conversations
  add column if not exists human_membership_managed boolean not null default false;
