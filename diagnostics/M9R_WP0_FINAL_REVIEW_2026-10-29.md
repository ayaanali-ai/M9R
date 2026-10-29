# WP0 closure-readiness and regression cause — 2026-10-29

> Historical inventory snapshot. Later exact-path removals and owner process-path evidence supersede its “still present” and “not yet captured” statements. For current status, use [`M9R_WP0_SOURCE_GUARD_RESULTS_2026-10-29.md`](M9R_WP0_SOURCE_GUARD_RESULTS_2026-10-29.md) and [`M9R_WP0_CLEANUP_DISPOSITION_2026-10-29.md`](M9R_WP0_CLEANUP_DISPOSITION_2026-10-29.md).

Historical snapshot: the duplicate ZIP pair and the unapproved `0e630…` package pair listed below were subsequently removed after owner authorization and verification. See `M9R_WP0_SOURCE_GUARD_RESULTS_2026-10-29.md`, `M9R_WP0_DUPLICATE_PACKAGE_REMOVAL_2026-10-29.json`, and `M9R_WP0_UNAPPROVED_PACKAGE_REMOVAL_2026-10-29.json` for current status and retained evidence.

## Scope and result

This is a read-only product/runtime audit. No product source, installed runtime, registry, scheduled task, provider configuration, or process was changed. No tests, builds, installs, desktop actions, or deletions were run. This report is the only new artifact from this pass.

**WP0 is not yet a deletion-only closeout.** One duplicate package pair is fully proven redundant. The other old artifacts cannot all be declared safe to delete because the UI lock is local and ignored, local package installation accepts any matching sidecar, the source used for the live build is dirty, some recovery roots are inaccessible, and the owner’s actual startup registry/task could not be inspected from this execution identity.

## Current accepted pill/runtime boundary

- Owner-confirmed whole pill/app/tray binary: SHA-256 `4e909c063e955450b8b8bb97c01e264d73edbb92632cbe6d53bc7b5ae4e4bbbb`.
- The installed overlay, accepted UI copy, current rollback copy, `engine/dist` overlay, and recovery-staging overlay all hash to that same accepted UI binary.
- Accepted live package: build `e507012c0ca6fd9f136a502b91e965cb99c0c4d5369e12d9e447d44171cc91c9`, ZIP SHA-256 `2999a772a25a08abbdedf4169633f7f60180f492048bd946048041d353fba9f3`.
- Installed manifest says `autostart=true`, `brokerAutostart=true`, active runtime root `C:\Users\kaina\.m9r\bin`, source commit `29d868dc696c8810846572d849d6de052439cf01`, and `sourceDirty=true`.
- The 185-file accepted release, installed runtime, and rollback passed hash comparison. This establishes byte preservation, not reboot or functional acceptance.

## Why the pill regressed

The concrete failure is **component selection without one durable release identity**. A new engine package could be internally hash-consistent while containing the wrong overlay binary.

1. The build’s UI lock is `.m9r/recovery-ui-lock.json`, but `.gitignore` ignores all of `.m9r` (`.gitignore:94`). The lock is not tracked. `scripts/build-engine.mjs` uses it when present, but if it is absent, it falls back to `overlay/src-tauri/target/release/m9r-overlay.exe`.
2. That fallback currently exists and is not the accepted UI: `overlay/src-tauri/target/release/m9r-overlay.exe` is SHA-256 `ac14d70e1c0109d56f61f30e653526cc6a3eb04af1f9a682945fd952c56758fe`. It also exists as the overlay in the component-recovery snapshot. Other retained nonaccepted overlays include `3938ce96…` in the rollback-regression snapshot and `4e25bb82…` in the retired-runtime snapshot.
3. `scripts/package-engine-release.ps1` checks that `engine/dist/m9r-overlay.exe` exists; it does not independently compare it with a committed approved UI identity. The current `engine/dist` copy happens to be the accepted `4e909c…` binary, but that is not a permanent guard.
4. `scripts/Install-M9R.ps1 -PackagePath` accepts any local ZIP whose adjacent `.sha256` matches that ZIP. A checksum proves the ZIP matches its sidecar; it does not prove that M9R approved that build. The local unaccepted package below has a valid sidecar and a different pill.
5. The local `recovery-ui-lock.json` fixed selection for this checkout, but it does not protect a clean checkout/worktree where the ignored file is absent. That leaves the old fallback available again.

Evidence for the specific build mixture:

- The accepted UI is `4e909c…`.
- `overlay/src-tauri/target/release` and a component-recovery image are `ac14d70e…`.
- The unaccepted `.m9r-release-current` ZIP is build `0e630138…`, from clean/reachable source commit `5552811c…`, but contains overlay hash `fffb2bae…` rather than the owner-accepted `4e909c…`.
- Earlier incident records say a newer engine/broker was activated while the old overlay was reused, then a source build and partial geometry/icon recovery followed. The owner rejected that result because the pill contents and tray messaging were wrong. A package build time did not identify the overlay’s build time. The alleged `2026-10-27T21:59:26Z` checkpoint time is 4:59 PM Chicago time, not 9:59 PM.

