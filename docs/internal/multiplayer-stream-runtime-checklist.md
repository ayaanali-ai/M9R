# Multiplayer stream implementation checklist

Base: `bfe44444718d80dd1fe8922d4117e13d6997524d`, including the seven approved background-input and cursor-renderer commits on `c086d199`.

The original checkout and its four modified provider files are excluded. Edge/notch glow is excluded. No install, live runtime update, or GitHub publication is authorized by this implementation pass.

1. [x] Persistent per-agent session streams through production desktop lifecycle; ordered within a stream, independent across agents, cancellation and diagnostic identity.
2. [x] Same-window independent semantic targets; revalidated stable identities and region fencing, same-target serialization retained; real two-field harness.
3. [x] Owner work mode and scoped foreground approval, end-to-end through pill/broker/dispatch.
4. [x] Per-action background capabilities; semantic-first delivery with no unapproved physical fallback.
5. [x] Bounded foreground handoff with safe owner-context restoration.
6. [x] Existing custom cursor renderer driven by live streams and exact targets, persistent task lifetime and cleanup.
7. [x] Provider-to-provider task coordination, assignment/claim/help/yield/resume, delivery/wakeup, verified completion and bounded stop.
8. [x] Final integrated checks and repeatable acceptance/evidence plan.

Existing source evidence: T1 exercises overlapping WM_CHAR writes to two native helper windows; T2 exercises same-stage serialization; T3 exercises real Notepad background text while an independent foreground typer runs. These are preserved, and do not establish arbitrary-app or two-distinct-fields coverage by themselves.

Item 1 verification: 40 tests passed (`agent-input-stream.test.ts` and `task-desktop-stage.test.ts`); focused native-input-stream TypeScript project and full root TypeScript check passed. The normal Windows sandbox stalls in the existing local-store directory-publication path before stream code; the same suite completes outside that sandbox. The isolated worktree uses the already installed pill dependencies through a local directory junction; no dependency files were changed.

## Item 2 verification and rerun

Independent streams now use separate, lazily started native helper processes. Shared HWND binding requires an explicit broker fence and an active assignment. Only complete, unambiguous, revalidated UIA ValuePattern controls get independent regions; weak identities and other operations retain the window fence. Region-scoped writes cannot fall back to shared-caret input. RuntimeId is a live revalidation epoch, not a durable field key. Revoked streams and broker shutdown reap their native helpers.

The supported same-window concurrency boundary is **independent ValuePattern replacements only**. Clicks, shared-caret typing, scroll, window manipulation and controls without a complete unique semantic identity remain serialized/excluded at window scope. This proves two-field semantic concurrency, not arbitrary simultaneous actions within an application.

Scoped regression suites passed (170 tests, including native-control-region, native-input-channels, multiplayer-dispatch-fence, task-desktop-stage, task-stage-actions, cua-stage-driver and windows-desktop-stage). The native production unit tests passed (3), including refusal of agent-context execution. Focused and full TypeScript checks passed.

Optional Windows proof, run from this worktree in an ordinary owner terminal:

```powershell
cargo build --offline --manifest-path native-input-host/Cargo.toml --features test-fixtures --bin m9r-native-input-fixture-host
node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/register-alias.mjs --test ./scripts/native-same-window-streams.test.ts
```

This creates only a disposable, nonactivating two-edit fixture window. Its optional executable refuses targets outside its own marked form and is excluded from ordinary builds. The test uses production framed protocol, native revalidation and UIA SetValue. A fixture-only barrier immediately before the actual calls proves overlapping native in-flight dispatch across two helpers; both field values are read back. A same-field collision permits only one writer. It checks zero injected mouse/keyboard events, no target activation, owner cursor coordinates (inconclusive if physical owner movement occurs), and helper/process cleanup. It records counts, not keys or physical-input text. **This is gated concurrency stress evidence, not normal-case latency evidence or arbitrary-app coverage.** Production runtime/provider live acceptance remains post-install work.

## Item 3: owner work mode

The owner pill displays **I'm Working** by default when no persisted choice exists. That preference is separate from each task's `background`/`owner-preview` delivery mode. **Agents Free** preserves the existing foreground route. The pill/Tauri command calls the CLI's owner-only named-pipe endpoint; agents cannot change the preference through MCP/HTTP or an agent-context CLI. The preference lives in `owner-work-mode.json` in the runtime data root and survives broker restarts. Invalid/corrupt data refuses foreground dispatch; the owner UI remains usable to save a valid choice.

