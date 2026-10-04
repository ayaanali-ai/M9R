# C2 — quiet typing and drag

Status: complete for the agent-owned Chrome channel, verified live on 2026-10-03.

## Implemented

- Existing typing uses Chrome `Input.insertText`; drag uses trusted CDP pointer input and, for native HTML drag/drop, Chrome's intercepted drag data.
- The dedicated Chrome broker enables one writer per tab in the existing fair turn scheduler. Drag and typing from different writer identities cannot overlap, even when their control scopes differ. The transport also serializes commands per tab.
- Source and destination accept CSS selectors or snapshot refs. Both endpoints must be visible and unobstructed in the same viewport. Hidden, stale or covered targets fail before input.
- Approved origins and granted paths are checked during a drag. Cancellation releases the button, cancels native dragging and disables interception. Local-file drag data is refused.
- Background rendering flags apply only to the dedicated Chrome launch. A drag temporarily uses `Emulation.setFocusEmulationEnabled`, then restores it in `finally`. This simulates active-page rendering; it does not call `Target.activateTarget` or `Page.bringToFront`. A site may observe the emulated focus/visibility while the drag runs.
- Existing MCP `m9r_web_type` and `m9r_web_drag` requests use this transport when configured for the agent Chrome broker. No new input API or Cua source code was copied.
- CLI packaging now includes the Chrome modules and an existing missing `provider-usage-core` dependency. The generated CLI's `web chrome` entry was executed successfully.

## Live acceptance

Local HTTP page, actual headed Chrome, broker `/cmd`, 2026-10-03 17:46:23 UTC:

- Synthetic text: `C2 quiet trusted input`, with trusted input events.
- Pointer drag and HTML drop: trusted events, both successful.
- Two broker writer identities submitted drag and typing concurrently. Observed order: `drag-start`, `drag-end`, `type`; no overlap.
- The operated tab was hidden after input; the separate foreground tab remained visible.
- Evidence: `.m9r/c2-live-acceptance/result.json`.

Public Selenium pages, actual headed Chrome, background tabs, 2026-10-03 17:55:22 UTC:

- `https://www.selenium.dev/selenium/web/formPage.html`: typed `M9R C2 quiet typing` into `#working`; read-back matched.
- `https://www.selenium.dev/selenium/web/mouse_interaction.html`: dragged `#draggable` to `#droppable`; the site's `#drop-status` reported `dropped`.
- No form was submitted and no personal account was used.
- Evidence: `.m9r/c2-public-result.json`.

The first public demo host remained loading and was not counted as a pass. Restricted command-sandbox Chrome also closes unexpectedly; live checks ran outside that sandbox using only dedicated test profiles.

## Executed checks

- Input, broker and turn-scheduler regression suites: 70 passed, no skips.
- Broker-server security/regression suite: 32 passed, no skips.
- Typecheck: passed.
- CLI build: passed; generated `node cli/dist/m9r.js web chrome` printed the expected command help.

Reproduce:

```powershell
node --import ./scripts/register-alias.mjs --test scripts/agent-chrome-input.test.ts scripts/web-broker.test.ts scripts/turn-scheduler-core.test.ts
node --import ./scripts/register-alias.mjs scripts/agent-chrome-c2-live.ts
node --import ./scripts/register-alias.mjs scripts/agent-chrome-c2-public.ts
```

Live runners close only the Chrome processes they launched. Test profiles and evidence remain under `.m9r`.

C1's owner sign-in persistence check remains separate; its live click/type and no-banner checks have now passed outside the restricted command sandbox. C3 readiness is tracked in `docs/M9R_C3_LIVE_TAB_ACCEPTANCE.md`. No merge or push was performed.
