# M9R receipt, lifecycle, and build/install audit — 2026-11-14

Audited commit: `c591a3c12dc5b5d1ff8dc87d8b0fb511d617fb2f`, tag `release-20261114-recovery-v16`, branch `codex/recovery-build-20261110`. No application code, installed files, or live process state was changed. No build or installation was performed. Times below are UTC, matching the recorded JSON timestamps; subtract six hours for Chicago on this date.

## Findings that change the diagnosis

1. **T381 was not waiting five minutes for a liveness timeout.** Claude was executing desktop operations during that interval. Its terminal provider result arrived without a structured completion report, and the broker deliberately recorded `uncertain`. The five-minute duration is coincidental.
2. **There is a confirmed result-correlation bug.** A subsequent teammate turn was instructed to answer T383. Its task-ID-less `m9r_result` completed T381 instead, because recent desktop activity wins the fallback selection. T383 remains at `provider_received`. This also reproduces against the current MCP server in an isolated store.
3. **The managed execution path lacks a silence watchdog.** This is a real reliability gap, but it did not cause this particular five-minute interval. Receipt history is not an execution heartbeat, and this path does not record `started` on the first tool event.
4. **The examined v16 installation matches the candidate, but the build/install flow is not airtight.** There are concrete gaps in dependency provenance, source-change fencing, shared build intermediates, and helper exit confirmation.

## T381: reconstruction from independent records

Evidence: `.m9r/state.json`; `.m9r/broker.log`; `.claude/projects/C--RunLeak-runleak/8e5ef01b-3336-4db1-9b44-f533a901d0c8.jsonl`; current managed-owner, MCP, and receipt code.

| Time | Evidence and meaning |
| --- | --- |
| 22:26:49.777 | T381 accepted, addressed to **Claude**, not Codex. |
| 22:26:55.857 | Provider receipt recorded. |
| 22:26:59 onward | Claude launches Notepad and performs observations and actions. |
| 22:27:38 | Claude reports that Sticky Notes is foreground and tries to target Notepad again. |
| 22:28–22:30 | Desktop enumeration, focus attempts, inspection, repeated launch, then app-scoped structure reading. |
| 22:30:14 | Opens a fresh Notepad tab. |
| 22:30:25–22:31:28 | Several type/replace/ref retries; the successful insertion occurs near the end. The stage ledger includes actual errors, including no replaceable field at the point. |
| 22:31:45–47 | Final capture after a stale read-value reference fails. |
| 22:31:51 | Calls `m9r_team_message` with a confirmation for Codex. This is a message, not a task-completion receipt. |
| 22:31:56 | Natural-language final answer says the Notepad work is complete. **No `m9r_result` was called in this turn.** |
| 22:31:57.154 | Managed-owner completion timing ends: 305,500.84 ms from turn start; post-action wrap-up is only 5,798.78 ms. |
| 22:31:57.785 | Broker records `uncertain`, source `provider-session`. |
| 22:31:59 | New prompt asks Claude to answer teammate task **T383** with `m9r_result`. |
| 22:32:01 | Claude calls `m9r_result`, structured status `completed`, omitting task ID as its tool schema recommends. |
| 22:32:02.777 | **T381** receives that result. The transition helper synthesizes `provider_received` and `started` immediately before `completed`. |

The 301.928-second interval between provider receipt and uncertainty contains real work. It is not evidence of a five-minute quiet session or a blocked receipt pump. The transcript shows focus/target acquisition and failed editing attempts consuming much of the time. It does not show three or four rejected structured completion calls for T381; it shows zero before the first turn ends.

The decisive code is `managed-provider-owner.ts:813–825`: a successful provider terminal event, without an already-completed or paused task, calls `recordTaskResult` with **explicit `status: incomplete`**. `local-store.ts:2950–2966` records that as `uncertain`. This is not the text heuristic misreading “complete”; this branch explicitly requests incomplete regardless of that wording.

`inbox-core.ts:171–175` explains the same-second final three entries. They are inferred history inserted by one completion operation, not buffered transitions released together. Their `basis: inferred` fields are present in T381's real record.

