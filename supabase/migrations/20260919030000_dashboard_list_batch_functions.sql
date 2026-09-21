-- The dashboard channel list ran one "latest message" query and one "unread count" query per channel on every
-- poll (every 2-10 s per open tab, up to 100 channels). These two functions do the same work in one round trip each.
-- security invoker: they run as the calling user, so row level security applies exactly as it does to a plain select.

create or replace function public.latest_messages_per_conversation(p_workspace_id uuid, p_conversation_ids uuid[])
returns setof public.conversation_messages
language sql stable security invoker set search_path = public as $$
  select m.*
  from unnest(p_conversation_ids) as c(id)
  cross join lateral (
    select * from public.conversation_messages
    where workspace_id = p_workspace_id and conversation_id = c.id
    order by created_at desc, id desc
    limit 1
  ) m
$$;

create or replace function public.unread_counts_per_conversation(p_workspace_id uuid, p_conversation_ids uuid[], p_user_id uuid, p_excluded_message_ids uuid[] default '{}')
returns table (conversation_id uuid, unread_count bigint)
language sql stable security invoker set search_path = public as $$
  select c.id, count(m.id)
  from unnest(p_conversation_ids) as c(id)
  left join public.conversation_read_markers r
    on r.workspace_id = p_workspace_id and r.conversation_id = c.id and r.user_id = p_user_id
  left join public.conversation_messages m
    on m.workspace_id = p_workspace_id and m.conversation_id = c.id
   and (r.read_at is null or m.created_at > r.read_at)
   and not (m.id = any(p_excluded_message_ids))
  group by c.id
$$;
