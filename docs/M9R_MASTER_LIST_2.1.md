# M9R Master List 2.1 — Condensed Execution Plan

Status: condensed successor to the reconciled 2026-10-19 Master List 2.1 view.

This document condenses the original 23-item list into seven execution lanes.
Nothing is removed: the coverage map at the end maps every original item to a
lane. The cumulative tracker remains the evidence record, and a source test,
build, or isolated package check never closes a live, installed, provider, or
production gate by itself.

## Status vocabulary

- **Verified source/package** — implementation and recorded regression,
  typecheck, build, or package evidence passed.
- **Implemented; live/release open** — source evidence exists, but installed,
  provider, production, or owner-visible proof is still missing.
- **Design/incomplete** — direction is recorded, but implementation or proof
  is incomplete.
- **Held/excluded** — intentionally not staged, deleted, activated, or changed
  in this pass.

## Current approved fix order — source of truth

This is the active implementation order for the current reliability and demo
pass. It supersedes the open-work ordering below without deleting its history.
Strike a bullet only after the source change and its focused regression
evidence are complete. Live/provider evidence is recorded at the integrated
gate; it is never implied by a source-only check.

1. **Shared CUA runtime contract and native-stage boot**
   - ~~Normalize named/default module exports before use.~~ The loader now
     flattens the supported package/bundled namespaces and uses the normalized
     surface for both runtime paths.
   - ~~Validate required constructors, action enums, and methods at runtime.~~
     Missing core Cua constructors, action enums, or methods fail immediately
     with an actionable contract error; optional cursor-motion exports are
     feature-detected and never gate stage boot.
   - ~~Keep cursor-motion configuration optional to presentation and impossible
     to make stage boot fail before observation or focus.~~ Motion setup is now
     best-effort; logical cursor enablement and desktop-stage boot remain
     authoritative and still verify the live session state.
   - Add a packaged-runtime smoke check for the same loader path. The installed
     package probe passes, but the clean activated runtime gate is still open.
2. **Provider-neutral runtime boundary**
   - Keep one stable M9R host boundary behind every provider adapter.
   - ~~Reconnect to the current runtime automatically after provider or M9R
     updates without replacing the existing CLI/MCP path.~~ Source compatibility
     and private one-session recovery are covered; installed/runtime proof is
     still required at the integrated gate.
   - ~~Make update, restart, and reconnect behavior provider-neutral.~~ The
     compatibility boundary accepts generic provider identities and preserves
     last-known-good state until verified refresh/reconnect.
3. **Provider delivery and lifecycle**
   - Deliver owner-authorized work automatically to the active provider
     session; do not require inbox polling or a manual approval echo.
   - Wake/rebind active sessions, accept a newly opened session automatically,
     reconcile stale claims, and prevent replay or duplicate delivery.
   - Make the M9R-managed, subscription-authenticated provider worker the
     default delivery path; attaching to an already-open provider session is
     optional and must not be required for managed delivery.
   - Give one existing local M9R owner responsibility for each managed worker
     profile across startup, provider updates, M9R updates, restart, and reboot;
     resolve the current provider CLI at reconciliation time instead of relying
     on stale version-specific M9R hook/runtime paths.
   - Report worker process health, provider-session binding, and successful task
     delivery as distinct evidence. A healthy process or binding alone is not
     delivery proof.
4. **Logical identity and authorization boundaries**
   - ~~Give each provider a stable public identity (Codex, Claude, OpenCode,
     and any future provider) independent of model or session ID.~~ Public
     identity and cursor-label normalization are provider/model neutral.
   - ~~Keep tokens, session IDs, process IDs, and task plumbing private.~~ The
     public identity result and cursor setup omit private session/process data;
     continuation credentials remain local-only.
   - ~~Treat a direct owner task as ordinary-action authorization; reserve extra
     approval for genuinely consequential actions.~~ Source authorization and
     stage-contract wording now distinguish direct owner work from
     agent-originated approval; installed/live proof remains part of the
     integrated gate.
5. **Whole-screen observation, focus, and open-world control**
   - ~~Build a generic desktop snapshot covering visible windows, taskbar/shell,
     foreground/attention state, and bounded per-window structure.~~ The native
     Windows UIA host now returns a bounded, handle-free whole-desktop control
     tree with virtual-screen coordinates; the existing Cua capture and
     per-window trees remain part of the same observation.
   - ~~Use structure first, same-capture visual fallback second, with no app or
     provider allowlist.~~ The stage maps native UIA rectangles into the exact
     desktop capture and keeps the capture as the bounded fallback without an
     app or provider allowlist.
   - ~~Resolve focus, occlusion, minimized/hidden/moved/closed windows, and
     taskbar recovery generically without moving the owner's physical pointer.~~
     Owner-preview now re-presents the exact verified live window when it moves
     to another virtual desktop, preserves the app/coordination identity, and
     keeps relaunch recovery limited to a genuinely gone window. Focus,
     occlusion, taskbar, and installed-runtime proof remain integrated gates.
6. **Canonical action and route execution**
   - ~~Normalize every action into one structured schema before dispatch.~~
     The MCP boundary now accepts a provider-stringified action wire value,
     parses it once, and sends only the canonical object to the existing
     validator/route; malformed values still fail closed.
   - ~~Remove stale browser-extension calls and dead route fallbacks from the
     active provider-facing path.~~ Native launch, managed-session, and
     shared-task prompts now advertise only the native desktop/UIA route; the
     disabled legacy implementation remains unregistered and is retained only
     for explicit historical fixtures.
   - ~~Keep clicks, typing, keys, menus, clipboard, scrolling, dragging,
     resizing, window controls, cancellation, and postcondition verification
     universal.~~ The canonical provider-neutral action contract now exposes
     the native window-state capability (minimize, maximize, restore) and
     dispatches it through the existing shared stage route; focused contract,
     MCP, and desktop-stage coverage passes. Installed/live action-family
     proof remains part of the integrated gate.
   - ~~Reduce model/tool round trips by returning structured results while
     retaining host-side authorization and evidence.~~ Native computer-use
     results now use MCP `structuredContent` plus the legacy text envelope;
     screenshots remain bounded/redacted and host-side authorization/evidence
     stays unchanged.
7. **Instant cursor, identity presentation, and latency**
   - ~~Publish the logical cursor before the first model desktop action.~~ Task
     creation primes it before stage preparation or desktop input.
   - ~~Keep public labels without session IDs/tokens.~~ Labels are stable
     provider names; private session IDs/tokens remain out of the public result.
   - Keep permanent selectable provider colors; the current fixed-color mapping
     is source-tested, but owner selection/persistence UI proof remains open.
     Motion remains presentation-only and never drives the owner pointer.
   - Preserve cursor visibility through reconnects and expose phase timings for
     latency work.
8. **Recovery, stale-state retirement, and release hygiene**
   - Reconcile stale claims, sessions, tasks, runtime generations, and held
     artifacts without deleting unknown user work.
   - Produce and activate one clean fingerprinted runtime with rollback and
     automatic update convergence.
   - Resume recoverable work after restart without requiring a fresh provider
     session.
9. **Integrated verification and demo gate**
   - Run source, typecheck, lint, audit, packaging, and installed-runtime
     verification after the implementation lanes are closed.
   - Run one difficult single-agent dry run and one coordinated multiplayer
     dry run, then close only the bullets their evidence actually supports.
   - Use the resulting evidence for the open-world live matrix and demo.

### Source evidence recorded for the current fix pass — 2026-10-21

### 2026-10-21 — SessionStart stage-contract parity

The trusted hook delivery path now carries the same native desktop-stage
contract when it injects the first owner-authorized task at `SessionStart` as
it does for ordinary provider prompts. This prevents a task from arriving
without the M9R-only observation/action instructions that keep desktop work
on the shared UIA/desktop route. The notice uses the existing exact-session
identity and task-frontier checks, so pending approvals remain blocked and no
task/session credential is exposed. OpenCode is intentionally excluded from
this pre-delivery notice because its resident poller owns its live prompt
transport; it receives the notice only with the task it actually claims.

Verification:

- focused task-stage-notice suite: **6/6 passed**;
- native store/hook regression suite: **58/58 passed**;
- `npm run typecheck`: passed;
- `git diff --check`: passed with existing LF/CRLF normalization notices only.

This closes the source gap for SessionStart stage-contract parity. It does
not claim installed-runtime, provider-owned unsolicited push, focus, action,
or integrated live/dry-run acceptance.

### 2026-10-21 — fresh-session stage-contract bootstrap

The same trusted `SessionStart` path now bootstraps the exact new provider
session's private identity before preparing its first task-stage notice. A
brand-new session therefore cannot receive an owner task without the native
M9R desktop observation/action contract, while a session explicitly revoked
in local state remains fail-closed. The bootstrap is exact-session only; it is
not provider discovery, token delivery, or a fresh-session requirement for
ordinary reconnects.

Verification:

- focused task-stage-notice suite: **7/7 passed**;
- combined native store/hook and resident hook-server suites: **61/61 passed**;
- `npm run typecheck`: passed;
- `git diff --check`: passed with existing LF/CRLF normalization notices only.

This closes the fresh-session stage-notice source gap. Installed-runtime,
provider-owned unsolicited push, focus/action behavior, and integrated
live/dry-run acceptance remain open.

### 2026-10-21 — OpenCode claimed-prompt stage-contract parity

The resident OpenCode poller now adds the same native desktop-stage contract
to the exact task envelope only after its atomic claim succeeds. This keeps
OpenCode's resident transport aligned with the ordinary prompt and
`SessionStart` paths without staging an unclaimed task, changing the CLI/MCP
transport, or exposing a private session credential. Malformed or empty poll
envelopes are left unchanged.

Verification:

- focused task-stage/native hook integration: **12/12 passed**;
- generated OpenCode plugin suite: **21/21 passed**;
- native store/hook regression suite: **58/58 passed**;
- `npm run typecheck`: passed;
- `git diff --check`: passed with existing LF/CRLF normalization notices only.

This closes the OpenCode claimed-prompt stage-contract source gap. Installed
runtime behavior, provider-owned unsolicited push, focus/action behavior, and
integrated live/dry-run acceptance remain open.

### 2026-10-21 — direct owner-task authorization contract

The owner-task authorization boundary is now explicit in both the stage broker
error and the MCP tool description: a task typed directly by the owner is
`not_needed` for agent approval, while agent-originated work still requires
approval or an applicable standing rule. The stage service continues to reject
pending, denied, expired, completed, and unrelated-session tasks. This removes
the misleading “approved-only” wording that could make a provider ask for an
approval echo that the owner task never needed.

Verification:

- task desktop-stage suite: **46/46 passed**;
- direct owner task asserted as `not_needed` before preparation;
- pending and finished task rejection regression passed;
- `npm run typecheck`: passed;
- `git diff --check`: passed with existing LF/CRLF normalization notices only.

This closes the source authorization-contract gap. Installed runtime behavior,
provider-owned delivery, and integrated live/dry-run acceptance remain open.

### 2026-10-21 — active provider prompt stale-route removal

The active managed-session and shared-task prompts no longer advertise the
retired browser-extension/shared-tab tools. They now direct browser and app
actions through the same native `m9r_stage_app` plus structured
`m9r_computer_observe`/`m9r_computer_action` surface, with same-capture
fallback and fresh verification. The disabled legacy implementation and
skipped historical fixtures were not deleted.

Verification:

- targeted web-live prompt tests: **3/3 passed**;
- `npm run typecheck`: passed;
- `git diff --check`: passed (existing line-ending notices only).

This is source verification only; installed tools/list, provider sessions,
live open-world action, and runtime activation remain open.

