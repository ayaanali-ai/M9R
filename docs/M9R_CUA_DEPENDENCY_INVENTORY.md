# Current Cua dependency inventory

**Updated:** 2026-11-04
**Status:** source audit; live package behavior still requires owner-machine verification.

## Production dependency boundary

The Cua runtime remains only for the labeled cursor overlay. It creates the
presentation session, moves/shows/hides that cursor, reports its position and
visibility, and shuts the presentation session down. A cursor failure must not
dispatch, retry, or block a desktop action.

The source calls in `src/lib/native/cua-stage-driver.ts` are limited to cursor
session and cursor presentation methods. Its `callTool("move_cursor", ...)`
uses are cursor-only. No Cua `click`, `pressKey`, `hotkey`, `typeText`, `scroll`,
`drag`, window discovery, window snapshot, screenshot, or accessibility method
is an input or observation route in the production desktop path.

The `@trycua/cua-driver` package, host process, cursor adapter, and runtime
assets remain because the cursor itself is still Cua-owned. Removing those
would remove the existing visible agent cursor; this inventory does not claim
the cursor replacement artwork is implemented.

## M9R-owned perception and window identity

- `native-input-host/src/shell_accessibility.rs` reads UI Automation structure
  and invokes supported semantic control patterns.
- `native-input-host/src/native_screenshot.rs` captures target windows and the
  physical multi-monitor virtual screen. “Virtual screen” here means the
  Windows coordinate space spanning monitors, not a Task View desktop.
- `native-input-host/src/windows_stage.rs` validates exact PID/HWND identities,
  process generation, visible-window inventory, popups, window state, and
  foreground identity. It does not create, enumerate, switch, or move Windows
  Task View desktops.
- `src/lib/native/windows-desktop-stage.ts` owns the persistent native helper,
  exact-window UIA/screenshot observations, point resolution, and window
  geometry/state bridge.
- `src/lib/native/cua-stage-driver.ts` combines those M9R observations with
  action results and the optional cursor overlay. The target and current UI
  state come from M9R's native host.

## M9R-owned actions

Click, keyboard/hotkey, Unicode text, scroll, drag, window activation/state,
window-frame changes, system controls, and supported UIA Invoke/Select/Toggle/
Value operations are dispatched by `native-input-host` through
`windows-desktop-stage.ts`. Physical `SendInput` paths bring the exact target
window forward under the shared input lease; they are not headless. Cua remains
limited to the labeled cursor presentation. A native OS delivery result and
the later UIA postcondition remain separate signals.

No production compatibility flag re-enables Cua action or perception calls.
The old one-shot virtual-desktop owner proof and pill command were removed;
`scripts/run-step3-owner-proof.ts` is no longer a supported test entrypoint.

## Remaining verification

Source inspection is not live proof. Before promotion, verify a packaged
candidate on the owner machine: native helper persistence, Notepad and modern
Notepad editing, Explorer navigation, Calculator launch/focus, a browser task,
and the visible cursor overlay. Confirm through runtime logs that the cursor
adapter is the only Cua path and that a cursor failure leaves native actions
available.
