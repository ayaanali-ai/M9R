# One pill: porting Coucou's Windows island into M9R — design

Status: **design for approval, nothing built.** Written 2026-10-02 from a read of Coucou's source (commit 7df46f2, cloned to a scratch folder outside the repo) and of M9R's three current pills (docs/m9r-quiet-agents-and-pill-plan.md section 9).

## 1. Scope the owner set

Take everything from Coucou's Windows app that makes it feel like macOS-level software: the motion engine, state machine, layout system, window behaviour, views, settings sidebar, drop-a-file flow, chat, activity ticker, approvals UI, styling. Do **not** take, and replace with ours: the Mochi character (`src/mochi/*`), the 28 sounds, the app icon and tray icon, the name "Coucou"/"Mochi" and anything that says it. Agent icons are the real Claude, Codex and OpenCode provider logos and agent names are the provider handles. Sounds are optional and decided later; the character is designed later and is not on the critical path. Coucou's integrations (Stripe, n8n, GitHub, Vercel, Resend, Notion, Cal.com, Apple Music) are not M9R features and are not ported.

What "hook relay" means: Coucou installs a tiny program (`coucou-hook.exe`) that Claude Code calls on each event and that forwards the event to the app over a Windows named pipe. M9R already has the equivalent (`m9r-hook.exe`, the resident engine and `~/.m9r/feed.json`), so none of Coucou's relay code is needed. We port the UI and window code, not the plumbing.

The single-pill goal: one pill that does everything the three do now: show every agent and what it is doing, approve or deny, link sessions, and **type any message and send it to any agent** (with @mentions), with the same behaviour whether it runs as the desktop pill or inside the browser.

## 2. What the source gives us (map)

| Coucou file | Role | Our use |
|---|---|---|
| `src/core/anim.ts` | easing set; damped-spring integrator equal to SwiftUI `.spring(response, dampingFraction)`, sub-stepped to 240 Hz; 340 ms close curve | port as is |
| `src/island/fsm.ts` | hidden / peek / home / greeting state machine with timers and a pinned state while an alert waits | port; rename states, keep timings as settings |
| `src/core/layout.ts` | modes hidden/compact/expanded, per-view sizes, corner radii, wake strip, glow and wash colours | port; replace the bot placement with our agent marks |
| `src/island/island.ts` (33 KB) | the controller: launch, expand, collapse, alert, reveal, cursor follow, settings | port; remove integration and character parts |
| `src/core/state.ts`, `bridge.ts` | app model and the Tauri command facade | **replace** the model with M9R's agent/task/approval/thread state; replace the bridge with our adapters (section 4) |
| `src/views/*` (chat, ticker, views, upload, icons) | panels | port chat as the message composer, ticker as the activity feed, upload as agent-to-agent file hand-off later |
| `src/settings/*` | settings sidebar | port; our options (position, do-not-disturb, sounds off, animation level) |
| `src/style.css` (26 KB) | tokens and transitions | port tokens and motion; re-theme to M9R |
| `src-tauri/src/island.rs`, `platform/windows.rs` | borderless, transparent, always-on-top, never-focused window at top-centre, per-frame click-through with a 14 px margin, DPI and monitor placement, wake strip | merge with the window code in `overlay/src-tauri/src/main.rs` |

Same stack as our `overlay/` (Tauri 2, Vite, vanilla TypeScript, no framework), so the port is a transplant, not a rewrite.

## 3. Architecture

One shared UI package, two thin shells.

- `pill/` (new): the ported UI, built by Vite into static files. State comes from one interface:
  `PillTransport { subscribe(listener: (state: PillState) => void); send(command: OwnerCommand) }`.
- **Desktop shell:** the Tauri window (replaces the UI in `overlay/`; keeps its Rust for feed reading, approve/deny commands, link picker, tray, engine supervision, hotkey/DND). Adapter reads the feed and web activity as today and converts them to `PillState`.
- **Browser shell:** the extension's `pill.html` iframe loads the same bundle. Adapter talks to the service worker (`pill-bridge.js`, nonce-gated as today) which already receives the broker's `ui-state`. Docks to the top-centre of the viewport and keeps the existing edge docking.
- **One at a time:** when the desktop pill is running, the browser shell stays collapsed to nothing (it asks the broker for `desktopPillRunning`, which the Tauri app reports), so the owner never sees two. Without the desktop app, the browser shell is the pill, which keeps the "no new app" path.
- **One state shape** (`PillState`): agents (handle, provider, state, activity), approvals needing the owner, thread, in-progress tasks, per-agent web activity. The desktop feed schema and the broker `ui-state` are both converted into it by adapters, so nothing upstream changes in step one.

## 4. The message box

