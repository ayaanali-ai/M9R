# M9R cross-machine room — design for approval

Status: step 1 is implemented in the local branch: room, member, and invite tables, plus authenticated room-create and room-invite endpoints. The migration has not been applied to any database. Invitation acceptance, room joining, relay coordination, browser authority, and UI are not implemented. The recommended same-origin, same-page v0 collaboration profile remains a design boundary to approve before those follow-on steps.

## Goal and boundary

Two people on different machines can join one explicitly shared room while each keeps their own local agents, browser profile, extension, credentials, and action authority. They can see room presence, messages, and page-target claims for the same shared page. A remote participant can request coordination, but cannot exercise the other person's browser authority or approve actions for them.

The first shippable profile should be **same-origin, same-page collaboration with per-owner execution**: both owners independently open the same URL in their own browser. “Same page” means the canonical origin/path plus an optional user-created shared-page label; it does not mean shared cookies, a remote-control session, or identical DOM state. Cross-origin redirects and different account/session state must remain visible as divergence, not be papered over.

## Existing pieces to reuse

- The deployed relay gateway routes a first authenticated WebSocket frame to a Durable Object keyed by workspace ID. Its `/healthz` endpoint is the health route; `/health` is not currently defined.
- The existing relay protocol already has `auth.browser`, `auth.bridge`, `workspace.subscribe`, `workspace.post`, `participant.presence`, `presence.cursor`, and `web.presence` frame shapes.
- The web app can mint short-lived browser relay credentials server-side; bridge clients already authenticate with a bridge credential. Credentials must not be copied between owners or included in room events.
- Workspace conversations already have participant membership and persistent messages. The relay currently provides live delivery; it is not by itself proof of cross-owner page grants, synchronized DOM state, or an immutable event log.
- The local web broker already owns browser actions and local claims/approvals. Keep that authority local and adapt it behind a room coordinator instead of moving browser control into the relay.

## Proposed data model

| Record | Required fields | Authority / lifetime |
|---|---|---|
| `Room` | `room_id`, `workspace_id`, `status`, `created_by`, `policy_version`, `created_at` | Durable app record; owner or workspace admin closes it. |
| `RoomMember` | `room_id`, `user_id`, `connection_id?`, role (`owner`, `member`, `guest`), join status, joined/left timestamps | Server-authenticated membership; never inferred from provider labels. |
| `RoomTab` | opaque `tab_ref`, `room_id`, `member_id`, canonical origin/path, navigation epoch, visibility, last-seen time | Local extension reports it; server stores only minimized metadata, lease expires on disconnect. |
| `PageGroup` | `room_id`, user-selected `page_group_id`, origin/path key, participant tab refs, divergence flags | Coordination key; does not assert equal DOM, cookies, or account state. |
| `PresenceLease` | `room_id`, `member_id`, `agent_id?`, provider label, state, sequence, expiry | Ephemeral; server derives identity from the authenticated socket. |
| `Claim` | `claim_id`, room/page group, scope (`field`, `form`, `tab`), opaque target key, holder member/agent, shared-with set, lease expiry, revision | Coordination only; enforcement remains at each holder's local broker. |
| `RoomEvent` | `event_id`, room, authenticated actor, kind, target ref, causal parents, server time, payload digest, minimized payload | Append-only application event record; page-derived fields are marked untrusted. |
| `Grant` | grantor owner, grantee member/key, site/path/action set, expiry, use count, revocation/version | Separate owner-controlled capability; room membership and claims never imply a grant. |

Never store or broadcast cookies, typed values, hidden input values, passwords, raw screenshots, terminal bytes, or provider credentials. The first release should not store full page text; use bounded user-approved excerpts or hashes where evidence is needed.

## States and transitions

Room: `created -> invite_pending -> active -> closing -> closed`; `revoked` is a terminal security state. Invitation acceptance is authenticated and one-time. A member can leave without closing the room. Owner removal revokes their room session and expires their ephemeral claims.

Member: `invited -> accepted -> joining -> active -> reconnecting -> left`; `denied`, `expired`, and `revoked` are terminal. Reconnect requires a newly minted short-lived credential and a fresh membership check; reconnect does not renew grants implicitly.

Tab: `unbound -> offered -> joined -> navigating -> diverged -> left`. A navigation epoch increments on full navigation and detectable same-document route changes. Origin/path changes invalidate page-scoped claims and pause actions until each local owner re-confirms the page group.

Claim: `free -> held -> shared -> releasing -> free`; expiry, tab close, member removal, lease loss, or navigation releases it. Two agents may claim distinct fields in one form. Form or tab claims conflict with their contained scopes. Sharing a claim adds an explicitly named holder but does not change the local broker's owner or action authority.

