-- One free text-memory pool per workspace, independent of member/agent count.
-- Saved notes, rules (including drafts/retired), and archived session text count.
-- Live chat, attachments, local files, and immutable audit history are separate.
create table public.workspace_memory_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid references public.agent_conversations(id) on delete cascade,
  title text not null check (length(title) between 1 and 160),
  body text not null check (octet_length(body) between 1 and 65536),
  source text not null check (source in ('human', 'agent')),
  author_user_id uuid references auth.users(id),
  author_connection_id uuid references public.agent_connections(id),
  reviewed boolean not null default false,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  content_hash text not null,
  constraint memory_author check ((source = 'human' and author_user_id is not null and author_connection_id is null) or (source = 'agent' and author_connection_id is not null and author_user_id is null))
);
create unique index workspace_memory_dedupe on public.workspace_memory_notes(workspace_id, coalesce(conversation_id::text, ''), content_hash);
create index workspace_memory_recent on public.workspace_memory_notes(workspace_id, created_at desc);
alter table public.workspace_memory_notes enable row level security;
grant select on public.workspace_memory_notes to authenticated;
grant all on public.workspace_memory_notes to service_role;
create policy "members read permitted shared notes" on public.workspace_memory_notes for select to authenticated using (
  exists (select 1 from public.projects p where p.id = workspace_id and
    (p.owner_id = auth.uid() or exists (select 1 from public.workspace_members m where m.workspace_id = p.id and m.user_id = auth.uid())))
  and (conversation_id is null or exists (select 1 from public.agent_conversations c where c.id = conversation_id and c.workspace_id = workspace_memory_notes.workspace_id and
    (c.created_by_user_id = auth.uid() or exists (select 1 from public.projects p where p.id = c.workspace_id and p.owner_id = auth.uid())
      or (not c.is_private and not c.human_membership_managed and c.channel_kind <> 'dm')
      or exists (select 1 from public.conversation_human_members h where h.workspace_id = c.workspace_id and h.conversation_id = c.id and h.user_id = auth.uid()))))
);

create table public.workspace_memory_quotas (
  workspace_id uuid primary key references public.projects(id) on delete cascade,
  limit_bytes bigint not null default 10485760 check (limit_bytes >= 0)
);
alter table public.workspace_memory_quotas enable row level security;
grant all on public.workspace_memory_quotas to service_role;

create function public.m9r_memory_bytes(p_workspace uuid) returns bigint
language sql volatile security definer set search_path = public as $$
  select
    coalesce((select sum(octet_length(title) + octet_length(body)) from workspace_memory_notes where workspace_id = p_workspace), 0)
    + coalesce((select sum(octet_length(title) + octet_length(body) + octet_length(coalesce(notes::text, '')) + octet_length(coalesce(evidence_summary, ''))) from workspace_rules where workspace_id = p_workspace and deleted_at is null), 0)
    + coalesce((select sum(octet_length(coalesce(title, ''))) from conversation_sessions where workspace_id = p_workspace and status = 'archived'), 0)
    + coalesce((select sum(octet_length(coalesce(m.body, ''))) from conversation_messages m where m.workspace_id = p_workspace and exists
      (select 1 from conversation_sessions s where s.workspace_id = p_workspace and s.status = 'archived' and m.id = any(s.message_ids))), 0);
$$;
revoke all on function public.m9r_memory_bytes(uuid) from public, anon, authenticated;
grant execute on function public.m9r_memory_bytes(uuid) to service_role;

-- Lock BEFORE the mutation so concurrent imports/archives share the same pool.
-- Two triggers preserve growth-only enforcement for legacy over-limit workspaces.
create function public.m9r_memory_lock() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  ws := case when TG_OP = 'DELETE' then OLD.workspace_id else NEW.workspace_id end;
  if TG_OP = 'UPDATE' and OLD.workspace_id <> NEW.workspace_id then raise exception 'Memory workspace cannot change'; end if;
  if TG_TABLE_NAME = 'conversation_sessions' then
    if TG_OP = 'INSERT' and NEW.status <> 'archived' then return NEW; end if;
    if TG_OP = 'DELETE' and OLD.status <> 'archived' then return OLD; end if;
    if TG_OP = 'UPDATE' and NEW.status <> 'archived' and OLD.status <> 'archived' then return NEW; end if;
  end if;
  if TG_TABLE_NAME = 'conversation_messages' and not exists (select 1 from conversation_sessions s where s.workspace_id = ws and s.status = 'archived' and (case when TG_OP = 'DELETE' then OLD.id else NEW.id end) = any(s.message_ids)) then
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(ws::text, 611));
  perform set_config('m9r.memory_before_' || replace(ws::text, '-', '_'), public.m9r_memory_bytes(ws)::text, true);
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;
create function public.m9r_memory_enforce() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws uuid; used bigint; allowance bigint; previous bigint;
begin
  ws := case when TG_OP = 'DELETE' then OLD.workspace_id else NEW.workspace_id end;
  if TG_TABLE_NAME = 'conversation_sessions' then
    if TG_OP = 'INSERT' and NEW.status <> 'archived' then return NEW; end if;
    if TG_OP = 'DELETE' and OLD.status <> 'archived' then return OLD; end if;
    if TG_OP = 'UPDATE' and NEW.status <> 'archived' and OLD.status <> 'archived' then return NEW; end if;
  end if;
  if TG_TABLE_NAME = 'conversation_messages' and not exists (select 1 from conversation_sessions s where s.workspace_id = ws and s.status = 'archived' and (case when TG_OP = 'DELETE' then OLD.id else NEW.id end) = any(s.message_ids)) then return null; end if;
  used := public.m9r_memory_bytes(ws);
  select limit_bytes into allowance from workspace_memory_quotas where workspace_id = ws;
  allowance := coalesce(allowance, 10485760);
  previous := coalesce(nullif(current_setting('m9r.memory_before_' || replace(ws::text, '-', '_'), true), '')::bigint, 0);
  if used > allowance and used > previous then raise exception using errcode = 'P0001', message = 'WORKSPACE_MEMORY_LIMIT_REACHED: This workspace has used its 10 MiB shared text memory allowance. Delete saved memory to make space.'; end if;
  return null;