Every foreground native request requires an explicit task authorization context. In Working mode a foreground-only fallback waits on the existing pill approval list. A grant is limited to the current ordered operation and exact PID/HWND, plus necessary pointer restoration; it does not authorize the next operation/task or another HWND. Native read-only foreground verification is not gated. UIA/WM_CHAR background dispatch continues without a prompt. New process startup is gated before spawning because even a hidden-start hint does not prevent an app from activating itself. Deny/timeout sends no foreground input; cancellation removes the pending approval. Switching to Agents Free releases a pending prompt. Revoked credentials/control are checked again after an approval wait. A denied pre-dispatch launch releases its operation receipt, so the same operation can retry safely.

Each persisted owner-mode choice creates a fresh revision. Returning to Working invalidates all earlier grants even inside the same operation; a preference change during a pending approval cannot revive the old grant. One launch approval covers startup and initial focus of the exact newly discovered application window: only the broker's launcher, after its system app-identity selection and native HWND attachment, carries that launch grant to the selected PID/HWND. Existing-window reuse receives no launch carry; other targets/operations still ask separately. Prompt-count tests verify one prompt for approved launch and none in Agents Free.

Launch receipt release is restricted to refusals before process startup was attempted. Once startup is attempted, a later mode change/focus denial retains an uncertain receipt and cannot replay as a new launch. The disposable-launch test covers both pre-spawn retry and post-spawn refusal/replay exclusion.

After that receipt correction, the work-mode acceptance suite passed 4/4 and `task-desktop-stage.test.ts` passed 37/37; focused TypeScript and whitespace checks passed again. Item 4 must also classify the native media `systemControl` fallback, which can emit global `keybd_event`; it is not claimed covered by item 3's current foreground-operation list.

Verification commands/results (all from this isolated worktree):

```powershell
node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/register-alias.mjs --test ./scripts/owner-work-mode.test.ts ./scripts/task-desktop-stage.test.ts ./scripts/cua-stage-driver.test.ts ./scripts/windows-desktop-stage.test.ts ./scripts/web-ui-bridge.test.ts
# 176 passed, 0 failed
node ../../node_modules/typescript/bin/tsc --noEmit --project scripts/tsconfig.native-input-stream.json
node ../../node_modules/typescript/bin/tsc --noEmit
# both passed; full root check run outside the restricted Windows temp-store sandbox
# From pill/: node ./node_modules/typescript/bin/tsc --noEmit
# From pill/: node ./node_modules/vite/bin/vite.js build --outDir ../overlay/dist/pill-next --emptyOutDir
cargo check --offline --manifest-path overlay/src-tauri/Cargo.toml
# all passed; cargo has four existing unused-function warnings
# Isolated CLI build: M9R_CLI_OUTPUT_DIR=<worktree>/.test-tmp-item3-cli node scripts/build-cli.mjs
# passed; generated CLI removed after graph/startup verification
```

The optional real same-window test also passed under the new default Working policy, including both readbacks, gated native overlap, same-target refusal, owner-input isolation and process cleanup. Intentional foreground Phase 0 harnesses explicitly opt into Agents Free; their direct owner-harness calls carry explicit authorization. Their existing live Windows app proof is not claimed rerun during this item.

Known baseline failures, left unchanged: `pill-shells.test.ts:197` expects a settings payload without the already-existing `glowStyle`/`glowColor`; `web-broker-server.test.ts:169` and `:219` expect terminal `resultSummary` values but get `undefined`. All three failures were reproduced with HEAD versions of changed broker/core/UI/desktop modules through a temporary read-only source loader (3 tests, same 3 failures). No fix is included in this item. The unchanged `pill-state.test.ts` cannot run with the repository's Node loader because it imports a provider SVG; Vite compilation and pill TypeScript check pass. These are not reported as passing tests.

Still requires post-install owner acceptance: the visible pill toggle in the actual overlay, approval/restoration behavior while the owner works in real apps, and provider-level live tasks. The safe context restoration path is implemented in item 5 below; it has not yet been live-tested with installed hooks.

## Item 4: per-action delivery and foreground boundary

Each task-stage and Computer Use action now has an explicit delivery profile. The planner accepts only exact, implementation-backed semantic/background capabilities and uses the capabilities actually advertised by the selected route; it no longer fabricates target support from the requested action, treats global input as background-safe, or hardcodes a valid lease. Window reframe is classified as background-safe only through the native `SetWindowPos(SWP_NOACTIVATE)` implementation. Global media keys enter the same owner authorization boundary and use their own approval scope; a media grant cannot authorize pointer restoration or other foreground input.

An explicit background-only request refuses when no safe semantic route exists, even if the call carries an escalation hint or an old owner lease. If a foreground turn is needed, the caller must issue that specific action as a foreground request; the native owner-work policy then approves the one bounded turn or refuses before dispatch. A typed zero-dispatch result may be retried only through that explicit path. Uncertain delivery is never replayed. This removes silent route escalation while preserving owner-preview and Agents Free behavior.

