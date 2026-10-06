# M9R provider capability and acceptance matrix

**Date:** 2026-10-05<br>
**Item:** Cleanup proposal item 5<br>
**Status:** **Matrix recorded; live acceptance is not signed off**

This matrix covers the local provider/session path for Claude Code, Codex, and
OpenCode. It does not treat a shared M9R MCP server, a web-room ACP process, or
human copy/paste as terminal-to-terminal delivery evidence.

## Evidence labels

- **R** — repository implementation and focused automated checks cover the
  behavior or contract.
- **P** — provider-neutral or partial behavior exists, but the provider-specific
  acceptance condition is not established.
- **L** — live owner-session evidence from the real provider CLI/session.
- **U** — unverified in this audit.

An `R; L open` cell has code and fixture evidence but is not a live acceptance
pass.

## Capability matrix

| Capability | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| **Detect installed provider** | **R; L open** — `detectInstalledAgents` probes `claude --version`; stable detection tests pass. Current machine exposes `claude.exe`. | **R; L open** — probes `codex --version`; detection tests pass. Current machine exposes `codex.ps1`. | **R; L open** — probes `opencode --version` in isolated XDG state; detection tests pass. Current machine exposes `opencode.ps1`. |
| **Target an exact existing session** | **R; L open** — ACP has `resumeSession` using the provider session reference; no live existing-session run was recorded. | **R; L open** — app-server resume uses the exact thread id; native delivery requires an explicit or unambiguous folder-scoped target and refuses guesses. | **R; L open** — ACP resume and OpenCode session targeting require the normalized folder/session id; tests reject ambiguous or cross-folder targets. |
| **Deliver a task** | **R; L open** — ACP `prompt` and Claude invocation/parser paths exist; no direct live cross-provider delivery proof. | **R; L open** — ACP/app-server prompt and native queued delivery exist; Codex target-selection and approval gates are tested. | **R; L open** — ACP `prompt` and `prompt_async` target a selected session; no direct live cross-provider delivery proof. |
| **Return a result** | **R; L open** — normalized completed/failed events and redacted result parsing exist. | **R; L open** — rollout/result parsing and exactly-once answer return are tested. | **R; L open** — ACP completed/output events and result handling exist; no live return was recorded. |
| **Stream activity** | **R; L open** — structured ACP tool events and Claude session activity normalization are tested. | **R; L open** — rollout activity, tool events, and feed projection are tested. | **R; L open** — ACP tool events, absolute-path normalization, and capture backfill are tested; native pill activity remains a separate item 6 acceptance gate. |
| **Request and answer approval** | **R; L open** — ACP permission requests and safe `allow_once` response are implemented/tested. | **R; L open** — app-server approval accept/decline/timeout behavior and native human approval gates are tested. | **R; L open** — shared ACP permission handling exists; a real OpenCode approval round trip was not recorded. |
| **Interrupt an active turn** | **R; L open** — ACP `cancelTurn` is wired through the session controller; no live cancellation run recorded. | **R; L open** — native app-server cancellation is tested and reports `cancelled`; no live run recorded. | **R; L open** — OpenCode uses the ACP cancellation path; provider-specific live cancellation is unverified. |
| **Revoke access and block later delivery** | **P; L open** — generic bridge/token revocation exists, but no Claude-specific revoke acceptance is recorded. | **P; L open** — token retirement and bridge revocation exist; native task delivery after revocation has not been proven live. | **P; L open** — generic bridge/token revocation exists, but no OpenCode-specific revoke acceptance is recorded. |

## Directional task-delivery matrix

These are separate from provider capability declarations. A provider adapter
being able to prompt a session does not prove that another provider can deliver
to that session and receive the result.

| Direction | Repository evidence | Live owner-session evidence | Status |
| --- | --- | --- | --- |
| **Claude Code → Codex** | Fixture coverage in `scripts/native-codex-delivery.test.ts`: a typed `@codex` task is pushed once to the selected Codex thread and the answer returns to Claude. | None recorded in this audit. | **Open** |
| **Codex → Claude Code** | Fixture coverage in `scripts/native-codex-delivery.test.ts`: Claude's completed turn returns to the Codex session that asked. | None recorded in this audit. | **Open** |
| **Claude Code → OpenCode** | No direct provider-to-provider proof. Generic ACP/MCP support is not counted. | None recorded. | **Open** |
| **OpenCode → Claude Code** | No direct provider-to-provider proof. Generic ACP/MCP support is not counted. | None recorded. | **Open** |
| **Codex → OpenCode** | No direct provider-to-provider proof. Generic ACP/MCP support is not counted. | None recorded. | **Open** |
| **OpenCode → Codex** | No direct provider-to-provider proof. Generic ACP/MCP support is not counted. | None recorded. | **Open** |

## Focused repository evidence

The following focused checks were run for this matrix:

- ACP/provider detection, Claude/Codex adapters, Codex app server, OpenCode
  ACP, and provider-adapter contracts: **119 passing**.
- Codex delivery/watch, session activity, approvals, token revocation,
  OpenCode session targeting, and OpenCode prompt behavior: **66 passing**.
- Combined focused evidence: **185 passing, 0 failing**.

These are implementation and fixture checks. They are not live provider-session
acceptance and do not replace the six directional runs above.

## Live acceptance procedure

To close the open cells, each provider needs a real existing session with its
provider identity intact. For every direction:

1. Record a redacted provider/session reference and working directory.
2. Send a unique harmless task to the exact target session.
3. Confirm the target received it and returned a result to the original
   provider.
4. Capture working/idle/activity transitions from the provider path.
5. Trigger an approval, verify allow/deny reaches the same session, then
   interrupt a separate in-flight turn.
6. Revoke the provider/bridge authority and verify a later delivery is denied.

No bearer tokens, raw provider transcripts, or private prompt contents belong in
the acceptance record. A web-room message, a copied prompt, or a shared MCP
connection is not sufficient evidence for any directional row.

## Item 5 conclusion

The requested **matrix deliverable is complete** and the repository-side
evidence is recorded. The **provider acceptance is still open** because the
required real-session directional runs have not been performed. Item 5 must not
be called fully accepted until those six directions and their approval,
interrupt, activity, and revoke outcomes are recorded.
