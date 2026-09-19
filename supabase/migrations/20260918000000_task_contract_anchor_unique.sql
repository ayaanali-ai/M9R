-- One task contract per anchor message: a message delivered twice (relay + poll)
-- must not open two contracts. Skipped, with a notice, if duplicates already
-- exist so the migration cannot fail mid-deploy; clean those up and re-run.
do $$
begin
  if exists (
    select 1 from public.task_contracts
    where anchor_message_id is not null
    group by anchor_message_id having count(*) > 1
  ) then
    raise notice 'task_contracts has duplicate anchor_message_id rows; unique index NOT created';
  else
    create unique index if not exists task_contracts_anchor_message_id_key
      on public.task_contracts (anchor_message_id)
      where anchor_message_id is not null;
  end if;
end $$;