So the reason the pill could regress twice is not that its accepted binary disappeared. The accepted copy survived. The workflow allowed a different binary to be selected, packaged, or installed without a versioned owner-approved identity for the **whole** pill. A geometry/icon adjustment could therefore make part of the pill look closer while leaving its messaging, cards, colors, or app behavior from another overlay.

## Why backend capabilities regressed

The recovery audit records a separate source/runtime mismatch: the selected source and package lacked native helper handlers while TypeScript callers and action descriptions remained. The preserved implementation existed in Git history/snapshot `65dc5bef`; the selected package was not a complete representation of the earlier working capabilities. On the recorded Codex Chrome run, invalid background actions were rejected, then the caller chose screenshot coordinates and the installed path performed physical foreground `SendInput`. The installed native helper lacked the cursor snapshot/restore operations that the TypeScript preservation path expected, and that path tolerated the missing saved pointer.

The native operations and refusal-to-escalate behavior were recovered and included in the matched runtime receipt. The present accepted build is still marked `sourceDirty=true`; source commit alone does not capture all installed recovery changes. The patches, checkpoint, and recovery evidence must remain until a clean source snapshot and patch digest are recorded. Do not delete worktrees, patches, or Git objects as though the live build were reproducible from `29d868dc` alone.

## Reboot/startup assessment

The source contract is coherent: pill autostart writes the current user's `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `M9R` to the exact installed `bin\m9r-overlay.exe`; broker autostart is a current-user logon task named `M9R Web Broker` with an ownership marker and exact action hash. The accepted install manifest reports both autostart flags enabled and the active root under `.m9r\bin`.

However, this shell ran as `msi\kaina` while `USERPROFILE` pointed to `C:\Users\kaina`. Queries against this shell’s `HKCU` and scheduled-task view are not authoritative for the owner’s interactive account. Therefore this audit does **not** claim the owner’s current Run value/task action or a reboot launch has been verified. No reboot or product task was run.

## Exact deletion disposition

### Fully verified duplicate — delete only after owner approval

These two files are the only artifacts currently proven redundant and unnecessary for recovery:

- `C:\RunLeak\runleak\diagnostics\pill-command-contract-package\m9r-engine-windows-x64.zip` — 115,049,614 bytes; SHA-256 `2999a772a25a08abbdedf4169633f7f60180f492048bd946048041d353fba9f3`.
- `C:\RunLeak\runleak\diagnostics\pill-command-contract-package\m9r-engine-windows-x64.zip.sha256` — 94 bytes; its checksum matches the ZIP.

The directory contains only those two files. The exact same ZIP and checksum remain in both the protected accepted-release folder `C:\Users\kaina\.m9r\releases\accepted-live-e507012c0ca6` and the accepted checkpoint `C:\RunLeak\runleak\diagnostics\checkpoints\accepted-live-e507012c0ca6`. No source-code reference to `pill-command-contract-package` was found. Deleting this third copy after approval would not delete the accepted release or rollback.

### Conditional cleanup targets — not safe to remove yet

| Exact item | Identity/evidence | Required gate before deletion |
|---|---|---|
| `C:\Users\kaina\.m9r\bin\m9r-engine.exe.m9r-retired-1793228209501-1375c783-2e4c-43fa-a7b7-faa30e1231be` | 94,942,720 bytes; SHA `74be427670ae53989090c3ae1f101da3a40d8c9296bd07e848fb753578edfc83`; matching staged copy under `diagnostics\recovery-staging\m9r-engine.exe`. | Make Restart Manager/owner check succeed in the owner session; preserve and verify the retained source; remove through a reviewed manifest-aware cleanup path, not manually. |
| `C:\Users\kaina\.m9r\bin\m9r-engine.exe.m9r-retired-1793240976786-4c9a5829-582e-45f6-a05b-98926f016d82` | 94,942,720 bytes; SHA `02d78d527b034cdbfaecd7b69b08f0e13414409340b5aefddfe7dbab2bdd1868`; matching engine in `releases\rollback-dddadff60f3e`. | Same owner/lock and manifest-aware cleanup gate. |
| `C:\Users\kaina\.m9r\bin\m9r-engine.exe.m9r-retired-1793241604254-71ff98e4-8579-4116-bcf4-519233d3d73e` | 94,955,520 bytes; SHA `0c39fb7771d016af3a684edd826c016fc311634d64eba21778d114f3315ea8fd`; matching engine in the retained `efe0b71` intermediate ZIP. | Same owner/lock and manifest-aware cleanup gate. |
| `C:\RunLeak\runleak\.m9r-release-current-b1897154f15d4d52a20eb4ef8e83a03e\m9r-engine-windows-x64.zip` and its `.sha256` | 111,025,832 bytes; SHA `a60ec0a9d4cab00229ffa7595e4944e56bb317052739168a9b40764ab6fcafb9`; build `0e630138…`; UI `fffb2bae…`; clean source commit is reachable. | First make the installer reject unapproved build identities. Retain the source commit and package ledger; then the unaccepted local ZIP can be removed after owner review. |
| `C:\RunLeak\runleak\overlay\src-tauri\target\release\m9r-overlay.exe` | 3,383,808 bytes; SHA `ac14d70e1c0109d56f61f30e653526cc6a3eb04af1f9a682945fd952c56758fe`; not the accepted UI. | First remove the builder’s missing-lock fallback and make release packaging fail closed. Deleting this generated binary alone cannot prevent a later build from recreating/selecting a wrong one. |

