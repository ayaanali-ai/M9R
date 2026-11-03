# Current Cua dependency inventory

Captured from `main` at `b4f45dba` on 2026-11-03. This is an inventory, not an approval to keep the dependency.

## Cursor presentation (retain temporarily behind one adapter)

- `src/lib/native/cua-stage-driver.ts`: runtime/session creation, cursor enable/disable, cursor motion, cursor state, cursor visibility confirmation, and cursor teardown.
- `src/lib/native/cua-driver-host.ts`: starts the private Cua host process and connects the cursor client.

These calls are presentation-only and may remain temporarily. They must not be used as a permission, targeting, or dispatch dependency.

## Perception still supplied by Cua (must move to native host)

- `getDesktopState`, `getWindowState`, `getScreenSize`, and `listWindows` in `cua-stage-driver.ts`.
- `parseVisualRegions` for visual fallback target descriptions.
- Cua screenshot/image extraction and Cua capture IDs.
- Window-level accessibility element tokens and Cua element maps.

The native host currently supplies desktop-wide UIA structure, window metadata, HWND/process-generation validation, hit testing, popups, and window geometry, but not the complete exact-window observation/screenshot contract required to remove these calls safely.

## Semantic/action calls still supplied by Cua (must move to native host)

- `set_value` through `driver.callTool` for exact-field replacement and append fallback.
- Cua semantic element click when a native screen point cannot be derived.
- Cua foreground/background fallback inside `driverInputAction`.
- Cua scroll for horizontal scrolling.
- Cua drag/click/key/type/scroll function closures retained as fallback delegates.
- Cua `setWindowFrame` for resize/snap paths.
- Cua `bring_to_front` where the native foreground option is not selected.

## Build/runtime packaging still supplied by Cua

- `@trycua/cua-driver` dependency in `package.json` and lockfile.
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

No new production caller may add a Cua perception/action dependency. Until the native replacement is complete, existing Cua calls remain explicitly tracked here and are not described as removed.
