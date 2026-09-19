# Mission Relay inventory (for DO rewrite)

Legend: [C] confirmed by reading; [I] inferred. Paths relative to C:\RunLeak\runleak. Abbrevs: SVC = src/lib/mission/mission-relay-service.ts, SRV = services/mission-relay/src/server.ts, PROD = src/lib/mission/mission-relay-production.ts, REG = mission-relay-subscriptions.ts, PROTO = mission-relay-protocol.ts.

Scope note: I read service/server/production/protocol/token/auth/subs/pty-protocol/cursor/snapshot fully, the Node client (mission-relay-client.ts) and browser client in the handshake/reconnect/heartbeat regions, and test names + the two server tests. I did NOT read all of mission-relay-client.ts's frame builders, mission-application-service.ts internals (mission-scope reads), mission-pty-runtime/host, owner-fs-runtime, or scripts/mission-relay.test.ts assertions line by line. The `mission.*` scope is thus lighter than the `workspace.*` scope.

---
## 0. Envelope (all frames) [C] PROTO:1-200
- `RelayFrame`: `{version:"oathlock.relay.v1", frameId(<=128), type(<=128, must be in client∪server list), workspaceId(<=256), missionId?(<=256), channelId?(<=256), correlationId(<=256), causationId?(null|<=256), idempotencyKey?(null|<=256), sentAt(<=64), payload(required key)}`.
- Limits: `MISSION_RELAY_MAX_PAYLOAD_BYTES=8192` (JSON.stringify(payload) UTF-8 bytes), `MISSION_RELAY_MAX_FRAME_BYTES=16384` (whole frame). Enforced by `parseRelayFrame` AFTER JSON.parse (no transport-level cap; `ws` default maxPayload is 100 MiB) [C].
- IMPORTANT: clients also run `parseRelayFrame` on INBOUND frames (mission-relay-client.ts:~411, browser client:~503) and treat a failure as an error. So server->client frames MUST also be <=8 KiB payload / 16 KiB frame or clients reject them. Server does not check its own outbound size except re-parsing `runtime.event` [C].
- Non-JSON message -> payload `null` -> `relay.error{code:"invalid_frame"}` with `workspaceId:"unknown"` (SRV:122-128, SVC receive) [C].
- Server replies use `serverFrame(source,type,payload)` (SVC ~1180): `frameId="relay-"+source.frameId`, copies source workspaceId/missionId/channelId/correlationId, `causationId=source.frameId`, `idempotencyKey=null`, fresh `sentAt`. Clients match confirmations on `correlationId` [C].
- Errors: `relay.error` payload `{code,message}` (+`retryable:true` only for backpressure), frameId `error-<source.frameId>` [C].

---
## 1. Frame types

### 1a. Client -> server (RELAY_CLIENT_FRAME_TYPES, PROTO:5-59). Handler = SVC.handleAuthenticated unless noted.
Pre-auth rule: anything other than auth.* before auth -> `relay.error unauthenticated`. Every authed frame first checks `principal.workspaceIds.includes(frame.workspaceId)` else `workspace_forbidden` (SVC receive) [C].