Verification: focused planner/recovery/stage-action tests passed (23); full focused integration set passed (208), covering action routing, task stage, CUA stage driver, Windows stage manager, computer-use programs/recovery, native input channels, dispatch fences, web UI bridge, and owner work mode. Root TypeScript, native-input-stream TypeScript, and `git diff --check` passed. The first restricted-sandbox run exposed the explicit-background escalation bug and failed unrelated temp-rename/loopback tests; after correcting the policy, the full 208-test integration run passed outside the restricted sandbox. No installed runtime, provider configuration, extension, or glow file was changed.

## Item 5: bounded foreground handoff and owner-context restoration

An approved foreground operation now captures the exact visible, non-minimized owner HWND and its process generation before dispatch. If the context is absent, invalid, or changes while it is sampled, the action is refused before input. Each subsequent foreground dispatch checks that the physical-input epoch still matches; owner mouse/keyboard activity stops further foreground actions. At operation end, M9R restores the captured owner HWND only when the exact authorized target process is still foreground, the owner window is still the same live process/window, and no physical owner input occurred. The restore path does not synthesize input, show/minimize windows, or restore after the owner resumes input. It reports restored/skipped/failed as diagnostics, not as task-effect proof.

Physical input detection uses temporary low-level keyboard/mouse hooks only during an approved foreground handoff. The callbacks read only each event's injected flag and increment an in-memory epoch for physical events; they do not retain or log key codes, text, pointer coordinates, or buttons. Agent-injected events do not count as owner input. Hooks are explicitly removed in the handoff's `finally` path, including restore failure/revocation. If hook setup or owner-context capture fails, no foreground action is sent.

Verification in the isolated worktree: Windows-stage suite passed (28), focused owner-work-mode/stage integration passed (3), native input-host unit tests passed (20), native input-stream TypeScript check passed, root TypeScript check passed, native `cargo check` passed, and `git diff --check` passed. Those tests exercise authorization, exact target scope, fail-closed capture, owner-input interruption, safe restoration, and hook-flag classification. They do not simulate real user input through installed hooks; that behavior remains part of post-install live acceptance. No runtime was installed or published.

## Item 6: persistent per-agent visual cursor

The existing Direct2D renderer is now wired as a presentation-only child of the owner broker. It starts lazily and reports ready only after its first layered frame was successfully presented. Each authenticated agent session receives a stable private marker ID, public label, and deterministic color. The existing CUA session remains the verified position source; its visual marker is hidden only after the M9R renderer acknowledges the matching screen-coordinate marker. If the renderer is missing or fails to acknowledge, the CUA marker is restored as fallback. This path sends no input and is never used as action-delivery or effect evidence.

Cursor target points are sent after CUA position verification and are in absolute screen coordinates; the renderer translates them against the virtual-screen origin for multi-monitor layouts. The marker remains visible between actions for that task. Explicit stop, task terminal state, identity revocation, or broker shutdown removes it. Task completion does **not** close the agent-session input host; that stream persists for the next task. Renderer startup/ack timing is recorded separately from action evidence.

Verification: the cursor host protocol and CUA-stage suites plus the full task desktop-stage suite passed (129 tests, 0 failures) with Windows test temp storage inside the isolated worktree; root TypeScript check and native `cargo check --offline --manifest-path native-input-host/Cargo.toml` passed. The native renderer self-test generated and visually verified its transparent/on-light/on-dark frames. These are build/unit/self-test results, not a live installed-runtime acceptance test. The implementation remains isolated and is not installed or published.

## Item 7: provider-to-provider coordination and durable return path

The managed owner broker now converts an accepted structured teammate message into a durable inbox task only when both provider sessions are active and the sender has a delivered, owner-approved parent task in its exact session. It pins both sender and recipient session IDs; work cannot spill into another logged-in session for the same provider. Replies must match the parent exchange and are routed back to the exact requesting session. Unknown, expired, mismatched, unapproved, or over-depth exchanges fail closed instead of leaving hidden approval-pending work. Delivery receipts distinguish queued, pending, partial, and failed outcomes; a duplicate retry can resume failed/partial delivery through the store's idempotency key without creating duplicate recipient tasks.

Task results now return as durable, exact-session reply tasks. Incomplete results preserve remaining work and return that status to the requester. A structured teammate reply suppresses a duplicate automatic result reply; result tasks do not recursively generate another result task. Reply depth is bounded. The provider bridge checks the active source and target session before delivery, and records the original request as answered only after the reply reaches the pinned sender session. These rules provide assignment/handoff, claim through the existing inbox ownership, help/reply, bounded continuation, and stop-on-missing-session behavior; they do not claim agents autonomously resolve every task or that model-level collaboration has been live-accepted.

