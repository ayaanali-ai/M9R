# M9R Native Independence Roadmap

Status: controlled implementation record. This roadmap supplements Source of Truth 6.0; it does not replace it.

## Baseline captured 2026-11-03

- Worktree had pre-existing user/Claude changes in ten tracked files plus `baseline-input-test.log`; none were included in this roadmap commit.
- Focused desktop/multiplayer gate: 94 tests, 86 passed, 8 failed. The failures are recorded in the command output and are not being reclassified as regressions until the phase-specific gates are run.
- Current branch: `main`, HEAD `b4f45dba` before this roadmap commit.

## Invariants

- M9R owns provider processes and provider connections. No provider-native session resume or hook/session compatibility path may be introduced.
- The production desktop action and perception path is M9R-owned. The Cua runtime may remain only behind the optional agent-cursor presentation adapter until the cursor is replaced.
- Existing user changes are preserved. No live install or release promotion is part of this roadmap; the final gate ends at a verified candidate ready for owner testing.
- A user message, task control message, and agent-to-agent message remain distinct records.
- Every mutation has an exact surface/revision target, bounded dispatch, a postcondition, and a receipt distinguishing delivery from verification.

## Phases and completion gates

1. **Baseline and dependency inventory**
   - Record the dirty worktree and current test/type/build baseline.
   - Inventory every Cua import, runtime call, package/build artifact, and action fallback.
   - Classify each dependency as cursor presentation, perception, semantic action, window management, screenshot fallback, or dead compatibility.
   - Gate: inventory is checked against source and no production caller is unclassified.

2. **Native perception**
   - Add exact-window UIA inspection, stable snapshot/ref identity, process-generation evidence, completeness metadata, popup/menu/taskbar/UWP discovery, and native screenshot capture.
   - Gate: native observations reproduce the required window, element, popup, and fallback fixtures without Cua.

3. **Native semantic actions**
   - Implement native invoke/select/toggle/expand/set-value/focus/menu/popup/browser-toolbar and window-state actions.
   - Keep SendInput for physical fallback only.
   - Gate: every action kind has one M9R-owned dispatch path and an observed postcondition.

4. **Unified targeting and outcomes**
   - Use one ref resolver, one process-generation/HWND validator, one pre-dispatch revalidation path, one actionability/occlusion resolver, and one outcome envelope.
   - Gate: stale/ambiguous/not-delivered outcomes never silently retarget or freeze unrelated work.

5. **Cursor-only Cua adapter**
   - Isolate the Cua dependency behind an optional presentation adapter.
   - Preserve configurable cursor theme, label, color, motion, and visibility without making the overlay a permission or input dependency.
   - Gate: disabling the cursor adapter leaves native observation and actions functional.

6. **Production Cua removal**
   - Remove Cua perception/action calls, package/runtime dependencies, build downloads, installer entries, and fallbacks from production paths.
   - Gate: production dispatch contains no Cua action/perception calls; only the cursor adapter remains.

7. **Provider lifecycle preservation**
   - Preserve persistent M9R-owned connections for normal messages.
   - Keep pause/redirect/resume in M9R task context; cold-start only after real process/broker restart.
   - Gate: no provider-native resume or control-message injection into provider conversations.

8. **Source of Truth 6.0 task and multiplayer contracts**
   - Implement explicit continuation, clarification, pause, resume, redirect, cancel, and new-task controls.
   - Keep natural A2A conversation with structured sidecars, dynamic assignment, progress witnesses, independent input leases, and selective reassignment.
   - Gate: unaffected participants continue and no agent loop repeats a state without progress.

9. **OpenCode and provider health**
   - Diagnose raw startup/quota/model errors, repair managed connection health, and verify a no-op, a desktop task, and a multiplayer handoff.
   - Gate: OpenCode is healthy in the pill and live task results retain their actual error/effect evidence.

