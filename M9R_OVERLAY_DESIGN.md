# M9R overlay: design (2026-09-20)

Status: **design approved 2026-09-20 (owner: top-centre pill; "Start with Windows" off by default; silent pings; overlay-key approvals with the stated limit; separate download; Claude dot shows only "seen at HH:MM" until the O3 spike). O1 built and proven; O2 to O6 not started.** Builds on `M9R_NATIVE_FRONT_DOOR_DESIGN.md` section 10 and `M9R_NEXT_BUILD_PLAN.md` section 3. Everything marked *proven* was tested on this machine (Windows 11); everything marked *unproven* is a guess that a build slice must test first.

## 1. What it is, in one paragraph
A small always-on-top window (a pill at the top centre of the screen on Windows first; a notch-style look on Mac later) that shows which agents are open and what they are doing, pings when something needs you (a task waiting for approval, an answer that came back, a push that failed), and expands to a list on click. It is built with Tauri (Rust shell, TypeScript UI). It **displays and asks; it never delivers a task, never types into another app, and the system works exactly the same with it closed.**

## 2. Principles
1. **Zero tokens, zero cost.** Nothing here calls a model or a paid service.
2. **The overlay is a view.** All logic (routing, approvals, liveness, delivery) stays in the tested Node code. The overlay reads a feed and sends a few explicit commands back. If the overlay crashes, nothing changes.
3. **Local first.** No account, no network. The web and team features attach later through the same feed (section 9).
4. **Honest states.** It shows "open", "working", "idle", "offline" only from evidence, and shows "unknown" when it cannot tell. It never shows a green dot it cannot justify.
5. **Never steals focus, never covers work.** Clicking it must not pull focus from the terminal you were typing in; it hides over fullscreen apps and can be paused.

## 3. What you see

### 3.1 Collapsed pill (default)
A rounded pill, about 220 by 36 px, top centre. Left to right: the M9R mark, one small dot per known agent (colour = state, section 4), and a badge with the number of things that need you. With nothing needing you it is quiet and low contrast; it never animates on its own.

### 3.2 A ping
When something needs you, the pill grows for about 6 seconds to one line: `@claude asks @codex: Review lease.ts   [Approve] [Deny]`, or `@codex answered T3`, or `T5 could not be pushed: 2 Codex sessions open`. It then shrinks back and the badge stays until handled. Pings never make a sound by default. Do-not-disturb (tray menu) silences pings but keeps the badge.

### 3.3 Expanded panel (click the pill)
Three sections, newest first, about 340 px wide:
- **Needs you**: pending approvals (`Approve` / `Deny`), failed pushes (with the reason and the command that fixes it), answers not yet seen.
- **Agents**: one row each: name, state, working directory, and a one-line "doing" (`editing relay/lease.ts` when known, else the state).
- **Recent**: the last 10 task events (`T3 @claude -> @codex  pushed`, `answered`).
Clicking a task row shows its full goal (already redacted) and its delivery timeline. There is no text box in v1.

### 3.4 Tray icon
Menu: Show/hide, Do not disturb, Pause updates, Start with Windows (off by default), Open memory folder (`m9r-cli memory`), Quit.

## 4. Agent states and the evidence for each
| State | Meaning | Codex (evidence) | Claude Code (evidence) |
|---|---|---|---|
| **open, working** | a session is open and mid-turn | rollout file held open (**proven**) and the file changed in the last 20 s or its last event is not `task_complete` (*unproven detail*) | *unproven*: session transcript changed in the last 20 s, or a hook event in the last 20 s |
| **open, idle** | a session is open, waiting for you | rollout held open and last event is `task_complete` (*unproven detail*) | *unproven*: hook seen recently, transcript quiet |
| **offline** | no open session known | rollout files exist but none held open (**proven**) | no session seen recently |
| **unknown** | cannot tell (non-Windows, check failed) | liveness returned `unknown` | same |
Codex "open" is proven on a real interactive session and on Codex Desktop. **Claude Code liveness is not proven**: whether Claude Code keeps its transcript open is a spike for slice O3, before any Claude dot is shown as more than "seen at HH:MM".
OpenCode has no adapter yet: it shows as "not connected".

## 5. Architecture
```
hooks / CLI / delivery  ->  ~/.m9r/state.json  (already exists)
                                  |
                      feed writer (Node, `m9r-cli feed --watch`)
                        - reads state.json when it changes
                        - every 8 s: liveness + activity probes (Windows Restart Manager ~1.2 s, off the UI path)
                        - derives the view model, writes ~/.m9r/feed.json atomically, only when it changed
                                  |
                          overlay (Tauri)  -- watches feed.json, renders, sends commands back
```
- **Why a feed file, not the overlay reading `state.json`:** the derivation (states, wording, redaction, "needs you") lives in one tested place in TypeScript; the overlay stays a thin renderer, so a Mac or web view can reuse the same feed later. It also keeps the expensive probes out of the UI process.
- **Who starts the feed writer:** the overlay starts it as a child process when it launches (`node <installed>/m9r-feed.js`) and restarts it if it dies. It can also run alone (`m9r-cli feed --watch`), which is how it is tested without any window. Node is already required for the CLI.
- **Cost:** reading a small JSON file on change, and one probe pass every 8 seconds; well under 1% CPU. The 8 s cadence is a guess to be measured in O3.