end;
$$;
create trigger memory_notes_lock before insert or update or delete on public.workspace_memory_notes for each row execute function public.m9r_memory_lock();
create trigger memory_notes_quota after insert or update or delete on public.workspace_memory_notes for each row execute function public.m9r_memory_enforce();
create trigger memory_rules_lock before insert or update or delete on public.workspace_rules for each row execute function public.m9r_memory_lock();
create trigger memory_rules_quota after insert or update or delete on public.workspace_rules for each row execute function public.m9r_memory_enforce();
create trigger memory_sessions_lock before insert or update or delete on public.conversation_sessions for each row execute function public.m9r_memory_lock();
create trigger memory_sessions_quota after insert or update or delete on public.conversation_sessions for each row execute function public.m9r_memory_enforce();
create trigger memory_messages_lock before update or delete on public.conversation_messages for each row execute function public.m9r_memory_lock();
create trigger memory_messages_quota after update or delete on public.conversation_messages for each row execute function public.m9r_memory_enforce();
revoke all on function public.m9r_memory_lock(), public.m9r_memory_enforce() from public, anon, authenticated;

-- Removing/leaving a team revokes that person's agents in the same transaction.
create function public.m9r_revoke_departed_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update agent_connections set status = 'revoked', revoked_at = now() where workspace_id = OLD.workspace_id and created_by = OLD.user_id and status <> 'revoked';
  update agent_tokens set revoked_at = now() where connection_id in (select id from agent_connections where workspace_id = OLD.workspace_id and created_by = OLD.user_id) and revoked_at is null;
  delete from conversation_participants where workspace_id = OLD.workspace_id and connection_id in (select id from agent_connections where workspace_id = OLD.workspace_id and created_by = OLD.user_id);
  delete from conversation_human_members where workspace_id = OLD.workspace_id and user_id = OLD.user_id;
  return OLD;
end;
$$;
create trigger revoke_departed_member after delete on public.workspace_members for each row execute function public.m9r_revoke_departed_member();
revoke all on function public.m9r_revoke_departed_member() from public, anon, authenticated;

-- A review decision and its audit receipt commit together; no note body is copied
-- into the audit ledger, so deleting memory actually frees its text allocation.
create function public.m9r_review_memory_note(p_workspace uuid,p_note uuid,p_actor uuid,p_delete boolean) returns void
language plpgsql security definer set search_path = public as $$
declare target workspace_memory_notes%rowtype;
begin
 if not exists(select 1 from projects where id=p_workspace and owner_id=p_actor) and not exists(select 1 from workspace_members where workspace_id=p_workspace and user_id=p_actor and role in ('owner','admin')) then raise exception 'Administrator required'; end if;
 select * into target from workspace_memory_notes where workspace_id=p_workspace and id=p_note for update;
 if not found then raise exception 'Memory note not found'; end if;
 if p_delete then delete from workspace_memory_notes where id=p_note and workspace_id=p_workspace;
 else update workspace_memory_notes set reviewed=true,reviewed_by=p_actor,reviewed_at=now() where id=p_note and workspace_id=p_workspace;
 end if;
 perform append_audit_log_entry(p_workspace,case when p_delete then 'memory.note.deleted' else 'memory.note.approved' end,'human',p_actor::text,jsonb_build_object('noteId',p_note,'channelId',target.conversation_id,'source',target.source,'authorUserId',target.author_user_id,'authorConnectionId',target.author_connection_id,'contentHash',target.content_hash));
end;
$$;
revoke all on function public.m9r_review_memory_note(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.m9r_review_memory_note(uuid,uuid,uuid,boolean) to service_role;