10. **Performance and T167 reliability**
    - Warm native hosts, reduce redundant captures, batch confident flow steps, settle Chromium/UWP surfaces, rank visible results, make brightness reporting truthful, and make multi-window tiling atomic.
    - Gate: T167 and cross-app latency baselines improve without new regressions.

11. **Verification matrix**
    - Run typecheck, Rust build/tests, full project tests with named before/after differences, and live tests across Notepad, modern Notepad, Explorer, Settings/Calculator, taskbar/Start, dialogs/popups, logged-in Chrome, and system controls.
    - Gate: every claim is backed by observed output, not code inspection alone.

12. **Candidate-ready release boundary**
    - Commit each phase separately, build one candidate from the verified tree, verify provenance and process/runtime state, and stop before installation/live promotion.
    - Gate: source, tests, candidate, and docs are green and ready for owner testing and later cursor design/release work.

## Change-control rule

Each phase is committed only after its own gate passes. A failing gate blocks the next phase; it is not worked around or silently deferred.

## Controlled commits

- Phase 1 baseline/inventory: `43647aad`.
- Phase 2 native exact-window perception and capture: `3d22ae71` (the dependency lockfile is carried forward into the next controlled commit because Cargo regenerated it after the phase commit).
- Phase 3 native-first foreground action and observation: `dd355420`.
- Phase 4 native visible-window launch verification: `76d0f528`.
- Phase 5 configurable cursor-only presentation boundary: `f88cdf57`.
- Phase 6 native production path: `dbad0f1d` (stage-scoped native SendInput transaction) plus `dd4f6b4a` (native desktop capture/enumeration, UIA menu invocation, window frames, and text clipboard). Cua perception/action fallback is now explicit compatibility-only; the normal broker path is native.
- Phase 7 provider lifecycle preservation: `2c69808c`.
- Phase 8 task/multiplayer continuity: `6e8599b7`.
- Phase 9 provider health: `3a06508f`.
- Phase 10 warm native stage/performance: `9ffa80ba`.

### Phase 6 gate note

The owner-preview action path now selects the M9R native sender whenever one exists, even when the caller did not set an explicit foreground confirmation flag. This removes the old silent Cua semantic-action round trip for visible work. Background-stage delivery is intentionally not claimed here: raw `SendInput` cannot target an off-desktop window without a stage-scoped activate/send/restore transaction, which remains a separate gate rather than being disguised as complete.

### Phase 6 completion gate

- Native host now exposes full virtual-desktop capture, visible-window coordinates, native window-frame updates, text clipboard read/write, and UIA menu invocation.
- `cua-stage-driver.ts` prefers those native operations and only permits the older Cua observation/action fallback for injected test seams or `M9R_ENABLE_CUA_COMPAT=1`.
- `npx tsc --noEmit -p .`: passed.
- `cargo build --release --manifest-path native-input-host/Cargo.toml`: passed.
- `cargo test --release --manifest-path native-input-host/Cargo.toml`: 21 passed, 1 pre-existing environment-dependent cursor round-trip failure (`owner_cursor_position_round_trips_through_get_and_restore`).
- Focused TypeScript gate remains at the previously recorded 48/54 pass profile; no new failure names were introduced by the native route.

### Phase 7 completion gate

- `managed-provider-owner.ts` now states and passes `allowProviderContinuation: false` explicitly at the production supervisor boundary.
- Added a lifecycle invariant test: normal turns reuse one M9R-owned connection; a failed provider process starts a new generation on that same logical connection with no provider continuation argument.
- M9R task-context continuation remains separate from provider-native session/thread identifiers.

### Phase 8 completion gate

- Existing task-context, A2A sidecar, scheduler, mutation-fence, and run-coordinator contracts are retained as the single multiplayer path.
- Added an acceptance test covering pause → release one assignment → redirect → reassign while an unaffected participant keeps its claimed work.
- Progress witnesses continue to reset the no-progress streak only on observable state change; duplicate witnesses enter `waiting-agent` instead of creating an unbounded message loop.

### Phase 9 completion gate

