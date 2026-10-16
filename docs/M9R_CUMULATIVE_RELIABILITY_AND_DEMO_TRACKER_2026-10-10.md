# M9R Cumulative Reliability, Demo Gates, and Ownership Tracker

**Checkpoint date:** 2026-10-10  
**Purpose:** One cumulative execution plan for reliability defects, the earlier proposed fix order, product/demo gates, roadmap work, and cleanup. New findings are appended to this plan; they do not replace or reorder it.

## 0. CURRENT EXECUTION ORDER — read this first (2026-10-10, owner-set, do not reorder or skip without the owner's explicit yes)

This section is the live, authoritative sequence for what gets worked on right now. It points at evidence recorded elsewhere in this document (sections 4-6 and the F12-F20 entries under Source records) rather than repeating it. Do not start step *N+1* before step *N*'s acceptance test passes, and do not edit this ordering yourself — if something here looks wrong, flag it to the owner rather than reordering.

**Standing rule that governs every step below, not just one of them:** no action may ever use a route requiring the real shared OS input device (`SyntheticEvents`/`GlobalInput`) without an explicit, visible, owner-acknowledged moment. Never a silent fallback into it. This is a product/safety requirement, not a nice-to-have, and every step below must be implemented to honor it.

1. **F12 — fix the empty/zero desktop-ID acceptance.** Reject an all-zero `GetWindowDesktopId` result as unknown, never as a match. Acceptance: re-run the owner's own Notepad test directly (not just Codex's synthetic proof) and confirm it passes consistently; this is the regression that's currently failing even for the "should be safe" app category.
2. **F16 — stop flattening real error detail** (Cua `.inner`, capture `AggregateError`, transport timeout-vs-crash-vs-broker-down) before fixing the rest. Doing this early makes every step after it verifiable by its real error text instead of a generic failure string.
3. **F17 — enforce one compatible runtime build identity** across engine/broker/MCP, and make health checks report the live build instead of a cached "ready" flag. Prerequisite for trusting any test result from here down.
4. **F18 — fix element-resolution reliability** so Cua's already-existing `ClickPosition.Element` / `ActionRoute.Accessibility` path is actually used instead of falling back to `Coordinates` (which is what triggers the Chrome/Terminal background-input refusal). This is the real fix for F13/F15's "opens Chrome, then stalls" symptom — not a new system, a reliability fix to resolution that already exists.
5. **F19 — investigate `ActionRoute.Dom`** for Chrome specifically (distinct from generic Accessibility) and decide whether to use it for browser targets. Needs a real answer, not an assumption either way, before Chrome's address-bar case is called fixed.
6. **F20 — test directly whether Accessibility/Dom-routed actions succeed on a window on a non-active virtual desktop.** This is the single most important open question and must be answered before finalizing the per-agent desktop design in step 7 — if true, it resolves F13 for the large majority of actions without ever needing the shared-input fallback.
7. **Build the per-agent Task View desktop design** (Codex's design review: stable per-agent identity, bind only owner-launched windows, recoverable `provisioning`/`assigned`/`watching`/`retiring`/`orphaned` lifecycle, explicit single input lease with on-screen "pointer is shared" notice for the watch case) — informed by F20's answer, which may simplify or change its scope.
8. **Implement the always-visible cursor display requirement**: the labeled cursor shows on every action by default, not an opt-in watch mode. `moveCursor`/`click` are already separate driver calls, so this is rendering/telemetry only — no added token cost, independent of which route executes the real action.
9. **F14 — make the fail-closed check chain recoverable instead of fatal**: re-capture instead of a hard 30s expiry, scope capture invalidation to one agent instead of all, per-agent action queues instead of one shared queue, stop converting a timeout into a permanent "do not replay" stop.
10. **F15's remainder beyond F18** — app/window matching for Squirrel-installed apps (Discord/Slack-style), already-open single-instance apps, and multi-window Chrome/Edge disambiguation.
11. **Terminal-class apps (no accessibility surface) — deliberately not in this sequence.** Owner-deprioritized for now. When picked up later, the standing rule at the top of this section still applies in full: explicit visible consent, never a silent foreground takeover.

This order was produced jointly from the owner's and Claude's conversation on 2026-10-10 (desktop-control reliability audit, Codex's Task View design review, and the F18-F20 follow-up) plus the original nine-finding attachment. It does not replace sections 4-6; it sequences the parts of them that are live right now.

## 1. How to use this tracker

This document reconciles four lists that were previously discussed separately:

1. The nine prioritized findings from the owner's audit attachment.
2. The earlier proposed clean-build and install sequence.
3. The seven-step cumulative product fix order.
4. The demo gates and the broader product/release roadmap.

They are related, but they are not interchangeable. The nine findings are the defect inventory. The clean-build sequence is a prerequisite for safely updating the runtime. The seven steps are the cumulative implementation order. Demo gates define evidence required for sign-off. Roadmap items extend beyond the first demo and must not be treated as silently complete when the core cursor demo passes.

### Status definitions

- **OPEN:** no accepted implementation and verification evidence.
- **IN PROGRESS:** an explicitly assigned implementation is underway; not accepted yet.
- **PARTIAL:** some code, cleanup, or tests exist, but at least one required integration or live acceptance is missing.
- **CLOSED:** implementation, regression coverage, and the stated acceptance evidence all pass.
- **DEFERRED / OPTIONAL:** retained in the roadmap but intentionally not on the current demo critical path.

An item is not CLOSED because code exists, a unit test passes, a synthetic cursor moves, a task appears in an inbox, or one successful run was reported. The integrated result and its observable effect must be verified.

## 2. Current evidence snapshot

### Follow-up implementation checkpoint — steps 1–4

- **Step 1 / source verified:** Corrupt or unsupported-version state now fails closed and preserves the file rather than silently resetting identities and task IDs. Local-state publication never falls back to an in-place copy. Writer locks publish their owner atomically; age never authorizes lock theft; a demonstrably dead owner can be recovered using its unique ownership file.
- **Step 2 / source verified:** Codex dispatch now claims the task atomically before asynchronous work. Sending/uncertain tasks cannot be injected again by inbox fallback. The target thread is recorded before dispatch, enabling actual rollout evidence to reconcile a lost response without replay. Completed results cannot be overwritten by a late delivery status. MCP accepts a caller-supplied stable operation ID for reconciliation across new requests.
- **Step 3 / partial:** Exact-window captures now expose at most 200 accessible labels/roles/bounds from the same snapshot, mapped to screenshot coordinates. The screenshot and existing driver remain available. Key-name parsing matches MCP's case-insensitive contract. This is not full semantic-action implementation or universal live acceptance.
- **Step 4 / Claude-owned:** T47 remains with Claude; no pill or microphone implementation was overwritten by Codex. Real microphone and integrated voice-task acceptance remain required.
- **Verification:** The focused state, delivery, MCP, Cua driver, task actions, desktop stage, and runtime identity suite passed 161 tests. Final typecheck and diff whitespace checks passed; the final ownership/reconciliation subset passed 10 tests. These tests use local fixtures and do not prove a live provider task or physical-pointer isolation on this machine.
- **Live acceptance blocker:** The provider-managed M9R tool connection returned `Transport closed`. This session exposes no provider-managed reconnect control. No detached MCP process was launched as a substitute; no live build was installed or pill restarted for this checkpoint.
- **Appended finding F11 / dependency audit:** Read-only production dependency audit reported 8 vulnerabilities (7 high, 1 critical): MCP SDK and its dependent provider packages, proxy-addr, sharp/Next, and source-map-js. Requires scoped compatibility review and targeted upgrades; do not run forced dependency upgrades against Claude's active work. This finding is appended and does not replace the cumulative order.

This status combines the owner's observed T47 result, the 2026-10-10 runtime cleanup, and canonical project documents last updated 2026-10-07 through 2026-10-09. Older roadmap statuses are historical until rechecked against current artifacts.

### Verified or recorded as completed

- The T26 malformed-identity diagnosis was that a 31-character token reached the stage call where 32 characters were expected. The misleading error was corrected in commit 98f8b144. This closes that malformed-length case only.
- Seven Codex/Claude M9R MCP child processes were mapped to retired engine images. Those exact stale children were stopped; two retired engine files and one retired broker file were removed; stale manifest paths were pruned.
- The source change for removing missing retired-image paths from the runtime manifest was committed as 6a4d0d23, “Prune stale retired runtime manifest entries.”
- At the recorded cleanup check, build identity/hash checks matched the installed engine metadata, the manifest had no missing runtime paths, no retired runtime images remained, and broker health returned healthy. The focused installer and native tests and typecheck recorded for that change passed.

### Still unverified or known open

- Stopping stale provider MCP children closed the active provider transports. The subsequent M9R identity call returned “Transport closed.” Provider-managed reconnection on the current build has not been verified. Do not start a detached engine MCP process as a substitute for provider-managed stdio wiring.
- T47 dictation failed in the owner's live test: Alt+M opened the composer, but there was no microphone prompt, listening animation, or recognized text. Claude owns the isolated fix. It remains IN PROGRESS until code review, tests, and a real microphone acceptance pass.
- T27 recorded a separate stage-path identity/runtime discrepancy: stage returned a stale generic authorization error while other identity calls worked. Its exact handler or input transformation was not located. The last broker-health check was healthy, but the earlier “ready” marker/listener discrepancy and stage readiness must be rechecked after provider reconnection.
- The connected-tool schema/parser mismatch, universal app/window operation, owner-mouse isolation, one-shot delivery across actual providers, extension readiness, multi-agent active-session work, and repeatable live desktop acceptance are not signed off.
- The working tree contained pre-existing modifications and untracked files when this tracker was prepared. Preserve them until ownership and references are established; do not clean or overwrite them by guessing.

## 3. Required prerequisite before live runtime changes

This is the original requested order for building and installing a runtime, retained as a safety gate before step 1 changes any live installation:

1. Record the source commit, branch, dirty paths, installed build ID, image paths, and process-to-image mapping. Preserve unrelated changes.
2. Build from a clean, committed source state. If the current checkout is dirty, use a clean verified source snapshot without discarding or silently excluding the owner's changes.
3. Compare the produced engine, broker, pill, native-input host, overlay, and manifest hashes to the exact package manifest. Record provenance for each artifact.
4. Do not update the live runtime until all expected hashes and component versions match. Stage the full compatible set, switch atomically, and retain a rollback target.
5. Verify the installed image paths and hashes, then probe broker health. “Ready” must reflect a live, version-matched health check.
6. Reconnect through the normal provider-managed MCP integration and verify its reported build/session fingerprint. Only then run a fresh harmless task.

This sequence prevents a successful local build from being mistaken for the build actually used by the broker or provider MCP process.

## 4. Cumulative implementation order

The order below is cumulative and remains fixed. The nine attachment findings are mapped into these steps. Newly discovered issues are appended with an ID, priority, evidence, owner, and closure test; they do not replace existing items.

### Step 1 — Identity and runtime consistency

**Maps to:** Attachment findings F1 and F2; the clean-build prerequisite; T26/T27 identity and runtime reports.

- Make the connected tool schema, parser, engine, broker, hooks, pill, and native-input host report compatible build identity. Generate the tool contract from the same source as the parser; reject incompatible versions with a useful non-secret diagnostic.
- Ensure hooks, broker, and MCP use one explicit state root and a verifiable identity mapping. Preserve corrupt or future-version state for recovery; do not silently replace it with empty state.
- Use owner-aware locks and safe versioned migration. Diagnose the reported .m9r/state.lock permission failure instead of masking it.
- Keep provider-session identity and selected project/working-folder identity distinct. A System32 working folder must produce a clear project mismatch, not be “fixed” by hard-coding this repository path for every user.
- Resolve the T27 stale stage authorization response and verify broker-ready state against a live listener and build fingerprint.
- Reconnect Codex and Claude through their normal provider-managed MCP integration and verify both point to the current installed engine. Do not launch a separate detached MCP process.

**Acceptance:** Tool description and parser agree; all relevant processes resolve to the same versioned runtime; state-root and identity probes agree; corrupted state is preserved; a fresh harmless task reaches the installed stage route without a token transcription mismatch.

**Current status:** PARTIAL. T26 malformed-length handling and stale-image cleanup are recorded as done. Provider transports are currently unverified after cleanup; T27 and tool schema/parser discrepancies remain open.

### Step 2 — One-time task delivery and truthful lifecycle

**Maps to:** Attachment findings F4, F5, and F6; previously reported replay, queue, stale task ID, “sent”/“working” mismatch, and provider-session issues.

- Reconcile a stage action after timeout before retrying. Every mutating action needs an idempotency key and durable operation receipt; report “outcome unknown” if completion cannot be established.
- Use a durable outbox and atomic claim/lease/ack for provider task delivery. Reconcile replay side effects and missed wakeups.
- Expose separate accepted, queued, delivered, started, and completed states. Do not claim delivery when detached runner startup failed.
- Make task IDs stable and tied to the intended provider connection, task, and project session. Prevent duplicate injection under concurrent dispatch, replay, or reconnect.
- Never show “working” based only on an old delivery marker. Use fresh provider/process evidence; show stopped, failed, deferred, stale, disconnected, or unknown truthfully.
- Preserve provider sessions across phases where the provider supports it. Surface terminal provider/model errors rather than reinjecting the same task or silently starting a new session.

**Acceptance:** Repeated/concurrent sends deliver once; injected prompt, task identity, project, and provider session match; lost responses are reconciled before retry; terminal state cannot be overwritten by a late heartbeat; the pill reflects real activity and actual failure.

**Current status:** PARTIAL at most. Receipt/idempotency code and tests exist in parts of the tree, but the provider-to-broker timeout/replay lifecycle has not been signed off end to end.

### Step 3 — Desktop-wide targeting and independent input

**Maps to:** Attachment finding F3; ordinary-app/browser/site requirements; stage/app/action failures; physical mouse movement; Pine-inspired accessibility-first control.

- Implement generic discovery and resolution for ordinary installed apps and windows. Do not use a Chrome/Notepad/Terminal allowlist. Support normal launch forms, shortcuts, Start/taskbar selection, Explorer-launched processes, and exact process/window adoption.
- Distinguish “launch requested,” “process started,” “window found,” “window focused,” “input sent,” and “effect verified.” Opening an app must not be reported as successful control of its window.
- Keep browser page actions, extension/profile capabilities, native OS windows, and stage input as explicit routes with visible capability reporting. Pin a selected route for an operation; do not silently switch transports.
- Expose fresh accessibility structure when available, with screenshot/coordinate fallback when it is not. Keep the current driver as a fallback until an accessibility-first implementation passes the same acceptance suite.
- Support clicks, double-clicks, typing, keys/hotkeys, scrolling, dragging, capture, window focus/adoption, and ordinary navigation without requiring users to narrate coordinates or every click.
- Verify that a labeled agent cursor and its input do not move or seize the owner's physical pointer. A Windows virtual desktop by itself is not proof of pointer/input isolation.
- Refuse unsupported or unverified target classes clearly. Do not silently fall back to foreground input on the owner's desktop.

**Acceptance:** A real provider task opens or restores the requested visible app/window, uses its actual window, performs and verifies a harmless multi-step task, shows the correct agent cursor, and leaves the owner's physical pointer and unrelated windows alone. Repeat on varied apps and natural paraphrases.

**Current status:** PARTIAL implementation; live acceptance OPEN. Bounded accessible targets and screenshot fallback exist and pass fixture checks. User-observed physical mouse movement and failed T38–T46 tasks remain unresolved acceptance evidence.

### Step 4 — Live pill dictation

**Maps to:** Attachment finding F7; failed T47; the earlier Alt+M requirement.

- Complete Claude's scoped pill fix: Alt+M hold-to-talk and the mic button use the same path; show permission/setup and listening/interim feedback; insert recognized text exactly once into the composer; never auto-send.
- Handle mic denied, no device, recognition unavailable, start failure, release/cancel, and stop cleanly. Do not leave a stale listening animation.
- Treat draft dictation, live partial transcription, explicit task submission, and any future speech-to-task dispatch as distinct states. The current T47 acceptance is draft-only; do not change it into implicit auto-send.
- Verify behavior in the desktop pill, not only a mocked speech environment or browser extension.

**Acceptance:** The owner sees the mic/listening state, speaks a phrase, sees one correct transcript in the draft, releases/stops, and confirms nothing was sent until explicit submission.

**Current status:** IN PROGRESS with Claude. The live T47 run failed and is not signed off.

### Step 5 — Provider adapters and a shared native session

**Maps to:** The seven-step broader defect/roadmap list; active-session cross-provider requirement.

- Build the shared M9R coordination surface for named people and agents to speak, show attributed status, steer, hand off, return work, and let the original agent resume.
- Start with Codex, Claude Code, and OpenCode paths that are supported by their actual session protocols. Preserve reusable sessions.
- Keep a shared M9R conversation distinct from a provider-native active session. Do not claim an agent entered another provider's live session unless it visibly works inside that session and the caller resumes there.
- Do not mistake queued inbox delivery, an @mention, an MCP call, or later result injection for active-session collaboration.

**Acceptance:** Prove both Codex→Claude and Claude→Codex in the caller's active session; prove OpenCode directions where the integration supports it; show the recipient working, returning an attributed result, and the caller reviewing and resuming.

**Current status:** OPEN for live active-session acceptance. Personal-agent Network Core Phase 1 is a separate parked track.

### Step 6 — Pill clarity and visual pass

**Maps to:** The broader defect list and the recorded visual/product requirements.

- Show truthful live agent state, full readable task text, current app/site and desktop, and useful per-agent detail.
- Present readable provider names and stable proposed colors (Claude orange, Codex blue, OpenCode green) while retaining unique internal session identities. Remove hash-shaped badges from user-facing identity.
- Fix stale “working” labels, clipped messages, duplicate/low-value chatter, and identity popping in/out. Keep task events concise and deduplicated.
- Preserve the recognizable provider logo while making sender and current activity clearer. Keep the composer less cramped; add durable conversation/task history and context recovery.
- Research Kyzo's One for visual ideas. Treat this as design research, not a runtime dependency.
- Performance work follows observed timings: reduce avoidable screenshots/round-trips, use structure when fresh and available, and measure cursor/action latency without weakening correctness or isolation.

**Acceptance:** Activity comes from real provider/process/window signals; app/site/desktop is accurate; messages remain legible and deduplicated; provider identity is stable; the visual pass is tested at the actual pill size.

**Current status:** OPEN; defer polish work that risks changing runtime behavior until steps 1–5 are stable.

### Step 7 — Repeatable acceptance and demo gates

**Maps to:** Attachment finding F8, all six local demo gates, and post-gate provider acceptance.

- Use varied ordinary-language requests: short, vague, detailed, and multi-step. Test app/site variation chosen by the owner; do not special-case only three fixtures.
- Repeat tasks across clean provider reconnects, app open/restore states, and supported browser routes.
- Record action receipts, build/session identity, visible result, cursor identity, and whether the physical owner pointer moved.
- Accept each demo gate only from retained evidence, not from expectation or one reported success.

**Current status:** OPEN. No complete repeatable user-task acceptance is recorded for the current build.

## 5. Attachment findings: canonical inventory and mapping

| ID | Priority and finding | Cumulative step | Proper closure test |
|---|---|---|---|
| **F1** | **P0 — tool schema and running build can disagree.** Connected stage schema, checked-out parser, installed hashes, and artifact provenance can differ. | Step 1 and prerequisite | Contract/parser generated together; every connected component reports matching build ID/hash; incompatible versions fail clearly; staged install rolls back safely. |
| **F2** | **P0 — identity and local state can split or reset.** Explicit M9R_HOME may differ from hook defaults; corrupt/future state and unsafe lock recovery can lose identity/state. | Step 1 | One state root and identity mapping; corrupt data preserved; owner-aware lock/migration tests; correct project/session identity. |
| **F3** | **P0 — app launch is not window control.** App discovery/window matching/input coverage are incomplete; agent contract is coordinate-based despite internal accessibility data. | Step 3 | Generic discovery, exact process/window adoption, fresh accessibility first with visual fallback, action-state receipt, real app proof without allowlist. |
| **F4** | **P0 — a failed response can hide a successful action; retry can duplicate it.** Side effects may precede capture/authorization failure and clients may time out while broker work continues. | Step 2 and Step 3 | Stable action idempotency key, durable receipt, reconciliation before retry, honest unknown outcome. |
| **F5** | **P0 — delivery can be reported before it starts.** Concurrent Codex dispatch, swallowed runner errors, and incomplete replay reconciliation can misstate delivery. | Step 2 | Atomic outbox claim/lease/ack, distinct lifecycle states, no “sent” before provider start, replay test. |
| **F6** | **P1 — bridge/task state can race or mislead.** Polling, terminal state, leader election, and transient startup handling can race. | Step 2 and Step 5 | Atomic claim/ack, terminal compare-and-set, real lease, bounded retry, normalized durable event. |
| **F7** | **P1 — pill activity can be stale and dictation is not live.** Cached probes and stale turn markers mislead; T47 microphone/listening/transcript failed. | Step 4 and Step 6 | Real live-state correlation; mic permission/start/failure feedback; one transcript insertion; explicit send; stale states visible. |
| **F8** | **P1 — browser extension readiness is ambiguous.** Hard-coded port, competing browser instances, weak readiness, and DOM limits complicate routing. | Step 3 and Step 7 | Instance/build-aware handshake; probe real connection; show route/capabilities; retain or replace extension capabilities intentionally. |
| **F9** | **P1 — install/update can leave mixed versions.** Sequential updates and premature cleanup can leave components mismatched or stop the pill before success. | Prerequisite and Step 1 | Versioned staging, all-component hash check, atomic switch, rollback to last known good, safe pill restart, second-machine proof. |
| **F10** | **P2 — worktrees and generated state are not fully classified.** Earlier inventory reported 20 registered worktrees, dirty checkouts, scratch/build data, and old worktrees with mass deletions. | Cleanup after P0, without changing fix order | Refresh inventory, identify owner/references, preserve snapshots, remove only individually verified unreferenced artifacts. |

F10 is an appended cleanup finding from the earlier audit, not a replacement for F1–F9. The current checkout also had pre-existing modified and untracked files on 2026-10-10. Their presence is not proof that they are stale.

## 6. Previously recorded defects not to lose

These are carried into the nine findings and cumulative steps, but remain explicit regression targets:

- T26 malformed token length versus T27 stale stage authorization handler; do not collapse both into “bad token.”
- Broker autostart “ready” versus actual listener/health disagreement; latest health was healthy, but repeat after provider reconnection.
- Provider MCP processes loading retired engine binaries; local stale images were removed, but managed provider reconnect and current-build verification remain.
- .m9r/state.lock permission error and unsafe recovery; preserve state and report ownership/permission clearly.
- System32 versus project working-folder mismatch; preserve selected project identity and explain a mismatch without hard-coding this repo for all users.
- Task IDs, queue replay, duplicate injection, missing in-flight claim, lost wakeups, and truthful accepted/queued/delivered/started/completed state.
- Cursor spasm/parking, cursor not moving from app icon to input target, taskbar/window restore/focus handoff, and owner physical mouse movement.
- Chrome window adoption: use the requested personal Chrome/profile when asked; never substitute a separate blank or hidden browser window.
- Browser-extension readiness/timeouts and route confusion; page-level CDP/extension behavior is distinct from native OS stage behavior.
- Stale pill “working” state, clipped task text, repeated messages, poor provider identity labels, and missing app/site/desktop activity.
- Dictation did not request/show mic permission, animate listening, or place recognized words in the composer on T47.
- Install/update left stale locked images or mixed components in the past; cleanup and local atomic engine staging do not alone prove signed updates, rollback, or second-machine reliability.
- One successful synthetic cursor proof or fixture test is not a substitute for a real connected provider task.

## 7. Demo acceptance gates

All six local gates must pass before a demo is called ready:

1. **One real agent, one ordinary task:** the agent infers normal UI steps, opens or restores an installed app using the correct window, and completes a harmless multi-step action. The requested browser proof uses the owner's personal Chrome, not a surprise profile/window. The labeled cursor is visible; the owner pointer stays still; the result is visible.
2. **Two agents:** distinct identities and cursor/session ownership; each can join/return/revoke as designed; one agent cannot erase or misattribute the other's work.
3. **Three agents/shared desktop:** three live identities are distinct; explicitly shared desktop/session behavior works without duplicate or replayed tasks.
4. **Browser route and cursor bridge:** understand and prove personal-profile extension behavior, CDP route, and any native cursor bridge before retiring the extension. Routes/capabilities are observable and do not silently switch.
5. **Delivery and safety:** one-shot delivery, useful terminal failures, truthful live activity, persistent owner approvals, and revocation. Ordinary app use does not require a per-app catalog; agreed high-impact actions still require the defined human gate.
6. **Install lifecycle on machine two:** clean install, sign-in startup, task delivery, restart persistence, and supported update path with matching artifacts and rollback evidence.

After those six, prove active-session cross-provider work in both directions. Codex and Claude must work inside each other's actual active session, with OpenCode directions tested where supported; the recipient works visibly, returns attributed output, and the caller reviews and resumes. Queued mentions and later result injection do not pass.

The C1/C2/C5 sign-offs recorded in the older wave plan remain historical evidence. C1's isolated/dedicated Chrome proof does not satisfy the newer requirement for the owner's personal Chrome; that acceptance must be reopened/re-scoped. C14's owner-session fixture proof also does not prove a real connected agent action through the installed pill.

## 8. Roadmap after and around the demo

The roadmap remains active; demo completion does not erase it:

- **C3 — PARTIAL / deferred by sequencing:** reviewed Cloudflare build/deployment and two-machine changing browser-frame proof. It is browser-tab relay, not desktop-frame relay.
- **C4 — REMAINING:** safe stage takeover/hand-back lease proof.
- **C6 — PARTIAL:** workspace/profile/site/room product model and consent behavior.
- **C7 — PARTIAL:** machine enrollment and registry.
- **C8 — PARTIAL:** signed, replayable room evidence and replay viewer.
- **C9 — DECISION REQUIRED:** directly compare scheduler scope and correct unsupported product claims before freezing implementation.
- **C10 — PARTIAL:** hosted-browser feasibility, current limits/cost/sign-in persistence.
- **C11 — PARTIAL:** DPAPI-backed reviewed-login design.
- **C12 — PARTIAL:** separate evaluation of Jev versus CUA-S1; do not replace Jev or confuse the two roles.
- **C13 — PARTIAL:** two-agent-plus-person benchmark and scorecard.
- **C14 — PARTIAL:** prove desktop actions through the visible pill and broaden real-app validation.
- **C15 — OPTIONAL, not a demo gate:** revisit custom desktop tiling only if Windows Task View plus the roster is insufficient.
- **Network Core Phase 1 personal-agent interoperability:** separate and parked for the current demo focus. It has not been live-accepted with Muse, Dots, or Grok Bot.
- **Cross-machine desktop relay/control:** separate from C3 browser-tab viewing; requires enrollment, read-only frame relay, and a later source-machine lease.
- **Product/release:** one understandable install/onboarding flow; clear supported update and rollback; accurate README/setup and waitlist wording; licensing/open-core decision; Stripe payment/webhook acceptance if charging.

Pine-inspired accessibility-first computer use belongs under Step 3. Preserve the current driver as fallback; expose fresh structured controls where available; use screenshot/coordinates as fallback; compare the same tasks and latency before changing the default. Pine's cloud offering or reported benchmarks are not a substitute for M9R's local provider-native acceptance.

The product/visual requirements still carried forward are: stable provider colors and readable identities; truthful agent activity and location (app/site/desktop); clean non-spammy multi-agent messaging; dictation in the pill; durable task/conversation history and context recovery; Kyzo's One visual research; and performance measurement for capture, routing, and action latency. These are not signed off by the current runtime cleanup.

## 9. Work ownership and concurrency boundaries

### Codex — primary owner

Codex owns Steps 1–3, the runtime/build prerequisite, integration across broker/provider/installer/stage, live end-to-end acceptance, and the final cross-file review. Codex will preserve dirty changes, avoid broad cleanup by guesswork, and will not mark a finding CLOSED until its acceptance evidence is recorded.

Codex will first restore/verify provider-managed connections and current-build identity, then work through the nine findings in the cumulative order. Any live install/restart happens only after clean-source provenance, artifact hashes, rollback readiness, and pre-install tests are verified. No promise of zero defects is implied; sign-off means the defined gates passed on recorded evidence.

### Claude — isolated current task

Claude owns T47 only: pill dictation implementation in pill/** and its scoped speech tests. Required result: visible permission/listening behavior, recognized text inserted once in the composer, and no auto-send. The owner's reported failure is the baseline. Claude must return the changed-file list, test commands/results, and any limitation; this is not accepted until reviewed and live microphone behavior is verified.

While Codex works on runtime, delivery, stage, and install paths, Claude may separately prepare a **read-only** acceptance matrix for Steps 2–3 and demo gates, using varied natural-language tasks and observable pass/fail signals. It must not edit this tracker or runtime/stage/bridge/extension/installer files in that parallel task.

### Claude must wait before

- Editing task delivery, identity/state locking, bridge/provider adapters, stage tools, browser transport, installer/update, or runtime cleanup owned by Codex.
- Installing, restarting, deleting, committing, or changing live M9R runtime state.
- Expanding T47 into automatic task submission or live task dispatch; the current T47 acceptance is draft-only.

After T47, any new implementation ownership should be assigned by file and acceptance boundary before edits to avoid overlapping changes in the shared checkout.

## 10. Cleanup inventory and preservation rule

The 2026-10-10 checkout status included modifications to:

- scripts/stage1-acceptance.mjs
- services/mission-bridge/src/bridge-runtime.ts
- src/app/sitemap.ts
- src/components/product/SettingsView.tsx
- src/lib/bridge/acp-stdio-adapter.ts
- src/lib/bridge/codex-app-server-adapter.ts
- src/lib/bridge/dev-mcp-server.ts
- src/lib/marketing-content.ts
- src/lib/mission/mission-provider-adapter.ts
- src/lib/workspace-rules-service.ts

It also included untracked .codex-committed-b4bc3f42/, .test-tmp/, and docs/Convenience_Store_Replacement_Plan.docx. These were intentionally preserved. Before any cleanup, determine who owns each item, whether it is referenced by a build/release/test, and whether a recoverable snapshot exists. No blanket deletion of worktrees, ignored files, executables, or docs.

## 11. Update protocol

For every new finding:

1. Append a unique ID, priority, observed evidence, root cause confidence, owner, and fix/acceptance test.
2. Map it to an existing cumulative step. Add an appended step only if it is genuinely outside the current seven; never renumber/rewrite passed evidence.
3. Record implementation separately from verification. Mark CLOSED only after source review, regression verification, and the relevant integrated/live acceptance.
4. Preserve the prior baseline and record commit/build IDs and hashes for installed changes.

This tracker is the working plan until all required demo gates are accepted. Roadmap work, optional C15, and public-launch readiness stay visible even when they are not current demo blockers.

## Source records

### 2026-10-10 package and app-launch receipt follow-up (steps 1–3)

- Setup now validates the canonical manifest digest and every declared companion hash before planning installed-file changes; missing, tampered, or redirected companions are rejected. The installer fixture now includes the complete Cua driver tree instead of silently omitting it. Its new full-package acceptance is still pending.
- MCP and broker desktop action validation share the exported action schema, including hotkey validation. Key spelling normalization remains in the broker parser.
- App selection/launch now carries a durable operation receipt through MCP, client, authenticated owner pipe, and stage service. Replays after success or uncertain capture do not launch again. Legacy network callers without a receipt are rejected before dispatch. Original driver messages are preserved in uncertain-launch errors.
- Verification: 108 stage/action/MCP/pipe/broker regressions passed; an additional 84-test identity/setup/MCP/stage/pipe run passed with the explicit launch transport check. These overlapping counts are not added together. Generated CLI build passed. TypeScript passed before the final diagnostic-message-only edit; final recheck remains pending.
- Production dependency audit still reports eight findings (seven high, one critical), retained under F11. No dependency upgrade, live runtime replacement, pill restart, or real cursor acceptance occurred in this follow-up. Claude's T47 source remains separate and preserved.

### 2026-10-10 desktop transport follow-up (steps 1–3; acceptance remains open)

- Preserved local checkpoint `22f9053d`; its clean archived source passed 161 focused regressions. No runtime installation or pill restart occurred for this checkpoint.
- Confirmed a transport inconsistency: agent task-state writes use the owner named pipe, while desktop prepare/app/action required the owner key and HTTP. Desktop operations now use that same local pipe when configured, with shared identity/task validation and no HTTP fallback. Owner approval endpoints remain unavailable through the agent pipe.
- Pipe responses support bounded captures up to 4 MiB, retain 64 KiB request limits, and allow a bounded desktop deadline. Additional socket chunks cannot dispatch an in-flight request twice.
- Windows lock publication retries transient sharing errors within its existing deadline without deleting another writer's lock or replacing atomic state publication.
- Verification: 51 broker/transport tests, 77 state/delivery tests, and 4 pipe tests passed; the latter includes extra-chunk one-shot dispatch and desktop requests with unavailable HTTP/key access. These are fixture regressions, not live cursor acceptance.
- After the owner restarted Codex, this chat's M9R connection still returned `Transport closed`. Existing broker HTTP health and read-only named-pipe probes did not yield a healthy response. Process probes disagree, so no crash or sole underlying cause is claimed. Clean build verification and installed-runtime recovery remain required before task-ready sign-off.

### 2026-10-10 update, capture, and activity follow-up

- Local transport checkpoint: `d3f93406`. The clean overlay build from `22f9053d` completed; no overlay/pill source changed between these two commits. This does not yet mean the full new runtime is built or installed.
- F9 implementation: engine setup now stages and verifies all planned runtime files, preserves the prior set and a transaction journal, verifies installed hashes, and restores already-replaced files after any component failure. It is a quiesced file transaction, not an atomic directory switch. Broker ownership, complete manifest parity, configuration failure recovery, power-loss recovery, and real installed rollback acceptance still require verification.
- F3 implementation: exact-window accessibility capture is bounded to 200 elements and retains a screenshot-only fallback on structure failure. It never switches windows, activates foreground input, or moves the owner pointer as a fallback. The 35 driver checks passed, including this fallback; the broader stage/MCP/identity subset passed 84 checks.
- F6 implementation: feed leadership no longer uses a read-then-write file race. Ownership is published as a populated directory; duplicate watchers in one process are refused, live/unknown owners are preserved, and only demonstrably dead owners are recovered. Failed activity probes discard prior successful activity instead of displaying it as fresh. Corrupt local state remains preserved rather than silently resetting the roster. The 20 feed/activity checks passed.
- Runtime transaction tests: a third-component failure restored both prior components and removed the newly introduced component; missing/invalid sources cannot partially apply. Both checks passed, along with all 32 native setup checks. The combined installer/build/native/transaction suite passed 49 checks, including consent decline, package SHA rejection, install/uninstall, and broker ownership preservation. Packaged installer checks used the previously available engine distribution; rerun against the new committed package before accepting its live installation.
- Owner reported Claude may be updating/restarting the live runtime for T47. Codex is preparing source/builds and withholding overlapping live runtime changes until that work is coordinated. T47 remains excluded from Codex implementation ownership.
- Follow-up: interrupted `applying`/`rollback_failed` journals now require verified prior hashes before recovery; duplicate or redirected destinations are rejected. Setup treats pending recovery as work even when installed hashes match. The combined capture/feed/setup/recovery suite passed 85 checks outside the Windows sandbox; the sandbox run was denied temporary-directory renames and is not counted as a product regression pass. TypeScript verification passed. Recovery remains source/fixture verified, not accepted on the owner's live installation.
- Checkpoints: `ed766485` preserves recovery/capture/feed fixes; `b98651f3` includes the new recovery module in the CLI generator; `ebdf44e9` makes CLI publication validate generated setup imports. The clean build exposed that packaging omission before installation. The actual generated dependency graph resolves, and a missing module is rejected.
- Clean package built from `b98651f3` source (archive base `ed766485` plus its sole committed build-script change): build ID `c203ee1d66e60ea68b2ef752ef6edb3982fd6cf11384927484dde23b1f135c58`, exactly 185 verified artifacts. Overlay provenance is `22f9053d`, with an unchanged overlay/pill subtree and SHA-256 `02b3ee776f90f7ef125d1850cb4e44c54033361c91f0e607577a8cc7c88ad899`. This package excludes Claude's still-uncommitted T47 implementation. Do not install it over that work without coordination.
- The committed build guard and CLI package passed 19 external-folder checks. All 12 installer checks against the new binaries passed in isolated temporary profiles, including actual engine installation/uninstallation, broker ownership refresh/preservation, consent decline, and bad SHA rejection. The installer test fixture uses a reduced package, so this is not acceptance of the owner's complete installed Cua/pill set or Claude's T47 changes. No owner-runtime installation or restart was performed by Codex in this follow-up.

- Owner audit attachment received 2026-10-10: nine findings F1–F9 and their proposed fixes.
- docs/M9R_AUDIT_CHECKPOINT_2026-10-07.md, including the 2026-10-09 T26/T27 addenda, seven-step cumulative order, demo gates, and carried-forward requirements.
- docs/M9R_CUA_WAVE_PLAN.md, current roadmap status record dated 2026-10-07.
- docs/M9R_WINDOWS_DESKTOP_STAGE_ACCEPTANCE.md, detailed stage, cursor, task lifecycle, and browser/native route acceptance.
- docs/M9R_EXTENSION_ISSUES_2026-10-05.md, extension-specific open acceptance evidence.

### 2026-10-10 Claude desktop-control reliability audit (F12–F17)

Independent diagnosis-only pass requested by the owner, run by a Claude subagent against the live working tree (uncommitted edits present in `task-desktop-stage.ts`, `task-stage-actions.ts`, `mcp-server.ts`, `web-broker-client.ts`, `web-broker-server.ts` at audit time) plus a live read-only Windows API probe and the task history in `~/.m9r/state.json` / `~/.m9r/windows-stages.json`. No files were edited; no runtime was installed or restarted. Findings are appended per section 11; they refine F3 rather than replace it, and are offered as additional verification, not a correction of intent.

| ID | Priority and finding | Confidence | Step | Owner |
|---|---|---|---|---|
| **F12** | Owner-preview desktop identity is read from `GetWindowDesktopId` on the current foreground window (`native-input-host/src/virtual_desktop.rs:1190-1215`, introduced by commit `eaeee865`, 2026-10-07). Live-probed on this machine: the M9R pill's own window and ApplicationFrameHost-hosted apps (Calculator, Settings, Store-style apps) return success with an all-zero desktop ID and `IsWindowOnCurrentVirtualDesktop = TRUE`. The existing check accepts this as a valid match. A saved stage (`preview-agent-84acbf7a…` in `~/.m9r/windows-stages.json`) already carries this all-zero ID, and T45/T46 in `state.json` show the exact downstream errors ("not on the owner's current desktop", "desktop changed before application presentation"). | HIGH — verified live against the Windows API, in code, in saved state, and in the task log. | Step 1 and Step 3 (desktop identity feeds every later `inspectStage`/`act`/`presentOwnerWindow` comparison in `windows-desktop-stage.ts` and `task-desktop-stage.ts`). | Codex |
| **F13** | Every stage input path passes `InputDeliveryMode.Background` only (`cua-stage-driver.ts:1056`, `:1240`); there is no agent-facing way to request foreground delivery. Cua Driver itself refuses background keyboard input to Chromium and Windows Terminal targets and suggests foreground delivery in its own error text (T40, T42, T43, T44 in `state.json`), but the stage-action tool schema rejects any extra field an agent would need to ask for it (`task-stage-actions.ts:17-26`, `:49-50`) — confirmed by T44's literal `Invalid stage action fields` failure. This is the concrete mechanism behind "opens Chrome, then stalls": the launch succeeds, the next keystroke has nowhere to go. | HIGH — verified in code and matched against five distinct task-log failures. | Step 3. | Codex |
| **F14** | Independent of F12/F13, a chain of fail-closed checks must each individually succeed on every multi-step task: a 30-second capture-to-click expiry (`cua-stage-driver.ts:613-621`) that model think time can exceed; any agent's input invalidates every agent's current capture (`:623-626`); an unlabeled click is held for a 55-second owner-approval wait before auto-refusing (`task-stage-actions.ts:98-103`, matches T18); every prepare/act/launch call across every agent shares one action queue (`task-desktop-stage.ts:148`, `:230-232`, `:307-309`); and a timed-out call is reported back as "may have been applied, do not replay," converting a transient failure into a permanent stop (`web-broker-client.ts:93-95`, `:117`). None is individually fatal; compounded across a 15–20 step task the subagent estimates roughly 5–20% success even without F12/F13, consistent with the owner-reported "2 in hundreds" rate. | HIGH on each check existing in code; the compounded success-rate estimate is inference, not a measurement. | Step 2 and Step 3 (overlaps F4/F5/F6: the receipt/idempotency mechanism intended to fix delivery truthfulness is also what turns a timeout into a permanent stop here). | Codex |
| **F15** | App discovery/window matching is a hand-written layer beside Cua (alias table plus hard-coded paths in `task-stage-apps.ts:157-216`, a PowerShell App-Paths/Get-StartApps/`.lnk` inventory in `windows-installed-apps.ts:42-121`), matched to windows by executable-name equality (`task-stage-apps.ts:59-68`). This fails deterministically, not randomly, for: Squirrel-installed apps whose shortcut target is an updater exe (Discord/Slack-style — the real window's executable name never matches); frame-hosted packaged apps (also hits F12's empty desktop ID); any already-open single-instance app other than Chrome/Edge (only browsers have a reuse-existing-window path, `:363-372`); and Chrome/Edge with more than one window open (`onScreenOnly:false` at `:362` includes minimized/other-desktop/PWA/DevTools windows, so more than one match throws). The literal string "unknown app" does not exist in current source; the live error is `The app "X" is not installed or could not be resolved on this machine.` (`task-stage-apps.ts:215`). | HIGH for the code paths; Cua's own expected `appName` format on Windows was not independently confirmed, so the full reach of this finding is not settled. | Step 3. | Codex |

| **F16** | Real failure detail is lost before it reaches the agent or any log the owner can read. Cua SDK errors carry detail in `.inner` (`cua_driver_sdk.js:2071-2084`); `stageFailure` only unwraps the outermost `.inner` (`web-broker-server.ts:106-124`), and both the mutating-action and launch paths re-wrap using only `.message` (`task-desktop-stage.ts:289-290`, `:559-562`, and `cua-stage-driver.ts:786-788`), which is why T5's agent saw only the literal string `DriverError.Tool`. Capture failures are similarly flattened behind a generic `AggregateError` (`:895`), and every transport failure (timeout, broker down, process crash) collapses to the same "response was lost" message (`owner-pipe.ts:77-101`). This is offered as a likely reason root cause has been hard to pin down across repeated prior fix attempts: the signal needed to diagnose it was being discarded before anyone could read it. | HIGH for the code paths; the claim about why past diagnosis attempts struggled is inference. | Step 3 (diagnosability, not a functional defect on its own). | Codex |
| **F17** | At audit time, three `m9r-engine` processes were running concurrently, at least one (PID 29844, started 17:35) predating the 18:43 runtime install, and about 18 commits touched the affected files between 2026-10-09 and 2026-10-10. The broker now rejects launch/input calls that lack a receipt ID with HTTP 409 (`web-broker-server.ts:543-544`, `:556-557`); an older broker build rejects the newer `operationId` field. Any mix of old and new MCP/broker builds running at once fails every call between them, independent of F12–F16. | HIGH for the facts observed; the practical frequency of this specific mismatch causing a given failure is not separately measured. | Step 1 (runtime/build consistency prerequisite). | Codex |

**2026-10-11 T49 owner-task evidence — F12 remains OPEN for live acceptance:** `m9r_stage_prepare` succeeded, but the saved owner-preview stage still had the all-zero desktop ID. `m9r_stage_app` failed with `requested application is not on the owner's current desktop`; the subsequent taskbar click failed with `The owner-visible preview stage is not on the owner's current desktop.` No text was typed. The failure maps directly to `present_owner_window` comparing the requested window's desktop ID against the saved stage ID. The installed runtime manifest reports build time `2026-10-10T22:56:04.076Z`; the committed native zero-ID fix is dated `2026-10-10T23:29:30-05:00` (2026-10-11T04:29:30Z), so the installed package predates that fix by about 5h33m. This is confirmed build/source mismatch evidence and the strongest explanation for T49; it is not owner-task proof that the new build works. A second source gap was found: the TypeScript stage boundary accepted a syntactically valid zero GUID. It now rejects zero IDs from native window/desktop results while still allowing the existing zero-ID registry entry to be safely rebound. Regression verification: task-stage suite 29/29 passed with temp redirected into the writable project area; native-input-host Rust suite 16/16 passed. **Next F12 acceptance:** produce a clean committed package, compare the complete artifact set, install/restart only after that comparison, verify live broker build/health, then have the owner send a fresh harmless task and observe it directly. No task-ready claim until that passes.

**Separate F17 provenance discrepancy observed during T49 diagnosis:** `web-setup-manifest.json` records native-input-host hash `f094…`, while the current file and `m9r-build-info.json` both record `0680…`. This is stale setup metadata relative to the installed runtime package; no evidence shows it caused T49. Reconcile the manifest-writing/update path in F17 rather than treating it as a second cause for the zero-ID failure.

**Where this agrees/disagrees with existing findings, stated plainly, not as a correction:** F3's "app launch is not window control, coverage incomplete" framing is directionally right but was written as a coverage gap to fill; F12 and F13 identify it instead as two specific wrong assumptions about what Windows and Cua Driver actually do (same class of error as the T47 dictation finding — a platform capability assumed to work that was never live-verified until now) plus one genuine coverage gap (F15). F4/F5's receipt mechanism is confirmed working as designed; F14 notes that the same mechanism, applied to a transient timeout, currently produces a permanent stop rather than a retry — a refinement of scope, not a reversal.

**Owner-proposed fix direction for F13 (superseded by Codex's design review below — kept for history only):** ~~use Windows virtual desktops as the resolution... with zero visible effect on the owner, since the owner is not viewing it~~. Codex's design review (see next section) found this specific claim inaccurate: Windows has one system-wide input stream, not one per virtual desktop, so a desktop only receives real foreground input while it is the one actually displayed. Virtual desktops remain the right answer for organizing each agent's own windows and for an explicit, visible "watch this agent" handoff; they do not by themselves give silent, simultaneous, real-input parallelism. Superseded by F18 below, which resolves the same problem a different way.

### 2026-10-10 Codex design review: Task View workspace is organizational, not independent input

Codex reviewed the owner's virtual-desktop proposal for F13 before any implementation. Finding: `IVirtualDesktopManager` can identify and move windows between desktops, but `SendInput` has no per-desktop pointer — input always goes to the one active desktop. Recommended design: a persistent Task View desktop per agent (stable identity, not derived from session ID as today), bound only to windows M9R can prove it launched, with a recoverable lifecycle (`provisioning`/`assigned`/`watching`/`retiring`/`orphaned`) instead of silent loss if Windows refuses to delete a desktop. "Watch an agent" is an explicit, single machine-wide input lease with clear on-screen notice that the owner's pointer is shared while it's active — not a passive view. The current native adapter uses private, undocumented Windows COM interfaces gated to builds 26100/26200 with no desktop-removal operation yet, so this needs build-specific integration tests, not just a design sign-off. No code or runtime changes were made in this review.

### 2026-10-10 Claude follow-up: F18–F20, resolving F13 without the shared-input limitation for most tasks

Prompted by the owner pushing back on the shared-pointer conclusion above. Verified directly against the installed `@trycua/cua-driver` package contract (`node_modules/@trycua/cua-driver/dist/native/cua_driver_contract.d.ts`) and M9R's own calling code (`src/lib/native/cua-stage-driver.ts`), not inferred from documentation alone.

| ID | Priority and finding | Confidence | Step | Owner |
|---|---|---|---|---|
| **F18** | Cua Driver already defines `ActionRoute { Accessibility, SyntheticEvents, GlobalInput, SystemApi, Dom, TrustedInput }` and `ClickPosition { Coordinates, Element, CapturedCoordinates }` as first-class, already-implemented options — Accessibility-routed, Element-targeted clicks do not require foreground/background delivery or a real shared cursor at all; that constraint applies only to `Coordinates`-targeted clicks routed through `SyntheticEvents`/`GlobalInput`. M9R's own code already prefers `ClickPosition.Element` when it has a resolved accessibility token (`cua-stage-driver.ts:1050-1053`) and only falls back to `Coordinates` when it doesn't — but always sets `deliveryMode: InputDeliveryMode.Background` regardless of which position type is used (`:1056`, `:1240`). **This reframes F13/F15: the gap is not "M9R can't do structural control," it's that element resolution fails often enough to fall back to the coordinate path, which Chrome/Terminal then refuse.** T18's "address-bar click withheld as unidentified" is this exact fallback happening live. | HIGH — verified directly in the installed package contract and in M9R's own calling code, not inferred. | Step 3 (narrows and supersedes part of F13/F15). | Codex |
| **F19** | Cua Driver separately defines an `ActionRoute.Dom` value, distinct from `Accessibility`, presumably for browser content specifically (CDP-backed or similar). No use of `Dom` was found anywhere in `cua-stage-driver.ts`. Whether requesting `Dom` for Chrome targets resolves the address-bar/dynamic-content fallback more directly than generic accessibility exposure is unverified — this needs a direct check against Cua's own docs/behavior, not an assumption either way. | Existence of the enum value: HIGH (verified in the type contract). Whether M9R should use it and what it would fix: UNVERIFIED. | Step 3. | Codex |
| **F20** | Whether an Accessibility- or Dom-routed action can succeed against a window on a virtual desktop that is *not* the currently active/displayed one is unverified in this codebase. If true, this resolves F13 and Codex's design-review limitation above for the large majority of actions (everything except the`SyntheticEvents`/`GlobalInput`-requiring fallback case), giving genuine simultaneous multi-agent action without the shared-input constraint, with virtual desktops (Codex's design above) providing the organizational layer on top. This is the single most important open question blocking the final F13 design and should be tested directly before further design work on this finding. | UNVERIFIED — plausible based on how Windows UI Automation is generally documented to behave (screen readers routinely interact with background/minimized windows), but not tested live in this codebase against an inactive virtual desktop specifically. | Step 3. | Codex (test), result shapes F13's final design |

**Product/safety requirement, not just a bug fix (owner-specified, binding on design):** no action may ever use a route requiring the real shared OS input device (`SyntheticEvents`/`GlobalInput`) without an explicit, visible, owner-acknowledged moment. Never a silent fallback into this path. If an action would require it and no such consent exists, the correct behaviors are: ask explicitly before proceeding, restrict that action to a desktop the owner has explicitly dedicated to that agent and is not currently viewing, or report plainly that the target isn't supported yet — never attempt a partial or silent action. With F18-F20's narrowing, this path is now expected to be rare (mainly Terminal-class apps with no accessibility surface) rather than common.

**Cursor display requirement (owner-specified):** the labeled agent cursor shows by default on every action, always, not as an opt-in "watch mode" — this is the core visible proof that "the agent actually did it." `moveCursor` and `click` are already separate driver calls (confirmed in the contract), so this is pure rendering/telemetry tied to coordinates the driver already computes — no added token/LLM cost regardless of which route executes the underlying action.

**Terminal-class apps (no accessibility surface):** explicitly deprioritized by the owner for now. Not a current blocker. When revisited, the same consent requirement above applies in full — no silent foreground takeover.

**Notepad regression, reconfirmed:** the owner directly tested Notepad (a classic Win32 app, previously assumed reliable from T32/T35 passing under Codex's own test conditions) and it failed. Codex is already aware of this; recorded here again as supporting evidence that hidden state (most likely F12's empty-desktop-ID bug) can affect even the "should be safe" app category, not only Chrome/Terminal — raising F12's practical priority.

**Explicit scope note:** Claude ran this audit read-only, per section 9's boundary, and is not implementing F12–F20. Codex owns implementation per section 9; this section is intended as a shared, verified starting point so both sessions work from the same evidence.

### 2026-10-10 F12 implementation checkpoint

- Added a regression test that first failed because an all-zero desktop GUID was accepted, then passed after the fix. The native stage helper now rejects zero GUIDs from parsed stage IDs, the public window-desktop API, and the private shell desktop-ID reader. This lets owner-preview desktop detection continue to the validated shell current-desktop query when the foreground window returns the invalid zero value.
- Verification: `cargo test --manifest-path native-input-host/Cargo.toml` passed (15 library tests and 1 binary test). No installed runtime was replaced or restarted.
- Recheck on 2026-10-10: the same native suite passed again (15 library tests and 1 binary test); source inspection confirmed both Windows `GetWindowDesktopId` and private shell `GetId` reads reject zero GUIDs before returning them. This remains source/native evidence only.
- **F12 remains PARTIAL.** The required owner-run Notepad acceptance has not been performed against this build, so F12 is not closed. The native regression tests pass, but there is no active authorized M9R desktop task/session in this turn for the owner's pill task; prior task tokens are not reusable. This blocks live acceptance and runtime installation, not source-level diagnostics. F16 source work below does not count as F12 evidence.

### 2026-10-10 F16 implementation checkpoint

- Added a bounded, secret-redacting stage-error serializer that preserves nested Cua `.inner`, `Error.cause`, and `AggregateError.errors`, including the original Cua tool/error code and each capture fallback cause.
- Stage refusals now carry an explicit `authorization`, `validation`, `driver`, or `runtime` failure kind. Native execution failures return 502 rather than being mislabeled as 403 authorization failures; existing validation/policy refusals remain fail-closed.
- Owner-pipe handler exceptions retain safe error detail. A synchronous handler throw is no longer caught as malformed JSON.
- Added a detailed owner-pipe result path distinguishing broker-unreachable, permission-denied, timeout, connection-lost, invalid-response, and oversized-response outcomes. Operation receipts are marked not-dispatched before connection, or unknown after request dispatch; the client still never falls back to HTTP for owner-pipe stage actions.
- Verification: failing regressions reproduced the aggregate flattening, generic handler error, missing broker classification, and stale launch receipt fixture. After fixes, the focused owner-pipe, broker-server, and stage-client set passed (56 tests, 0 failures); `npm run typecheck` passed; scoped `git diff --check` passed. The earlier broad default-sandbox run hit local-loopback `EACCES`; the focused elevated local-loopback run passed.
- **F16 implementation and local integration verification: CLOSED.** This confirms the error-reporting path in source/local broker tests only; it does not prove an installed runtime or live provider run. F12 remains PARTIAL and still blocks any live runtime replacement/acceptance.

### 2026-10-15 Item 7 / Pine-style observation implementation checkpoint

- Added a bounded exact-app-window `read_structure` stage action. It uses the installed Cua Driver `getWindowState` accessibility tree, preserves parent/depth/role/label/action metadata, remaps driver element tokens without exposing HWND/PID metadata, and refuses desktop-wide structured observation rather than pretending a visual desktop capture is a UI tree.
- Kept the browser route separate and provider-neutral: the existing M9R browser snapshot remains the structured DOM observation path; the native route is the exact-window Cua accessibility path; visual capture remains an explicit fallback. No extension cursor is required for either observation path.
- Added the action parser/dispatcher and the exact-window driver fixtures for complete-tree output, partial-tree fallback, accessibility-unavailable fallback, and app-only routing. Focused verification passed: `test:desktop-stage` 84/84; contract/router/stage/Cua focused suite 65/65; targeted strict TypeScript compile of the changed tracked stage files passed; scoped ESLint passed with one pre-existing unused-import warning and zero errors; `git diff --check` passed.
- The separate untracked `computer-use-mcp.ts` universal adapter remains an unfinished migration against the current durable-operation store and web-client types; its failed compile/tests are not counted as Item 7 evidence and were not silently wired into the main MCP server. Integrating that provider-neutral action surface is a later shared-layer task, not an app-specific fix.
- **Item 7 remains OPEN for full closure.** Installed-runtime/owner-preview proof, a real browser snapshot plus a real native app tree under one target/revision contract, latency/partial-tree/fallback measurements, and live fallback-route verification are still required. No owner-ready or live acceptance claim is made from these local results.
- **2026-10-15 live-gate attempt:** `npm run test:desktop-stage` passed 84/84 and the focused contract/router/stage/Cua suite passed 65/65 again. The installed-provider acceptance harness failed before live observation because the installed native hook returned an empty SessionStart response. Installed `m9r-build-info.json` reports source commit `99a20e3c...` with `sourceDirty: true`, while this checkout is at `a8463b4a...`; therefore the installed runtime is not evidence for the current Item 7 implementation and must not be treated as current. The current OpenAI CUA connection exposed no native app windows and no M9R task-card surface (`apps: []`), so no fresh governed owner-preview task could be obtained or reused. Item 7 remains OPEN pending a rebuilt/current runtime and a fresh governed live task.
- **2026-10-15 stale-runtime prevention checkpoint:** The repository `oathlock` script pointed at the deleted `scripts/oathlock-cli.ts`; it now points at the actual `scripts/m9r-cli.ts`, with a regression test. The native feed now watches the adjacent runtime generation marker while in `--watch` mode, aborts through the normal delivery drain when the installed manifest changes, closes the hook server, and releases the feed lock in `finally`; this prevents an old engine from remaining the sole writer after activation and prevents a failed refresh from leaving a lock behind. Source/fixture evidence is still required before treating the fix as live-installed behavior.
- **2026-10-15 stale-runtime/build convergence checkpoint:** The CLI build graph had omitted the shared `task-execution-context`, `task-delivery-pump`, and `mcp-stdio-supervisor` modules; a fresh build therefore either retained an older generated runtime or failed later during SEA packaging. The builder now ships those modules and validates every generated entrypoint (`m9r.js`, hook, MCP, developer MCP, and native setup) before publishing. The installer fixture now includes the canonical Cua runtime and asserts `cua-cursor-theme.exe` is present, matching the release packager rather than a minimal stale ZIP. The final post-commit Windows build completed with runtime identity `ec64780431d06e1a9ea349323b7538e58483daad32a58eb15d841282f44559d4` across 185 artifacts. Verification against that exact build: installer suite 12/12; desktop-stage 84/84; contract/router/stage/Cua 65/65; phase-6 reliability 25/25; native runtime/feed/command suite 54/54. Repository-wide `npm run typecheck` remains blocked by pre-existing untracked/unfinished migration files (`computer-use-mcp.ts`, session-binding tests, and `bench-claude-cli.test.ts`); these were not modified or counted as Item 7 evidence. Item 7 source/runtime packaging is stronger and reproducible, but owner-preview live structure proof remains OPEN pending an approved fresh governed task and current installed-runtime observation.
