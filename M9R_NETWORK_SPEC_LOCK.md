# M9R Network Spec: Lock Sheet for Stage 1 and 2 (2026-09-19)

Purpose: the handoff says the state machines and security semantics must be locked before any Stage 1 code. `M9R_NETWORK_SPEC.md` already has D1-D10 locked. This sheet covers what those decisions did not: the concrete rules the Stage 1 and 2 code will implement, adjusted for what changed since the spec was written (Relay is now a Durable Object, messaging is proven live on Cloudflare, `m9r-cli ask` exists, Codex app-server is verified, native-history is verified). Section numbers refer to the spec.

Status key: **LOCK** = recommended as written, veto if you disagree. **AMEND** = spec text changes as shown. **ASK** = needs your decision (asked in chat).

## A. Rules to lock as written

| # | Rule | Spec | Status |
|---|---|---|---|
| A1 | Endpoint is durable; `sessionGeneration` increments when the bound session is replaced. A message queued for generation N is delivered to N+1 with a `generationChanged` flag. Capsules are never carried across generations. | 3.4 D2 | LOCK |
| A2 | Address grammar `@owner/name[~generation]`, lowercase ASCII, 2-39 chars, reserved handles (`m9r`, `admin`, `system`, `everyone`, `here`, `channel`, provider names). Bare `@codex` stays a same-owner shorthand and is never resolved across owners. | 3.1 | LOCK |
| A3 | Delivery state machine exactly as in 7.2 (accepted, queued, delivered_to_node, delivered_to_session, processing, completed, failed, expired, rejected, cancelled) with the transition table. A state is only written with adapter or Node evidence; `completed` means the turn ended, not that the work is correct. | 7.2 | LOCK |
| A4 | RESUMABLE_NATIVE sessions stop at `delivered_to_node` with `pendingUntilTurnBoundary`. CONSULTATION deliveries carry `viaConsultation=true` everywhere they are shown. Never claim a higher state than the evidence. | 7.2 | LOCK |
| A5 | Idempotency: scope `(from, idempotencyKey)` kept 7 days; same key and content returns the original result; same key with different content is `409 IDEMPOTENCY_KEY_CONFLICT`; a repeated transition ack is a no-op. | 7.3 | LOCK |
| A6 | Loop guard is cloud-side: `hop <= 3`, per (from, to) rate limit 20 per minute, auto-pause row. | 7.3 #8 | LOCK |
| A7 | Presence: 90 s lease, `working` hard stop at 180 s without an event, state moves to `offline` with confidence `unknown` on expiry, `seq` must increase, server time is authoritative, confidence is never upgraded by a consumer. Old states map as in 5.3. | 5.1 | LOCK |
| A8 | Offline default is `queue` with a 24 h TTL and a sender notice; no silent redirect (D6). Blocking is silent to the sender. | 7.4 | LOCK |
| A9 | Delivery guarantee is at-least-once to the Node and effectively-once into the session via dedupe. We never claim exactly-once (D5). | 7.7 | LOCK |
| A10 | Machine Call state machine as in 9.1 for Stage 2, limited to initiator and callee in one workspace (`requested` to `active` to `ended`). Grants are minted only in `approved` and all revoked at `ended`. | 9.1, 9.3 | LOCK |
| A11 | Same-owner and cross-owner rules from D7: cross-owner default is deny. `PUBLIC` endpoints and orgs are not in v1. | 4, 6 | LOCK |
| A12 | The confidence chip is shown to humans for `inferred` and `unknown` only. | 5.4 | LOCK |

## B. Amendments (spec text changes)

**B1. Stage 1 builds on the messaging that now works, not a parallel stack.** The spec's 7.6 adds `envelopes`, `deliveries` and a `POST /v1/messages` path next to chat. Messaging was only just made reliable on Cloudflare, so the Stage 1 plan is:
- `endpoints` is a view-backed table over `agent_connections` (1:1 backfill, `legacy_connection_id`), as in 3.3.
- Delivery states are stored in one new table `message_deliveries` (one row per message and recipient), written from the reports the Bridge already sends (message accepted, picked up, turn started, turn finished, plus the new provider-session report).
- No new transport, no `m9r.relay.v2` frames, no `envelopes` table until a state machine test needs them. The existing chat message row is the envelope for Stage 1.
- `m9r-cli ask` is the Stage 1 sender. `--wait` becomes "show the delivery timeline", not only the reply.

