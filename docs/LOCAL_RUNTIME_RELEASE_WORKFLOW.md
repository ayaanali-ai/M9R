# Local M9R runtime release workflow

This document describes the local install layout and the source-level update path for the engine, hook, broker, pill, and native input runtime. The transaction changes in this branch are staged source changes; they have not been installed into the live runtime.

## One installed runtime

The installed runtime lives at `%USERPROFILE%\.m9r\bin`. Each component has one canonical filename there; updates replace changed files at those same paths. `install-manifest.json` records which paths M9R owns, and `m9r-build-info.json` identifies the exact runtime build and artifact hashes.

An update stages and hashes the complete package before touching the install. It skips files whose hashes already match, replaces changed files at their canonical paths, removes only stale files recorded in the M9R ownership manifest, then verifies the resulting files. Temporary transaction data exists only while the update can still roll back. A successful update removes the transaction snapshots. If a target is locked or changes during the transaction, the update rolls back and reports the exact path; it does not rename a running executable to a `.m9r-retired-*` sibling.

The full engine package is required before reconciling old runtime paths. A hook-only CLI update preserves the existing engine, pill, broker, and native input files because that smaller package cannot authoritatively describe the complete runtime. The standalone installer includes its managed broker in the same runtime transaction and refreshes the broker's separate ownership hash after the transaction succeeds.

## One generated build output

`cli/dist` and `engine/dist` are generated outputs, not historical version stores. Each builder writes a complete staged directory, verifies it, then replaces the destination directory as one snapshot. It does not merge the new runtime with leftover files from an older build. If the prior output is not a valid complete output, publication stops and preserves it for audit. If a prior snapshot remains after a verified publication, the build reports the exact path and the next run removes it only after validating the new output and the prior snapshot.

This lifecycle is source-verified in this branch but has not been installed or executed as a user-facing update. The `npm run build:engine` path rebuilds the CLI first; the candidate builder also builds the CLI and engine into the same candidate. Do not build the engine directly against an old `cli/dist` folder.

## Build and review a candidate

From the repository root, run `npm run build:candidate` on Windows. The command builds the CLI and runtime under a unique `engine/candidates/<UTC-time>-<source-commit>/` directory and packages that same runtime. The candidate receipt records the source commit, whether the source tree was dirty, runtime build ID, accepted pill hash, and package checksum.

The candidate builder uses `release-assets/accepted-ui/m9r-overlay.exe` as the pill input and verifies it against `release-assets/accepted-runtime.json`. It does not publish into `cli/dist` or `engine/dist`, change the accepted runtime policy, or write to the installed `%USERPROFILE%\.m9r\bin`. A candidate with `sourceDirty: true` is not a clean release candidate; review its exact source changes before promotion.

If packaging fails after the runtime has been built, resume packaging that exact verified runtime with `npm run build:candidate -- --resume .\engine\candidates\<candidate-id>`. Resume refuses paths outside `engine/candidates/`, rechecks the full runtime manifest, and will not overwrite a completed candidate.

## Promote and install

Review `candidate.json`, `runtime/m9r-build-info.json`, and the package checksum. A candidate is eligible only when its source commit is clean, the runtime manifest lists the exact packaged artifact set, its pill hash matches the accepted pill, and the package checksum verifies.

Promotion means copying the reviewed candidate's `runtime/m9r-build-info.json` to `release-assets/accepted-runtime.json`. That file is the one release allowlist used by the package builder and installer. Do not promote based only on a candidate's timestamp or folder name. Before promotion of a candidate already installed locally, compare every artifact hash against `%USERPROFILE%\.m9r\bin` and confirm its `activeRuntime` build ID and source commit match the candidate.

The standalone installer previews and verifies the package, stops M9R-owned pill and broker services, applies the runtime file transaction, then starts the broker again. It does not kill provider work by process name. If Windows reports a locked executable, the update fails closed and names the exact file. Close the owning M9R/provider process and retry; no second installed runtime is created.

The runtime transaction is now verified in source and tests. A user-facing “Update and restart” control is a separate integration step: `m9r-cli update check` can check release metadata, but no pill/app command currently installs a runtime package. The older `managed-runtime-update.ts` coordinator is not wired and uses a provider supervisor/session model; do not connect it to M9R's direct provider-process architecture.

## OpenCode comparison

OpenCode's Windows desktop updater uses a downloaded installer and an install/restart handoff. Its maintainers say the installer copy at the cache root is intentionally retained for future delta updates, while the pending installer is electron-updater's download; they expect the cache to stay bounded at about two copies, not to grow once per release. That is a deliberate bandwidth tradeoff, but it does not meet M9R's stricter “one installed copy, no leftover generations” policy. See the [OpenCode updater controller](https://github.com/anomalyco/opencode/blob/dev/packages/desktop/src/main/updater-controller.ts) and the maintainers' [Windows updater cache explanation](https://github.com/anomalyco/opencode/issues/60179). The issue also records that the pending copy may remain after an update until the next download.

M9R keeps only the active install at its canonical paths after a successful update. It may create short-lived staged/rollback files during the transaction, but it removes them after verification. Git history is the source history; it is not an installed runtime generation.

`engine/candidates/` is ignored by Git and excluded from the root Docker build context. Candidate folders are release staging, not installed runtimes. Keep the accepted candidate and any candidate still under review; remove a completed candidate only after confirming that no acceptance receipt or recovery checkpoint points to it.
