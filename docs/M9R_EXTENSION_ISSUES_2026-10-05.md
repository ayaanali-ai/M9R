# Browser extension issue audit — 2026-10-05

Scope: the loaded Chrome extension, extension source, shared pill adapters, approval UI, injection lifecycle, and desktop suppression. This is a confirmed finding list, not a claim that every possible defect has been discovered.

| Priority | Finding and evidence | Status |
| --- | --- | --- |
| P0 | Live pill authenticates and then disappears. Current X host reports `L1XN;A1X;L2PR;R1P;`, `m9rPillFrame=retrying`; no visible M9R pill. The page-origin load follows authentication and closes its channel. Earlier URL guards have not produced a demonstrated live recovery. | Open; needs actual document/navigation evidence before another guard is considered a fix. |
| P1 | Chrome loads `C:\RunLeak\runleak-launch\extensions\browser`; managed updater writes `%LOCALAPPDATA%\M9R\extension`. Chrome's extension registration was inspected with a targeted JSON read. Updating the managed folder alone leaves the running extension stale. | The managed folder has the current `index-B3dmoCIg.js`/`index-F2OiyVMq.css` bundle and no retired New Tab files. The Chrome launch copy still contains older `index-B_JN8rjq.css`/`index-C4qe4DM1.js` plus extra prior bundles, so the running extension remains a separate stale copy until it is synchronized and reloaded. |
| P1 | Static dev manifest injects on all HTTP/HTTPS sites; bridge also registers the same scripts dynamically for granted sites, excluding only loopback. Duplicate execution replaces overlays and restarts their iframe lifecycle. | Fixed locally: skip static coverage and remove overlapping persisted registration. New regression passes. Live effect pending. |
| P1 | Approval UI called `transport.decide` without awaiting or catching it, immediately removed the request, and played success even on rejection. | Fixed locally: await acceptance, retain request on failure, report error, prevent concurrent decisions. Needs dedicated UI rejection verification. |
| P1 | Shared pill could not typecheck: desktop stage response type omitted `capture` and `cursor` even though both were accessed. | Fixed locally; TypeScript and browser bundle build pass. |
| P2 | Browser transport subscription provides no disposal and schedules reconnect forever, retaining listeners/timers after consumers stop. | Fixed locally: dispose timer/port and ignore callbacks from stale ports. Existing shell tests pass; dedicated reconnect/disposal coverage remains. |
| P2 | Broker emits `m9r-broker` connected/disconnected messages; extension adapter processes only `ui-state`. Pill gives no connection state and can keep stale agents/approvals after disconnect. | Open; needs a connection state in the shared UI contract. |
| P2 | Initial thread snapshot becomes a baseline in `AppState.apply`; only subsequent replies are appended to `chatHistory`. Reloaded browser chat therefore loses the already available conversation. | Open; restore initial history without replaying arrival effects. |
| P2 | Retry counter is diagnostic only; frame authentication retries have no maximum. Also a retry assigns a URL but schedules no further timer itself, so if no load arrives it stalls at `retrying`. | Open; bounded recovery and explicit stalled-load handling required. |
| P2 | `resume()` treats any non-null port with `ready=true` as healthy, without a port acknowledgment/liveness check. | Open; require a measured acknowledgment before using this as recovery evidence. |
| P2 | When deciding fails, the retained approval is correct, but its error is recorded in chat while the current view remains approval. | Open UX follow-up: render the failure beside the approval so the owner sees it immediately. |

Earlier scoped repairs remain in the checkout: top-centre default, messaging shortcut support for the one pill, suppression across layouts, desktop collapsed heartbeat, and ticker identity reset. They are not all live verified.

## Verification

- Browser pill `build:ext` passes, including TypeScript.
- Frame lifecycle suite: 9 passing.
- Existing shell/desktop presence/dock/bridge suite: 33 passing before the additional injection regression.
- Bridge suite after injection regression: 7 passing.
- `git diff --check`: no whitespace errors; existing CRLF warnings remain.
- Live messaging delivery, approval acceptance/refusal, microphone, tab switching, desktop handoff, and visual responsiveness remain unverified while the live frame is hidden.

## Next execution order

1. Deploy the injection repair and rebuilt pill together into Chrome's actual loaded folder.
2. Reload once and collect the frame load/navigation sequence. Verify a visible stable pill before UI sign-off.
3. Verify rejected and accepted decisions and messages in a controlled local fixture.
4. Repair connection status and initial conversation hydration; verify reconnect, tab switching, and desktop handoff.
