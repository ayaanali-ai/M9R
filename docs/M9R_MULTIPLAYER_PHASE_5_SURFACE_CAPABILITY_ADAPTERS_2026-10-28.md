# M9R Multiplayer — Phase 5: Surface Capability Adapters

Status: source implementation complete for Phase 5; validation tests remain deferred until the user-approved end-of-phases verification pass.

## One surface boundary

`src/lib/native/multiplayer-surface.ts` adds one provider-neutral surface interface with four capability levels:

1. `browser-cdp`
2. `ui-automation`
3. `document-application`
4. `visual-physical`

The boundary binds an observed `ComputerUseTarget` to a logical multiplayer surface and a broker route. It does not launch a browser, focus a window, dispatch input, or invent a target identity. Those actions remain in the existing Computer Use and broker paths.

## Existing routes preserved

The built-in catalog maps the current routes without changing them:

- browser targets → `m9r-browser-broker` through the `browser-cdp` adapter;
- desktop/app targets → `m9r-desktop-stage` through the `ui-automation` adapter.

The browser adapter is therefore broker-owned and target-bound. It does not revive, require, or replace the old browser extension UI. The current browser control implementation remains the dispatch backend.

Document-specific and visual/physical adapters are extensible registrations. They are not advertised as live unless a caller explicitly registers them with an appropriate availability state. Adapter selection is deterministic by explicit preference or priority, and unavailable adapters fail closed.

## Verification boundary

- Added coverage for route preservation, capability-level selection, custom document/visual registration, and explicit preferred-adapter failures.
- Added the surface module to the native CLI build manifest.
- Compile-only typecheck and diff verification are performed before the Phase 5 commit.
- No browser-control implementation, extension, desktop stage, provider runtime, pill UI, or machine setting was changed by this phase.
- Tests remain deferred until all approved phases are implemented, per the owner’s instruction.