- **Closed at source:** provider binding waits are now asynchronous. The MCP
  server preserves the same bounded, fail-closed reconnect behavior without
  blocking Node's event loop with `Atomics.wait`; the delayed-binding
  regression proves unrelated timers continue to run during the wait. The
  provider-update recovery window is seven days for one unambiguous,
  non-revoked provider/session/project record, while the short claim-publication
  TTL remains unchanged.
- **Closed at source:** the generated OpenCode integration retries session
  discovery after provider startup/API readiness races and re-runs the
  idempotent identity hook before polling. The focused generated-plugin suite is
  **21/21** for the current file, including the new retry regression.
- **Closed at source:** the shared computer-use MCP boundary accepts the flat
  JSON-string action shape emitted by a provider bridge and normalizes it before
  canonical validation. The isolated stringified-action regression passes.

- **Closed at source:** the Cua loader now accepts the supported named/default
  package shapes, validates the core runtime contract, and treats motion style
  and timing exports as optional presentation features. Focused evidence is
  **175/175** desktop/action/stage tests, including missing-motion and motion-
  failure boot regressions.
- **Closed at source:** task creation now emits a non-blocking logical-cursor
  prime through the owner-pipe, hook, and web-broker delivery seams before
  stage preparation or desktop input. The cursor is visual-only and does not
  move or capture the owner's physical pointer. The installed/owner-visible
  proof remains part of the integrated gate.
- **Closed at source:** the provider-update compatibility boundary is generic:
  it preserves the existing CLI/MCP route, detects provider identity/version
  changes, keeps last-known-good state until refresh/reconnect is verified, and
  can privately recover exactly one recent provider session after an update.
  Ambiguous and revoked sessions fail closed. Provider/OpenCode compatibility
  evidence is **59/59**; installed and live-provider proof remain open.
- **Closed at source:** desktop structured observation now uses one bounded
-  desktop capture plus visible-window accessibility trees, with opaque local
  references and same-capture fallback geometry. The route is open-world and
  provider-neutral; it does not use an app allowlist. The native Windows host
  now adds a bounded control-view UIA snapshot rooted at the virtual desktop,
  including shell/taskbar elements without exposing HWNDs or PIDs; native
  rectangles are mapped into that same capture, with visual fallback retained
  when UIA is unavailable. Owner-preview now also verifies and re-presents the
  exact live window after a virtual-desktop move without relaunching it or
  moving the owner's physical pointer. Focus/occlusion and installed proof
  remain separate gates.
- **Closed at source:** public identity output no longer exposes session IDs.
  Cursor labels remain provider names, while private session IDs, process IDs,
  and continuation claims stay inside the local runtime. Identity/color and
  native setup evidence is **48/48**.
- **Research boundary recorded:** Cloudflare Code Mode demonstrates the useful
  local design principle of composing tool calls behind a compact structured
  result; it does not remove host authorization or native side effects. M9R
  keeps that principle local and adds no cloud API or browser-extension route.

- **Closed at source:** the canonical action layer now exposes minimize,
  maximize, and restore as one `window_state` contract. The native stage
  already owned those operations; the missing provider-neutral schema and
  dispatch mapping were added without changing the existing CLI/MCP transport.
  Focused canonical contract/MCP coverage is **62/62**, and repository
  typecheck passes. Installed/live window-control effects remain open.
- **Closed for the current provider-session recovery slice:** an owner-typed
  task addressed to a known provider with a temporarily missing identity is now
  retained as deferred work instead of being terminally failed. The next
  trusted OpenCode poll re-registers the exact session, recovers its private
  identity when the one-session recovery predicate is satisfied, and atomically
  claims the task without a fresh session or manual identity command. This is
  source evidence for the provider-continuity boundary, not universal live
  provider acceptance; ambiguous, revoked, failed, queued, and uncertain work
  remain fail-closed.
- **Closed for the resident feed retry boundary:** the production native feed
  now passes the existing provider-neutral delivery scheduler, with the
  already-supported Codex queue transport supplied as its default adapter and
  future transports injectable without changing scheduling or fencing logic.
  Deferred owner work is retried on the feed cadence; uncertain, queued,
  failed, stale, and duplicate work is not replayed. The native command suite
  is **42/42** with the new adapter-pump regression, and repository typecheck
  passes. This is source evidence for automatic retry, not universal
  unsolicited delivery to provider-owned sessions.

### 2026-10-21 — trusted session-start delivery fallback

The common provider hook now uses the trusted `SessionStart` boundary to claim
and inject at most one owner-authorized task for the exact reconnecting session
when that provider has a hook-based delivery path. The injected text contains
the task body but no task ID, session ID, token, or inbox command. OpenCode
continues to use its resident session poller so two delivery mechanisms cannot
race. Pending, denied, expired, ambiguous, revoked, queued, uncertain, and
already-delivered work remains fenced closed.

The broker-prompt detector was updated with the same provider-neutral wording
as the current native desktop prompt, so the active route remains protected
against treating M9R-generated teammate mentions as owner commands. The
previous wording remains recognized for retained historical prompts.

Verification:

- native store/hook suite: **57/57 passed** with a workspace-local Windows temp
  root, including the reconnect auto-delivery and no-replay regressions;
- `npm run typecheck`: passed;
- `git diff --check`: passed (existing line-ending notices only).

This is source verification only. It does not claim unsolicited push into an
arbitrary already-running provider-owned session, installed-runtime behavior,
provider restart/rebind, or integrated live/dry-run acceptance.

### 2026-10-21 — terminal delivery-failure replay fence

The ordinary provider-prompt inbox path now treats a terminal `failed`
delivery as closed work. It is neither rendered nor reclaimed on a later
prompt, so a failed item cannot block or replay ahead of a fresh
owner-authorized item. In-flight `sending`/`uncertain` work remains fenced for
reconciliation, while intentional `deferred` work remains eligible for its
next trusted provider boundary.

Verification:

- native store/hook suite: **58/58 passed** with a workspace-local Windows temp
  root, including the failed-delivery replay regression;
- `npm run typecheck`: passed after this narrowly scoped inbox change;
- `git diff --check`: passed (existing line-ending notices only).

This is source verification only; installed/runtime and integrated provider
proof remain open.

### 2026-10-21 — terminal lifecycle work excluded from identity repair

The provider identity-repair query now excludes tasks whose delivery or
lifecycle state is terminally `failed` or `completed`. Those records remain
durable history, but they can no longer block a known provider session from
repairing its current identity or make stale failed work look pending. The
existing `sending`/`uncertain` reconciliation barrier and intentional
`deferred` eligibility are unchanged.

Verification:

- native store/hook suite: **58/58 passed** with a workspace-local Windows
  temp root, including the terminal-failure identity-repair regression;
- `npm run typecheck`: passed after this change;
- `git diff --check`: passed with existing line-ending notices only.

This is source verification only; installed/runtime and integrated provider
proof remain open.

### 2026-10-21 — structured computer-use result boundary

The native `m9r_computer_observe` and `m9r_computer_action` tools now expose
the same privacy-filtered result in MCP `structuredContent` as well as the
legacy JSON text block. Modern provider bridges can consume targets,
observations, receipts, postconditions, and telemetry without making the
model parse a text envelope or request a redundant follow-up. The compatibility
text path remains in place for older bridges, and screenshot data URLs remain
redacted from both structured and text results while bounded image blocks stay
available through the existing response budget.

Verification:

- computer-use contract and MCP suite: **62/62 passed**;
- `npm run typecheck`: passed after the structured-result change;
- `git diff --check`: passed with existing line-ending notices only.

This closes the source-side result-shaping slice only. It does not claim that
every provider bridge consumes `structuredContent`, nor does it close installed
runtime, provider restart/rebind, focus, action, or integrated live/dry-run
acceptance.

The telemetry attachment was then made symmetric across both MCP result forms;
the structured result now carries the same validated phase timings and
replay-receipt flag as the compatibility text result.

Verification after that correction: the same **62/62** computer-use suite,
`npm run typecheck`, and `git diff --check` all passed. This remains source
verification only.

### Still open after this source pass

- A clean packaged-runtime smoke/activation proof is still required; no
  installer, runtime activation, or provider restart was performed in this
  pass.
- Unsolicited delivery to an arbitrary provider-owned session cannot be claimed
  universal from a local MCP server alone. Each provider must expose a resident
  input/hook channel, or M9R must own a managed live session; source hooks and
  OpenCode polling are not proof that Claude or every future provider can be
  pushed a turn without a provider prompt.
- Installed native shell/taskbar execution, focus/occlusion recovery,
  arbitrary-provider acceptance, open-world dry runs, multiplayer ownership,
  and the final single-agent/multiplayer demo gate remain unclosed.

## Preservation and release boundary

- Recoverable checkpoint: Git ref
  `refs/m9r/checkpoints/pre-master-2.1-20261019`, object
  `b6134fae25379551c564d2000009e3c24dac4946`. It covers the tracked dirty
  worktree without changing it. Untracked files and artifacts remain in place.
- The checkout is dirty by design and must not be represented as a clean
  release until an allowlisted commit and clean rebuild exist.
- Automatic artifact draining is deferred. No broad deletion, process killing,
  runtime restart, provider reconnect, or database change is implied here.
- Retained/excluded until separately reviewed: activation evidence, recovery
  quarantine history, `engine/` runtime outputs and backups, `scratchpad/`
  including its local secret, the user document, and unverified icon/reference
  assets.
- Recorded verification at the current release boundary: 2,646/2,646
  repository tests, 118/118 desktop-stage tests, focused provider/action and
  cross-worker lease regressions, typecheck, production build with 138 pages,
  CLI build, full lint exit 0 with 245 existing warnings, and
  `git diff --check`. Production dependencies report 0 vulnerabilities. The
  prior dirty-worktree public-surface scan was blocked by the retained
  recovery quarantine; no broad deletion or release-boundary hiding was
  applied.

Follow-up verification on 2026-10-21 closed the two previously reported
pre-live boundary failures without activating a runtime or touching held
evidence: the native installer fixture passed **13/13**, and the public-surface
scan now passes while explicitly excluding the untracked recovery quarantine
from the release candidate. The quarantine remains held and would fail closed
if tracked or staged. The worktree is still dirty and is not a release.

## Condensed execution lanes

### Lane 1 — Foundation: provider continuity, runtime, task lifecycle, and multiplayer architecture

Includes original items 1, 2, 3, 4, 5, 9, and 22.

Current conclusion:

- OpenCode stale-model migration, provider-scoped selection, no-replay guards,
  and asynchronous provider-failure terminalization are source/package
  verified.
- Provider claim reconciliation, PID precedence, worker identity propagation,
  stable shims, and installed reconnect coverage are source/package verified.
- Runtime build identity, managed convergence, graceful-drain boundaries,
  watchdog ownership, generation checks, rollback retention, and cleanup tests
  are verified.
- Task claiming, explicit lifecycle states, age-bounded reconciliation,
  provider scoping, async failure finalization, result fencing, idempotency,
  and identity gates are verified.
- Local heartbeat, provider-neutral relay/mention routing, liveness freshness,
  idempotency, provenance, and queue/dead-letter bounds are verified.
- Provider-update compatibility now has a provider-neutral refresh boundary:
  configured adapters run only after the stable M9R route is verified, and a
  first provider observation cannot be recorded healthy until initialization
  and reconnect succeed. The OpenCode adapter migrates only M9R-owned schema
  drift (`plugin` to `plugins` and `mcp.m9r` to `mcp.servers.m9r`) while
  preserving unrelated user entries and credentials. Focused regression
  evidence is 50/50 plus a clean typecheck and CLI build.
- OpenCode session lifecycle continuity now rebinds identity and wakes the
  existing delivery poller on `session.created` and `session.compacted`, while
  `session.deleted` retires the poller and terminalizes an active task instead
  of leaving it stale. The compaction path repeats the trusted SessionStart
  hook so the native store can reuse the existing claim rather than minting a
  competing one. The generated-plugin regression is 20/20; installed and
  live-provider proof remain open.
