# M9R reliability work — handoff

Written 2026-11-01 for whichever agent continues this work. Read all of it before editing anything.

## Your job

Make M9R's agents act on the desktop and in the browser as reliably and quickly as Cua, Vercel Labs' agent-browser and
agent-desktop. The wiring already exists. The failures come from M9R's own safety layer misreading outcomes and blocking
itself. Continue from Phase 2 below, in order. Commit each phase separately. Stop on any failing gate and report it
instead of working around it.

## Where things stand

- **Installed on the owner's machine (2026-11-02, verified live):** `4908faaf`, runtime build
  `c1fb5e999b33f81b17e8144d6c7032105f8fc65a21a96c9c4b3c0628f99a8afc`. Phases 1–3 are live and proven on the owner's
  real machine, not just by tests. Phase 4 (speed) and Phase 5 (acceptance) have not started.
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
| `a298df56`, `2de35f6a`, `1509828b`, `7ff62348` | Codex | **Phase 2**, reviewed and confirmed correct — structured-only completion, orphaned-task reconciliation preserving uncertain evidence, installed/verified |
| `ea225178` | Claude | **Phase 3.1** — Chrome background-typing recovery via bounded foreground escalation |
| `fce10e17` | Claude | **Phase 3.2** — ghost-cursor background refusal no longer a plain-Error surface lock |
| `e4375dcf` | Claude | **Phase 3.3a** — `m9r_browser_open`/`m9r_browser_tabs` gated off by default (necessary but not sufficient, see next row) |
| `4908faaf` | Claude | **Phase 3.3b, the real fix** — `scripts/m9r-web-broker.ts` no longer builds the isolated CDP browser transport unconditionally; installed and live-verified via `/web/status` |

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

Phase 2 closure: correction 2de35f6a installed from its clean candidate, runtime build 3b133bcf3a7663d556c34b4179467b84f1da7006fc6932b19790f797834c1a76. All 184 installed artifacts match. Broker health and runtime identity verified; one broker and one pill. T23/T84 now have canceled work receipts, incomplete remaining work, and preserved uncertain delivery evidence. Pill remains 4db938e8.

**Phase 3 decision, made by the owner and closed: no isolated browser, no extension, ever, as a default route, for any user.** The owner tested the native-desktop route directly (it opened their real signed-in Chrome, searched YouTube, played a video) and explicitly rejected both alternatives Codex proposed (a browser extension, an isolated CDP-connected Chrome profile). See `ea225178`, `fce10e17`, `4908faaf` below for what this took; do not revisit this decision or re-enable either route by default without the owner asking first.

**Installed and live-tested (2026-11-02):** commit `4908faaf`, runtime build `c1fb5e999b33f81b17e8144d6c7032105f8fc65a21a96c9c4b3c0628f99a8afc`. Confirmed via the broker's own `/web/status`: `{"browserTransport":"native-desktop","extensionConnected":false}`. Live task "Open Chrome, search YouTube for Strawberry Park, play the latest video" (T121) completed end-to-end: opened the owner's real signed-in Chrome, searched, **sorted by "Recently uploaded" and verified the correct newest video before playing it** (self-corrected a bad run two attempts earlier where it played a 5-day-old video without checking). 14/15 actions confirmed; 1 still logged "uncertain" (a keyboard-event background refusal, cause not yet isolated — see Phase 3.4 below).

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

### Phase 3 — browser route — CLOSED, do not reopen without the owner
The owner decided: native desktop/UIA only, against their real signed-in Chrome, never the CDP daemon or the
extension, by default, for any user. What shipped (read before touching browser code again):

1. `ea225178` — Chrome refuses *background* `set_value`/`type_text` outright; Cua's `TypeTextInput` has no
   `deliveryMode` field at all (unlike `ClickInput`), so there was no way to retry it foreground. Fix: when
   `deliveryMode === "background"` and the driver cleanly refuses (not just `"owner-preview"`, which already had
   this), `driverInputAction` now falls through to the same bounded `runForeground()` recovery — wait for the owner
   to be idle, bring the exact window forward, dispatch, confirm, restore the owner's pointer. **This changes the
   hard rule below** ("background-mode stages must never take the owner's pointer") to: *may, only as a one-shot
   last resort after background delivery is confirmed refused, never as a first attempt.* Covers `typeIntoExactField`
   too (same `deliveryMode` gate).
