# M9R runtime recovery — evidence-led phases 0–7

Status: Recovery changes are staged through the safe provider/receipt/run-fencing boundaries. This plan is based on the current repository, the persisted M9R state, and the managed-provider diagnostics captured on this machine. It deliberately preserves the current browser-control route; the old extension/CDP path is not being reintroduced.

## Current implementation checkpoint

- **Phase 0 — complete:** the bounded `cursor-visible` timing event is emitted and durably accepted without storing prompts, pixels, credentials, or window IDs.
- **Phase 1 — implementation complete; verification held until Phases 2–7 are implemented:** the active M9R owner now uses one isolated, M9R-owned Codex app-server plus one resumable Codex thread per managed connection. The app-server inherits the user's existing authenticated Codex home (so M9R does not manufacture a logout) and receives process-scoped M9R MCP, read-only, and provider-tool-disable overrides without mutating the user's Codex UI config. App-server failures are classified as not-running, active-writer, timeout, oversized-message, authentication, usage-limit, or unknown. OpenCode's ACP submission callback and persistent-session behavior remain intact. The legacy per-turn Codex worker remains only as an explicit compatibility fixture path and is no longer selected by the owner.
- **Phase 2 — implementation complete; verification held until Phases 3–7:** provider errors are recorded as `failed`, and abandoned `sending` claims become `uncertain` on broker startup with no automatic replay. Result writers refuse to turn a failed delivery into a successful result. Explicit retries cross a durable `failed -> retryable -> dispatched` boundary. Historical T1/T4/T20/T21 records are retained as evidence and are not rewritten or resent by startup reconciliation.
- **Phase 3 — implemented:** owner stop/stop-all cancels the durable task, fences late provider events, and the UI bridge coalesces streamed text only within the same M9R turn fence. A later run from the same provider is never silently merged into the prior run.
- **Phase 4 — implementation complete; verification held until the ordered pass:** the CUA capture now preserves the driver's opaque capture identity, coordinate/position and compositor gates are separately classified and timed, foreground input remains leased, background refusal never silently falls back in a background stage, and cursor identities remain bounded to 16. The current browser-control route is unchanged.
- **Phase 5 — implementation complete; verification held until the ordered pass:** native teammate sends now carry a bounded reply-depth fence, hash the full message for idempotency, and report broker acceptance separately from recipient acknowledgement. Agent-authored activity is rendered as concise coordination labels; the existing web-room bridge remains bounded and stop-all fenced.
- **Phase 6 — implementation complete; verification held until the ordered pass:** native owner turns persist queue wait, runtime acquisition, provider acceptance, first visible action, and completion separately; managed connections verify their live provider transport before ready-state reuse. Additional measured budgets require a live trace, not guessed constants.
- **Phase 7 — implementation complete; verification held until the ordered pass:** native managed connections now expose only provider-reported model catalogs, validate selections against the live catalog, persist profile-bound choices atomically, and apply valid choices between turns where the provider supports it. The native-pill picker remains intentionally unexposed; it must consume this capability boundary rather than a guessed list.

## Confirmed failure classes