- Local sessions, takeover, joint windows, recovery anchors, replay, wallets,
  and federation boundaries are documented as product architecture. They are
  intentionally moved up here as foundational multiplayer work, not left as a
  late roadmap detail.

### 2026-10-24 — M9R-owned provider lifecycle and workspace-routing decision (design; not implemented)

This is the architecture decision made tonight. It records the target
direction only; it is not an implementation claim, package claim, installed
runtime claim, or provider/live acceptance claim.

#### Decision

M9R is moving from the current provider-owned STDIO model to an M9R-owned
provider-process lifecycle for the managed path.

The superseded model is:

1. Claude, Codex, or OpenCode starts its own M9R STDIO/MCP process.
2. M9R receives provider/session/process observations from that external
   process.
3. M9R attempts to discover or reconcile which provider session a task belongs
   to.
4. A task can be deferred, rejected, or delivered through a provider-specific
   hook, poller, or session-reconciliation path.

The target managed model is:

1. M9R starts the Claude, Codex, or OpenCode CLI/process using the user's
   existing provider login/subscription path; an API key is not introduced by
   this decision.
2. One M9R owner supervisor owns the lifecycle of the managed provider
   connections.
3. Each managed connection is keyed by an agent handle and a project folder.
   Its internal record contains the provider, logical connection ID, working
   folder, process/worker state, private provider resume reference, M9R
   generation, and task state.
4. M9R sends the task directly to the managed connection. The normal path does
   not poll an inbox and does not guess which externally running session won.
5. Provider-specific transport differences remain isolated inside adapters;
   the pill, task router, authorization boundary, desktop action contract,
   cursors, receipts, memory, and multiplayer coordination remain universal.

The existing managed lifecycle in
`src/lib/native/web-live-sessions.ts` is the source pattern for this design:
M9R owns the long-lived provider process, keeps the provider continuation
metadata private, and routes work through an M9R-owned connection rather than
searching arbitrary provider sessions. The lifecycle must be extracted into a
shared owner-runtime service before the browser/in-page UI is retired.

#### Workspace and folder identity

The default user experience is one owner-selected workspace folder. When the
owner selects a folder for the current M9R workspace, that folder is applied
to all participating agents by default:

```text
Owner-selected workspace folder
  ├─ Claude connection in that folder
  ├─ Codex connection in that folder
  └─ OpenCode connection in that folder
```

The architecture also supports explicit per-agent folder bindings without
changing the default. For example, an owner may later choose Claude in
Project A, Codex in Project B, and OpenCode in Project A. That is an optional
multi-project capability, not a requirement for the first demo.

The resulting connection model is therefore:

```text
One M9R owner supervisor
  ├─ provider handle + selected folder → one managed connection/process
  ├─ provider handle + another folder  → a separate managed connection/process
  └─ provider handle + same folder     → reuse the existing connection unless
                                          the owner explicitly requests another
                                          logical connection
```

The selected `cwd` is the primary routing signal. `cwd` is already part of
the identity key in `src/lib/native/provider-session-reconciliation.ts:151`;
this decision makes it load-bearing and user-selected instead of treating it
as a late tiebreaker after PID guessing.

For an externally opened compatibility session, M9R may use the explicitly
selected provider and folder to identify the session. If more than one
candidate still matches, M9R must refuse to guess and require an explicit
connection selection. A PID may validate ownership or provide diagnostics,
but it is not the product routing identity.

The future project-agnostic/ambient mode remains deferred. It may support a
provider process that is not tied to a project folder, but it complements the
folder-based model and does not replace it for coding work.

#### One supervisor and three provider connections

“One M9R owner supervisor” does not mean one shared provider process. It means
one M9R-owned lifecycle/controller with isolated provider connection slots.
Each slot has its own process, transport, folder, resume metadata, health,
generation, task stream, and failure state. A Claude failure must not silently
rebind Codex or OpenCode, and a provider must never receive another provider's
task.

The shared supervisor exposes one provider-neutral contract:

- start and readiness;
- send/prompt;
- cancel;
- pause and resume;
- status and health;
- streamed events and receipts;
- graceful drain and stop;
- reconnect after a controlled update or restart.

The provider adapter is the only layer that knows whether the underlying
transport is Claude's stream process, Codex's worker/resume interface, or
OpenCode's ACP interface. These are transport differences, not three
different M9R products or three different desktop-action systems.

The provider's private resume/session reference remains available for
continuation after interruption. It is not displayed as the agent identity,
not used as an arbitrary routing key, and not coupled to the future M9R
memory/network identity. M9R memory and relationship state can therefore
survive a provider process restart or provider change.

#### Superseded identity bullets

The existing Lane 1 bullets mentioning provider claim reconciliation, PID
precedence, worker identity propagation, and stable provider-owned shims
describe the old provider-owned STDIO model and its compatibility boundary.
They are historical/source evidence and must be read as superseded target
architecture, not as the current intended managed-path design.

They are not struck through by this entry because the new lifecycle has not
yet been implemented or verified. Once the shared owner-runtime implementation
and its focused regression evidence are complete, the affected implementation
bullets may be updated or struck according to the normal tracker rules. The
remaining integrated provider and desktop acceptance evidence is tracked
separately and is not required to keep a completed source implementation
bullet artificially open.

#### Detailed implementation order

1. ~~**Freeze and baseline the boundary.**~~ Record the current source diff,
   installed runtime identity, provider configuration, and active process
   ownership. Classify site changes, provider changes, runtime changes, and
   scratch artifacts. Do not delete sessions, user files, historical evidence,
   or unknown packages as part of this architecture change.
2. ~~**Define the shared connection contract.**~~ Add the owner-runtime interface
   for start, readiness, send, cancellation, pause/resume, status, event
   streaming, drain, stop, and provider continuation metadata. The contract
   must carry provider, logical connection ID, selected `cwd`, task ID, and
   runtime generation without exposing private credentials or process IDs.
3. ~~**Extract the proven lifecycle.**~~ Move the generic lifecycle/state-machine
   behavior out of `createWebLiveSessions` in
   `src/lib/native/web-live-sessions.ts` into one shared managed-provider
   runtime module. Keep the web workspace as a compatibility facade over that
   module so the extraction does not change its behavior first.
4. ~~**Keep transport adapters at the edge.**~~ Reuse the existing Claude process
   path, Codex worker/resume path, and OpenCode ACP path from
   `src/lib/native/web-opencode-acp.ts`. Each adapter implements the shared
   contract; no provider-specific branch is added to the pill, CUA action
   schema, memory layer, or task authorization layer.
5. ~~**Add deterministic connection selection.**~~ Use the owner-selected
   workspace folder for all participating agents by default. Permit explicit
   per-agent folder overrides for multi-project work. Make exact provider plus
   `cwd` the compatibility selector, use explicit connection IDs when needed,
   and remove PID-first guessing from the managed route.
6. ~~**Connect the desktop pill to the owner broker.**~~ The pill communicates
   with the existing local owner broker and shared runtime. It does not start
   a second provider supervisor, route through the browser page, scan provider
   sessions, or require an inbox check. The web/in-page surface remains in
   place until the desktop pill reaches equivalent behavior.
7. ~~**Unify delivery and receipts.** Normal owner work enters the owner broker
   and is delivered to the selected managed connection. Record accepted,
   dispatched, provider-received, started, completed, canceled, failed, and
   retryable states distinctly. No uncertain delivery may disappear or become
   invisible to a later inbox read.~~
8. ~~**Preserve universal desktop behavior.** Keep the existing provider-neutral
   observation/action contract, cursor priming, focus recovery, pointer
   isolation, clipboard, window controls, cancellation, and postcondition
   verification. Prime the active cursor roster before the first desktop
   action, while allowing independent provider connections to work in parallel
   when their actions do not contend for the foreground lease.~~
9. ~~**Implement controlled update and recovery.**~~ Drain the owner supervisor,
   finish or bound active work, replace the stable package, start the new
   generation, and restore connections from logical connection configuration
   plus private continuation metadata. Do not kill processes by provider name,
   let providers discover arbitrary old binaries, or treat a healthy binary
   path as proof that a provider is connected.
10. **Build and package one exact revision.** Run focused tests, typecheck,
    CLI/build checks, package-manifest checks, and installed-runtime checks from
    the exact source revision being activated. A dirty source/package mismatch
    is not a release boundary.
11. **Run grouped integrated acceptance.** Do not create one live task per
    tracker bullet. Use the smallest grouped set that covers the matrix: one
    concise provider receipt/action run for each provider where individual
    behavior must be distinguished, followed by one coordinated multiplayer
    run covering shared delivery, cursors, focus, universal actions, receipts,
    recovery, and visible results. The evidence closes only the behaviors it
    actually demonstrates.
12. **Retire the browser/in-page surface last.** After the desktop pill and
    owner broker no longer depend on browser-only UI, remove the web surface,
    routes, and unused fixtures through a reference/provenance review. Keep
    the shared owner supervisor and local broker; removing the UI must not
    remove the managed provider lifecycle.

#### Latency impact

The design removes avoidable latency from inbox polling, session discovery,
PID reconciliation, repeated process startup, browser round trips, and
duplicate broker layers. The owner supervisor keeps connection state in memory,
reuses warm provider processes, streams events directly to the pill, and can
dispatch independent provider work concurrently. The provider's own model
reasoning, ACP/stream startup, and real desktop input remain genuine latency
sources and are not hidden by the architecture.

M9R should measure task acceptance, first cursor visibility, provider receipt,
first desktop action, tool completion, and final result separately. A single
“healthy” or “connected” status must not be used as a substitute for those
phase timings. Structured MCP results remain the preferred result path so a
provider does not need an extra turn to parse an intermediate text envelope.

Cloudflare Code Mode remains a later optimization for composing tool work
behind compact structured results. It is not required for the owner-supervisor
architecture and does not replace host authorization or native Windows
actions.

#### Runtime simplification and cleanup invariant

The installed system may contain multiple executable roles, but it must have
one current stable package/version for each role. A staged executable is
temporary update state, never a second provider runtime. Providers must be
configured with the stable path and must never search a runtime directory for
an executable to launch.

The update is not complete merely because the new executable starts. The
update transaction must also prove that the old process has drained, that no
provider connection references the retired generation, and that staged and
retired files have been removed. If Windows or another process prevents
cleanup, the update remains explicitly incomplete/failed and the old artifact
is quarantined from launch; the system must not silently report a clean update
while leaving an eligible stale path behind.

Rollback metadata, if retained for a bounded transaction, is not a provider
launch target and is not a second active runtime. It must be provenance-bound,
excluded from provider resolution, and removed when the transaction's cleanup
policy allows. Broad historical package, quarantine, or user-artifact deletion
is outside this decision and still requires separate provenance evidence.

#### Evidence and closure rule

Source implementation, focused regression evidence, package/installed evidence,
and integrated owner-visible acceptance are separate evidence classes. A source
fix is closed when the implementation and its focused regression/build/package
evidence are complete. The integrated acceptance gate is then run as grouped
dry runs and closes only the delivery, continuity, cursor, focus, action,
recovery, routing, and visible-postcondition behaviors actually observed.

This entry does not claim that the M9R-owned lifecycle has been implemented,
packaged, activated, or accepted. It records the target architecture and the
order in which it must be built and verified.

### 2026-10-24 — M9R-owned provider owner boundary wired (source implementation; package/live gates open)

The first implementation slice of the architecture above is now present in
source. This is not an installed-runtime or live-provider acceptance claim.

- `src/lib/native/managed-provider-owner.ts` is the broker-owned entry point.
  It creates one logical managed connection per configured agent handle and
  selected project folder, owns the connection lifecycle, and keeps provider
  resume references and M9R identity tokens private to that connection.
- `scripts/m9r-web-broker.ts` now attaches the pill/UI to that owner boundary.
  The broker and pill share the same owner; the managed path does not select a
  provider session by PID or poll a provider-wide session list.