Verification in the isolated worktree: the four focused A2A/provider/MCP suites passed **40/40** with Node test-file concurrency set to 1; each suite also passed independently. Root TypeScript check and `git diff --check` passed. No provider transcript or desktop action is created by these unit tests; no installed runtime or live provider task was run.

### T215 diagnostic evidence (2026-11-08)

The local store records T215 as accepted, dispatched, provider-received by Codex, and then paused by the owner broker at `2026-11-08T04:41:53Z`. Its runtime build ID matches the installed engine build ID (`d672a143…`), whose build metadata identifies clean source commit `bfe44444718d80dd1fe8922d4117e13d6997524d`. The retained stage telemetry contains a cursor-preview stage but no Chrome/app-launch, browser observation, action, verification, or first-visible-action record. The preview stage is not evidence of a Chrome launch. Local managed-provider-session logs do not contain a T215 provider transcript. Therefore the evidence rules out a task-delivery failure and an installed-build-ID mismatch for this run, but cannot tell whether Codex never selected the desktop tool or a tool call failed before M9R recorded a stage event. The task was owner-paused before a desktop action was recorded. Do not label this a proven CUA/native dispatch failure or claim Chrome opened.

## Item 8: integrated verification and repeatable acceptance

The integrated isolated-worktree regression set passed **282/282** tests across input streams, owner work mode, native semantic regions, task/app stages, background dispatch, CUA stage driver, Windows stage manager, web UI bridge, computer-use planning/recovery, cursor renderer lifecycle, managed A2A delivery, provider queue, and MCP inbox. The owner-pill transport test requires loopback; a restricted run returned `EACCES` on `127.0.0.1`, then the same full suite passed with local-network access. The real disposable-form Phase 0 test also passed: two separate helpers had overlapping native `SetValue` intervals for two distinct fields in one HWND; same-field contention admitted one writer; the owner cursor/input was not used. This is gated semantic concurrency proof, not broad app support or a latency benchmark.

Additional checks passed: root TypeScript (`tsc --noEmit`), native-input-stream TypeScript project, native host `cargo test --offline` (23 tests), optional `test-fixtures` host build, and `git diff --check`. Tests used an isolated worktree and generated test-only artifacts there. The installed runtime, provider configuration, and edge/notch glow were not changed. No live provider acceptance task has been run against this code yet.

### Post-install acceptance card

For each run, record the task ID, installed engine build ID and source commit, provider/session identity (redacted to stable local labels), lifecycle timestamps, provider receipt, stage preparation/launch, action route and dispatch certainty, post-action effect evidence, owner-input epoch, and cursor-renderer acknowledgement/cleanup. Preserve the task log and screenshots or on-disk artifacts needed to prove the requested outcome. `provider_received` and `queued` prove transport/queueing only; they are not proof that the model called a desktop tool or that the requested effect occurred. If no action was recorded, report “no stage action observed” and keep the cause unknown unless a provider tool-call trace or explicit refusal identifies it.

Run these checks in order after installing the candidate:

1. **One-agent browser action (T215 diagnostic).** “Open Chrome (reuse an existing window if one is open), go to YouTube, find Strawberry Park’s newest upload by comparing the channel’s displayed upload dates, and report its exact title and displayed date. Do not play the video or modify files.” Pass only with a recorded Chrome target resolution, page observation, selected upload title/date, and visible-page evidence matching the answer. A task receipt without the first app/action event is a failure to start useful work.
2. **One-agent artifact.** “Calculate `29 × 13 + 7`, create a new Notepad document containing `M9R acceptance` and `29 × 13 + 7 = 384` on separate lines, save it in the already-created Desktop folder `M9R-Benchmark\Acceptance-Run1` with filename `calculation.txt`, then reopen that exact file and verify both lines.” Create the folder before the run. Pass only if the reopened exact path and bytes/text match; do not infer success from the Save click.
3. **Provider handoff.** Send one owner task to Codex that asks it to delegate a separate, read-only `https://example.com/` heading check to Claude while Codex independently computes `31 × 17 + 9`; require Codex to return both results and the delegated task ID. Pass only if the task shows a durable handoff to Claude’s pinned session, Claude’s result returns to Codex’s pinned session, Codex reports both correct results, and no duplicate/looping reply appears.
4. **Two-stream fixture and owner isolation.** Rerun the guarded `native-same-window-streams.test.ts` proof, then separately perform a short user-present action while the owner keeps typing in another app. Pass only when the independent target effects land, the owner’s foreground/cursor/input remain intact in background mode, and any foreground-only action waits for its explicit owner approval and restores the captured owner context safely.

Stop after any mismatch; retain the task evidence, do not retry an uncertain mutation, and classify the failure by the first missing/contradictory event. The app-action trace gap seen in T215 must be addressed by the live evidence record before claiming a provider-selection or native-dispatch root cause.
