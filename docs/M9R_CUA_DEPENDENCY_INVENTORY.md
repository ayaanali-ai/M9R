# Current Cua dependency inventory

Captured from `codex/final-polish-rebirth` at `d98c0f5c` on 2026-11-03. This is an inventory, not an approval to keep the dependency.

## Cursor presentation (retain temporarily behind one adapter)

- `src/lib/native/cua-stage-driver.ts`: runtime/session creation, cursor enable/disable, cursor motion, cursor state, cursor visibility confirmation, and cursor teardown.
- `src/lib/native/cua-driver-host.ts`: starts the private Cua host process and connects the cursor client.

These calls are presentation-only and may remain temporarily. They must not be used as a permission, targeting, or dispatch dependency.

## Perception supplied by the native host in production

- `windows-desktop-stage.ts` owns `desktopStructure`, `windowStructure`, `captureDesktop`,
  `captureWindow`, `listVisibleWindows`, HWND/process-generation validation, and
  exact foreground/window geometry.
- `cua-stage-driver.ts` uses those native calls first for desktop and app-window
  observations, including popup captures and point resolution.
- The old Cua observation path remains only as an explicit `M9R_ENABLE_CUA_COMPAT=1`
  rollback/test adapter when a native seam is unavailable. Production stages do not
  set that flag.

The native host currently supplies desktop-wide UIA structure, window metadata, HWND/process-generation validation, hit testing, popups, and window geometry, but not the complete exact-window observation/screenshot contract required to remove these calls safely.

## Semantic/action calls supplied by the native host in production

- click, key, hotkey, Unicode text, vertical/horizontal scroll, drag, foreground
  activation, resize, and window state all route through
  `windows-desktop-stage.ts` and `native-input-host`.
- `driverInputAction` no longer calls Cua in production; its compatibility branch
  is reachable only with the explicit rollback flag and only for injected fixtures.
- `set_value` replacement uses native foreground click/select-all/text delivery;
  it is not a Cua semantic action.

## Cursor/presentation and packaging still supplied by Cua (temporary)

- `@trycua/cua-driver` dependency in `package.json` and lockfile.
- The cursor presentation adapter still uses the vendored Cua runtime for its
  labeled overlay and motion. This is presentation-only and is not an input or
  target-selection dependency.
- Cua runtime download, archive extraction, and packaging in `scripts/build-engine.mjs` and `scripts/package-engine-release.ps1`.
- Cua runtime promotion/cleanup in `scripts/accept-overlay-candidate.mjs` and `src/lib/native/native-commands.ts`.
- Cua host metadata/version checks in `src/lib/native/cua-driver-host.ts`.

## Existing M9R-owned native foundation

- UIA desktop structure: `native-input-host/src/shell_accessibility.rs`.
- Window identity, process generation, virtual desktops, hit testing, popups, and window state: `native-input-host/src/virtual_desktop.rs`.
- Foreground activation and SendInput primitives: `native-input-host/src/win32.rs`.
- TypeScript native stage manager: `src/lib/native/windows-desktop-stage.ts`.
- Shared MCP/action contracts, receipts, task context, and multiplayer routing: `src/lib/native/computer-use-contract.ts`, `computer-use-mcp.ts`, `logical-task-context.ts`, and `multiplayer-*` modules.

## Production rule

No new production caller may add a Cua perception/action dependency. The only
accepted runtime dependency is the temporary cursor presentation adapter and its
packaging metadata. The compatibility branch is an explicit rollback/test seam,
not a production route, and must be deleted once the native observation contract
is independently packaged and live-verified.