The chat view becomes the composer: type, `@claude` / `@codex` / `@opencode` completion (reusing `mention-logic.js`), send. The owner's text goes through the existing path (`pill-bridge` owner command in the browser, an engine command from Tauri) so routing, approval rules and the stale-prompt guards all stay as they are. No new route to the agents is created.

## 5. Build steps (each ends with a check and a stop)

1. **Baseline port:** copy the Windows UI into `pill/` on a branch, build it against a mock `PillState` (like `overlay/public/mock-feed.json`), with no Mochi, sounds or integrations. Check: it renders and animates identically to Coucou's on the same mock, side by side.
2. **Adapters:** feed adapter (desktop) and bridge adapter (browser). Check: live agent states and approvals match what the old pills show.
3. **Composer:** typed messages with @mentions reach agents from both shells. Check: round trip to Claude, Codex, OpenCode.
4. **Approvals and linking** (from the old desktop pill) moved into the new views. Check: approve, deny, "allow for a day", link picker.
5. **Browser shell and de-duplication.** Check: opening a new window or tab shows exactly one pill, in every Chrome window.
6. **Brand:** provider logos, M9R mark, tokens; sounds off; character placeholder only. Check: owner review.
7. **Retire the old pills** only after the owner signs off steps 1 to 6.
8. **Package and sign** the desktop shell (unsigned installers get flagged by Defender, as Coucou's did).

## 6. Edge cases and risks to test

Per-frame click-through must never block clicks on the page beneath; multi-monitor and DPI changes; Windows taskbar position and full-screen apps (hide behind a full-screen video); reduced-motion preference; keyboard-only operation and focus order; a spring loop running only while animating (idle CPU near zero); extension CSP (no inline script, no eval; Vite output is compatible); iframe inside heavy pages must not steal focus or scroll; the owner-command trust rules in `pill-bridge.js` stay intact (only our own frame with a registered nonce can send commands); sensitive text from the feed placed with `textContent`, never as HTML (the current overlay's rule).

## 7. Licensing

Copied files keep their MIT notice. One `THIRD_PARTY_NOTICES` file ships with the installer; it is not shown in the UI or marketing and does not describe M9R as built on anything. The name, character, icon and sounds from Coucou are not used anywhere (`LICENSE-ASSETS.md` forbids shipping them).

## 8. Decisions needed

1. Approve the one-state-shape, two-shells architecture and the build order above.
2. Neutral placeholder (M9R mark only) until the character is designed, or a simple temporary mark?
3. Keep the old overlay and in-page pills running until step 7, or switch to the new one as soon as steps 1 to 3 pass?

## 9. Owner answers (2026-10-02)

Architecture (one shared UI, two shells, one state shape) and the build order: **approved**. No M9R-mark placeholder: the owner wants to see the whole pill before judging brand elements. The old three pills stay in place until step 7; the new pill runs only behind a developer switch until the owner signs off steps 1 to 6.

## 10. Build status (2026-10-02, worktree `C:\RunLeak\runleak-claude-fixes`, branch claude/one-pill, nothing committed since steps 1-2)

Done and tested: steps 1-3; step 4 (undeliverable messages offer "Link a session…" in the desktop shell; approve, deny and "allow for a day" were already in); step 5 in the browser (the pill mounts in the page frame behind a developer switch; no separate message bar; Alt+M opens the pill's message view).

Developer switch: set `m9rPillNext` to `true` in the extension's `chrome.storage.local` (any extension page's console), reload the page. Build the frame bundle with `npm run build:ext` in `pill/` (writes `extensions/browser/pill-next/`). Without the switch nothing changes.

Verified in a real Chromium with the extension loaded from the worktree: exactly one frame mounts (the new pill, no old pill, no message bar); it hangs from the top edge at exactly the island's size so the page stays clickable; it showed live agents from the local broker; Alt+M opened the message view with the cursor in the field and the @agent chips.

Added later the same day: push-to-talk (mic button, hold; Alt+M hold from the page or from inside the pill; speech lands in the field and is never sent; browser only, the desktop window has no speech service) and the desktop window hooks (Rust commands `pill_set_rect`, `pill_set_collapsed`, `pill_set_focus`; opt in with `M9R_PILL_NEXT=1`; build the UI into the overlay with `npm run build:desktop` in `pill/`, then rebuild the overlay). Verified in a real Tauri window: 720x320 centred, folds to a 240x6 wake strip and back, bad rectangles rejected.

Not done: automatic one-at-a-time with the desktop pill (needs the broker or the desktop app to report that it is running; for now the owner picks by the switch); speech in the desktop window; step 6 owner review; step 7 retiring the old pills (after sign-off); step 8 signing.