- Claude, Codex, and OpenCode remain different only inside their transport
  adapters. The shared owner contract carries the provider-neutral task,
  selected `cwd`, logical connection ID, generation, cancellation, status,
  streaming events, continuation, and shutdown operations.
- Delivery receipts now require an explicit adapter `accepted` event (or a
  provider result that proves acceptance). A local `working` status alone is
  not treated as delivery proof. Timed-out owner tasks are fenced and are not
  replayed if a late provider startup callback arrives.
- The existing provider-owned STDIO/MCP reconciliation route remains as a
  compatibility path for externally launched sessions. It is not the managed
  owner route used by the broker wiring in this slice and is not deleted until
  the compatibility/package review is complete.

#### Source evidence for this slice

- Focused managed-provider, owner, adapter, supervisor, runtime, and web
  session tests: **54 passed, 0 failed**.
- TypeScript no-emit check: **passed**.
- ESLint on the changed owner/adapter/contract/broker/test files: **passed**.
- `npm run build:cli`: **passed**; the generated broker bundle contains the
  M9R-owned owner boundary and acceptance receipt path.
- `npm run build:engine`: **passed**; the engine and web-broker executables were
  generated, the runtime identity was verified across 185 files, and the
  temporary engine build directory was removed after publication.
- The engine build emitted `warning: The signature seems corrupted!` during
  SEA injection, although the command exited 0 and completed injection. No
  Authenticode/signing or installed-package verification has been claimed; the
  release boundary remains open until that warning is resolved or explicitly
  explained by the signing step.
- Repository-wide `npm run lint`: **passed with 0 errors and 57 warnings** after
  excluding generated scratch/proof/skill and extension-distribution paths from
  the flat config. The warnings are existing quality debt and are not blocking
  this source/package build slice.
- The engine build reports `sourceDirty: true`, and `engine/dist` still contains
  an older `m9r-engine-windows-x64.zip` dated 2026-10-23. That zip was not
  deleted or treated as the current package; it requires a separate provenance
  decision before cleanup.
- No installed runtime was replaced, no provider process was restarted, and no
  stale package/runtime/artifact was deleted in this implementation/package
  build pass.

#### Still open after this source slice

1. **Package boundary:** build/package the exact source revision and verify the
   installed runtime; this is the remaining Step 10 work.
2. **Runtime cleanup invariant:** reconcile the stable package path and staged
   update cleanup before activation. No old artifact may remain eligible for
   provider launch; no broad historical deletion is authorized by this entry.
3. **Grouped owner-visible acceptance:** run the integrated provider and
   desktop dry runs after packaging. Source tests do not close live delivery,
   cursor, focus, action, recovery, or reboot behavior.

#### Step 1 status — baseline recorded (2026-10-24)

Step 1 is complete as a read-only baseline. It does not close any provider,
runtime, desktop, or integrated acceptance gate.

- **Repository identity:** branch
  `codex/m9r-21-item-audit-close-20261017`; HEAD
  `143bc976f86613afbd889f9a632bf5a6610d5dc1`.
- **Worktree state:** dirty by design. Existing modified and untracked work
  spans the M9R tracker and cumulative tracker, native/runtime sources,
  `hook/src/main.rs`, provider delivery and reconciliation code, build and
  packaging scripts, focused tests, webhook/security code, reference/try UI,
  a Supabase migration, `.artifact-scratch/`, and held documentation/assets.
  `public/og-v2.png` is already staged as a deletion. No existing change was
  reset, staged, committed, or deleted by this baseline pass.
- **Diff hygiene:** `git diff --check` completed without whitespace errors;
  Git reported only existing LF/CRLF normalization warnings for several dirty
  files. No source tests, builds, package activation, or runtime restart were
  run as part of Step 1.
- **Installed build identity:** the stable M9R build info reports build ID
  `166bb5834a763febb25a83cb4fd7b8ee8eac57ac48a697aee5229ce5f57a2235`, source
  commit `143bc976f86613afbd889f9a632bf5a6610d5dc1`, and
  `sourceDirty: true`. The installed engine therefore is not a clean-source
  release boundary for the current worktree.
- **Stable binaries:** the active stable paths are under
  `C:\Users\kaina\.m9r\bin`. The baseline recorded the current hashes for
  `m9r-engine.exe`, `m9r-hook.exe`, `m9r-web-broker.exe`, and
  `m9r-overlay.exe`; no binary was replaced or activated.
- **Runtime artifacts:** the bin directory contains 27 entries, including the
  stable role binaries and two `m9r-engine.exe.m9r-retired-*` images. The M9R
  state root also contains 15 `runtime-backups` entries, one
  `rollback-snapshots` entry, and 13 `backups` entries. These are recorded as
  held artifacts only; none was deleted, drained, or made launchable.
- **Provider configuration routes:** OpenCode currently references the stable
  `m9r-engine.exe mcp` route with `M9R_PROVIDER=opencode`; Codex references the
  stable `m9r-hook.exe mcp` route with `M9R_PROVIDER=codex`; Claude's settings
  reference the stable `m9r-hook.exe` for its SessionStart,
  UserPromptSubmit, and Stop hook events. This difference is baseline evidence
  for the next architecture step, not a claim that any route is already
  corrected.
- **Active ownership:** read-only parent mapping found a resident
  `m9r-web-broker.exe`, multiple `m9r-engine.exe` instances, two Codex
  processes, two OpenCode processes, and multiple Claude processes. At least
  one Codex and two Claude hook chains currently lead to M9R engine descendants;
  OpenCode currently has direct M9R engine descendants. This confirms the
  existing mixed provider-owned/managed process topology that the new shared
  supervisor must replace in the managed path. No process was stopped or
  restarted.
- **Safety boundary:** no provider session, user document, runtime artifact,
  permission, credential, or unrelated dirty file was modified. Step 2 may now
  define the shared connection contract from this recorded baseline; that
  contract is recorded as source-complete below.

#### Step 2 status — shared connection contract defined (2026-10-24)

The provider-neutral contract is now implemented at source level in
`src/lib/native/managed-provider-contract.ts`, with focused coverage in
`scripts/managed-provider-contract.test.ts`. This closes the contract-definition
step only; it does not yet extract the web lifecycle, wire the pill, replace
the provider-owned STDIO route, package a runtime, or establish provider/live
acceptance.

- **Connection profile:** normalizes the concrete agent handle, provider name,
  and absolute project `cwd`; rejects broadcast/ambiguous handles, invalid
  providers, relative folders, and filesystem roots. Equivalent Windows path
  spellings resolve to the same normalized profile and default logical
  connection ID.
- **Workspace routing:** the profile carries one selected folder by default,
  which the future owner supervisor can apply to every participating agent.
  An explicit logical connection ID remains available for a deliberate
  per-agent/multi-project slot without making per-agent folders mandatory for
  the demo.
- **Task envelope:** carries only the provider-neutral routing fields required
  by the supervisor: task ID, logical connection ID, agent handle, provider,
  selected `cwd`, runtime generation, and prompt. Validation rejects a task
  whose provider, connection, folder, or generation is stale or mismatched.
- **Lifecycle contract:** defines common start/readiness, send, cancellation,
  supervisor pause/resume, status, streamed events, graceful drain, stop, and
  reconnect boundaries. Claude stream transport, Codex worker/resume
  transport, and OpenCode ACP remain adapter implementation details.
- **Private data boundary:** provider continuation references are represented
  only as private continuation metadata. Public-safe snapshots do not contain
  provider session references, process IDs, tokens, or credentials.
- **TDD evidence:** the new focused test first executed RED because the shared
  module did not exist; after the minimal implementation, the same test passed
  **3/3**. `npm run typecheck` passed with exit code 0. The documentation diff
  check passed without whitespace errors.
- **Lint evidence:** targeted ESLint was attempted for the two new files, but
  the command produced no output or exit status after several minutes and was
  interrupted. It is therefore **not** counted as a lint pass; no lint failure
  is being invented from that timeout. The new files were separately checked
  for trailing whitespace and passed.
- **Checkpoint limitation:** the TDD skill's isolated RED checkpoint commit
  could not be created because this managed shell exposes `.git` as read-only;
  Git could not create `.git/index.lock`. No existing file was staged or
  committed, and the source/test evidence is preserved in the working tree.
- **Cleanup boundary:** no runtime, backup, retired image, provider session,
  process, or user artifact was deleted or restarted. Old files are held while
  the new owner boundary is built. Their mere presence does not make them an
  active launch target, but the currently running process generations still
  require explicit ownership/generation verification before any cleanup can be
  called safe. Cleanup remains a later release step, after the managed route
  and package transition are verified.

#### Step 3 status — shared lifecycle extraction (2026-10-24)

Step 3 is complete at source level. It extracts the provider-neutral lifecycle
state machine without changing the provider-specific transport adapters or
activating a new runtime.

- **Shared runtime module:** added
  `src/lib/native/managed-provider-runtime.ts`. It owns the registered logical
  connection profiles, one monotonic generation per connection, stale-callback
  rejection, explicit draining/stop invalidation, task-ownership fencing, and
  public-safe snapshots. It never stores or exposes process IDs, provider
  session references, tokens, or credentials.
- **Compatibility facade:** `createWebLiveSessions` now normalizes each web
  agent into the shared connection profile and uses the shared runtime for
  generation creation, late callback checks, status transitions, and stop
  invalidation. Claude stream-json, Codex worker/resume, and OpenCode ACP
  launch/send code remains at the edge exactly as it was; Step 4 moves those
  adapters behind the shared send/start contract.
- **Focused TDD evidence:**
  `scripts/managed-provider-runtime.test.ts` first ran RED because the module
  did not exist, then passed **4/4** after implementation. The existing
  `scripts/web-live-sessions.test.ts` regression suite passed **43/43**;
  `scripts/managed-provider-contract.test.ts` passed **3/3** alongside it.
  `npm run typecheck` exited 0.
- **Lint evidence:** targeted ESLint for the two new files and the modified
  compatibility facade exited 0.
- **Diff evidence:** `git diff --check` completed without whitespace errors.
  Existing LF/CRLF normalization warnings in the dirty worktree are not
  source failures.
- **Scope boundary:** no provider process was stopped or restarted; no session,
  runtime, binary, backup, retired image, package, permission, or user file was
  deleted; no package was activated. The old artifacts remain held until the
  managed provider route and exact package transition are verified. Their
  cleanup is not silently treated as complete.

Step 3 does **not** claim that Claude, Codex, or OpenCode are already launched
by the new owner supervisor. That is Step 4. It also does not close integrated
provider delivery, desktop, cursor, update/reboot, or live acceptance gates.

#### Step 4 status — provider transport adapters at the edge (2026-10-24)

Step 4 is complete at source level. Each current provider transport now has a
provider-specific adapter that implements the same managed-provider connection
contract. The shared runtime, pill, desktop-action schema, memory, and task
authorization layers do not need provider-specific branches.

- **Claude adapter:**
  `createClaudeManagedProviderConnection` wraps the existing
  `startLiveSession` stream-json path. It owns readiness from the provider's
  init event, exact continuation matching, signed user input, streamed text and
  tool events, result/error events, cancellation, pause/resume, drain, and stop.
- **Codex adapter:**
  `createCodexManagedProviderConnection` keeps Codex's existing one-worker-per-
  turn behavior. Its edge callback supplies the existing worker arguments,
  while the adapter owns task-generation validation, JSONL thread/message/tool
  mapping, resume-thread continuation, worker failure, cancellation, and stop.
- **OpenCode adapter:**
  `createOpenCodeManagedProviderConnection` wraps the existing ACP runtime. It
  keeps ACP startup, session continuation, prompt streaming, activity mapping,
  cancellation, drain, and shutdown at the provider edge.
