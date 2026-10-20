# M9R Master List 2.1

Status: reconciled successor to Master List 2.0, 2026-10-19.

This document is the current ordered release and acceptance plan. Master List
2.0 is preserved in the cumulative tracker under the heading
“consolidated Master List 2.0 status ledger”; it is not overwritten. The
tracker remains the evidence record. A source test, build, or isolated package
check does not close a live, installed, provider, or production gate by itself.

## Status vocabulary

- **Verified source/package** — the implementation and its recorded regression,
  typecheck, build, or package evidence passed.
- **Implemented; live/release open** — source evidence exists, but the required
  installed, provider, production, or owner-visible proof is still missing.
- **Design/incomplete** — the direction is recorded, but implementation or
  proof is not complete.
- **Held/excluded** — intentionally not staged or changed in this pass.

## Current preservation and release boundary

- Recoverable checkpoint: Git ref
  `refs/m9r/checkpoints/pre-master-2.1-20261019`, object
  `b6134fae25379551c564d2000009e3c24dac4946`. It covers the tracked dirty
  worktree without changing the working tree. Untracked files and artifacts
  remain in place and were not silently folded into the checkpoint.
- The current checkout is dirty by design. The candidate/runtime provenance
  records that fact; it must not be represented as a clean release until an
  allowlisted commit and clean rebuild exist.
- Automatic artifact draining is explicitly deferred. No broad deletion,
  process killing, runtime restart, provider reconnect, or database change is
  part of this reconciliation.
- Retained and excluded from any commit until separately reviewed: activation
  evidence, recoverable quarantine history, `engine/` runtime outputs and
  backups, `scratchpad/` including its local secret, the user document, and
  unverified icon/reference assets.
- Verification already recorded for the current candidate: 206 test files and
  2,586 tests passed; packaged CLI 19/19; Codex delivery 39/39; typecheck;
  production build with 138 pages; focused lint; native command plus Windows
  stage regressions 61/61. Full scoped lint is not clean (15 errors and 704
  warnings in baseline/generated or otherwise unrelated areas), and the high-
  severity audit remains open (21 vulnerabilities: 1 critical, 19 high, 1
  moderate). These are release gates, not silently ignored failures.

## Ordered master list

