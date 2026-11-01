# M9R Source of Truth 6.0 — Universal surfaces, fluid tasks, and multiplayer

Status: implementation contract for the provider-neutral desktop runtime.

This is the repository's canonical Source of Truth 6.0. A tracked file named
“Master List 2.1” was not present in this checkout, so this document is the
safe, reviewable equivalent rather than silently creating or overwriting an
unknown file outside the repository. Source of Truth 5.0 remains the release
and installation contract; this document defines the task, surface, action,
and multiplayer behavior built on top of it.

## Non-negotiable invariants

1. The accepted pill/frontend and the canonical runtime are protected. No live
   install, pill rebuild, overlay replacement, or recovery-folder promotion is
   part of this work package.
2. Provider-neutral means no provider-specific workflow is hard-coded into the
   product. Provider adapters may expose capabilities, but intent, surface,
   leases, task state, and verification are shared contracts.
3. A task, a user control message, and an agent-to-agent message are distinct
   records. A new user message may continue, clarify, pause, resume, redirect,
   cancel, or create a new task; it must not accidentally destroy unrelated
   work.
4. Semantic/UIA/CDP routes are preferred. Screenshot and physical input are
   bounded fallbacks. No route may silently retarget a different tab, window,
   or app, and no route bypasses site security or anti-bot controls.
5. Normal teammate conversation is not throttled by a small arbitrary message
   quota. Loop protection is progress- and state-based. Storage, payload, and
   retention bounds remain mandatory safety limits.
6. Windows has one global physical keyboard/focus device. Independent agents
   may work concurrently through semantic/background routes or separate
   regions. Operations that truly require the global device acquire only a
   short exclusive-input lease; they do not block unrelated work.
7. Every mutation has a fresh observation, an exact target identity, a bounded
   lease, a postcondition, and an auditable receipt. Stale observations fail
   closed and request re-observation/rebase.

## Implementation order

### 1. Protect the baseline and the release boundary

- Keep the accepted pill/frontend untouched while the contracts are changed.
- Keep Source of Truth 5.0's single canonical install, atomic candidate
  staging, manifest verification, and source/build/runtime boundary.
- Build inputs are allowlisted source only; worktrees, recovery evidence,
  diagnostics, and excluded directories are never promoted by filename.
- Do not perform a live install until the acceptance gate in section 14 is
  green.

### 2. One unified surface model

Represent browser instances, tabs, frames, web elements, native windows,
documents, and system surfaces through the existing `ComputerUseTarget` plus
the multiplayer surface adapter catalog. A surface binding carries a stable
surface identity, target revision, adapter capability, and owner correlation.
Browser work is pinned to the explicit instance/tab/frame; it never silently
changes the user's current tab. Native work binds the actual foreground window
or an explicitly named background window.

### 3. Agent seats and observable presence

Each participant has a run/branch/agent identity, a stable label/color, a
surface binding, an action stream, and a session-owned cursor/presence record.
The existing presence and target-identity registries remain the source of
truth. A cursor is presentation state, not permission; permission comes from
the route and lease contracts.

### 4. Durable task contexts and explicit controls

Create a task context keyed by `taskId` and `conversationId`, with plan
revision, participants, assignments, artifacts, observations, pending user
decisions, progress witness, and state. The state machine supports active,
paused-owner, waiting-user, waiting-agent, replanning, completed, and canceled.

Classify incoming user controls as continuation, clarification, pause, resume,
redirect, cancel, or new-task. Pause preserves work and observations; resume
continues the same task; redirect creates a new plan revision while retaining
completed work; cancel fences only the requested scope; a new task gets a new
context. Unaffected participants continue unless their surface or lease is
explicitly affected.

### 5. Natural team rooms with structured sidecars

Use the existing A2A router for delivery, deduplication, expiry, and recipient
validation. Add a task-local room and a structured sidecar for assignment,
handoff, blocker, evidence, and verification events. The visible conversation
may remain natural and concise; the sidecar carries machine-readable state so
agents do not need to repeat large dumps. The room closes when the task is
complete or canceled.

### 6. User-directed or dynamic work allocation

If the user assigns roles, preserve those assignments exactly. If the user
does not, agents may propose and claim work based on current capability,
surface access, and observed progress. Claims are revisioned and idempotent;
two agents cannot silently own the same mutation. Provider strengths are
learned per user/team/task and never hard-coded globally (Codex is not always
“backend” and Claude is not always “design”).

### 7. Progress-based loop protection

Every meaningful agent handoff or action records a progress witness: changed
artifact, completed operation, new observation revision, verified postcondition,
or a concrete blocker. Repeating the same state without a new witness enters a
waiting/clarification state instead of sending another identical message. A
bounded history and payload limit still protect memory and transport, but do
not replace progress detection.

