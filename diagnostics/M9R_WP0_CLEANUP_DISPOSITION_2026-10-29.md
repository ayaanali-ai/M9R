# M9R WP0 cleanup disposition — 2026-10-29

## Decision

**The active installed runtime cleanup is complete; repository-wide WP0 closeout remains open.** The accepted release and rollback are integrity-verified, and the three retired engine sidecars have been removed after exact ownership, hashes, retained copies, and Restart Manager use were checked. Recovery archives, dirty/missing worktrees, inaccessible roots, and sensitive scratch data remain preserved or on hold. WP1 has already been dispatched separately by the owner; keep it isolated and do not promote/install it as part of WP0. This audit is scoped to the project and M9R-specific files; external storage remains owner-managed.

## Revalidated preservation boundary

The read-only revalidation receipt is [`M9R_WP0_CURRENT_LIVE_REVALIDATION_FOLLOWUP_2026-10-29.json`](M9R_WP0_CURRENT_LIVE_REVALIDATION_FOLLOWUP_2026-10-29.json), SHA-256 `5e6f081294d65afa94d5e6817e4c03a732e72068e1c815e95d8c5154959e2f67`.

- Accepted build ID: `e507012c0ca6fd9f136a502b91e965cb99c0c4d5369e12d9e447d44171cc91c9`.
- Accepted package SHA-256: `2999a772a25a08abbdedf4169633f7f60180f492048bd946048041d353fba9f3`.
- Accepted pill SHA-256: `4e909c063e955450b8b8bb97c01e264d73edbb92632cbe6d53bc7b5ae4e4bbbb`.
- Checkpoint ZIP and manifest match; all 185 checkpoint payloads and all 185 installed payloads match.
- Rollback build `dddadff60f3e354fb50d37529f72385ff300d589ab13cad83f4cd885d5fa53e9` has all 185 payloads matching.
- Seven checkpoint/mirror files match; the UI lock, installed pill, and installed build metadata match the accepted baseline.
- A fresh direct comparison of the installed engine, broker, and overlay to the corresponding accepted ZIP entries also matched all three hashes.
- The pre-cleanup live install manifest is preserved at [`wp0-live-install-manifest-20261029/install-manifest.json`](checkpoints/wp0-live-install-manifest-20261029/install-manifest.json), SHA-256 `479368ebca93f6f8e1c93eaf6656e40d10421adf98436d269a9c6990bf1ba24f`. The duplicate checkpoint copy was removed after its exact hash matched this retained copy. The current live manifest is SHA-256 `458abb06ec124feccc49f28efd64ce84ed3136002bb499b414c7650dbfbb30d4`, build `e507012c…`, and 186 runtime paths.
- A read-only reconciliation of the full installed `bin` directory found exactly 186 files, all 186 owned by the live manifest; zero unowned files, zero missing manifest paths, and zero retired/staged-name leftovers.
- This verifies byte identity and preservation only. It is not a full functional qualification.

## Disposition register