| Evidence | What is proven | What is not proven yet |
| --- | --- | --- |
| Codex managed-provider diagnostics | The Codex app-server repeatedly reported `not running`, `no response within 60000ms`, `already has an active writer`, and oversized messages. A provider usage-limit event also exists. The worker adapter flattened the later process failure to `Codex worker exited with code 1`. | The historical T20 process's exact final stderr/exit cause was not persisted, so it is not possible to honestly name one single sub-cause for that one exit. The cause family is proven: app-server/runtime availability and stale-writer contention, with usage limits also present in the same diagnostic history. |
| Persisted T21 OpenCode task | OpenCode returned the provider's exact free-usage-limit response. This is a provider quota failure, not evidence of an ACP worker crash. | Whether the account quota has since reset is a live-state question; no retry or account mutation is performed by this phase. |
| Persisted T20/T21 receipts | Both provider-failure summaries were written through a result path that marked delivery `done`/receipt `completed`. That is a receipt-integrity bug: a failed provider turn must not look completed. | The repair belongs to the receipt/reconciliation phase; Phase 0 does not rewrite historical state. |
| T4 and legacy T1 | T4 remains an old `sending` task tied to a revoked/changed Claude owner identity. T1 failed because it targeted a stale Codex identity in the old restore-managed-provider worktree. | Whether either old task should be replayed is intentionally not inferred. They must be reconciled or explicitly abandoned by policy, never silently resent. |
| Claude multiplayer log | The same long Claude turn continued to emit progress after the owner attempted to stop it, while M9R also reported that the provider was already handling another turn. This is consistent with missing run/turn fencing and stop propagation, not proof of a text-bubble duplication bug. | The exact provider-side continuation boundary still needs a controlled stop/restart test. |
| CUA tests and source | The current CUA path has two separate gates: exact cursor position confirmation, then bounded compositor visibility confirmation. The current dirty baseline fails 19/84 desktop-stage tests, and several failures stop at position confirmation before the visibility gate. | The historical live overlay miss cannot be assigned to the compositor alone from old logs; the old path did not persist the lower-level stage and attempt cost. Phase 0 now records it. |

## Phase order

### Phase 0 — freeze, baseline, and evidence (implemented in this pass)

- Preserve the dirty worktree; do not reset, checkout, delete, reinstall, or mutate machine-level settings.
- Record the current HEAD, dirty-tree condition, provider diagnostics, task/receipt evidence, and test baseline in the companion report.
- Keep browser control unchanged.
- Add a privacy-safe `cursor-visible` timing event. It records duration, bounded attempt count, configured poll interval, success/error status, and optional stage name. It contains no prompt text, credentials, pixels, window IDs, or provider tokens.
- Permit that event through the durable stage-timing validator so a future overlay miss remains available after the broker exits.

### Phase 1 — provider runtime truth

- Preserve one managed runtime per provider connection where the provider supports it; Codex now uses one M9R-owned app-server and resumable thread per managed connection rather than a per-turn worker fleet.
- Capture bounded, redacted Codex worker stderr and exit context before the worker is discarded.
- Add app-server liveness and stale-writer classification so `not running`, active-writer, timeout, oversized-message, authentication, and usage-limit failures remain distinguishable; the managed boundary now emits those classes.
- Keep OpenCode ACP persistent-session behavior and surface its provider quota response without relabeling it as a generic worker failure.
- Add recovery tests for startup, restart, and one failed turn; no automatic replay of an uncertain task.

### Phase 2 — receipt truth and reconciliation

- Make provider failure terminal state `failed` (or `uncertain` when receipt is ambiguous), never `completed` merely because a result summary was written.
- Persist stale `sending` as `uncertain` once its bounded acceptance window has expired, so it cannot remain an immortal retry-looking task.
- Reconcile T1/T4/T20/T21 by explicit evidence and policy; do not replay old work automatically.

Implementation boundary completed in this pass:

- The compatibility/live-session failure path now calls the terminal failure
  recorder instead of writing a provider error through the successful result
  setter. Authenticated and legacy result writers also refuse late results for
  a task whose receipt, delivery, or lifecycle is already `failed`.
- An explicit retry is represented in receipt history as
  `failed -> retryable -> dispatched`; no delivery pump treats a failed or
  uncertain item as retryable. The Codex compatibility adapter may only be
  re-entered by an explicit caller, while the resident delivery pump offers
  deferred work only. Provider-owner retries reopen the lifecycle projection
  at the same atomic claim, so a successful retry is not rejected by a stale
  `lifecycle=failed` marker.
- Startup reconciliation fences every old `sending` claim. A missing or
  malformed `claimedAt` is treated as unprovable/stale rather than left
  immortal, and reconciliation records no automatic resend.
- The persisted historical rows were inspected read-only. Their evidence is
  preserved; this phase does not rewrite T1/T4/T20/T21 or guess a retry policy
  for them.

### Phase 3 — run fencing, stop, and duplicate prevention

