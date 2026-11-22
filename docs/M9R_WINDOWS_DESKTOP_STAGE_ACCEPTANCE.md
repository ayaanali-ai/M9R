# M9R Windows desktop stage acceptance

**Updated:** 2026-11-04
**Current status:** source uses one owner-visible Windows desktop and exact
window identities. Live acceptance is pending; historical virtual-desktop
results do not prove the current implementation.

## Current contract

- A stage is an M9R local name and exact window binding. It does not create or
  switch Windows Task View desktops and does not move a window to another OS
  desktop.
- The binding is an exact PID/HWND plus process-generation evidence when the
  operating system provides it. The helper validates that identity before
  capture, semantic invocation, foreground activation, or input.
- `desktopStructure` is a UIA read of the interactive Windows shell. A
  `captureDesktop` image is the physical multi-monitor virtual screen. Neither
  operation reads or changes Task View desktop membership.
- `roomDesktopId` is a random M9R coordination key retained for room lease
  compatibility. It is not a Windows desktop GUID and is never used to choose
  or move an OS desktop.
- Supported UIA patterns are preferred when the target exposes them. Physical
  input uses the M9R native host and a short shared foreground-input lease; it
  is not headless. Cua remains limited to the labeled cursor presentation.

## Retired paths

The former `native-input-host/src/virtual_desktop.rs` implementation, its
Windows desktop create/inspect/activate/move operations, the pill's
`desktop_stage_action` bridge, and the virtual-desktop owner-proof script were
removed. The old October 2026 owner proof described that retired implementation
and is not acceptance evidence for this source.

The pill no longer offers a local stage roster or Join/return controls. Agent
tasks continue through the broker's native stage and action APIs.

## Required source gates

- TypeScript typecheck.
- Native host format check, release build, and release tests.
- Focused desktop-stage/action tests and the full project test gate, with
  baseline failures named rather than silently treated as passes.
- Engine and candidate build with matching source/runtime/artifact manifests.

## Owner-machine acceptance after candidate review

Run one task per surface and retain the task IDs/raw stage receipts:

1. Open Notepad, type and save a harmless text file, close and reopen it, then
   verify the content.
2. Repeat a text edit in the installed modern Notepad.
3. Open Explorer and navigate/scroll a folder without changing unrelated
   windows.
4. Launch Calculator from a clean state, confirm its exact window, calculate a
   harmless expression, then minimize/restore it.
5. Use an existing signed-in browser window, verify the exact selected window
   and tab, and perform a harmless search.
6. While a task is active, move the owner's physical pointer and send a
   continuation/redirect; verify input receipts and the final observed state.

Record OS-level delivery separately from visible post-action confirmation.
Do not claim live success from source tests or the retired October proof.
