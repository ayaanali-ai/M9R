# M9R canonical Phase 1 — multiplayer contracts

Status: implemented on the Phase 0 checkpoint branch. This phase defines
provider-neutral internal contracts only. It does not dispatch a provider,
change the browser-control route, acquire Windows input, expose the pill, or
alter live sessions.

## Contract surface

`src/lib/native/multiplayer-contract.ts` defines and validates:

- run, branch, and agent correlation (`runId`, `branchId`, `agentId`);
- bounded rosters from one through sixteen active agents, with unique agent and
  branch identities;
- surface and region identities;
- revisioned operations and leases;
- bounded, idempotent A2A messages with direct or group recipients;
- compact presence states for the pill/activity layer;
- hierarchical cancellation scopes for an operation, agent, branch, or run.

The schemas reject duplicate roster identities, self-directed A2A messages,
expired leases/messages, mismatched lease holders, over-sized groups, and
reply chains deeper than the existing bounded eight-hop policy. Structured
details are bounded and contain no provider credentials, process IDs, prompts,
pixels, or session tokens.

## Deliberate boundary

Phase 1 does not wire these contracts into provider dispatch, CUA input, the
browser adapter, or the pill. Those changes belong to the ordered later phases:
run cancellation, provider runtime ownership, A2A routing, surface adapters,
mutation scheduling, browser/desktop correctness, and presence UI. Keeping the
contract additive and unused here prevents this phase from regressing the
known-good browser and provider paths.

## Verification boundary

No live provider task, browser action, installation, restart, or machine setting
was changed. Per the ordered implementation instruction, the test matrix is
deferred until all phases are implemented; this record is the source contract
and review boundary for that final verification pass.