| type | sender | payload | requires | effect / reply |
|---|---|---|---|---|
| auth.browser | browser | `{credential}` (signed human token) | none | authenticate; reply `relay.ready{principalKind,principalId}`. 2nd auth -> `already_authenticated`. Any auth failure surfaces as `relay.error code:"request_failed" message:"Relay credential is invalid or expired."` (thrown inside try) — socket NOT closed [C] |
| auth.bridge | bridge/CLI | `{credential}` (signed bridge token OR raw agent token) | none | same |
| workspace.subscribe | any | `{cursor?:string|null}`; needs `channelId` | authed | `channel_required`/`workspace_unavailable` errors; calls loadWorkspaceSnapshot (Supabase authz + snapshot) THEN registers subscription (scope "workspace", key ws:channel) THEN sends `workspace.snapshot{cursor(echo of request), snapshot}` THEN ephemeral replay (presence, typing, pty state+scrollback). Subscribe is idempotent per (conn,room): re-subscribe closes old mailbox and replaces [C] |
| workspace.unsubscribe | any | – | channelId | unsub, clears presence/typing/pty owned by this conn in the room (publishes offline/typing-stop/pty exited host_disconnected) [C] |
| workspace.post | human or bridge | `{kind?:message|handoff|ack|result|notice, body(<=2000 after whitespace collapse), parentMessageId?, recipientConnectionId?, outcome?:ok|failed|incomplete}`; frame.idempotencyKey | channelId | durable insert (see §5), then publish `workspace.event(result)` to room with recipient filter + always to sender; plus one extra `workspace.event` per `result.messages[]` (availability notice) with correlationId `workspace-side-effect:<frameId>:<n>` [C]. NOTE: publish happens even if sender is no longer subscribed (no subscription check) [C] |
| workspace.timing | bridge only | `oathlock.workspace_timing.v1` event | bridge | upsert `workspace_turn_timing_events`; no fan-out, no reply on success [C] |
| workspace.step | human or bridge | free object | channelId/missionId | plain broadcast to room as `workspace.step` (no subscription needed by sender) [C] |
| workspace.turn / workspace.todos / workspace.queued | bridge only | free object | bridge | same broadcast; `bridge_required` else [C] |
| mission.subscribe | any | `{cursor}`; needs `missionId` | authed | loadMissionSnapshot (mission-application-service reads) -> subscribe scope "mission" -> `mission.snapshot{cursor,snapshot}` -> ephemeral replay [C] |
| mission.unsubscribe | any | – | missionId | as workspace.unsubscribe [C] |
| cursor.resume | any | `{cursor}`; needs missionId | authed | re-sends `mission.snapshot` (does NOT re-subscribe) [C] |
| message.post | any | mission message (`senderParticipantId, recipientParticipantIds|"mission_broadcast", messageType, body<=12000, evidenceRefs, structuredPayload...`) | missionId | postMissionMessage; fan-out `mission.event(result)` to mission room (no recipient filter) [C] |
| message.acknowledge | any | `{deliveryId}` | missionId | acknowledgeMissionMessageDelivery; no reply [C] |
| participant.presence | any | `{participantId (must == principal.id), state: online|working|idle|offline}` | room id | store in presence map, broadcast `participant.presence{participantId,state,updatedAt}` to room. Errors: `presence_identity_mismatch`, `presence_state_invalid`, `room_required`. No subscription check [C] |
| participant.typing | any | `{participantId(must==principal), typing:boolean, sessionId?<=128}` | room id | typing map entry expiresAt=now+2500ms; broadcast `participant.typing{participantId,typing,expiresAt,sessionId?}`. Errors `typing_identity_mismatch` [C] |
| presence.cursor | any | `{participantId==principal, sessionId(<=128), x,y in [0,1]}` | room id | token bucket 20 tokens, 20/s refill per CONNECTION; over-limit silently dropped; invalid silently dropped; pure fan-out `presence.cursor{participantId,sessionId,x,y}`, never replayed [C] |
| runtime.event | bridge only | `{executionId,participantId,assignmentId?,event:{type,eventId,adapterId,providerSessionRef?,timestamp,turnId?,payload{type}}}` | bridge, missionId | receiveRuntimeEvent normalizes+journals to Supabase, returns `{eventId,eventType,summary,activity}`; server re-parses safe frame; publishes `runtime.event` to mission room (if missionId) AND `workspace.event{activity}` to EVERY workspace-scope subscription in the workspace (publishWorkspace, no channel/recipient filter). Errors `bridge_required`, `runtime_sink_unavailable`, `runtime_event_rejected` [C] |
| runtime.session_state, git.operation_result | ANY principal | opaque | – | client frame relayed VERBATIM (original frameId, type) to mission room; no validation, no bridge check, no subscription check [C] (spoofable) |
| runtime.permission_response | any | opaque | – | forwarded to `receivePermissionResponse` option — NOT provided in production options -> silent no-op [C] |
| bridge.heartbeat | bridge only | `{protocolVersion==BRIDGE_PROTOCOL_VERSION, bridgeInstanceId, activeSessionIds[]}` | bridge | store.heartbeatInstance + touchSessions (first 8) in Supabase; errors thrown -> `request_failed` [C] |
| huddle.join/leave/mute/offer/answer/ice | any | `{huddleId(<=128), participantId(==principal), ...}`; need `missionId` AND conn subscribed to that mission (`mission_subscription_required`) | see §3 | join: sends existing members' `huddle.join` to joiner then broadcasts join to all members (only to huddle members, not room). leave/mute require membership on the SAME connection (`huddle_membership_required`). signals: strict allow-list of keys; offer/answer `description{type,sdp<=16000 chars}`; ice `candidate{candidate<=4096,sdpMid,sdpMLineIndex int>=0,usernameFragment}`; delivered point-to-point to target member's connection only; `huddle_target_not_found`, `huddle_signal_invalid`, `huddle_mute_invalid`, `huddle_identity_mismatch` [C]. SMELL: sdp<=16000 chars can never pass the 8192-byte payload cap |
| pty.open | bridge only | `{sessionId(<=128,no space), cols,rows in 1..1000, title?<=200}` | bridge + subscribed to room | register PtySessionRecord; broadcast `pty.state`. `pty_session_taken` if another live owner conn. Reopen by same/other after exit keeps linkedSessionIds, resets scrollback, shared=true [C] |
| pty.output | bridge only | `{sessionId,seq>=0 int,data:base64 <=4096 raw}` | bridge, owner conn, subscribed | append 64KiB scrollback, set lastSeq, broadcast `pty.output` (payload = parsed, identical). Errors `pty_session_not_found`,`pty_not_owner`,`pty_output_invalid` [C] |
| pty.input | any subscribed | `{sessionId,data:base64<=4096 raw}` | subscribed | delivered ONLY to owner connection as `pty.input{...,participantId:<principal.id>}`. If `!record.shared` and sender not owner -> `pty_not_shared` [C] |
| pty.resize | any subscribed | `{sessionId,cols,rows}` | subscribed | updates record cols/rows, forwarded ONLY to owner conn w/ participantId. NOTE any viewer may resize regardless of sharing [C] |
| pty.close | any subscribed | `{sessionId,reason?<=200}` | subscribed | owner conn: mark exited, delete, unlink peers, broadcast `pty.state` w/ reason. Non-owner: sends `pty.state{reason:"close_requested"}` to owner conn only [C] |
| pty.share | owner (bridge conn OR human who owns the agent connection per `resolvePtyOwnerHuman`) | `{sessionId,shared}` | subscribed | update, broadcast `pty.state` [C] |
| pty.request | human only | any | subscribed | broadcast `pty.requested{requestedByUserId}` to room (owner-pty-runtime self-filters) [C] |
| pty.link / pty.unlink | owner of FROM session | `{sessionId,targetSessionId}` | subscribed to own room; link also must be subscribed to target's room | symmetric add/remove in linkedSessionIds; publish `pty.state` to both rooms. Errors `pty_link_invalid`,`pty_session_not_found`,`pty_not_owner`,`pty_subscription_required` [C] |
| fs.tree.request / fs.read.request | human only | validated by mission-fs-protocol (requestId<=128, connectionId target, relative path<=1000 no `..`) | subscribed | broadcast to room; resident bridge self-filters by connectionId [C] |
| fs.tree / fs.content.chunk / fs.error | bridge only | opaque (no payload validation) | subscribed | re-broadcast to room [C] |

Client-list types that fall to `default` -> `unsupported_frame`: none besides server-only types. Server-only types received from a client (e.g. `relay.ready`, `pty.handoff`, `pty.state`, `workspace.snapshot`) -> `unsupported_frame` [C].