## Message flow

1. Owner creates or accepts an invitation to a workspace conversation; the app records membership and binds it to authenticated user/connection IDs.
2. Each browser requests a short-lived browser credential from the app, opens its own relay socket, and authenticates. The relay must bind principal/workspace from the credential rather than trusting frame fields.
3. Each extension joins the room and advertises a minimized page identity (`origin`, normalized `path`, opaque tab ref, navigation epoch). The UI shows “same URL / page state may differ” until the peers explicitly pair their tabs.
4. Presence, messages, cursor rectangles, claims, and release events are delivered in order per room. The server attaches canonical actor identity, sequence, and event ID; clients reject stale sequence/replay IDs.
5. A claim is coordinated through the room, then independently enforced by every local broker that will act. Before any action, the broker re-checks its own origin, path, navigation epoch, claim lease, local grant, and any required owner approval.
6. Findings and replies reference causal event IDs. A human message that changes an agent's goal is a new intent revision, not a silent overwrite. Owner stop-all is local and immediate; a room-wide stop request fans out, but cannot re-enable an owner node.

## Security requirements

- Authenticate every browser and bridge socket with short-lived, audience-bound credentials; bind the authenticated actor and workspace to the socket once and ignore caller-supplied sender IDs.
- Authorize membership and room/topic access on snapshot, subscribe, post, claim, grant, and export. Guessing a room UUID must reveal neither existence nor content.
- Separate four concepts: membership (may join), grant (may act on a site), claim (avoid collision), and approval (owner authorizes one risky operation).
- Keep site grants owner-local by default. A cross-owner grant requires a separate, explicit, expiring grant from the owner of the target browser; never inherit grants through team membership.
- Bound payload sizes, rate-limit cursor/presence, deduplicate message IDs, enforce per-sender monotonic sequence, and persist replay state for durable events.
- Treat page text, titles, selectors, screenshots, and remote findings as untrusted. Do not let them modify policy, identity, grants, or approvals.
- Record an append-only event stream with authenticated actor, causal parents, and digests. Until a signing/anchoring key is deployed, describe it as tamper-evident only within its stated threat model, not tamper-proof.
- Disconnect, timeout, origin/path drift, browser restart, revoked member, and owner kill-switch all fail closed for new page actions. Pending remote actions become `outcome_unknown` if delivery may have happened; never auto-repeat an irreversible action.

## Edge cases and expected behavior

- Same URL but different login/account/data: show separate owner/session indicators; never imply state synchronization.
- Redirect or SPA route change during an action: stop before dispatch if detected; otherwise do not retry, mark the result uncertain, invalidate claims, and require a fresh snapshot.
- Two owners claim the same field or overlapping form/tab scope: deterministic server conflict response; no “last writer wins.” Distinct field claims can coexist.
- Claim holder disconnects: short lease grace for reconnect, then expire and broadcast release; never retain indefinitely.
- Owner closes the tab or extension: that owner's tab membership and local claims end; other peers may continue only on their own tabs.
- Room invite forwarded or replayed: single-use invite bound to intended identity, room, expiry, and capability set; reject replay.
- Relay unavailable: local read/preparation may continue; no cross-owner action is claimed as coordinated and no remote grant or approval is inferred.
- Stale/out-of-order presence: ignore by sequence and expiry; do not resurrect a departed member from a delayed frame.
- One owner's kill switch: immediately blocks that owner's local actions, while broadcasting a stop notice; remote peers cannot clear the switch.
- Export request: only an authorized room member can export; redact page-derived sensitive data and preserve causal links plus actor provenance.

## Rollout and proof gates

1. Approve this model and select whether v0 requires both owners to open the same URL themselves (recommended) or permits one owner to invite another into an already-open tab.
2. Add membership-bound browser credential tests and unauthorized-room denial tests.
3. Build a local relay integration test with two distinct authenticated principals and two browser clients before any production pilot.
4. Demonstrate presence, message delivery, field-claim conflict, distinct-field concurrency, lease expiry, path drift, and local owner stop across two machines.
5. Only then expose the room UI or claim “cross-machine multiplayer”; document that remote members never receive the owner's browser credentials or automatic action authority.

## Approval boundary

Step 1 only is implemented locally; no migration has been applied. Before implementing invite acceptance or cross-machine coordination, approve the “both owners open the same URL in their own browser” v0 boundary, or specify another sharing model. The current same-token two-socket relay smoke check is transport evidence only, not proof of two-owner or two-machine membership.
