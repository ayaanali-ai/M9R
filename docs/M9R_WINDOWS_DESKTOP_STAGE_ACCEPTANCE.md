# M9R Windows desktop stage — Track A step 3

**Status:** **PARTIAL — owner-session isolation, background actions, and task-lifecycle proof pass; pill, room, second-machine, and release gates remain**

**Updated:** 2026-10-05
**Roadmap:** Track A step 3 / master P3

## Implemented locally

- A machine-local Windows stage registry now writes version 3. It stores the Windows desktop GUID and exact anchor PID/HWND locally, plus random opaque UUIDs for room coordination. Windows desktop GUIDs and process/window identifiers are not sent to a room.
- The Rust helper inspects the requested PID/HWND pair through Microsoft's public `IVirtualDesktopManager` API. Moving another process's window uses the build-gated shell application-view interface: the public move API refused the live fixture. The helper resolves only that exact HWND, verifies its PID and resulting desktop, and checks the active desktop remains unchanged. It never substitutes a process's main window.
- Create, inspect, activate, return, register, move, and forget commands are wired through the CLI and native pill. Desktop creation does not switch away from the owner’s active desktop; open and return are explicit actions. The undocumented shell COM lifecycle adapter fails closed outside Windows 11 build baselines 26100 and 26200.
- The pill invokes the same CLI through a detached native child process. Its explicit owner-UI marker permits that non-terminal call; agent-context markers still deny the operation, even when the marker is present.
- The expanded Windows desktop pill has a local Stage tab with stage selection, create/open/return, local window discovery, explicit attach-to-stage, and a local snapshot of the registered anchor window. The browser extension does not receive this machine-local capability.
- The Windows engine packages Cua Driver 0.33.4, its Windows DLL and Node add-ons, and the required third-party notices. The adapter captures only the registered anchor window, moves only the Cua ghost cursor, and routes click/type/scroll/drag to the exact registered PID/HWND. Click explicitly requests background delivery. Other actions use the Driver's window target; any refusal or non-confirmed result is shown without retrying through foreground input. The pill requires the owner to enable local input before clicking or dragging the preview. Typed text is passed from the pill to the local engine through stdin JSON rather than a process command line. Images and entered text remain local and are not included in room events.
- Room coordination accepts opaque `desktop:<machine-uuid>:<stage-uuid>` and `window:<machine-uuid>:<anchor-uuid>` keys. Room leases serialize coordination only; they do not grant access to a computer. Transition activity is explicitly member-reported. The additive lease-function migration was applied to hosted Supabase with owner approval; the live database checks are recorded below.
- Jev remains separate from CUA-S1. Jev is existing, optional server-side message-routing judgment and stays off by default. CUA-S1 is a narrow computer-use model, not a substitute for message routing. Keep Jev; consider CUA-S1 only as a separate optional evaluation under C12 after evaluating its model artifacts and fit. See [CUA-S1 repository](https://github.com/trycua/cua/tree/main/libs/cua-s1) and [model card](https://github.com/trycua/cua/blob/main/libs/cua-s1/MODEL_CARD.md).

## Per-agent OS cursor update — visible-overlay proof passed; M9R task sign-off pending

- The dependency, lockfile, rebuilt engine, and installed Windows package contain Cua Driver 0.33.4; packaged metadata for the JavaScript driver and Windows native package was verified. The owner-machine install's engine, pill, broker, and standalone cursor-host hashes match the built package. Upstream [0.33.4 release notes](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.33.4) do not claim a cursor-motion enhancement; M9R configures the session-owned cursor motion API available in 0.33.4.
- The owner-launched task broker keeps one Cua Driver runtime and creates a stable named cursor session for each verified agent handle/session pair. Each OS-level overlay label is formatted `@<agent>-<8-character-session-tag>` and capped at Cua's 28-character display limit; the M9R Stage list separately shows the full agent handle and session fingerprint. The session is refreshed idempotently on each authorized action to avoid Cua's five-minute idle-session expiry. Motion now uses Cua's distance-based glide timing with a curved path, click dwell, and 15-second idle hide instead of the previous fixed 220 ms glide. Task click, scroll, drag, and explicit cursor actions route through that identity while remaining targeted to the registered window. Cursor colors remain Cua-owned; M9R does not yet select explicit per-agent colors.
- The machine-local stage registry records only the normalized agent handle and an eight-character session fingerprint. Raw provider session IDs, Windows desktop GUIDs, PID/HWND values, screen frames, and typed content are not added to room events.
- A live Windows proof launched the bundled Cua Driver 0.33.4 standalone host, created a session using M9R's `@<agent>-<session-tag>` identity format and configured glide motion, and moved its labeled ghost cursor across the actual desktop. Cua reported the cursor overlay visible after both moves; the physical mouse position was unchanged. This proves the cursor is a Windows screen overlay, not pill-only artwork. It used a synthetic proof identity and direct driver calls, so it does not yet prove that a real connected agent's task reaches this path through the currently installed pill/broker.
- The rebuilt and installed local Windows package includes the integration; the focused adapter suite, TypeScript check, Windows package build, and package hash comparison pass. One direct owner-session proof showed a synthetic labeled ghost cursor moving on the actual screen without moving the physical pointer. The integrated M9R task route and multi-agent owner-session behavior remain unverified. Each provider session currently maps to its own stage; co-locating agents on one stage and cross-machine desktop streaming/control remain separate work.

### Per-agent cursor acceptance gates

1. Typecheck the source and run the focused stage/Cua adapter tests. The Windows engine rebuild and packaged Driver metadata check are complete: both packages report `0.33.4`.
2. In the owner's interactive Windows session, use two distinct, verified agent handle/session pairs. Confirm each gets a different Windows stage, a stable Cua cursor session/badge, and the corresponding handle in the pill's Stage list.
3. Send actions through both verified sessions. Confirm each cursor/action reaches only its registered window, with the owner desktop and physical pointer left alone. M9R serializes these actions through the owner broker; separate identities do not mean simultaneous native input.
4. Revoke one agent's control permission while its cursor is visible. Confirm the cursor is ended, later actions from that session are denied, and the other session remains usable. Leave one session idle beyond Cua's documented expiry, then confirm the next authorized action refreshes its cursor session and motion settings.
5. Sign off only from the retained owner-session report, not from the dependency pin, Stage labels, or a single-agent fixture proof.

## Cross-machine stage direction — not implemented

- Cua Spaces is the behavioral reference: its docs describe separate Spaces for agents, machine registration/relay, and a viewer's own named cursor on a read-only live stream. Its `cua-spacesd`/RCDP implementation is source-available, so M9R will reproduce the needed behavior with its own broker and Cloudflare/Supabase contracts; this repo uses only the MIT Cua Driver package for local cursor sessions. See [Spaces overview](https://cua.ai/docs/spaces), [sharing](https://cua.ai/docs/spaces/reference/sharing), and [agent cursor API](https://cua.ai/docs/cua-driver/reference/mcp-tools/agent-cursor).
- Do not add a separate viewer-only desktop app. Each computer runs the normal M9R Windows pill and its local owner broker. The agent and its Windows virtual desktop stay on the computer where that agent runs; the machine must remain powered on, signed in, and running the broker to host a live stage.
- After the single-machine cursor proof, enroll each computer as an owner-controlled machine (C7). Share only an explicitly selected, registered stage window through a Cloudflare room relay; Supabase continues to provide room identity and membership. The other pill receives rate-limited frames and agent cursor labels in read-only mode. It receives no HWND, PID, Windows desktop GUID, credential, or raw provider session ID.
- Remote control is a later C4 lease: a viewer requests the stage lease, the source broker pauses the agent's queued actions, checks owner policy and exact-window identity again, and performs approved actions locally. Releasing the lease resumes the agent queue. Revocation and access events are recorded; no viewer can reach Windows input directly.
- C3 is the browser-tab relay acceptance and does not prove desktop-stage streaming. Build and verify its Cloudflare relay first, then extend its authenticated room relay contract for native stage frames. The stage-frame relay, machine enrollment, and cross-machine takeover each need their own acceptance proof before we claim cross-machine desktop support.

### Cross-machine implementation order

1. Sign off single-machine per-agent stage/cursor behavior above.
2. Finish C4 lease pause/handoff and C15 multi-window ownership so a remote human has a safe control contract.
3. Finish C3 browser-tab relay for the authenticated room transport, then implement C7 machine enrolment before using that transport for desktop stages.
4. Add a separate, explicitly consented desktop-stage frame/cursor relay. C3 passing does not pass this gate. Start read-only; only add remote control after the source-broker lease, revocation, and audit checks pass.
5. Verify with two installed M9R pills on two computers: source machine stays awake with its owner session and broker running; viewer gets changing, rate-limited frames and labels but no input; after an approved lease, actions are executed by the source broker on the exact stage window. Do not send local HWND/PID, desktop GUID, bearer credentials, raw session IDs, or typed text to the other machine.

## Local verification recorded — 2026-10-05

- `npm run typecheck` passed after the local window picker and window-targeted input actions were added.
- `npm run test:desktop-stage` passed: 57 tests across local stage lifecycle, Cua window discovery/capture/cursor/input adapter, room coordination/events, cross-machine room contracts, and pill bridge.
- `npm --prefix pill run build:desktop` passed with the Stage window picker and explicit local-input controls.
- `cargo check --manifest-path overlay/src-tauri/Cargo.toml --target-dir .workcache/step3-overlay-target` passed without warnings.
- `npm run build:engine` rebuilt the local engine and broker with the Cua window action adapter.
- `cargo test --manifest-path native-input-host/Cargo.toml --target-dir .workcache/step3-native-target` passed 15 Rust tests.
- The release executable was launched from the isolated owner-session folder. The latest owner proof reuses the registered proof desktop and separately creates a task-scoped desktop. Reproducible build caches and superseded staging folders were removed after retaining the final verified installer package and latest proof result.

These checks prove code, tests, and packaging. The saved owner-session proof below also verifies real fixture effects while the owner desktop stays active.

### Latest owner-session proof — 2026-10-05

- `.workcache/step3-owner-proof/2026-10-05T18-10-22-629Z/result.json` is the retained latest run: **20/20 phases passed**. It verified the owner desktop stayed active, only the owned target window moved, background capture, explicit open/return, and task-scoped app launch, click, type, capture, revocation denial, and cleanup.
- The harmless native fixture recorded click counter `0→1`, text entry, scroll position `0→360`, and drag counter `0→1`. These observed fixture effects make the action checks meaningful even though the low-level Driver replies label their delivery `unverifiable`.
- This supersedes the earlier failing owner-session runs. Those repeated generated run folders were removed; the latest passing report remains.

## Live acceptance still required

### Input-route boundary — 2026-10-05

- The earlier WinForms button failure came from `Button.OnMouseUp` requiring the active-desktop hit test. The helper now sends the reflected `BN_CLICKED` command only for an enabled `WindowsForms10.BUTTON.*` control after exact PID/HWND and stage validation.
- This is a bounded WinForms control adapter, not universal background pointer input. Other controls keep their existing route. The latest owner-session fixture proves the button effect; no desktop activation or foreground fallback was added.

### Product lifecycle gaps found on 2026-10-05

- Approved inbox tasks can request session-scoped desktop preparation through the owner-launched broker. The owner must separately allow the agent in the native pill. Identity, task recipient, session, approval, and unfinished-state checks are enforced; duplicate preparation reuses the desktop. MCP inbox, Codex queued delivery, and Claude Code's normal prompt-hook inbox delivery request preparation before the task is injected. The pill already sends tasks through the local engine. OpenCode currently has a SessionStart hook rather than a per-prompt hook; its MCP inbox path can request preparation when the agent checks inbox. A focused Claude hook integration proof is added; live acceptance still requires a real connected provider session and verifying the named Stage/cursor through the visible pill. Arbitrary existing owner windows and desktop switching remain owner actions.
- These are Windows Task View virtual desktops, not virtual machines. A preview does not guarantee that hidden windows accept background input. Refused input must remain visible and must not silently fall back to the owner's foreground desktop.
- Startup is optional and per Windows user. The installer completed from a process running as `msi\\codexsandboxoffline`, even though its `USERPROFILE` pointed at `C:\Users\kaina`; the install manifest says autostart is enabled, but the owner account's Run-key entry and visible launch were not verified from that process. Verify startup by running setup in the owner's Windows session and checking after sign-in. Second-machine setup is also pending. Startup is not enabled for other users automatically. A development executable in `.workcache` is not a supported installed release.
- Automatic updates are not implemented: `verifyUpdateManifest` has tests but no production caller. Release installation needs signed artifact verification, staging, compatible engine/pill/Driver versions, idle restart, rollback, and offline retry. Devices update when online and safe to restart, not simultaneously.
- Second-machine acceptance must include clean installation, sign-in startup, task-triggered stage provisioning, and upgrade/restart persistence. Manual launch proof does not satisfy these lifecycle checks.

1. From the expanded native pill in the owner's normal Windows session, exercise Refresh, Create, Open, Return, Find app, Move here, capture, and ghost cursor. Confirm unrelated windows stay on the owner desktop.
2. Repeat the harmless desktop-app click/type/scroll/drag proof through the visible pill controls, not only the owner-session harness; retain before/after fixture state and Driver outcomes.
3. The approved additive room-lease migration is applied and database-level acquire/contention/release/member checks passed. Still verify two active room members through the app can acquire/release one stage lease and report a transition, while the room receives no screen pixels or machine control.
4. Test clean installation, sign-in startup, task-triggered stage provisioning, and upgrade/restart persistence on the second machine. On this machine, startup is registered but has not yet been observed across a reboot.
5. Decide whether the undocumented shell COM lifecycle API is acceptable for a released supported product. Current build gating is experimental compatibility protection, not a Windows support guarantee.

## Cost and data boundary

### Current acceptance boundary — October 5, 2026

- The stage-lease migration has been applied with owner approval. Transactional database checks passed acquisition, contention, holder-only release, next-member acquisition, and non-member denial for opaque desktop/window keys. This is database evidence, not a two-member app demonstration.
- The task lifecycle has approved executable IDs and owner arguments, broker-owned process tracking, task-scoped input/capture, revocation checks, and a passing owner-session proof. The proof creates a task stage and does not switch the owner's desktop.
- Step 3 stays partial until the native pill controls are exercised live, room-member lease behavior is shown in the app, second-machine install/startup/restart is accepted, and the shell COM support decision is made.
- One live Windows proof confirmed a named ghost cursor moves on the actual screen with the physical mouse unchanged. The matching rebuilt runtime and standalone cursor host are now installed on the owner machine. That proof used a synthetic identity and direct driver calls; integrated M9R agent-task and two-agent proofs through the pill are still required before acceptance.

The stage lifecycle and Cua capture/cursor path run locally on Windows. Stage frames and entered text stay in the pill process and are not sent to the room. The approved room-lease migration is already applied to Supabase; the current remaining room check is a two-member app-level demonstration. The M9R sign-in entry is a separate, per-user Windows setting and does not enable startup for other user profiles.