- **Private-data boundary:** provider continuation references remain private
  adapter state and are returned only through the private readiness value.
  Public snapshots contain only logical connection identity, folder, status,
  generation, and active task ID; they do not expose process IDs, tokens, or
  provider session references.
- **Focused evidence:**
  `scripts/managed-provider-adapters.test.ts` passed **3/3** using fake
  transports for all three providers. The combined contract/runtime/web
  regression run passed **46/46**. `npm run typecheck` exited 0, targeted
  ESLint exited 0, and `git diff --check` passed.
- **Scope boundary:** these adapters are source-ready but are not yet the
  active owner-supervisor route. The web compatibility facade remains on its
  existing transport code until Step 6 wires the owner broker/pill to these
  adapters. No provider process,
  runtime, package, session, or user file was restarted, activated, or deleted.

#### Step 5 status — deterministic provider connection selection (2026-10-24)

Step 5 is complete at source level. Provider and project-folder identity now
select the connection before process evidence is considered. The implementation
does not guess from PID order, recency, or whichever provider process happens to
ask first.

- **Managed profile selection:**
  `selectManagedProviderProfile` matches the normalized provider and normalized
  project folder, with the agent handle narrowing deliberately separate slots.
  If two logical connections still have the same provider, handle, and folder,
  an explicit `connectionId` is required; otherwise selection fails closed.
- **MCP connection binding:** connection claims, durable bindings, active-turn
  lookup, and `bindConnectionForProcess` now carry the project folder as the
  primary compatibility selector. A supplied process ID validates the selected
  folder; it does not choose a different folder. The managed MCP startup path
  passes its configured `connectionCwd` into reconciliation and binding.
- **Provider-session reconciliation:** Claude, Codex, and OpenCode recovery
  filters live observations by the exact expected project folder before applying
  session/process checks. Multiple live sessions in one selected folder fail
  closed unless an exact session or connection selector is present. Unknown
  process ownership is never converted into a different folder or session.
- **Web compatibility facade:** `agents.json` may carry an optional logical
  `connectionId`; the facade selects the exact normalized provider/folder
  profile and reports an explicit ambiguity/missing-connection error instead of
  silently choosing another profile.
- **Focused TDD evidence:** the Step 5 regression command passed **105/105**.
  It covers exact provider/folder selection, same-PID cross-folder isolation,
  explicit duplicate-connection selection, Claude/OpenCode/Codex reconciliation,
  managed delivery, and the existing web-session regressions. `npm run typecheck`
  exited 0. Targeted ESLint exited 0 with five existing unused-variable
  warnings and no errors. `git diff --check` reported no whitespace errors.
- **Scope boundary:** this is source/test evidence only. No provider process,
  session, runtime, package, binary, backup, permission, or user file was
  restarted, activated, deleted, or cleaned up by Step 5. Installed-runtime
  continuity and live provider acceptance remain later gates.

#### Step 6 status — desktop pill owner-broker boundary (2026-10-24)

Step 6 is complete at source level. The desktop pill now uses the existing
owner broker as its state and command boundary. It does not create a second
provider supervisor, route through the browser page, scan provider sessions,
or require an inbox read.

- **Broker-owned state:** `scripts/m9r-web-broker.ts` publishes one redacted,
  atomically replaced `desktop-pill-state.json` snapshot beside the broker's
  existing state. The broker refreshes it while alive and removes it during a
  clean shutdown. The overlay rejects a stale snapshot after ten seconds, so
  a crashed broker cannot leave the pill attached to dead state.
- **Owner command path:** pill messages, approval allow/deny decisions, and
  shared-memory notes now travel through the authenticated owner pipe at
  `/web/ui/command`, `/web/ui/approve`, `/web/ui/deny`, and
  `/web/ui/save-note`. The broker's UI bridge remains the single place that
  selects recipients, applies authorization, and calls the managed sessions.
- **Desktop shell:** the Tauri overlay reads broker state first and maps it
  through the same provider-neutral pill snapshot converter as the in-page
  surface. Its legacy merged feed remains a compatibility fallback only when
  no fresh broker snapshot exists. Broker-owned approvals intentionally hide
  the old “allow for a day” control because that grant is not part of the
  owner-broker UI contract.
- **Packaging:** the new state module is included in the CLI runtime bundle.
- **Focused TDD evidence:** the desktop state test passed **1/1**, the pill
  shell suite passed **16/16**, the owner-pipe desktop-pill integration test
  passed **1/1**, `npm run typecheck` exited 0, and the Rust overlay suite
  passed **15/15** using an isolated writable Cargo target because the
  pre-existing target directory is inaccessible/corrupt. The normal Cargo
  target was not deleted or repaired.
- **Scope boundary:** this is source and focused-test completion. No provider
  process, provider session, runtime, package, binary, backup, permission, or
  user file was restarted, activated, deleted, or cleaned up by Step 6. The
  packaged activation and grouped live desktop/provider acceptance remain
  later steps.

#### Step 7 status — unified delivery and receipts (2026-10-24)

Step 7 is complete at source level. Tasks now carry one provider-neutral receipt
record alongside their existing delivery and lifecycle fields. The receipt
contract records `accepted`, `dispatched`, `provider_received`, `started`,
`completed`, `canceled`, `failed`, `retryable`, and `uncertain` distinctly,
with bounded history and an explicit `observed` or `inferred` basis. Existing
owner-broker, provider-transport, prompt/inbox, Codex, Claude, and OpenCode
delivery paths update that same record rather than creating separate status
interpretations.

- A task is accepted when created. Dispatch and provider receipt are recorded
  at their actual delivery boundaries. A result may infer only the missing
  provider-received and started phases; the receipt marks those phases as
  inferred instead of pretending they were directly observed.
- Failed delivery is distinct from `retryable`, and `retryable` is only created
  by an explicit deferred retry. `uncertain` is a durable, non-replayable
  transport outcome; it remains visible to a later inbox read even when no
  provider session ID was available, and it is presented as status rather than
  executable work.
- Cancellation is a durable receipt fence. The delivery pump, approval path,
  inbox claims, provider claims, pending-status counts, and late results do not
  revive or mutate a canceled task. Existing transport history remains intact
  for diagnosis.
- **Focused TDD evidence:** the new receipt suite passed **4/4**; the combined
  delivery/store/feed/inbox/receipt/OpenCode regression set passed **127/127**;
  the targeted uncertain-receipt inbox case passed **1/1**; `npm run typecheck`
  and `npm run build` both exited 0; `git diff --check` reported no whitespace
  errors (only existing line-ending warnings).
- **Scope boundary:** this is source and test completion only. No provider
  process, provider session, runtime, package, binary, backup, permission, or
  user file was restarted, activated, deleted, or cleaned up. Installed-runtime
  activation and grouped live provider/desktop acceptance remain later gates.

#### Step 8 status — universal desktop behavior preserved (2026-10-24)

Step 8 is complete at source level. The existing provider-neutral desktop
contract remains intact, and the native stage now enforces the missing
cross-provider invariants at the boundaries where they matter.

- **Cursor roster and first-action ordering:** cursor presentation is now
  serialized only for initial overlay-slot reservation, so Codex, Claude,
  OpenCode, and other independent provider sessions receive distinct startup
  positions even when their deliveries arrive concurrently. The placement
  remains overlay-only (`scope: "window"`) and never uses the owner's physical
  pointer. `m9r_stage_app` primes the cursor before window discovery or launch;
  `m9r_stage_prepare` primes before stage preparation completes; and every
  later desktop action re-primes immediately before dispatch so a cursor hidden
  after a failed native call cannot silently remain absent.
- **Pointer isolation and foreground contention:** the existing shared FIFO
  foreground lease still serializes the one real Windows foreground stream while
  background-capable provider connections remain independent. If foreground
  input is sent but the owner's exact pointer position cannot be restored, the
  action now returns an explicit uncertain outcome instead of reporting clean
  isolation.
- **Cancellation and recovery:** a task with a durable canceled receipt is
  fenced before cursor resolution, stage preparation, launch, or desktop input.
  Existing exact-window focus recovery, moved-window re-presentation,
  closed-window relaunch rules, operation receipts, clipboard routes, window
  controls, and post-action capture/postcondition behavior remain covered by
  the provider-neutral stage contract.
- **Focused TDD evidence:** the complete Step 8 native regression set passed
  **180/180**, including Cua cursor startup, concurrent cursor placement,
  pointer restoration, foreground leasing, stage actions, app launch/recovery,
  clipboard, window state, cancellation, operation receipts, and native stage
  lifecycle. `npm run typecheck` completed without diagnostics, `npm run build`
  completed successfully, and `git diff --check` reported no whitespace errors
  (only existing LF/CRLF normalization warnings).
- **Scope boundary:** this is source, focused-test, typecheck, and production
  build completion only. No provider process, provider session, runtime,
  package, binary, backup, permission, or user file was restarted, activated,
  deleted, or cleaned up by Step 8. Live cursor, focus, action, clipboard,
  multi-provider, and reboot acceptance remain grouped acceptance work later;
  they are not being called complete from source evidence alone.

#### Step 9 status — controlled update and recovery (2026-10-24)

Step 9 is complete at source level. The update path now has one explicit,
provider-neutral transaction boundary for draining the owner supervisor,
stopping only the exact logical connections it owns, replacing and verifying a
new runtime generation, restoring the configured connections, and refusing to
report success while retired artifacts remain.

- **One owner boundary:** added
  `src/lib/native/managed-provider-supervisor.ts`. Connections are keyed by a
  normalized logical profile (`handle`, `provider`, `cwd`, and logical
  connection ID). Dispatch rejects stale provider, folder, connection, or
  generation fields before provider I/O. The supervisor never scans or kills
  processes by provider name, PID, executable path, or an arbitrary session
  candidate.
- **Private continuation only:** provider continuation metadata is stored in a
  profile-bound, atomically written file whose name is a one-way digest of the
  logical connection ID. The record contains no PID, executable path, token, or
  credential. Corrupt, mismatched, or invalid metadata is ignored rather than
  used to select a connection.
- **Controlled transaction:** added
  `src/lib/native/managed-runtime-update.ts`. The enforced order is drain →
  explicitly bound active work if and only if the drain timeout is exceeded →
  exact connection stop → stable package replacement → generation verification
  → new-generation start → logical-profile/continuation restore → retired
  artifact cleanup. A stuck drain fails closed when no explicit owner policy is
  supplied. Cleanup that leaves any retired artifact is a failed update, not a
  successful update with a warning.
- **Recovery:** if replacement has happened and verification, start, restore,
  or cleanup fails, the coordinator attempts the supplied rollback, restarts the
  previous generation, and restores the same logical profiles. A rollback
  failure is reported together with the original failure instead of being
  hidden.
- **Low-level file safety:** the existing
  `runtime-install-transaction.ts` remains the staged/hashed file transaction;
  Step 9 supplies the owner-lifecycle boundary around it. Step 10 will connect
  the exact packaged installer/runtime entrypoint to this coordinator and prove
  the activated revision. No installed runtime was replaced during Step 9.
- **Focused TDD evidence:** the new Step 9 tests first ran RED because the
  supervisor and update coordinator were absent. The final focused set passed
  **22/22**, covering identity fencing, duplicate/profile rejection, drain and
  bounded-work behavior, private continuation restore, ordered replacement,
  rollback, stale-generation rejection, and cleanup failure. The related
  adapter, contract, and runtime suites were included in that 22-test set.
  `npm run typecheck` exited 0, `npm run build` exited 0, and `git diff --check`
  reported no whitespace errors (only existing LF/CRLF normalization warnings).
- **Broader-suite boundary:** a combined native run still has 27 failures in
  pre-existing temp-backed tests because this managed sandbox denies Windows
  `rename` under its temporary directory with `EPERM`. The Step 9 tests,
  runtime-install transaction tests, and provider-update lifecycle/monitor
  tests passed. No unsafe rename fallback was added to hide that environment
  limitation.