### 1b. Server -> client (RELAY_SERVER_FRAME_TYPES)
Actually produced: relay.ready, workspace.snapshot, workspace.event, mission.snapshot, mission.event, runtime.event, participant.presence, participant.typing, workspace.step/turn/todos/queued, relay.error, huddle.join/leave/mute/offer/answer/ice, pty.output/input/resize/state/requested, pty.handoff (ONLY via /internal/publish), fs.tree.request/fs.tree/fs.read.request/fs.content.chunk/fs.error, presence.cursor [C].
Declared but NO producer found in src/services (grep): `message.delivery_command`, `message.delivery_state`, `runtime.session_state` (only relayed verbatim from clients), `runtime.permission_request`, `git.operation_command` [C for grep result].
- `/internal/publish` may publish ANY server type (workspace.event used by conversation-service.ts:134 for agent MCP replies; pty.handoff by handoff-to-terminal route). Payload not validated (only the 64KB HTTP body cap) — but see the client-side 8 KiB inbound limit [C].
- Synthetic server-originated frames: `presence-offline-*`, `typing-stop-*`, `huddle-disconnect-*`, `pty-host-gone-*` (reason "host_disconnected", status exited), `pty-unlink-*`, `relay-backpressure-*`, `internal-<ts>-<rand>` (publishServerFrame) [C].

Ordering/idempotency:
- Per-socket protocol frames are SERIALIZED by a promise chain in SRV:118-137 (needed so subscribe finishes before a following post; tested in mission-relay-server.test.ts:86). A DO must keep this (async handlers interleave at awaits) [C].
- Outbound per-subscription ordering by OrderedMailbox (REG); cross-subscription order not guaranteed.
- Idempotency only exists for workspace.post (Supabase unique `(workspace_id, idempotency_key)`, see §5); `workspace.timing` via upsert ignoreDuplicates on (workspace_id,event_id); `message.post` via clientRequestId (=frame.idempotencyKey ?? frameId) inside postMissionMessage; runtime.event journal keyed by eventId (I).
- Confirmation of workspace.post = a `workspace.event` with the same correlationId, sent to the sender even when recipient-filtered. Clients resolve FIFO per correlationId [C].

---
## 2. Auth [C]
Transport: NO auth on WS upgrade (no path, no header, no origin check, no subprotocol). Credential is the first frame. No auth deadline: an unauthenticated socket lives forever (only ping/pong liveness) [C].
`createAuthenticator` PROD:~74-92:
1. `verifyMissionRelayToken(credential, secret)` (token.ts). Format `base64url(header).base64url(payload).base64url(HMAC-SHA256)`; header `{alg:"HS256",typ:"OATHLOCK_RELAY"}`; payload `{aud:"oathlock-mission-relay", sub, kind:"human"|"bridge", workspaceId, iat, exp}`. Default TTL 300s, clamp 30..900s; secret >=32 chars; verify rejects `exp<=now`, `iat>now+60`, wrong aud/alg/typ; HMAC compared with timingSafeEqual. Uses node:crypto createHmac/timingSafeEqual + Buffer base64url + `process.env.MISSION_RELAY_TOKEN_SECRET` default (token.ts:1-94).
2. If claims valid: require `claims.kind == (browser?"human":"bridge")` and `claims.workspaceId == frame.workspaceId` else throw. Principal `{kind, id: claims.sub, workspaceIds:[claims.workspaceId]}`. No Supabase call for signed tokens.
3. Else if `auth.bridge`: dynamic import of `../agent-join-service` `authenticateAgent(rawToken)`: Supabase queries: `agent_tokens` by `token_hash = sha256hex(token)` (select id, connection_id, workspace_id, scopes, expires_at, revoked_at); reject if revoked/expired; `agent_connections` select status, agent_kind, repo_hint by id, require status "active"; THEN WRITES `agent_tokens.last_used_at` and `agent_connections.last_seen_at` = now (every auth). Require `agent.workspaceId == frame.workspaceId`. Principal `{kind:"bridge", id: connectionId, workspaceIds:[workspaceId]}` (agent-join-service.ts:795-832).
   - Module cost: `agent-join-service.ts` imports `@/lib/supabase` (supabase-js createClient with SUPABASE_SERVICE_ROLE_KEY at module load), `@/lib/supabase/server` (next/headers! cookie client), `node:crypto`, projects-service, plan-limits-service, agent-join (createHash/randomBytes). Not loadable into a Workers DO as-is; needs a slim `authenticateAgent` (WebCrypto SHA-256 hex + 3 PostgREST calls) [C for imports; I for what else transitively loads].
4. Else throw "Relay credential is invalid or expired." -> `relay.error request_failed`.
Human tokens are minted at GET /api/missions/relay-token (src/app/api/missions/relay-token/route.ts): requires human principal + workspace; subject=user id, ttl 300. Bridge signed tokens: mintMissionRelayToken kind "bridge" (callers in local-mission-bridge-bootstrap.ts / scripts) [C for human, I for bridge minters].
Expiry semantics: token is checked ONLY at auth time. An authenticated socket is never re-checked/expired (a 300 s token yields an unbounded session); revoked agent tokens keep working until the socket drops [C].
Workspace authorization:
- Per-frame: `principal.workspaceIds.includes(frame.workspaceId)` (mission-relay-auth.ts) – purely token-derived [C].
- Channel authz at workspace.subscribe and workspace.post (`authorizeWorkspaceChannel` PROD:~316): `agent_conversations` row by id+workspace_id+status="open" ; human -> `projects` row with `id=workspaceId AND owner_id=principal.id` (so ONLY the workspace owner, not members [C]); bridge -> `agent_connections` id=principal.id, workspace_id, status active AND `conversation_participants` row (workspace,conversation,connection). NOT re-checked on later frames: presence/typing/step/turn/todos/pty.*/fs.* only need workspace match (+ `state.subscriptions` for pty/fs/huddle).
- Mission scope: `missionPrincipal()` -> mission-application-service reads (authorization inside those functions; not audited here).
- pty owner-by-human: `resolvePtyOwnerHuman(agentConnectionId)`: `agent_connections.created_by` (called on every pty.input/resize/share/link/unlink/close by a non-owner-conn sender -> one Supabase query per keystroke frame from a human viewer!) [C].

