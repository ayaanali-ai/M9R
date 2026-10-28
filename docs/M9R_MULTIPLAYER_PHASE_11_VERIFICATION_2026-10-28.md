# M9R Multiplayer Phase 11 — verification and cleanup

Status: qualification complete for the M9R multiplayer/provider/pill contracts; no blind cleanup performed.

## Scope

Phase 11 is the final verification pass for Phases 0–10. It verifies the owner-owned provider runtime, the multiplayer contracts, browser and desktop surface routing, cancellation, delivery idempotency, restart recovery, the pill projection, and the live model picker. It does not switch the product back to provider-app sessions and it does not revive the old browser extension UI.

Branch under test: `codex/m9r-phase0-11-checkpoint-2026-10-28`

Starting checkpoint: `65fad7e2` (Phase 10 model picker)

## Fixes found during qualification

- Surface adapter registration now validates only the serializable descriptor. The executable `canHandle` and `bind` methods are deliberately outside that schema. Invalid target payloads now fail closed with a structured resolution error instead of throwing out of the catalog.
- Managed provider identity comparison now canonicalizes equivalent Windows paths and normalized provider/handle values before comparing them. Different logical identities still fail closed.
- Managed provider continuations are retained privately in memory even when a durable continuation store is not configured. A restarted runtime therefore resumes the same provider session instead of silently creating a new logical session. A provider-returned continuation is persisted at the start boundary.
- The pill shell test now asserts the Phase 8 collaboration envelope that the current UI contract intentionally emits for an empty state.

None of these changes alter the existing broker-owned browser route, desktop-stage route, provider command protocol, or provider-app-session source of truth.

## Verification results

| Area | Result |
| --- | --- |
| Multiplayer contract, A2A, cancellation, leases, 1/2/4/8/16 roster | 19/19 |
| Managed Claude/Codex/OpenCode adapter and supervisor, Codex app-server persistence/recovery | 23/23 |
| Web UI bridge (including ready extension socket gate and duplicate-result coalescing) | 19/19 |
| Browser broker, tab/field/form claims, authority, loop guard, approvals | 56/56 |
| Pill state, pill shells, desktop presence, stop/approval display | 22/22 |
| Restart recovery and runtime build identity | 14/14 |
| Provider model catalog/selection/UI projection | 3/3 |
| TypeScript repository check | passed |
| Production pill bundle (`npm --prefix pill run build`) | passed |
| CLI artifact (`node scripts/build-cli.mjs`) | passed |
| Engine/broker/CUA artifacts (`node scripts/build-engine.mjs`) | passed; identity verified across 185 files |
| `git diff --check` | passed |

The web UI bridge socket test required host networking permission; its sandbox-only `EACCES` was an environment restriction, and the host-permission rerun passed.

The broad `npm test` wrapper still exits non-zero because it includes unrelated repository suites that are not part of this M9R phase gate: Windows sandbox `EPERM` renames for local-store lock files, sandbox localhost restrictions, a missing roadmap fixture, project-local `M9R_HOME` isolation checks, a mission-relay environment failure, and an older oathlock CLI wording assertion. Its second batch remains 96/96. These failures do not occur in the focused Phase 11 matrix above.

The root Next production build was started but did not progress past the initial optimized-build banner in this environment and was stopped after the timeout window. The pill, CLI, and engine production artifacts built and verified successfully; no deploy was attempted.

## Matrix coverage

- The 1/2/4/8/16 capacity contract is exercised without inventing provider sessions; the live machine currently has three providers, so a sixteen-provider live run was not fabricated.
- Independent browser tabs and same-tab field/form arbitration are covered by the browser broker tests; independent regions and overlapping regions are covered by the mutation scheduler tests.
- A2A request/reply, stop-one-agent, stop-all/run cancellation, late-action prevention, stale-lease fencing, duplicate-delivery suppression, provider failure, Codex process stability, and restart continuation are covered by the focused groups above.
- The browser and desktop routes remain the existing M9R routes. No extension UI path was reactivated.

## Cleanup decision

No obsolete path was deleted. The reference audit found remaining legacy references in credential migration, compatibility/config layout handling, the explicit ACP escape hatch, and migration-era tests. They are still reachable by supported compatibility flows or referenced by tests, so blind deletion would be unsafe. The pre-existing untracked recovery, diagnostics, scratchpad, and test-temporary directories were left untouched.

Phase 11 is therefore source-qualified for the M9R contract surface, with the broad-suite/environment exceptions recorded above. Deployment and live three-provider desktop acceptance remain separate operational steps.
