# M9R / Cua wave plan

**Current source of truth: 2026-10-07**

This is the active status list for C1–C15. It replaces older planning language that described Cua parity as a novelty claim. A status below is only marked complete when the acceptance evidence is present; design notes and local smoke tests remain partial.

## Rules

- Cua Driver, SDK, Bench, and Lume are MIT-licensed and may be used directly with their notices preserved.
- Spaces, `cua-spacesd`, Keyvault, and Volume are source-available with a no-competing-hosted-use clause. We may study behavior, but do not copy their code.
- AGPL components, including OmniParser and `cua-som`, are out of scope.
- Cua overlap is described as parity or a deliberate M9R implementation. We do not claim that an existing Cua capability is a new invention.
- C5 is a compatibility report. M9R's browser input path remains its own CDP broker. The Windows desktop-stage runtime separately packages Cua Driver for exact-window capture and ghost-cursor work; the M9R web app has no Cua Driver runtime dependency.

## Status legend

- **DONE** — acceptance evidence is complete and the item is signed off.
- **PARTIAL** — implementation, research, or local evidence exists, but at least one acceptance gate is open.
- **REMAINING** — no acceptance evidence for the requested outcome yet.
- **DECISION / BLOCKED** — a required scope or dependency decision must happen before implementation can be accepted.

## Wave 1 — demo and cross-user

| ID | Status | Evidence and remaining gates | Current framing |
|---|---|---|---|
| **C1** | **DONE — signed off** | Dedicated agent-owned Chrome path, synthetic live click/type/no-banner checks, and normal-browser owner setup are verified. A signed-in GitHub session survived stopping and restarting the M9R-controlled channel in the same isolated profile. See [C1 acceptance](M9R_C1_AGENT_CHROME_ACCEPTANCE.md). | Keep as written. The setup path separates provider sign-in from the debug-controlled agent channel. |
| **C2** | **DONE — signed off** | Live quiet typing and drag, one-writer-per-tab scheduling, and public fixture evidence are recorded. Focused input tests pass 4/4. See [C2 acceptance](M9R_C2_QUIET_INPUT_ACCEPTANCE.md). | Keep as written. The scheduler is M9R-specific; Cua's quiet driving does not provide this room scheduler. |
| **C3** | **PARTIAL — deferred by sequencing; not signed off** | Room-member broadcast implementation, migration, local typecheck/build/smoke tests, and 11 focused room tests pass. The reviewed Cloudflare Linux build/preview deployment and two-machine changing-frame proof are still open. The owner has explicitly deferred this acceptance until the OS-level stage work and its dependent desktop-stage work are complete. See [C3 acceptance](M9R_C3_LIVE_TAB_ACCEPTANCE.md). | Keep the build. Describe the differentiator as read-only, rate-limited, disclosure-gated relay behavior; Cua Spaces already streams video and cursors. |
| **C4** | **REMAINING — not signed off** | No accepted M9R lease/handoff proof is recorded. | Build our own implementation for parity with Cua Spaces; do not present it as a Cua gap. |
| **C5** | **DONE — signed off** | Final owner-session run with official Driver 0.33.2 records screenshot, click, type, scroll, and drag outcomes for Chromium, Electron 44.5.1, and the native Notepad fixture. Background refusals and unverifiable deliveries are explicitly classified; no failed capability is presented as a pass. See [C5 report](M9R_C5_CUA_DRIVER_WINDOWS_RETEST.md). | Keep the Windows re-test. This is a compatibility report, not proof that M9R has integrated Cua Driver. |

## Track A sequencing status

| Step | Status | Evidence and boundary |
|---|---|---|
| **2 — room-agent adapter (master P1)** | **DONE — audited and accepted** | Existing authenticated room routes cover join, membership, events, leases, handoffs, and memory. Existing local MCP/bridge tools cover the equivalent agent surface with room namespacing, identity checks, inbox delivery, results, shared notes, and browser actions. Focused MCP, broker, and room-contract checks pass. No duplicate room system was introduced. Lease/handoff tool exposure remains Track A C4 by design. See [adapter acceptance](M9R_ROOM_AGENT_ADAPTER_ACCEPTANCE.md). |
| **3 — OS-level stage groundwork (master P3)** | **PARTIAL — owner-preview path, package install, and local agent-desktop roster implementation; integrated agent/pill acceptance remains** | The retained latest owner proof passed all 20 phases: only the owned window moved, the owner's desktop stayed active, background click/type/scroll/drag changed the native fixture, task-scoped launch/capture worked, and revoked/completed work was denied and cleaned up. The additive room-lease migration is applied; database-level authorization/contention checks passed. The source and rebuilt engine pin Cua Driver 0.34.0 with adaptive/Fitts cursor motion. The owner-preview mode binds an approved app to the owner's current desktop without creating or switching desktops; the package was installed and the pill launched with sign-in startup enabled. A direct synthetic identity proof showed a labeled OS cursor moving without moving the physical pointer. The owner confirms the Stage tab is now visible (2026-10-07). Still open: prove a real connected agent routes a visible cursor action through the installed broker/pill; exercise roster assignment and Join/return live; demonstrate two distinct agent cursor sessions and revocation; demonstrate a two-member room lease in the app; accept second-machine install/sign-in/task/restart; and decide support for the undocumented shell COM API. See [Windows stage acceptance](M9R_WINDOWS_DESKTOP_STAGE_ACCEPTANCE.md). |

