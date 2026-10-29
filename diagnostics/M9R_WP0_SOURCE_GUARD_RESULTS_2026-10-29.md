# WP0 source guards and remaining closeout gates — 2026-10-29

## Confirmed regression cause

The accepted pill binary survived. The failure path was selection and installation of mismatched components:

1. `scripts/build-engine.mjs` read an ignored local `.m9r/recovery-ui-lock.json`, then fell back to `overlay/src-tauri/target/release/m9r-overlay.exe` when that lock was missing. That target executable is not the accepted pill.
2. The release packager checked that an overlay existed but did not compare its hash or the rest of the runtime against an owner-accepted identity.
3. The local installer accepted any ZIP with a matching adjacent checksum. That established ZIP integrity only; it did not establish that the runtime was the one accepted by the owner.
4. Developer launch shortcuts also selected the Cargo target binary by default, making it possible to mistake a stale target build for the accepted pill.

This explains why geometry or tray adjustments could appear to restore part of the pill while its contents, cards, colors, or application behavior still came from another binary.

## Source guards now in place

- Preserved the exact owner-confirmed pill at `release-assets/accepted-ui/m9r-overlay.exe`. Its SHA-256 is `4e909c063e955450b8b8bb97c01e264d73edbb92632cbe6d53bc7b5ae4e4bbbb`.
- Added `release-assets/accepted-runtime.json`, the owner-accepted complete runtime identity: build `e507012c0ca6fd9f136a502b91e965cb99c0c4d5369e12d9e447d44171cc91c9` and 185 artifact hashes.
- The engine builder now selects the preserved pill by default. An explicit `M9R_OVERLAY_EXE` is allowed only when its bytes match the accepted hash. There is no fallback to Cargo target output, and the ignored local lock is no longer read.
- The packager now requires the accepted build ID and exact artifact map, then hashes every artifact before creating a ZIP.
- The installer now validates the package build ID, artifact inventory, and every extracted artifact hash before showing setup consent or making changes. A matching ZIP sidecar alone is insufficient.
- Overlay verification shortcuts now default to the preserved accepted pill. They can still select another executable when a path is explicitly passed.
- `release-assets/README.md` records the promotion rule: review and accept a complete build identity before changing the accepted pill or runtime manifest.

## Read-only evidence checks

- All 185 hashes in the accepted runtime manifest match the current `engine/dist` files: zero mismatches.
- All 185 hashes in the retained accepted ZIP match the same manifest: zero mismatches. The ZIP SHA-256 remains `2999a772a25a08abbdedf4169633f7f60180f492048bd946048041d353fba9f3`.
- All 185 files in `C:\Users\kaina\.m9r\bin` match that accepted manifest: zero mismatches. The install manifest records build `e507…`, `sourceDirty=true`, `autostart=true`, `brokerAutostart=true`, and installed root `C:\Users\kaina\.m9r\bin`.
- The broker ownership record points to `C:\Users\kaina\.m9r\bin\m9r-web-broker.exe`; its recorded and actual hash both equal the accepted `8a6b972dd190e033c1e41b672bcf8e5a78915a07e22423bc1d5fd98046fd3658`.
- Installed critical binaries match the same build: pill `4e909c…`, engine `782226…`, hook `74b84d…`, native input host `d5f967…`, and broker `8a6b97…`.
- After both archive cleanups, I rechecked the installed runtime: all 185 hashes still match build `e507…`; the accepted pill still hashes to `4e909c…`; both retained accepted ZIP copies still hash to `2999a7…`; and both removed package paths are absent.
- The removed unaccepted package was build `0e630138ae311491087dc7f26a97688de7af5c1356c7fb9b3c732138b534e0a8`, with pill SHA-256 `fffb2bae5aa6ab89d057183fc8824dc3d21de155c10ab7f26623b9c3322dd89d`. Its 216-entry inventory and all 185 runtime hashes are preserved in the linked forensic inventory.
- The previous Cargo target pill is SHA-256 `ac14d70e1c0109d56f61f30e653526cc6a3eb04af1f9a682945fd952c56758fe`; the new build path and developer shortcuts no longer select it by default.
- Static syntax parsing passed for the modified JavaScript and PowerShell scripts. `git diff --check` passed.