| Scope | Decision | Basis / next gate |
|---|---|---|
| `C:\Users\kaina\.m9r\releases\accepted-live-e507012c0ca6`, `accepted-ui-4e909c06`, `rollback-dddadff60f3e` | **KEEP — immutable** | Accepted live package, exact UI, and rollback. Do not clean or rewrite in place. |
| `C:\Users\kaina\.m9r\bin\m9r-engine.exe.m9r-retired-*` (three registered sidecars) | **REMOVED — exact identity retained** | All three exact hashes matched their manifest-owned paths and preserved copies; Restart Manager reported zero users. Only these three files and their three manifest entries were removed. The accepted 185-file runtime remained hash-identical; the 186-file bin now has no unowned or retired/staged files. |
| Component recovery, rollback-regression, retired-runtime recovery roots | **KEEP — recovery evidence** | Historical builds and unique files have unresolved acceptance/reference value; hashed inventory is in `M9R_WP0_RECOVERY_HASH_LEDGER_2026-10-29.csv`. |
| `C:\Users\kaina\.m9r\releases\rollback-dddadff60f3e` and intermediate archive `wp0-intermediate-efe0b71` | **KEEP — rollback/archive** | Needed to retain the documented rollback chain; the intermediate is not an accepted launch target. |
| `C:\Users\kaina\.m9r\backups` | **KEEP — configuration** | Two original provider configuration backups; exclude from binary cleanup and customer packages. |
| `.m9r-release-current-b1897154f15d4d52a20eb4ef8e83a03e` | **REMOVED — provenance retained** | The unaccepted ZIP and checksum were removed after full payload/entry inventory and source-reachability checks; its forensic inventory and exact hashes remain in `diagnostics/checkpoints/unapproved-build-0e630138ae311491087dc7f26a97688de7af5c1356c7fb9b3c732138b534e0a8/package-inventory.json` and the removal receipt. |
| `.m9r-recovery-quarantine-20261014` | **HOLD** | 1,310 files / about 1.57 GB with broker, coordinator-worker, candidate, activation, and rollback evidence. Requires complete build/reference mapping before disposition. |
| `.test-tmp` | **HOLD — potentially sensitive** | 818 files / about 736 MB; 46 `.key`-suffix files. Contents were not opened. Identify owners, active writers, fixture use, and key purpose before exact-path cleanup. Do not copy into a normal release backup. |
| `diagnostics` | **KEEP selectively / HOLD raw records** | Source-of-truth checkpoint and audit artifacts must remain. Raw logs/ETL/session records need separate retention and sensitive-data review; do not bulk-delete or include raw records in release artifacts. |
| `diagnostics\recovery-staging` | **KEEP — recovery staging** | Seven files / about 98 MB. `m9r-engine.exe` hash `74be…` exactly matches retired sidecar 1; build `22d3b904…` is an explicit component recovery based on `b7e95ff…`, source commit `29d868dc…`, source dirty. Hashes for all seven staged files are in [`M9R_WP0_RECOVERY_STAGING_HASH_LEDGER_2026-10-29.csv`](M9R_WP0_RECOVERY_STAGING_HASH_LEDGER_2026-10-29.csv; SHA-256 `918993dfffeba65b67c2175d3163a15c68d70129356c9a1abdd66256064935d2`). `scripts/build-engine.mjs` excludes `diagnostics/` from release-source dirty checks/package inputs. Do not install or delete this staging set. |
| `scratchpad` | **HOLD — secret-bearing** | A file named `relay-secret.txt` exists; its contents were not read. Preserve securely; exclude from reports, packages, and ordinary backup copies. |
| Dirty or unavailable worktrees and their untracked paths | **HOLD** | `git worktree list --porcelain` still reports missing/prunable registrations and the project `.worktrees` root remains inaccessible, including under the approved read-only elevated query. `.release-excluded` is also inaccessible. Tracked patches and admin/index evidence are preserved, but untracked checkout data cannot be reviewed. Do not prune/reset. |
| 112 Git `tmp_obj_*` files (~2.19 GB) | **HOLD** | Metadata is recorded, but complete ownership, reference value, and recovery value are not proven. No `git gc`, `git prune`, or manual deletion. |
| Source-only cleanup guard patch | **KEEP — unpromoted source** | Removes an unsafe prefix scan and narrows cleanup to manifest-owned runtime paths. It has not been built, installed, or functionally validated; the one-time sidecar cleanup was performed with a separate exact-path/hash/manifest check, not by running the current installer. |

## Follow-up exact mapping and install-path findings

The three retired engine sidecars are all present in `install-manifest.json`'s `runtimeFiles`; no separate config entry references them. Their current hashes map as follows:

| Exact sidecar | Bytes | SHA-256 | Matching preserved identity |
|---|---:|---|---|
| `m9r-engine.exe.m9r-retired-1793228209501-1375c783-2e4c-43fa-a7b7-faa30e1231be` | 94,942,720 | `74be427670ae53989090c3ae1f101da3a40d8c9296bd07e848fb753578edfc83` | Build `b7e95ff…`; exact local copy at `diagnostics/recovery-staging/m9r-engine.exe`, whose metadata reports explicit component-recovery build `22d3b904…`, base `b7e95ff…`, source commit `29d868dc…`, source dirty. The separate component-recovery directory has metadata but no engine executable. No other matching engine was found in the 18 ZIPs or same-size binary files searched across the listed recovery roots. |
| `m9r-engine.exe.m9r-retired-1793240976786-4c9a5829-582e-45f6-a05b-98926f016d82` | 94,942,720 | `02d78d527b034cdbfaecd7b69b08f0e13414409340b5aefddfe7dbab2bdd1868` | Build `dddadff…`; exact SHA-256 match to the preserved rollback `bin\m9r-engine.exe`. |
| `m9r-engine.exe.m9r-retired-1793241604254-71ff98e4-8579-4116-bcf4-519233d3d73e` | 94,955,520 | `0c39fb7771d016af3a684edd826c016fc311634d64eba21778d114f3315ea8fd` | Build `efe0b71…`; exact SHA-256 match to `runtime/m9r-engine.exe` inside the preserved intermediate ZIP. |

