# M9R native front doors: design pass (v0.1, 2026-09-20, for owner sign-off)

Status: **design only. Nothing here is built.** No code is written until the owner signs off the decisions in section 17. Evidence for every "proven" claim is in `M9R_NATIVE_SESSIONS_DESIGN.md` sections 13 and 14 (spike results on this machine: Codex 0.153.4, Claude Code 2.1.263, OpenCode 1.18.31). This document builds on the network spec (`M9R_NETWORK_SPEC.md`, locked sheet `M9R_NETWORK_SPEC_LOCK.md`) and does not replace it.

## 0. What this locks, and what it does not

**Goal (owner).** A user mentions `@codex`, `@opencode` or any connected agent from inside the Claude desktop app or a plain terminal, and it reaches that agent in its own app. No M9R workspace. No `m9r run` wrapper. No pasting. The agents share context and memory so they avoid duplicated work, collisions and accidental deletions, while spending as few tokens as possible.

**First release = one user, all of their own agents, on one machine (multi-machine second).** No team, no cross-user, no marketplace, no receipts economy. Everything below is scoped to that. Cross-user reuses the same model later.

**Not in scope:** the PTY wrapper and an M9R-hosted TUI (rejected as the core; may exist later as an optional power surface), OS keystroke injection into another app's window (last resort, off, never remote-triggered), channel-based delivery into Claude (proven not to work, section 5), the paid economy layers.

## 1. Principles (each one is a test the design must pass)

1. **Agents stay in their own apps.** Nothing in this design requires launching an agent through M9R.
2. **Pull, not push, for context.** Agents fetch what they need. Only tiny pointers are injected automatically.
3. **Tokens are a budget.** Every automatic injection has a hard cap (section 12). The default cost of being connected is a few hundred tokens per session, not per turn.
4. **Deterministic things run in code, not in the model.** Locks, collision checks, routing, logging, delivery state. They cost zero tokens and do not depend on the model remembering.
5. **The human is the authority.** A message the human typed is authorised. An agent-initiated delegation needs approval or a standing rule the human set (section 7).
6. **Honest labels.** Each endpoint states how it can really be reached (section 4). Never claim "live in your window" when it is "delivered on next prompt".
7. **Local first.** Same-machine delivery works with the internet off. The cloud is for the viewer, other machines and history.
8. **Cost stays at zero.** No new paid service. Cloudflare $5 plan plus credits, Supabase Pro as-is, the user's own provider subscriptions.

## 2. The model (vocabulary)

- **Machine / Node:** the M9R background service on one computer. It evolves from today's bridge. It exposes a local API (localhost, per-user token) to hooks, MCP tools and the CLI, keeps the local store, and talks to the Relay only when needed.
- **Endpoint:** a durable address for one running or resumable agent session, e.g. `@codex`, `@claude`, `@codex-auth`. It has a provider, a machine, an owner, a working directory, a current session, a **session generation** (bumps when the underlying session changes), and a fidelity label. Exists today as the `endpoints` table (Stage 1).
- **Session:** the actual provider session (a Codex thread id, a Claude session id). An endpoint points at one current session.
- **Task:** a small durable record: goal, pointers, who asked, approval state, result summary. The unit of delegation.
- **Message envelope:** what is actually sent to a target: 3 to 6 lines plus a task id. Never a payload dump.
- **Memory item:** a fact or decision stored as a markdown file with provenance (section 9).
- **Activity event:** one line "who touched what" produced automatically by hooks. Zero tokens.
- **Lock:** a short-lived claim on a path or resource by one endpoint. Enforced by the guard hook.

## 3. Identity and addressing without a workspace

**Today.** `endpoints` is keyed by `(workspace_id, owner_user_id, provider)`. That ties every address to a workspace and is the main gap between what we built and the goal.