2. `fce10e17` — the ghost-cursor overlay move (`moveAndVerifyCursor`, `requireProof: true` branch, used by the
   explicit `cursor` MCP action) called the bare `resultError()` helper, which throws a **plain** `Error` for any
   driver refusal, including a background-input refusal — violating the typed-error hard rule even though no real
   window was ever touched (the overlay is presentation only). That plain error got recorded *uncertain* and locked
   the surface for the *next* real action, even though nothing real had failed. Fix: new `resultErrorTyped()`
   reclassifies a background refusal here as `DesktopInputNotDispatchedError("background-unavailable")`. It
   deliberately does **not** escalate to foreground — stealing focus to show a cosmetic cursor is not justified.
3. `4908faaf` — **the actual root cause of the isolated-browser pop-up the owner kept seeing.** `m9r_browser_open`
   (gated off in `e4375dcf`, see below) was never the only way to reach the isolated browser. The real production
   entry point, `scripts/m9r-web-broker.ts` (compiled into the installed `m9r-web-broker.exe`), **unconditionally**
   built `browserTransport = createBrowserDaemon(() => launchAgentChrome(...))` at startup and passed it to
   `startWebBroker`, alongside `nativeDesktopRoute: true`. Read `web-broker-server.ts`: `nativeDesktopRoute` only
   feeds a status string (`/web/status`'s `browserTransport` field) — **nothing in the actual dispatch path reads
   it.** Every real place that sends a browser-tab-kind action checks `options.browserTransport` first; if it's set,
   that's what runs, full stop. `m9r_browser_tabs` alone (a read-only "list tabs" call, still registered after the
   first gate) was enough to trigger `ensureReady()` on the isolated daemon. Fixed by building `browserTransport`
   only when `M9R_ENABLE_ISOLATED_BROWSER=1` is set (it is not, by default); `m9r_browser_tabs` is now gated the
   same way `m9r_browser_open` already was (`e4375dcf`), since it has nothing to report without a transport.
   **Verify this is still true before any future change to `m9r-web-broker.ts` or `web-broker-server.ts`:** run
   the installed broker and `curl`/`Invoke-RestMethod` its `/web/status` with the broker key from
   `~/.m9r/web-broker.key`; it must read `"browserTransport":"native-desktop"`, never `"agent-chrome"`.
4. **Not yet closed:** T121's live run still logged one `background-unavailable` refusal on a **keyboard** event
   (not the cursor overlay, not `typeIntoExactField` — those are now fixed and tested) that still surfaced as
   *uncertain* rather than a clean typed refusal or a foreground recovery. The task completed anyway (the agent
   retried), so this is not blocking, but it is a real, unisolated gap. Candidates to check, in order: (a) `pressKey()`'s
   own call into `driverInputAction("press_key", ...)` — confirm it's actually reaching that function and not a
   different, earlier-return path; (b) `nativeControl()`'s `move_cursor`/`click`/`type` child-input path (a DIFFERENT
   mechanism from the Cua driver, used when a native Win32 child control is found — check whether it has its own
   unclassified-refusal problem); (c) any other `resultError(` call site in `cua-stage-driver.ts` not yet converted
   to `resultErrorTyped` (grep `resultError\(` — several remain, e.g. lines handling `setAgentCursorMotion`,
   `setAgentCursorEnabled` before the first desktop action, and the standalone `move_cursor` prepare step). Do not
   guess which one it is from this description alone — reproduce it (the same "search YouTube, play a video" task,
   a few runs if needed), capture the exact `detail` text and which MCP action/phase it occurred on from
   `~/.m9r/state.json`, and trace that specific call site before changing code.
