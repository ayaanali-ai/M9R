# Five independent follow-ups — 2026-10-17

Scope: investigate 1/2, design 3, implement 4, research 5. No changes to history capture, cursor startup behavior, observation semantics, or provider model configuration were authorized by these investigation items. No active M9R/provider service was stopped, restarted, installed, or replaced. No desktop input was sent.

## 1. Duplicate session/history entries — investigation, not fixed

There are several different stores; they must not be conflated:

- Local capture: `cross-agent-capture-setup-core.ts` generates SessionEnd hooks which append provider/session/transcript-path jobs. `cross-agent-capture-core.ts:drainCaptureSpool()` collapses jobs by provider + session ID, writes one stable `local/<provider>/<sessionId>.md` and `.summary.md`, and rebuilds the index. `memory-command.ts` can create missing summaries. `memory-distill-core.ts:buildIndex()` renders one line per summary file, not per turn.
- Dashboard evidence: `agent-join-service.ts:recordAgentSession()` inserts a new `agent_sessions` row per submission. `submission_digest` is stored, but this function does not use it as an idempotency key; the additive attestation migration does not make it unique. This is a replay-duplication risk, not evidence that the reported UI used this path.
- The archived conversation catalog uses `conversation_sessions` through `bridge/session-service.ts`. It is not the local markdown index or the evidence table.
- `run-history.ts` is a separate browser-local analysis history and appends a new random run ID; do not change it to repair an unrelated history surface.

Confirmed parser defect/mechanism: `parseCodexTranscript()` appends every role-bearing record without checking its message ID. A diagnostic fixture consisting of the same response_item/message ID twice returned 2 messages. The analogous Claude fixture with one repeated UUID returned 1, because `parseClaudeCodeTranscript()` uses a last-write-wins UUID map. This can duplicate transcript messages; it does not by itself create multiple summary files or multiple history cards.

Local inventory: one Codex summary and 48 Claude summaries. Several Claude first-goal headings repeat across distinct session filenames. Equal headings are not enough to call those duplicates: resumed/forked sessions may legitimately share an initial goal. Existing capture/distillation/setup suites passed 33/33, including same-session spool deduplication.

Additional observed drift: this checkout's generated `.m9r/bin/m9r-capture.mjs` still targets `.oathlock/capture/pending.jsonl`, whereas current generator source targets `.m9r/capture/pending.jsonl`. It was not regenerated or edited during this investigation.

Disposition: no history fix made. To attribute the owner's particular repeated entries, correlate their actual surface and underlying row/file IDs with provider session + turn IDs and upload/capture triggers. Do not deduplicate by title or text alone; identical legitimate messages and repeated tasks must survive. A future fix should use stable provider message/turn identity for transcript capture and submission-scoped idempotency for uploads, after confirming which writer caused the observed symptom.

## 2. Cursor acquisition — measured current startup, historical 101 seconds unresolved

Reproducible diagnostic: `node --import tsx scripts/profile-cursor-acquisition.ts`.

The script creates a private diagnostic Cua daemon and named session, sends no input, never moves a pointer, repeats idempotent session setup twice warm, and ends the session/closes only that daemon. It does not attach to or restart the running broker. These numbers are from one Windows run outside the restricted sandbox:

| Phase | Milliseconds |
| --- | ---: |
| SDK import | 81.31 |
| Host spawn + pipe connection + metadata validation | 221.48 |
| Cold startSession | 12.00 |
| Cold cursor-motion configuration | 3.83 |
| Warm startSession / motion, sample 1 | 1.63 / 1.58 |
| Warm startSession / motion, sample 2 | 2.34 / 2.95 |
| endSession | 4.24 |
| Close owned diagnostic host | 6.67 |

Cold acquisition total before cleanup: 318.62 ms. A second isolated run measured SDK import 90.80 ms, host/connect/metadata 1249.09 ms, session 5.11 ms and motion 2.89 ms: 1347.89 ms total. Its warm pairs were 3.75/3.46 ms, with session end 2.49 ms and host close 8.22 ms. The two samples show host-start variability; they are not a percentile benchmark. This is not a timing of the full Explorer task or a live broker tool call.