No product tests, build, install, process launch, desktop action, or reboot was performed. Two audited archive pairs and their empty folders were deleted as listed below. These checks confirm file identity and source structure only; they do not confirm that the installed processes are currently running, that the task/Run entry in the interactive owner session points to these files, or that behavior still works.

## Preservation checkpoint

At the time this checkpoint was captured, the accepted runtime source files and fail-closed guard changes were staged but not yet committed. The exact source-guard patch was subsequently committed as `eba5d4937a3fb584ac297934dfac434fab20bcc7` on `codex/pill-recovery-20261028`. The final tracked/staged patch and a copy of `release-assets` remain as historical evidence under `diagnostics/checkpoints/wp0-source-guards-v2-20261029`; its patch SHA-256 is `8ac5a1d97f427dd24b42edb707214407164c6ef979481b3eb8e6f884ae0a4ae5`. The initial source-guard checkpoint is also retained at `diagnostics/checkpoints/wp0-source-guards-20261029`. The pre-hardening patch remains at `diagnostics/checkpoints/wp0-pre-hardening-20261029`.

## Exact removal candidates and current disposition

Two package pairs and their now-empty folders were removed after the owner authorized removal of items proven unnecessary. No installed runtime files, recovery snapshots, keys, or worktrees were removed. Exact hashes and retained evidence are recorded in `diagnostics/M9R_WP0_DUPLICATE_PACKAGE_REMOVAL_2026-10-29.json` and `diagnostics/M9R_WP0_UNAPPROVED_PACKAGE_REMOVAL_2026-10-29.json`.

### Removed verified duplicate pair

- `diagnostics/pill-command-contract-package/m9r-engine-windows-x64.zip` — 115,049,614 bytes; SHA-256 `2999a772a25a08abbdedf4169633f7f60180f492048bd946048041d353fba9f3`.
- `diagnostics/pill-command-contract-package/m9r-engine-windows-x64.zip.sha256` — 94 bytes.

The folder contained only these two files. Before removal, both files matched byte-for-byte copies in the accepted release and checkpoint; both retained copies were rehashed after removal and still match. The empty folder was then removed without recursion.

### Unaccepted local release — removed after full inventory

- `.m9r-release-current-b1897154f15d4d52a20eb4ef8e83a03e/m9r-engine-windows-x64.zip` — SHA-256 `a60ec0a9d4cab00229ffa7595e4944e56bb317052739168a9b40764ab6fcafb9`.
- `.m9r-release-current-b1897154f15d4d52a20eb4ef8e83a03e/m9r-engine-windows-x64.zip.sha256` — matching checksum sidecar.

This was the sole ZIP copy of the rejected build, and it contained an older bundled installer. Before removal I verified all 185 runtime hashes against its embedded manifest, inventoried all 216 ZIP entries, found no secret-named entries, verified its source commit is clean and reachable from two local branches, and recorded the complete file/hash inventory at `diagnostics/checkpoints/unapproved-build-0e630138ae311491087dc7f26a97688de7af5c1356c7fb9b3c732138b534e0a8/package-inventory.json`. The ZIP, sidecar, and empty folder are now removed. Its exact SHA-256 and source identity remain in the forensic inventory and removal receipt.

### Generated wrong pill — exact stale build output removed

- The stale Cargo pill had SHA-256 `ac14d70e1c0109d56f61f30e653526cc6a3eb04af1f9a682945fd952c56758fe` and was a hard link at `overlay/src-tauri/target/release/m9r-overlay.exe` and `overlay/src-tauri/target/release/deps/m9r_overlay.exe`.

Both exact release directory entries were removed after the owner-session screenshots showed the running pill at the accepted `C:\Users\kaina\.m9r\bin\m9r-overlay.exe` path. The accepted source UI and live pill were rehashed afterward; both remain `4e909c063e955450b8b8bb97c01e264d73edbb92632cbe6d53bc7b5ae4e4bbbb`. The builder and developer shortcuts no longer select the Cargo release output. A second stale debug pill is covered below. The Cargo target directory remains intact and may regenerate outputs on a future build; the source guards still reject a mismatched pill hash from the release path.

### Stale standalone Tauri installer — exact generated output removed