## P0 — Local Windows package and installer

**Status: COMPLETE locally; public release and demo acceptance remain separate gates.** The release package and installer now cover the M9R engine, desktop pill, web broker, native input host, and matching Windows cursor runtime. The owner-machine install completed: installed engine, pill, broker, and cursor host hashes matched the built package; sign-in startup points to the installed pill, which launched after setup. Installer, typecheck, engine, and pill builds passed. The updater now stages and atomically replaces a Windows-locked engine while preserving already-running agent MCP sessions; the old mapped image remains tracked for later cleanup.

This does **not** publish a GitHub release or prove a clean install/restart on another machine. Live per-agent task-to-cursor proof through the installed pill and the CDP-default/extension-retirement gate also remain open. Do not describe the product as publicly released or demo-ready from this package milestone alone.

## Wave 2 — product parity and depth

| ID | Status | Evidence and remaining gates | Current framing |
|---|---|---|---|
| **C6** | **PARTIAL — design only** | Workspace/profile/site/room concepts are described, but no accepted M9R Space build exists. | Keep the build, but the name is Cua's too. Define and prove the better M9R network/consent behavior before calling it differentiated. |
| **C7** | **PARTIAL — design only** | Network-core work provides a foundation, but no accepted machine registry/enrolment flow is recorded. | Keep. Treat overlap with Cua fleet/CLI auth as unconfirmed until a direct comparison is finished. |
| **C8** | **PARTIAL — design only** | No signed, replayable room export and replay-viewer acceptance artifact exists. | Keep. The gap is room-scoped approvals, signatures, and multiplayer evidence; Cua Bench already exports structured trajectories (ATIF). |
| **C9** | **DECISION / BLOCKED — scope correction** | The old “nothing like this exists in Cua” sentence is not verified. A direct read of `cua-sandbox` / `cua-spaces` is required before implementation scope is frozen. | Keep the scheduler build, but correct the claim before it is used as product or investor copy. |
| **C10** | **PARTIAL — feasibility not complete** | No current Cloudflare Browser Run limits, cost, or sign-in persistence report is accepted. | Keep as a feasibility/catch-up report; Cua already offers a hosted sandbox. |

## Wave 3 — depth

| ID | Status | Evidence and remaining gates | Current framing |
|---|---|---|---|
| **C11** | **PARTIAL — design only** | No accepted Windows DPAPI-backed, per-domain reviewed-login implementation is recorded. | Keep as table-stakes parity. Keyvault cannot be copied. |
| **C12** | **PARTIAL — decision recorded; evaluation not started** | Jev already exists as optional, off-by-default server-side message-routing judgment. It is not the same job as CUA-S1's narrow computer-use model. Do not replace Jev; any CUA-S1 adoption evaluation is a separate C12 decision. | Preserve Jev's existing scope. Evaluate CUA-S1 only if its specific computer-use capability fits a later requirement. |
| **C13** | **PARTIAL — benchmark design only** | No completed two-agent-plus-person benchmark run or scorecard is recorded. | Keep. Multiplayer handoff measurement remains a genuine M9R gap. |
| **C14** | **PARTIAL — owner-session fixture proof passed; pill-path acceptance open** | The retained owner-session proof records click, type, scroll, and drag effects on a harmless Windows fixture and task-scoped app lifecycle. Exercise those actions through the visible native pill controls and broaden app validation before sign-off. | C5 is the compatibility report; it does not itself prove M9R desktop control. |
| **C15** | **OPTIONAL — design only; not a demo gate** | Windows Task View already lets the owner inspect and switch between virtual desktops. The current demo still needs the M9R roster and exact Join/return behavior, but it does not need a custom tiled/window-pool view. | Keep as optional future work only if user testing shows Task View plus the M9R roster is insufficient. |