### 8. Universal intent and target resolution

Use `resolveUniversalIntent` as a planning hint, not a hard-coded app workflow.
Resolve “this form”, “that tab”, “the open document”, “turn on dictation”, or
“open Spotify” from the live foreground/visible surface and current structure.
For app launch, try a direct route, then Start/Search discovery, then a bounded
taskbar fallback. For a browser, select the exact tab by stable identity before
observing. If the request is genuinely ambiguous, ask one short question.

### 9. Dynamic action ladder and routing

For each action choose the fastest safe route available:

1. Browser/CDP or page-semantic route.
2. Native UI Automation/accessibility route.
3. Window-targeted background route when the adapter guarantees it is safe.
4. Fresh structure observation after every meaningful page/control mutation.
5. Bounded window-local screenshot coordinates when structure is unavailable.
6. Foreground physical input only with an owner-approved exclusive-input lease.

The route returns its effect, escalation, verification, and retry disposition.
It never silently falls back to foreground input after a background refusal.

### 10. Foreground/background coexistence and leases

Choose `background-semantic`, `visible-semantic`, or `exclusive-input` per
action, not once per task. Background agents continue while another agent
needs foreground. Shared reads and disjoint semantic regions may proceed in
parallel. Only the narrow global keyboard/focus/pointer operation is serialized
by an exclusive lease. Lease conflicts produce a wait/reobserve result, not a
blanket “M9R blocked because another agent is using input.”

### 11. Observation, mutation, and verification receipts

Every action binds an exact target revision, dispatches at most once for that
operation ID, and records a receipt. A stale HWND/tab/frame/element, changed
virtual desktop, or changed page revision triggers refresh/rebase. Postconditions
are checked with a fresh observation. Receipts distinguish claimed, committed,
aborted, stale, conflicted, and expired work.

### 12. Browser and desktop inspiration, adapted to M9R

- **Vercel Agent Browser:** persistent daemon/session ownership, named tab
  binding, interactive refs, snapshots/deltas, batching, output limits, and
  screenshot-if-changed. M9R adopts the bounded observation/target ideas but
  keeps the user's browser and does not claim isolated sandbox DOM access.
- **Vercel Agent Desktop:** accessibility-tree-first observation, stable refs,
  observe-act-observe, JSON action envelopes, and ref actions that do not move
  the real pointer unless required. M9R maps this to UIA plus its existing
  screenshot fallback.
- **Cua Driver:** exact target binding, background-first route selection,
  explicit effect/escalation/verified results, session-owned cursors, and
  per-session target state. M9R adopts the contracts without replacing its
  broker or reintroducing an extension architecture.
- **A2A/MCP:** discoverable capabilities, task lifecycle, messages, artifacts,
  cancellation, and structured tool boundaries. M9R keeps provider processes
  directly managed by the broker and uses these ideas at the coordination
  layer.

### 13. Workflow and network learning

After the driver is stable, record only bounded local preference signals:
no-submit/no-advance habits, preferred observation route, successful action
patterns, provider strengths, and team handoff outcomes. Never store prompts,
page text, secrets, credentials, or screenshots in workflow memory. Learning is
asynchronous and must not add a full resolver chain to every action.

### 14. Verification and live-promotion gate

Before any live build or pill/app installation:

- all CUA driver tests pass, including the 15 owner-preview failures;
- multiplayer contract, A2A, coordinator, scheduler, target identity, surface,
  presence, and dispatch-fence tests pass;
- universal intent and workflow-memory tests pass;
- TypeScript typecheck passes;
- browser dropdown/table, exact-tab, stale-target, and screenshot-fallback
  fixtures pass;
- pause/resume/redirect preserves unaffected agents;
- semantic/background work can continue while a separate operation owns
  exclusive input;
- candidate/source/build/runtime manifests and accepted pill identity match;
- no live install or rebuild is performed from a worktree, recovery directory,
  or excluded artifact.

## References

- [Source of Truth 5.0](./M9R_SOURCE_OF_TRUTH_5.0_MAINTENANCE_CONTRACT.md)
- [Agent Browser](https://github.com/vercel-labs/agent-browser)
- [Agent Browser session management](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/core/references/session-management.md)
- [Agent Desktop](https://github.com/vercel-labs/agent-desktop)
- [Cua Driver concepts](https://github.com/trycua/cua/blob/main/docs/content/docs/cua-driver/concepts/how-cua-driver-works.mdx)
- [Cua Driver contract](https://github.com/trycua/cua/blob/main/libs/cua-driver/contract/README.md)
- [A2A specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
- [MCP architecture](https://github.com/modelcontextprotocol/docs/blob/main/docs/concepts/architecture.mdx)

