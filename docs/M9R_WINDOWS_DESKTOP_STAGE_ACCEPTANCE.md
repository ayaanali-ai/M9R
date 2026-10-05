# M9R Windows desktop stage — lifecycle foundation

**Status:** **PARTIAL — implementation started, not signed off**
**Date:** 2026-10-04
**Roadmap:** Track A step 3 / master P3

## What this slice does

- Adds a local stage registry under the current user's M9R state directory. A stage names a Windows virtual-desktop GUID and may store one anchor PID/window handle. The mapping stays on this machine. Version 1 anchor-based registries migrate in memory and are written as version 2 on the next change.
- Adds a narrow native helper request for inspecting an exact window's virtual-desktop GUID and current-desktop status, and for moving that exact window to a known GUID.
- Adds owner-only `create` and `activate` operations. Creation leaves the user's original desktop active; activation is a separate explicit command.
- Checks that the HWND is still valid and belongs to the supplied PID before reading or moving it. A move is accepted only when a follow-up read confirms the requested desktop GUID.
- Exposes owner-terminal commands: `m9r web stage list`, `create <name>`, `register <name> <pid> <window-id>`, `inspect <name>`, `activate <name>`, `return <name>`, `move-window <name> <pid> <window-id>`, and `forget <name>`.
- Refuses creation, activation, registration, and window movement when invoked from an agent context or without an interactive owner terminal.

`create <name>` creates a desktop and records its GUID plus the desktop that was active before creation, without switching the user away from it. The local M9R name is authoritative; Windows may display its default desktop number. `activate <name>` is the explicit user-requested switch. `return <name>` returns to that saved pre-creation desktop. `register` still adopts an existing desktop from one of its windows and has no saved return target.

## Windows API boundary

Window inspection and movement use Microsoft's public `IVirtualDesktopManager` interface. Microsoft documents only `GetWindowDesktopId`, `IsWindowOnCurrentVirtualDesktop`, and `MoveWindowToDesktop` on that interface; it does not expose desktop creation or activation.

Creation, enumeration, and activation use the Windows shell's internal `IVirtualDesktopManagerInternal` COM service. This API is undocumented and not a Windows compatibility contract. Its COM interface identifiers and vtable changed between Windows builds; this first adapter supports only the 24H2/25H2 interface family and is disabled except on Windows 11 build baselines 26100 and 26200. A live owner-session test is still required before calling the desktop lifecycle accepted on either baseline. Future or unlisted builds fail closed.

## Verification recorded

- `cargo build --release --manifest-path native-input-host/Cargo.toml` passed on this Windows machine, and `npm run typecheck` passed after the lifecycle changes.
- The Rust and TypeScript test sources cover GUID/handle validation, build gating, registry migration, owner-only creation/activation, exact PID/window routing, and move destination verification. They were not rerun after the final interface-layout and return-target edits.
- Live owner-session desktop creation, activation, move, and return checks remain necessary before this stage is signed off.

## Still required for Track A step 3

- Integrate the approved Cua Driver cursor primitive into M9R's local Windows runtime and prove its cursor state/visible movement on an owned stage window.
- Run the owner-session acceptance on Windows 11 25H2 build 26200 and confirm create leaves the original desktop active, activate switches to the stage, return restores the original, and cleanup removes only the local mapping.
- Decide whether relying on Windows' undocumented shell COM virtual-desktop API is acceptable for supported product releases; the current native adapter is deliberately experimental and build-gated.
- Extend ownership from one local window mapping to joinable room members and record visible window/desktop transitions in the room activity feed.
- Exercise a real app window on a dedicated virtual desktop, move it to and from the stage, and verify that unrelated owner windows are untouched.
- Complete the Jev-vs-CUA-S1 build/port decision before beginning decision-model routing work.
- Complete the C14 desktop-app Driver validation and scope acceptance.

## Scope and cost boundary

This uses local Windows APIs and the already packaged M9R native-input helper. It adds no hosted resource, Cloudflare Worker, Supabase migration, daemon, login task, or paid service. It does not add Cua Driver as a runtime dependency in this first slice.
