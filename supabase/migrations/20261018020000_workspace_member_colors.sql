-- Cursor-color ownership (owner decision, 2026-10-18): color scopes to the PERSON when a
-- workspace has more than one distinct human in it (every agent that person connected shares
-- their one color, no two people collide, like Snapchat group-chat name colors), and to the
-- AGENT when the workspace is solo (one human, multiple agents -- Claude/Codex/OpenCode each get
-- their own color, which is what the native colorFor() allocator and the web AGENT_BRAND_COLOR
-- map already do). Colors are permanent once assigned, never reassigned turn to turn.
--
-- This migration only adds the per-person half (workspace_member_colors) and the function that
-- allocates/reads it. Per-agent solo coloring is unchanged and lives where it already does.

create table if not exists public.workspace_member_colors (
  workspace_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  color text not null,
  assigned_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

alter table public.workspace_member_colors enable row level security;

-- Readable by anyone who can already see the workspace's membership; never writable directly by
-- a client -- only allocate_workspace_member_color (security definer, below) ever inserts a row,
-- so two concurrent requests for the same new member can never allocate two different colors.
-- Explicitly scoped `to authenticated`, matching every other policy in this schema (e.g.
-- workspace_members' own select policy) -- omitting it defaults to PUBLIC including anon.
drop policy if exists "workspace_member_colors_select" on public.workspace_member_colors;
create policy "workspace_member_colors_select" on public.workspace_member_colors
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = workspace_member_colors.workspace_id
        and wm.user_id = auth.uid()
    )
  );

-- Same 8-color palette as the native colorFor() allocator (local-store.ts), Claude's real brand
-- color preferred first for the same reason: the one agent/person pairing with a true published
-- brand color should get it when available, everyone else takes the next free palette slot.
create or replace function public.allocate_workspace_member_color(p_workspace_id uuid, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing text;
  v_palette text[] := array['#D97757', '#7AA2F7', '#34D399', '#F59E0B', '#EC4899', '#38BDF8', '#A78BFA', '#FB7185'];
  v_used text[];
  v_chosen text;
begin
  -- One allocation per (workspace, user) at a time; a second concurrent caller for the same
  -- brand-new member waits here instead of racing to insert two different colors.
  perform pg_advisory_xact_lock(hashtext(p_workspace_id::text || ':' || p_user_id::text));

  select color into v_existing
  from public.workspace_member_colors
  where workspace_id = p_workspace_id and user_id = p_user_id;
  if v_existing is not null then
    return v_existing;
  end if;

  select array_agg(color) into v_used
  from public.workspace_member_colors
  where workspace_id = p_workspace_id;
  v_used := coalesce(v_used, array[]::text[]);

  select c into v_chosen from unnest(v_palette) as c where not (c = any(v_used)) limit 1;
  if v_chosen is null then
    -- Palette exhausted: cycle, same fallback behavior as the native allocator rather than fail.
    v_chosen := v_palette[1 + (select count(*) from public.workspace_member_colors where workspace_id = p_workspace_id) % array_length(v_palette, 1)];
  end if;

  insert into public.workspace_member_colors (workspace_id, user_id, color)
  values (p_workspace_id, p_user_id, v_chosen);
  return v_chosen;
end;
$$;

revoke all on function public.allocate_workspace_member_color(uuid, uuid) from public;
grant execute on function public.allocate_workspace_member_color(uuid, uuid) to authenticated;
