# Quiet mode: agent input that never touches the user's mouse, keyboard or focus — design

Status: **design for approval, nothing built.** Written 2026-10-02. Evidence: Q0 prototypes (docs/m9r-quiet-agents-and-pill-plan.md sections 7 and 8), Cua's published driver docs, and a read of the current extension code.

## 1. Goal and non-goals

Goal: every agent click, keystroke and scroll in the user's signed-in Chrome is delivered without moving the OS cursor, stealing focus, or needing Chrome in front, while keeping every existing safety rule (site grants, owner stop switch, risky-action approval, one-writer-per-tab). Agents' cursors are our own overlay only.

Non-goals: desktop-app control, a new browser, copying the user's profile, raw CDP access for agents, any hosted service.

## 2. What happens today (verified in code)

- [background.js:683](../extensions/browser/src/background.js) treats `click, click_at, double_click, right_click, download, submit, buy, post, follow, like, dm` as "native click" actions: plan the target ([`m9rPageClickPlan`](../extensions/browser/src/background.js)), glide the overlay, then send a **real OS click through the native host** ([native-input-client.js](../extensions/browser/src/native-input-client.js), [win32.rs:377](../native-input-host/src/win32.rs)), which needs Chrome in front. This is why every agent click moves the user's mouse.
- Safety envelope around that step, all of which must carry over unchanged: host grant re-checked (`hasHostPermission`), grant origin and path prefix, URL unchanged since planning, owner stop switch (`actionsStopped`), target validated before mouse-down, the tab must be the visible active tab, one native click at a time, cancellation.
- Other actions (`press`, drag/drop, `type`, `select`, scroll) run as DOM events in the page (`trusted: false`).
- Agent cursors and halos are in-page overlays ([presence-overlay.js](../extensions/browser/src/presence-overlay.js)).
- The broker serialises contested targets per tab (turn scheduler) and routes commands to the extension; results come back as `{ ok, data | error }`.

## 3. Delivery routes

Three routes, chosen per action, reported on every result as `route`:

| Route | How | Trusted | Moves OS cursor / needs focus | Used for |
|---|---|---|---|---|
| `quiet` (new default for pointer and key input) | `chrome.debugger` + CDP `Input.dispatchMouseEvent`, `dispatchKeyEvent`, `insertText` | yes | no / no | click, double and right click, hover, type, key presses, drag where supported |
| `dom` | content-script events (today's non-click path) | no | no / no | reads, snapshots, `select`, scroll fallback, anything a page accepts untrusted |
| `native` | OS `SendInput` through the native host | yes | yes / Chrome in front | opt-in fallback only, with save, bring-forward, restore of the previous window and a re-activation guard |

Rule: never escalate silently. A route that cannot run returns a structured refusal (section 6) and the caller (agent or owner) decides; `native` runs only when the owner enabled it for that site or the action explicitly asked for `delivery: "foreground"`.

## 4. Quiet-input session manager (new `src/quiet-input.js`)

State per tab: `{ tabId, attached, attachedAt, lastActionAt, focusEmulation, idleTimer, state }`, `state` in `detached | attaching | ready | cancelled | blocked`.

- **Attach on demand** at the first quiet action for a tab, only while the broker has granted the tab claim to the acting agent. `Emulation.setFocusEmulationEnabled(true)` on attach so a covered or unfocused window still behaves as focused (Q0: required for scroll in an occluded window under default Chrome flags).
- **Detach after idle** (default 4 s of no actions, configurable) so Chrome's "started debugging this browser" banner only appears around agent work; Q0 measured it disappearing 1.5 to 3 s after detach.
- **One attachment per tab, shared by all agents.** The broker's scheduler already serialises actions on a tab; the session manager never interleaves two actions.
- **Lifecycle events:** `chrome.debugger.onDetach` with reason `canceled_by_user` means the owner clicked the banner's Cancel: mark the tab `cancelled`, refuse further quiet actions on it with `debugger_cancelled`, show it in the pill, and re-enable only when the owner re-enables. `target_closed` and navigation to a page the debugger cannot attach to (`chrome://`, the Web Store, other extensions' pages) end the session; the next action returns `restricted_page`. Cross-site navigation inside an attached tab keeps the attachment; re-run focus emulation after it.
- **Conflicts:** attach failure "another debugger is attached" (DevTools open, another extension) returns `devtools_open` and offers the route choice; never detach someone else's session.
- **Service-worker restarts** (MV3 suspends workers): on wake, enumerate `chrome.debugger.getTargets()` for our attachments and adopt or detach them; never leave an orphaned attachment.

## 5. CDP policy (what the extension may send)

Fixed allow-list, enforced in one place, never exposed to agents: `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`, `Input.dispatchDragEvent` (if the drag work succeeds), `Emulation.setFocusEmulationEnabled`, `Page.handleJavaScriptDialog` (owner or approved agent only), and a short list of read-only `Runtime.evaluate` helpers that are our own code, not agent-supplied. CDP grants broad authority (cookies, storage), so `Network.*`, `Storage.*`, `Fetch.*`, arbitrary `Runtime.evaluate`, and target manipulation are refused by construction. Commands are accepted only from the broker connection that the existing nonce and identity checks already guard.

## 6. Permissions and consent

- Ship `debugger` as an **optional permission**, not an install-time one, so the Web Store install warning and review risk do not grow. A "Turn on quiet mode" button on the existing permission page asks for it with a user gesture and explains the browser banner in one sentence. Until it is granted, behaviour is exactly today's.
- Quiet actions still require the same per-site grants; the debugger never widens which sites an agent may act on.
- The risky-action pause (approvals for buy, post, send, delete) is unchanged and runs before dispatch.

