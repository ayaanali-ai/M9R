# Cua catch-up: work split between Claude and Codex

2026-10-03. Companion to `m9r-cua-and-ship-plan.md` (read it for the why). One item at a time, report after each, tests with each, no unrequested extras.

Base: branch `launch/m9r-pill-rooms-dashboard` (it contains Codex's dashboard branch, the one-pill work and the Memory-as-notes change). Start new work from it, not from `main`.

## Codex: native, broker, extension, live Windows tests
1. **Agent-owned Chrome profile (no banner).** Launch a dedicated Chrome profile with a debugging port, owned by M9R, that the person logs into once and approves per site. Broker routes quiet actions there. Done when: a click and a typed string land with no "debugging" banner, and the owner's normal Chrome is untouched.
2. **Quiet-mode typing and drag** over that channel, through the existing one-writer-per-tab scheduler. Done when: typing into a real input and dragging an element work on a real site, with a test and a short live run.
3. **Cua Driver re-test on Windows** with their newest release. Report which of click, type, scroll, drag, screenshot work in the background for Chromium, Electron and a native app (Notepad, Calculator). Report only; no integration until the owner reads the result.
4. **Live view relay.** Chrome screencast frames from a tab, sent over the relay to room members, read-only, rate limited, with the room's disclosure rules applied. Done when: a second machine or tab renders the first one's tab live.
5. Keep the network-core work already in progress; rebase it onto the base branch first.

## Claude: UI, rooms, memory, safety
1. **Take over / Hand back** in the pill and the room, over the existing leases and handoffs.
2. **Legible-agent cursor skins and states** (thinking, unsure, blocked, waiting on a teammate).
3. **Agent manifest** screen: sites and actions each agent may use, built on the origin grants.
4. **Memory join and per-turn recall**, plus the pill "save to memory" button.
5. **Admin controls**: who can approve, who can add agents, per-agent access, in one screen, on the roles that exist.
6. **Cross-user room test** with the second account, when the second machine is on.
7. Then **Two-Key Actions** and **Live Rooms with spectators** (UI over Codex's relay).

## Rules for both
- Files: Codex owns `scripts/m9r-*`, `src/lib/native/*`, `extensions/browser/src/*` (background, quiet-input, native input), `native-input-host/`, `services/`. Claude owns `pill/`, `src/components/`, `src/app/`, `overlay/`, `docs/`. If you need to touch the other side's files, message first.
- No merges to `main` without the owner's say-so. Commit to your own branch.
- Never claim live behaviour from a simulated test.
