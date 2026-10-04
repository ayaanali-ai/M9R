# M9R room-agent adapter acceptance

**Date:** 2026-10-04
**Status:** **DONE — audited and accepted for Track A step 2**

## Scope

Track A step 2 is an audit/exposure task. It is not a second room protocol and it does not replace the authenticated room HTTP/RPC system. The adapter lets local agent sessions use the room's existing collaboration primitives while the room API remains the authority for cross-machine membership and durable room state.

## Existing surfaces verified

### Authenticated room HTTP/RPC

The room routes already provide the server-authoritative operations:

- `join`, pending requests, member admission, and member roster
- agent-seat registration
- minimized event append/read/export
- lease claim, renew, release, and owner preemption
- structured handoff proposal and response
- room-scoped shared memory

These routes authenticate the Supabase user, validate the room, and delegate state changes to the room RPCs/RLS policies. They remain the correct authority for room membership, leases, and handoffs.

### Local agent adapter

The existing `createM9rMcpServer` plus `WebBrokerClient` provide the equivalent agent-facing operations:

| Agent need | Existing surface | Boundary |
|---|---|---|
| Discover room teammates | `m9r_agents` → `listRoomAgents` | Web-room identities use the room roster; unrelated local sessions are not mixed in. |
| Send a task/message | `m9r_send` → `authorizeRoomMessage` + durable local inbox + `notifyMessage` | Room handles are namespaced (`web-*`); the broker hook is checked before delivery. Its current local-agent policy permits sends without a separate AWARE membership-admission step, so it is not the cross-machine room membership authority. |
| Receive work | `m9r_inbox` | The cursor is keyed to the stable room handle, survives provider-session respawns, and filters pre-room work. |
| Return a result | `m9r_result` | Recipient ownership is checked before recording the result. |
| Shared room memory | `m9r_note` | Notes are bounded, attributed, and page-derived text is marked untrusted. |
| Shared browser work | `m9r_web_*` | Existing broker claims, room modes, grants, disclosure gates, and one-writer scheduling remain in force. |
| Room bridge notifications | `/web/message`, `/web/agents`, `/web/agent-done` | Loopback broker key and authenticated owner/agent paths are preserved. |

No second room store, alternate membership ledger, or new message protocol was introduced.

The local send authorization hook is intentionally distinct from the authenticated room membership routes: it does not enforce AWARE admission for local sessions. Cross-machine membership remains enforced by the authenticated room HTTP/RPC and database policy paths. Do not describe the local hook as a cross-machine membership check.

## Evidence

The following focused checks pass on the current checkout:

- `npm run test:coordination` — **23/23**
- `npm run test:web-broker` — **231/231**
- `node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/register-alias.mjs --test ./scripts/cross-machine-room.test.ts ./scripts/room-coordination.test.ts ./scripts/room-events.test.ts ./scripts/room-event-export.test.ts ./scripts/room-shared-memory.test.ts` — **27/27**

The room-contract checks cover authenticated room routes, agent seats, ordered events, active-member boundaries, leases, handoffs, memory, and live-tab disclosure boundaries. The MCP/broker checks cover room roster discovery, send/inbox/result delivery, stable cursors, room file-access gates, browser claims, notifications, and authorization failure behavior.

## Deliberate boundary

The local MCP adapter does not pretend to be the cross-machine lease/handoff API. Those actions stay on the authenticated room routes and UI until Track A C4, where the broker lease and clean agent pause/resume are implemented and accepted. This keeps step 2 from duplicating C4 or creating a second authority path.

## Step 3 decision

**Track A step 3 is unblocked.** The next task is the OS-level stage groundwork: Cua Driver cursor primitive, dedicated Windows virtual-desktop stage, native switching, joinable app/window/desktop ownership, visible transitions, and the Jev-vs-CUA-S1 decision. C3 remains deferred until the stage sequence, C4, and C15 are complete.
