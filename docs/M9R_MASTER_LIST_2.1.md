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
- Recorded verification at the current release boundary: 2,594/2,594
  repository tests, focused provider/action regression 205/205, Codex
  delivery 39/39, typecheck, production build with 138 pages, targeted lint,
  native/stage, dashboard, and marketing regressions, and `git diff --check`.
  Production dependencies report 0 vulnerabilities after the Hono patch-level
  override. The full-tree audit still has dev-toolchain findings whose force
  path proposes a breaking shadcn update; no breaking upgrade was applied.
  The full unscoped lint command did not complete, so targeted lint—not a
  fabricated full-lint pass—is the recorded result.

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
- Local sessions, takeover, joint windows, recovery anchors, replay, wallets,
  and federation boundaries are documented as product architecture. They are
  intentionally moved up here as foundational multiplayer work, not left as a
  late roadmap detail.

Still required:

- Fresh clean installed OpenCode acceptance, including no stale task selection.
- Current-runtime continuity for Claude, Codex, and OpenCode, including
  reconnect, reboot, update, and heartbeat presence proof.
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
- Remove inbox-checking and unnecessary owner-approval boilerplate from normal
  owner-originated work while retaining backend authorization and audit data.
- Keep task IDs, session IDs, tokens, delivery lists, and routing metadata out
  of the ordinary user and agent experience.
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
  draining is part of this pass. The clean packaged runtime boundary is now
  verified separately; activation/install and live-provider acceptance remain
  open.

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
   compare the complete artifact set. **Verified for the packaged candidate:**
   fresh build ID `381ec554b922aefb673c3f19e306aa15ad86cc897a7eaf7bb1b7a88a80e09190`,
   `sourceDirty: false`, 185 artifact identities, packaged MCP 2/2,
   transaction tests 3/3, and packaged binding/reconnect tests 4/4. Live
   install/activation is intentionally separate.
6. Only after that, activate/reconnect as an explicitly authorized live change,
   run the two difficult dry runs, rehearse the multiplayer demo, and record
   the final demo. **Open.**

The next safe action is therefore held-item review and live-acceptance
planning—not automatic deletion, blanket committing, runtime activation, or
provider acceptance. The release-boundary source/package work is complete for
this checkpoint; the remaining gates are explicitly live, visual, provider,
or held-product work.
