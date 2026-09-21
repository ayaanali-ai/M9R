# M9R Relay on Durable Objects — Design Pass (DRAFT v0.1)

**Date:** 2026-09-19 · **Status:** design only — no implementation until the founder approves the decisions in section 12 · **Locked input:** spec decision **D9 = "Move to Durable Objects now"** (`M9R_NETWORK_SPEC.md`).
**Sources:** a line-by-line inventory of the current Relay (~4,300 lines: `services/mission-relay`, `src/lib/mission/mission-relay-*.ts`, both clients, the contract tests) and Cloudflare's own documentation (URLs in Appendix D). Anything I could not confirm is marked **[VERIFY]** and has a spike in section 9.

---

> **Design revision R1 (2026-09-19, build phase).** After reading the code, the existing `MissionRelayService` turned out to be fully portable: it has no Node imports and takes all database access through an injected options object. The build therefore **runs that same, tested service unchanged inside a per-workspace Durable Object** and points its options at the web app over a service binding (`/api/internal/relay/rpc`, which calls the existing `createProductionMissionRelayOptions` functions). A gateway Worker reads each socket's first frame to pick the workspace Hub, so **the URL does not change and no client changes are needed** — this removes the `/v2/<workspaceId>` URL and the legacy-container window from D-R3, and makes the cutover a same-name deploy. Sockets are standard (non-hibernating) for the MVP, matching the container's state lifetime; hibernation, richer limits and the phase-2 items remain follow-ups. Built in `services/relay-do/`; acceptance test 14/14 on the real stack.

## 0. Summary (read this first)

**Recommendation.** Rebuild the Relay's *transport* on Durable Objects, **one Workspace Hub DO per workspace** behind a thin gateway Worker, and **do not port the business logic**. Everything that touches the database or product rules (channel authorization, snapshots, message persistence, evidence/task side effects, agent-token auth, mission reads) stays in the Next.js app and is called from the Hub over a Cloudflare **service binding**. The Hub owns only what a Relay should own: sockets, rooms, fan-out, presence/typing, PTY/file-tree routing, and connection policy.

**Why this is the right shape.**
- The inventory shows the Relay is ~1,200 lines of transport wrapped around ~3,000 lines of database/business code that already exists and already runs in the Next app. Porting that code to the Workers runtime is where the risk is (Node `crypto`, `next/headers`, `authenticateAgent`, the mission service graph). Calling it over a service binding removes the risk and the duplicated availability logic that already caused drift.
- `workspaceId` is a natural shard key: every frame carries it, principals are single-workspace, rooms never span workspaces, and PTY linking is workspace-local. One DO per workspace keeps `publishWorkspace`, PTY linking and presence local, and removes the single-process ceiling for good.
- A Durable Object has a documented **soft limit of 1,000 requests per second per object**. A workspace is far below that for chat, but a busy terminal can approach it. The design handles this with output coalescing now and an optional PTY split later (section 4.3).

**What changes for clients (unavoidable).** A DO must be chosen at WebSocket upgrade time, but today's clients connect to a bare URL and reveal the workspace only in the first frame. The new Relay lives at `wss://<relay>/v2/<workspaceId>`. Existing clients keep working against the old container Relay until every workspace is cut over (section 7), so nothing breaks for people on published CLIs.

**What this buys.** No single instance; automatic per-workspace scaling; hibernation (idle workspaces cost ~nothing); presence derived from live sockets (fixes stale "online"); real connection limits, auth deadline, session expiry and revocation (all missing today); and a Relay built to the target protocol (spec section 7 delivery states) instead of re-ported twice.

**Cost of the rewrite.** Estimated **5–6 weeks** of focused work (section 10), built *beside* the container Relay and cut over per workspace behind a flag, with instant rollback. Stage 0 reliability work continues on the container Relay and is not blocked.

**Risks that matter most.** (1) Every deploy disconnects every socket — a reconnect storm on each release; (2) PTY throughput against the 1,000 req/s soft limit; (3) hibernation drops in-memory state, so all ephemeral state must be rebuildable from socket attachments; (4) the client URL contract change. Each has a mitigation and a spike below.

---

## 1. Goals, non-goals, success criteria

**Goals**
1. Remove the single-instance limit: correct behavior with any number of workspaces and sockets, no process-local truth.
2. Preserve the v1 wire protocol and every client-visible contract (section 6) so the browser client, Node client, and CLI need only a URL/backoff change.
3. Fix the transport defects the inventory found instead of porting them (Appendix C).
4. Keep all database and business logic in one place (the Next app).
5. Make cutover reversible per workspace.

**Non-goals (this pass)**
- New product features, the Stage 1+ protocol objects (endpoints, calls, grants, receipts) — this Relay is built so they can be added, but they are not part of it.
- Changing message storage, the cursor format, or the Supabase schema.
- Moving the PTY *shell* anywhere: shells stay on the user's machine; the Relay only routes bytes.

