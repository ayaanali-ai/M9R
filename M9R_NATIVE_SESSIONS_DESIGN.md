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