The sidecar hashes and preservation mapping above are retained as incident evidence. Before removal, the current installed manifest listed all three exact paths; the first file had an exact hash-matching staging copy despite incomplete provenance metadata, the second matched the rollback engine, and the third matched the preserved intermediate ZIP entry. A fresh Restart Manager query returned zero users for all three exact files. The cleanup rechecked each expected SHA-256, each exact manifest entry, all retained copies, and all 185 accepted runtime hashes; it then removed only the three sidecars and those three manifest entries. The resulting manifest keeps the accepted build identity, and the full bin reconciliation found no extras or missing owned files. No process was stopped.

### Owner-provided active-process path evidence (2026-10-29)

The owner supplied Task Manager Details captures with both `Image path name` and `Command line` fully visible. They show all listed active M9R processes launched from the same canonical directory, `C:\Users\kaina\.m9r\bin`:

- `m9r-engine.exe` and `m9r-hook.exe` use that directory; `m9r-overlay.exe` and `m9r-web-broker.exe` do as well.
- In the command-line capture, engine instances use `mcp` except one `feed --watch --serve-hooks` instance; hook instances use `mcp`.
- The broker command line is `m9r-web-broker.exe --home C:\Users\kaina\.m9r --port 47821 --project-root C:\RunLeak\runleak`.
- The two screenshots are different process snapshots: the path capture shows 9 engines and 7 hooks, while the command-line capture shows 10 engines and 8 hooks. This confirms multiple process instances from the same image paths, not multiple active binary locations. The screenshots do not identify each parent/client or prove that every instance is expected.

This supersedes the earlier process-name scan that saw no M9R processes. It verifies the image paths shown at capture time; the exact retired sidecars were separately checked with Restart Manager and removed only after that query reported zero users. This does not classify historical copies in recovery archives or inaccessible roots.

The source/test contract had one stale assertion for the removed `pruneRetiredRuntimeFile(file.to)` helper. I updated `scripts/install-m9r.test.mjs` to assert the current manifest-scoped helper, path ownership, and evidence-preservation flag. No test was run; the owner should run the focused test before any cleanup candidate is built or installed.

Packaging and installation have different protections. `scripts/build-engine.mjs` excludes `.m9r-release-current-*`, recovery quarantine, and `.test-tmp` from release inputs. The current checked-out `scripts/Install-M9R.ps1` validates the owner-accepted build ID, full artifact inventory, and hashes; the older installer copies inside retained archives may predate that guard. Do not launch an installer from any recovery/quarantine package. The three live sidecars were retired with the exact-path one-time cleanup recorded above; any future cleanup behavior in a packaged updater still needs owner-run test and release validation.

### Exact cleanup completed in this pass

Removed these three exact files after checking manifest ownership, SHA-256, preserved copies, and zero Restart Manager users:

- `C:\Users\kaina\.m9r\bin\m9r-engine.exe.m9r-retired-1793228209501-1375c783-2e4c-43fa-a7b7-faa30e1231be` — `74be427670ae53989090c3ae1f101da3a40d8c9296bd07e848fb753578edfc83`.
- `C:\Users\kaina\.m9r\bin\m9r-engine.exe.m9r-retired-1793240976786-4c9a5829-582e-45f6-a05b-98926f016d82` — `02d78d527b034cdbfaecd7b69b08f0e13414409340b5aefddfe7dbab2bdd1868`.
- `C:\Users\kaina\.m9r\bin\m9r-engine.exe.m9r-retired-1793241604254-71ff98e4-8579-4116-bcf4-519233d3d73e` — `0c39fb7771d016af3a684edd826c016fc311634d64eba21778d114f3315ea8fd`.

The current live manifest SHA-256 is `458abb06ec124feccc49f28efd64ce84ed3136002bb499b414c7650dbfbb30d4`; the pre-cleanup manifest remains preserved with hash `479368ebca93f6f8e1c93eaf6656e40d10421adf98436d269a9c6990bf1ba24f`. The accepted 185-file runtime and pill hash were rechecked after removal.

### Already completed, exact cleanup (do not count as current purge authorization)

