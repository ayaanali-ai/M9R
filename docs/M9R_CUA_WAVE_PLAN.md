# M9R / Cua wave plan

**Current source of truth: 2026-10-04**

This is the active status list for C1–C15. It replaces older planning language that described Cua parity as a novelty claim. A status below is only marked complete when the acceptance evidence is present; design notes and local smoke tests remain partial.

## Rules

- Cua Driver, SDK, Bench, and Lume are MIT-licensed and may be used directly with their notices preserved.
- Spaces, `cua-spacesd`, Keyvault, and Volume are source-available with a no-competing-hosted-use clause. We may study behavior, but do not copy their code.
- AGPL components, including OmniParser and `cua-som`, are out of scope.
- Cua overlap is described as parity or a deliberate M9R implementation. We do not claim that an existing Cua capability is a new invention.
- C5 is a compatibility report. M9R's current browser input path remains its own CDP broker; no Cua Driver package is a runtime dependency of the M9R web app.

## Status legend

- **DONE** — acceptance evidence is complete and the item is signed off.
- **PARTIAL** — implementation, research, or local evidence exists, but at least one acceptance gate is open.
- **REMAINING** — no acceptance evidence for the requested outcome yet.
- **DECISION / BLOCKED** — a required scope or dependency decision must happen before implementation can be accepted.

## Wave 1 — demo and cross-user

| ID | Status | Evidence and remaining gates | Current framing |
|---|---|---|---|
| **C1** | **PARTIAL — not signed off** | Dedicated agent-owned Chrome path and synthetic live click/type/no-banner checks exist. The owner sign-in persistence check after profile restart is still open. See [C1 acceptance](M9R_C1_AGENT_CHROME_ACCEPTANCE.md). | Keep as written. It is under-verified, not complete. |
| **C2** | **DONE — signed off** | Live quiet typing and drag, one-writer-per-tab scheduling, and public fixture evidence are recorded. Focused input tests pass 4/4. See [C2 acceptance](M9R_C2_QUIET_INPUT_ACCEPTANCE.md). | Keep as written. The scheduler is M9R-specific; Cua's quiet driving does not provide this room scheduler. |
| **C3** | **PARTIAL — not signed off** | Room-member broadcast implementation, migration, local typecheck/build/smoke tests, and 11 focused room tests pass. The reviewed Cloudflare Linux build/preview deployment and two-machine changing-frame proof are still open. See [C3 acceptance](M9R_C3_LIVE_TAB_ACCEPTANCE.md). | Keep the build. Describe the differentiator as read-only, rate-limited, disclosure-gated relay behavior; Cua Spaces already streams video and cursors. |
| **C4** | **REMAINING — not signed off** | No accepted M9R lease/handoff proof is recorded. | Build our own implementation for parity with Cua Spaces; do not present it as a Cua gap. |
| **C5** | **PARTIAL — not signed off** | The newest observed official 0.33.2 SDK/native preflight passes. The native probe captures a screenshot, but background click was refused, typing was unverifiable, background scroll was unavailable, and drag was unverified. Chromium now produces a classified matrix with a screenshot/click pass and explicit background refusals for type/scroll/drag. Electron 44.5.1 still crashes before a visible window. See [C5 report](M9R_C5_CUA_DRIVER_WINDOWS_RETEST.md). | Keep the Windows re-test. This is a compatibility report, not proof that M9R has integrated Cua Driver. |

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
| **C12** | **DECISION / NOT STARTED** | No Jev implementation has started. The build-vs-port review for MIT CUA-S1 is required first. | Evaluate adopting/porting CUA-S1 before building a separate decision model. |
| **C13** | **PARTIAL — benchmark design only** | No completed two-agent-plus-person benchmark run or scorecard is recorded. | Keep. Multiplayer handoff measurement remains a genuine M9R gap. |
| **C14** | **REMAINING — conditional** | No accepted desktop-app implementation is recorded. It depends on a passing C5 and an explicitly widened saved scope. | Keep; use Cua Driver only after C5 and scope approval. |
| **C15** | **PARTIAL — design only** | No accepted tiled multi-window stage with lease handoff exists. | Keep the build, but treat tiled/cursor control as parity with Cua Spaces; the M9R UI and governed room semantics must carry the distinction. |

## Current count

- **Done:** C2 (1)
- **Partial:** C1, C3, C5, C6, C7, C8, C10, C11, C13, C15 (10)
- **Remaining:** C4, C14 (2)
- **Decision or scope blocker:** C9, C12 (2)

Nothing in C1, C3, or C5 is signed off yet. C1 still needs owner-profile persistence evidence; C3 still needs the reviewed Cloudflare build/deploy and two-machine frame proof; C5 still needs Chromium and Electron runs plus a final action-by-action report.

## Sign-off order

1. Finish the C1 owner-profile persistence gate.
2. Finish the C3 reviewed Cloudflare artifact and two-machine relay proof.
3. Finish C5 on a real interactive Windows desktop using a matching Cua Driver binary and the isolated Chromium/Electron/native fixtures.
4. Only then start C4 or widen scope to C6–C15.