---
## 3. In-memory state (all process-local, all lost on restart) [C]
SVC fields (SVC:~150-160):
| structure | key | value | lifetime / eviction | authority |
|---|---|---|---|---|
| `connections: Map<connId, {connection, principal|null, subscriptions:Set<"ws\0room">}>` | `ws-<uuid>` per socket | | added on WS connection, removed on close/error | cache (session) |
| `subscriptions` (REG) `Map<"workspaceId:room", Map<connId,{subscription, OrderedMailbox}>>` | | mailbox queue max 128 frames | removed on unsubscribe/disconnect/overflow/send-throw | cache; clients re-subscribe on reconnect |
| `presence: Map<"ws\0room", Map<participantId,{participantId,state,connectionId,updatedAt}>>` | | | removed on `offline` post, on disconnect/unsubscribe of the recording connection ONLY (a second connection for the same participant overwrites connectionId, so the first's disconnect doesn't clear it); NO timer expiry | authoritative (ephemeral) |
| `typing: Map<"ws\0room", Map<participantId,{...,expiresAt,sessionId?}>>` | | expiresAt=now+2.5s | lazily filtered ONLY during ephemeral replay to a new subscriber; no timer; clients rely on `expiresAt` | authoritative (ephemeral) |
| `cursorRateLimiter.buckets: Map<connId,{tokens,lastRefillAt}>` | | | cleared on disconnect | authoritative |
| `huddles: Map<"ws\0mission\0huddleId", Map<participantId,{participantId,connectionId,muted}>>` | | | removed on leave / disconnect of that connection / (clearHuddleState per subscribed mission) | authoritative (ephemeral). NOTE: not cleared on mission.unsubscribe (unsubscribe path calls clearEphemeralState+clearPtyState only) [C] |
| `ptySessions: Map<lenPrefixedKey(ws,room,sessionId), PtySessionRecord>` | | `{sessionId,workspaceId,channelId,ownerConnectionId,ownerParticipantId,cols,rows,title?,status,scrollback:Uint8Array<=64KiB,lastSeq,shared,linkedSessionIds:Set}` | removed on pty.close by owner or owner disconnect/unsubscribe. Lookup by sessionId alone is an O(n) scan (`findPtySessionById`) | authoritative for routing+scrollback (bytes live only here) |
| `options` | – | – | – | – |
Server transport (SRV): `socketLiveness: WeakMap<WebSocket,bool>`, `webSocketServer.clients`.
Not present at all (do not assume they exist): pending posts, dedupe caches, cursors (cursors are client-held opaque strings; server keeps none), fs session registry (fs is pure broadcast). Client-side pending post queues live in clients [C].
Client-held state that the server relies on being re-sent after reconnect: subscriptions + cursors, presence, typing, huddle join/mute, pending workspace posts (client resends after relay.ready) [C].

---
## 4. Timers / heartbeats [C]
- SRV:97-108: `setInterval` 30 s over `webSocketServer.clients`: if the socket did not pong since the last tick -> `terminate()`; else mark false and `socket.ping()` (protocol-level ws ping/pong, NOT app frames). Effective dead-peer detection 30-60 s. Timer unref'd.
- Node client: its own 30 s ping (heartbeatIntervalMs default 30_000, timeout 10_000), terminates on missing pong, reconnect backoff [250,1000,3000,10000,30000] ms, resets to 0 on relay.ready. Browser client: browsers cannot ping; exponential 500ms*2^n capped 30 s; there is NO app-level heartbeat frame from browser (relies on server ws pings + browser auto-pong). => a Worker/DO must answer/emit WS-protocol ping/pong or keep an equivalent; `bridge.heartbeat` is an unrelated app frame (DB heartbeat of bridge instance).
- Presence: no expiry timer. Typing: 2.5 s expiry is data only; nothing publishes a "typing stopped" on expiry (client must expire by `expiresAt`). Cursor bucket: refill computed lazily.
- Post confirmation timers are client-side (5 s then one reconnect retry; browser 5 s / 10 s retry).
- Graceful shutdown: SIGTERM -> `wss.close()` then `server.close()` -> exit(0). No draining message to clients.
- Container wrapper (worker-wrapper.ts): `sleepAfter="24h"`, `onActivityExpired` no-op ("keeps alive indefinitely").