- **Scope boundary:** no provider process, provider session, installed runtime,
  package, binary, backup, permission, or user file was restarted, activated,
  deleted, or cleaned up. This is source/test/build completion only. Exact
  revision packaging and installed-runtime activation are Step 10; grouped
  owner-visible provider, desktop, reboot, and recovery acceptance is Step 11.

#### Step 10 status — exact revision packaging boundary (2026-10-24)

Step 10 is complete at the source and package-boundary level, but the native
installed-runtime check is not being called complete because this managed
Windows test host refuses the installer fixture's backup-directory creation
with `EPERM`. The release guard is intentionally fail-closed rather than
working around that restriction.

- **Exact package identity:** added
  `scripts/release-package-manifest.mjs`. It records the runtime build ID,
  source commit/dirty state, and the SHA-256 of every staged package file,
  then verifies the exact file set and every hash before the ZIP is written.
  The package manifest itself is excluded from its own file map so creation
  and verification are deterministic.
- **Packager boundary:** `scripts/package-engine-release.ps1` now creates and
  verifies that manifest and accepts `-RequireCleanSource`. A clean-release
  request refuses the current dirty checkout with the runtime's explicit
  `sourceDirty` identity instead of producing a misleading release package.
  A local development package was created separately and contained both
  identity manifests plus 218 exact ZIP entries; it was not installed.
- **Installer boundary:** `scripts/install-m9r.ps1` requires
  `m9r-package-info.json`, checks its runtime/source identity against
  `m9r-build-info.json`, validates safe paths, and hashes every extracted file
  before setup proceeds. The installer fixture now uses the same manifest
  contract as the real packager.
- **Published workflow:** `.github/workflows/m9r-engine-release.yml` now
  passes `-RequireCleanSource` in addition to the existing signature gate.
- **Build and test evidence:** `npm run build:cli`, `npm run typecheck`,
  `npm run build`, and `npm run build:engine` completed successfully. The
  native build verified one runtime identity across 185 files. The focused
  package/workflow suite passed **7/7**; the static installer/package contract
  subset passed **2/2**; `git diff --check` reported no whitespace errors and
  only the repository's existing LF/CRLF normalization warnings.
- **Native installer boundary:** the full installer suite reached 9 passing
  checks and 4 failures. Every failure is the same host restriction while
  creating the test home `backups` directory (`EPERM`), before setup can
  complete. No unsafe fallback was added. The full lint command also did not
  return a completion status in this host and was stopped after its worker
  exited without a result; it is not being reported as passed.
- **Scope boundary:** no installed runtime, provider process/session, user
  configuration, permission, backup, or existing runtime artifact was
  activated, restarted, deleted, or cleaned up by Step 10. The dirty local
  build is not a release boundary. Native installer completion and grouped
  owner-visible acceptance remain Step 11 work.

**Next implementation step:** remove the native test-host restriction or run
the installer regression on an equivalent writable Windows host, then proceed
to Step 11 grouped integrated acceptance. Do not activate the dirty local
package as a release.

#### Step 10 follow-up — installer regression and lint gate reverified (2026-10-24)

The earlier 9-pass/4-fail result above is now superseded for the current
checkout. The failures were confined to the disposable native-test fixture:
the fixture created its test home beside the checkout and then attempted
Windows executable replacement from an AppContainer-scoped temporary working
directory. The production installer was not changed to weaken that boundary.

- **Manifest verifier fix:** `scripts/install-m9r.ps1` now normalizes Windows
  path separators with the actual single backslash character before comparing
  extracted files with `m9r-package-info.json`. Nested package entries are
  therefore checked against the exact manifest paths instead of being rejected
  or missed because of a two-character separator literal.
- **Test fixture correction:** `scripts/install-m9r.test.mjs` keeps its
  disposable M9R home under the checkout for the executable-replacement test,
  while running the packaged engine from a temporary working directory. This
  preserves the credential-boundary check and avoids the host's unrelated
  AppContainer rename restriction; it does not alter the installer or runtime
  path used by users.
- **Verification:** the complete installer suite now passes **13/13**. The
  full lint command exits 0 with the repository's existing warnings, and the
  typecheck, CLI build, engine build, focused managed-provider tests, and
  `git diff --check` remain green from the same source state.
- **Generated-output cleanup:** the two checkout-local `.m9r-installer-*`
  package fixtures and six sibling `.m9r-installer-home-*` test homes were
  removed after their contents were confirmed to be generated installer
  packages, test binaries, backups, and manifests. No provider session,
  user-profile directory, runtime outside those test homes, or release ZIP
  was removed.
- **Held artifacts:** the dated 2026-10-23 engine ZIP and its matching SHA-256
  sidecar remain held because they are release evidence, not proven-disposable
  test output. `.artifact-scratch` also remains because its design files have
  not been classified as disposable.

**Current Step 10 conclusion:** source, package-boundary, installer, and lint
checks are complete for this checkout. A clean release package still cannot be
declared because the worktree is source-dirty and no Authenticode signing
certificate/thumbprint is configured. Installed-runtime activation and grouped
owner-visible provider/desktop acceptance remain Step 11 gates.

#### Runtime retention and release-authorization audit — 2026-10-24

The remaining local cleanup and release blockers were traced to their actual
boundaries rather than treated as generic stale files.

- **Retention root cause:** runtime transaction journals stored Windows paths
  with `\\` separators, while snapshot verification constructed `/`-separated
  relative paths. The verifier therefore rejected every nested snapshot as
  unverifiable and preserved it indefinitely. `normalizeSnapshotPath` now
  canonicalizes both separators before comparison. The focused runtime suite
  passes **8/8**, including a nested Windows-path regression case.
- **User-state cleanup:** M9R's own verified transaction pruner removed all
  **15 committed, exact-`bin` runtime snapshots** after hashing and validating
  their manifests. No applying, failed, malformed, foreign-target, or uncertain
  recovery journal was removed. The active `runtime-backups` directory is now
  empty.
- **Retired images:** the two exact `m9r-engine.exe.m9r-retired-*` files were
  not referenced by the active install manifest, and no named M9R process was
  running. They were removed. The old `recovery-quarantine-20261014` was also
  unreferenced and contained only stale engine/broker/runtime-backup/temp
  material; that exact quarantine was removed. Current install backups,
  web-runtime state, web backups, and the rollback snapshot were retained.
- **Dirty-tree classification:** the remaining checkout entries are source,
  tests, migrations, release workflow, tracker/docs, and intentional site/pill
  changes, plus three pill-design scratch files and one old user DOCX. No
  generated installer fixtures or runtime staging directories remain. Nothing
  was hidden by changing ignore rules, and no unrelated source was deleted.
- **Authenticode boundary:** this is a Windows publisher code-signing
  certificate, not an M9R token or runtime credential. Its thumbprint is the
  certificate's 40-hex-character SHA-1 fingerprint used to ensure every
  packaged executable was signed by the expected publisher. This machine has
  no certificate in `Cert:\CurrentUser\My`, all three built M9R executables are
  `NotSigned`, and `M9R_SIGNER_THUMBPRINT` is empty. The workflow verifies the
  thumbprint but does not invent or create a publisher identity; production
  release authorization therefore requires the owner's real signing
  certificate/private-key service and the corresponding CI secret/variable.
- **Post-cleanup build:** `npm run build:engine` rebuilt the current engine,
  broker, and pill companion set and verified one build identity across 185
  runtime files
  (`7d16d13b581818fce75fe791a2b0d56a6dc1b933c962850967501c8e7b7d41d8`). The
  build reported the existing postject
  signature warning and the resulting engine is still `NotSigned`; no staged
  `.m9r-*` build directory remains. This is a current development build, not
  a release package.

Still required:

- Fresh clean installed OpenCode acceptance, including no stale task selection.
- Current-runtime continuity for Claude, Codex, and OpenCode, including
  reconnect, reboot, update, and heartbeat presence proof.
- Installed provider-update proof is still required: the active OpenCode
  process must load the reconciled modern config without manual inbox polling,
  and Claude/Codex must show the same update/reconnect contract. Source and
  fixture evidence does not close this live gate.
- Live active-work drain, replacement/retirement, reboot persistence, and
  no-orphan proof.
- Coordinated live failure/reconnect and ordinary user-facing lifecycle proof.
- All-three-provider simultaneous presence, live cross-provider mention
  routing, resumable delivery, and removal of inbox-polling friction.
- Equivalent background/foreground execution, automatic reopen/resume, and
  joint-window leasing.
- Local disposable-session proof, resource measurements, recovery semantics,
  and later implementation decisions for takeover, replay, wallets, and
  federation. Automatic artifact draining remains deferred.

### Lane 2 — Universal open-world desktop control, observation, routes, and actions

Includes original items 6, 7, 8, 9, 12, 13, and 14.

Current conclusion:

- Launcher/renderer matching, existing-window adoption, ownership
  coordination, refusal, focus separation, recovery states, and stage
  lifecycle fixes are source-verified.
- Generic semantic/coordinate targeting, actionable ancestors, deep trees,
  field memory, insert/replace behavior, foreground delivery, keys, hotkeys,
  scrolling, dragging, popup capture, dispatch classification, and
  postconditions are source/fixture covered.
- Separate provider workers now share one provider-neutral foreground-input
  lease with FIFO waiting, cancellation, dead-owner recovery, and fail-closed
  stale-lock handling. This prevents independent provider sessions from
  fighting over the one real Windows foreground stream without serializing
  background-capable work; the source regression is 5/5.
- Local UIA/DOM-first observation, revision/change tracking, honest
  partial/truncated status, bounded fallback, popup metadata, and image
  budgeting are verified. This is local structured observation, not a cloud
  Pine Computer dependency.
- Native-versus-extension separation, target-family pinning, disabled
  extension registration, no-double-dispatch, and packaged route checks passed
  47/47.
- Typed/pasted path sharing and stale-idempotency handling are traced and
  covered.

Still required:

- Arbitrary apps, sites, browsers, controls, and workflows—not an allowlist or
  a named-app acceptance boundary.
- Focus, occlusion, minimized/hidden/moved/closed-window recovery and
  universal live ownership.
- Live cancellation, pointer isolation, menus, clipboard, resize, move,
  minimize/maximize/restore, and arbitrary-control coverage.
- Arbitrary native/browser live observation parity, event freshness, and
  installed-provider acceptance.
- Fresh OS-only browser proof, cursor attribution, pointer isolation, and
  opt-in shared-tab acceptance.
- The owner-reported T305 Chrome trace must be rerun against a fresh current
  package: the old extension wait, stale/occluded window references, malformed
  action shapes, and desktop-stage IPC timeout are diagnostic findings, not a
  named-app acceptance pass. The current source keeps the extension tools
  unregistered; installed-runtime proof must show they cannot leak back into
  an agent tool list.
- Real event-level capture of the owner-reported arbitrary-paste symptom, or a
  documented non-reproduction covering the attempted input classes.

### Lane 3 — Persistent cursors, pointer isolation, and joint-window presentation

Includes original items 10 and 11, plus the visual part of the joint-window
architecture.

Current conclusion:

- Shared cursor delivery, physical-pointer capture/restore hooks, and
  provider-neutral integration are source/fixture covered.
- Persistent allocation is wired through dashboard, pill, feed, and activity
  surfaces; focused allocator/UI tests passed 54/54.

Still required:

- Cursor visible before the first action, simultaneous and multi-monitor
  rendering, animation, and live pointer-isolation proof.
- Persistent provider identity, permanent customizable colors, reconnect
  persistence, correctly formatted labels, and no visible session IDs/tokens.
- Better cursor design, always-visible identity labels, and joint-window color
  outlines/harbor presentation.
- Design options must be shown visually before the final cursor/pill look is
  selected. Native theme assets remain held until reviewed.

