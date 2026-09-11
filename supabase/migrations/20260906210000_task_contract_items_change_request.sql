alter table public.task_contract_items
  add column if not exists change_request jsonb null;

comment on column public.task_contract_items.change_request is
  'Single-slot request from the currently-assigned agent to change its own assignment. {reason, detail, suggestedConnectionId, requestedByConnectionId, requestedAt}. Null = no open request. Set via the request_assignment_change MCP tool; cleared by a human resolving it (reassign/keep-as-is/fail). See M9R_MASTER_BUILD_PLAN.md #4.';
