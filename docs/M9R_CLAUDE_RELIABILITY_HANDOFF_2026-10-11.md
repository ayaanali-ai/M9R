# Claude reliability assignment — 2026-10-11

Read `docs/M9R_CUMULATIVE_RELIABILITY_AND_DEMO_TRACKER_2026-10-10.md`, including its latest checkpoints, before starting. Work in `C:\RunLeak\runleak`. The owner has clarified that Codex may run automated validation now; only the owner's manual acceptance is deferred. Source changes are not installed-runtime acceptance.

This is a prepared handoff for the owner to give Claude. It has not been sent to another agent.

Codex's current validation: CLI build and TypeScript pass; scoped lint has zero errors/four existing warnings; focused runtime/package regressions pass 203/203. Delivery/restart/bridge/package checks pass 106/106, including 19 overlapping package tests. Installer fixture paths passed using existing standalone binaries. The new full standalone release has not been built or installed; automated checks do not establish live provider/desktop acceptance.

## Work Claude can start independently

1. **F1/F2/F9/F17: runtime and stale-process audit.** Inventory only M9R processes, parent/provider ownership, start times, executable paths, live listener ownership, hook/broker/MCP state roots, and each provider connection's actual reported MCP version/schema. Compare startup identity, installed artifacts, broker health, and setup ownership metadata. A current executable path or healthy broker does not prove an older MCP process loaded that build. Produce an exact reconciliation plan using the provider's normal managed reconnect and M9R's normal updater.
2. **F2: state and locks.** Diagnose `.m9r/state.lock` from its actual owner/process, root, ACL, and error context. Review corrupt/future-state preservation and migration. Sandbox fixture EPERM is distinct from an owner-runtime lock failure. Do not delete a live lock or reset identity/state to make a probe pass.
3. **F7/T47 and Step 4: finish the existing dictation assignment.** Continue the isolated pill speech work: permission/setup feedback, Alt+M and mic-button agreement, visible listening/interim feedback, one transcript insertion, cancel/release/failure handling, and explicit submission. The owner microphone run remains a later acceptance requirement.
4. **F7 and Step 6: pill clarity.** Prepare the concrete UI changes for readable task/history text, stable provider names/colors, less clipped composer/message content, and deduplicated events. Correlate stale activity with actual provider/session signals. Runtime event semantics stay with Codex; report the needed contract changes before editing shared modules. Behavioral polish follows the runtime gates in the tracker.
5. **F11: dependency remediation plan.** Reproduce the production audit and map each vulnerable dependency to the shipped surfaces and provider compatibility checks. Prepare reviewed, targeted package/lockfile changes in a separate patch or isolated checkout. Do not use `npm audit fix --force`. If a version change needs adapter/runtime edits, identify those files for Codex integration first.
6. **F10: cleanup inventory.** Classify all registered worktrees, generated distributions, scratch directories, retired images, and rollback backups by owner, references, dirty state, recoverability, and current process use. Keep an individually justified cleanup list. Age, an untracked file, or a dirty worktree does not establish that it is disposable.
7. **Independent review of Codex's reliability changes.** Read the current diff for F12/F14–F18 and the typing guard described below. Review authorization before/after approval waits, build matching, receipt replay, per-agent concurrency/revocation, capture/image recovery, exact-window selection, and package imports. Return file/line evidence for defects and missing coverage; leave these implementation files to Codex.
8. **F4/F5/F6/F8 and Steps 2/5/7: acceptance matrix.** Prepare exact tests for concurrent/duplicate delivery, lost-response reconciliation, terminal state versus late heartbeat, provider session/project identity, extension readiness and browser-instance identity, current route reporting, revocation, and truthful pill status. Include actual active-session Codex↔Claude and supported OpenCode directions; inbox delivery alone does not satisfy active-session collaboration.

## Concrete current runtime findings

- The installed manifest and all 185 artifacts verified as build `2f2152f24eba1c69234c9b71e177f6f7cc23b6c63fb13510d9ac7d89fd8375b1`. Live broker health reports that same verified build and `desktopStage: not-probed`. This is the previous installed build; the new source changes have not been installed.
- M9R MCP PIDs **18508** and **1312** started at 09:48:39 and 10:32:58 local time. The current engine file's write time is 10:44:50 local time. Those processes predate the installed file; their loaded-build identities remain to be established. MCP PID **24416** started at 10:54:01. Recheck all PIDs before using this inventory; processes can exit or PIDs can be reused.
- One retired image remains: `m9r-engine.exe.m9r-retired-1791733856002-b559289d-0c61-43c6-8edf-7c621a073009`. Determine whether it is still mapped/referenced before recommending removal.
- The setup manifest records native-helper hash `f094ffa10d2a31b0a0ab2c3d13a2054c091a23b36b6c005f60a289f7ebc77c98`; the verified installed build records `1ca89f69f1449ed75c053a251bbd08ab6f08b875cc4d14d31944ffa8d013206d`. This is confirmed metadata drift, not a proven cause of the Notepad failures. Codex added reconciliation to the normal verified update path; it is not installed yet.
- `git worktree list --porcelain` currently lists **20** worktrees. The historical/public checkout and independent Claude/Codex checkouts are included. Their safety for deletion has not been determined.
- `npm audit --omit=dev` still reports **8 vulnerabilities: 7 high, 1 critical**, involving MCP SDK/provider dependencies, proxy-addr, sharp/Next, and source-map-js. Treat this as the audit result; assess affected usage and compatibility before changing versions.

