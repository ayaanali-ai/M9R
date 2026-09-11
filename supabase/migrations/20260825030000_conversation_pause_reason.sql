-- Layer 2's hard-stop and Layer 3's human pause switch both write
-- agent_replies_paused_at, but they mean different things and must clear
-- differently: a human pause is only lifted by the explicit resume_agents
-- action; a loop-detected auto-pause is lifted the instant a human posts a
-- real message in the channel (that IS the resolution signal for Layer 2,
-- per bridge-runtime.ts's own recordWorkspaceLoopSignal). Without a reason
-- column those two behaviors can't be told apart from the column alone.
--
-- This also fixes a real live incident: Layer 2's hard-stop state lived only
-- in a per-bridge-process in-memory Set, so every one of the (possibly
-- several, briefly overlapping across a restart) bridge processes for a
-- channel's connected agents independently detected the same "loop" and
-- independently posted its own copy of the same notice -- confirmed live,
-- nine duplicate notices in 1.9 seconds. Persisting the pause here makes it
-- genuinely cross-process: only the first writer's update actually changes
-- the row (see the WHERE clause the app code uses), so only one notice is
-- ever posted, from any number of processes that all detect the trip.
alter table public.agent_conversations
  add column if not exists agent_replies_paused_reason text
    check (agent_replies_paused_reason is null or agent_replies_paused_reason in ('human', 'loop_detected'));