Final diagnostic also explicitly checks the motion ToolResult's isError field, not just whether the Promise resolved. That run succeeded: import 80.27 ms, host/connect 262.76 ms, session 3.86 ms, motion 2.80 ms (349.69 ms total); warm pairs 5.04/7.18 ms, endSession 3.61 ms, host close 8.37 ms. No motion-configuration refusal was ignored.

Sandbox control: the same diagnostic inside the sandbox failed with `The Cua Driver host did not become ready within 12 seconds (DriverError.Transport).` Outside-sandbox acquisition succeeded. The failure cleanup belongs to `startCuaDriverHost()`; no retry/prewarm change was made in production code.

Source path: `createRuntime()` loads the SDK and calls `startCuaDriverHost()`; `agentRuntimePromise` caches the connection. `ensureAgentSession()` intentionally calls startSession and motion configuration on every authorized action to refresh the native TTL. Host readiness retries every 100 ms under a nominal 12-second deadline; an individual awaited RPC is not separately bounded by that loop condition. `task-desktop-stage.ts` has a separate up-to-60-iteration window-discovery loop, with existing `[stage-launch-poll]` timing logs. It must not be counted as cursor acquisition. Current inspected broker log files did not contain that historical timing breakdown.

Conclusion: this measurement does not support attributing 101 seconds to lazy cursor acquisition. Exact historical attribution remains unproven. Next diagnostic should correlate one real request's authorization/queue wait, SDK load, host connection, session setup, window discovery, structure/capture, input, and verification with one operation ID and monotonic durations. Do not add prewarming or change timeouts merely from the owner's task's total wall-clock duration.

## 3. Finding M: change tracking — design only

Current `computer-use-mcp.ts:saveObservation()` creates a random revision for every successful observation. That is a freshness/concurrency token; comparing two revisions always differs and cannot tell whether the UI changed. No semantic previous/current comparison is returned. Claude's truncation-honesty changes remain intact.

Proposed contract:

1. Keep freshness revision independent from a versioned `structureFingerprint`.
2. Normalize only observations already collected: role, label, supported actions, enabled/selected/expanded state, stable parent relationships, and the existing privacy-safe value policy. Exclude capture timestamps, transient ref/token strings, and image bytes. No extra observation or background polling.
3. Keep only the previous bounded normalized observation for the same authenticated identity, exact logical window/tab, route, and native incarnation. Reuse existing TTL/cap eviction. Never compare different sessions, windows, navigation incarnations, or routes as one scene.
4. Return `change.status = initial | unchanged | changed | unknown`, `comparedToRevision`, fingerprint schema version, and bounded added/removed/updated counts. Diffs must not expose secret values. Use stable native element identity when supported; otherwise report aggregate changes without claiming durable element correspondence.
5. An incomplete/truncated/unavailable tree cannot establish that the whole target is unchanged. Report unknown for full-structure equivalence, with an explicitly scoped returned-subtree comparison if useful. Do not mistake missing/unobserved controls for removals.
6. Separate geometry change from semantic change. Scrolling/moving must invalidate unsafe input coordinates even if labels/actions remain identical. Observation fingerprints do not authorize replay or relax input preflights.
7. On comparison mismatch or navigation/recovery, start a new baseline; do not reuse an old content fingerprint as a valid input revision. A lost response must still use receipt reconciliation, not replay.

Required regressions before implementation sign-off: equal scenes/new freshness revisions; changed label/actions/state; geometry-only move; transient refs ignored; incomplete-to-complete transitions; cap/truncation; reordered indistinguishable siblings; different owner/session/route; closed/reopened window; navigation; bounded retention; secret-redaction preservation. No implementation made.

## 4. Durable colors — local transport implemented; dashboard ownership pending

Implemented:

- `feed-core.ts` accepts an injected allocator; `feed-writer.ts` supplies the existing local store's colorFor and publishes the durable assigned color in each agent row.
- `web-ui-bridge.ts` can serialize the same allocated color, wired by `scripts/m9r-web-broker.ts` to the same local store.
- Both pill shell converters preserve host colors. `PillSnapshot` carries the optional field, and pill rendering consumes valid six-digit hex colors instead of substituting a provider constant. Legacy payloads retain the existing fallback. Untrusted malformed style values are rejected.
- `colorFor()` reads existing assignments without taking a write lock; first allocation still rechecks under the existing store lock. Rendering an established identity therefore no longer rewrites state for every request.

Verification: 72/72 focused feed, pill-shell, pill-state, web-UI bridge and allocator/MCP tests passed outside the sandbox, including a cross-instance persisted-color read that leaves the state file's modification time unchanged. Initial sandbox failures were EPERM on temporary lock renames and EACCES on a test loopback socket; the new color assertions themselves passed. No installed pill rebuild/restart was performed.

Dashboard gap found: `AGENT_BRAND_COLOR` is read at four sites in three files (`WorkspaceUI.tsx`, `ConversationPanel.tsx` twice, `agent-workspace/task-card.tsx`). Cloud `AgentView`/connection payloads do not currently carry a color allocated by this local store. Importing the filesystem-backed local store into client components or inventing another browser allocator would be incorrect. Those sites are unchanged pending the cross-machine authority decision: workspace-authoritative durable assignments, or authenticated publication of each connected agent's local assignment. A question was sent to the owner. The chosen path needs authenticated serialization, stable identity/alias mapping, conflict handling, migration/backward-compatibility if persisted in cloud connections, and rendering tests. This item is not claimed complete.

Native theme color/design assets remain explicitly out of scope. No native cursor theme was changed.

## 5. Real cross-provider model picker — research only

Both products support actual model switching in their own interactive session: `/model`, rather than an M9R display label. This does not imply M9R can remotely mutate any unrelated already-running provider UI.

- Installed Codex package inspected: 0.153.4. Local help exposes `--model`, resume, app-server, and shared-daemon agent commands. Current official source exposes `ThreadSettingsUpdateParams.model/effort`, describes a `thread/settings/updated` notification, and per-turn model overrides. API availability must be checked against the actual installed server; main-branch documentation is not an installed-version acceptance test. M9R's existing Codex adapter already validates model/list choices, stores the selected setting between turns, and passes it to real `turn/start`; that is real execution configuration, but does not prove a second external TUI's picker refreshes.
- Claude official docs expose interactive `/model` and Agent SDK `setModel()`/`set_model()` on a streaming session. These affect the managed session, not an arbitrary other Claude process. Changing a startup flag or environment variable alone does not change the running session. Native picker selections may also save a global default; any UI-driven approach must explicitly avoid unintended persistence.
- Existing M9R ACP adapter applies model-category configuration choices through its provider connection. Capability discovery and provider acknowledgement are prerequisites; a database model string is not acknowledgement from the provider.

Feasible design: a capability-advertised provider adapter exposing discover/get/set, stable provider session identity, supported models/efforts, between-turn restrictions, provider acknowledgement/readback, and native notification/UI synchronization when the provider offers it. A setting remains pending or unsupported until acknowledged. No fake universal support or hardcoded global model catalog. No hot-switch during an in-flight generation is claimed.

Evidence required before shipping a picker: actual same-session provider acknowledgement, next-turn model identity, the provider's own UI showing the selection, restrictions/unsupported model refusal, reconnect persistence, and no accidental default changes. No model was changed during this research.

Primary sources:

- https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
- https://developers.openai.com/codex/app-server
- https://code.claude.com/docs/en/model-config
- https://code.claude.com/docs/en/agent-sdk/configuration

## Verification and boundaries

- Focused implementation tests: 72 passed, 0 failed/skipped.
- Existing capture/distillation/setup tests: 33 passed, 0 failed/skipped.
- Root clean nonincremental typecheck completed with exit code 0.
- Changes to shared dirty files were localized; no stash/reset, deletion of existing work, provider dispatch, deployment, database migration application, runtime installation, or active-process cleanup was performed.
- This report does not close the original twelve-item owner-readiness gates or overwrite other agents' live evidence.
