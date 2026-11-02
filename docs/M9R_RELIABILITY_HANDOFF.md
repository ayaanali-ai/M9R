# M9R reliability work — handoff

Written 2026-11-01 for whichever agent continues this work. Read all of it before editing anything.

## Your job

Make M9R's agents act on the desktop and in the browser as reliably and quickly as Cua, Vercel Labs' agent-browser and
agent-desktop. The wiring already exists. The failures come from M9R's own safety layer misreading outcomes and blocking
itself. Continue from Phase 2 below, in order. Commit each phase separately. Stop on any failing gate and report it
instead of working around it.

## Where things stand

- **Installed on the owner's machine:** an engine built from `84a4399a` (2026-11-01 16:11). **Nothing listed below is
  live yet.** Every failure in the owner's run history (`~/.m9r/state.json`) came from that older build.
- **Branch:** `main`, local only, not pushed. Working tree clean except the untracked `.test-tmp/`.

### Already done and committed

| Commit | Author | What it does |
|---|---|---|
| `c8b86c1f` | Codex | Preserve recovery and enforce the background-delivery boundary |
| `1b983386` | Codex | Reuse Cua sessions; cursor presentation no longer gates dispatch (cursor overlay can't block actions) |
| `e6d1b0e3` | Codex | Bind native windows to process generations; centralize rebinds |
| `bc58522b` | Codex | Broker-owned CDP browser daemon (`browser-daemon.ts`, `agent-chrome.ts`); browser route can click |
| `9a906d88` | Codex | Preserve incomplete work; structured delivery receipts |
| `7cc8e207` | Codex (saved by Claude) | Codex's unfinished integration pass, saved exactly as left: typed pre-dispatch refusals, work identity on receipts, `m9r_browser_open` / `m9r_browser_tabs` / `m9r_computer_inspect`, browser tab select/close, cursor label ordinals. Reviewed: typechecks, focused tests pass. |
| `5e85e321` | Claude | Pill test builds full settings (the pill gained voice/glow settings) |
| `85d876fa` | Claude | **Phase 1** — see below |

Pill redesign (all committed, intentional, keep it): `97062da5`, `62ecda3d`, `26039b7d`, `5d73a758`, `9e06bad1`,
`f8aac6fc`, `e6863d57`. `036ec923` was reverted by `66d4f265` at the owner's request — do not re-apply it.

### Phase 1 (`85d876fa`) — what it fixed and why

1. **Driver refusals.** Cua's own contract (`node_modules/@trycua/cua-driver/dist/native/cua_driver_contract.d.ts`):
   `ActionResult.effect = Refused (4)` with `error: { code, hint }` means *"sent no input"*, and
   `escalation: { target: Foreground }` names the route that can deliver. M9R's refusal check read only text fields,
   so it never saw this. Result: Chrome's background refusal never fell back to foreground, and `actionOutcome` threw a
   plain `Error`, which the stage recorded as *uncertain* and the dispatch fence turned into a surface lock
   ("A prior action on this surface has an unresolved outcome"). Now `driverRefusal()` in `cua-stage-driver.ts` reads
   the typed fields; a refusal throws `DesktopInputNotDispatchedError` (`background-unavailable` when foreground is
   named, else the new `driver-refused` code), and owner-preview escalates once to foreground.
2. **Pre-input checks inside the dispatch window.** The stage sets `dispatchStarted` *before* calling the driver, so any
   plain `Error` from the driver's own pre-checks was recorded as uncertain. Converted to typed not-dispatched:
   expired desktop view, desktop-wide input target missing/unverifiable, point outside capture, desktop assignment.
3. **Lock recovery in one response.** A not-dispatched `mutation-revision` gate (surface lock or stale revision) now
   returns a fresh observation from `computer-use-mcp.ts` instead of a bare refusal. A fresh observation of the same
   surface is what clears the lock (`observeSurface` in `multiplayer-dispatch-fence.ts`).
4. **Money gate.** `stageClickNeedsApproval`: only labels that look like money hold for the owner. Unlabeled controls
   and points the driver can't describe carry no money signal and proceed. A stale **element ref** still refuses.
5. **Legacy window bindings.** Codex's `7cc8e207` refused any saved stage without a process generation. All five
   anchored stages on the owner's machine lack one, so every action on them would have failed after install. Now the
   generation is backfilled on inspection when the live window has the same PID and HWND; protection applies after.
6. **Paused task ids.** A new owner message pauses the running task and carries its context into a fresh task. Agents
   kept naming the paused id and were refused ("This task is paused"). `resolveTaskId` in `mcp-server.ts` now maps an
   explicitly named *paused* task to the session's current pending task. Canceled stays canceled.
7. **Owner pointer hand-back** window raised from 1.2 s to 5 s.

Tests added: typed refusal (foreground and other), legacy generation backfill, paused-task redirect. Updated: two
money-gate tests and six message patterns that encoded the old behavior.

## Evidence (owner's run history, pre-fix build)

From `~/.m9r/state.json` (115 tasks): 13% of computer actions and 17% of stage operations ended *uncertain*.
Top errors: Chrome background refusal recorded as uncertain (9×), the surface lock it caused (9×), unresolved click
target (10×), unlabeled-control refusal (5×), desktop-wide typing refused (6×), Codex app launch resolved to the npm
CLI shim `ENOENT` (5×), multi-window Chrome launch refused (5×). One desktop action took 2.6 s typical, 7.7 s at p90.
**17 of 75 tasks marked "completed" say in their own result that they failed or were blocked.** 10 tasks are stuck in
"acknowledged" and 3 in "queued".

## Remaining work, in order

Phase 2 closure: correction 2de35f6a installed from its clean candidate, runtime build 3b133bcf3a7663d556c34b4179467b84f1da7006fc6932b19790f797834c1a76. All 184 installed artifacts match. Broker health and runtime identity verified; one broker and one pill. T23/T84 now have canceled work receipts, incomplete remaining work, and preserved uncertain delivery evidence. Pill remains 4db938e8. Expanded gate passed 205 tests with zero failures and one explicitly skipped live-browser test; typecheck passed. These are automated contract checks and live installation/state checks, not a provider-driven desktop acceptance run. Phase 3 is next; its isolated-browser versus personal-Chrome shipping decision remains with the owner.

### Phase 2 — honest results
Phase 2 implementation: only structured completion can produce success; plain provider output remains incomplete. Broker startup settles orphaned queued/acknowledged work for configured providers once, preserving remaining work and terminal reasons. Abandoned work with uncertain input is canceled while its delivery evidence remains uncertain; startup also repairs inconsistent records created by the first Phase 2 installer. New human goals strip the historical room footer; teammate context remains in the provider prompt. All 82 historical result summaries were checked: none can produce success without a structured completion report, covering the reported 17 false successes. Runtime a298df56 was installed and accepted in 1509828b; the follow-up correction must be installed and verified before Phase 2 is closed. The opening installed-state description is the original handoff baseline, not current runtime state. Updated compatibility tests to report structured completion and made the Notepad lookup assertion case-insensitive (Windows search semantics).

1. A task is `completed` only when the agent reports completion through `m9r_result` with a completed status. When a
   provider turn ends without that, mark it incomplete/blocked and keep the reason and remaining work. `9a906d88`
   started this (`task-completion-contract.ts`), but its plain-text detector only matches "couldn't
   finish/complete/verify/access" — T107's "I couldn't switch to the Codex desktop app…" would still be marked
   completed. Prefer the structured `m9r_result` status over text matching, and verify against all 17 examples.
2. Resolve tasks stuck in `acknowledged` / `queued` with no live turn: mark them with a clear terminal reason.
3. Stop appending the "Also in this room, not addressed by this message…" footer to the owner's goal text (82 of 115
   goals carry it). Put room context in the prompt, not in the goal.