### Lane 4 — Trust, history, latency, and model continuity

Includes original items 15, 16, and 17.

Current conclusion:

- Generated-envelope provenance, human provenance, transcript/session
  deduplication, submission idempotency source work, and T261 reconciliation
  are verified.
- Durable inner-phase timing and bounded fallback payloads are implemented and
  tested; the corrected T261 timeline is recorded.
- Authorized setting persistence, catalog validation, ACP/Codex application,
  and adapter/settings/discovery suites are verified.

Still required:

- Production duplicate-row acceptance, historical-row policy, random-chat
  prevention, and fresh dashboard proof.
- Fresh T261-class timing correlation and the root cause of the historical
  59.516-second gap.
- Visible mid-session model changes inside both Codex and Claude native UIs.

### Lane 5 — Pill, dashboard, messaging, and product polish

Includes original item 18 and the user-facing portions of item 5 and item 11.

Current conclusion:

- Provider-visible text no longer needs internal routing metadata.
- Concise delivery, color wiring, public consistency boundaries, and the
  current dashboard/workspace consumers are source-verified.

Still required before the demo:

- Improve the pill messaging area and make ordinary agent-to-agent delivery
  concise and natural.
- Refine the pill's visual hierarchy and interaction intent so the composer,
  selected M9R-managed worker versus optional direct provider session, and
  ready/sending/working/waiting/approval/error/done states look and behave
  consistently. Preserve the current messaging flow while making each state
  clear instead of relying on contradictory conditional UI.
- Remove inbox-checking and unnecessary owner-approval boilerplate from normal
  owner-originated work while retaining backend authorization and audit data.
- Keep task IDs, session IDs, tokens, delivery lists, and routing metadata out
  of the ordinary user and agent experience.
- **Deferred, post-first-launch**: a project-agnostic connection mode where a
  provider's live process is tracked purely by M9R without being tied to any
  project folder/cwd at all, for personal/ambient tasks that don't need repo
  context. Complements, not replaces, the folder-based disambiguation fix
  (matching a live session to the project root the user selects, since `cwd`
  is already part of the identity key in
  `src/lib/native/provider-session-reconciliation.ts:151` — this just makes it
  the primary, user-chosen signal instead of PID-guessing). Folder-based
  disambiguation ships first, for the demo; this project-agnostic mode is
  revisited once the app (not just the web workspace) is the target surface.
- Finish live mention UX, taskbar-artifact ownership, cursor harbor/presentation,
  and intentional update UI.
- Ensure all providers use the same generic orchestration contract even when
  their models differ in speed or reasoning quality.

### Lane 6 — Release, cleanup, updates, and public readiness

Includes original items 19, 20, and 21.

Current conclusion:

- Recoverable quarantine, rollback retention, stale-build convergence,
  duplicate-watchdog prevention, and bounded cleanup rules are verified without
  blanket killing.
- The signed check-only updater contract and Tauri updater plan exist; updater
  implementation is not represented as shipped.
- Signup age gating, pricing/Terms consistency, public-content checks,
  typecheck, and the focused marketing regression 8/8 are verified.

Still required:

- Evidence-backed stale-worker retirement, restart/reboot persistence, and
  user-safe cleanup behavior.
- Hosted updater manifest/endpoint, signing, check/download/apply/restart/
  rollback behavior, UX specification, packaged acceptance, and final icon
  assets.
- Live homepage/workspace audit, billing/webhook proof, legal/operator sign-off,
  deployment, onboarding acceptance, and an allowlisted PWA asset commit.
- The current manifest/logo pair, icon binaries, asset-dependent marketing
  test, ESLint config cleanup, runtime outputs, quarantine, scratchpad, and
  user document remain held until individually reviewed. No automatic artifact
  draining is part of this pass. The clean packaged runtime boundary and exact
  activation are now verified for build
  `02b96a7e05c762588e9f7180a44aa9ed3efdef286f96e3541756bf72f7dc1d25` from
  source commit `27af26cc`; the installed 185-artifact manifest matches the
  package. Provider-owned parent supervisors from earlier sessions remain
  intentionally untouched while current-generation workers are handed off;
  idle-parent retirement and reboot persistence still require evidence. Live
  provider acceptance remains open.

### Lane 7 — Live acceptance and multiplayer demo gates

Includes original items 6 and 23.

Acceptance boundary:

- The matrix is open-world: the owner may choose any app, site, browser,
  control, or workflow. Calculator, Settings, Paint, File Explorer, Chrome,
  and Notepad are only smoke fixtures.
- Codex, Claude, and OpenCode must be tested separately and then together.
- A pass requires delivery, provider continuity, cursor identity, observation,
  focus, action, recovery, routing, and visible postcondition evidence—not
  merely that an app opened.

Demo sequence:

1. Complete the polish and release gates above.
2. Run one difficult dry run focused on provider continuity and recovery.
3. Run a second difficult dry run focused on universal actions, cursors, and
   multi-agent coordination.
4. Run a rehearsal of the actual multiplayer demo.
5. Record the final multiplayer demo only after the rehearsal passes.

The intended demo is collaborative rather than three unrelated smoke tests:
Codex, Claude, and OpenCode should each contribute a visible step to one
coordinated, non-destructive workflow, with distinct cursors and a final
shared result. The first demo may use the current shared local desktop surface
with coordinated turns; local isolated-session implementation remains a
foundational follow-up and is not falsely marked complete by the demo.

## Original-item coverage map

| Original item | Covered by |
|---:|---|
| 1 | Lane 1 |
| 2 | Lane 1 |
| 3 | Lane 1 |
| 4 | Lane 1 |
| 5 | Lanes 1 and 5 |
| 6 | Lane 7, with control implementation in Lane 2 |
| 7 | Lane 2 |
| 8 | Lane 2 |
| 9 | Lanes 1 and 2 |
| 10 | Lane 3 |
| 11 | Lane 3, with presentation polish in Lane 5 |
| 12 | Lane 2 |
| 13 | Lane 2 |
| 14 | Lane 2 |
| 15 | Lane 4 |
| 16 | Lane 4 |
| 17 | Lane 4 |
| 18 | Lane 5 |
| 19 | Lane 6 |
| 20 | Lane 6 |
| 21 | Lane 6 |
| 22 | Lane 1 |
| 23 | Lane 7 |

## Release sequence from this checkpoint

1. Preserve the checkpoint and Master List 2.0 history. **Done.**
2. Reconcile the tracker, source diffs, tests, installed evidence, and retained
   artifacts into this condensed 2.1 plan. **Done for the current boundary.**
3. Finish the reviewed allowlist of source, regression tests, migrations, and
   documentation. Exclude generated runtime output, secrets, user documents,
   historical quarantine, and unverified design/icon files. **Done for the
   reviewed source boundary.**
4. Review and commit only verified logical groups. The current boundary is
   recorded by allowlist commit `cc1f5b28`, provenance fix `ffc8bbf4`, and
   tracker evidence commit `580a3705`; held asset/config/runtime categories
   remain unstaged and uncommitted. **Done for this boundary.**
5. Rebuild from the resulting clean commit, run release manifest/checks, and
   compare the complete artifact set. **Verified:** clean source commit
   `27af26cc`, build ID
   `02b96a7e05c762588e9f7180a44aa9ed3efdef286f96e3541756bf72f7dc1d25`,
   `sourceDirty: false`, 185 artifact identities, exact ZIP checksum
   `047c2256845d96d97ca80c8ffbac15bbf4498267f78fcf1c37ef6c3ea62e3b19`,
   installed manifest/hash comparison green, packaged MCP verifier green,
   engine smoke 2/2, transaction checks 3/3, bounded installer checks 4/4,
   and installed connection/reconnect harness 2/2 using disposable stores.
   The full installer fixture was inconclusive at that earlier checkpoint and
   was not promoted to green there. Follow-up fixture verification on
   2026-10-21 passed **13/13** after moving only the disposable native test
   root off the AppContainer `%TEMP%` boundary; production installer behavior
   was unchanged.
6. Exact package activation is **verified**: managed broker stop/start and
   current-build receipts, installed runtime identity, and pill start all
   succeeded. Current-generation workers were handed off beneath the existing
   provider supervisors without blanket process termination. Idle-parent
   retirement, reboot persistence, installed-provider proof, the two difficult
   dry runs, multiplayer rehearsal, and final demo recording remain **open**.

## Numbered remaining closure sequence

This is the numbered continuation of the consolidated execution list after the
completed implementation/release work above. It does not replace the original
23-item coverage map; it groups the remaining gates so they can be completed
and tracked in order.

9. **Cursor identity and presentation.** Remove session IDs and tokens from
   visible labels; use correctly formatted provider names; add persistent,
   customizable solid colors; show the cursor and identity before the first
   action; verify animation, reconnect persistence, multi-monitor behavior,
   pointer isolation, and the Harbor/joint-window presentation.

10. **Universal live desktop/action gate.** Prove arbitrary apps, sites,
    browsers, controls, and workflows—not an allowlist—with fresh observation,
    focus and occlusion recovery, minimized/hidden/moved/closed-window recovery,
    cancellation, clipboard, menus, resize, move, minimize, maximize, restore,
    keyboard, drag, arbitrary-control targeting, and verified postconditions.
    Include OS-only browser proof, pointer isolation, event freshness, and the
    arbitrary-paste/non-reproduction evidence. Retired extension tools must
    remain absent from the installed tool list.

11. **Provider-neutral execution and latency.** Keep structure-first screen
    observation, bounded fallback, and route exclusivity; remove dead-tool
    calls, obsolete extension waits, malformed action retries, unnecessary
    polling, and backend metadata from ordinary agent turns. Measure the
    complete path from task dispatch to first visible action and improve the
    T305-class latency without creating an app-specific path. Harness² remains
    an optional, isolated later experiment for improving prompts, skills,
    middleware, and tool guidance; it is not a replacement for M9R's runtime,
    provider bridge, desktop-control, or multiplayer layers.

12. **Provider continuity and multiplayer operations.** Prove fresh current
    runtime continuity for Codex, Claude, and OpenCode across update, reconnect,
    compaction, restart, reboot, and heartbeat. Prove no stale task selection,
    no orphan worker, resumable delivery, all-three presence, cross-provider
    mention routing, live failure/reconnect, equivalent foreground/background
    behavior, joint-window leasing, and the later local disposable-session,
    takeover, recovery, replay, wallet, and federation boundaries.

13. **Pill, messaging, and user-facing orchestration.** Make agent-to-agent
    delivery concise and natural; remove normal inbox-check and owner-approval
    boilerplate while retaining backend authorization/audit data; keep task IDs,
    session IDs, tokens, and delivery lists out of ordinary user and agent
    views; finish live mention UX, taskbar-artifact ownership, Harbor display,
    and the intentional update flow. All providers must use the same generic
    orchestration contract even when models differ in speed or reasoning.

14. **Release, updater, and safe cleanup.** Complete the hosted updater
    manifest, signing, check/download/apply/restart/rollback flow, update UX,
    and packaged acceptance. The native installer fixture is now verified
    **13/13**, but stale-parent
    retirement, reboot persistence, and cleanup of only provably unreferenced
    retired images. Review held assets, runtime outputs, quarantine, scratchpad,
    and user files individually; drain nothing broadly and delete nothing
    without provenance and recovery evidence. This cleanup occurs before dry
    runs, but only after the release boundary is reverified.

15. **Production and public readiness.** Close production duplicate/history
    policy, random-chat prevention, fresh dashboard proof, latency correlation,
    visible mid-session model changes, homepage/workspace, billing/webhooks,
    legal/operator sign-off, deployment, onboarding, PWA/public assets, and the
    final open-core release boundary.