**Success criteria (PASS/FAIL, all required before any workspace is cut over)**
- The existing contract tests (`scripts/mission-relay*.test.ts`, `workspace-relay-phase1.test.ts`) pass against the DO implementation through a transport adapter, unchanged.
- Reconnect-with-cursor resumes with no loss and no duplicate after a forced hibernation, after a deploy, and after a network drop, for 1,000 consecutive cycles in a soak.
- A message posted on socket A appears once on every subscribed socket B, in order, with the same `correlationId` confirmation semantics.
- p95 post→fan-out latency ≤ the container Relay's measured p95 (baseline captured first, section 9).
- Killing/evicting the DO mid-conversation loses no durable data and rebuilds presence within one reconnect.

---

## 2. What the Relay does today (compressed from the inventory)

- **One Node process**, `ws` library, in a Cloudflare Container pinned to one fixed instance. Six process-local maps: connections, subscriptions (with 128-frame mailboxes), presence, typing, huddles, PTY sessions (64 KiB scrollback each). Nothing authoritative lives in Supabase except messages and cursors.
- **~50 client frame types and ~35 server types** in one envelope (`oathlock.relay.v1`, 8 KiB payload / 16 KiB frame). Clients also *reject inbound* frames over those limits.
- **Auth is the first frame** (signed HS256 token, or a raw agent token verified against Supabase). No auth on upgrade, no deadline, no expiry after auth.
- **Per-socket frame processing is serialized** by a promise chain so `subscribe` completes before a following `post` (tested).
- **Post path** does channel authorization, idempotent insert, availability notices, evidence decisions, task negotiation, notifications — inside the Relay.
- **Snapshots**: no cursor = "baseline" (0 messages + newest cursor); with a cursor = up to 100 rows after `(created_at,id)`, trimmed to ~7.5 KiB, and `snapshot.cursor` (not `payload.cursor`) is what clients store.
- **Internal HTTP**: `/healthz`, `GET /internal/pty-session/:id`, `POST /internal/publish` (bearer = the token signing secret).
- **Heartbeat**: server `ws.ping()` every 30 s, terminate on missed pong; the Node client also pings; browsers only auto-pong.

Full detail with file:line references: the inventory report (kept beside this doc for the implementation phase).

---

## 3. Verified Cloudflare facts this design relies on

