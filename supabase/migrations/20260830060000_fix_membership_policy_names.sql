-- The previous migration (20260830050000) briefly created renamed policies
-- ("members read ..." / "Members can ...") before being corrected to keep
-- the original policy names -- this migration file matches what was
-- actually run against the live database to fix that in place: drop the
-- renamed policies, then recreate under the original names.
drop policy if exists "members read conversations" on public.agent_conversations;
drop policy if exists "owners read conversations" on public.agent_conversations;
create policy "owners read conversations" on public.agent_conversations for select to authenticated
using (exists (select 1 from public.projects p where p.id = agent_conversations.workspace_id and p.owner_id = (select auth.uid()))
  or public.is_workspace_member(agent_conversations.workspace_id, (select auth.uid())));

drop policy if exists "members read conversation messages" on public.conversation_messages;
drop policy if exists "owners read conversation messages" on public.conversation_messages;
create policy "owners read conversation messages" on public.conversation_messages for select to authenticated
using (exists (select 1 from public.projects p where p.id = conversation_messages.workspace_id and p.owner_id = (select auth.uid()))
  or public.is_workspace_member(conversation_messages.workspace_id, (select auth.uid())));

drop policy if exists "members read conversation participants" on public.conversation_participants;
drop policy if exists "owners read conversation participants" on public.conversation_participants;
create policy "owners read conversation participants" on public.conversation_participants for select to authenticated
using (exists (select 1 from public.projects p where p.id = conversation_participants.workspace_id and p.owner_id = (select auth.uid()))
  or public.is_workspace_member(conversation_participants.workspace_id, (select auth.uid())));

drop policy if exists "members read conversation reactions" on public.conversation_message_reactions;
drop policy if exists "owners read conversation reactions" on public.conversation_message_reactions;
create policy "owners read conversation reactions" on public.conversation_message_reactions for select to authenticated
using (exists (select 1 from public.projects p where p.id = conversation_message_reactions.workspace_id and p.owner_id = (select auth.uid()))
  or public.is_workspace_member(conversation_message_reactions.workspace_id, (select auth.uid())));

drop policy if exists "members read conversation mentions" on public.conversation_message_mentions;
drop policy if exists "owners read conversation mentions" on public.conversation_message_mentions;
create policy "owners read conversation mentions" on public.conversation_message_mentions for select to authenticated
using (exists (select 1 from public.projects p where p.id = conversation_message_mentions.workspace_id and p.owner_id = (select auth.uid()))
  or public.is_workspace_member(conversation_message_mentions.workspace_id, (select auth.uid())));

drop policy if exists "members manage conversation read markers" on public.conversation_read_markers;
drop policy if exists "owners manage conversation read markers" on public.conversation_read_markers;
create policy "owners manage conversation read markers" on public.conversation_read_markers for all to authenticated
using (user_id = (select auth.uid()) and (
  exists (select 1 from public.projects p where p.id = conversation_read_markers.workspace_id and p.owner_id = (select auth.uid()))
  or public.is_workspace_member(conversation_read_markers.workspace_id, (select auth.uid()))
))
with check (user_id = (select auth.uid()) and (
  exists (select 1 from public.projects p where p.id = conversation_read_markers.workspace_id and p.owner_id = (select auth.uid()))
  or public.is_workspace_member(conversation_read_markers.workspace_id, (select auth.uid()))
));

drop policy if exists "members read workspace notifications" on public.workspace_notifications;
drop policy if exists "owners read workspace notifications" on public.workspace_notifications;
create policy "owners read workspace notifications" on public.workspace_notifications for select to authenticated
using (recipient_user_id = (select auth.uid()) and (
  exists (select 1 from public.projects p where p.id = workspace_notifications.workspace_id and p.owner_id = (select auth.uid()))
  or public.is_workspace_member(workspace_notifications.workspace_id, (select auth.uid()))
));

drop policy if exists "Members can read workspace rules" on public.workspace_rules;
drop policy if exists "Users can read own workspace rules" on public.workspace_rules;
create policy "Users can read own workspace rules" on public.workspace_rules for select to authenticated
using (workspace_id in (select id from public.projects where owner_id = auth.uid())
  or public.is_workspace_member(workspace_id, auth.uid()));

drop policy if exists "Members can insert workspace rules" on public.workspace_rules;
drop policy if exists "Users can insert own workspace rules" on public.workspace_rules;
create policy "Users can insert own workspace rules" on public.workspace_rules for insert to authenticated
with check (workspace_id in (select id from public.projects where owner_id = auth.uid())
  or public.is_workspace_member(workspace_id, auth.uid()));

drop policy if exists "Members can update workspace rules" on public.workspace_rules;
drop policy if exists "Users can update own workspace rules" on public.workspace_rules;
create policy "Users can update own workspace rules" on public.workspace_rules for update to authenticated
using (workspace_id in (select id from public.projects where owner_id = auth.uid())
  or public.is_workspace_member(workspace_id, auth.uid()))
with check (workspace_id in (select id from public.projects where owner_id = auth.uid())
  or public.is_workspace_member(workspace_id, auth.uid()));

drop policy if exists "Members can delete workspace rules" on public.workspace_rules;
drop policy if exists "Users can delete own workspace rules" on public.workspace_rules;
create policy "Users can delete own workspace rules" on public.workspace_rules for delete to authenticated
using (workspace_id in (select id from public.projects where owner_id = auth.uid())
  or public.is_workspace_member(workspace_id, auth.uid()));

drop policy if exists "Members read workspace findings" on public.findings;
drop policy if exists "Users read own workspace findings" on public.findings;
create policy "Users read own workspace findings" on public.findings for select to authenticated
using (workspace_id in (select id from public.projects where owner_id = auth.uid())
  or public.is_workspace_member(workspace_id, auth.uid()));

drop policy if exists "Members read workspace findings_adoptions" on public.findings_adoptions;
drop policy if exists "Users read own workspace findings_adoptions" on public.findings_adoptions;
create policy "Users read own workspace findings_adoptions" on public.findings_adoptions for select to authenticated
using (workspace_id in (select id from public.projects where owner_id = auth.uid())
  or public.is_workspace_member(workspace_id, auth.uid()));

drop policy if exists "Members read agent runs" on public.agent_runs;
drop policy if exists "Users read own agent runs" on public.agent_runs;
create policy "Users read own agent runs" on public.agent_runs for select to authenticated
using (workspace_id in (select id from public.projects where owner_id = auth.uid())
  or public.is_workspace_member(workspace_id, auth.uid()));

drop policy if exists "Members read agent run events" on public.agent_run_events;
drop policy if exists "Users read own agent run events" on public.agent_run_events;
create policy "Users read own agent run events" on public.agent_run_events for select to authenticated
using (run_id in (select id from public.agent_runs where workspace_id in (select id from public.projects where owner_id = auth.uid())
    or public.is_workspace_member(agent_runs.workspace_id, auth.uid())));

drop policy if exists "Members read agent sessions" on public.agent_sessions;
drop policy if exists "Users read own agent sessions" on public.agent_sessions;
create policy "Users read own agent sessions" on public.agent_sessions for select to authenticated
using (workspace_id in (select id from public.projects where owner_id = auth.uid())
  or public.is_workspace_member(workspace_id, auth.uid()));
