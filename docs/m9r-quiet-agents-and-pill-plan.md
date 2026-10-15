# M9R: quiet multi-agent cursors, agent Spaces, and one pill — research and plan

Status: research snapshot from 2026-10-02 (revised after the owner's correction); it is not an active approval gate or implementation status. Sources: Cua's public repo and docs (trycua/cua), Coucou's repo (Louis-CFM/coucou), read through fetched pages and file listings. In that research pass, no Cua or Coucou code was installed or run.

> **Historical research snapshot, not the current implementation status.** The Q/P sequence below predates later work. Use [M9R_CUA_WAVE_PLAN.md](M9R_CUA_WAVE_PLAN.md) for current C1–C15 status/order and [M9R_WINDOWS_DESKTOP_STAGE_ACCEPTANCE.md](M9R_WINDOWS_DESKTOP_STAGE_ACCEPTANCE.md) for current Track A Step 3 gates. The Coucou research and licensing notes remain reference material.

## 1. What Cua actually has (corrected)

An earlier draft of this note said Cua lacked per-agent cursors. That was wrong: it came from thin page summaries. The repo and blog show:

- **Per-agent cursors are real.** `cursor-overlay` crate (14 files, about 260 KB): each agent session gets a `CursorKey` (explicit `cursor_id`, else the session id), all cursors share one render thread with independent position, config and visual state (`CursorRegistry`). Motion uses bezier glide and a path planner, with dwell after clicks and idle fade. A **session badge** (label up to 28 chars, delivery chip Foreground/Background, target chip Browser/Desktop/Pixel, session-tinted glow) hangs under each cursor. Themes are compiled artifacts. `capture_exclusion` keeps the overlay out of screenshots; `z_order` and `surface_fit` keep it aligned.
- **Windows overlay:** a transparent, click-through layered window that spans the virtual screen, never activates, and sits just above the target window in z-order (`platform-windows/src/overlay.rs`, 72 KB). The real OS pointer is never used.
- **Input delivery (Windows):** tiered. UI Automation patterns first (`Invoke`, `Toggle`, `Value`, `RangeValue`, `ExpandCollapse`), then a UIA hit-test at the pixel, then `PostMessage`. Returns an explicit `background_unavailable` instead of silently stealing focus; `delivery_mode:"foreground"` is an opt-in visible takeover.
- **Chrome/Edge without an extension, in the background:** the driver binds an exact process id and window id to a loopback DevTools endpoint and drives the page over the Chrome DevTools Protocol. Docs state: on Windows Chrome/Edge, "full background delivery validated for trusted CDP pointer input"; it can address an exact inactive tab without foregrounding the browser. This replaces my earlier claim that Chrome needs `SendInput` there; `SendInput` is only their fallback for coordinate clicks without CDP.
- **Permissions:** isolated driver-owned profile by default (deleted when the session ends); the user's normal signed-in profile only through an explicit host grant; `bounded` mode with a reviewed manifest (tools, apps, origins, files); an agent cannot promote its own permission mode; refs are session-scoped and invalidated by navigation.
- **Multi-agent (CuaBot):** each agent runs in its own Docker container with its own X11 display and a distinct coloured cursor; the human keeps a cursor too and can click into any agent's window. Conflicts are avoided by isolation, not by locks. Their own skill doc still says to keep one controller per shared desktop, because sessions do not isolate global focus or single-instance apps. **M9R's one-writer-per-tab scheduler solves that shared-surface problem, which they leave open.**
- **Cua Spaces:** a Space is a sandbox running `cua-spacesd` (port 3211); a Tauri 2 app (macOS, Windows, Linux) streams Spaces (WebCodecs video, Opus audio), lets a human drag a local window onto a Space (consent ladder, SHA-256 verified), and exposes menu-bar and notch panels. Spaces is **FSL-1.1-MIT** (no competing hosted service; MIT after two years).
- **Also:** Cua Bench (OSWorld-style evals), S1 forms models, an encrypted metadata-only action history, recording tools, an SDK in Python/TypeScript/Swift/Kotlin over a stable C ABI.
- **Licences:** driver and SDK MIT; Spaces FSL; `cua-som`/`cua-perception` AGPL. Avoid Spaces and AGPL code.

## 2. Coucou

- Code MIT; name, Mochi character, icon and 28 sounds are all rights reserved to the author. We make our own brand, character and audio.
- Windows/Linux app is Tauri 2: Rust backend about 113 KB (`pipe.rs` named-pipe server, `hooks.rs` hook installer/relay, `island.rs` window placement, `integrations.rs`, `claude.rs` chat, `secrets.rs` keyring), TypeScript front end (`island/` state machine, `views/`, `mochi/` Canvas 2D character, `settings/`), a small `coucou-hook.exe` relay.
- The island is a borderless, transparent, always-on-top, never-focused window, centred at the top of the target monitor. Full panel 720×320 logical px, a 240×6 "wake strip" for the peek animation; click-through is toggled per frame from a ~60 Hz cursor poll with a 14 px hit margin.
- Features worth matching: live per-agent status, Allow/Deny approvals from the pill, chat, file drop, idle-hide, sound cues, credentials in the OS keyring.
- Their Windows installer is withheld because Defender flags it unsigned: **we must code-sign.**

## 3. Where M9R already stands

- Per-agent named cursors and target halos exist in the extension (page-level, Item 3). They are visible only inside the page.
- Native clicks use `SendInput` and need Chrome in front ([win32.rs:377](../native-input-host/src/win32.rs)). That is the part that takes the user's mouse.
- An overlay program (`m9r-overlay.exe`), an in-page pill and a dashboard panel all exist: the "three pills".
- The extension has no `debugger` permission; the user's normal logged-in Chrome is the product's core promise.

## 4. Proposed build (each step stops for sign-off)

| Step | Work | Gate |
|---|---|---|
| Q0 prototype | Two routes on the local fixture: (a) `chrome.debugger` attach inside the user's normal Chrome; (b) Cua-style driver-owned isolated profile with a loopback DevTools endpoint. Dispatch click/type/scroll via CDP. Measure `isTrusted`, OS cursor unmoved, focus unchanged, background-tab addressing, latency vs native host, banner/consent behaviour | Evidence on fixture, a React app, an iframe/shadow page. Note: recent Chrome versions refuse a debugging port on the default profile, which is why (a) uses the extension API and (b) uses an isolated profile |
| Q1 quiet mode | CDP delivery as the default for shared tabs; native `SendInput` becomes opt-in with save/bring-forward/restore of the previous window and a re-activation guard; `background_unavailable`-style explicit refusals; keep the one-writer scheduler | No OS cursor movement on the default path; broker suite green; zero duplicate actions |
| Q2 screen-wide agent cursors | A click-through, non-activating layered overlay (extend `m9r-overlay.exe`, own implementation) rendering one cursor per agent with a badge (name, delivery chip, target chip), glide, idle fade, excluded from screenshots, own theme/art | Two agents visibly acting on two tabs; user's real cursor untouched; same-pixel check across sites |
| Q3 agent Spaces-lite | Optional per-agent managed Chrome window/profile (isolated by default, existing profile only on explicit grant, bounded-manifest option) with a live thumbnail in the pill. No VMs, no hosted service | One agent works in its own window while the owner uses theirs |
| P1 pill inventory | List the three existing pills, what each does, what state each owns, how they talk to the broker | Written inventory, then a one-pill design for approval |
| P2 one pill | Single always-on-top, never-focused, click-through-aware pill at the top edge: per-agent rows and states, Allow/Deny approvals, chat, idle-peek, sounds; Tauri vs extending the current overlay decided from the inventory; own brand, character, icons, audio; code-signed | Replaces the other two |
| P3 native-app driver | Windows UI Automation actuator for non-browser apps | Only if the owner reopens desktop-app scope (current scope: web + terminal) |

## 5. Licensing handling

- Where we write our own implementation from described behaviour, no obligation arises.
- Where we copy MIT code (Cua Driver, Coucou code), the MIT notice must travel with shipped binaries: one `THIRD_PARTY_NOTICES` file in the installer, not shown in the UI or marketing and not saying "built on". Skipping it would breach the licence.
- Never copy: Cua Spaces (FSL), anything AGPL, Coucou art/sounds/name.

## 6. Open decisions

1. Approve Q0 as the first step.
2. Whether the `debugger` permission ships in the Web Store build or direct install only.
3. Pill inventory in parallel with Q0, or after.

## 7. Q0 results (2026-10-02, route b: driver-owned isolated profile, Chrome 154)

Scratch harness only (outside the repo, nothing installed, no existing code changed). Chrome launched with a temporary profile and a DevTools port; a test page and the capability fixture were driven with `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText` and `Emulation.setFocusEmulationEnabled`; the OS cursor position and foreground window were sampled before and after each scenario.

| Scenario (default Chrome flags, i.e. like the user's normal Chrome) | Result |
|---|---|
| Chrome in front | click, type, scroll all work; every event `isTrusted`; OS cursor unmoved; foreground unchanged |
| Chrome fully covered by another app | page reports `hidden`; click and typing still land, **scroll does not** (no frames); with `setFocusEmulationEnabled` the page reports visible and everything works |
| Tab in the background of the same window | click and typing land, **wheel scroll does not** even with focus emulation; DOM scroll is the fallback |
| Same, with Cua-style launch flags (occlusion detection off) | covered-window case works with no emulation; background-tab wheel limit remains |
| Capability fixture (covered + focus emulation) | async button, iframe button, shadow-DOM button, double click, right click, hover menu, contenteditable typing, canvas click, wheel scroll triggering lazy load: **all pass**; foreground and cursor unchanged |
| Native HTML5 drag-and-drop | **fails** with plain mouse events; CDP's drag-intercept route did not fire in one attempt; unsolved |

Latency per dispatched mouse event was 2 to 3 ms, `insertText` about 16 ms.

Not yet tested: route (a) `chrome.debugger` inside the user's normal Chrome (infobar, permission prompt, conflict with open DevTools), a React-controlled input page, and a debugging port on the default profile (recent Chrome blocks it, which is why route (a) uses the extension API). Gate for Q1: route (a) attach test in a throwaway profile with the extension loaded, plus the drag-and-drop fix or an explicit fallback.

## 8. Q0 results, route (a): MV3 extension using `chrome.debugger` (2026-10-02)

Scratch extension (outside the repo) loaded into a throwaway Chrome 154 profile through DevTools `Extensions.loadUnpacked` (`--load-extension` is ignored by branded Chrome 154). The service worker attached to the fixture tab and drove it with the same CDP input calls.

| Check | Result |
|---|---|
| Click + type with Chrome in front | works; every click `isTrusted`; OS cursor unmoved; foreground unchanged; attach 10 to 36 ms |
| Same with Chrome fully covered by another app, using `setFocusEmulationEnabled` | works; cursor and foreground unchanged |
| Browser banner | "<extension> started debugging this browser" is shown while attached and disappears about 1.5 to 3 s after detach (read through UI Automation) |

Design consequence: attach on demand, detach after a short idle period, so the banner only appears around agent actions. Still untested: a React-controlled input page, DevTools already open on the tab, another extension holding the debugger, drag-and-drop (unsolved), background-tab scroll (use programmatic scroll). Q1 gate is unchanged except that route (a) now has evidence.

## 9. Pill inventory (2026-10-02, read-only)

| # | Pill | Code | Data in | Shell |
|---|---|---|---|---|
| 1 | Desktop pill | `overlay/` (Tauri 2, TypeScript + CSS, Rust `src-tauri/src/main.rs`) | view-only merge of `~/.m9r/feed.json` and `web-activity.json`, read by Rust; approve/deny, link picker, do-not-disturb, tray; keeps the engine's `feed --watch` alive | always-on-top, transparent, never focused; 220×36 collapsed, 360 wide panel, top-centre |
| 2 | In-page agent pill | `extensions/browser/pill.html`, `src/pill.js`, `src/pill-bridge.js`, `frame.css`, `dock-logic.js` | broker `ui-state` (agents, thread, approvals) through the extension service worker | iframe injected into granted pages; docks to any edge, notch style; nonce-gated trust |
| 3 | In-page message bar | `composer.html`, `src/composer.js`, `mention-logic.js` | same bridge; sends owner messages with @mentions | iframe in the page |

Related, not pills: `presence-overlay.js` (66 KB, in-page agent cursors and halos), the dashboard conversation panel.

Findings: the desktop pill is already the same stack as Coucou's Windows app (Tauri 2 plus a TypeScript front end), and both browser pills are plain HTML/CSS/JS. The two data planes differ (feed files vs broker `ui-state`), and the shells differ (OS window vs page iframe), but the UI itself is web code in all three.

Proposed architecture for one pill (needs approval): a single shared UI package with a small transport interface (subscribe to one state shape, send owner commands) and two adapters, a Tauri adapter and an extension adapter. The extension shell hides itself when the desktop pill is running so the owner never sees two; extension-only users (no desktop app) keep the in-page shell, which matches the "no new app" goal. The state shape becomes the broker's `ui-state`, with a converter from today's feed for the transition. Coucou-class motion, idle-peek, approvals, chat and sounds are built once in the shared package, with our own brand, character and audio.

## 10. Competitive read (2026-10-02, from public pages only; products not tried)

| | What the pages say | Browser control / cursors | Cross-provider | Cross-user |
|---|---|---|---|---|
| Nebula (nebula.gg, assumed to be the one meant; other "Nebula AI" products exist) | "Your team. Your agents. One workspace." Channels (text, voice, video), an orchestrator, agents, background tasks; macOS, Windows, Linux, iOS, Android | not stated | Claude/Codex named only as examples of bringing your own | yes: team channels |
| Plasma AI (plasma.ai) | Infrastructure: Radio (agent-to-agent comms), Wiki (indexed knowledge for agents), Fractal ("coming soon") with budgets and explicit permissions | not mentioned | not specified | team-level, unspecified |
| Cua | Computer-control layer (driver, Spaces, CuaBot) | yes, per-agent cursors and background input | any MCP agent | not documented |
| M9R | One shared, logged-in browser; one-writer scheduler; cross-provider agents; rooms; approvals | yes, and now proven quiet via DevTools input (Q0) | Claude, Codex, OpenCode today | rooms built; network core planned |

Where we are ahead: live action on the user's real signed-in browser with turn-taking across providers, quiet input measured at about 80 ms through M9R's own path, and the planned cross-vendor personal-agent network. Where they are ahead: workspace polish and distribution (native apps on every platform, voice and video channels), cost and budget visibility, knowledge bases. Gaps to close: onboarding, a knowledge layer (shared memory), cost visibility, voice/video if wanted.

## 11. Coucou Windows pill: port notes (source read 2026-10-02, commit 7df46f2, MIT code; LICENSE-ASSETS reserves name, Mochi, icons, sounds, media)

Same stack as our `overlay/`: Tauri 2 + Vite + vanilla TypeScript. Files that carry the "macOS-level" feel:
- `src/core/anim.ts`: easing set, a damped-spring integrator equivalent to SwiftUI `.spring(response, dampingFraction)` stepped at up to 240 Hz so dropped frames never destabilise it, and a 340 ms close curve cubic-bezier(.45, 0, .2, 1).
- `src/island/fsm.ts`: island state machine (hidden, peek, home, greeting) with timed collapses (home to peek 15 s, peek to hidden 60 s), hover handling, and a pinned state while an alert waits for an answer.
- `src/island/island.ts` (33 KB), `src/core/layout.ts`, `src/core/state.ts`, `src/style.css` (26 KB): the view, spring-driven sizing, and styling.
- `src/core/sound.ts` plus views for chat, ticker, integrations, upload.
- `src-tauri/src/island.rs`, `platform/windows.rs`: borderless, transparent, always-on-top, never-focused window at top-centre, per-frame click-through, DPI and multi-monitor placement.
Replace: Mochi character (`src/mochi/*`), sounds, icons, name, hook relay (`hooks.rs`, `pipe.rs`, `hook/`) with our feed/broker adapter. Port the motion, state machine and window code; the MIT notice for copied files goes in the installer's third-party notices file.

## 12. Live agent windows: spectate and join (owner idea, 2026-10-02)

The owner's idea: like Cua Spaces, each agent's working window appears as a live tile in the room; anyone with access can click the tile to spectate, and click again to join (take part or take over). Not still screenshots.

Feasibility sketch (untested): Chrome can stream a tab continuously through DevTools screencast (compressed frames, effectively live video at roughly 10 to 30 fps) or through tab capture sent as video; the same DevTools channel accepts mouse and keyboard input, so a viewer's clicks on the tile can be turned into real input in the agent's tab. "Join" then means the one-writer scheduler hands the tab's turn to the human, the agent pauses or works elsewhere, and both appear as named cursors. This needs no virtual machines. Open questions: stream path (relay versus peer-to-peer), latency target, per-site privacy (blur or block sensitive pages), who may spectate versus who may take control, how a teammate's input is authorised, bandwidth cost on Cloudflare, and how it interacts with approvals.