16. **Live matrix, dry runs, and demo.** Run the owner-selected open-world
    matrix with Codex, Claude, and OpenCode separately and then together. A pass
    requires delivery, continuity, cursor identity, observation, focus, action,
    recovery, routing, and visible postconditions. Then run two difficult dry
    runs, rehearse the actual coordinated multiplayer workflow, and record the
    final demo only after the rehearsal passes.

The next safe action is therefore held-item review and live-acceptance
planning—not automatic deletion, blanket committing, or unverified provider
acceptance. The release-boundary source/package/activation work is complete for
this checkpoint; the remaining gates are explicitly live, visual, provider,
or held-product work.

## Current checkpoint — 2026-10-21

The release-boundary implementation is now complete for this checkpoint. The
historical sequence above remains intentionally preserved; this section is the
current status and supersedes its immediate-action wording.

- Verified release commits: `3e278b68`, `90078424`, and `7cc5cae3`.
- Clean runtime source: `7cc5cae3`, `sourceDirty: false`.
- Runtime fingerprint: `fcf4c3fd25295cea6e7e363824d868b72fbcd1276bf7d6ff120d6ef901abc7a9`.
- Final package: `m9r-clean-cutover-20261021/m9r-engine-windows-x64.zip`.
- Package checksum: `83f447506e525735589aa5ed856c56e968ef5ea9559f86ca19c1f74e7279390b`.
- Exact package activation succeeded; the installed manifest and six top-level
  runtime artifact hashes match the build output, and the pill/broker are
  running from the current build with autostart enabled.
- Private tracker, icon, manifest, marketing, quarantine, scratchpad, user
  document, and older runtime/package material remains outside the release
  commit boundary. The held tracked work is preserved in the named recoverable
  stash; no broad cleanup was performed.
- The implementation side of ordered items 1–6 and the clean runtime/activation
  step is complete. Their integrated delivery, cursor, focus, action, recovery,
  and visible-postcondition evidence is intentionally collected in the dry-run
  area, not by opening separate proof tasks now.

### Immediate order after activation

1. Start or resume the provider sessions.
2. Run one integrated single-agent dry run covering the shared action and
   recovery gates.
3. Run one integrated multiplayer dry run covering delivery, coordination,
   ownership/focus, cursors, and visible results.
4. Reconcile evidence, close only supported list points, then review held
   artifacts for provenance-backed cleanup before the final demo rehearsal.

### Continuity correction — 2026-10-21

The provider-update continuity gap discovered after the OpenCode 2.1.1 update
is now fixed at the M9R-owned configuration boundary. The failure was not a
requirement for a fresh provider chat: two supported OpenCode config spellings
existed in the active directory, but only one was reconciled, allowing a stale
sibling to launch without the current provider identity route. Commit
`023f2707` makes setup and provider-update reconciliation enumerate and
conservatively repair every existing spelling while preserving unrelated user
configuration and credentials. The installed runtime was rebuilt and activated
from that commit with `sourceDirty: false`; both current OpenCode configs now
use the modern `mcp.servers.m9r` route, current hook, provider marker, shared
M9R home/port, and identity plugin.

Focused source evidence is **26/26** provider-update tests, **1/1** dual-config
native reconciliation regression, typecheck pass, changed-file lint with zero
errors, and clean diff check. This closes the reproducible config-drift cause;
the integrated dry run still owns live claim, delivery, reconnect, cursor,
focus, action, and visible-postcondition proof. No fresh provider chat is a
repair step for this bug, and no held/private material was deleted or committed.

### Continuity finalization — 2026-10-21

- **Closed in source:** retained historical sessions no longer generate false
  identity-restart warnings, and normal setup/status no longer repeats
  first-time fresh-session guidance once an existing provider endpoint is
  known. Existing sessions remain the continuity path.
- **Verified:** native suite **41/41**, typecheck pass, changed-file lint with
  zero errors, final clean runtime build/activation from `0bf353a2`, installed
  build ID `8be9ae912cf36f82e0080b3d68f422a4b509f41420dc40d2e6f8e353711cd9e4`,
  `sourceDirty: false`, 209 installed runtime files, and both OpenCode config
  spellings still normalized to the current M9R route.
- **Still open:** integrated live/dry-run proof of claim publication, delivery,
  reconnect, cursor/focus, universal action, recovery, and visible result. This
  remains one combined provider/multiplayer proof gate; it is not a reason to
  create a new provider chat for every runtime update.

### 2026-10-21 — provider-update hook reconciliation

The provider-neutral update monitor now refreshes the M9R-owned OpenCode
identity hook as part of the existing provider-update compatibility boundary.
The adapter generates the current hook source for session start, prompt-time
delivery, polling, and delivery-result events, then updates it only when the
setup manifest proves M9R ownership. A user-edited, path-changed, malformed,
or unowned plugin is preserved and the update is held rather than overwritten.
The provider's credentials, model state, unrelated configuration, and current
CLI/MCP route remain outside this repair. Config replacement for this path now
uses the bounded Windows-safe managed-file replacement with rollback recovery.

Verification: typecheck passed; the OpenCode plugin refresh plus provider
compatibility/lifecycle/monitor/route suites passed **30/30**. This is source
verification only: the installed updater, provider restart/rebind, and
integrated dry-run evidence remain open.

### 2026-10-21 — deferred-task cursor priming

The provider-neutral delivery path now primes the addressed agent's visual
identity when an owner task is created even if that provider is temporarily
offline or between identity claims. Cursor presentation is independent from
transport readiness: a known session may render immediately, while an
unresolved session remains a safe no-op until its next trusted hook/rebind.
The durable task remains deferred rather than failed, and the callback cannot
authorize, deliver, or block routing.

Verification: the native store/hook suite is **56/56 passed** with a
workspace-local Windows temp root. This closes the source regression for
pre-action cursor priming; installed-runtime and integrated dry-run evidence
remain open.

### 2026-10-21 — active MCP route registration fence

The native MCP connection regression now asserts that no `m9r_web_*` tool is
registered on an active provider connection. The legacy browser-broker
implementation remains retained only for explicit historical fixtures, while
the provider-facing native surface stays limited to the current desktop/UIA
route. This prevents a future registration refactor from silently reviving the
retired browser-extension path.

Verification: `mcp-connection.test.ts` **28/28 passed**; the assertion covers
the complete registered-tool map. This is source verification only; installed
tools/list, provider sessions, and integrated live/dry-run acceptance remain
open. No runtime was activated, no artifact was deleted, and no commit was
made.

### 2026-10-21 — provider-neutral SessionStart delivery coverage

The trusted SessionStart delivery path is now regression-tested with an
unlisted provider slug (`gemini-cli`). It uses the same normalized handle,
identity, approval-frontier, one-shot claim, and native stage-contract path as
the named providers; no provider allowlist is consulted. This proves the
source boundary is generic without claiming that an uninstalled provider has
been live-tested or that every provider exposes an unsolicited input channel.

Verification: native store/hook, hook-server, and stage-notice suites
**71/71 passed** with a workspace-local Windows temp root. `npm run typecheck`
passed, the targeted ESLint command completed with no errors, and `git diff --check`
passed with the repository's existing LF/CRLF normalization notices only.
Installed provider delivery and integrated dry-run acceptance remain open. No
runtime was activated, no artifact was deleted, and no commit was made.

### 2026-10-23 — provider/runtime lifecycle source repairs (verification pending)

Source changes are in progress for the provider/runtime failures in the active
fix order: packaged MCP supervisors now refuse to respawn from a retired engine
image when the stable engine slot is missing; OpenCode delivery prefers the
documented exact-session plugin prompt API and reports bounded, value-free
transport/hook failures; hook-triggered engine startup is serialized and a
failed/dead engine start no longer leaves a false retry cooldown; resident
startup refreshes M9R-owned provider configuration without forcing a provider
reconnect; and completed runtime transaction snapshots are removed only after
their terminal state and file manifest are validated. Regression tests were
added, including retry after a provider is initially unavailable.

No bullets above are struck through: the focused tests, Rust tests, typecheck,
build, package activation, and installed/live provider acceptance have not
been run in this pass. The local plugin documentation also confirms OpenCode
loads local plugins at server startup; on-disk refresh alone cannot update code
already loaded in a running OpenCode process. Same-session restart/recovery and
automatic-delivery acceptance remain open. The security-audit isolation
requirement still prevents executing repository-controlled verification in
this shell without an isolated runner.

### 2026-10-23 — current provider/runtime package status

This update supersedes the earlier “verification pending” statement for the
current candidate only:

- ~~`npm run typecheck` passed; the focused provider/runtime suites passed
  **149/149** with a workspace-local Windows temp directory.~~
- ~~Candidate package `237a0caf99a408550ba216073e4bea7cf4e6f66c118ca7559d7d12a00d3783cf`
  was installed and matches the active manifest. Its isolated post-install MCP
  handshake passed with stage/computer-use tools present and retired web tools
  absent.~~ Its source is still dirty (`sourceDirty=true`), so this is not a
  clean-source release sign-off.
- Integrated provider acceptance is **still open**. M9R could not uniquely
  identify the Codex sender session, so no Claude task was sent. The local
  doctor also reports one recent session without live identity and a failed
  `m9r.dev` fetch from this shell. No automatic-delivery claim is made.
- Five older ignored ZIP snapshots (about 591 MB total) and one manifest-listed
  retired engine image (about 95 MB) are not required by the active package.
  They remain untouched pending explicit cleanup approval; the current package
  ZIP remains the verified install input.
- No provider session, site file, local scratch file, or historical package
  archive was removed or reset during this verification.

### 2026-10-23 — provider binding/delivery continuation (source and candidate checks)

- ~~**Exact-turn lifecycle repaired in source:** provider turn-end events now
  retire only the matching provider/session/process turn; OpenCode session
  deletion and idle events close the exact turn, and Codex interruption/end
  hooks use the same exact-turn boundary. Reconciliation derives OpenCode's
  process identity only from the exact session's verified claim, not a stale
  heartbeat or MCP caller.~~
- ~~**OpenCode send path corrected:** delivery now uses the documented SDK
  `client.session.promptAsync` request with the exact session ID and working
  directory. The undocumented plugin-context prompt method was removed as a
  send route. Adapter failures are reported once with bounded, secret-free
  reasons instead of disappearing silently.~~
- ~~**Action binding diagnosis/fix:** MCP identity resolution now preserves and
  re-verifies the exact live provider-turn binding instead of reselecting by
  process alone. Because authorization/binding runs before desktop routing,
  this was a real upstream blocker for focus/action dispatch; the CUA cursor,
  pointer, and input implementation was left unchanged.~~
- ~~**Source verification:** the focused eight-suite group passed **214/214**;
  `npm run typecheck`, `npm run build:cli`, the engine build, isolated packaged
  MCP verification, and `git diff --check` passed. Engine candidate build ID:
  `84bb42f...e9efc2`.~~
- **Still open — installed/live acceptance:** the engine candidate was built
  from a dirty working tree (`sourceDirty=true`) and was not activated into the
  stable user runtime. No real Claude/OpenCode automatic-delivery task, restart
  recovery, or visible focus/action run has been accepted in this checkpoint.
  The live task proof must verify normal delivery in existing provider
  sessions, exact identity, cursor appearance, focus recovery, and visible
  postconditions; source tests do not substitute for that proof.
- **Claude report scope correction:** `deliverOwnerTask` in
  `web-live-sessions.ts` is wired by `scripts/m9r-web-broker.ts` to its resident
  web-workspace sessions. The native feed uses the separate provider adapters
  in `native-commands.ts`. The report's claim that the web resident-slot gate
  is the native pill's delivery path is therefore not established by source.
  The native pump now emits a redacted per-task refusal reason; expanding the
  web workspace's UI snapshot with internal slot state was not done because it
  is not yet shown to be on this failing route.
- **Preservation:** no provider session, CUA/cursor implementation, historical
  package, or unrelated dirty file was removed, reset, committed, or pushed.