- The persisted M9R task ID is the durable turn identifier. Managed owner events additionally carry a short-lived UI run fence, while the managed connection generation fences provider callbacks after restart or stop. The provider-neutral supervisor validates task identity, connection identity, project folder, and generation before dispatch.
- Stop, stop-all, shutdown, and the compatibility live-session stop path now use the durable cancellation boundary before tearing down the provider transport. The cancellation is idempotent; a provider that ignores or races a stop is fenced from publishing text, tools, results, or failure evidence into the canceled task.
- The UI bridge coalesces streamed text only when the handle and UI run fence match, and only while that live entry is still the newest thread item. Results from another run remain separate evidence instead of silently merging into an older bubble.

Implementation boundary completed in this pass:

- Managed owner late-event handling now checks the task fence before every provider event and suppresses post-stop error/status output as well as text/results. The owner shutdown path applies the same fence before draining its resident connections.
- The legacy/compatibility live-session stop path now cancels active, owner-pending, and room-relayed task associations through `cancelTask` before stopping Claude, Codex, or OpenCode. Stop-all and close also cancel a task that is still in the delivery/acceptance window even when its process has not started yet.
- If the owner-delivery acceptance window expires, the task remains `uncertain` and non-replayable while the exact provider transport is stopped through the same generation fence; late output cannot leak into a later turn.
- No browser-control route, provider authentication, model selection, machine setting, or provider-owned session was changed by Phase 3. No tests, builds, live provider tasks, or desktop actions were run; the ordered verification checkpoint remains after the implementation phases.

### Phase 4 — desktop/CUA correctness and multiplayer input

- Separate position proof, compositor visibility proof, foreground-input lease, and background-input capability in both errors and timings.
- Repair the current coordinate/fixture contract before changing the live browser route. Do not hide position mismatches by weakening confirmation.
- Keep the one real Windows foreground stream serialized, while allowing background-capable actions to run concurrently. Cursor identities remain bounded to 16 providers; no promise of two raw foreground keyboards is made.
- Use explicit per-agent cursor slots and task/run ownership to prevent collisions.

Implementation boundary completed in this pass:

- The exact Cua screenshot identity returned by the native driver now survives
  the public capture/structure path and the cached-capture path. A coordinate
  action can therefore remain bound to the immutable frame it was observed
  from instead of losing the driver's capture identity at the adapter boundary.
- Desktop input gates now carry stable, machine-readable codes for target
  identity, unconfirmed cursor position, compositor overlay visibility, and
  unavailable background delivery. Callers do not need to parse error text,
  and a gate still fails closed before input is dispatched.
- The stage timing contract records `cursor-position`, `cursor-visible`,
  `foreground-lease`, and `background-dispatch` separately. Details are
  bounded and privacy-safe; no prompts, credentials, window IDs, or pixels are
  recorded.
- Foreground actions continue through the single broker-wide lease. A
  background stage still refuses a foreground fallback when the native driver
  cannot deliver background input. Per-agent cursor slot reservation remains
  serialized and capped at 16 identities.
- No browser/CDP route, provider session, authentication state, machine
  setting, or live desktop action was changed. Tests and builds remain deferred
  until the ordered implementation phases are complete.

### Phase 5 — agent-to-agent coordination

- Use bounded structured messages (intent, target, dependency, completion) rather than repeatedly polling full transcripts.
- Add recipient/run dedupe and acknowledgement state so a handoff is not resent on a late or missing receipt.
- Render concise human-facing activity labels separately from the raw coordination log.

Implementation boundary completed in this pass:

- Native `m9r_send` and its authenticated owner-broker mutation path now derive
  reply depth from the active parent task and refuse a chain beyond eight
  teammate hops. A provider must start a new owner task instead of creating an
  unbounded self-referential exchange.
- The direct native send path now hashes the complete message, not a 200-byte
  prefix, together with the sender session and recipient. Repeated delivery of
  the same full message is therefore deduplicated without collapsing two
  different long messages that share a prefix.
- Send responses now say that M9R accepted exactly one durable task and that
  recipient acknowledgement is a separate state. No provider acceptance is
  claimed merely because the task was created.