**Design.**
- Add a **personal scope**: endpoints owned by a user need no workspace. `scope` is `personal` or `workspace` (existing rows stay `workspace`). Personal uniqueness is `(owner_user_id, alias)`; `workspace_id` becomes nullable for `scope = personal`. Migration is additive; the existing `bind_endpoint_for_connection` trigger keeps working for workspace-scoped rows.
- **Registration without a workspace.** The Node registers each agent it discovers under the signed-in user. The one-time connect stays (Node install and `m9r init`), but it creates personal endpoints, not a workspace membership.
- **Resolution of `@name`:** exact alias match under the caller's owner first. `@codex` means "my Codex".
- **Multiple sessions of one provider** (Stage 1 collapsed these to one): an endpoint is `provider + working directory + session`. `@codex` resolves to the **most recently active session whose working directory is the same repo as the caller**. If none match, the most recent Codex overall. If two are equally plausible it does not guess: it returns an ambiguity error listing `@codex`, `@codex-auth`, `@codex-2` and asks the caller to pick. Users can name a session (`m9r name codex-auth`).
- **Owner handles** (`@ayaan/codex`) are reserved for cross-user, later. In the first release they resolve to the same personal endpoint if the owner is the caller and are otherwise refused.
- **Path clash with file mentions.** Claude Code and Codex already use `@path` for files. A token is an endpoint mention only if it exactly matches a registered alias **and** does not resolve to an existing file or folder relative to the working directory. Otherwise it is ignored. Aliases that collide with a real top-level file name are flagged at registration.

## 4. Fidelity labels and how each target is really reached

Existing labels stay: `LIVE_NATIVE`, `RESUMABLE_NATIVE`, `CONSULTATION`. Two proposed additions (needs sign-off, section 17): `QUEUED_NATIVE` (the provider's own queue holds it and runs it when the session is idle or resumed) and `NEXT_PROMPT` (delivered by hook at the user's next prompt).

| Target | Receive mechanism | Label | Proven? |
|---|---|---|---|
| Codex terminal (`codex resume` or a live TUI) | `codex queue --thread <id> --message ...`; consumed immediately | `LIVE_NATIVE` | Yes (2026-09-19) |
| Codex Desktop app | same command; lands in the thread's own queue UI; runs at once if the thread is unpaused, on **Resume** if the user had interrupted it | `QUEUED_NATIVE` | Partly: lands and runs after Resume. Unpaused-idle case not separately tested |
| Claude Code terminal or Desktop (plain, unmodified launch) | hook inbox at the next prompt, authorised by a standing instruction the user installed (section 8) | `NEXT_PROMPT` | Yes (headless) |
| Claude, instant handling wanted | M9R starts a resumable turn: `claude --resume <session-id> -p "<task>"` (a genuine user-role prompt, appended to the same session) | `RESUMABLE_NATIVE` | **No.** Not tested against an open interactive session; may fork or conflict |
| OpenCode | server attach (`opencode serve` / attach) | to be decided | **No.** Spike not run |
| Any provider with no door | sibling session of the same provider in the same repo, sharing memory | `CONSULTATION` | Yes for Codex (our adapter) |

Why not Claude channels: a channel push reliably wakes an idle plain session, but Claude refused all three framings tried (agent-claimed, "you typed this", "forwarded by M9R") because it treats pushed text as untrusted. Channels also require a launch flag. They may still be useful later as a permission-relay path (approvals to a phone), not as a delivery path.

## 5. Send side (how `@codex` leaves the caller)

Two paths, both local:

1. **Human-typed mention (deterministic).** A `UserPromptSubmit` hook (Claude and Codex both support it, in terminal and Desktop) inspects the raw prompt. On an endpoint mention (rules in section 3) it calls the Node, which creates a task and delivers it. The hook then injects one line so the model does not do the work itself: "M9R sent this to @codex as task T12. Continue with anything else; the result will arrive in your inbox." The original prompt is left intact so the caller keeps its own context. Measured hook latency on this machine: about 20 ms.
2. **Agent-initiated (model-mediated).** The agent calls an M9R tool: `m9r_ask(@target, goal, pointers)`. Available through the MCP server (works in Claude Desktop and any MCP client) and the `m9r ask` CLI (already exists). This path is **not authorised by itself** (section 7).

## 6. Task record, envelope and delivery states

**Task** (stored locally, mirrored to cloud for the viewer): `id`, `from` endpoint, `to` endpoint, `goal` (max 2,000 characters, the existing cap), `pointers` (file paths, memory ids, commit refs; no contents), `origin` (`human_typed` or `agent_initiated`), `approval` (`not_needed`, `pending`, `approved`, `denied`, `expired`), `state`, `result_summary` (max 400 characters) plus `result_pointer`, timestamps, `reply_depth`, `idempotency_key`.

**Envelope delivered to the target:** `[M9R task T12 from @claude, approved by you] <goal, first 600 chars> Details: get_task T12.` The full record is fetched with `get_task`.

