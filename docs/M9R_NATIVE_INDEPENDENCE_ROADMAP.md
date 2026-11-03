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