### 5.1 Feed schema v1 (`~/.m9r/feed.json`)
```json
{
  "version": 1,
  "seq": 412,
  "generatedAt": "2026-09-20T17:00:00Z",
  "agents": [
    { "handle": "codex", "state": "open_working", "since": "...", "doing": "editing relay/lease.ts",
      "sessions": [{ "id": "01a0...", "cwd": "C:/proj", "live": true }], "evidence": "rollout held open, changed 4 s ago" }
  ],
  "needsYou": [
    { "kind": "approval", "taskId": "T4", "from": "claude", "to": "codex", "goal": "Review lease.ts", "protected": false },
    { "kind": "push_failed", "taskId": "T5", "reason": "2 Codex sessions are open...", "fix": "m9r-cli send @codex --session <id> ..." },
    { "kind": "answer", "taskId": "T3", "from": "codex", "summary": "Reviewed: one race in renew()." }
  ],
  "recent": [{ "at": "...", "taskId": "T3", "text": "@claude -> @codex pushed" }],
  "pings": [{ "id": 412, "kind": "approval", "taskId": "T4", "text": "@claude asks @codex: Review lease.ts" }],
  "reserved": { "people": [], "channels": [] }
}
```
- `seq` increases on every change; `pings` carries only items new since the previous `seq`, so the overlay never re-pings after a restart (it stores the last `seq` it showed).
- Every string is already passed through `redactSecrets` and length-capped (goal 300 chars, summary 400) before it is written. The overlay renders text as plain text, never as HTML.
- `reserved` is where teammates and channels go later (section 9); v1 leaves them empty.

## 6. Actions (what the overlay may send back)
The overlay sends exactly these, through the CLI, never by editing state itself:
`approve <taskId>`, `deny <taskId>`, `dismiss <answer taskId>` (marks it seen), `pause`/`resume pings`.

### 6.1 The approval problem, stated honestly
Today `m9r-cli approve` needs a real terminal with no agent markers, which is what stops an agent from approving its own task. A click in a window is not a terminal, so the overlay needs another way that an agent cannot use by accident. Design:
- On first run the overlay creates a random secret in `~/.m9r/overlay.key` (readable only by the user) and registers it with the store.
- `m9r-cli decide <task> approved|denied --overlay-key <key>` is accepted without a terminal **only** with that key; the key is never printed, never put in an environment variable, never sent anywhere.
- **What this does and does not protect against:** it stops the realistic threat, a prompt-injected agent that runs `m9r-cli approve` in its shell, because that path still refuses. It does **not** stop malware or an agent that deliberately reads `~/.m9r/overlay.key`, since everything runs as the same Windows user and can read the same files. This is the same limit the terminal check already has, and it should be documented that way, not oversold.
- **Stronger later (not v1):** require a Windows Hello or OS confirmation for protected actions.

## 7. Window behaviour (Tauri v2)
- **Config:** transparent, undecorated, always on top, skip taskbar, not focusable on click (so it does not steal focus; needs Windows-specific handling, per other Tauri overlays).
- **Click-through:** Tauri has no per-region hit testing. Collapsed, only the pill's rectangle is clickable; the rest of the transparent window ignores the mouse. Implemented by shrinking the window to the pill/panel size and moving it, not by a full-screen transparent window and a cursor-polling loop; that avoids the 60 fps polling other projects use. (*Unproven*, first thing to test in O2.)
- **Position:** top centre of the primary monitor, below the taskbar-safe area; remembers a dragged position per monitor; re-centres if the monitor set changes.
- **Fullscreen:** hides when a fullscreen app or game is foreground (checked with the Windows shell "quiet time" state), so it never covers a presentation or a game.
- **DPI and multi-monitor:** sizes in logical pixels, follows the primary monitor's scale.
- **Hotkey:** Ctrl+Alt+M shows/hides (configurable later).

## 8. Startup and packaging
- **Development:** `npm run overlay:dev` (Tauri dev with a mock feed, so the UI can also be checked in a normal browser).
- **User:** starts when the user chooses "Start with Windows" (off by default; a per-user Run registry entry, removed on uninstall). Closing the window hides it to the tray; only Quit ends it.
- **Distribution:** a separate download (a single small installer, roughly 10 MB), not inside the npm package. It is **unsigned** for now, so other people would see a SmartScreen warning; the code-signing certificate is the one paid item and waits.
- **License:** Apache-2.0 like the local layer. Tauri is MIT/Apache. Reference code only from Apache-2.0 projects (OpenWispr, OpenCluely) with attribution in `THIRD_PARTY_NOTICES.md`; nothing copied from the GPL-3.0 projects (Cheating Daddy, Pluely, Cue).