- Agent-authored activity feed entries use concise route/depth/result labels;
  the full request and result remain available through the task record rather
  than being repeated verbatim in the pill activity stream.
- The existing web-room exchange cap, stop-all fence, and durable delivery
  state remain in place. No provider runtime, authentication, browser route,
  or live session was changed by this phase; tests/builds/live tasks remain
  deferred until the ordered pass is complete.

### Phase 6 — latency and readiness

Implementation boundary completed in this pass:

- Native owner turns now persist separate `queue_wait`, `runtime-acquire`,
  `provider-acceptance`, `first-visible-action`, and `completion` timing
  events. Existing cursor visibility and desktop-stage timings remain separate;
  the provider timing path does not pretend that a provider event proves a
  desktop mutation succeeded.
- Managed connections now expose a provider-local readiness check. The
  supervisor reuses a ready connection only when the adapter confirms its live
  transport binding: Claude checks its live stream, Codex checks its app-server
  process/session, and OpenCode checks its ACP runtime. Logical profile and
  generation checks remain in force, and no process IDs or credentials are
  exposed.
- Timing writes are best-effort postmortem evidence and never gate, replay,
  or fail a provider turn. No unconditional probe loop, guessed latency budget,
  browser route, authentication path, or live runtime was introduced.
- Budgets remain intentionally uncommitted until real traces are collected in
  the final verification pass; this phase records the evidence needed to set
  them from measured behavior rather than guesses.

### Phase 7 — provider capabilities and model selection

- Discover models from the provider connection, validate availability, persist the selected model, and apply it on the next turn/restart.
- Keep model selection separate from provider authentication and from browser-control routing.
- Add capability tests for Claude, Codex, and OpenCode before exposing a picker in the pill.

Implementation boundary completed in this pass:

- Added a pure provider-model contract and fail-closed validator. Model and
  effort IDs are accepted only when the live provider session reports them;
  no Claude, Codex, or OpenCode model names were hardcoded, and a provider
  that does not expose a catalog returns `null` rather than an invented list.
- Codex app-server capabilities are projected from its `model/list` response.
  OpenCode capabilities are projected from the ACP session's real `model`
  config options. Claude's native stream-json connection truthfully reports
  that it has no live catalog in this boundary, so a picker cannot claim
  unsupported choices are available.
- Added an owner-local, profile-bound model-selection store under
  `managed-provider-model-selections/`. Writes are atomic and owner-only;
  records contain only connection identity plus model/effort IDs. They do not
  contain credentials, provider session IDs, prompts, or browser state.
- Added an owner capability read and selection API. Valid selections are
  persisted and applied on the next turn for Codex/OpenCode when their live
  protocol exposes between-turn configuration. If a provider cannot apply it
  live, the durable choice remains a next-restart override; invalid or stale
  selections never block startup, authentication, or browser routing.
- No pill picker, provider-auth change, browser-control change, provider
  process discovery, or live provider task was introduced. Capability tests,
  builds, and integrated verification remain deferred to the final checkpoint
  after all ordered phases.

## Non-negotiable guardrails

1. No machine reset, profile cleanup, credential deletion, or broad process killing.
2. No replacement of the current browser-control implementation with the historical extension/CDP path without an explicit comparison and approval.
3. No automatic resend after provider failure or uncertain delivery.
4. No weakening of overlay/position confirmation merely to turn a red state green.
5. Every phase must leave a reproducible test or evidence artifact and report any pre-existing failure separately from changes made in that phase.

## Verification checkpoint after the recovery pass

- `npm run typecheck` — passed.
- Targeted provider/recovery suite (web live sessions, Codex app-server adapter, managed-provider adapters, web UI bridge, Windows app discovery, and resident supervisor) — **76/76 passed** with local socket access enabled for the extension-socket fixture.
- `npm run test:desktop-stage` — **66/85 passed, 19 failed**. The remaining failures are the pre-existing CUA fixture/contract mismatches listed in the Phase 4 gate above (coordinate-space expectations, typed-vs-generic driver calls, persistent-session expectations, and missing explicit background-delivery mode). No overlay or position check was weakened to make this suite appear green.
