-- Keep launch diff-review evidence immutable to authenticated Data API clients.
-- Owners may only transition a pending review through this narrow function.

revoke update on public.launch_diff_reviews from authenticated;
drop policy if exists "owners decide launch diff reviews" on public.launch_diff_reviews;

create or replace function public.decide_launch_diff_review(
  p_review_id uuid,
  p_decision text,
  p_decided_at timestamptz default now()
) returns table (
  id uuid,
  launch_grant_id uuid,
  manifest_digest text,
  decision text,
  decided_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid diff-review decision' using errcode = '22023';
  end if;

  return query
  update public.launch_diff_reviews as review
  set
    decision = p_decision,
    decided_by = v_actor,
    decided_at = p_decided_at
  where review.id = p_review_id
    and review.decision = 'pending'
    and exists (
      select 1
      from public.projects as project
      where project.id = review.workspace_id
        and project.owner_id = v_actor
        and project.deleted_at is null
    )
  returning
    review.id,
    review.launch_grant_id,
    review.manifest_digest,
    review.decision,
    review.decided_at;
end;
$$;

revoke all on function public.decide_launch_diff_review(uuid, text, timestamptz) from public;
grant execute on function public.decide_launch_diff_review(uuid, text, timestamptz) to authenticated;