---
## 5. Persistence (all Supabase, service-role) [C unless noted]
Relay-side READS:
- `agent_conversations` (channel authz), `projects` (owner), `agent_connections`, `conversation_participants`, `conversation_messages` (snapshot page + idempotency lookups), `conversation_message_reactions` (ALL reactions in the channel, unbounded query, then sliced 20/msg in memory), `mission_runtime_events` (last 80 with non-null `activity`, workspace-wide, NOT channel- or recipient-filtered).
- Mission scope: mission-application-service (getMission, getMissionConversation(limit100,cursor), getMissionRuntimeActivity(100), getMissionMessageDeliveries(100), assignments, plan, evidence, executions) — 8 parallel reads per mission.subscribe/cursor.resume [C names, internals not read].
Workspace snapshot semantics (PROD loadWorkspaceSnapshot):
- No cursor = "initial baseline": returns 0 messages, `cursor` = (created_at,id) of newest message (1-row query, order desc), `incremental:false`. History is NOT replayed over the relay.
- Cursor = tuple `workspace-cursor.v1:` + base64url(JSON{createdAt,messageId}); legacy bare ISO timestamp accepted (empty id, `gte`, may replay one boundary row). Query: `created_at > c OR (created_at = c AND id > m)` ascending, limit 100. Bridge principals additionally filtered `recipient_connection_id is null OR = self OR sender_connection_id = self`.
- Snapshot page is trimmed to <= 7680 bytes (`buildBoundedWorkspaceSnapshot`, 8192-512): messages appended until size exceeded (reactions dropped to [] if that fits), then activity; `cursor` advances to last message that fit so resume pages the backlog. BUT the `snapshot.cursor` in the frame's outer payload (`payload.cursor`) echoes the REQUEST cursor while `payload.snapshot.cursor` is the new one; clients read `snapshot.cursor` (browser client:535; node `workspaceSnapshotCursor`). Preserve that.
- Same-timestamp siblings handled by (created_at,id) tuple; id compare in JS is lowercase string compare (workspace-cursor.ts:214) vs Postgres uuid ordering — equivalent for lowercase-hex uuids (I).
- Message rows returned include `sender_connection_id, sender_user_id, sender_display_name, recipient_connection_id, kind, body, outcome, created_at, spawned_run_id, related_run_id, parent_message_id, edited_at, deleted_at, correlation_id` + `reactions[]`.
- mission snapshot is NOT size-bounded (see §12 smell).
Relay-side WRITES:
- `conversation_messages` INSERT for workspace.post: idempotency by unique `(workspace_id, idempotency_key)`: lookup-first, then insert, on Postgres `23505` re-select; `idempotencyIdentityMatches` compares conversation, sender conn/user, recipient, kind, body, parent, outcome else error "idempotencyKey is already used by another message." Replay returns `{message,messages,activity:[],cursor,idempotentReplay:true}`.
- Availability notice INSERT (`kind:"notice"`, sender "M9R", `idempotency_key="agent-availability:<messageId>"`, parent=messageId) for human posts naming unavailable agents.
- `workspace_notifications` UPSERT (bridge posts; onConflict `recipient_user_id,message_id,kind`, ignoreDuplicates) — awaited but error ignored.
- `workspace_turn_timing_events` UPSERT onConflict `(workspace_id,event_id)` ignoreDuplicates.
- Runtime journal append via `createSupabaseMissionRuntimeEventJournal().append` + usage ledger `appendFromRuntimeEvents` (failure swallowed/logged).
- Bridge instance heartbeat/touch sessions (`createSupabaseMissionBridgeStore`).
- `agent_tokens.last_used_at`, `agent_connections.last_seen_at` on every bridge raw-token auth.
- postMissionMessage / acknowledgeMissionMessageDelivery (mission command persistence).
- Human-post side effects run INSIDE the relay: `findPendingEvidenceDecisionTarget` (before insert), `decideChatEvidenceRequestFromMessage` (after), multi-mention task negotiation `openTaskContractForMultiMention` (dynamic import of conversation-service [pulls next/headers], agent-dashboard-presenter, `@/lib/bridge/task-contract-service`), `scheduleShadowJudgment` (Jev via `@typesafe-ai/sdk`, env M9R_JEV_MODE/TYPESAFE_API_KEY). These are business logic embedded in the transport and should move behind an HTTP/queue boundary in a rewrite.
- Body policy: whitespace collapsed, <=2000, blocked by `containsActiveContent`, `looksLikeSourceCode`, `<script|javascript:|BEGIN (RSA|OPENSSH|PRIVATE) KEY`, SECRET_PATTERNS (agent-join.ts / agent-run-core.ts).
Never persisted: presence, typing, huddles, PTY bytes/scrollback, fs data, step/turn/todos/queued/cursor frames, runtime.session_state.

---
## 6. HTTP routes
Container (SRV:51-94) [C]:
- `GET /healthz` -> 200 `{"status":"ok"}` no auth.
- `GET /internal/pty-session/<sessionId>?workspaceId=<id>` — Bearer == MISSION_RELAY_TOKEN_SECRET (sha256-then-timingSafeEqual). 400 missing ids, 404 `{error:"not_found"}`, 200 `{channelId, ownerConnectionId, status}`. Only caller: handoff-to-terminal route via `lookupLivePtySessionRoom` (8 s timeout; 404->null, other non-ok -> throw).
- `POST /internal/publish` — same bearer; body <=64 KiB JSON object `{workspaceId, channelId, type, payload}`; `type` must be in RELAY_SERVER_FRAME_TYPES else 400 "unsupported frame type"; missing fields 400; 200 `{ok:true}` (even if zero subscribers; no delivery count). Frame stamped `internal-<Date.now()>-<rand>`, correlationId = frameId, no recipient filter, published to that room only (`publish`, not publishWorkspace). Callers: conversation-service.ts:134 (`workspace.event` for agent-written messages; failure swallowed) and handoff-to-terminal route (`pty.handoff`). Body-read errors: `readJsonBody` returns null -> 400.
- Anything else 404 `{error:"not_found"}`. WS upgrade accepted on ANY path/URL (clients use bare root URL).
Worker wrapper (worker-wrapper.ts) [C]: `POST /internal/restart` bearer = MISSION_RELAY_TOKEN_SECRET (WebCrypto sha256 + `crypto.subtle.timingSafeEqual`) -> `container.destroy()` (needed because container env is fixed at start). All other requests -> start container (passing env: MISSION_RELAY_TOKEN_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MISSION_RELAY_PUBLIC_URL, HOST/PORT, optional M9R_JEV_MODE, TYPESAFE_API_KEY) then `container.fetch(request)`. Single fixed container instance id `"m9r-relay-staging"`, `max_instances:1`, `instance_type:"standard-1"`, wrangler compat flags `nodejs_compat`, compat date 2024-12-01, DO class MissionRelayContainer (sqlite migration v1). Public URL default `https://m9r-relay.m9r.workers.dev` (mission-relay-internal-publish.ts:125). Same secret is signing secret AND internal bearer (no separation).