### Phase 3 — browser route (infrastructure exists, routing does not)
1. `bc58522b` built the CDP daemon and the route reports `nativeClickAvailable`, but the agent prompt in
   `web-live-sessions.ts` (line ~115) still says *"Use M9R's native desktop tools for every web and app action"*.
   Change it so web work uses `m9r_browser_open` / browser-tab targets first, and the desktop route is the fallback.
2. **Decide with the owner before shipping:** the daemon is M9R's *isolated* browser. It does not have the owner's
   logged-in Chrome sessions. Tasks like "log in to blinn.edu" may need the owner's Chrome. Do not silently switch.
3. Browser observations should return only what changed after an action (agent-browser's snapshot delta), not a
   full tree each time.

### Phase 4 — desktop speed
1. After an action, return a "what changed" summary; include a screenshot only when asked or when no structure exists.
   Today almost every action returns an image (up to 512 KB, up to 4 per observation), which also slows the model.
2. Expire references when the surface changes (revision), not 30 s of wall time (`MAX_OBSERVATION_AGE_MS`).
3. The money gate re-reads the screen (sometimes `parseVisualRegions`) before every click. Reuse the label from the
   agent's last observation when the click is by element ref.
4. Keep the driver warm between tasks; check Cua driver releases (installed 0.34.0, 2026-10-27) before updating.
5. Allow a short action batch in one call (type, then Enter).
6. Launch: resolve installed apps instead of npm shims (`codex` → the Codex app, not `%APPDATA%\npm\codex`); with
   several Chrome windows, use the active one instead of refusing.

### Phase 5 — prove it
Acceptance runs against real apps: Chrome/YouTube, Spotify, Notepad, File Explorer, a canvas, plus owner pointer
movement mid-action, a new owner message mid-task, and parallel agents on separate windows.

## Where Codex's 18-item list needed correcting

- **#2 "stop reacquiring runtime/session per action"** — the data disagrees: runtime-acquire median 0 ms over 1,222
  samples, session-start 47 ms. Latency is the 3–4 screen reads per action plus images sent to the model.
- **#7 foreground escalation** — the intent was already in code; it failed because refusals weren't recognised
  (Phase 1 item 1). `84a4399a` tried to fix Chrome and the owner's T115 run still failed after it was installed.
- **#9 universal actions** — mostly exists already (`system_control`, window state, menus, clipboard). Not a fix.
- **#11 "retry: never"** — outdated; `computer-use-recovery.ts` only says never for truly terminal codes.
- **#14, #15** — hygiene / not causing failures. Later.
- Codex's list missed the root cause (typed refusal misread), the plain-error-inside-dispatch-window pattern, the
  per-click money-gate read, per-action screenshots, and the 30 s wall-clock expiry.
- Codex's list was right where my first audit was not: false task success (#12), task continuation (#10), the browser
  route (#6), and acceptance tests (#17).

## Rules — do not break these

- **Anything that stops before input is sent must throw `DesktopInputNotDispatchedError` (or a
  `StageInputNotDispatchedError` subclass).** A plain `Error` inside the stage's dispatch window is recorded as
  *uncertain* and locks the surface. This one pattern caused most of the failures.
- Never infer "not sent" from message text when a typed signal exists. Read the driver's typed result.
- Do not add a gate that refuses on missing evidence when the action itself would be safe (unlabeled control, legacy
  binding, cosmetic cursor). Unknown is not dangerous.
- Background-mode stages must never take the owner's pointer. Only owner-preview may escalate to foreground.
- Keep money holds. Canceled tasks stay canceled.
- Do not change the pill's visual design. Do not edit the "New idea" section of the Source of Truth without the owner.

## Tests

```bash
npx tsc --noEmit --allowImportingTsExtensions
```

Focused suite (run after every phase):

```bash
node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/register-alias.mjs --test ./scripts/agent-chrome-input.test.ts ./scripts/browser-daemon-live.test.ts ./scripts/computer-execution-loop.test.ts ./scripts/computer-use-recovery.test.ts ./scripts/cua-stage-driver.test.ts ./scripts/managed-provider-owner-queue.test.ts ./scripts/task-desktop-stage.test.ts ./scripts/universal-intent.test.ts ./scripts/windows-desktop-stage.test.ts ./scripts/task-completion-contract.test.ts ./scripts/multiplayer-dispatch-fence.test.ts ./scripts/multiplayer-action-policy.test.ts ./scripts/logical-task-context.test.ts ./scripts/windows-installed-apps.test.ts ./scripts/mcp-inbox.test.ts ./scripts/pill-shells.test.ts
```

**Failures that predate this work (verified by running them with Phase 1 removed):**
- `windows-installed-apps.test.ts` — "queries both modern Notepad registration names…" (unchanged code since 10-28).
- 17 tests across `native-codex-delivery`, `native-store-and-hook`, `native-identity`, `engine-mcp-smoke` and related
  hook/inbox delivery tests. Identical failures with and without Phase 1. Not part of this work unless the owner asks.

## Install (only when the owner says to bring it live)

1. Build one candidate from the exact committed source (`scripts/build-candidate.mjs`).
2. Stop every `m9r-hook.exe` / `m9r-engine.exe` process under `~/.m9r/bin` whose command line is `mcp` (not
   `feed --watch`, not the broker). Provider apps hold them and they lock `m9r-engine.exe`. They respawn in seconds, so
   install immediately.
3. `scripts/install-m9r.ps1 -PackagePath <candidate zip> -AllowLocalCandidate -CandidateReceiptPath <candidate.json>`.
   Answer its consent prompt yourself only when the owner has said to bring it live.
4. Never copy files into `~/.m9r/bin` by hand.
5. Accepting a runtime means copying the candidate's `runtime/m9r-build-info.json` byte-for-byte into
   `release-assets/accepted-runtime.json`. The pill changed intentionally today, so accept the new pill with
   `scripts/accept-overlay-candidate.mjs`.
6. Verify: installed hashes match the manifest, one broker/pill/feed engine, fresh start times. Then rerun the owner's
   YouTube task and compare against the evidence above.

## Testing cadence

Test live at checkpoints, not after every commit and not only at the end:
1. **Now: Phase 1.** It changes the riskiest path and should remove most blocks. Confirm before building on it.
2. **After Phases 2 and 3.** Phase 3 changes which route web work takes; test it on its own install.
3. **After Phase 4.** Speed changes; measure per-action latency against 2.6 s / 7.7 s.
4. **Phase 5** is the final acceptance run.
