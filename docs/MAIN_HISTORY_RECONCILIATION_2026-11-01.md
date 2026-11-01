# Main history reconciliation — 2026-11-01

## Decision

The local `main` line contains the current M9R runtime, desktop driver, multiplayer,
provider lifecycle, installer, and pill work. `origin/main` contains two later merge
commits (`bca2457d` and `53d46004`) that were created from the common base, but their
trees also remove large parts of the local runtime. A normal content merge would
silently delete current capabilities.

The upstream changes were reviewed file-by-file before reconciliation:

- The Windows installed-app discovery improvement is already present in the local
  line (including packaged-app preference and its tests).
- The app-window and broker-watchdog behavior is already present in the local line,
  with additional local fixes for the one-pill runtime, dictation, and broker state.
- The `public/try` deletion is intentionally not propagated yet. It is a product
  surface decision, not a safe runtime reconciliation step, and no evidence was
  found that it is required for the native build.

## Merge policy

The reconciliation merge records both histories in one `main` ancestry while
preserving the verified local tree. No upstream deletion is accepted merely because
it is newer by date. Any future removal of `public/try` or other release assets must
be a separate reviewed change with an explicit product decision and tests.

## Release rule

Every live release must be built from this reconciled `main`, with a clean source
commit, a generated provenance manifest, and a post-install hash check. Worktrees,
recovery directories, and accepted artifacts are never build inputs.
