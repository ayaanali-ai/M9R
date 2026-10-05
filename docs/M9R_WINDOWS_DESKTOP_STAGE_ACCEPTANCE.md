# M9R Windows desktop stage — Track A step 3

**Status:** **PARTIAL — local implementation and build proof complete; live acceptance remains open**

**Updated:** 2026-10-05
**Roadmap:** Track A step 3 / master P3

## Implemented locally

- A machine-local Windows stage registry now writes version 3. It stores the Windows desktop GUID and exact anchor PID/HWND locally, plus random opaque UUIDs for room coordination. Windows desktop GUIDs and process/window identifiers are not sent to a room.
- The Rust helper inspects and moves only the requested PID/HWND pair through Microsoft's public `IVirtualDesktopManager` API. It verifies the resulting desktop after a move.
- Create, inspect, activate, return, register, move, and forget commands are wired through the CLI and native pill. Desktop creation does not switch away from the owner’s active desktop; open and return are explicit actions. The undocumented shell COM lifecycle adapter fails closed outside Windows 11 build baselines 26100 and 26200.
- The pill invokes the same CLI through a detached native child process. Its explicit owner-UI marker permits that non-terminal call; agent-context markers still deny the operation, even when the marker is present.
- The expanded Windows desktop pill has a local Stage tab with stage selection, create/open/return, a local snapshot of the registered anchor window, and a Cua Driver ghost cursor overlay. The browser extension does not receive this machine-local capability.
- The Windows engine packages Cua Driver 0.33.2, its Windows DLL and Node add-ons, and the required third-party notices. The adapter captures only the registered anchor window and moves only the Cua ghost cursor. It does not move the user's OS pointer or send click/type/scroll/drag input, and it does not stream the image to a room.
- Room coordination accepts opaque `desktop:<machine-uuid>:<stage-uuid>` and `window:<machine-uuid>:<anchor-uuid>` keys. Room leases serialize coordination only; they do not grant access to a computer. Transition activity is explicitly member-reported. The additive lease-function migration is present locally but has **not** been applied to hosted Supabase.
- Jev remains separate from CUA-S1. Jev is existing, optional server-side message-routing judgment and stays off by default. CUA-S1 is a narrow computer-use model, not a substitute for message routing. Keep Jev; consider CUA-S1 only as a separate optional evaluation under C12 after evaluating its model artifacts and fit. See [CUA-S1 repository](https://github.com/trycua/cua/tree/main/libs/cua-s1) and [model card](https://github.com/trycua/cua/blob/main/libs/cua-s1/MODEL_CARD.md).

## Local verification recorded — 2026-10-05

- The last clean `npm run typecheck` passed earlier in this work. The current whole-repo run is **not green**: it reports an unrelated Worker handler typing mismatch at `services/cron-scheduler/src/index.ts:80` and extension-refresh action/type errors at `src/lib/native/web-setup-core.ts:426`.
- `npm run test:desktop-stage` passed: 44 tests across local stage lifecycle, Cua capture/cursor adapter, room coordination/events, cross-machine room contracts, and pill bridge.
- `cargo test --manifest-path native-input-host/Cargo.toml --target-dir .workcache/step3-native-target` passed 15 Rust tests.
- `npm run build:engine` succeeded and produced the Windows engine and broker plus bundled Cua Driver runtime.
- `npm --prefix pill run build:desktop` succeeded.
- `cargo check --manifest-path overlay/src-tauri/Cargo.toml --target-dir .workcache/step3-overlay-target` and optimized `cargo build --release --manifest-path overlay/src-tauri/Cargo.toml --target-dir .workcache/step3-overlay-target` passed. The release overlay binary is 3,342,336 bytes; it was not launched or installed.
- `scripts/package-engine-release.ps1` created a local Windows engine ZIP and SHA-256 file. The final ZIP is 81,834,543 bytes, its verified SHA-256 is `cc725d62732122abb722e48514e603d2f3d986c1d55cf510b034ff787ba8c388`, and all 11 required engine, Cua Driver runtime, and notice entries are present. It is an unsigned local artifact, not a published or installed release.

These checks prove code, tests, and packaging. They do **not** prove desktop switching or Cua behavior against a real app window.

## Live acceptance still required

1. In the owner's interactive Windows session on a supported build, create a stage and confirm the original desktop remains active; open it; return; register/move a test app window; verify the exact window changes desktops and an unrelated window does not.
2. From the expanded native pill running in the owner's normal Windows session, exercise Refresh, Create, Open, Return, local window capture, and ghost-cursor movement on that registered app window. Confirm the captured image changes when the app changes. Agent-context markers remain a hard deny; no stage was created or switched from this Codex agent process.
3. Complete the desktop-app Cua Driver validation included in the Track A sign-off order. This slice supports capture and a ghost cursor only. Cua Driver click/type/scroll/drag integration and live results are still open; C5's compatibility report alone does not satisfy C14.
4. Apply the local room-lease migration only after explicit approval for this hosted Supabase change. Then verify two active room members can acquire/release one stage lease and report a transition, while the room receives no screen pixels or machine control.
5. Decide whether the undocumented shell COM lifecycle API is acceptable for a released supported product. Current build gating is experimental compatibility protection, not a Windows support guarantee.

## Cost and data boundary

The stage lifecycle and Cua capture/cursor path run locally on Windows. The feature adds no Cloudflare Worker, hosted browser, daemon, login task, or paid service. The room migration would change hosted Supabase only if separately approved and applied. Local window images stay in the pill process and are not sent to the room by this implementation.
