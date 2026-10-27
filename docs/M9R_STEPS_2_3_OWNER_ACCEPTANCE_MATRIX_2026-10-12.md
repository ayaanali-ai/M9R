# M9R Steps 2-3 Owner Acceptance Matrix

**Prepared by:** Claude, as the read-only parallel task authorized in
`M9R_CUMULATIVE_RELIABILITY_AND_DEMO_TRACKER_2026-10-10.md` Section 9 ("Claude —
isolated current task"). This file does not edit the tracker and makes no claim
about runtime/stage/bridge/extension/installer behavior; it only defines test
cases. No code, config, or tracker content was changed to produce it.

**Purpose:** The tracker's six-step owner card (Section 7) proves the product
works end to end at a high level. This matrix is narrower and more granular:
it targets Steps 2 (capability-based route selection) and 3 (generic input
semantics and backends) specifically, using varied natural-language tasks an
owner can actually run, each with one observable pass/fail signal. Its job is
to surface exactly *where* a route or capability claim breaks, not just
whether the demo as a whole works.

**How to use this:** Run each case as a real prompt to a connected agent, on
the real machine, through the real product surfaces -- not a script, not a
fixture. Record PASS, FAIL, or BLOCKED (and why) next to each case. A case
cannot be marked PASS from reasoning about the code; it requires the stated
observable signal actually occurring once, live.

**Does not replace:** the six-step owner card (Section 7), Step 6 live
acceptance, or any of Codex's existing fixture suites. This is an additional,
narrower layer aimed at exactly the two steps the tracker currently marks
PARTIAL.

---

## A. Desktop app-window route (Step 3: generic input semantics)

| # | Natural-language task | Exercises | Observable pass signal | Observable fail signal |
|---|---|---|---|---|
| A1 | "Open Notepad and type 'm9r test one' into it." | App discovery, launch, exact-window identification, caret insertion | Text appears once in Notepad, caret insertion (not whole-field replace), no duplicate text | App doesn't launch; text missing; text duplicated; wrong window receives input |
| A2 | "In that same Notepad window, select all the text and replace it with 'replaced'." | Explicit whole-value replace vs. insertion distinction | Entire field content becomes exactly "replaced" | Insertion appended instead of replacing; partial replace; wrong control targeted |
| A3 | "Right-click inside Notepad's text area." | Right-click semantics on an exact app-window backend that supports it | Context menu appears | No menu; left-click behavior substituted silently; error without explicit "unsupported" message |
| A4 | "Open File Explorer, click into the address bar, and type a folder path." | Exact-window click + caret targeting on a different app than A1 (no app-name special-casing) | Address bar receives focus and text, same behavior class as A1 without app-specific code path | Works in Notepad but not Explorer (would indicate an app-name allowlist, which the tracker says must not exist) |
| A5 | "Scroll down one page in a long document or window." | Explicit scroll unit (`page`) and single-axis-per-operation | Scrolls exactly one page, vertical only | Scrolls by pixel/line instead of page; scrolls both axes; silently no-ops |
| A6 | "Click a UI element that has no accessible label or role (e.g. a custom-drawn control)." | Fallback to exact-window background coordinate click when accessibility resolution fails | Click still lands via the CUA background coordinate fallback, confirmed by the resulting UI change | Silent failure; falls back to full-desktop/global input instead of staying scoped to the exact window |
| A7 | "Try to type into a window that isn't focused/selected yet, without selecting it first." | Key/caret input withheld until confirmed target selection | Action is explicitly refused with a clear reason (no target selected), no input sent anywhere | Input lands in the wrong window; silent no-op with no explanation |

## B. Browser-tab route (Step 3: browser click capability gating)

| # | Natural-language task | Exercises | Observable pass signal | Observable fail signal |
|---|---|---|---|---|
| B1 | "Click the search box on [a real site] and type a query." | `nativeClickAvailable` gating. The owner-selected manifest makes Chrome's `debugger` permission required; the quiet-input setting and a valid site grant still gate the browser click route. | With the extension connected, the required permission present, quiet input enabled, and the site authorized, the query appears once and the page cursor shows the action. If any prerequisite is absent, the route explicitly refuses before dispatch with the actual cause. | A false success, duplicate query, physical owner-mouse movement, or silent fallback to desktop input. |
| B2 | Only after an explicit browser-route refusal: "Okay, do it through the desktop window instead." | A distinct re-plan handoff (restore/select the existing browser -> fresh exact `app-window` observation -> choose the generic desktop route); never an automatic same-action retry. | The agent explains the route change, captures a fresh exact window, and the separate desktop action produces the requested visible effect. | Reusing stale browser coordinates/refs, silently replaying the same action, or claiming success without an observed effect. |
| B3 | "Select this paragraph of text on the page." (where the page has real selectable DOM text) | Browser text selection via fresh element ref, including nested text nodes | Visible selection highlight appears over the exact requested text | Wrong text selected; selection fails silently; offset is off by one node |
| B4 | "Scroll down on this webpage." | Browser vertical pixel scroll vs. desktop's line/page units | Page scrolls vertically, amount is sane and in pixels (not jumping a full screen or not moving) | Wrong axis scrolls; scroll amount is nonsensical |
| B5 | "Go to [a page known to be restricted, e.g. a browser internal page like chrome://settings]." | Restricted-page refusal without fallback | Explicit refusal naming the page as restricted; no desktop-stage input substituted | Agent silently tries another route; agent reports success despite doing nothing |
| B6 | "Drag this item to that drop target." (on a page with two real draggable/droppable elements) | Drag requiring at least two enabled targets with fresh bounds | Visible drag completes, item relocates | Drag no-ops; wrong element moves; stale bounds cause a miss |

## C. Route-selection and capability-mismatch (Step 2)

| # | Natural-language task | Exercises | Observable pass signal | Observable fail signal |
|---|---|---|---|---|
| C1 | "Middle-click this link to open it in a new tab." (on desktop-wide target, not an exact app-window) | Desktop-wide targets correctly advertise middle-click as unsupported | Explicit "unsupported" refusal, no click sent | Silent failure; left-click substituted without saying so |
| C2 | "Switch to the browser tab I had open about [topic], then click something in it." | Capability-based route selection choosing `browser-tab` -> M9R browser broker correctly, and switching away from a stale `app-window` target | Correct tab is activated and the subsequent action targets it | Wrong tab/window targeted; action silently lands on the previously active window instead |
| C3 | "Do the same multi-step task twice in a row with identical instructions." | No automatic retry duplicating an effect; stale refs trigger re-observation instead of blind reuse | Second run re-observes current state and behaves correctly (e.g., doesn't double-submit a form); or explicitly explains it's a no-op this time | Action is duplicated (e.g., two form submissions from one request) |
| C4 | "Open an app, close it mid-task, then ask for another action in the same window." | Stale-window/stale-ref refusal | Explicit refusal citing the window no longer exists, no fallback to global input | Silent failure; input dispatched to the wrong/closed window handle |

---

## Notes for whoever runs this

- Cases **B1/B2** are the highest-value route pair: B1 checks the connected extension path when Chrome's required permission, quiet-input opt-in, and site grant are all present (and truthful refusal when one is absent); B2 checks a separate, fresh-observation handoff to generic desktop control after refusal. Do not expect B1 to refuse when all prerequisites are met, and do not count a silent cross-route replay as success.
- Any case that silently appears to succeed without the stated observable signal should be treated as more concerning than an explicit failure -- the tracker's standing rule is that a route must never silently fall back to shared OS input or claim an unverified effect.
- Record build ID / installed runtime hash alongside results (per the tracker's existing convention) so a result can be tied to the exact code it tested.
