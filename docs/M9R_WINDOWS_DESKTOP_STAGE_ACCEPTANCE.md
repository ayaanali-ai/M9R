# M9R Windows desktop stage — initial foundation

**Status:** **PARTIAL — implementation started, not signed off**
**Date:** 2026-10-04
**Roadmap:** Track A step 3 / master P3

## What this slice does

- Adds a local stage registry under the current user's M9R state directory. A registered stage names a Windows virtual-desktop GUID and stores one anchor PID/window handle. The mapping stays on this machine.
- Adds a narrow native helper request for inspecting an exact window's virtual-desktop GUID and current-desktop status, and for moving that exact window to a known GUID.
- Checks that the HWND is still valid and belongs to the supplied PID before reading or moving it. A move is accepted only when a follow-up read confirms the requested desktop GUID.
- Exposes owner-terminal commands: `m9r web stage list`, `register <name> <pid> <window-id>`, `inspect <name>`, `move-window <name> <pid> <window-id>`, and `forget <name>`.
- Refuses registration and window movement when invoked from an agent context or without an interactive owner terminal.

To register a stage, the owner creates or switches to the desired Windows virtual desktop, opens a window there, and registers that window as the anchor. This code does not create or activate a Windows desktop. The owner uses Windows' native shortcuts (`Win+Ctrl+D`, `Win+Ctrl+Arrow`) for those transitions.

## Windows API boundary

The implementation uses Microsoft's public `IVirtualDesktopManager` interface for `GetWindowDesktopId`, `IsWindowOnCurrentVirtualDesktop`, and `MoveWindowToDesktop`. That interface does not provide desktop creation or activation. M9R does not call undocumented shell COM interfaces for this slice.

## Verification recorded

- Rust native-host tests cover GUID parsing, malformed handles, unsupported operations, and non-Windows fail-closed behavior.
- TypeScript tests cover registry persistence, owner-only changes, exact PID/window routing, destination verification, stale anchor detection, corrupt state, and forgetting only the local mapping.
- The native build and TypeScript typecheck are run before commit; Windows GUI behavior still needs an interactive live acceptance run before this stage is signed off.

## Still required for Track A step 3

- Integrate the approved Cua Driver cursor primitive into M9R's local Windows runtime and prove its cursor state/visible movement on an owned stage window.
- Provide a supported creation and activation workflow with visible stage transitions; this slice intentionally leaves those actions to the owner via Windows shortcuts.
- Extend ownership from one local window mapping to joinable room members and record visible window/desktop transitions in the room activity feed.
- Exercise a real app window on a dedicated virtual desktop, move it to and from the stage, and verify that unrelated owner windows are untouched.
- Complete the Jev-vs-CUA-S1 build/port decision before beginning decision-model routing work.
- Complete the C14 desktop-app Driver validation and scope acceptance.

## Scope and cost boundary

This uses local Windows APIs and the already packaged M9R native-input helper. It adds no hosted resource, Cloudflare Worker, Supabase migration, daemon, login task, or paid service. It does not add Cua Driver as a runtime dependency in this first slice.
