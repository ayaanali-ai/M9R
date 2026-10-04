# Cua catch-up: tasks for Codex

2026-10-03. Read `m9r-cua-and-ship-plan.md` (what Cua ships and why) and `m9r-cua-work-split.md` (who owns which files) first. One task at a time. Report after each with what actually ran. No claims from simulated tests. No merges to `main` without the owner. Work from `main` (it now contains the pill, rooms and dashboard work and deploys to Cloudflare on every push).

## Licence rule for anything taken from Cua
- **MIT parts** (Cua Driver, SDK, CLI, Bench, Lume, CUA-S1 code): may be used or ported directly, keeping their copyright notice.
- **FSL-1.1-MIT parts** (Spaces, `cua-spacesd`, Keyvault, Volume): source-available, and the licence forbids using it to build a competing hosted product. Do **not** copy their code. Write our own from their *public behaviour* (docs, release notes, what the app does on screen). Best practice is a spec first (what it does, inputs, outputs, failure cases), then implement from the spec without the Cua source open.
- **AGPL parts** (OmniParser integration, `cua-som`): do not use or copy. Using them would force us to publish our source.
- Not legal advice. If a task needs their code to proceed, stop and ask the owner.

## Cua scheduled jobs
I found no scheduled or recurring agent runs in Cua's releases or docs. That is a gap we can own (task C9).

## Tasks, in order

### Wave 1: what the demo and the cross-user story need
**C1. Agent-owned Chrome profile (no banner).** Dedicated Chrome profile with a debugging port that M9R launches and owns. The owner signs in once and approves sites. Broker routes quiet actions there. *Why:* Cua's browser route has no banner; ours has one today. Done when: a click and a typed string land with no "debugging" banner and the owner's normal Chrome is untouched. (Task T372 already covers this.)

**C2. Quiet typing and drag** through that channel, inside the existing one-writer-per-tab scheduler. *Why:* agents fill forms and drag items silently on real sites. Done when: typing into a real input and dragging an element work on a real site, with a test and a short live run.

**C3. Live view relay.** Screencast frames from a tab sent over the relay to room members, read-only, rate limited, room disclosure rules applied. *Why:* the "watch it from another machine" half of the cross-user demo; Cua streams a whole desktop, we stream one tab. Done when: a second machine renders the first one's tab live.

**C4. Take-over / hand-back API in the broker.** The lease and handoff primitives for a *local* session (the room page already has them against Supabase). Claude builds the pill and room UI on top. Done when: a person can take the wheel from an agent and give it back, the scheduler honours it, and an agent's queued actions pause cleanly.

**C5. Windows re-test of Cua Driver (MIT), report only.** Newest release. Which of click, type, scroll, drag, screenshot work in the background on Chromium, Electron and a native app (Notepad, Calculator). Their README says Windows is "Full"; our earlier test proved only a background left click. The owner decides what to integrate after reading the report.

### Wave 2: match Cua's product surface
**C6. M9R Space: a named agent workspace.** One Space = an agent-owned browser profile (C1) + the sites the owner approved + the agents allowed in it + its room. This is our answer to Cua Spaces and "teleport", without moving the owner's logged-in apps anywhere. Needs an approved-sites list, a visible manifest per agent (Claude builds the screen), and a consent screen when adding a site.

**C7. Machine enrolment.** Cua Spaces v0.6 lists "your machines" before a Mac is enrolled. Ours: a registry of the owner's computers (name, last seen, what agents run there) so a room member can pick which machine an agent runs on. Builds on the network-core work already in progress.

**C8. Action history and the flight recorder.** Cua has a read-only action history. Ours should be append-only per room, signed, and replayable: actions, cursor positions, page states and approvals with timestamps, exportable and linkable. Gives: audit, replay URLs, and later "turn a run into a reusable skill". Start with the recorder and an export; the replay viewer is Claude's.

**C9. Scheduled agent runs ("standing orders").** Recurring and one-time agent tasks with a budget and an owner approval policy, running on Cloudflare cron triggers / Workflows, plus moving the four old Vercel cron sweeps (`/api/internal/work-signal-sweep`, `stale-run-sweep`, `workflow-scheduler`, `idle-session-sweep`, all gated on `CRON_SECRET`) onto Cloudflare. Cua has no equivalent that I could find. Done when: a schedule fires on Cloudflare, runs a task, and records the result; the four sweeps run again.

**C10. Always-on hosted browser.** Cua offers cloud desktops. Ours: an agent browser that keeps running when the owner's laptop is off, on **Cloudflare Browser Run** (it appears in the account's Compute menu) using the startup credit. Needed for C9 to be useful. Start with a feasibility report: limits, cost per hour, how sign-in persists, what the owner must approve.

### Wave 3: depth
**C11. Approved logins ("secrets") the agent never sees.** Cua SDK 0.3 added per-app secret items with unattended locks and per-domain review, with Windows DPAPI storage. Ours must keep M9R's rule that agents never see passwords or cookies: a Windows-DPAPI-backed store, per-domain review, and the extension fills the field itself while the agent only asks "log in to X". Owner decision needed before building: is this in scope? Spec first.

**C12. Small fast decision models.** Cua's CUA-S1 uses small specialised models for bounded choices such as form filling. Ours: Jev (TypeSafe) for element choice, form-fill confidence and the Approval Twin. Wire Jev behind `M9R_JEV_*` switches, off by default, null result means old behaviour.

**C13. Multiplayer benchmark.** Cua Bench lets people build tasks and export trajectories. Ours: tasks that *require* two agents and a person to hand off, scored on completion, handoffs and time, using the `bench-*` harness and C8's recorder. Publishable with the demo.

**C14. Desktop apps, opt-in, only if C5 passes.** Cua Driver (MIT) as an optional "desktop apps" tool, off by default. Needs the owner to widen the saved scope ("web + terminal, no desktop-app driving").

**C15. Window pool for the stage.** Two or more agent windows tiled, cursors crossing, one lease handoff. Small first.

### Not doing
Mac VMs (Lume/Lumier), the Linux Hyprland cursor, Cua's own telemetry (we stay opt-in only), and anything AGPL.

## Claude's side (for reference)
Take-over/hand-back UI, cursor skins, agent manifest screen, admin controls, per-turn memory recall and cloud/local memory join, pill release, Two-Key Actions, Live Rooms UI, Space screens.
