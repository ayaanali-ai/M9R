# Multiplayer stream implementation checklist

Base: `bfe44444718d80dd1fe8922d4117e13d6997524d`, including the seven approved background-input and cursor-renderer commits on `c086d199`.

The original checkout and its four modified provider files are excluded. Edge/notch glow is excluded. No install, live runtime update, or GitHub publication is authorized by this implementation pass.

1. [x] Persistent per-agent session streams through production desktop lifecycle; ordered within a stream, independent across agents, cancellation and diagnostic identity.
2. [x] Same-window independent semantic targets; revalidated stable identities and region fencing, same-target serialization retained; real two-field harness.
3. [x] Owner work mode and scoped foreground approval, end-to-end through pill/broker/dispatch.
4. [ ] Per-action background capabilities; semantic-first delivery with no unapproved physical fallback.
5. [ ] Bounded foreground handoff with safe owner-context restoration.
6. [ ] Existing custom cursor renderer driven by live streams and exact targets, persistent task lifetime and cleanup.
7. [ ] Provider-to-provider task coordination, assignment/claim/help/yield/resume, delivery/wakeup, verified completion and bounded stop.
8. [ ] Final integrated checks and repeatable acceptance/evidence plan.

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

Still requires post-install owner acceptance: the visible pill toggle in the actual overlay, approval/restoration behavior while the owner works in real apps, and provider-level live tasks. This item does not claim new background capabilities or change the broader per-action router; that remains item 4. Exact safe context restoration is item 5.