**States.** Reuse the existing delivery state machine (`accepted`, `queued`, `delivered_to_node`, `delivered_to_session`, `processing`, `completed`, `failed`, `expired`, `rejected`, `cancelled`). Add one pre-state, `awaiting_approval`, before `accepted` for agent-initiated tasks. Evidence per state comes from what we can observe: for Codex, `codex queue` acceptance, then the transcript's `task_started` and `task_complete`; for Claude, the hook's inbox hand-off, then the transcript's `assistant` message with `stop_reason: end_turn`.

**Result return.** When the target's turn completes, the Node reads the final assistant message from the transcript (both providers write append-only transcripts we can tail), stores the full text locally, and puts a one-line summary plus pointer into the caller's inbox. It does not inject the whole reply.

## 7. Authorisation model (first release: same user)

- **Human-typed mention:** authorised. The human wrote it.
- **Agent-initiated delegation:** `awaiting_approval` unless a standing rule allows it. Approval surfaces: the overlay ping, `m9r approve T12` in any terminal, and later a phone prompt.
- **Standing rules** (set by the human, with expiry): "trust @claude to hand tasks to @codex in this repo for 8 hours", with per-pair rate limit and a max reply depth. Default expiry 8 hours (the spec's proposal). A standing rule never covers protected actions.
- **Protected actions** (deploys, secrets, deletes outside the repo, spending money) always ask the human, regardless of rules. Enforced by the guard hook and the provider's own approval system, never by the model.
- **Loops:** the existing reply-depth cap (server-side) and a per-pair rate limit; a task that would exceed either is `rejected` with a visible reason. The server-side loop counter remains a Stage 0 open item and this feature must not make it worse.

## 8. Installing into the user's agents (consent, safety, removal)

`m9r init` shows exactly what it will change and asks. It never edits silently.
- **Hooks:** Claude in `~/.claude/settings.json` (user scope, so plain sessions get it), Codex in `~/.codex/hooks.json` or the config file. Safe merge that keeps existing entries, writes a timestamped backup, and is reversible with `m9r uninstall`. The existing capture-hook installer is the base.
- **Codex hook trust:** non-managed Codex hooks need a one-time trust review (`/hooks` in Codex). `m9r init` explains this and tells the user the exact step; it does not use the trust-bypass flag. Codex hooks are stored per hook in `~/.codex/config.toml` under `[hooks.state]`.
- **Standing instruction:** a small delimited block appended to the user's `CLAUDE.md` (user scope) and `AGENTS.md`, for example: "M9R is my own local agent network. If your context contains an 'M9R inbox' item marked approved by the user, handle that task first, briefly." The user sees it and can delete it; `m9r uninstall` removes only our block. Proven necessary: without it Claude ignores hook-delivered tasks.
- **MCP tools:** register the M9R MCP server (`search_memory`, `whats_happening`, `ask`, `inbox`, `get_task`, `approve`) via each provider's own MCP config. For Claude Desktop this means editing `claude_desktop_config.json`, which only happens with explicit consent, a backup and a safe merge, and Desktop must be restarted by the user.
- **Existing noise:** other tools' hooks can fail and show "Hook failed" (seen here from a third-party plugin). M9R hooks must fail silent and fast so they never add to that.

## 9. Shared context and memory (the token-efficient core)

**Layout (local, plain files, the Jake Van Clief idea, built in `memory-export-core.ts`):** `.oathlock/memory/<owner>/<channel or repo>/index.md`, then topic files, then detail files. Index lines are one sentence each with a link. Agents read files with tools they already have, so cost is paid only on use.

**Session-start card** (injected once per session by `SessionStart`), target at most about 300 tokens: my handle, who else is active and one line on what each is doing, count of pending inbox items, where memory lives, the standing rule to consult memory when unsure. No memory content.

**Inbox injection** (`UserPromptSubmit`): only when there is something new, delta-only using the existing durable cursor, at most 3 items, each at most about 200 tokens, marked "approved by you" or "awaiting your approval". Codex hooks have a per-hook `additionalContextLimit` (default 2,500 tokens); we set ours lower.

**Pull tools:** `search_memory(query)` returns titles and one-line hits with pointers; `get_task(id)`; `whats_happening()` returns a short activity digest.

**Write rules:** agents write only durable facts (decisions, failed approaches, contracts), each with provenance (agent, task, time) and a version. A conflicting fact is surfaced as a contradiction, not silently stored. Session logs and chatter are not memory.

**All of it is untrusted data.** Anything read from shared memory is labeled as data, never instructions, so a poisoned memory item cannot direct an agent.

**Collision guard** (deterministic, `PreToolUse`): before a write, edit or delete, look up locks and recent activity for that path. Hit: deny with one short line naming the holder and task (proven on both providers, 6 to 19 ms). Miss: silent. Lock rules: acquired automatically on first edit of a path by an endpoint, released on task completion or after a TTL (default 15 minutes without activity), visible to `whats_happening`. **Failure mode:** if the Node cannot be reached, reads and unlocked writes proceed (fail open); paths with a known live lock fail closed only if the lock was written to a local file the hook can read without the Node. That file is the source of truth for the guard, so the guard needs no network and no running Node.

## 10. The overlay (passive viewer)

A native, always-on-top window (a compact pill or dock on Windows first; a notch-style look on Mac later). It shows a live feed of everything the agents do, built from the activity events, transcript tails and M9R task events. Click a ping to expand the task, see the agent's recent output, or jump to that terminal or window. **It never delivers anything and never types into another app.** It costs no tokens and the system works without it. It also hosts the approval prompts for agent-initiated tasks. Native shell choice (Electron vs Tauri) and code-signing cost are deferred and are the only paid item on the roadmap; a local unsigned build for the owner is free. Opt-in per session.

## 11. Edge cases and failure behaviour (each needs a test)

| Case | Behaviour |
|---|---|
| Target session not running | Task stays `queued` (24 h, the existing rule); caller told "queued, @codex is offline"; delivered when the session appears (resume or new). |
| Target busy mid-turn | Codex queues natively; Claude gets it at its next prompt; state shows `delivered_to_node` until it starts. |
| Codex Desktop thread paused after an interrupt | Task lands in the queue UI, state `queued`; overlay shows "waiting for Resume". Never auto-resumed by M9R. |
| Session restarts or is replaced | Endpoint's session generation bumps; in-flight task is marked `failed` with reason `restart_interrupted` and one notice is posted (the restart-recovery behaviour we already built); nothing is run twice. |
| Same task delivered twice | Idempotency key = task id. `codex queue` has no dedupe of its own, so the Node records each queued item id in the delivery ledger and never re-queues a task already queued. |
| Two sessions match `@codex` | Ambiguity error with choices; no guess. |
| Message longer than the cap | Goal truncated at 2,000 characters with a marker and a pointer to the full text; the envelope carries the pointer only. |
| Node down | Hooks fail open and silent; guard uses the local lock file; sends fail with a clear "M9R node not running" message and offer to start it. |
| Hook slow or crashing | Hard timeout well under the provider's; never blocks the prompt; logs locally. |
| Agent is loop-bouncing tasks | Reply-depth and rate caps reject with a visible reason. |
| Secrets in a goal, memory item or result | Redaction pass before storage and before display; never written to the cloud mirror. |
| Windows paths and quoting | All spawn and file paths normalised; Windows shell quoting was already a real failure here (`codex queue` message with spaces needed explicit quoting). Covered by tests. |
| User has other tools' hooks | M9R hooks are additive and independent; uninstall removes only ours. |

## 12. Token budget (proposed caps, to be measured)

| Item | Cap |
|---|---|
| Session-start card | about 300 tokens, once per session |
| Inbox injection | at most 3 items, about 200 tokens each, delta only, only when something is new |
| Task envelope to a target | about 150 tokens (goal first 600 chars plus pointer) |
| Result summary back to the caller | 400 characters plus pointer |
| Memory index read | about 1,500 tokens, only when the agent chooses to |
| Guard denial message | one line |
| Overlay, routing, locks, activity, delivery state | zero (code) |

Measure real usage per session in the first slice and adjust; the caps live in one config so they can change without a release.

## 13. Security and privacy

- The Node's local API binds to localhost only, requires a per-user token stored with normal file permissions, and rejects requests without it. Hooks and MCP tools use the same token.
- Hook scripts are installed from a fixed location and their hash is recorded so a tampered script is noticed. The Node is a high-value process (it can reach repos), so it runs as the user with no elevated rights.
- Provider credentials never pass through M9R. We only invoke each provider's own CLI or app-server as the logged-in user on their own machine, in the way a user typing would. This is the reading of the provider terms in the Claude and Codex documents; **it should still get a real legal read before public launch.**
- Cross-user is disabled, not just unused: personal-scope endpoints are never resolvable by another account.
- Audit: every task, approval, lock and delivery is recorded locally with the actor, and mirrored (metadata only) to the cloud viewer. Full private transcripts are not uploaded.

## 14. Build slices, in order (each ends in a PASS/FAIL test on real sessions)

- **N1. Local Node API, inbox store, Claude hooks and standing instruction, `m9r init`/`uninstall` with consent.** PASS: with the web app closed, a task created by CLI appears in a plain Claude terminal session and a plain Claude Desktop session at the next prompt and is handled; sending "hi" alone does nothing; uninstall restores the original files byte for byte.
- **N2. Codex delivery via `codex queue` and Codex hooks.** PASS: in Claude type `@codex investigate X`; a plain `codex resume` terminal runs it; the result summary appears in Claude's inbox; the Codex Desktop app shows it in its queue and runs it after Resume; web app closed throughout.
- **N3. Activity log and collision guard for both providers.** PASS: with a lock held by one endpoint, the other's write and delete are denied with the holder named; an unrelated file is untouched; the guard works with the Node stopped.
- **N4. Workspace-free identity.** PASS: personal-scope endpoints, ambiguity handling, `@name` vs file-path rule; existing workspace endpoints unaffected.
- **N5. Approvals and standing rules.** PASS: agent-initiated tasks wait for approval; a standing rule with expiry lets them through until expiry; protected actions always ask.
- **N6. Overlay v1 (Windows), passive feed and approvals.** PASS: feed shows a real cross-agent task end to end; click jumps to the right window; system works with overlay closed.
- **N7. OpenCode adapter** (after its spike) and **Claude resumable turn** (after its test).
- **N8. Multi-machine** via the Relay, and the web observatory view of all of it.

Order rationale: N1 and N2 deliver the demo's first half with the fewest unknowns; N3 delivers the "less breakage" promise that motivates the whole product; identity is N4 because slices N1 to N3 can run on the current endpoint model for a single machine.

## 15. Cost

Building and running this adds no paid services. Test turns use the owner's existing provider subscriptions in small amounts. The only future paid item is the code-signing certificate for distributing the native overlay to other people, deferred.

## 16. Proven versus unproven (short form)

**Proven on this machine:** hooks inject context and catch mentions on Claude and Codex (about 20 ms); the deterministic guard denies locked writes on both; `codex queue` delivers into a `codex resume` terminal instantly and into the Codex Desktop app's queue (runs on Resume); transcript files give turn-done and final replies for both; a Claude channel push wakes an idle plain session; a hook-delivered inbox task is acted on by Claude when the user asks or when a standing instruction exists.
**Not proven:** Codex Desktop running a queued task with no pause; `claude --resume -p` against an open interactive session; OpenCode attach; how `codex queue` behaves if the thread is running a long turn; the injected-token cost in real sessions; Windows behaviour of the hook installer on machines with other hooks; and that Claude keeps honouring the standing instruction across versions (it is model behaviour, so it needs a regression test).

## 17. Decisions needed from the owner before N1

1. Add the two fidelity labels `QUEUED_NATIVE` and `NEXT_PROMPT`? (Recommended: yes.)
2. Personal scope: allow `workspace_id` to be null for personal endpoints? (Recommended: yes.)
3. OK to install a small standing-instruction block in the user's own `CLAUDE.md` and `AGENTS.md` with consent at `m9r init`? (Recommended: yes; proven required.)
4. Default standing-rule expiry 8 hours? Default lock TTL 15 minutes?
5. Guard failure mode: reads fail open; a path with a known live lock fails closed using the local lock file. Agreed?
6. Sibling-thread fallback allowed when a target has no door (labelled `CONSULTATION`)?
7. First overlay target: Windows pill now, Mac notch later. Agreed?
8. Slice order N1 to N8 as written, or move the overlay earlier?

## 18. Non-goals (guard against drift)

Not an agent OS, not a room or workspace for every interaction, not a wrapper, not a router that hides the agents, not an orchestrator with a boss agent, not a replacement for any provider's runtime, not cross-user in this release.

## 19. Sign-off record

**2026-09-20: owner answered "yes to all 8" on the section 17 decisions.** Locked: (1) add `QUEUED_NATIVE` and `NEXT_PROMPT` labels; (2) personal-scope endpoints with nullable `workspace_id`; (3) standing-instruction block in the user's own `CLAUDE.md` and `AGENTS.md` with consent at `m9r init`; (4) standing-rule default expiry 8 h and lock TTL 15 min; (5) guard fails open for reads and closed for a known live lock via the local lock file; (6) sibling-session fallback allowed, labelled `CONSULTATION`; (7) Windows pill first, Mac notch later; (8) slice order N1 to N8 as written. Design v0.1 is now the build baseline; changes after this need a new dated entry here. N1 is next once the owner says start.