## 9. Later: teams, messaging, shared agents (fantasy, kept in view)
The feed's `reserved.people` and `reserved.channels` are where these plug in, fed by the web app's channels through the account connection. Rules that stay true:
- The overlay may show teammates and a small message box that sends **M9R messages only**. "Never types into another app" means never into a terminal or other window; that rule stays.
- **Public/private agents** (letting a teammate hand work to your agent) are a permissions feature, not an overlay feature; it also needs the provider-terms read first, because running someone else's work on your Claude or Codex subscription may not be allowed.

## 10. Edge cases (each needs a test)
| Case | Behaviour |
|---|---|
| Feed file missing, half-written or corrupt | Overlay keeps the last good feed and shows a small "stale" mark after 20 s; the writer writes atomically (temp file then rename) so a half file is not expected. |
| Feed writer dies | Overlay restarts it; after 3 quick failures shows "M9R engine stopped" and stops retrying. |
| `state.json` corrupt | The store already sets it aside and starts clean; the feed shows an empty state, not an error loop. |
| Liveness returns `unknown` (non-Windows, PowerShell blocked) | States show `unknown`, never `offline`. |
| Same approval clicked in the overlay and typed in a terminal | The store is authoritative: the second one gets "already answered" and the overlay refreshes. |
| Approval for a task that has lapsed (over 24 h) | Buttons disabled; shows "lapsed". |
| Overlay opened while pings are queued | Shows the badge and list; only pings newer than its stored `seq` animate. |
| Many pings at once | At most one ping animation per 6 s; the rest go straight to the badge. |
| Two monitors, one unplugged | Re-centres on the primary. |
| Fullscreen app in front | Hidden until it leaves fullscreen; badge state is kept. |
| Do-not-disturb on | No ping animation; badge still updates. |
| Overlay killed | No effect on delivery, approvals, or hooks. |
| Secret file missing | Approvals from the overlay are disabled with "use m9r-cli approve"; nothing else breaks. |

## 11. Build slices (each with a PASS criterion)
- **O1. Feed writer and schema.** `m9r-cli feed [--watch]`, the view-model derivation, redaction, atomic writes, `seq`/pings, tests with fixtures. PASS: with a real task created through the hook, the feed shows it within 2 s; a corrupt state file does not crash it; no secret text ever reaches the feed.
- **O2. Tauri pill with a mock feed.** Window flags, no focus stealing, click-through, position memory, tray, do-not-disturb. PASS: on this machine the pill stays on top, clicking it does not take focus from a terminal, the transparent area passes clicks through, and it uses under 30 MB.
- **O3. Live presence.** Liveness and activity probes for Codex, and the Claude Code spike. PASS: open a real Codex session and kill it; the dot follows within about 10 s; Claude shows only states that have evidence.
- **O4. Pings, panel, task detail.** PASS: a real `@codex` task shows a ping, then the row moves through pushed and answered.
- **O5. Approvals.** Overlay key, `decide` command, buttons. PASS: an agent-initiated task shows Approve; clicking it pushes the task; an agent running `m9r-cli approve` is still refused; the double-answer case works.
- **O6. Startup and polish.** Start-with-Windows, fullscreen hiding, hotkey, packaging notes, an acceptance script. PASS: a fresh reboot with "Start with Windows" on shows the pill; the acceptance script drives a real task end to end with the overlay running and with it closed (delivery identical).

Order: O1 first (testable without any window), then O2, O3, O4, O5, O6.

**O1 status (2026-09-20): built, `npm run o1:acceptance` passes 9 of 9 with real processes.** `m9r-cli feed [--watch]` writes `~/.m9r/feed.json` atomically and only when the content changed; `m9r-cli dismiss <task>` clears items from the overlay list. Measured: the file appears about 1.2 s after start; a new task reaches the feed about half a second after it is created; a hard-killed writer catches up on restart with `seq` continuing and no duplicate ping; a corrupt `state.json` does not stop it; idle CPU about 1.3%; a secret in a goal never reaches the file. Unit tests: `scripts/native-feed.test.ts` (8). Not yet measured: the cost of the Codex liveness probe every 8 s with several sessions open (O3).

## 12. Decisions needed from the owner
1. **Position:** top centre pill (proposed) or a corner?
2. **Startup:** "Start with Windows" off by default (proposed), or on after first run?
3. **Sound:** silent pings by default (proposed)?
4. **Approve from the overlay:** OK with the overlay key design in 6.1 and its stated limit?
5. **Distribution:** separate download for now, packaged installer later?
6. **Claude Code dot:** fine to show only "seen HH:MM" until the O3 spike proves a real signal?