The existing cursor evidence is consistent: the final broker entries for T381 change from `taskActive=true` to `false`, with `expired=false`. Nothing here implicates the cursor reaper. It correctly renders the task state it is given.

## Confirmed cross-turn result routing defect

`mcp-server.ts:1287–1300` describes task ID as an optional legacy field and tells normal provider-bound callers to omit it. `resolveResultTaskId`, at lines 610–635, searches **all open delivered tasks for the session**. With multiple candidates, it first asks `mostRecentlyActiveTaskId`, then falls back to newest creation time.

`local-store.ts:2141–2154` defines “active” here as the most recent stage-operation record within five minutes. It does not mean the current managed provider turn. Consequently, a recently finished desktop turn that missed its completion report can take the result intended for a later text-only teammate turn.

T381/T383 demonstrate the defect in live records:

- T381 retains recent desktop activity and an uncertain receipt.
- T383 is delivered at 22:31:59.282 and is explicitly named in the new prompt.
- The task-ID-less reply records its confirmation on T381, closing it at 22:32:02.777.
- T383 has no result or completion record and remains `provider_received` in the inspected snapshot.
- T385 is subsequently acknowledged normally, after T381 is no longer a candidate.

An isolated reproduction used the actual local store and MCP handler: create and deliver an owner task, settle a desktop operation on it, record an incomplete outcome, deliver a newer teammate task to the same session, then call `m9r_result` without task ID. Actual output was `first: completed`, `next: provider_received`, with a generic “Recorded result” response. No live tasks were touched.

Recommended repair direction: resolve results from the broker's authenticated **current turn/task binding**, including teammate turns. Do not use prior desktop activity as result ownership. Until that exists, require explicit IDs when multiple delivered tasks are open, and include the selected task ID in the tool acknowledgement. Preserve the existing ability to complete an uncertain task explicitly.

There is also a state-consistency issue: after T381 completes, its `logicalContext.state` remains `paused` and retains the old remaining objective. The completion branch updates receipt/lifecycle/result but does not clear the incomplete logical context. This does not explain the five-minute interval, but follow-up context can disagree with completed status.

## What liveness mechanisms actually exist

The brief's Codex leads are mostly a different transport path:

- `task-delivery-pump.ts` schedules **deferred** delivery. It is not an in-flight watchdog.
- `codex-watch.ts` / `codex-watch-core.ts` discover sessions and route typed mentions, with double-work detection. They do not advance this managed Claude receipt.
- `codex-liveness.ts` observes Windows file holders for session selection/readiness. It is not an execution-progress timeout.
- `collectCodexResults` explicitly skips `correlation: internal-context`; T381 has that correlation and is Claude work in any case.
- Legacy `claude-delivery.ts` transport failures are not the managed-owner terminal-result path used here.

The managed path is `managed-provider-owner.runTask` → supervisor dispatch → adapter event queue. The owner records provider acceptance, emits text/tool events, and records timings, but does not advance the receipt to `started` on first work. The supervisor awaits `connection.send`; Claude's adapter awaits its async queue. Process exit/error and terminal result settle that queue. `live-session-core.ts` has bounded control-request timers, not a timer for silence during an ordinary turn. Adapter readiness checks establish process availability, not ongoing task progress.

There is a pre-acceptance delivery timer: default 60 seconds, bounded to at most 120 seconds (`managed-provider-owner.ts:949`). Acceptance clears that wait. It does not cover execution afterward.

There is periodic retirement every five minutes (`managed-provider-owner.ts:1014`), but `retireStaleTasks` uses **creation age**, default **30 minutes** (`inbox-core.ts:658`), not last provider activity. Its uncertainty event has source `system` and an age-out error. T381 has source `provider-session` and was only five minutes old, ruling this out.

Recommended repair direction: record observed execution start; maintain separate last-event/progress timestamps; surface “no recent progress” without automatically replaying ambiguous work. A live-but-silent provider can currently remain open until retirement or an explicit stop/error/result. Retirement is not a suitable execution watchdog and can also retire genuinely long-running active work.

## Build and install: verified guarantees and limits

