# M9R local Node boundary

**Decision record:** 2026-10-05<br>
**Status:** specified; implementation changes are intentionally separate

This document defines what “M9R Node” means for the local owner machine. It
prevents a second runtime package from being created before the process,
credential, and authority boundaries are understood.

## Definition

The **M9R local Node** is the owner-machine control plane that starts and
supervises M9R's local processes and connects them to the hosted M9R network.
It is a Node.js runtime delivered by the packaged engine/CLI and managed by the
desktop shell or an explicit CLI command. It is not a hosted Worker and it is
not the `@m9r/runtime-core` contracts package.

The current implementation already contains most of this control plane:

- `scripts/m9r-cli.ts` starts `terminal runtime` and the packaged engine.
- `createResidentSupervisor` owns one provider resident per configured profile.
- Resident processes run provider-specific work, heartbeat, and result loops.
- The local bridge and feed publish bounded presence and activity state.
- The web broker owns the owner-scoped local browser transport and extension
  connection.
- Watchdog and stale-build handling recover or stop local processes without
  silently duplicating them.

This is a boundary specification, not a claim that every lifecycle below is
already accepted in a clean-machine or live multi-provider run.

## Responsibilities

| Area | Local Node owns | Source of authority |
| --- | --- | --- |
| Process lifecycle | Start, stop, bounded restart, stale-build restart, and failed-state reporting for the engine and configured provider residents | Local process state and supervisor snapshot |
| Provider discovery | Explicit detection/configuration of installed provider CLIs and registered profiles; no unbounded background process scanning | Local configuration and an explicit CLI/desktop request |
| Provider sessions | Launch the configured resident for a provider profile, attach its scoped credential at runtime, send heartbeats, and return structured results | Provider process plus local resident protocol |
| Local IPC | Serve authenticated loopback/named-pipe/WebSocket clients for the desktop, CLI, broker, and provider bridges | Versioned local protocol and owner-scoped credentials |
| Presence and activity | Convert local lifecycle, heartbeat, feed, and provider events into bounded working/idle/waiting/offline signals | Local event/feed state; hosted presence is a projection |
| Browser broker | Start or connect to the separate local broker, keep its owner key protected, and expose browser actions only through the broker authority checks | Broker authority snapshot and owner approval state |
| Local state | Maintain `.m9r` configuration, locks, journals, capture queues, and bounded recovery metadata without writing provider secrets into config or logs | Files owned by the current OS user |
| Hosted connection | Authenticate requests to M9R Cloud for presence, messages, tasks, results, and room events; retry with bounded backoff | Cloud API/relay is authoritative for hosted room state |

## Explicit exclusions

The local Node does **not**:

- become a second implementation of `@m9r/runtime-core`;
- own Cloudflare Worker code, Supabase schema, hosted room membership, or
  authoritative hosted event history;
- proxy provider model APIs or pool provider subscription credentials;
- expose provider credentials, broker keys, page contents, screenshots, or
  typed text to the browser extension or a remote room member;
- grant remote users control of the owner's browser, desktop, filesystem, or
  approvals;
- discover and launch arbitrary executables from network or database input;
- replace the browser extension, desktop overlay, Cua Driver adapter, or
  Cloudflare scheduler with another copy of their UI/runtime logic;
- promise symmetric Claude/Codex/OpenCode handoff until the capability matrix
  has separate evidence for each direction; or
- silently migrate, delete, or reorganize existing `.m9r` state or user
  configuration during startup.

## Process topology

```text
Desktop overlay / explicit CLI
              |
              v
       M9R local Node (engine)
        |       |       |
        |       |       +--> local feed / presence / journals
        |       +----------> authenticated hosted M9R API/relay
        +--> resident supervisor
                |       |       |
                v       v       v
             Claude   Codex   OpenCode residents

Browser extension <--> local web broker <--> owner-authorized browser transport
```

The browser broker is a companion local service with its own HTTP, extension
WebSocket, and owner-pipe boundary. The Node may supervise or start it, but the
broker remains the authority for browser claims, approvals, and page actions.
The extension never becomes a provider process manager.

## Lifecycle contract

### Start

1. Resolve the packaged engine and project root.
2. Load `.m9r` configuration and validate profile names, provider kinds, and
   repository bindings.
3. Load or create owner-scoped local credentials with owner-only ACLs.
4. Start the local broker and bridge endpoints on loopback/owner IPC only.
5. Start one resident per configured provider profile.
6. Start watchdog, feed, capture, and bounded recovery loops where enabled.
7. Publish local readiness only after the local endpoints have passed their
   handshake checks.

### Reconcile

Configuration changes are explicit. A refresh may add or remove a named
profile, but it must not kill unrelated provider sessions or create a second
engine. Removed profiles are stopped and marked stopped; added profiles are
started only after validation.

### Failure and recovery

- Provider exits are retried with bounded exponential/backoff behavior and a
  visible failed state after the configured restart budget is exhausted.
- A deliberate stale-build exit is an immediate supervised restart and does
  not consume the crash budget.
- Hosted or broker outages produce disconnected/unknown state until a real
  handshake succeeds; they must not be rendered as idle.
- Recovery never repeats an irreversible browser action merely because the
  delivery result is unknown.

### Stop

1. Stop accepting new local work.
2. Cancel timers and watchdog ownership.
3. Ask residents and broker sessions to stop; then terminate only processes the
   Node owns.
4. Publish offline/disconnected state where the hosted connection is available.
5. Preserve user configuration, journals, and changed files.

## Initial local API surface

This is the minimum boundary the implementation must converge on. It is not a
new public network API.

| Operation | Caller | Required result |
| --- | --- | --- |
| `status` | Desktop, CLI, owner pipe | Version, process health, provider states, broker readiness, and explicit unknown/error reasons |
| `profiles.list` | Desktop, CLI | Validated configured profiles with redacted provider identity and lifecycle state |
| `profiles.reconcile` | Explicit owner action | Add/remove/update named profiles; return per-profile actions and failures |
| `runtime.stop` / `runtime.restart` | Desktop, CLI, owner action | Stop/restart only the Node-owned processes and return a bounded outcome |
| `provider.retry_failed` | Desktop, CLI | Clear the named resident's restart budget and report which profiles were retried |
| `broker.status` | Desktop, extension, owner pipe | Ready/disconnected/unknown state; no browser mutation through status |
| `feed.subscribe` | Desktop, extension, local UI | Bounded activity/presence snapshots with explicit provider and connection state |
| `hosted.publish` | Internal bridge only | Authenticated presence/message/task/result publication with redaction and idempotency |

All mutations require a local owner context or an already-authorized provider
session. Browser actions continue through the broker's authority/approval path;
the Node API must not add a bypass command.

## Ownership and implementation rule

For the next implementation slice, extend the existing engine/CLI, resident
supervisor, bridge, and broker contracts where evidence shows a missing piece.
Do not create `packages/node`, a second “runtime-core,” or a new daemon until a
concrete missing operation cannot be represented by this boundary and its
versioned local protocol.

## Acceptance gates for this item

Item 4 is complete as a specification when the following are true:

- the owner-machine process owner is distinct from Cloudflare and
  `@m9r/runtime-core`;
- provider, broker, feed, hosted, and credential boundaries are explicit;
- start/reconcile/failure/stop behavior is defined;
- the local API names callers, authority, and redaction requirements; and
- no implementation package is added solely to give the boundary a name.

The specification does not claim that the provider matrix, OpenCode activity,
clean-machine setup, or live desktop acceptance is complete. Those are later
items in the cleanup proposal.