## Remaining desktop and demo work

| Finding or requirement | Remaining work | Owner/boundary |
|---|---|---|
| F1/F2/F9/F17 | Current provider schemas/loaded builds, state-root agreement, normal update/reconnect, rollback and second-machine acceptance | Claude audit; Codex runtime integration/update |
| F3/F13/F15/F18 | Packaged apps hosted by ApplicationFrameHost; unsupported app controls, double/right clicks, app-specific insertion and input routes | Codex implementation; Claude review and acceptance cases |
| F4/F14 | Durable one-shot effects across actual provider timeouts/reconnects; recovery and concurrent sessions in a real run | Codex integration; Claude matrix/review |
| F5/F6 | Real provider delivery claim/lease/ack, missed wakeups, terminal state, replay and truthful status | Codex source; Claude independent evidence review |
| F7/T47 | Pill dictation and real live activity; later actual microphone acceptance | Claude pill implementation |
| F8/C1 | Personal-profile browser, instance-aware extension readiness, native versus page route, restart/sign-in persistence | Claude matrix/audit; Codex browser integration |
| F10 | Owner/reference/snapshot-based cleanup plan | Claude inventory; individually reviewed cleanup later |
| F11 | Targeted dependency upgrades with provider/package compatibility evidence | Claude isolated package patch; Codex integration |
| F12 | Repeated owner Notepad blank-note and existing-note continuation tasks against the new installed build | Codex automated checks/update; owner manual acceptance later |
| F16 | New error/recovery paths in the installed runtime and real provider connection | Codex integration; Claude independent review |
| F19 | Actual Chrome native address-bar behavior; Cua Dom is an output enum, not a selectable ClickInput field | Codex targeted route validation; Claude matrix |
| F20 | Accessibility/Dom on an inactive virtual desktop | Codex live experiment with a fresh approved task; owner acceptance deferred |
| Per-agent Task View and C4 | F20-informed stable identity, desktop lifecycle, takeover/hand-back and explicit shared-input lease | Codex design/integration after F20 evidence |
| Cursor and Step 7 | Visible labels on all actions, owner-pointer isolation, 1/2/3-agent gates, repeatable natural tasks and machine-two install | Claude matrix; Codex integrated/live proof |
| Text insertion guard | `set_value` replaces whole contents. It now refuses nonempty/unknown field values for `type`. Existing-note insertion still needs a supported route | Codex implementation/acceptance; Claude verify no content loss |

Terminal applications remain deferred in section 0. Windows Task View does not by itself prove independent simultaneous OS input. Do not declare a route safe from its name or a mock result; retain the actual action evidence and physical-pointer observation.

## Files and operation boundaries

- Claude can continue the existing dictation/UI work in its pill files. The current related dirty files include `overlay/src-tauri/Cargo.toml`, `Cargo.lock`, `src/main.rs`, and `src/native_dictation.rs`; preserve their existing work and other owners' changes.
- For runtime audit automation, use new files such as `scripts/m9r-runtime-audit.mjs` and its own focused tests. Reports belong in a new `docs/M9R_CLAUDE_RELIABILITY_REPORT_2026-10-11.md`.
- A dependency patch owns `package.json` and `package-lock.json` in an isolated patch/checkout. Do not regenerate unrelated manifests or upgrade adapters silently.
- Codex owns the current changes in `src/lib/native/**`, `scripts/m9r-cli.ts`, `scripts/build-cli.mjs`, `scripts/install-m9r.ps1`, their regression tests, and the cumulative tracker. Claude reviews them and reports corrections rather than editing them concurrently.
- Do not stop the live pill/broker, kill provider MCPs, delete images/locks/worktrees, install a runtime, overwrite credentials/config, push, or deploy as an audit step. Prepare the exact affected target and recovery/reconnect sequence first. The current assignment is evidence gathering and the isolated source scopes above.

## Required return from Claude

Return the finding ID, observed evidence, current versus historical status, affected process/file/provider, proposed correction, changed-file list, exact test results, and remaining owner acceptance. Explicitly distinguish an installed-file hash, a process startup identity, a provider MCP handshake, and a visible successful task. Report blockers once with the concrete reason. Never include session tokens or unrelated private app text in a report.

The broader C3/C6–C14 roadmap, parked Network Core, cross-machine desktop relay, and release/billing decisions remain in tracker section 8. They are not newly assigned to Claude's parallel runtime audit. C3 still needs Cloudflare/two-machine browser-frame evidence; C1's personal-browser scope is open; C2 retains its historical sign-off.
