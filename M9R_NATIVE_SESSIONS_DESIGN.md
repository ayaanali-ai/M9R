# M9R Native Sessions: Stage 1 and 2 Implementation Plan (DRAFT v0.2, 2026-09-19)

Supersedes v0.1. Aligned with `M9R_COMPLETE_HANDOFF_2026-09-18.docx` (thesis, Stage 1-2, canonical demo) and `M9R_NETWORK_SPEC.md` (locked D1-D10). Nothing here is built. Provider facts come from docs fetched this session; anything unfetched is marked UNVERIFIED.

Sequencing note: the handoff says no Stage 1+ code until Stage 0 is done and the spec's state machines are locked. This plan is the design for that work. Section 7 is Stage 0 hardening that can start now; Sections 3-6 need your lock first.

## 1. The goal, in one flow

You are in your own Claude Code session and ask `@codex` to look at something. A Codex session that is already running receives it, works on it, and the answer comes back into your Claude session. No copy/paste, no M9R UI, no mandatory room. That is the handoff's canonical demo and Stage 2's proof.

Fidelity rule (handoff s.9): every endpoint advertises LIVE_NATIVE, RESUMABLE_NATIVE or CONSULTATION. We never call a consultation copy "the same live session".

## 2. Where the code is today

- Each session is a NEW headless ACP child spawned by the bridge (`acp-stdio-adapter.ts:728`, `bridge-runtime.ts:1305`). It uses the user's env, cwd and login, and Claude loads user/project/local settings.
- Nothing attaches to a `claude`, `codex` or `opencode` the user already runs. The terminal pane is a plain shell (`local-terminal-bridge-core.ts:19`).
- Cross-agent messaging works only through workspace channels: a mention routes to the target's bridge, and the prompt is built from channel context (`buildWorkspaceTurnPrompt`). M9R-started Claude sessions have `send_message` via `oathlock-dev-tools`.
- A Claude you started yourself has no way to post. Hooks only observe it.

Honest label today: local-hosted, channel-based consultation. Stage 1-2 turn that into addressable live endpoints.

## 3. Architecture (from the handoff and spec, mapped to code)

- **Endpoint** (D1, D2): durable `ep_` id, handle `@handle/name`, replaceable `sessionGeneration`. One user can have several simultaneous sessions per provider, each its own endpoint.
- **M9R Node** (D4): new `services/m9r-node`, importing extracted Bridge modules. The Bridge stays for the cloud/CI path. The Node owns adapters, presence, local policy, PTYs, reconnect queue, and an outbound connection to the Relay.
- **Relay** is already a Durable Object per workspace (D9 done). Fabric truth lives in Supabase.
- **Delivery** (D5, D6): at-least-once to the Node, deduped into the session, `processing` only on adapter confirmation, 24 h offline queue with sender notice.
- **Control** (D8): fenced lease with `controlEpoch`; the session owner can always preempt.
- **Cross-owner** (D7): deny by default. For Stages 2-4 the "cross-user" case is same-workspace teammates.

## 4. The one thing every provider needs: a way in and a way out

A provider session participates in the fabric through two channels.

**Out (the session addresses others).** Give the session a tool or command to send to `@handle`:
- Register an M9R MCP server (or `m9r ask @codex "..."` command) in the user's own Claude, Codex and OpenCode configs. This is the smallest reliable path and needs no preview feature. It must be additive, visible, and removable with one command.
- A UserPromptSubmit hook that parses `@codex` from the user's prompt is a convenience layer on top, not the primary path.

**In (the session receives).** Depends on provider and on how the session was started:

| Provider | Session started by user in their own terminal | Session hosted by M9R |
|---|---|---|
| OpenCode | LIVE_NATIVE via its local server (needs pinned port + password, launch wrapper or config; UNVERIFIED discovery of a bare TUI's port) | LIVE_NATIVE (same) |
| Codex | RESUMABLE_NATIVE at best (`codex exec resume` when idle, UNVERIFIED) plus coarse observe via notify/otel | LIVE_NATIVE via `codex app-server` (`turn/steer`, `turn/interrupt`, approvals) |
| Claude Code | Observe and approve via hooks (only for sessions started after install); inject at the next turn boundary via a UserPromptSubmit inbox hook; mid-turn only via Channels (research preview, dev flag) | LIVE_NATIVE via Agent SDK / ACP child we own, or a PTY we own |

Cloud-hosted Claude Managed Agents sessions are a separate, real attach path: the `ant beta:sessions connect` docs confirm follow, send, interrupt and approve/deny on an existing managed session. That applies to sessions in the Anthropic Console workspace using the API, not to a local `claude` terminal, so it is a possible "remote endpoint" adapter later, not the local answer. Auth is Console/API based (UNVERIFIED whether subscription auth works).

The `m9r run <agent>` PTY wrapper is the universal fallback: launch the real CLI inside an M9R-owned ConPTY and we get observe, inject and steer for all three providers at terminal fidelity. It requires starting agents through M9R.

## 5. Stage 1: Live Session Endpoint

Deliverable: real Claude, Codex and OpenCode sessions get stable endpoint identity, ownership, presence, direct addressing and a published capability/fidelity matrix. Proof: web app closed, `m9r ask @handle` reaches a real native endpoint.

Build order:
1. Endpoint registry + `ep_` ids + handles (Supabase tables, no Relay change).
2. Node skeleton (`services/m9r-node`): supervisor, Relay client, adapter interface with capability/fidelity flags (handoff s.9 flag list), presence heartbeats with expiry.
3. Adapters in this order:
   - **Codex app-server** (handoff calls it the preferred first adapter). M9R hosts threads; native steer, interrupt and approvals. This is the "M9R hosts the native session" model.
   - **OpenCode server attach** (documented HTTP + SSE, abort, permission reply). Require `OPENCODE_SERVER_PASSWORD`, bind loopback only.
   - **Claude**: hooks (observe, approve, inbox) plus M9R-owned sessions. Fidelity shown honestly per session.
   - `m9r run` PTY wrapper as fallback.
4. `m9r agents` / `m9r presence` / `m9r ask` CLI, and the "out" tool registration from Section 4.

## 6. Stage 2: session-to-session Machine Call

Deliverable: a live session asks another live session for help, no copy/paste, proven across at least two providers, consultation labeled honestly.

Minimum path: Claude endpoint sends via `m9r ask @codex` -> Relay -> Codex Node -> app-server thread (`turn/start` or `turn/steer`) -> events stream back -> reply lands in Claude's inbox (delivered at next turn via hook, or immediately if Channels/PTY). Delivery states surfaced: accepted, delivered-to-node, delivered-to-session, processing, completed/failed.

Capsules, grants and receipts (Stage 4) are out of scope here, but every message carries a capsule reference field so they slot in later.

## 7. Stage 0 hardening from the audit (can start now, independent of the spec lock)

1. Add `.oathlock/` and `.claude/settings.local.json` to `.gitignore` (or `.git/info/exclude`) during init. Today a plaintext token can be committed.
2. Pick the `allow_once` permission option explicitly instead of `options[0]` (`acp-stdio-adapter.ts:474-477`).
3. Make autostart an explicit y/N in init; stop `doctor` from spawning a daemon; add an uninstall that reverses everything.
4. Add `capture uninstall` and make transcript capture opt-in with a plain disclosure.
5. Warn or force default permission mode if the user's Claude settings use `bypassPermissions`, since it would skip M9R's deny-list.
6. Show the provider session id in the UI so the user can `claude --resume <id>`.
7. Smoke test that M9R-started sessions appear in each provider's native history (currently unverified).
8. Disclose "what leaves your machine"; default hosts are Cloudflare staging URLs.

## 8. Principles (handoff s.19, kept)

- The provider's own CLI authenticates; M9R does not vault provider credentials.
- Config edits are additive, visible, reversible. Loopback only, per-install secret, reject browser origins.
- Remote text injected into a turn is labeled with its origin.
- Authority is deterministic code, never the model or Jev.
- Every adapter fails unsupported operations explicitly. No fake native semantics.
- Nothing is marked shipped until proven live with PASS/FAIL evidence.

## 9. Decisions I need from you before Stage 1 code

1. Confirm sequencing: Stage 0 items in Section 7 now, then lock the spec's state machines, then Stage 1.
2. Adapter order: Codex app-server first (handoff) or OpenCode first (easiest attach)?
3. "Out" path: OK to register an additive M9R MCP server / `m9r ask` command in the user's own Claude, Codex and OpenCode configs, opt-in and removable?
4. Are you fine that a Codex or Claude session you started outside M9R stays RESUMABLE or CONSULTATION until you start it via `m9r run`?

## 10. Unverified (must check before building)

Codex app-server details (approval methods, WebSocket auth, whether a TUI can join a shared server, `--remote`); the OpenAI harness post could not be fetched (HTTP 403). Codex rollout paths and `codex exec resume` with an open TUI. Claude `--resume`/stream-json, `additionalContext` return, hook behavior on Windows. OpenCode port discovery and session storage. ACP cancel/permission text. Provider terms on driving subscription logins from background processes. Whether M9R-started sessions show in native history.

## 11. Codex app-server: verified facts and adapter design (2026-09-19)

### 11.1 What was verified against the installed Codex (codex-cli 0.153.4, Windows)

Ran a real handshake over stdio (`codex app-server`, one JSON object per line, no `jsonrpc` field needed) and generated the full protocol with `codex app-server generate-ts`.

- Handshake works: `initialize` (clientInfo) then an `initialized` notification. Response includes `codexHome` and platform.
- `thread/start` (cwd, approvalPolicy, sandbox, serviceName, model, developerInstructions, ephemeral) returns a thread id. `turn/start` takes `input: [{type:"text", text, text_elements:[]}]`.
- `thread/loaded/list` lists threads loaded in that server. `thread/list` (filterable by cwd) lists persisted threads. Both worked.
- Requests that give live control (present in the generated protocol, not yet exercised end to end): `turn/steer` (needs `expectedTurnId`), `turn/interrupt`, `thread/resume`, `thread/inject_items`, `thread/fork`, `thread/rollback`, `thread/shellCommand`.
- Server-to-client approval requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, plus legacy `applyPatchApproval` / `execCommandApproval`.
- Notifications cover the whole lifecycle: `thread/started`, `thread/status/changed`, `turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed`, `turn/completed`, `turn/diff/updated`, `turn/plan/updated`, `thread/tokenUsage/updated`.
- Threads created this way are normal, persisted Codex threads (they showed up in `thread/list`, and the earlier ACP-started session was found in `~/.codex/sessions`).

**Not verified yet:** a full successful turn (streaming, steer, interrupt, approval round trip). The test turn failed with Codex's own "usage limit reached, resets Sep 19 2:11 PM" message, so these need a rerun after the reset. This also means the earlier native-history smoke test for Codex proves the session was recorded, not that its turn succeeded.

### 11.2 The shared-daemon discovery (changes the plan)

The installed Codex has, beyond what the docs I could fetch showed:
- `codex --remote <ADDR>` (with `--remote-auth-token-env`): the Codex TUI can connect to a remote or shared app-server.
- `codex app-server --listen` accepts `stdio://`, `unix://PATH`, `ws://IP:PORT`.
- `codex app-server daemon start|stop|restart|bootstrap` and `codex agents` ("browse all agent sessions on the shared local app-server daemon").
- (`remote-control` / `enable-remote-control` is Codex's own hosted remote feature. We do not use it.)

If a TUI attached to an M9R-run app-server behaves as the flags suggest, then the user's own Codex TUI and M9R can share the same live threads, which is exactly the "M9R and the user in one native session" goal. Not yet proven: whether the TUI's threads appear in `thread/loaded/list` on the shared server, and what auth `--remote` requires.

### 11.3 Adapter design (proposal, needs approval before code)

**Where it lives:** `src/lib/bridge/codex-app-server-adapter.ts`, implementing the existing `InteractiveProviderAdapter` interface, so the bridge can choose it instead of the ACP wrapper for Codex. Reused later by `services/m9r-node` (D4). No Relay or database changes.

**Process model (default, no new background service):** the bridge spawns one `codex app-server` per bridge process (stdio, `windowsHide`, same env and `CODEX_HOME` as the user's Codex), speaks JSONL, restarts it with backoff if it dies. Sessions are threads inside it. If the app-server dies, threads persist on disk and are resumed with `thread/resume`.

**Optional shared mode (opt-in, later):** M9R runs the server on `unix://` or loopback `ws://127.0.0.1:PORT` with a per-install secret so the user's TUI can attach with `codex --remote`. Needs its own decision because it is a persistent listener.

**Mapping to the interface:**
- `launchServer` / `initialize`: spawn + handshake; capabilities set from what the server actually reports.
- `createSession`: `thread/start` with cwd, `approvalPolicy: "on-request"`, sandbox from M9R policy, `developerInstructions` = M9R rules and persona (replaces per-turn prompt injection for Codex). `providerSessionRef` = thread id, which is exactly what `codex resume <id>` takes (this makes the new "Resume natively" button work for app-server sessions).
- `resumeSession`: `thread/resume`.
- `prompt`: `turn/start`; map `item/agentMessage/delta` to output events, `turn/completed` to `provider.completed`/`failed` (surfacing Codex's own error text, e.g. usage limit), token usage to usage events.
- `cancelTurn`: `turn/interrupt` (native, replaces the 10 s force-close workaround).
- Mid-turn message: `turn/steer` with `expectedTurnId`. This turns `mid_turn_steering` on for Codex, which ACP could not do.
- Permissions: map the server-to-client approval requests into the existing permission flow (deny-list first, file-lock check, human approval, timeout auto-cancel). Answer with the explicit "accept once" decision, never an "always" decision.
- `closeSession`: `thread/unsubscribe` (thread stays in history). `shutdown`: stop the server.

**Fidelity:** LIVE_NATIVE for threads M9R hosts (observe, steer, interrupt, approve). Threads started by the user in a separate plain TUI stay RESUMABLE_NATIVE or CONSULTATION until shared mode exists.

**Edge cases the build must handle (and test with a fake app-server first):**
1. Usage limit or auth errors arrive as `turn/completed` with status failed: report the real message, do not retry-loop.
2. Server crash mid-turn: fail the turn, restart, `thread/resume`.
3. Approval request that arrives after the turn was interrupted: answer "cancel".
4. Two turns requested at once: reject with the existing "session already has an active prompt" behavior; steer is a separate explicit call.
5. Unknown notification methods and future protocol changes: ignore, log once, never throw.
6. Protocol version drift: pin a tested Codex version range and report a clear "unsupported Codex version" instead of failing obscurely.
7. Windows: launch through the npm `codex.cmd` shim with `windowsHide` (same as the current ACP path).
8. Zero extra cost: everything is local and uses the user's own Codex login and quota. No cloud service is involved.

**Build order (once approved):**
1. JSONL transport + typed client with a fake app-server test double (no Codex quota needed).
2. Adapter against the fake, with the edge-case tests above.
3. Live run against real Codex after the quota reset: full turn, steer, interrupt, approval round trip. Record PASS/FAIL.
4. Feature flag in the bridge to choose app-server or ACP for Codex; ACP remains the fallback.
5. Then, separately decided: shared mode and `m9r run codex`.

## 12. Cross-agent "out" path: built (2026-09-19)

`m9r-cli ask <agent> "<message>" [--channel general] [--wait] [--timeout N] [--agent-kind <your kind>]` posts from whatever agent runs it, addressed to one connected agent (mention in the text plus a direct recipient id), and with `--wait` prints that agent's threaded reply. It uses only the agent-facing API the connection already has a token for; no new endpoints, no preview features, no config edits in the user's own tools. The managed repo block (`bootstrap`) now tells agents about it, so a Claude or Codex session the user started themselves can use it through its normal shell tool.

Proven live on staging: a Codex-identity `ask @claude-code "reply with only the single word: pong5" --wait` produced exactly one direct message and one threaded reply, printed back in about 13 seconds. 6 new CLI tests cover the target, channel, wait, timeout and refusal paths.

Deliberately not built: an MCP server that exposes the same call as a tool. It would add the MCP SDK to the published CLI and edit the user's Claude/Codex/OpenCode configs, so it waits until the CLI route proves insufficient. Caveat: an agent has to be told to use it (the bootstrap block does that for repos that ran `bootstrap`; existing blocks refresh on the next `bootstrap`).

## 13. Native front doors and the shared-context model (decided direction, 2026-09-19; spikes pending)

**The requirement (owner, restated).** A user must be able to mention `@codex`, `@opencode` or any connected agent from the Claude desktop app or a plain terminal, and it must reach that agent in its own app, with no M9R workspace, no `m9r run` wrapper, and no pasting. The first release is one user with all their own agents; team and cross-user come later. The point is coordination: agents that know what each other are doing, share context and memory, and so avoid duplicated work, accidental breakage and deletions, and lost efficiency.

**Two layers (they fail independently).**

*Layer 1: shared context and awareness (the product core; works for plain sessions).*
- Read is **pull, not push.** A session-start hook injects only a card of about 5 lines: the agent's handle, who else is active and on what, and where memory lives. It carries pointers, never memory content.
- Memory is plain markdown on disk (the Jake Van Clief idea; built as `memory-export-core.ts` writing `.oathlock/memory/<owner>/<channel>/*.md`, plus a `search_memory` tool; wiring into this flow is unverified). Index, then topic, then detail, so an agent opens only what it needs. Agents already read files, so cost is paid only on use.
- Agent-facing tools: `search_memory`, `whats_happening`, `ask @agent`, `inbox`, `get_task`. Each returns short answers with pointers.
- An instruction snippet (`CLAUDE.md` / `AGENTS.md`) names when to look: starting a session or task, before touching a shared or unfamiliar file, when unsure of a past decision, and before finishing (write durable facts only).
- **Deterministic machinery runs in code and costs zero tokens:** activity logging from tool-event hooks, file locks and collision checks (pre-tool hook, warn or deny, silent unless there is a conflict, then one short line), routing, the overlay. Nothing depends on the model remembering.
- Token discipline: injections capped (target about 300 tokens, configurable) and delta-only (existing cursor); summaries written at write time; facts expire or are superseded; agent-to-agent reply depth capped (already exists); shared memory is untrusted data, never instructions.

*Layer 2: delegation (`@codex do X`).*
- A task record carries the goal and pointers to files and memory ids, not a dump. The envelope is about 3 lines plus a task id; the receiver pulls detail with `get_task`.
- Delivery uses the best door available, and the address book labels it: a live door (Claude channel with `--channels`; Codex on a shared app-server via `--remote`) is `LIVE_NATIVE`; otherwise the task runs in a sibling thread of the same provider in the same repo (the adapter already built and proven) and is `RESUMABLE_NATIVE`; replies to an idle plain session arrive at its next prompt via hook (labeled delivered-on-next-prompt). No wrapper is required for any of these.
- Reply returns as a one-line summary plus a pointer (`get_task T`).

**The overlay is a passive viewer.** It shows a live feed of what every agent is doing, from transcript tails, hook events and M9R events. Clicking a ping only reveals detail or jumps to that terminal. It never delivers anything and costs no tokens; agents work without it. It is a native always-on-top window (a floating pill or dock on Windows; a notch-style look later on Mac) and needs the native shell, whose code-signing cost is the one paid item and stays deferred. Original idea: the older 30d "cross-provider live-awareness overlay" (2026-09-06).

**Rejected or demoted.** `m9r run <agent>` PTY wrapper and an M9R-hosted TUI (Herdr-style): reliable, but they make users launch agents inside M9R; optional power surface at most. OS-level keystroke injection into another app's window: the only truly provider-neutral push, but brittle and a prompt-injection path; last resort, off by default, never remote-triggered.

**Verified from primary docs (not yet tested on this machine).** Claude Code channels: an MCP server declaring `claude/channel` pushes events into a running session; two-way via a reply tool; permission relay for remote approval; research preview; events arrive only while the session is open; custom channels need `--dangerously-load-development-channels` (not on Anthropic's allowlist) and Team/Enterprise need an admin to enable. Claude hooks fire the same in terminal, IDE and Desktop; `UserPromptSubmit` sees typed prompts; hooks cannot wake an idle session (the `asyncRewake` behaviour is unclear). Desktop supports MCP servers, hooks and plugins; channels are not documented for Desktop. Codex app-server: several clients can share a thread and see `turn/started`; a TUI attaches with `codex --remote`; WebSocket is experimental. The Codex Desktop app's own thread cannot be attached (openai/codex#25914, open).

**Spikes (local, no cost, scratch projects only; no real config touched without consent).** S1 hook context card and latency in Claude terminal and Desktop. S2 pre-tool deny when another agent holds the file. S3 `@mention` caught by `UserPromptSubmit`. S4 what Codex offers (hooks, notify, MCP tools, plain-TUI visibility to an app-server or daemon). S5 `asyncRewake` on an idle session. S6 channel push and permission relay in a Claude terminal; channels in Desktop. S7 transcript-tail feed and reply capture for both providers. Results are recorded in section 14 below as they land.

**Open decisions.** Fail-open versus fail-closed when the Node is down (proposal: reads fail open, locked paths fail closed). Whether a sibling-thread fallback is acceptable when a plain open window cannot be pushed into (proposal: yes, labeled resumable). A fourth fidelity label for delivered-on-next-prompt.

## 14. Spike results (2026-09-19, this machine: Codex 0.153.4, Claude Code 2.1.263, OpenCode 1.18.31)

Scratch projects only; no real config touched. Scripts and logs live in the session scratchpad (`hookspike/`, `spike-queue.mjs`, `spike-transcripts.mjs`).

| Spike | Result |
|---|---|
| S1 context card via hook (Claude) | **PASS.** A `UserPromptSubmit` hook injected a one-line card; the model quoted it back. Hook latency 23-29 ms. |
| S3 literal `@codex` caught (Claude) | **PASS.** The hook saw the raw prompt text `@codex please ...` and could route it. |
| S2 deterministic collision guard (Claude) | **PASS.** A `PreToolUse` hook denied a `Write` to a locked file with our reason string and allowed the other file; the model relayed the reason. Latency 17-19 ms. Runs in code, zero model tokens. |
| S7 transcript feed (both) | **PASS.** Codex rollout has `task_started`/`task_complete` per turn and the final assistant message. Claude transcript has assistant messages with `stop_reason: end_turn` and every `tool_use`. Enough for the passive overlay and for reply capture without any injection. |
| S4a Codex `hooks` | **Feature is stable and on.** Same events and stdout contract as Claude (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PermissionRequest`, ...), `additionalContextLimit` per hook (built-in token cap), runs in the Codex desktop app and `codex exec`. Non-managed hooks need a one-time trust review (`/hooks`). **Not yet run here**: the only non-interactive path is `--dangerously-bypass-hook-trust`, which the permission classifier blocked; needs the owner to trust once or approve the flag for the scratch dir. |
| S4b `codex queue` | **PASS, and the most important finding.** `codex queue --thread <id> --message "<text>"` (an official CLI command; durable store `~/.codex/queue_1.sqlite`) run from outside started a real turn in a thread that a separate running app-server had loaded: `turn/started`, a `userMessage` item with our text, reply "two", `turn/completed`, and the server emits `thread/queue/changed` to subscribed clients. This is a native, sanctioned push into an existing Codex session with no wrapper. **Unproven:** whether a thread open in the Codex Desktop app or a plain TUI consumes the queue the same way (needs a UI-owned thread). |
| S4c shared daemon | `codex agents` ("all agent sessions on the shared local app-server daemon"), `codex app-server daemon start/stop`, `codex remote-control`, `codex --remote`. A daemon exists; not yet checked whether Desktop and plain TUI sessions register with it. |
| S5 `asyncRewake` | Not run. |
| S6 channels (terminal, Desktop) | Not run: needs `--dangerously-load-development-channels` (blocked as a bypass flag) and, for Desktop, an edit to the real `claude_desktop_config.json`. Needs owner consent. |
| Claude other doors | `claude --bg` background sessions with `attach`/`logs`/`stop` and `claude agents` exist but are for sessions started with `--bg`. No `claude queue` equivalent. `claude --resume <id> -p` resumes a session non-interactively (not tested against an open interactive one). Claude transcripts contain `queue-operation` events (Claude has its own prompt queue; not documented as an external API). |

**What this changes.** Layer 1 (context card, pull tools, activity, deterministic guard) is now proven for Claude and documented for Codex with the same contract, at about 20 ms per hook and with a built-in context cap. For Layer 2, Codex now has a real native push (`codex queue`), so the sibling-thread fallback may be needed only for Desktop threads that do not consume the queue, and for Claude, where plain sessions still depend on hooks (next prompt), channels (`--channels`), or `--bg`. The M9R Codex adapter should prefer `codex queue` / the shared daemon over spawning its own app-server thread once the Desktop/TUI consumption is proven.

**Next spikes (need owner action).** (1) Open the scratch thread in the Codex Desktop app or a plain `codex resume`, then `codex queue` into it and watch it run. (2) Trust the scratch Codex hooks once (or approve the bypass flag for the scratch dir) and run C1/C2. (3) Channels: approve the development flag and, for Desktop, a backed-up edit to `claude_desktop_config.json`. (4) `asyncRewake` on an idle Claude session.

**S4b follow-up (2026-09-19, owner-confirmed):** with the scratch thread open in a plain `codex resume` terminal, `codex queue --thread <id> --message ...` from another process ran as a live turn in that terminal (the row was consumed in under 8 s; the owner saw the message and the reply "three" appear in the open window). So a plain, user-started Codex terminal session can be reached natively with no wrapper. Still unproven for the Codex Desktop app. Note: the terminal also showed three "Hook failed / exit 1" lines from the owner's Vercel plugin session-start hooks (not M9R); hook trust is persisted in `~/.codex/config.toml` under `[hooks.state]`.

**S4a follow-up (2026-09-19, owner trusted the scratch hooks):** **PASS on Codex.** `codex exec` in the scratch project: the `UserPromptSubmit` hook caught the literal `@claude` mention (23 ms) and its one-line card reached the model, which quoted it back; the `PreToolUse` guard denied the shell write to the locked file and allowed the free one (6-10 ms per check). Same contract and same latency as Claude. Open oddity: Codex labeled our `SessionStart` hook "Failed" although it exited 0 with valid JSON (cause not yet found; `UserPromptSubmit` and `PreToolUse` are unaffected).

**S6 follow-up (channels): inconclusive, needs an interactive session.** A scratch two-way channel server (`chspike/channel.mjs`, SDK 1.30.0) loaded and started in a headless `claude -p --input-format stream-json` session with the development flag, and an HTTP push was sent while the session sat idle after its first turn; the session did not react and the debug log showed no channel registration. This does not disprove channels (headless mode may not process them, and the development flag normally shows an interactive consent prompt). Needs a real terminal session. **Claude Desktop:** documented flag table has no `--channels` equivalent, so channels cannot be opted in there; testing would also mean restarting the Desktop app that hosts the current work, so it was not attempted and the real `claude_desktop_config.json` was not touched. Desktop reach therefore rests on hooks (proven) and the MCP inbox/tools, not channel push.

**S4b Desktop result (2026-09-20, owner-observed):** `codex queue` into two Codex Desktop threads (an older one, and a fresh idle one titled "TEST SESSION FOR HOOK", `01a0bc1f-...`) was **not consumed**: the queue row stayed for 25+ s, the turn count did not change, and nothing appeared in the Desktop UI. So the Codex Desktop app does not act on the external queue the way a `codex resume` terminal does. Desktop reach must use hooks (Layer 1, documented to run in Desktop) plus M9R's own thread, until OpenAI ships thread attach (openai/codex#25914). Note: the queued "ping" rows remain in `~/.codex/queue_1.sqlite` and may run if those threads are later loaded by a client that consumes the queue.

**S6 channel result (2026-09-20, owner-observed): a channel push DOES wake an idle, plain, user-started Claude Code terminal session.** With the session idle, the pushed event rendered as `← m9rchan: ...` and Claude began a turn within about 5 s. Claude then **refused** it as a suspected prompt injection because the message told it to call a `reply` tool that was not in its toolset and did not come from a recognised sender. Lessons: (1) channel content is treated as untrusted by the model, which is the right default; a message must come from a registered channel with a real reply tool and clear `instructions`, or be a plain-text task; (2) the reply tool must actually be loaded (the scratch server's tool was not available in that session; cause not yet found); (3) the flag `--channels` (here the development flag plus an interactive consent) is required at launch, so a plain `claude` started without it has no channel. `asyncRewake` remains untested.

**Correction (2026-09-20, owner screenshots):** the S4b Desktop conclusion above ("not consumed") was wrong. The Codex Desktop app **did** receive the externally queued message: it appears in the Desktop thread's own queue UI ("Queue paused because you interrupted", with Resume / Steer / delete controls). The queue is paused only because that thread had been interrupted. So `codex queue` reaches the Desktop app; whether it runs unattended depends on the thread's pause state (a Resume click, or a new normal turn). Verification of the Resume step is pending. The owner also reports seeing an earlier attempt from about 19 hours before in the Desktop app.

**S6 trust finding (2026-09-20, owner screenshots):** a channel push reliably wakes an idle plain Claude terminal (twice), but Claude refused both messages: it treats content claiming to come from another agent as untrusted data and acts only on the human's own words. The scratch `reply` tool itself works when the server loads (headless test called it successfully; the earlier "no reply tool" was not the deciding factor). This matches the always-ask decision in the spec: agent-to-agent delegation into Claude needs human provenance. Two legitimate shapes: (1) the human typed the `@mention` themselves, so M9R forwards the human's own words, attributed, as the human's message; (2) an agent-initiated delegation is shown to the human for approval (or a standing trust rule such as "trust this pair for 8 h"), and on approval is delivered as the human's instruction. A third test (human words forwarded) is running.

**Results 2026-09-20 (owner-observed + headless tests):**
- **Codex Desktop, proven:** after the owner clicked Resume on the paused queue in "TEST SESSION FOR HOOK", the externally queued message ran and Codex answered "ping". So `codex queue` reaches both a `codex resume` terminal (consumed immediately) and the Codex Desktop app (lands in its queue; runs on Resume when the thread was interrupted; unpaused-idle case not separately tested).
- **Claude channel, third framing failed:** even "forwarded by M9R, you typed this and approved it" was refused ("content delivered this way ... I'm not going to comply, just type it directly here"). A channel push wakes the session but Claude will not take instructions from it. Do not build Claude delivery on channel text.
- **Claude hook inbox works, and the human is the authoriser (headless):** (A) with a hook-injected "M9R inbox: 1 pending task ... approved by the user" and the user saying "Handle my M9R inbox", Claude did the task ("received"). (B) with only "hi", Claude ignored the inbox item (injection-safe). (C) with a standing instruction in the user's own `CLAUDE.md` ("if your context contains an M9R inbox item marked approved by the user, handle it first"), Claude tried the inbox task first (it looked for `get_task T10`, which does not exist in the scratch) and then answered the user's actual question. So a user-consented standing instruction plus a hook makes pending tasks actionable on the next prompt in both terminal and Desktop, with no typing and no wrapper.
- **Decision this supports:** Claude as receiver = hook inbox at the next prompt, authorised by a standing instruction the user installs once (consent at `m9r init`), plus an M9R-initiated resumable turn (`claude --resume <id> -p "<task>"`, a genuine user-role prompt; not yet tested against an open interactive session) when instant handling is wanted. Codex as receiver = `codex queue` (terminal and Desktop), with hooks for context and the guard. Agent-initiated delegation still needs human approval or a standing trust rule. `asyncRewake` is no longer on the critical path and stays untested.