- Removed `overlay/src-tauri/target/release/bundle/nsis/M9R Overlay_0.1.0_x64-setup.exe` (1,259,585 bytes; SHA-256 `EE5E0DCFB40745B17DB9CE7CA39E4B9248C6B53A6A7C251F866F33B8CF3B34D6`).
- It was an unsigned, ignored Cargo/Tauri target artifact dated 2026-10-25, was not tracked or referenced by release/source scripts, and is not an accepted-release artifact. It was not executed. The exact file is absent after removal; the target directory and all other build outputs remain untouched.

### Stale debug pill — exact hard-linked outputs removed

- The 2026-09-20 debug pill had SHA-256 `909c22a335aef43c53946b11ef3c49c34d91ab89c9ced408639ffa3454116996`, different from the accepted pill. `fsutil hardlink list` confirmed the same file was exposed at `overlay/src-tauri/target/debug/m9r-overlay.exe` and `overlay/src-tauri/target/debug/deps/m9r_overlay.exe`.
- Both ignored, untracked directory entries were removed by exact path after confirming the accepted pill hash remained `4e909c…`. No recursive target cleanup was done; the build directory remains and can regenerate outputs.

### Current closeout status and remaining holds

- The three retired engine sidecars under `C:\Users\kaina\.m9r\bin` were removed by exact path after hash, manifest ownership, retained-copy, and Restart Manager checks. Their bytes remain preserved in the recovery staging, rollback, and intermediate archive sources.
- Recovery snapshots, provider configuration backups, `.m9r-recovery-quarantine-20261014`, `.test-tmp`, `scratchpad`, Git temporary objects, and dirty/unavailable worktrees remain on hold. Their inventories and inaccessible subdirectories are documented in `M9R_WP0_FINAL_REVIEW_2026-10-29.md` and the associated ledgers.
- Read-only elevated inspection verified the owner Run entry and exact `M9R Web Broker` scheduled-task action; no reboot check was run.
- **Owner process-path evidence received (2026-10-29):** Task Manager screenshots show every listed `m9r-engine.exe`, `m9r-hook.exe`, `m9r-overlay.exe`, and `m9r-web-broker.exe` image path under the one canonical `C:\Users\kaina\.m9r\bin` directory. Command lines show multiple `mcp` invocations and one `m9r-engine.exe feed --watch --serve-hooks` instance. The broker command line identifies `--home C:\Users\kaina\.m9r`, port `47821`, and `--project-root C:\RunLeak\runleak`. The two captures are different snapshots (9 engines/7 hooks, then 10/8); counts alone do not establish stale files or stuck processes. This closes the active image-path check, but says nothing about old binaries sitting elsewhere on disk or sidecar file locks.

## Historical status before final WP0 closeout review

The following status was accurate when this checkpoint was written. It was superseded by the owner reboot/startup evidence and the final disposition in [`M9R_WP0_CLEANUP_DISPOSITION_2026-10-29.md`](M9R_WP0_CLEANUP_DISPOSITION_2026-10-29.md), which closes WP0 for the active release/runtime and normal build-input boundary while retaining unresolved archives as KEEP/HOLD.

The source-level selection/install regression route is guarded. Its exact 10-file patch is committed as `eba5d4937a3fb584ac297934dfac434fab20bcc7`; the recovered pre-WP1 source snapshot is now captured as `56ead0c73be59d9a2ed79de1f26493eed4f56230` on `wp-order`. The live build metadata still records `sourceDirty=true` from build time. The stale release/debug pill outputs, unsigned generated Tauri installer, rejected `0e630…` package, duplicate accepted-package copy, and three retired live engine sidecars were removed by exact paths with hashes recorded. The live manifest now has 186 owned runtime files, and the canonical `bin` directory has zero unowned, missing, retired, or staged files. WP0 still needs a successful installer integration validation and an owner reboot/startup check. Held recovery and unreadable roots are classified KEEP/HOLD; no further deletion candidate was proven safe. The incomplete OpenCode WP1 diff remains uncommitted and separate.


## Final read-only WP0 checks (2026-10-29)

