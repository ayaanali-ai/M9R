# M9R Source of Truth 5.0 — Maintenance and Deployment Contract

Status: working contract for the provider-neutral desktop runtime.

This document records the operating model that keeps M9R easy to maintain without reducing capabilities, action coverage, provider support, or runtime efficiency.

## 1. Product boundary

M9R is one product with one canonical user installation. The user should see one simple install, one simple update action, and one simple uninstall path. Internal source history, build staging, and recovery evidence are engineering concerns and must not become extra runtime installations.

The canonical Windows runtime is `%USERPROFILE%\\.m9r\\bin`. Only the approved manifest may select files for that runtime.

## 2. Process roles

Multiple Windows processes do not automatically mean multiple installed engines. The expected roles are:

| Role | Expected behavior |
| --- | --- |
| `m9r-overlay.exe` | One visible pill/app overlay. |
| `m9r-web-broker.exe` | One managed broker, started by the M9R logon task. |
| `m9r-engine.exe feed --watch --serve-hooks` | One resident feed/hook supervisor. A feed lock rejects a duplicate. |
| `m9r-engine.exe mcp` | Short-lived or bounded MCP bridge instances. Several can exist for concurrent provider/tool calls. |
| `m9r-hook.exe mcp` | Short-lived hook adapters associated with provider calls. |
| Provider process | One long-lived managed process per configured provider connection where supported; tasks are multiplexed through it. |

The runtime must expose process role, executable path, parent/owner, provider, task/turn identifier, start time, and cleanup state so that valid concurrency is distinguishable from an orphan or stale process.

Internal session identifiers may be used for exact process binding and routing. They are not user-managed provider sessions and must not become a second reconnect architecture.

## 3. Update transaction

Updates replace the current canonical installation; they do not create a second permanent M9R installation.

1. Make source changes on a named branch.
2. Run focused tests and commit the source change.
3. Build one candidate from that exact commit and the approved pill source.
4. Produce one manifest with one hash per canonical runtime path.
5. Stage the candidate temporarily outside the live runtime.
6. Verify the candidate manifest, source commit, and accepted pill identity.
7. Stop the managed pill, broker, resident engine, and provider children as one coordinated operation.
8. Replace only changed files in `%USERPROFILE%\\.m9r\\bin`; leave unchanged files in place.
9. Verify every installed file against the manifest and verify startup entries.
10. Restart the managed system once.
11. Remove temporary staging and transaction data after success.
12. Record the build ID, hashes, commit, tests, and process-path verification.

Windows executables cannot safely overwrite themselves while running. Temporary staging is therefore allowed during the transaction, but it must not become a permanent retired directory, alternate runtime, or user-visible installation.

Internal rollback checkpoints remain an engineering safeguard only. They are not a user-facing feature and must not be copied into the active runtime.

## 4. Source/build/runtime boundaries

- Source branches and Git history may retain prior source versions.
- Release staging may temporarily contain a candidate package.
- The live runtime contains only the current approved artifacts.
- Worktrees, diagnostics, checkpoints, recovery archives, and test outputs are never valid build inputs unless explicitly allowlisted.
- A binary found in a worktree or diagnostic folder must never be promoted merely because it has a plausible filename.

## 5. Commit discipline

Every implementation unit follows this loop:

1. One scoped change.
2. Focused verification.
3. Immediate commit.
4. Recorded commit, build ID, manifest, and test result.
5. Candidate promotion only from that commit.
6. Final tracked-worktree review before the next unit.

Untracked diagnostics must be classified as documentation, temporary evidence, or recovery data. They must not silently accumulate beside active source changes.

## 6. Dry-run acceptance tasks

These are read-only/low-risk provider checks. They should not change files, submit forms, buy anything, or perform destructive desktop actions.

### Codex

> Reply with exactly: `codex-ready`, then report your active model and effort. Do not open an app or use the desktop.

Expected proof: one complete response, active model/effort visible in the provider state, no desktop action.

### Claude

> Reply with exactly: `claude-ready`, then report your active model and effort. Do not open an app or use the desktop.

Expected proof: one complete response, provider process remains healthy, no desktop action.

### OpenCode

> Reply with exactly: `opencode-ready`, then report your active model. Do not open an app, edit files, or use the desktop.

Expected proof: one complete ACP response from the OpenCode process, no stale-task resend, no desktop action.

### Cross-provider dry run

> Codex, Claude, and OpenCode: each reply with your assigned readiness word only. Do not call tools, open applications, edit files, or send another task.

Expected proof: three distinct replies, correct provider labels, no collision, no duplicate delivery, and no new stale notice.

## 7. Acceptance evidence required before promotion

- Canonical executable paths.
- One resident feed process.
- One broker and one overlay.
- Provider readiness for each configured provider.
- Candidate and installed manifest equality.
- Accepted pill hash unchanged unless the pill was intentionally changed.
- No legacy overlay mode flag.
- No unknown permanent runtime folder.
- No unbounded orphaned MCP/hook processes.
- Focused tests pass or have a documented environment-only explanation.

## 8. Current observed baseline

The current live state has all three provider entries (`claude`, `codex`, `opencode`) in the desktop pill state as ready/idle. Codex and OpenCode expose model catalogs; Claude's catalog is currently unavailable. The running process inventory shows one resident feed engine, one broker, one overlay, and multiple canonical-path MCP/hook instances. Those multiple instances are expected concurrency, not evidence of multiple installed engine binaries.