Refusal codes (stable strings in `error.code`, plain sentence in `error.message`): `quiet_not_enabled`, `debugger_cancelled`, `devtools_open`, `restricted_page`, `tab_not_attachable`, `dialog_open` (with the dialog text so the agent can respond), `route_unavailable_for_action` (e.g. wheel scroll in a hidden tab), `grant_changed`, `url_changed`, `stopped_by_owner`.

## 7. Action flow (quiet route)

1. Existing preflight unchanged: tab exists, grant and path check, owner stop switch, claim.
2. Plan the target in the page (existing `m9rPageClickPlan`): rect, centre point, frame offsets, validation token. For clicks inside same-origin iframes and open shadow roots the plan already yields page coordinates (Q0 passed iframe and shadow cases).
3. Overlay: glide the agent's cursor to the point and show the action label (existing `announce`), without any OS movement.
4. Re-validate immediately before dispatch: URL unchanged, grant still held, target still under the point.
5. Dispatch `mouseMoved`, `mousePressed`, `mouseReleased` (double click: `clickCount` 1 then 2; right click: `button: "right"`). Typing uses `insertText`; shortcuts and special keys use `dispatchKeyEvent`. Measured cost: 2 to 3 ms per mouse event, about 16 ms per `insertText`.
6. Observe the effect with the existing page-change detection and return `{ ok, data: { route: "quiet", trusted: true, ...effect } }`.

## 8. Known gaps and how each is handled

| Gap (Q0 evidence) | Handling |
|---|---|
| Wheel scroll does not run in a hidden or fully covered tab without focus emulation, and not at all in a background tab | focus emulation on attach; for a hidden tab use programmatic scroll (`dom` route) and report `route: "dom"` |
| Native HTML5 drag and drop failed with plain mouse events; one attempt at the drag-intercept API did not fire | experiment matrix (intercept variants, `dispatchDragEvent` with explicit data, synthetic `DragEvent` sequence via `dom`); until one passes, drag returns `route_unavailable_for_action` with `dom` as the offered fallback |
| JavaScript dialogs block input | surface `dialog_open` with text; add an explicit dialog tool using `Page.handleJavaScriptDialog` |
| Browser zoom, device pixel ratio | CDP uses CSS pixels of the viewport; test at 125%, 150%, 200% before sign-off |
| Cross-origin iframes (out-of-process) | pointer input routes by hit-testing so it works; element lookup inside them needs frame targeting; test explicitly |
| File choosers, downloads, popups opened by a click | keep existing upload and download tools; a popup becomes a new tab that is attached on demand |
| Password and card fields | existing sensitive-field rules unchanged |

## 9. Broker and tool surface

- Add optional `delivery` to the click-like and key tools: `"quiet"` (default when enabled), `"dom"`, `"foreground"` (native, owner-enabled only).
- Add `route` and `trusted` to every action result, `error.code` to refusals, and a one-line guidance in each tool description: do not retry a refused route, do not escalate beyond the failed step.
- Surface route and refusals in `web-activity` so the pill can show a "quiet" badge and a clear reason when an agent was refused.

## 10. Rollout and safety

- Feature flag `quietMode`, off by default; legacy native path unchanged and still the default until the gates below pass. No existing behaviour is removed in this change.
- Rollback is the flag: one setting returns to today's routes.
- Every deployment step follows the same discipline as the broker fixes: clean worktree commit, tests, a spare-port live check, backups.

## 11. Test plan and acceptance gates

Unit: route chooser, session manager against a fake `chrome.debugger` (attach, idle detach, cancel, conflict, worker restart adoption), policy allow-list (every disallowed method rejected), refusal codes.
Live (a promoted version of the Q0 harness, Chrome 154 via `Extensions.loadUnpacked` over a pipe, throwaway profile): capability fixture, a React-controlled form, zoom 150%, cross-origin iframe, DevTools-open conflict, navigation mid-action, covered window, background tab, two agents contending for one tab, stop switch mid-action, banner cancel.
Gates to turn the flag on: all live cases pass with `isTrusted` true, OS cursor and foreground unchanged on every case; broker suite and extension suites green; drag either works or refuses cleanly with a documented fallback; owner has watched one end-to-end run on their own Chrome.

## 12. Files expected to change

`extensions/browser/manifest.json` (optional permission), `src/background.js` (route selection and the native step's replacement), new `src/quiet-input.js`, `src/permission-page.js` and `permission.html` (consent), `src/page-actions.js` (scroll fallback), `src/native-input-client.js` (fallback orchestration), broker `web-broker-core.ts`, MCP tool schemas in `mcp-server.ts`, tests under `scripts/`.

## 13. Decisions needed from the owner

1. Ship quiet mode with `debugger` as an **optional** permission behind an opt-in screen (recommended), or require it at install?
2. When quiet cannot run, should the default be refuse-and-report (recommended) or fall back to a visible native click automatically?
3. Idle detach delay: 4 s (recommended) or longer to avoid banner flicker during long agent runs?

## 14. Owner answers (2026-10-02)

1. `debugger` as an optional permission behind an opt-in screen: **approved**.
2. Refuse-and-report versus automatic visible click: owner asked for an explanation; recommendation updated to "refuse, report, and offer a one-time owner-approved visible click from the pill".
3. Idle detach: owner unsure; recommendation updated to detach 10 s after the last action or when the agent run ends (see the message that explains the trade-off).