The prior audit removed two hash-verified completed runtime transaction folders after preserving the unique intermediate and confirming the other generations in separate verified releases; it also removed one verified-empty transaction placeholder and one empty staging repository. The transaction cleanup freed `864,712,804` bytes. Later exact cleanup removed the rejected Cargo release/debug pill hardlinks, the unsigned stale Tauri NSIS installer, the unapproved package, and the duplicate accepted-package copy; hashes and receipts are recorded in `M9R_WP0_SOURCE_GUARD_RESULTS_2026-10-29.md` and the package-removal receipts. The accepted runtime, provider configuration, test fixtures, recovery roots, quarantine, worktrees, and Git objects were not removed. No Git garbage collection or pruning was run.

## Order to close WP0 safely

1. Keep the accepted release, UI lock, and rollback frozen. The local accepted checkpoint and exact M9R recovery copies are the rollback boundary for this pass. External storage is owner-managed and outside this audit; no external location is used.
2. Resolve ownership and preserve untracked data for missing/prunable worktrees; do not reset or prune them while `.worktrees` remains inaccessible.
3. Keep recovery archives, quarantine, `.test-tmp`, `scratchpad`, Git temporary objects, and `.release-excluded` isolated from packaging and assign individual retention decisions. Never bulk-delete unreadable, secret-bearing, or ambiguous paths.
4. Run the focused release-guard and cleanup checks before building or installing a new cleanup candidate. The latest agent validation is recorded in the closeout update below; the installer integration did not complete successfully in the sandbox.
5. Keep WP1 changes separate until its own review. Do not merge or install WP1 as part of WP0.
6. The accepted source baseline has now been captured on `wp-order`; keep the uncommitted WP1 diff separate. WP0 still needs successful installer validation and an owner-controlled startup/reboot check. No old binary remains in the canonical installed `bin`; historical rollback copies remain only in preserved archives.

## Actions in this follow-up

Read-only registry/task inspection confirmed the Run entry and exact broker task action; the live task remains at its legacy `Win7` compatibility metadata and was not edited. Source now requests `Win8` for future re-registration and recognizes the exact prior `Win7` ownership marker. Restart Manager reported zero users for the three retired sidecars. An exact-path cleanup removed those three files, atomically removed only their ownership entries from the live manifest, preserved the pre-cleanup manifest in the project checkpoint, and revalidated all 185 accepted runtime hashes plus a zero-extra/zero-missing inventory of `bin`. No live install, task registration, process stop, provider task, UI action, Git GC/prune, or reboot was performed. `.worktrees` and `.release-excluded` remain unreadable even to the read-only elevated query.

## Final WP0 closeout pass — 2026-10-29

- The pre-WP1 recovered source snapshot is committed on branch `wp-order` as `56ead0c7`; the audit/evidence record is `a4d8fc2a`. The source snapshot matches the preserved pre-OpenCode working-tree patch. The remaining uncommitted source diff is the incomplete OpenCode WP1 multiplayer change; it is not part of either commit.
- The source guard commit `eba5d493` remains an ancestor. The accepted engine metadata still records build `e507012c…`, source commit `29d868dc…`, and `sourceDirty=true` from build time. The source changes are now captured in Git, but no rebuild was done to rewrite that historical build metadata.
- `scripts/native-install-core.test.ts`: 31/31 passed after correcting stale assertions for the current Win8 task settings and v6 standing-instruction marker.
- The focused installer check confirmed the cleanup guard assertion and accepted release packaging. Its consent-preview, no-autostart, decline, and bad-checksum cases passed. Three install/update/uninstall cases failed with `EPERM` while renaming the staged engine inside an isolated Windows AppContainer temp profile. A follow-up used a fresh test root under the user's normal Windows Temp directory, outside the repository, with fake profiles and `-NoAutostart -NoLaunch`; that run produced fixture/package directories but did not return a trustworthy test summary. It was stopped after the command wrapper remained silent, so it is **inconclusive**, not a pass. Only that freshly created test root was removed after exact-path verification. No live M9R files, task, processes, or provider configuration were touched by either test attempt.
- Held-data decisions are final for this pass: **KEEP** accepted/rollback releases and recovery evidence; **HOLD** `.m9r-recovery-quarantine-20261014`, `.test-tmp` (including `.key`-suffix files), `scratchpad` (secret-named file), raw diagnostics, Git temporary objects, and every unreviewed recovery archive. `.worktrees` and `.release-excluded` returned access denied even for a read-only elevated listing; their ACLs were not changed. No further exact-path deletion candidate was proven safe, so nothing else was deleted.
- The installed-bin cleanup and source snapshot are complete. WP0 remains open for successful installer integration validation, a real owner startup/reboot check, and access-backed disposition of the two unreadable roots. The live scheduled task remains Win7 until normal M9R setup applies the source's Win8 contract; this metadata does not select a Windows or Notepad version.