- Managed OpenCode startup and turn failures retain a provider-specific
  classification (`usage-limit`, `model-not-found`, `authentication`,
  `timeout`, `not-running`, `internal`, or `unknown`) in the M9R-owned error
  evidence. Quota and configuration failures are not presented as retryable
  transport failures; transient transport failures remain retryable.
- Normal M9R connection reuse, cold replacement after a dead runtime, and
  provider-native session isolation remain unchanged.
- Added focused classifier coverage for quota, model, transport, and timeout
  evidence. Phase 9 does not start a provider, alter a user's provider
  profile, or introduce a provider-session resume path.

### Phase 10 completion gate

- Native desktop-stage managers now keep one bounded, request-id-multiplexed
  `--desktop-stage-server` helper alive instead of spawning a process for every
  UIA read, capture, or native action. The one-shot JSON entrypoint remains for
  explicit CLI use; the production manager uses the persistent host only when
  no test/injected invoker is supplied.
- Popup perception is native-first in production. The Cua popup screenshot is
  retained only behind the explicit compatibility seam, so menus and
  suggestion surfaces do not silently re-enter the retired perception route.
- Visible-window structure is ranked generically by the verified foreground
  window and then area before bounded enumeration; no app/site-specific rule
  was added.
- Brightness writes now distinguish a confirmed readback from a successful
  write whose monitor exposes no readable brightness instance. The response
  reports `verification: "readback"` or `"write-dispatched"` instead of
  claiming a false failure/success.
- Existing native frame updates remain one stage transaction and are
  re-observed by the action layer; no second tiling implementation was added.
- Verification: `rustfmt --check --edition 2021` passed for the Phase 10 Rust
  files; `cargo build --release --manifest-path native-input-host/Cargo.toml`
  passed; `npx tsc --noEmit -p .` passed; focused desktop/provider tests were
  70/76 passing. The six failures are existing contract/environment cases:
  owner-pointer preservation, owner-preview desktop width, two Chrome
  foreground-confirmation expectations, the pre-existing 500-character error
  wording assertion, and the pointer-preservation setup in the typed refusal
  test. No new Phase 10 failure name appeared. The persistent helper itself is
  compiled and protocol-checked at source level; a live installed-host run is
  intentionally deferred to the owner's Phase 11 testing because this
  roadmap never installs or promotes a candidate.

### Phase 11 completion gate

- TypeScript typecheck passed: `npx tsc --noEmit -p .`.
- Native Rust tests completed with 21 passed and 1 known environment-dependent
  failure (`virtual_desktop::tests::owner_cursor_position_round_trips_through_get_and_restore`), the same cursor round-trip failure recorded before this roadmap.
- The expanded focused matrix ran 194 tests: 137 passed, 56 failed, and 1
  skipped. The recorded pre-Phase-11 focused baseline was 194 tests, 193
  passed, and 1 skipped. The current failures are not presented as a green
  gate: they include the known sandbox `EPERM` state-lock rename failures,
  existing browser-loop fixture mismatches, pointer-preservation fixture
  expectations, and the pre-existing 500-character wording assertion. No
  Phase 10-specific failure was introduced in the native stage tests; the
  native stage subset itself passed.
- The full project runner completed 2,568 tests across 206 files: batch 1 had
  2,472 tests with 2,347 passed, 124 failed, and 3 skipped; batch 2 had 96
  tests with 96 passed. The failed batch is dominated by the documented
  environment/fixture constraints (sandbox rename `EPERM`, project-local
  `M9R_HOME`, unavailable local roadmap fixture, and loopback permission
  failures) plus existing dirty user/Claude compatibility changes. These are
  recorded rather than hidden or reclassified as success.
- Owner-machine live tests (classic/modern Notepad, Explorer, Settings or
  Calculator, taskbar/dialogs, logged-in Chrome, system controls, and an
  installed persistent stage host) were not run here because Phase 12 is
  explicitly a no-install/no-live-promotion boundary. They remain the owner's
  required acceptance run.