## Current count

- **Done:** C1, C2, C5 (3)
- **Partial:** C3, C6, C7, C8, C10, C11, C12, C13, C14 (9)
- **Remaining:** C4 (1)
- **Decision or scope blocker:** C9 (1)
- **Optional:** C15 (1)

C3 still needs the reviewed Cloudflare build/deploy and two-machine frame proof, but that proof is intentionally deferred until the OS-level stage sequence below is complete. C1, C2, and C5 are signed off as recorded above.

## Owner sequencing decision — 2026-10-04

The owner explicitly moved C3 behind the OS-level Phase 3 work. C3 is not cancelled and is not signed off; it stays **PARTIAL** until its Cloudflare artifact and two-machine changing-frame proof are accepted.

## Sign-off order

1. **OS-level stage groundwork (master P3):** establish the Windows virtual-desktop stage, the native cursor/window control path, joinable app/window/desktop ownership, visible cross-desktop transitions, and the Jev-vs-CUA-S1 decision. C14's desktop-app Driver action validation is part of this stage because C5 is already complete. Owner-session isolation, background fixture actions, task lifecycle, hosted database lease checks, and the owner-preview implementation now pass local checks. The exact Driver 0.34.0 package is installed on the owner machine and the pill launched with sign-in startup enabled. A synthetic labeled cursor has moved on the real screen; real connected-agent task routing through the installed broker/pill and two-agent cursor behavior remain unverified. Visible-pill controls, two-member room UI, second-machine lifecycle, and the shell-COM support decision still prevent sign-off.
2. **C4 takeover/hand-back:** prove the broker lease and clean agent pause/resume on the stage.
3. **C3 live-view acceptance:** run the reviewed Cloudflare Linux build/deployment and the two-machine changing-frame proof, with viewer controls absent.
4. **C6–C13:** continue the remaining product-parity, recorder, scheduler, hosted-browser, approved-login, and benchmark work in the table above, respecting the C9 and C12 decisions first.
5. **C15 (optional):** revisit a custom tiled/window-pool view only if Windows Task View plus the M9R roster does not meet user needs.

## Merged adjacent release and demo gates

These items come from the ranked Windows-launch audit and other active plans. They are included here to provide one working checklist; they do not change the C1–C15 acceptance definitions or the owner-approved order above.

### Windows launch gates mapped to the roadmap

| Gate | Relationship to C1–C15 | Remaining acceptance |
|---|---|---|
| Pill task routes to a real agent's Stage and shows the owning session | Same as Track A step 3 | The pill sends tasks through the local engine. Approved inbox tasks request session-scoped Stage preparation through MCP inbox and Codex queued delivery; Claude Code's prompt hooks also request preparation before inbox injection. The 2026-10-07 delivery handoff records OpenCode `UserPromptSubmit` support, superseding the older SessionStart-only note. The owner confirms the Stage tab is visible; verify a real connected agent and labeled cursor through the installed pill, then exercise roster assignment and Join/return. |
| Version-matched engine, desktop pill, broker, input host, cursor runtime | Same as P0 package | Locally packaged and installed; the old audit claim that the package omitted the pill/runtime is superseded. Publish a Windows release asset and verify a clean install on machine two. |
| Two real agents with distinct OS cursor identities | Same as Track A step 3 and C14 | Synthetic visible cursor proof passed; two verified real sessions, isolated actions, revocation, and continued operation of the other session remain open. |
| Pill as the single user-facing Stage and messaging surface | Same as Track A step 3/P0 | Shared pill UI code has the agent desktop roster, task/current-status field, and Join/return controls. The owner confirms the Stage tab is visible; live roster data and Join/return behavior remain to be accepted. Desktop and browser host adapters are still separate. |
| Cross-provider live work appears inside the caller's active session | Separate provider-interoperability acceptance | This is stricter than an @mention, inbox pickup, tool call that returns an answer, or queued task followed by result injection. While agent A's real task remains active, agent B must visibly appear and do its work inside A's live session; B returns the result there, A reviews it, and A resumes. Prove both Claude → Codex and Codex → Claude for the requested demo. The inspected Codex delivery path queues work into B's session and later collects its rollout; OpenCode's inbox hook injects work at its next prompt. Neither is evidence of B visibly working inside A's live session. Claude usage is unavailable until Friday, so Codex ↔ OpenCode can be an interim delivery check only, not a substitute for the Claude acceptance. |
| CDP browser path and extension retirement | Separate from C1 | C1 proves the dedicated agent-owned Chrome profile signs in and persists across restart; it does not prove `m9r_web_*` uses CDP by default. Normal web setup still configures the extension transport, while the separate `m9r chrome` path supplies CDP. There is no capability-negotiated hybrid yet. Keep the extension until its host permissions, content scripts, tabs/cookies, extension UI/service-worker, and owner-profile needs are mapped and covered. Webpage actions use the configured M9R web route; native OS windows use Stage/Cua. A CDP-to-native-window cursor bridge is also open if the demo requires the OS cursor to visibly track browser-page actions. |
| Startup and updates on clean installs | Same as P0 and second-machine lifecycle | The installer enables current-user sign-in startup by default unless `-NoAutostart` is passed, and launches the pill after setup. A successful launch after setup is recorded; cold sign-in/reboot persistence in the owner's normal Windows session and second-machine install/restart remain open. Atomic staging for a locked engine exists; signed automatic updates, coordinated component versions, rollback, and offline retry do not. |