The clean-tree/branch/canonical-folder guard is real and executes before typechecking/building. The repository was clean at audit start. The candidate uses isolated output directories. CLI generation uses a fresh staging directory; esbuild performs fresh build calls rather than reusing an incremental build context. The Vite desktop command specifies `--emptyOutDir`.

`build-engine.mjs:245–248` unconditionally deletes the final pill executable on the normal Windows build path, invokes the Tauri build, and requires the executable afterward. Tauri's `beforeBuildCommand` rebuilds the current pill frontend. This removes the old static accepted-pill shortcut.

Retained artifacts corroborate that path:

| Candidate source | Pill last-write UTC | SHA-256 prefix |
| --- | --- | --- |
| 74a0ce3a | 09:12:49 | 9fe1fc95e797 |
| a8ca64f1 | 20:14:02 | 67fa966e8b54 |
| 8939fea3 | 20:34:11 | ddf780569b83 |
| ae39347c | 21:02:28 | b3feee82396a |
| b6bb2f3f | 21:29:58 | 6b65500ed532 |
| c591a3c1 | 22:16:31 | 881fe3ee65ac |

These six candidates have distinct pill bytes and `sourceDirty: false`. The latest target/release pill, candidate pill, and installed pill all hash to `881fe3ee65acf886c62ff6748f905736ac45f568eba76fdf5b620810956a7735`.

The latest candidate's exact runtime manifest verified successfully across **183 artifacts**, build ID `869c7e5c0d8831c6c7b40f8ca159eda0b7f9c12e89d6d816408973b88f9a9338`. All four installed M9R executables match their v16 candidate hashes. T381 records this same runtime build ID. This is strong evidence against a stale installed executable as T381's cause; it is not a measurement of every historical process's loaded memory.

Specific gaps:

1. **Clean Git does not verify dependencies or toolchains.** `node_modules`, Rust targets, and generated outputs are ignored. The build does not perform or validate a lockfile-exact dependency installation across the involved packages, nor attest installed package contents/toolchain versions. The native host runs `cargo build --release`, retaining its existing target directory; the overlay retains Cargo intermediates too. Normal incremental reuse is expected and does not itself prove staleness, but deleting one final EXE is not a clean rebuild of every Rust dependency. Hashes prove which output bytes shipped, not that every build input matched the lockfiles.
2. **Source cleanliness is a snapshot, not a build-wide fence.** The entry guard runs once. Engine provenance is computed after CLI generation and before the remaining compile. The content diff computes `sourceDirty`; it does not reject a dirty value. Candidate packaging records that flag, and local-candidate installation does not require it to be false. Edits during compilation are not prevented, and there is no final comparison tying all compiled inputs to the initial commit. This is a concrete time-of-check/time-of-use gap.
3. **Candidate isolation does not serialize shared intermediates.** Engine builds share `.m9r-engine-cli-input`, `.m9r-engine-bundle.cjs`, overlay output, and Cargo target paths. There is no build-wide mutex in these scripts. Concurrent builds can interfere despite unique final candidate directories.
4. **`--resume` is an intentional exception to “every run rebuilds.”** It verifies and packages an existing unfinished candidate without recompiling. Its recorded source may differ from the current checkout. The tag guard still permits that older tagged candidate; it is not a guarantee of installing current HEAD or the newest release.

The local installer genuinely checks receipt/ZIP/source/runtime/pill correspondence and requires a `release-*` tag pointing at the source commit. v16 has that tag. These checks establish package identity; they do not close the input-provenance and concurrency gaps above.

## Process replacement and duplicate helpers

The normal installer ordering is sensible: disable broker autostart, authenticate/stop the owned broker, stop and wait for the pill, reject surviving installed engine/native-host processes, apply files, restore/start the broker, then launch the pill. CLI broker-update additionally checks exact broker image processes and uses PID/path/start-time guarded termination. This is materially stronger than merely checking HTTP health.

It does **not** prove “no old and new binary can ever overlap”:

- `windows-desktop-stage.ts:1991–2005` checks a terminating helper, issues another kill if still alive, then clears its PID and spawns immediately. Despite its comment, it does not wait and recheck for exit. A kill failure is swallowed. Replacement overlap remains possible.
- `closeManager` and native host `close` issue kills without awaiting exit. `reapOrphanStageChildren` also kills without exit confirmation, then overwrites the PID list with `[]` even when a kill fails.
- The orphan list records bare PIDs, without path/start-time or parent-generation identity. A later manager can target a recycled PID, unlike the broker updater's stronger exact-process guard.
- The installer's surviving-process check is a point-in-time check, not an exclusion lock against independent MCP/helper launches during copying. Path-inspection exceptions are treated as nonmatches. Autostart disablement closes the scheduler race, not every possible launcher race.

Read-only host process inspection found one installed broker, one pill, three desktop-stage servers, one cursor-overlay host, and four engine MCP/dev-server processes. All observed starts are after the v16 broker launch at 22:22:49; there is no observed pre-update survivor. The three stage-server PIDs (7828, 12432, 22136) all have that broker as parent and match the persisted PID list. Multiple servers are legitimate here: the manager owns a default host plus separate hosts per input stream (`windows-desktop-stage.ts:555–560`). Their mere coexistence is not evidence of the historical orphan defect.

Recommended repair direction: await confirmed exit before replacement, fail closed on termination failure, persist exact child identity, and use a shared update/build exclusion mechanism where required. No live restart was performed to test those changes.

## Named-pipe collision and renderer evidence

The exact collision exists in **`.m9r/bin/broker-stdout.log`**, not the current `.m9r/broker-stdout.log`. Its last-write time is **2026-11-12 05:03:51 UTC**. The latter file currently contains a successful startup and was last written November 14 at 21:11:56 UTC.

`owner-pipe.ts:28–72` attempts the named-pipe listen and rejects on collision; there is no reconciliation with an already-running owner at this boundary. The line establishes a failed competing bind at that historical moment. It does not identify the process holding the pipe or distinguish a leaked broker from a deliberate/manual second launch. The current process snapshot has only one broker. No persistent stale-owner or repeatable leak can be concluded from this evidence alone. To resolve the historical cause, retain both launch histories and capture pipe ownership/process identity at the next collision.

The cursor renderer repair is present at `cursor_overlay.rs:1256–1272`: failure logging, renderer recreation, and immediate retry. The available `cursor-overlay-debug.log` contains no `stderr`/render-failure matches, so it does not demonstrate that recovery has been exercised. It does record several readiness timeouts followed by termination and successful replacement, including 22:22:52–22:22:59. Those are startup-readiness failures, not proof of Direct2D target loss. No fresh renderer runs or fault injection were performed.

## Validation and UX assessment

Existing focused tests ran: completion contract, managed-provider owner queue, MCP inbox/result handling, and engine-build transaction. **32 passed; 14 failed.** All 14 owner-queue tests fail during profile setup with `managed provider connection ID contains unsupported characters`, before their behavior assertions. In this sandbox, the temporary path contains `#!sandbox...`; `encodeURIComponent` retains `!`, while the connection-ID regex rejects it. This is a validation/fixture-path compatibility issue, not evidence that 14 production execution paths failed. It also means this run does not validate the owner-queue behaviors. The separate isolated MCP reproduction succeeded and exposed the routing defect described above. No test or production code was modified.

The cursor/chatter presentation merits a separate design pass. Task lifetime, recent pointer activity, agent reasoning, and teammate conversation are different states. Keeping one cursor-associated bubble for the full task makes long targeting/retry sequences feel stuck even when work continues. A compact pill notch also offers little space to identify both speaker and recipient or distinguish progress from confirmed completion. Prefer a quiet recent-action cursor with bounded visual persistence, a separate working/waiting status, and an explicit conversation surface for agent-to-agent exchanges. This is a design assessment based on the lifecycle and the owner's supplied observations, not a fresh visual usability review.

Repair priority: current-turn result binding first; then observed start/progress and missing-report handling; then confirmed helper exit and build/update fencing. The cursor reaper and the classic-Edit-only WM_CHAR safeguard do not need to be undone to address these findings.
