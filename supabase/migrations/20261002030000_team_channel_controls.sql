-- Invite tokens confer membership; administrators alone may read them.
drop policy if exists "members read their workspace invites" on public.workspace_invites;
create policy "administrators read workspace invites" on public.workspace_invites for select to authenticated using (
 exists(select 1 from public.projects p where p.id = workspace_id and p.owner_id = auth.uid())
 or exists(select 1 from public.workspace_members m where m.workspace_id = workspace_invites.workspace_id and m.user_id = auth.uid() and m.role in ('owner','admin'))
);
-- Serialize conversion of implicit membership and roster updates in one transaction.
create function public.m9r_change_channel_human(p_workspace uuid,p_channel uuid,p_user uuid,p_add boolean) returns void
language plpgsql security definer set search_path = public as $$
declare managed boolean;
begin
 select human_membership_managed into managed from agent_conversations where id = p_channel and workspace_id = p_workspace for update;
 if not found then raise exception 'Channel not found'; end if;
 if p_add and not exists(select 1 from workspace_members where workspace_id = p_workspace and user_id = p_user) then raise exception 'Workspace membership required'; end if;
 if not managed then
  insert into conversation_human_members(workspace_id,conversation_id,user_id)
  select p_workspace,p_channel,user_id from workspace_members where workspace_id = p_workspace on conflict(conversation_id,user_id) do nothing;
  update agent_conversations set human_membership_managed = true where id = p_channel and workspace_id = p_workspace;
 end if;
 if p_add then
  insert into conversation_human_members(workspace_id,conversation_id,user_id) values(p_workspace,p_channel,p_user) on conflict(conversation_id,user_id) do nothing;
 else
  delete from conversation_human_members where workspace_id = p_workspace and conversation_id = p_channel and user_id = p_user;
 end if;
end;
$$;
revoke all on function public.m9r_change_channel_human(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.m9r_change_channel_human(uuid,uuid,uuid,boolean) to service_role;

create function public.m9r_change_channel_agent(p_workspace uuid,p_channel uuid,p_connection uuid,p_add boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
 perform 1 from agent_conversations where id = p_channel and workspace_id = p_workspace for update;
 if not found then raise exception 'Channel not found'; end if;
 perform 1 from agent_connections where id = p_connection and workspace_id = p_workspace and status = 'active' for update;
 if not found then raise exception 'Active workspace connection required'; end if;
 if p_add then
  insert into conversation_participants(workspace_id,conversation_id,connection_id) values(p_workspace,p_channel,p_connection) on conflict(conversation_id,connection_id) do nothing;
 else
  delete from channel_agent_settings where workspace_id = p_workspace and conversation_id = p_channel and connection_id = p_connection;
  delete from conversation_participants where workspace_id = p_workspace and conversation_id = p_channel and connection_id = p_connection;
 end if;
end;
$$;
revoke all on function public.m9r_change_channel_agent(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.m9r_change_channel_agent(uuid,uuid,uuid,boolean) to service_role;