**B2. `delivered_to_node` needs a local ledger the Bridge does not have yet.** Before the Node acks, it must persist `messageId -> highest state` locally (A5 #7). Stage 1 adds a small append-only file in `.oathlock/runtime/`. Until it exists the Bridge cannot honestly report `delivered_to_node`, so it reports `delivered_to_session` only.

**B3. Body cap. LOCKED (founder, 2026-09-19): keep 2,000 characters for Stage 1.** Spec's 8 KiB inline plus blob refs is deferred; longer context goes in a file the agent reads.

**B4. Same-owner calls. LOCKED (founder, 2026-09-19): always ask, including between your own agents.** Every Machine Call needs the callee owner's approval, SELF tier included; the optional "trust this caller for 8 h" standing rule is how the friction is removed, and it is opt-in per caller. (This is stricter than my recommendation of auto-allow for SELF.)

**B5. Codex.** The spec's Codex adapter row is updated: app-server is verified against Codex 0.153.4; M9R-hosted threads are LIVE_NATIVE; a Codex you started in a plain terminal stays RESUMABLE_NATIVE or CONSULTATION until shared-server mode is proven.

**B6. Provider session id.** `agent_connections.last_provider_session_ref` is now the first field of `nativeSessionRef`. It is per connection today; Stage 1 moves it onto the endpoint and keeps one per generation.

## C. Explicitly deferred (not locked now)

- Capability grant signing (D3, Ed25519) and revocation set: Stage 4.
- Control leases and `controlEpoch` (D8): Stage 3.
- Message and event signing (17): Stage 5.
- Context Capsules (8): Stage 4; Stage 2 messages carry a `capsuleId` field that is always null.
- Cross-org discovery, reputation, marketplace: Stage 6+.

## D. What Stage 1 code this unlocks (in order)

1. `endpoints` table and `m9r resolve` (read-only).
2. `message_deliveries` table, the state machine as a pure module with tests, and Bridge reports into it.
3. Node local ledger and `delivered_to_node`.
4. `m9r ask` prints the delivery timeline; idempotency and conflict behaviour per A5.
5. Presence expiry sweep in the Relay hub and the confidence chip.
6. Stage 1 acceptance script (spec section 25) run against real Codex and Claude sessions.

## E. Open items that stay open

- **Stage 1 base (B1) is not locked yet:** founder asked for the cost first. Money: about $0 either way (Supabase is on Pro, DB is 126 MB with 654 messages; delivery rows are ~200 bytes each). Effort and regression risk differ.
- Queue freshness: **LOCKED 24 h queue, sender is told and can cancel** (spec default D6, A8).
- Whether `mission_message_deliveries` is on the live chat path (spec marks it UNVERIFIED). I will check the live database before writing `message_deliveries`, and reuse it if it is.
- Provider terms for driving subscription logins from background processes (not a code decision; needs your reading of Anthropic and OpenAI terms).

## F. Stage 1 progress

- **Slice 1 (endpoints, `resolve`, `endpoints`): shipped to staging 2026-09-19.**
- **Slice 2 (delivery states): shipped to staging 2026-09-19.** Amendment to B1: no new table and no new Bridge reports. The Bridge already stores a timing event for every stage of every message (`workspace_turn_timing_events`), so `message_deliveries` was not needed; delivery state is derived read-only (`delivery-state.ts`, 14 tests) from the message row, the recipient's liveness and those events. Cost: zero new writes. Mapping: message stored = accepted; no evidence and recipient not live = queued; over 24 h unreceived = expired; `message.received` = delivered_to_node; `prompt.started` = delivered_to_session; `provider.first_event` = processing; `turn.completed` = completed (or failed if its outcome is failed); `turn.failed` = failed. **`turn.rejected` is not a failure:** the Bridge emits it whenever it declines to run a message right now (session still starting, paused, loop hard-stop, usage cooldown, full queue), and real data showed messages that were declined twice and then completed. It is kept as a note and a `declined` flag, never as `failed` or the spec's `rejected` (which stays a cloud policy decision at accept). A later stage marks earlier states `implied`; nothing is derived from absence.
- **Still open from B2:** `delivered_to_node` is the Bridge's in-memory receipt; the timeline says so on every row until the local ledger is built. Next: the ledger, presence expiry sweep in the Relay hub, and the Stage 1 acceptance script.
- **Slice 3 (Bridge local delivery ledger): shipped 2026-09-19.** `src/lib/bridge/delivery-ledger.ts`: append-only JSONL per provider Bridge in `.oathlock/runtime/delivery-ledger-<provider>.jsonl`, written before each stage is reported; `message.received` now carries `ledger: true` when the receipt was saved first, and the timeline says "saved in the bridge's local ledger first" (rows without it still say "bridge memory only"). 7-day retention, 10,000-entry cap, corrupt lines skipped, unwritable disk reports not-persisted instead of failing a message. Live PASS (`pong8`). **Bug found and fixed by this work:** every local Bridge marks a receipt for each provider a message mentions, so the Codex Bridge was also reporting "claude-code received it"; the delivery timeline now only counts a receipt from the recipient's own Bridge (`local-<provider>-*`), which corrected the timestamps of earlier messages. **Still open (acceptance step 6):** on restart, read `ledger.unfinished()` and report those messages as failed(restart_interrupted) instead of relying on the cursor; the ledger already records what that needs.
- **Slice 4 (restart recovery): shipped and proven live 2026-09-19 (founder chose "notice and stop").** On restart the Bridge reads its local ledger and decides per re-offered message (`restart-recovery.ts`, pure, 9 tests): a message a previous process had handed to a session and never finished is **not re-run**; one notice is posted (kind result, outcome failed, threaded, no @ mention, idempotent per message) and the delivery timeline reads `failed` with failure `restart_interrupted`; a turn a previous process completed, or already reported as interrupted, is skipped silently; a message only received, or any state written by this process, runs as before. The guard sits synchronously in all three delivery paths (snapshot, relay event, poll) before any session is started, and never touches entries newer than the process. **Acceptance step 6 PASS:** long task sent to claude-code, Claude bridge killed mid-turn (`processing` in the ledger), supervisor restarted it, recovery fired 13 s later; exactly 1 notice, no second prompt, timeline failed(restart_interrupted); a following normal message (`pong9`) completed normally. Script: `scripts/stage1-restart-kill-test.ps1`. Known limits: a crash after the turn finished but before the reply posted is a separate lost-reply case; a deleted or corrupt ledger falls back to the old re-run behavior.
- **Slice 5 (Relay presence lease) and the acceptance suite: shipped 2026-09-19.** The Durable Object Relay now closes a Bridge socket (code 4009 `presence_lease_expired`, with a reason frame first) after a full 90 s lease with no inbound frame; only sockets that have sent `bridge.heartbeat` after authenticating are subject to it, so a quiet browser tab is never swept. One 30 s interval per Hub, present only while a heartbeating Bridge is connected (no idle timer, no added cost). Live PASS x3 against `m9r-relay.m9r.workers.dev` (closed at 102-108 s; a steady heartbeater and a never-heartbeating socket stayed up; the first run once closed the never-heartbeating socket for a reason I could not reproduce in two further runs, most likely the deploy rolling over). `scripts/stage1-acceptance.mjs` (`npm run stage1:acceptance`): spec section 25 steps 1-5, 7, 8, 9 automated against staging, **12/12 PASS** with the target claude-code (`--restart-bridges` includes the message-sent-during-a-restart check: one hand-off, no loss, no duplicate); step 6 is `scripts/stage1-restart-kill-test.ps1`. Steps that name Codex re-run with `--target codex` once the Codex usage limit resets. Migrations `task_contract_anchor_unique` (0 duplicates found) and `agent_identity_fields` applied to the shared database; dashboard verified after.