### Keep on HOLD — deleting now risks losing recovery or source information

- `C:\Users\kaina\.m9r\recovery\component-recovery-20261028-172852` — 6 files / 3,682,327 bytes; contains the `ac14d70e…` overlay and component provenance.
- `C:\Users\kaina\.m9r\recovery\m9r-rollback-20261028-regression` — 12 files / 380,266,381 bytes; contains the `3938ce96…` overlay and duplicated engine/broker snapshot names. Preserve the whole incident snapshot until its other files and references are dispositioned.
- `C:\Users\kaina\.m9r\recovery\retired-runtime-20261028-1705` — 23 files / 1,321,791,670 bytes; contains old runtime evidence, the `4e25bb82…` overlay, two copies of the accepted `4e909c…` overlay, and duplicate broker artifacts. No whole-folder delete is proven safe.
- `.m9r-recovery-quarantine-20261014` — 1,310 files / about 1.57 GB. Its 13 release ZIPs are distinct, with valid matching sidecars; some lack build metadata and the root contains 275 `.key`-suffix files whose contents were not read. Keep until each package and key’s purpose is classified.
- `.test-tmp` — 818 files / about 736 MB, 46 `.key`-suffix files and six package ZIPs. It is scratch/test-looking data but exact key ownership and active owner-session use were not established. Do not bulk-delete it yet.
- `scratchpad` — includes `relay-secret.txt`; its content was not read. Keep securely and out of packages.
- All three user-profile recovery roots and their 41-file hash ledger, rollback/intermediate releases, provider configuration backups, raw diagnostics other than the one duplicate ZIP pair above, dirty or unavailable worktrees, and the 112 Git `tmp_obj_*` files (~2.19 GB). Their per-file inventories are retained in the linked WP0 ledgers.
- `.worktrees` and `.release-excluded` in the project root remain inaccessible even after a read-only access attempt. No disposition is possible for their contents from this session; do not delete or prune them.

The machine-readable package, recovery, and worktree inventories are `M9R_WP0_PACKAGE_ARCHIVE_IDENTITY_2026-10-29.csv`, `M9R_WP0_RECOVERY_HASH_LEDGER_2026-10-29.csv`, `M9R_WP0_RECOVERY_STAGING_HASH_LEDGER_2026-10-29.csv`, and `M9R_WP0_WORKTREE_STATUS_2026-10-29_FINAL.csv`.

## What must happen before WP0 can be deletion-only

1. Put the accepted UI hash and component compatibility identities in a tracked, versioned release manifest. A release build must fail if that manifest is missing; remove the fallback to a random Cargo target output. Make `package-engine-release.ps1` verify the UI hash against that manifest.
2. Make local and downloaded install paths accept only an owner-approved build ID and complete manifest/hash set. A ZIP plus a matching adjacent checksum alone must not authorize installation. Record clean source commit plus a patch digest; do not release from an unaccounted dirty worktree.
3. Preserve the current accepted package, accepted UI, rollback, source patch, and recovery ledgers. Resolve `.worktrees`/`.release-excluded` access and classify missing/unavailable worktrees without resets or pruning.
4. In the owner’s interactive Windows session, inspect the actual Run value and `M9R Web Broker` task action against `C:\Users\kaina\.m9r\bin`; inspect exact process image paths and handle owners. The sandbox account’s empty result is not owner evidence.
5. Produce a path-by-path removal manifest. Remove the single duplicate accepted ZIP pair first only after the owner approves it. Remove retired sidecars only through the corrected retention-aware cleanup path after owner/lock checks. Treat each old package/target and recovery root separately; do not blanket-delete directories.
6. After every approved removal, hash-check the accepted live set and rollback set. Owner performs the reboot/startup check and the product tasks; no such tasks were run here.

## Readiness decision

There is one clear duplicate pair for later owner-approved deletion. The rest of WP0 is **not** ready for a delete-only pass yet: the fail-open selection/install cause must be closed in source first, and the inaccessible roots and owner-session startup/lock state must be resolved. Starting WP1 before those gates would leave the same regression path available.

The requested GitHub research on Voice Studio was not completed: the required M9R browser tool returned that this legacy connection needs an M9R session token. No alternate browser/search route was used.
