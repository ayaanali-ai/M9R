# M9R Multiplayer — Phase 7: Browser and desktop correctness

Status: source implementation complete for Phase 7; validation tests remain
deferred until the owner-approved end-of-phases verification pass.

## Target identity boundary

`src/lib/native/multiplayer-target-identity.ts` adds the multiplayer gate above
the existing `computer-use` target/revision contract. It reuses the same
snapshot-scoped `targetId` and revision, while requiring an explicit stable
identity before a caller claims a multiplayer mutation:

- browser-chrome: `browserInstanceId`;
- browser-tab: `browserInstanceId` plus `tabId`;
- browser-frame: browser instance, tab, and frame IDs;
- web-element: browser instance, tab, snapshot, and element references;
- desktop-window: an explicit `windowRef`.

The target key excludes observation revision and capabilities, so a fresh
observation of the same tab/window remains the same binding. A target ID owned
by one agent cannot silently be claimed by another agent in the same run. The
owner can explicitly forget a closed/replaced target before a new binding is
accepted.

The Phase 6 mutation scheduler accepts an optional `targetBinding`. When a
caller supplies it, correlation must match the operation and the registry
claims the target before the mutation lease is created. Claims are released
when the transaction commits, aborts, or expires, while ownership remains
agent-bound until the target is explicitly forgotten. Existing callers without
the optional binding continue to use their explicit legacy path unchanged.

## Existing browser route

The current broker-owned browser route remains the only dispatch route. No
extension UI, service worker, or historical extension/CDP dependency was
revived. Browser observations now carry opaque, session-derived browser and
tab identity fields when the target is represented by the native computer-use
adapter; raw provider session IDs are never exposed in those fields. If an
older broker omits a resolved tab, the adapter preserves the caller's explicit
tab or documented default instead of guessing another window.

## Packaged Notepad resolution

The installed-app resolver queries both modern Windows StartApps names
(`Notepad` and `Windows Notepad`) and prefers the packaged
`shell:AppsFolder\\...!App` activation route when it is the only matching
modern app. The explicit legacy executable/App Paths route remains a fallback
when no packaged registration exists. The resolver still refuses genuine
ambiguity rather than choosing an unrelated window.

## Deferred behavior

Incognito and multi-window selection are intentionally not auto-selected in
this phase. A caller must provide an explicit tab/window identity; the existing
ambiguity refusal and owner-selection path remain authoritative until the
coordinator is stable.

## Verification boundary

- Added target-identity and registry coverage for distinct browser tabs,
  cross-agent collisions, explicit target forgetting, and desktop window
  references.
- Added a regression assertion for the modern Notepad registration aliases.
- Added the target-identity module to the native CLI build manifest.
- Compile-only typecheck and diff verification are performed before the Phase 7
  commit. Full tests and live tasks remain deferred until all approved phases
  are implemented.
