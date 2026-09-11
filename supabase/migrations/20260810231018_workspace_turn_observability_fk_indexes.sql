-- Phase 0 follow-up: cover the foreign keys used by timing-event cleanup and joins.
create index if not exists workspace_turn_timing_conversation_fk_idx
  on public.workspace_turn_timing_events (conversation_id, occurred_at desc, id);

create index if not exists workspace_turn_timing_message_scope_idx
  on public.workspace_turn_timing_events (message_id, workspace_id, occurred_at desc, id);