| # | Area | Current conclusion | Still required before closure |
|---:|---|---|---|
| 1 | OpenCode reliability | Stale-model migration, provider-scoped selection, no-replay guards, and asynchronous provider-failure terminalization are source/package verified. | Fresh clean installed OpenCode acceptance, including no stale task selection. |
| 2 | Provider binding | Continuation/dead-claim reconciliation, PID precedence, worker identity propagation, stable shims, and installed reconnect coverage are source/package verified. | Current-runtime continuity for Claude, Codex, and OpenCode; reconnect, reboot, update, and heartbeat presence proof. |
| 3 | Runtime/update handoff | Build identity, managed convergence, graceful drain boundaries, watchdog ownership, generation checks, rollback retention, and cleanup tests are verified. | Live active-work drain, replacement/retirement, reboot persistence, and no-orphan proof. |
| 4 | Task lifecycle | Atomic claiming, explicit states, age-bounded reconciliation, provider scoping, async failure finalization, result fencing, idempotency, and identity gates are verified. | Coordinated live failure/reconnect and ordinary user-facing lifecycle proof. |
| 5 | Presence/relay/messaging | Local heartbeat, provider-neutral relay/mention routing, liveness freshness, idempotency, provenance, and queue/dead-letter bounds are verified. | All-three-provider simultaneous presence, live cross-provider mention routing, resumable delivery, and removal of inbox-polling friction. |
| 6 | Open-world live matrix | Provider-neutral action/delivery source suites are green; prior Calculator, Settings, Paint, and provider lanes are evidence only. | Arbitrary apps/sites/browsers/workflows through Codex, Claude, and OpenCode, separately and together, with visible postconditions. Named apps are smoke fixtures, not the acceptance boundary. |
| 7 | App/window discovery | Launcher/renderer matching, existing-window adoption, ownership coordination, refusal, focus separation, recovery states, and stage lifecycle fixes are source-verified. | Arbitrary installed-app proof, focus/occlusion recovery, and universal live window ownership. |
| 8 | Universal actions | Generic semantic/coordinate targeting, actionable ancestors, deep trees, field memory, insert/replace, foreground delivery, keys, hotkeys, scroll/drag, popup capture, dispatch classification, and postconditions are source/fixture covered. | Live action-family coverage: cancellation, pointer isolation, menus, clipboard, resize, move, minimize/maximize/restore, and arbitrary controls. |
| 9 | Background/foreground recovery | Focus verification, recovery anchors, registry rehydration, background-launch handling, and distinct window states are implemented or designed. | Equivalent background/foreground execution, automatic reopen/resume, and joint-window leasing. |
| 10 | Persistent cursors/pointer isolation | Shared cursor delivery, physical-pointer capture/restore hooks, and provider-neutral integration are source/fixture covered. | Cursor before first action, simultaneous/multi-monitor rendering, animation, and live isolation proof. |
| 11 | Cursor identity/colors | Persistent allocation is wired through dashboard, pill, feed, and activity surfaces; focused allocator/UI tests passed 54/54. | Native theme assets, customization UI, reconnect persistence, labels, and joint-window color outlines. |
| 12 | Pine-style observation | Local UIA/DOM-first observation, revisions/change tracking, honest partial/truncated status, bounded fallback, popup metadata, and image budgeting are verified. | Arbitrary native/browser live parity, event freshness, and installed provider acceptance. This is local structured observation, not a cloud Pine Computer dependency. |
| 13 | Route ownership | Native-versus-extension separation, target-family pinning, disabled extension registration, no-double-dispatch, and packaged route checks passed 47/47. | Fresh OS-only browser proof, cursor attribution, pointer isolation, and opt-in shared-tab acceptance. |
| 14 | Paste reliability | Shared typed/pasted path and stale-idempotency handling are traced and covered. | Real event-level capture of the owner-reported arbitrary-paste symptom, or a documented non-reproduction with the attempted input classes. |
| 15 | History/provenance | Generated-envelope provenance, human provenance, transcript/session deduplication, submission idempotency source work, and T261 reconciliation are verified. | Production duplicate-row acceptance, historical-row policy, random-chat prevention, and fresh dashboard proof. |
| 16 | Latency | Durable inner phase timing and bounded fallback payloads are implemented/tested; corrected T261 timeline is recorded. | Fresh T261-class correlation and root cause of the historical 59.516-second gap. |
| 17 | Model switching | Authorized setting persistence, catalog validation, ACP/Codex application, and adapter/settings/discovery suites are verified. | Visible mid-session model change in Codex and Claude native UIs. |
| 18 | Pill/dashboard/workspace UX | Provider-visible text no longer needs internal routing metadata; concise delivery, color wiring, and public consistency boundaries are verified. | Live mention UX, taskbar artifact ownership, cursor harbor/presentation, and intentional update UI. |
| 19 | Runtime safety/cleanup | Recoverable quarantine, rollback retention, stale-build convergence, duplicate-watchdog prevention, and bounded cleanup rules are verified without blanket killing. | Evidence-backed stale-worker retirement, restart/reboot persistence, and user-safe cleanup behavior. Automatic artifact draining remains deferred. |
| 20 | Updater/release | Signed check-only contract and Tauri updater plan exist; implementation is not represented as shipped. | Hosted manifest/endpoint, signing, check/download/apply/restart/rollback, UX specification, packaged acceptance, and final icon assets. |
| 21 | Public readiness | Signup age gate, pricing/Terms consistency, PWA correction, public-content checks, and typecheck are verified. | Live homepage/workspace audit, billing/webhook proof, legal/operator sign-off, deployment, and onboarding acceptance. |
| 22 | Architecture/roadmap | Active roadmap versus historical material is reconciled; local-session, joint-window, takeover, replay, wallets, and federation boundaries are documented. | Local disposable-session proof, resource measurements, recovery semantics, and later product implementation decisions. No provider-specific or cloud-session assumption closes this item. |
| 23 | Demo/release gates | The ordered gate register and evidence boundaries are documented. | Full live demo/release run from a clean, allowlisted, rebuilt package with all provider and open-world gates recorded. |

## Release sequence from this checkpoint

1. Keep the checkpoint and 2.0 history intact. **Done.**
2. Reconcile the tracker ledger, source diffs, tests, installed evidence, and
   retained artifacts into this 2.1 document. **Done.**
3. Build a reviewed allowlist of source, regression tests, migrations, and
   documentation that are actually verified. Exclude generated runtime output,
   secrets, user documents, historical quarantine, and unverified design/icon
   files. **In progress.**
4. Stage and review logical commits separately. The documentation boundary is
   committed as `7f806b79` plus tracker correction `f600bd92`, and the verified
   foreground/package reliability group is committed as `5f447ba7`, and the
   provider-neutral delivery/runtime group is committed as `61469d95`. The
   remaining mixed source and product edits are not staged or committed.
   **In progress.**
5. Rebuild from the resulting clean commit, run the release manifest/checks,
   and compare the complete artifact set. **Open.**
6. Only after that, activate/reconnect as an explicitly authorized live change,
   then run the provider and open-world acceptance gates. **Open.**

The next safe commit boundary is therefore a reviewed allowlist, not an
automatic “commit everything modified” operation.