5. Browser observations should return only what changed after an action (agent-browser's snapshot delta), not a
   full tree each time. Still open; see Phase 4.4 below, it's the same underlying cost.

### Phase 4 — desktop speed

**Latency finding, from T121's own timing data (2026-11-02), do not re-derive this from scratch — reread
`~/.m9r/state.json`'s `stageTiming` for any task and sum `durationMs` grouped by `phase` to reproduce it:**
engine-side work (`action`, `launch`, `prepare`, `session-start`, `runtime-acquire`, `queue_wait`, `sdk-load`,
`host-connect`, `cursor-visible`, `provider-acceptance`, `cursor-motion` — everything that is actually M9R/Cua
dispatch) summed to **~69 s out of a 261 s task.** The remaining ~190 s (73%) is not in any engine phase at all —
it is the time the provider (the LLM) itself spends thinking between tool calls: reading the returned
screenshot/structure, deciding the next action, writing it out. **This is not an M9R engine bottleneck; it is
inference time on the provider side, and no amount of driver/session optimization touches it.** Do not "fix" this
by further speeding up `runtime-acquire`/`session-start` — they are already cheap (runtime-acquire averaged 39 ms,
session-start 342 ms over this run; Codex's original claim that session reuse was the bottleneck was already
checked and rejected, see "Where Codex's list needed correcting" below). The only real levers on the LLM-thinking
side: (a) return a smaller, more targeted observation (see item 1 below) so there's less for the model to read each
turn; (b) let obviously-independent steps batch into one tool call (item 5); (c) a faster/smaller model for routine
steps is an *owner* product decision, not something to change unilaterally.

1. After an action, return a "what changed" summary; include a screenshot only when asked or when no structure exists.
   Today almost every action returns an image (up to 512 KB, up to 4 per observation), which also slows the model.
2. Expire references when the surface changes (revision), not 30 s of wall time (`MAX_OBSERVATION_AGE_MS`).
3. The money gate re-reads the screen (sometimes `parseVisualRegions`) before every click. Reuse the label from the
   agent's last observation when the click is by element ref.
4. Keep the driver warm between tasks; check Cua driver releases (installed 0.34.0, 2026-10-27) before updating.
5. Allow a short action batch in one call (type, then Enter).
6. Launch: resolve installed apps instead of npm shims (`codex` → the Codex app, not `%APPDATA%\npm\codex`); with
   several Chrome windows, use the active one instead of refusing.
7. **Scrolling/reasoning gap, observed live (2026-11-02), not yet root-caused — do not hardcode a fix.** On a YouTube
   search results page, the agent did not scroll down or check more than what was immediately on-screen before
   picking a video; a later run self-corrected by explicitly sorting "Recently uploaded" and checking the upload
   date before playing, so this is inconsistent, not a hard failure every time. The owner was explicit: **do not
   hardcode "always scroll" or any other YouTube-specific behavior** — that's a band-aid, not a fix. The real
   question to investigate is whether `read_structure`'s result tells the agent when content is cut off below the
   visible viewport (a true "there is more below, not yet observed" signal) versus silently returning only what's
   currently rendered as if it were the whole page. If the model isn't told something is truncated, it has no way
   to know to scroll — that's an observation-completeness bug, not a prompting problem, and the fix (if confirmed)
   belongs in the structure/observation contract, not in a system prompt telling the agent to "remember to scroll."

### Phase 5 — prove it
Acceptance runs against real apps: Chrome/YouTube, Spotify, Notepad, File Explorer, a canvas, plus owner pointer
movement mid-action, a new owner message mid-task, and parallel agents on separate windows.

### Out of scope for this work, explicitly deferred by the owner (2026-11-02)
- **Conversation/task memory surviving reboots.** The owner asked whether M9R has anything like persistent
  conversation state across a laptop restart. It does not, as far as this work looked — `~/.m9r/state.json` persists
  tasks/events durably across restarts already (that's how this whole investigation reads prior runs), but there is
  no mechanism for a provider's mid-conversation *context* to resume after a reboot. The owner said this is
  important but explicitly **not** part of this phase — do not build it as a side effect of anything above.

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
- Background-mode stages may take the owner's pointer **only as a one-shot last resort**, after background delivery
  is confirmed refused by the driver (never as a first attempt, never speculatively). This was changed in `ea225178`
  — the earlier wording ("must never") is superseded; see Phase 3.1 for why and the exact gate that still protects it
  (`driverInputAction`'s `options.deliveryMode === "background" && options.preferForeground` throws immediately —
  only the post-refusal recovery path is new).
- **The isolated CDP browser profile and the browser extension are never a default route, for any user, under any
  circumstance, without the owner explicitly asking first.** This was tested live and explicitly rejected twice
  (2026-11-02). `M9R_ENABLE_ISOLATED_BROWSER=1` is the only way to turn the isolated daemon back on; it is not set
  in the installed runtime. Do not add a fallback that silently switches to it, do not re-register `m9r_browser_open`
  / `m9r_browser_tabs` without the same gate, and do not build a new code path that constructs
  `createBrowserDaemon(() => launchAgentChrome(...))` anywhere else without the same env-var gate.
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