---
## 7. Fan-out rules [C]
- Room = `channelId ?? missionId` (SVC roomId). Registry key `${workspaceId}:${room}` — channels and missions share one namespace.
- `publish(ws, room, frame, {recipientPrincipalId, senderConnectionId})`: if recipient null -> every subscription in the room (INCLUDING the sender connection and both humans and bridges). If recipient set -> subscriptions whose `principalId == recipient` OR whose connection == sender. Applies only to workspace.event from workspace.post. `principalId` = agent connection id for bridges, user id for humans. Consequence: a DM/handoff (recipient set) is NOT delivered live to humans other than the sender's own connection (another tab of the same human misses it; owner human viewing a bridge-to-bridge DM doesn't see it) [C/I on intent]. Recipient is `message.recipient_connection_id` (explicit, evidence-decision agent, or DM channel's first participant).
- `publishWorkspace(ws, frame)`: every subscription with scope "workspace" in ANY channel of the workspace (prefix scan over ALL registry keys: O(total rooms)), used only for runtime.event->workspace.event{activity}. No recipient filtering, so agent activity goes to all bridges too [C].
- Direct routing: pty.input/pty.resize -> single owner connection; `pty.state{close_requested}` -> owner conn; huddle signals -> target member conn; huddle join/leave/mute -> huddle members only; fs/pty other frames -> whole room.
- Snapshots use the same visibility (bridge recipient filter) as live fan-out (tested, mission-relay.test.ts:120).
- Late-joiner replay (after snapshot): presence records, unexpired typing, then per PTY session in the room: `pty.state` then scrollback re-chunked to 4096-byte base64 `pty.output` frames with SYNTHETIC seq = `lastSeq - n + 1 + i` (may be negative if fewer than n frames were ever sent) [C].
- Backpressure: OrderedMailbox per subscription, cap `DEFAULT_MAX_PENDING_RELAY_FRAMES=128`; overflow -> drop queue, send one `relay.error{code:"subscriber_backpressure",retryable:true}`, and REMOVE the subscription (socket stays open, client not told to resubscribe other than the message; clients must reconnect). CAVEAT: SRV's `send` is synchronous (`socket.send` with no await/bufferedAmount check) so `deliver` never returns a promise and the queue never fills — backpressure is effectively dead code with the real transport; it only triggers in tests with async senders [C]. No `bufferedAmount` check anywhere.
- Limits: frame 16 KiB / payload 8 KiB inbound; PTY chunk 4096 raw bytes in & out; scrollback 64 KiB/session; cols/rows 1..1000; session/huddle ids <=128; `pty.output` seq monotonic per session but the server does not verify ordering or gaps. Rate limits: ONLY presence.cursor (20/s, burst 20, per connection). Nothing on pty.output/input, typing, presence, posts, subscribe, auth attempts, connection count, per-workspace fan-out.

---
## 8. Node-specific dependencies and Workers equivalents
| dependency | where | Workers equivalent |
|---|---|---|
| `ws` (WebSocketServer, ping/pong/terminate, `clients`) | SRV | WebSocketPair + `state.acceptWebSocket()` Hibernation API; `ws.close(code)` replaces terminate; no protocol-level ping API from DO (use `setWebSocketAutoResponse` for an app-level text ping/pong; CF edge answers WS-protocol pings automatically [I - verify against docs]) |
| `node:http` createServer | SRV | Worker `fetch` handler / DO `fetch` |
| `node:crypto` randomUUID | SRV, clients | `crypto.randomUUID()` (global) |
| `node:crypto` createHash/timingSafeEqual (bearer check) | SRV | WebCrypto `subtle.digest` + `crypto.subtle.timingSafeEqual` (already done in worker-wrapper.ts) |
| `node:crypto` createHmac + timingSafeEqual + `Buffer` base64url | token.ts | WebCrypto HMAC (`subtle.importKey/verify` is inherently constant-time) + base64url via atob/btoa helpers; token.ts also used by Next routes (must stay Node-compatible or dual-implemented; token format must stay byte-identical) |
| `Buffer` (byteLength, base64) | protocol (has TextEncoder fallback), pty-protocol (has atob/btoa fallback), workspace-cursor.ts (NO fallback: Buffer base64url), workspace-relay-snapshot (fallback) | `nodejs_compat` provides Buffer, or replace with TextEncoder/btoa (workspace-cursor needs a rewrite for fallback) |
| `process.env.*` (MISSION_RELAY_TOKEN_SECRET default, OATHLOCK_RELAY_DEBUG, supabase URL/key via `@/lib/supabase`, feature flags) | many | DO `env` bindings; `process.env` in Workers requires `nodejs_compat` + `nodejs_compat_populate_process_env` or compat date >= 2025-04-01 (wrangler currently 2024-12-01) [I] |
| `setInterval`/`setTimeout` (heartbeat) | SRV | DO alarms (`storage.setAlarm`); timers don't survive hibernation |
| `@supabase/supabase-js` service-role client created at import time (`src/lib/supabase.ts`) | PROD + all stores | supabase-js is fetch-based and runs on Workers [I]; or raw PostgREST via fetch/Hyperdrive. Service-role key must be a DO secret |
| `agent-join-service.ts` (next/headers via `@/lib/supabase/server`, plan-limits, projects-service, node:crypto) | bridge raw-token auth | no equivalent as-is: extract a minimal authenticateAgent |
| `mission-application-service` graph (supabase stores, `mission-git-attestation-signer.ts` uses node:crypto sign/verify/createPrivateKey/createPublicKey; `mission-idempotency`, `mission-commands` createHash) | mission.* scope | createHash -> WebCrypto (async); asymmetric key ops -> nodejs_compat partial / WebCrypto; signer probably shouldn't live in relay at all [I on Workers compat] |
| `import("../conversation-service")` (next/headers), `task-contract-service`, `chat-evidence-service`, `jev-shadow` (`@typesafe-ai/sdk`), `containsActiveContent/looksLikeSourceCode/SECRET_PATTERNS` | workspace.post side effects | Move to a Next API / Queue; regex helpers are pure and portable |
| `@cloudflare/containers` | wrapper | Not needed after migration |
| `node-pty`, `child_process`, `fs` | NOT in the relay; only in bridge-side `mission-pty-runtime.ts` (`createNodePtySpawner`), `owner-pty-runtime.ts`, `owner-fs-runtime.ts` on the user's machine | remain on the user's machine; not a Workers concern [C] |
| `console.error/warn` | throughout | fine (Workers logs) |

---
## 9. Single-process assumptions [C unless noted]
- ALL room state is one JS heap; correctness needs every socket of a workspace (in practice: every socket) on the same process. Wrangler/wrapper enforces this by hard-pinning one container `getContainer(env, "m9r-relay-staging")` with `max_instances:1`. A second instance would: split fan-out (subscribers on B never see posts on A); lose PTY routing (`ptySessions` only on owner's instance -> `pty_session_not_found`, `/internal/pty-session` 404, `/internal/publish` lands on random instance); split huddles, presence, typing; cursor rate limiter per-instance; `publishWorkspace` reach only local sockets.
- Restart = every socket dropped, all PTY sessions silently dead (owner reconnect must re-`pty.open`; viewers get nothing except socket close), presence gone (clients resend presence on reconnect), huddles gone (client resends join). Only durable data survives.
- `/internal/publish` and `/internal/pty-session` are HTTP calls into the same process; with multiple instances they'd need routing by workspace.
- Serialization assumption: `receiveChain` per socket; service methods are not re-entrant-safe across sockets (Maps mutated between awaits) — fine single-threaded.
- DO note: partition key is naturally `workspaceId` (every frame carries it; principal is single-workspace `workspaceIds:[one]`; rooms never span workspaces). Cross-workspace state: none. One DO per workspace also makes `publishWorkspace` local. `/internal/publish` and `/internal/pty-session` are addressed with workspaceId already. Auth (`auth.*` first frame) currently needs the workspaceId from the frame, while a DO must be chosen at upgrade time -> upgrade URL needs the workspaceId (e.g., query/path) and the frame's workspaceId must be verified to match. This changes the client URL contract (clients use a bare root URL today) [I].

---
## 10. PTY / terminal rooms [C]
- The shell runs on the user's own machine in Node (`mission-pty-runtime.ts` via node-pty, `owner-pty-runtime.ts` started by `m9r-cli terminal runtime`, one per person). The relay only routes: it is a byte-agnostic (base64) message router + 64 KiB scrollback ring + ownership/ACL metadata. Therefore it CAN move to a DO (no process spawning in the relay).
- Ownership/input: owner = the bridge connection that sent `pty.open` (`ownerConnectionId`, transient per socket), and, for control actions (share/link/unlink), also the human whose user id == `agent_connections.created_by` of `ownerParticipantId` (Supabase lookup per call). Input is accepted from any subscribed principal (human or bridge) when `shared` (default true); when `shared=false` only owner may input; resize is always allowed for any subscribed viewer; close by non-owner is only a request. Input is delivered only to the owner connection with authoritative `participantId`.
- Data flow: bridge `pty.open` -> room `pty.state`; bridge `pty.output` (<=4096 raw bytes/frame, base64) -> room + scrollback; browser `pty.input/resize` -> owner only; `pty.request` (human) -> room -> owner-pty-runtime opens shell when `requestedByUserId == its ownerUserId`; `pty.link/unlink` cross-room metadata; `presence.cursor` overlays; `pty.handoff` server-injected (agent handoff-to-terminal route, after lookup verifying `room.channelId == conversationId`); `fs.*` request/response for file tree/content (2 MiB max file, 4096-byte chunks) all via room broadcast with self-filtering by `connectionId`.
- Sizes: scrollback 64 KiB/session; unbounded number of sessions; linked sessions can span rooms within a workspace (`findPtySessionById` scans all) — in a per-workspace DO that stays local; a per-channel DO would break linking.
- DO fit: session state is small; must be persisted or reconstructable if the DO hibernates/evicts: ownerConnectionId is a socket (with hibernation use `ws.serializeAttachment` + `getWebSockets()` tags), the scrollback (<=64 KiB x sessions) fits DO storage (2 KiB attachment limit is too small for it -> use storage). Owner disconnect currently kills the session; keep semantic or add grace.
- High-frequency: every `pty.output` frame is a message into the DO (each wakes a hibernated DO and bills a request); per-frame authz is memory-only for output, but `pty.input` from a non-owner-conn human costs a Supabase query each (resolvePtyOwnerHuman) [C].

---
## 11. Scale numbers implied by code
- Max connections/subscriptions/rooms: none enforced (Map-bound only). Container `standard-1`, single instance.
- Inbound frame 16 KiB/payload 8 KiB; workspace HTTP internal body 64 KiB; workspace message body 2000 chars; mission message body 12000 chars (larger than payload cap 8192 bytes -> effectively <8 KiB); evidenceRefs 32; activeSessionIds 8.
- Snapshot: messages<=100 rows queried, trimmed to ~7680 B total; activity query 80 rows trimmed to fit; reactions per message 20. Baseline subscribe returns 0 messages.
- Mission snapshot: up to 8 queries with limits of 100; unbounded size (violates the client's inbound 8 KiB limit) [C on missing bound, I on client consequence].
- PTY: 4096 B chunks, 64 KiB scrollback (=16 replay frames per session per late joiner), cols/rows <=1000, huddle sdp<=16000 chars, ice<=4096.
- Mailbox 128 frames per subscription. Cursor 20 Hz/conn. Typing 2.5 s TTL. WS ping 30 s. Token TTL 30-900 s (default 300).
- Per-post fan-out: O(subscribers in room); runtime.event fan-out: O(all workspace-scope subs in the workspace) with a full registry scan.
- Per-post Supabase round trips (human): ~6-12 (channel, project, [parent], [recipient x2], evidence lookup, idempotency, insert, availability notice x2 queries, task-contract mention check, evidence decision) — latency dominated by Supabase, not by relay.

---
## 12. Client contract that must be preserved
- Connect: WS to bare URL; first frame `auth.bridge|auth.browser` with `version`,`frameId`,`workspaceId`,`correlationId`,`sentAt`,`payload.credential`; wait for `relay.ready` then subscribe/resend. Browser gets credential fresh via `getCredential` on each reconnect.
- Node client: any `relay.error` BEFORE `relay.ready` fails the connect ("rejected Bridge authentication"); after ready, a `relay.error` whose `correlationId` matches a pending post rejects that post only; otherwise forwarded to `onFrame`. Server must therefore NOT send other correlationIds that collide with pending post correlationIds (hence the `workspace-side-effect:` correlation).
- Confirmation: `workspace.event` echoing the post's `correlationId` with payload `{message, messages?, activity, cursor, idempotentReplay?}`; clients resolve FIFO per correlationId (bridge posts share a correlationId across a turn). Must be sent to the sender even when recipient-filtered.
- Resume: client stores `snapshot.cursor` from `workspace.snapshot` and `payload.cursor` from `workspace.event` (only when a string; `cursor:null` from internal publishes must not clobber it), re-sends `workspace.subscribe{cursor}` after reconnect. Baseline vs incremental semantics per §5. Cursor string format must remain decodable (`workspace-cursor.v1:` + b64url JSON, legacy ISO).
- Reconnect safety net: duplicates are collapsed by UI on message id; idempotent replays return `idempotentReplay:true`.
- Ordering: subscribe must fully complete (snapshot sent) before a following frame on the same socket is processed (per-socket serialization).
- Heartbeat: Node client uses WS-protocol `ping()` and force-terminates if no `pong` within 10 s; server must answer pings with pongs (a ws server library does this automatically). Server pings every 30 s and clients (ws lib / browser) auto-pong.
- Close codes: server never sets one explicitly (uses `terminate()` = abnormal 1006, or normal on shutdown). Browser client closes itself with 1000 (intentional) or 4000 (client error; 1011 avoided because browsers reject it). Clients treat any `close` as reconnect trigger (except explicit close). Error codes clients/tests depend on: `invalid_frame, unauthenticated, already_authenticated, request_failed, workspace_forbidden, channel_required, workspace_unavailable, mission_required, bridge_required, human_required, room_required, presence_identity_mismatch, presence_state_invalid, typing_identity_mismatch, huddle_*(identity_mismatch, membership_required, signal_invalid, target_not_found, mute_invalid), mission_subscription_required, pty_* (subscription_required, not_owner, session_not_found, session_taken, not_shared, *_invalid, link_invalid), fs_*_request_invalid, runtime_sink_unavailable, runtime_event_rejected, message_unavailable, workspace_timing_unavailable, unsupported_frame, subscriber_backpressure(retryable)`.
- `relay.ready` payload `{principalKind, principalId}`; principalId = user id (human) or agent connection id (bridge) — used by clients for identity matching (presence/typing/huddle `participantId` must equal it).
- `pty.state.payload` shape: `{sessionId,status,ownerParticipantId,shared,cols,rows,title?,linkedSessionIds[],reason?}`; `pty.output.seq` semantics; replay-after-subscribe ordering (state then output) — TerminalPane.tsx depends (I).
- `/internal/*` contracts in §6, incl. status codes and JSON error shapes; `pty.handoff` payload `{sessionId,fromConnectionId,fromLabel,text,reason,handoffId}` (TerminalPane.tsx:358).
- Test contracts to port (scripts/mission-relay*.test.ts, workspace-relay-phase1.test.ts): frame validation bounds; cross-tenant rejection; subscription isolation by (workspace,mission); recipient-aware fan-out (target + posting socket only); direct-recipient workspace.post; additional messages published with separate correlation; bridge snapshot visibility; ordered delivery behind async transport; explicit resync on slow subscriber; auth-before-subscribe; workspace.timing bridge-only & never fanned out; presence/typing streamed and cleared on disconnect; identity mismatch refusals; huddle membership/mute/targeted signaling/forged identity/media-bearing SDP rejection/disconnect cleanup; subscribe-then-post serialization; client resume from snapshot cursor, credential refresh on reconnect, pending post rejected on close/resent after reconnect, request errors keep socket alive.

---
## 13. Bugs / races / smells NOT to port
1. Backpressure is dead code on the real transport (sync `socket.send`, no bufferedAmount). Implement real backpressure (bufferedAmount / drop policy) in the rewrite.
2. No auth timeout; unauthenticated sockets live forever; no connection limits; no per-frame rate limits except cursors; no origin check.
3. Token expiry only checked at auth; sessions never expire or re-auth; revoked agent tokens and removed members keep access for the socket lifetime.
4. Human workspace access = `projects.owner_id == user` only (owner-only), while workspace.post etc. trust it; membership model unclear [I].
5. presence/typing/step/turn/todos/queued/runtime.session_state/git.operation_result do not require channel membership or subscription; `runtime.session_state`/`git.operation_result` relayed verbatim from ANY principal (spoofable) and with original frameId/type.
6. `publishWorkspace` sends agent activity (unfiltered `mission_runtime_events`, and runtime.event->workspace.event) to all channels' subscribers incl. private channels/DMs and all bridges; snapshot `activity` query is workspace-wide, not per channel/visibility.
7. Recipient filtering hides direct messages from all humans except the sending connection (second tab of the same human misses it); intent unclear.
8. Presence keyed by participantId with the last connection winning; first connection's disconnect leaves stale "online"; no presence TTL if a client vanishes without close (only server ws-ping timeout cleans up).
9. Huddle SDP limit (16000 chars) vs payload cap (8192 bytes) inconsistent; huddles only usable with `missionId` + mission subscription; `mission.unsubscribe` doesn't clear huddle state.
10. PTY replay seq is synthetic and can be negative; scrollback trimmed mid-escape; `findPtySessionById` O(n); `pty.resize` allowed for any viewer regardless of sharing; `pty.input` non-owner human triggers a Supabase query every frame; owner-disconnect immediately kills a session with no grace/reattach.
11. Server outbound frames aren't size-checked but clients reject >8 KiB payload: mission.snapshot (8 parallel queries, unbounded) and `/internal/publish` payloads can silently break clients.
12. `runtime.permission_response` silently ignored in prod; five server frame types have no producer (message.delivery_command/state, runtime.permission_request, git.operation_command, runtime.session_state as server type) — dead protocol surface.
13. Business logic (evidence approval, task negotiation, Jev shadow judgment, availability notices, notifications) runs inside the relay's post path with lazy imports that pull `next/headers`; slow, hard to run in Workers. Extract.
14. `workspace.snapshot` outer `payload.cursor` echoes the request cursor while the real new cursor is `snapshot.cursor` — confusing, but clients depend on it.
15. `snapshot` conversation row + reactions: full unbounded reactions query for the channel each subscribe (then sliced), scaling badly.
16. Registry key uses ":" separators while service uses "\0"; `publishWorkspace` prefix-matches `${workspaceId}:` (safe only because ids are UUIDs) [I].
17. Same secret (MISSION_RELAY_TOKEN_SECRET) is the token signing key and the `/internal/*` + `/internal/restart` bearer; secret rotation requires container restart (wrapper comment).
18. Auth failure returns generic `request_failed` w/ message, not a distinct code and doesn't close the socket (client-visible contract: Node client keys on "before relay.ready").
19. `publishServerFrame` stamps `Math.random()` ids; `internal/publish` returns ok even with zero recipients (no delivery info); no dedupe of repeated internal publishes (UI dedupes by message id).
20. workspace.post publishes even if the socket unsubscribed; and the human-only side effects use `.catch` swallow patterns making failures invisible except console.
