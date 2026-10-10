# M9R Cumulative Reliability, Demo Gates, and Ownership Tracker

**Checkpoint date:** 2026-10-10  
**Purpose:** One cumulative execution plan for reliability defects, the earlier proposed fix order, product/demo gates, roadmap work, and cleanup. New findings are appended to this plan; they do not replace or reorder it.

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

**Current status:** OPEN. Synthetic cursor and fixture proofs are not a real provider task. User-observed physical mouse movement and failed T38–T46 tasks remain unresolved acceptance evidence.

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

### 2026-10-10 desktop transport follow-up (steps 1–3; acceptance remains open)

- Preserved local checkpoint `22f9053d`; its clean archived source passed 161 focused regressions. No runtime installation or pill restart occurred for this checkpoint.
- Confirmed a transport inconsistency: agent task-state writes use the owner named pipe, while desktop prepare/app/action required the owner key and HTTP. Desktop operations now use that same local pipe when configured, with shared identity/task validation and no HTTP fallback. Owner approval endpoints remain unavailable through the agent pipe.
- Pipe responses support bounded captures up to 4 MiB, retain 64 KiB request limits, and allow a bounded desktop deadline. Additional socket chunks cannot dispatch an in-flight request twice.
- Windows lock publication retries transient sharing errors within its existing deadline without deleting another writer's lock or replacing atomic state publication.
- Verification: 51 broker/transport tests, 77 state/delivery tests, and 4 pipe tests passed; the latter includes extra-chunk one-shot dispatch and desktop requests with unavailable HTTP/key access. These are fixture regressions, not live cursor acceptance.
- After the owner restarted Codex, this chat's M9R connection still returned `Transport closed`. Existing broker HTTP health and read-only named-pipe probes did not yield a healthy response. Process probes disagree, so no crash or sole underlying cause is claimed. Clean build verification and installed-runtime recovery remain required before task-ready sign-off.

- Owner audit attachment received 2026-10-10: nine findings F1–F9 and their proposed fixes.
- docs/M9R_AUDIT_CHECKPOINT_2026-10-07.md, including the 2026-10-09 T26/T27 addenda, seven-step cumulative order, demo gates, and carried-forward requirements.
- docs/M9R_CUA_WAVE_PLAN.md, current roadmap status record dated 2026-10-07.
- docs/M9R_WINDOWS_DESKTOP_STAGE_ACCEPTANCE.md, detailed stage, cursor, task lifecycle, and browser/native route acceptance.
- docs/M9R_EXTENSION_ISSUES_2026-10-05.md, extension-specific open acceptance evidence.