The supported `npx m9r-cli` setup still requires Node and web setup still instructs users to load the extension. The standalone Windows installer is a separate no-Node route. A GitHub Windows release exists, but it predates the current local work; the current package changes are not publicly released. This remains a distribution gap.

### Cross-machine desktop is separate from C3

C3 proves **browser-tab** viewing only. C7 is machine enrolment. Cross-machine **desktop-stage** viewing requires a separate read-only relay for explicitly selected stage frames and cursor labels after machine enrolment; remote control then requires C4's source-machine lease. None of those desktop-frame relay/control gates is passed by C3. The implementation boundary and order are in [Windows Stage acceptance](M9R_WINDOWS_DESKTOP_STAGE_ACCEPTANCE.md).

### Related active plans outside C1–C15

| Plan | Current state | Relationship / remaining work |
|---|---|---|
| **Network Core Phase 0** | Passed against the deployed Cloudflare Worker on 2026-10-03 | Separate foundational network work; pairing, credentials, events, inbox, rotation, and revocation passed. Not a duplicate of desktop Stage or C3. |
| **Personal-agent Network Phase 1** | Local implementation; not deployed or live-tested with Muse, Dots, or Grok Bot | Parked by the owner's later instruction to focus on Claude Code, Codex, and OpenCode. Do not treat it as a current Windows launch blocker. |
| **Claude Code/Codex/OpenCode provider interoperability** | Repository implementation/tests exist; live directional acceptance is open | The demo requires a delegated call visible inside the caller's active session, with the caller resuming after the recipient returns work. Prove Claude→Codex and Codex→Claude. The provider matrix's other directions plus approval, interruption, activity, and revocation remain fuller support sign-off; tests alone do not pass them. See [provider matrix](M9R_PROVIDER_CAPABILITY_MATRIX_2026-10-05.md). |
| **Cloudflare scheduled-job operations** | Scheduler deployed; two `idle-session-sweep` runs recorded | Three other sweep logs remain open: `work-signal-sweep`, `stale-run-sweep`, and `workflow-scheduler`. This is operational sign-off, not a local cursor-demo prerequisite. See [system map](M9R_SYSTEM_MAP_2026-10-05.md). |
| **Open-core/public launch** | Separate release/legal gate | A successful two-provider run overlaps the provider matrix and should reuse that evidence, not become duplicate testing. Counsel review remains separate. `OPEN_CORE_LAUNCH_PLAN.md` has a 2026-09-11 checkpoint and historical Render evidence; reconcile it with the current Cloudflare deployment map before using it to guide a release. |

The audit's CDP review, C9 repository comparison, C10 Browser Run feasibility report, and demo/storyboard drafts are supporting tasks for the matching rows above, not additional roadmap items. Keep the positioning **“The multiplayer web for agents”** for now; Cua and other products are engineering references, not the launch headline.

### Public-launch consistency gates (owner direction, 2026-10-07)

- **Waitlist:** the owner confirms the waitlist is open. Checked-in pricing and FAQ copy still says there is no waitlist; reconcile the public copy and verify the actual signup path before promoting it.
- **Stripe:** complete product/price setup and a live payment/webhook acceptance before the demo, as requested by the owner. Current billing configuration is disabled and the checked-in product identifiers need review; no live Stripe acceptance is recorded.
- **Licensing and business model:** open-core versus fully open source versus paid access remains undecided. This can follow the demo, but settle it before making public licensing/pricing promises or publishing a release.
