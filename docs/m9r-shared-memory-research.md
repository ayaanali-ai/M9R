# Shared memory: what Mosaic and HeyBrain do, and what M9R should build

2026-10-03. Research from public pages only (no accounts, no installs). Proposal needs owner approval before any build.

## What the owner decided
- Agents keep their own memory and rules. M9R does not generate or store "rules" and does not auto-extract lessons from runs. That queue is removed from the Memory page.
- Shared memory is facts and decisions the team saved, plus the record of work done. A person or an agent can save in one step, from wherever they are, without opening Memory and filling a form.

## Mosaic (YC launch, shared memory for a team's agents)
- Syncs every AI session the team runs (Claude Code, Codex, Cursor) into one shared place any agent can read and write. Records what was tried, what changed and why, so a teammate or agent picks up where someone else stopped.
- Capture is automatic (session sync). Public pages say nothing about permissions, retention or deletion. About 2,000 installs, 37 orgs, 2 people (their own launch page).
- Lesson: capture should cost the user nothing, and the unit is "work done and why", not abstract rules.

## HeyBrain (Brain, governed company memory)
- Connects company sources and enforces each source's permissions on every read by people and agents. Every agent gets an identity, a limit and a record; access is logged in a tamper-evident ledger. MCP is the agent interface, but its own docs say MCP compatibility does not by itself give permission enforcement, revocation or audit.
- Current capability is governed read. Write-back to sources is listed as roadmap. Public pages do not describe how conflicts or stale facts are handled.
- Lesson: sharing needs per-agent scope, revocation and an access record. It is retrieval governance, not a capture product.

## Where M9R fits
Mosaic captures but is silent on governance. HeyBrain governs but does not capture. M9R already has the missing pieces: agent identities with owner-approved sharing, rooms and channels as scopes, and one MCP surface used by Claude, Codex and OpenCode. Position: "what your team and its agents decided, available to every agent in the room."

## What already exists in the repo
- `workspace_memory_notes` table, `/api/shared-memory` (people), `/api/agent/memory/notes` (agents), `m9r_note` MCP tool (append / list / export / clear), room-scoped notes injected into live-session prompts, a 10 MiB workspace pool.
- This branch: Memory page is notes only, one-box save, human saves are shared immediately, agent saves wait for a person to Keep.

## Proposed build, in order (each small)
1. **Save from anywhere.** "Save to memory" on any chat message; pill command `remember: ...`; the same in rooms. One click, no form.
2. **Agents save at the end of work.** Agents are told (already in the room prompt) to append one line per decision or verified finding via `m9r_note`; the chat shows "saved to memory" with an undo, instead of an approval queue.
3. **Recall at turn start.** Inject the few most relevant notes for the channel or room into each turn automatically, instead of relying on the agent to call `m9r_note list`. Notes are data, never instructions.
4. **Provenance and freshness.** Every note shows who or which agent saved it, when, and from which room. A newer note can supersede an older one; superseded notes are hidden, not deleted.
5. **Scopes and revocation.** Workspace, channel, room. An agent only reads scopes it was given. Removing an agent from a room removes its read access.

## Open decision for the owner
Should an agent's saved note be shared with other agents immediately (frictionless, but a wrong or injected note spreads), or wait for one person to tap Keep (current behaviour)? Recommendation: immediate within the room the agent is working in, flagged as agent-saved, with one-tap delete. Not decided; today it waits.

Sources: ycombinator.com/launches/T3K-mosaic-shared-memory-for-your-team-s-agents; heybrain.io and heybrain.io/blog/best-ai-brain-for-ai-agents; the Brain launch release on GlobeNewswire (2026-09-23).