| Fact | Value | Design consequence |
|---|---|---|
| Hibernation API connections per DO | 32,768 max | Far above any workspace; not a constraint. |
| Per-DO request rate | soft limit 1,000 req/s (incoming HTTP **and WebSocket messages** count as requests for billing) | Chat is fine; PTY output must be coalesced (4.3). |
| CPU per invocation | 30 s default (configurable to 5 min); each incoming message resets it | Snapshot/persist work goes to the web Worker, not the Hub. |
| SQLite storage per DO / account | 10 GB / unlimited (paid) | Ample for ephemeral state + debounced PTY snapshots. |
| Received WebSocket message size | 32 MiB | Our 16 KiB frame cap is policy, not a platform limit — enforce it ourselves. |
| `serializeAttachment` size | 16,384 bytes per socket (docs). *The code comment in the inventory says 2 KiB — treat 2 KiB as the safe assumption until spike S1 confirms.* | Keep per-socket attachments tiny; keep subscription sets compact. |
| Tags per socket | ≤10, ≤256 chars each | Cannot tag a socket with every room; iterate + filter instead. |
| Hibernation | in-memory state is **reset**; `setTimeout`/`setInterval`/alarms/requests **prevent** hibernation | No timers. Rebuild state from attachments on wake. |
| Protocol ping/pong | handled automatically by the runtime **without waking** the DO | Client→server protocol pings are free. A DO cannot *send* protocol pings (the container Relay's 30 s server ping has no equivalent). |
| Deploys | "Code updates disconnect all WebSockets"; every DO restarts | Reconnect storm on each release; clients need jittered backoff (section 8). |
| Alarms | single alarm per DO; must be re-armed; avoid short intervals | One low-frequency sweep alarm, only while sockets exist. |
| Compat flag `web_socket_auto_reply_to_close` | default on for compatibility dates ≥ 2026-04-07 | The new Worker uses a recent compat date (today's Relay uses 2024-12-01). |
| Pricing (paid) | $0.15/M requests (1M incl.); duration $12.50/M GB-s (400k incl.), billed only while active/not hibernatable; incoming WS messages at **20:1** for duration; SQLite rows written $1.00/M (50M incl.), read $0.001/M, storage $0.20/GB-mo (5 GB incl.) | Chat traffic costs pennies; **row writes must be batched** (PTY scrollback). Cloudflare's own example (100 DOs × 100 hibernating sockets, 1 msg/min) is $20.65/month. |
| Classes per account | 500 | Not a constraint. |

---

## 4. Architecture

### 4.1 Components

```
Browser / Node client / CLI
        │  wss://relay.<domain>/v2/<workspaceId>      (v1 frames unchanged)
        ▼
┌────────────────────────────┐   HTTP   ┌──────────────────────────────┐
│ relay-gateway (Worker)     │◄────────►│ web app (Next on OpenNext)   │
│  • upgrade routing         │  service │  • auth: agent-token lookup  │
│  • connection admission    │  binding │  • snapshot / post / mission │
│  • /healthz, /internal/*   │          │  • evidence, tasks, notices  │
└─────────────┬──────────────┘          │  • Supabase (service role)   │
              │ idFromName(workspaceId) └──────────────────────────────┘
              ▼                                        ▲
┌────────────────────────────┐   service binding (RPC) │
│ WorkspaceHub (Durable Obj) │─────────────────────────┘
│  • sockets (Hibernation API)
│  • rooms/subscriptions, fan-out, recipient filtering
│  • presence, typing, huddle signaling
│  • PTY registry + scrollback, fs.* routing
│  • policy: auth deadline, limits, expiry, revocation
└────────────────────────────┘
```

- **relay-gateway (Worker).** Terminates the upgrade, validates the path, applies edge admission (per-IP upgrade rate, origin allow-list for browsers), and forwards to `env.HUB.get(env.HUB.idFromName(workspaceId))`. Also serves `/healthz` (checks a DO round trip) and forwards authenticated `/internal/*` to the right DO.
- **WorkspaceHub (DO class, SQLite-backed).** One instance per workspace. Owns transport and ephemeral state only.
- **Web app (existing).** Gains a small set of **internal RPC endpoints**, callable only over the service binding with an internal secret (section 4.4). It already contains every function the Relay needs.

### 4.2 Why a DO per workspace (topology options)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. One DO per workspace** | Natural shard key; all workspace-scope fan-out, PTY linking, presence local; simplest correctness | A very hot workspace concentrates load on one object | **Recommended** |
| B. One DO per channel | Smaller blast radius | `publishWorkspace` (agent activity to all channels), PTY linking across rooms, and workspace-wide presence all become cross-DO; more moving parts | Rejected |
| C. Workspace coordinator + per-channel DOs | Scales a mega-workspace | Highest complexity; needed only far beyond current scale | Revisit only if a workspace outgrows A |
| D. Single global DO | Trivial | Recreates today's single-instance ceiling | Rejected |

The 1,000 req/s soft limit is the only real pressure on A. It is addressed by design in 4.3, and metrics (section 9, spike S4) decide whether the optional PTY split is ever needed.

### 4.3 State model — what lives where

The rule: **the DO's memory is a cache that can vanish at any time.** Everything must be reconstructible from (a) socket attachments, (b) SQLite, or (c) Supabase.

| State | Today | New home | Rebuild on wake |
|---|---|---|---|
| Connection identity (principal kind/id, workspace, connId, auth expiry) | `connections` map | **Socket attachment** (small JSON) | `getWebSockets()` → `deserializeAttachment()` |
| Subscriptions (room keys per socket) | `subscriptions` registry + mailboxes | Attachment (compact array); in-memory index rebuilt lazily | scan attachments once per wake |
| Presence | `presence` map, no expiry | **Derived from live sockets**: each socket's attachment carries its last presence state | scan attachments — a vanished client disappears with its socket (fixes stale "online") |
| Typing | `typing` map with `expiresAt` | Attachment or memory; expiry is data (`expiresAt`), as today | drop expired on read |
| Huddle membership | `huddles` map | Attachment (per socket) | scan |
| PTY session registry (owner conn, cols/rows, shared, links) | `ptySessions` map | **SQLite table** + owner conn id in the owner socket's attachment | read table; drop sessions whose owner socket is gone (grace, 4.5) |
| PTY scrollback (≤64 KiB/session) | in-memory ring | Memory ring + **debounced** SQLite snapshot (≤1 write/s/session, only when changed) | load last snapshot |
| Per-connection rate-limit buckets | `cursorRateLimiter` | Memory only (a reset on wake is harmless) | — |
| Messages, reactions, notifications, cursors, tokens | Supabase | Supabase (unchanged) | — |

**PTY throughput.** Every `pty.output` frame is a request to the DO. To stay well inside 1,000 req/s and keep row writes cheap: (1) the bridge coalesces output to at most 20 frames/s per session (16 KiB max per frame, subject to the client-side 8 KiB payload rule — see Appendix C #11), (2) the Hub batches scrollback persistence to ≤1 write/s/session, (3) `pty.input` from a human viewer never triggers a database lookup (ownership is resolved once and cached in the attachment; today it costs a Supabase query *per keystroke frame*). If soak testing (S4) shows hot workspaces still approaching the limit, split terminals into a second DO class keyed `workspaceId:ptySessionId`, reached through the same gateway; the wire protocol does not change.

### 4.4 Business logic stays in the web app — the RPC boundary

The Hub never talks to Supabase directly. It calls these internal endpoints on the web Worker over a service binding (no public network hop; authenticated with `RELAY_INTERNAL_SECRET`, distinct from the token signing secret):

| RPC | Replaces (today, in `mission-relay-production.ts`) | Returns |
|---|---|---|
| `authenticateAgent(rawToken, workspaceId)` | `authenticateAgent` (pulls `next/headers`, Node crypto; **writes `last_seen_at` every connect**) | `{connectionId}`; throttles the `last_seen` write |
| `authorizeChannel(principal, workspaceId, channelId)` | `authorizeWorkspaceChannel` | `{ok, isDm, participantIds}`; **result cached in the socket attachment for 60 s** |
| `workspaceSnapshot(principal, workspaceId, channelId, cursor)` | `loadWorkspaceSnapshot` + `buildBoundedWorkspaceSnapshot` | the bounded snapshot exactly as today |
| `postWorkspaceMessage(principal, frame)` | `postWorkspaceMessage` (validation, idempotent insert, availability notice, evidence, tasks, notifications) | `{message, messages[], activity[], cursor, idempotentReplay?}` |
| `recordTiming(event)` | `workspace.timing` upsert | `{}` |
| `bridgeHeartbeat(...)` | `bridge.heartbeat` | `{}` |
| `missionSnapshot / postMissionMessage / ack` | mission scope | as today (**deferred**, section 12 D-R7) |
| `resolvePtyOwnerHuman(agentConnectionId)` | per-frame Supabase lookup | `{userId}`, cached |

Consequences: one implementation of the post rules (the duplicated availability logic between the HTTP path and the Relay path collapses into one), no Node-only dependency in the Hub, and the Hub's failure surface is small. Cost: one extra service-binding hop on `post` and `subscribe` (measured in spike S2; service bindings are same-colo and cheap).

### 4.5 Connection lifecycle and policy (new — none of this exists today)

1. **Upgrade** — gateway validates `/v2/<workspaceId>` (UUID shape), origin (browsers), per-IP rate; forwards to the Hub; Hub accepts with `ctx.acceptWebSocket(server)` and stores an attachment `{connId, authDeadline: now+5s, principal: null}`.
2. **Auth deadline** — 5 s to send `auth.*`; otherwise close `4001`. (Today an unauthenticated socket lives forever.)
3. **Auth** — signed token verified with WebCrypto HMAC (byte-identical format; parity-tested against the Node implementation, S6). Raw agent token → `authenticateAgent` RPC. On success reply `relay.ready` exactly as today; on failure reply `relay.error request_failed` and keep the socket (preserves the client contract), then close after a second failure (new).
4. **Limits** — max sockets per workspace (default 2,000) and per principal (default 20); token bucket per connection over *all* inbound frames (default sustained 60/s, burst 120; the PTY owner's output and `presence.cursor` have their own buckets). Excess → `relay.error rate_limited` then close `4008` on sustained abuse.
5. **Session expiry** — attachment stores `sessionExpiresAt = min(token exp + 10 min, now + 60 min)`. Checked on every message and by one sweep alarm every 5 min while sockets exist. On expiry: `relay.error session_expired` + close `4002`. Clients already fetch a fresh credential on reconnect. (Today a 5-minute token yields an unbounded session.)
6. **Revocation** — `POST /internal/revoke {workspaceId, principalId|connectionId}` (called by the web app when an agent is disconnected, a member is removed, or an agent token is rotated) closes matching sockets with `4003`. This is the server half of the OpenCode-disconnect fix.
7. **Owner-disconnect grace for PTY** — a PTY session whose owner socket drops stays `reconnecting` for 20 s; if the same principal re-`pty.open`s the same `sessionId` it resumes (scrollback intact); otherwise it exits with `host_disconnected`. (Today the session dies instantly, so any network blip ends the terminal.)
8. **Close** — clean up subscriptions/presence/typing/huddles/PTY exactly as today (offline presence, typing-stop, `pty exited host_disconnected`), all derived from the closing socket's attachment.

### 4.6 Heartbeat and liveness

- Client→server **protocol pings are answered by the runtime without waking the DO**, so the Node client's existing 30 s `ws.ping()` keeps working unchanged.
- A DO **cannot originate protocol pings**, and browsers do not send them. New clients therefore send an **application-level text `ping`** every 30 s, answered by `setWebSocketAutoResponse` (also free, no wake). Old clients (published CLIs) that only wait for server pings will simply rely on TCP/edge closure and their own reconnect logic — acceptable because old clients stay on the container Relay (section 7).
- Dead-peer detection for browsers becomes client-driven (no pong within 10 s → close and reconnect), which is strictly better than today's "no app-level heartbeat from the browser".

### 4.7 Fan-out and ordering

- **Per-socket serialization is mandatory** (subscribe must finish before a following post). In a DO, message handlers interleave at `await`s, so each socket gets a promise chain kept in memory; on hibernation wake the chain is empty, which is safe because nothing is in flight.
- **Fan-out** iterates the in-memory subscription index (built from attachments). Recipient-aware filtering rules are ported unchanged (recipient set → the recipient principal's sockets **plus the sender's socket**); the inventory's open question about other tabs of the same human is D-R6.
- **Backpressure.** The current implementation's 128-frame mailboxes are dead code (`socket.send` is synchronous). Workers WebSockets expose no `bufferedAmount` [VERIFY, S3]; the design therefore uses *policy*, not queues: droppable classes (`presence.cursor`, `participant.typing`, PTY output for a slow viewer) are shed under load, non-droppable classes (`workspace.event`) are never dropped, and a socket whose send throws is closed so the client resubscribes by cursor.
- **Outbound size** is checked (≤8 KiB payload / 16 KiB frame) before send, because clients reject larger frames; oversize server frames are logged and replaced by a `relay.error message_too_large`.

---

## 5. Frame-by-frame ownership (Hub vs web app)

| Frame(s) | Handled in | Notes |
|---|---|---|
| `auth.browser`, `auth.bridge` | Hub (+ RPC for raw agent tokens) | Signed tokens verified locally (WebCrypto). |
| `workspace.subscribe` / `unsubscribe` | Hub + RPC `authorizeChannel`, `workspaceSnapshot` | Registers the subscription **after** the snapshot is sent, as today. |
| `workspace.post` | Hub → RPC `postWorkspaceMessage` → Hub fans out | Confirmation `workspace.event` to the sender always, correlationId preserved; extra events for `messages[]` use the `workspace-side-effect:` correlation. |
| `workspace.timing`, `bridge.heartbeat` | Hub → RPC | Never fanned out. |
| `workspace.step/turn/todos/queued` | Hub only | Bridge-only for turn/todos/queued; plain broadcast. |
| `participant.presence`, `participant.typing`, `presence.cursor` | Hub only | Presence in attachments; cursor rate-limited and never replayed. |
| `runtime.event` | Hub → RPC (journal/normalize) → Hub publishes | The workspace-wide `activity` fan-out is **channel-scoped in v2** (Appendix C #6). |
| `runtime.session_state`, `git.operation_result` | Hub, **bridge-only, validated** | Today relayed verbatim from any principal. |
| `runtime.permission_response` | **Removed** unless a producer is defined | Silent no-op today. |
| `huddle.*` | Hub only | Requires mission subscription today — see D-R7. |
| `pty.*`, `fs.*` | Hub only | Registry in SQLite, owner in attachment, scrollback debounced. |
| `mission.subscribe/unsubscribe`, `message.post/acknowledge`, `cursor.resume` | Hub + RPC | **Deferred** (D-R7). |
| `/internal/publish`, `/internal/pty-session/:id`, `/internal/restart`→`/internal/revoke` | Gateway → Hub | Same status codes and JSON shapes; bearer = `RELAY_INTERNAL_SECRET`. |
| Five declared-but-unproduced server types | Dropped from v2 | `message.delivery_command/state`, `runtime.permission_request`, `git.operation_command`, server `runtime.session_state`. |

---

## 6. Compatibility contract (must not change)

1. Envelope and limits: `oathlock.relay.v1`, 8 KiB payload / 16 KiB frame, enforced inbound **and** outbound.
2. First-frame auth, `relay.ready {principalKind, principalId}`; any `relay.error` before `relay.ready` fails a Node-client connect; `request_failed` for bad credentials without closing.
3. Confirmation: `workspace.event` echoing the post's `correlationId`, sent to the sender even when recipient-filtered; clients resolve FIFO per correlationId; side-effect events use a distinct correlation.
4. Cursor: `workspace-cursor.v1:` + base64url JSON `{createdAt,messageId}` (legacy ISO accepted); clients store `snapshot.cursor` (not the echoed `payload.cursor`) and never let `cursor:null` from internal publishes clobber it; baseline (no cursor) returns 0 messages + newest cursor.
5. Ordering: subscribe completes (snapshot sent) before the next frame on that socket is processed; replay order after subscribe is presence → typing → PTY `state` then scrollback.
6. Error codes listed in inventory §12 (`invalid_frame … subscriber_backpressure`) keep their names and semantics; new codes are additive (`session_expired`, `rate_limited`, `message_too_large`, `auth_timeout`).
7. `/internal/*` status codes and body shapes (inventory §6), including `pty.handoff {sessionId,fromConnectionId,fromLabel,text,reason,handoffId}`.
8. Close-code handling: clients treat any close as reconnect except an intentional close; new server close codes are in the 4000–4999 range and clients must reconnect on all of them except explicit "do not retry" (`4003` revoked → reauthenticate before retry).

**Deliberate v2 changes** (all additive or behind the new URL): the workspace path in the URL; auth deadline; connection and rate limits; session expiry and revocation; PTY owner grace; channel-scoped activity; validated `runtime.session_state`/`git.operation_result`; jittered reconnect and an app-level ping in new clients.

---

## 7. Migration and cutover plan (no big bang, instant rollback)

**Rule:** the container Relay keeps running unchanged the whole time. Nothing here modifies it except adding `/internal/revoke` parity if needed.

| Phase | Work | Exit gate |
|---|---|---|
| **P0 — Approve & spike** | This document approved; spikes S1–S6 (section 9) complete; baseline latency/throughput captured from the container Relay | Written spike results; decisions D-R1…D-R7 locked |
| **P1 — Shared, isomorphic core** | Extract the pure modules used by both runtimes (protocol, frame validation, cursor codec, PTY/fs protocols, recipient-visibility, snapshot bounding) with no Node-only APIs (`Buffer`→`TextEncoder`/`atob`, HMAC via WebCrypto behind an interface). Build the **transport adapter** so the existing contract tests can drive either implementation | All existing relay tests green on the *current* implementation through the adapter |
| **P2 — Workspace scope** | Gateway + Hub: auth, subscribe/snapshot, post (via RPC), presence/typing/cursor, step/turn/todos/queued, timing, heartbeat, internal publish, policy (deadline, limits, expiry, revocation). Web app RPC endpoints. Deployed as a **separate Worker** (`m9r-relay-v2`) | Contract tests green against the Hub; parity soak (below) |
| **P3 — PTY/fs/huddles** | PTY registry, scrollback, ownership, linking, grace; fs routing; huddle signaling | PTY soak at target frame rates; terminal works end-to-end from the browser |
| **P4 — Client changes** | Browser client + Node client + CLI: build `/v2/<workspaceId>` URL from a per-workspace `relayUrl`, jittered backoff, app-level ping, handle new close codes; publish CLI | Old CLIs still connect to the container Relay unchanged |
| **P5 — Dual-run parity** | For a test workspace, run both Relays; a synthetic bridge and browser send identical traffic to each; compare delivered frames, ordering, confirmations, cursors. Then shadow real staging traffic | Zero diffs over a soak |
| **P6 — Per-workspace cutover** | A Supabase column `workspace_relay_backend` (`container`\|`do`, default `container`) drives the `relayUrl` returned by `/api/missions/relay-token` and `whoami`. Flip one internal workspace, then more. **Rollback = flip the flag back** (clients reconnect to the container Relay within seconds; durable data is shared, so nothing is lost) | Acceptance matrix passes on `do` workspaces for ≥ 1 week |
| **P7 — Retire** | Default new workspaces to `do`; remove the container Relay after every active workspace has moved and old CLI versions are below an agreed floor | — |

**Legacy CLI window.** Published CLIs (0.6.x) connect to the bare root URL. The container Relay keeps serving that URL until the legacy floor is retired, so no user is stranded.

---

## 8. Reconnect storms and deploys

Because every deploy disconnects every socket and restarts every DO:
- **Client side (P4):** exponential backoff **with full jitter** (today: Node `[250,1000,3000,10000,30000]` ms, browser `500·2ⁿ` ms, both without jitter, so a restart produces synchronized reconnects).
- **Server side:** the gateway sheds excess upgrades with `503 Retry-After` during a storm; each Hub's first `auth` is cheap (signed token) — only raw agent tokens hit the RPC, and those are cached for 30 s per token hash.
- **Release discipline:** Hub deploys are batched, announced in the release notes, and avoided in working hours once real users exist; gradual rollouts are used where the platform offers them.
- **Cursor resume already makes reconnects lossless**, which is why the storm is a latency event, not a correctness one. It is tested explicitly (section 9).

---

## 9. Verification plan

### 9.1 Spikes (run in P0, one day each, before any build)

| # | Question | Method | Decides |
|---|---|---|---|
| S1 | Real `serializeAttachment` limit; rebuild of subscriptions/presence from attachments after forced hibernation and eviction | Minimal Hub with 500 sockets; force hibernate; measure rebuild time and correctness | Attachment schema (4.3) |
| S2 | Hub→web service-binding latency and failure modes for `postWorkspaceMessage` and `workspaceSnapshot` | Deploy stub RPC endpoints; measure p50/p95 from Hub | Confirms the "business logic stays in web" design (4.4) |
| S3 | WebSocket send backpressure in DOs (no `bufferedAmount`?) and behavior with a stalled consumer | Slow-reader client against a Hub broadcasting at 500 msg/s | Backpressure policy (4.7) |
| S4 | PTY throughput vs the 1,000 req/s soft limit; effect of coalescing; row-write cost of debounced scrollback | Synthetic `cat /dev/urandom`-style output through a Hub with N viewers | Whether the PTY-DO split is ever needed |
| S5 | Deploy behavior: exact disconnect/restart semantics and time-to-recover with 1,000 sockets | Deploy while connected; measure reconnect distribution with/without jitter | Backoff constants (section 8) |
| S6 | WebCrypto HMAC token verification parity with `mission-relay-token.ts` (byte-identical accept/reject, including clock-skew rules) | Property test with random valid/invalid tokens against both | Safe swap of token verification |

### 9.2 Test suites

1. **Ported contract tests** (the list in inventory §12/§13) run through the transport adapter against both implementations.
2. **New behavior tests:** auth deadline; connection and per-principal limits; rate limiting; session expiry and re-auth; revocation (agent disconnect closes its socket within 1 s); PTY owner grace and resume; presence derived from sockets (no stale "online"); outbound size enforcement; channel-scoped activity; validated `runtime.session_state`.
3. **Chaos:** forced hibernation between every step of the scenario; DO eviction mid-post; Supabase RPC 500s and timeouts (post must return a clean error, never a duplicate); reconnect storm at 1,000 sockets.
4. **Load targets (initial, to be revised from baseline):** 50 workspaces × 20 sockets, 10 posts/s aggregate, 5 active terminals at 20 frames/s; p95 post→fan-out ≤ baseline; zero lost/duplicated messages; Hub CPU well under limits.

### 9.3 Observability and operations
- Structured logs per frame class (counts, sizes, latencies, no message bodies), DO metrics, and error-rate alerts on `request_failed`, RPC failures, and reconnect spikes. **Unlike the container Relay, these are visible from the Cloudflare dashboard and CLI** (today container stdout is not).
- Separate secrets: `MISSION_RELAY_TOKEN_SECRET` (signs tokens) vs `RELAY_INTERNAL_SECRET` (service binding + `/internal/*`). Rotating either creates a new Worker version (all sockets reconnect) — no special restart route is needed, which retires `/internal/restart`.
- Runbooks: rollback flag flip, revoke-all for a workspace, drain a Hub, read a Hub's state via SQLite Data Studio.

---

## 10. Cost and effort

**Cost (estimate, not a quote).** Chat traffic is negligible at current scale: Cloudflare's own example of 100 DOs × 100 hibernating sockets with one message a minute is ~$20/month. The two things that move the number are PTY output volume (mitigated by coalescing) and SQLite row writes (mitigated by ≤1 write/s/session batching; unbatched a hot terminal would cost several dollars per day in row writes alone). The container Relay costs a fixed instance around the clock; the DO Relay costs roughly nothing when idle. A precise model comes out of spike S4.

**Effort (rough, one engineer).**

| Phase | Estimate |
|---|---|
| P0 spikes + approvals | 3–4 days |
| P1 shared core + adapter | 4–5 days |
| P2 workspace scope + RPC | 7–8 days |
| P3 PTY/fs/huddles | 6–7 days |
| P4 clients + CLI | 3–4 days |
| P5 parity + soak | 5–7 days |
| P6 cutover + monitoring | ongoing, 1–2 weeks elapsed |
| **Total** | **~5–6 weeks** |

**Sequencing vs Stage 0.** This does not gate Stage 0. Stage 0's remaining Relay items (reconnect-from-cursor proof, log review, soak) continue on the container Relay; the parity harness built in P1 also *improves* that testing.

---

## 11. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Every deploy disconnects all sockets | High (recurring) | Jittered backoff, upgrade shedding, release discipline, lossless cursor resume (section 8, spike S5) |
| PTY throughput vs 1,000 req/s soft limit | Medium | Output coalescing, batched persistence, optional PTY DO split (4.3, S4) |
| Hibernation drops in-memory state | High if missed | Design rule: memory is a cache; attachments/SQLite/Supabase are truth; chaos tests force hibernation between every step (S1, 9.2) |
| Client URL contract change strands old CLIs | Medium | Container Relay stays live until a legacy floor; per-workspace flag; instant rollback (section 7) |
| Business-logic RPC adds latency/failure modes | Medium | Service bindings (same colo); 60 s authorization cache; clean error mapping; S2 measures it |
| Scope creep into Stage 1 protocol | Medium | Non-goal; v1 frames only; adapter boundary keeps spec objects addable later |
| Rewrite collides with Stage 0 focus | Medium | Separate Worker, separate repo path, no changes to the container Relay; explicit go/no-go at P0 |
| Two Relays to keep correct during the window | Medium | Shared isomorphic core + one contract test suite over both |

---

## 12. Decisions needed from the founder

| # | Decision | Recommended | Why / trade-off |
|---|---|---|---|
| **D-R1** | Topology | **One Hub DO per workspace** (option A), PTY split only if S4 demands | Simplest correct shard; matches every frame's `workspaceId` |
| **D-R2** | Where business logic lives | **Stays in the web app**, called over a service binding | Avoids porting Node-only code and removes the duplicated availability logic; costs one cheap hop |
| **D-R3** | URL contract and legacy window | `wss://…/v2/<workspaceId>`; container Relay serves the old URL until a legacy floor is agreed | A DO must be chosen at upgrade time; no user is broken |
| **D-R4** | PTY scrollback persistence | Memory + **debounced** SQLite snapshot (≤1 write/s/session), owner-disconnect grace 20 s | Terminals survive a blip and a DO eviction without paying per-frame row writes |
| **D-R5** | Session lifetime / re-auth | Cap sockets at 60 min or token exp + 10 min, whichever is sooner; explicit revoke endpoint | Closes the "token checked only at connect" gap; pairs with the disconnect fix |
| **D-R6** | Human access model on the new Relay | Use **workspace membership** (the `workspace_members` table) instead of owner-only, and deliver DMs to *all* of the sender's sockets | The current owner-only check and the "second tab misses DMs" behavior look like bugs; needs your call because it changes who can connect |
| **D-R7** | Scope of v2 launch | **Workspace scope + PTY/fs first; defer `mission.*`, `message.post`, huddles** until usage data shows they matter | Mission-scope is the least-read and heaviest-to-port part; huddles depend on it |

### Decisions locked (2026-09-19)

| # | Locked value | Note |
|---|---|---|
| D-R1 | **One Hub DO per workspace**; PTY split only if spike S4 demands | as recommended |
| D-R2 | **Business logic stays in the web app** (service binding) | as recommended; no extra request fee (service-binding calls are not billed as separate requests; CPU time across both Workers is) |
| D-R3 | **`/v2/<workspaceId>` URL; the container Relay keeps serving the bare URL for older CLIs until a cut-off date the founder sets** | applied as the default because it is already running (no new spend); can be changed at any time. Running cost of that container ≈ $30-55/month on Cloudflare (Containers price sheet: 4 GiB memory, 1/2 vCPU, 8 GB disk for `standard-1`) |
| D-R4 | **20 s owner grace + scrollback saved at most once per second per session** | ~$0 at current scale (vs ~$800/month at 100 busy terminals if every frame were saved) |
| D-R5 | **60-minute socket cap (or token exp + 10 min) + revoke-on-disconnect** | as recommended |
| D-R6 | **Any workspace member may connect as a human** (via `workspace_members`); DMs reach all of the sender's open tabs | changes who can connect; requires the RPC authorization to use membership |
| D-R7 | **v2 launches with workspace chat + PTY/fs; `mission.*`, `message.post`, huddles deferred** | until usage data shows they matter |

**Billing note (verified 2026-09-19):** the startup credit is Active ($10,000, program start Sep 16, 2026, expires Sep 16, 2027). Per the program email, **Durable Objects and Workers are covered by credits; Containers are not listed**, so the container Relay's ~$27-53/month (`standard-1`) should be treated as billable. This is a further reason for D9: the DO Relay runs entirely on credit-covered products and lets the container be switched off after the legacy window. Keep the legacy container only as long as older CLIs need it.

**On approval I will:** (1) run the six spikes and report real numbers before writing any Hub code; (2) update spec sections 15 and 26 with the locked decisions; (3) only then start P1.

---

## Appendix A — State and lifecycle map (today → new)

| Concern | Today | New |
|---|---|---|
| Process model | 1 container, 1 Node process | 1 Hub DO per workspace + gateway Worker |
| Socket lib | `ws` | Hibernation API (`acceptWebSocket`) |
| Dead-peer detection | server `ws.ping()` 30 s | client app-level ping + runtime-handled protocol pings |
| Auth | first frame, never expires | first frame + 5 s deadline + expiry + revocation |
| Presence | map, no TTL, last-conn-wins | derived from live sockets |
| PTY | memory, dies with process/owner socket | SQLite registry + debounced scrollback + owner grace |
| DB access | in-process supabase-js | RPC to web app over service binding |
| Secrets | one secret = signing key = internal bearer | two secrets, separated |
| Restart | container destroy route | Worker version deploy (sockets reconnect) |

## Appendix B — Isomorphic modules to extract in P1
`mission-relay-protocol` (validation), `workspace-cursor` (replace `Buffer` base64url), `mission-pty-protocol`, `mission-fs-protocol`, recipient-visibility helper, `workspace-relay-snapshot` (bounding), `mission-relay-token` (behind a crypto interface with Node and WebCrypto implementations; **token format must stay byte-identical** because the Next app mints tokens in Node).

## Appendix C — Defects from the inventory that v2 must not port
1. Backpressure is dead code (sync `send`). 2. No auth timeout, connection cap, or rate limits. 3. Tokens checked only at connect. 4. Owner-only human access. 5. `runtime.session_state`/`git.operation_result` relayed from any principal; presence/step/turn/todos need no channel membership. 6. Workspace-wide activity leak across channels/private DMs. 7. DMs hidden from the sender's other tabs. 8. Presence keyed by participant with stale "online". 9. Huddle SDP cap (16,000) contradicts payload cap (8,192). 10. PTY replay seq can go negative; scrollback trimmed mid-escape; O(n) session lookup; resize allowed for any viewer; per-keystroke Supabase lookup; instant session death. 11. Oversized outbound frames (mission snapshot, `/internal/publish`) silently break clients. 12. `runtime.permission_response` no-op; five dead server frame types. 13. Business logic embedded in the transport. 14. Confusing `payload.cursor` echo (clients depend on it — preserve, document). 15. Unbounded reactions query per subscribe. 16. `:` vs `\0` registry key inconsistency. 17. One secret for signing and internal bearer. 18. Auth failure closes nothing and returns generic `request_failed` (client contract — preserve, add a second-failure close). 19. `/internal/publish` returns ok with zero recipients and no delivery info. 20. `workspace.post` publishes even if the sender unsubscribed.

## Appendix D — Cloudflare documentation used (accessed 2026-09-19)
- Durable Objects state / `acceptWebSocket` (32,768 sockets, ≤10 tags): developers.cloudflare.com/durable-objects/api/state/
- WebSocket Hibernation rules (attachment 16,384 B, timers prevent hibernation, deploys disconnect sockets, auto ping/pong): developers.cloudflare.com/durable-objects/best-practices/websockets/
- Limits (1,000 req/s soft, CPU, storage, 32 MiB message): developers.cloudflare.com/durable-objects/platform/limits/
- Pricing (requests, duration, 20:1 WS ratio, SQLite rows/storage, worked example): developers.cloudflare.com/durable-objects/platform/pricing/
- Rules of Durable Objects (alarms, close handling, `web_socket_auto_reply_to_close` ≥ 2026-04-07): developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/

## Appendix E — What I did not verify
- Exact `bufferedAmount`/backpressure behavior of DO WebSockets (S3); the real attachment size (S1); service-binding latency (S2); PTY soak numbers (S4); deploy recovery distribution (S5); WebCrypto token parity (S6).
- The `mission.*` internals, `mission-pty-runtime`, `owner-fs-runtime`, and the exact assertions of `scripts/mission-relay.test.ts` were skimmed, not read line by line (they are inside D-R7's deferred scope or covered by the contract-test port).
- Whether workspace membership (`workspace_members`) is the intended human-access model everywhere (D-R6).