- Recomputed every hash in `release-assets/accepted-runtime.json`: all 185 files under `C:\Users\kaina\.m9r\bin` and all 185 files under `engine/dist` match build `e507012c0ca6fd9f136a502b91e965cb99c0c4d5369e12d9e447d44171cc91c9`. No missing files or mismatches.
- The preserved pill in `release-assets/accepted-ui/m9r-overlay.exe` still matches SHA-256 `4e909c063e955450b8b8bb97c01e264d73edbb92632cbe6d53bc7b5ae4e4bbbb`. Both retained accepted ZIP copies still match SHA-256 `2999a772a25a08abbdedf4169633f7f60180f492048bd946048041d353fba9f3`; both removed package directories remain absent.
- Before cleanup, the live install ownership manifest had 189 runtime paths: 185 accepted artifacts, `m9r-build-info.json`, and three retired engine sidecars. After exact removal, the live manifest has 186 paths; the pre-cleanup manifest is preserved at `diagnostics/checkpoints/wp0-live-install-manifest-20261029/install-manifest.json`, SHA-256 `479368ebca93f6f8e1c93eaf6656e40d10421adf98436d269a9c6990bf1ba24f`. The current manifest SHA-256 is `458abb06ec124feccc49f28efd64ce84ed3136002bb499b414c7650dbfbb30d4`.
- A full installed-bin inventory found 186 files, exactly matching the 186 manifest paths; there are no missing or unowned files and no `m9r-retired` or `m9r-new` leftovers. All 185 accepted runtime hashes and the accepted pill hash still match.
- Read-only elevated inspection verified `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `M9R` is `"C:\Users\kaina\.m9r\bin\m9r-overlay.exe"`. It found no M9R/OathLock `RunOnce` entry and only one matching scheduled task. `M9R Web Broker` is running for `kaina` with an at-logon action targeting `C:\Users\kaina\.m9r\bin\m9r-web-broker.exe`, home `C:\Users\kaina\.m9r`, port `47821`, project root `C:\RunLeak\runleak`, and working directory `C:\RunLeak\runleak`. The task still has legacy `Win7` compatibility metadata; source requests `Win8` on registration. No task/Run setting was changed. No reboot check was run.
- M9R desktop observation was not used for this owner-desktop check. The OpenAI Computer Use observation of the pill showed `Codex app-server timeout: thread/resume: no response within 60000ms`, `Session stopped on an error.`, and `No agents connected yet.` It also showed the Stage registry still loading. This establishes a current Codex managed-provider startup/resume failure, not a pill-binary mismatch; source tracing shows the continuation reference is resumed and the adapter is shut down after the 60-second timeout. The stored reference may be stale, but that has not been proven; it was not cleared or changed.
- At the time of these final read-only checks, no product test, build, install, provider action, desktop input, or reboot had been run. Computer Use only observed windows and process identity; no settings or app state were changed. Later focused test results are recorded in the final closeout update in `M9R_WP0_CLEANUP_DISPOSITION_2026-10-29.md`.

WP0's active installed-runtime cleanup is complete and hash-verified. The recovered source snapshot and held-data decisions are now recorded on `wp-order`; the uncommitted WP1 diff is separate. Broader WP0 closeout remains open because installer integration did not complete in the sandbox and an owner reboot/startup check has not been performed. The active process paths, Run entry, and scheduled-task action are verified; the task itself was not edited.

### Exact owner evidence needed to close the Windows-only verification gap

The owner’s Run entry, scheduled-task definition, process image paths, and retired-file lock state have now been checked. The remaining Windows-side validation is an owner-controlled reboot/startup check; no startup setting or task definition was changed during this audit.

**Verified:** Task Scheduler shows `M9R Web Broker` with an enabled at-logon trigger for `MSI\kaina`, hidden, run only while the user is logged on, and not elevated. Read-only task inspection confirmed the exact action and working directory: canonical broker under `C:\Users\kaina\.m9r\bin`, M9R home, port `47821`, and project root `C:\RunLeak\runleak`. The Run value points to the accepted pill in the same `bin` directory. Task Manager screenshots show all active M9R images under that canonical directory. One screenshot lists 9 engines/7 hooks; the command-line screenshot lists 10/8, so counts differ between snapshots. They are processes from the same canonical image paths, not evidence of old binaries running elsewhere.

The task General tab says “Configure for: Windows 7, Windows Server 2008 R2.” This is compatibility metadata, not an executable target. Source requests `Win8` for new/re-registered broker tasks and accepts the exact legacy definition for a later safe migration. The live task remains unchanged at `Win7`; no reboot or owner-run product test has been performed.

Restart Manager reported zero users for all three retired engine sidecar paths immediately before exact cleanup. The separate Codex `thread/resume` timeout recorded above remains an unclassified provider startup issue; it is not evidence of a wrong pill binary and must not be “fixed” by deleting continuation state without proof.
