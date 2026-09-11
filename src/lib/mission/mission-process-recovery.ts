/**
 * Process-aware recovery (Phase 3A)
 * ----------------------------------------------------------------------------
 * The correction Phase 2D.2 needed: `MissionDispatchRuntime.recoverOnStartup`
 * always revoked a still-valid lease on restart, because it had no way to
 * ask "is the process I dispatched actually dead?" — it only ever had the
 * fencing token, never a process handle. This module is that missing
 * question, answered via `ProcessExecutionHost.inspect` against the handle
 * persisted by `attachProcessHandle` (mission-scheduler-store.ts), and the
 * five outcomes a real recovery pass must land on:
 *
 *   1. Confirmed dead            -> revoke, allow redispatch.
 *   2. Reattachable              -> restore supervision, keep lease + identity.
 *   3. Alive, not reattachable   -> terminate, confirm, THEN revoke.
 *   4. Unknown, disposable env   -> quarantine the old environment, allow
 *                                    redispatch into a fresh one.
 *   5. Unknown, shared env       -> do NOT redispatch; require human review.
 *
 * Fencing (mission-scheduler.ts) proves logical ownership of a slot but does
 * nothing to stop a still-running process from touching a filesystem,
 * making a git commit, calling a network API, or spending credentials —
 * which is exactly why rule 5 exists: a lease being revocable is not the
 * same question as a process being safe to ignore.
 *
 * Deliberately decoupled from `MissionDispatchRuntime` (mission-dispatch-
 * runtime.ts): this operates directly against `MissionSchedulerStore` and
 * `ProcessExecutionHost`, so a caller decides separately whether/how to
 * resume LOCAL supervision of a reattached process (case 2) — this module's
 * job ends at "here is the reattached process's current output and handle,"
 * not at re-wiring it into a specific Runtime instance's tracking map.
 */

import { isConfirmedDeadTermination } from "./mission-process-host";
import type { EnvironmentKind, PersistableProcessHandle, ProcessExecutionHost, ProcessStatusKind, ReattachedProcess } from "./mission-process-host";
import type { MissionSchedulerStore } from "./mission-scheduler-store";

// ---------------------------------------------------------------------------
// Pure decision
// ---------------------------------------------------------------------------

export const RECOVERY_ACTIONS = [
  "revoke_and_allow_redispatch",
  "restore_supervision",
  "terminate_then_revoke",
  "quarantine_and_allow_redispatch",
  "block_redispatch_requires_review",
] as const;
export type RecoveryActionKind = (typeof RECOVERY_ACTIONS)[number];

/**
 * The five determinations a recovery pass reports having reached — the
 * exact vocabulary requested: what actually happened to this instruction,
 * as opposed to `RecoveryActionKind` (what the coordinator decided to try).
 * They correspond one-to-one except that `revoke_and_allow_redispatch`
 * reports as `process_confirmed_dead` (the FACT that justified the action,
 * not the action's name) and `terminate_then_revoke` reports as
 * `process_terminated`.
 */
export const RECOVERY_OUTCOMES = ["process_confirmed_dead", "process_reattached", "process_terminated", "environment_quarantined", "process_status_unknown"] as const;
export type RecoveryOutcomeKind = (typeof RECOVERY_OUTCOMES)[number];

/**
 * Pure: given what `inspect` reported and the fixed kind of environment the
 * process ran in, decide which of the five rules applies. Takes no I/O of
 * its own so it stays independently testable from `inspect`'s/`quarantine`'s
 * actual behavior — the same split `mission-execution.ts`'s
 * `classifyOutstandingIntentForRecovery` drew for the simpler, handle-less
 * case Phase 2D.2 shipped with.
 */
export function determineRecoveryAction(processStatus: ProcessStatusKind, environmentKind: EnvironmentKind): RecoveryActionKind {
  switch (processStatus) {
    case "process_confirmed_dead":
      return "revoke_and_allow_redispatch";
    case "process_alive_reattachable":
      return "restore_supervision";
    case "process_alive_not_reattachable":
      return "terminate_then_revoke";
    case "process_status_unknown":
      return environmentKind === "disposable" ? "quarantine_and_allow_redispatch" : "block_redispatch_requires_review";
  }
}

// ---------------------------------------------------------------------------
// Impure coordinator
// ---------------------------------------------------------------------------

export interface ProcessRecoveryOutcome {
  instructionId: string;
  action: RecoveryActionKind;
  outcome: RecoveryOutcomeKind;
  requiresHumanReview: boolean;
  detail: string;
  /** Populated only for `restore_supervision` — the caller may resume local tracking from this. */
  reattached: ReattachedProcess | null;
}

export interface ProcessRecoveryReport {
  outcomes: ProcessRecoveryOutcome[];
}

export interface RecoverWithProcessHostInput {
  schedulerStore: MissionSchedulerStore;
  processHost: ProcessExecutionHost;
  workspaceId: string;
  now: string;
}

/**
 * Runs one recovery pass over every outstanding dispatch intent in a
 * workspace, using a REAL (or fake, for tests) `ProcessExecutionHost` to
 * determine actual process liveness before deciding anything — replacing
 * Phase 2D.2's conservative always-revoke behavior with the five-rule model
 * above. `MissionDispatchRuntime.recoverOnStartup` remains correct and
 * unchanged for callers that have no `ProcessExecutionHost` configured
 * (e.g. still using the Phase 2D.2 in-memory fake) — see
 * IMPLEMENTATION_NOTES.md for why that fallback is intentional, not an
 * oversight.
 */
export async function recoverOutstandingIntentsWithProcessHost(input: RecoverWithProcessHostInput): Promise<ProcessRecoveryReport> {
  const { schedulerStore, processHost, workspaceId, now } = input;
  const outcomes: ProcessRecoveryOutcome[] = [];

  const outstanding = await schedulerStore.listOutstandingDispatchIntents(workspaceId);

  for (const intent of outstanding) {
    if (!intent.processHandle) {
      // No handle was ever persisted for this instruction — nothing to
      // inspect. Fail safe: treated exactly like "unknown, shared
      // environment," the most conservative of the five outcomes, rather
      // than assumed disposable.
      outcomes.push({
        instructionId: intent.instructionId,
        action: "block_redispatch_requires_review",
        outcome: "process_status_unknown",
        requiresHumanReview: true,
        detail: "No process handle was ever persisted for this instruction — liveness cannot be determined, and the environment's isolation cannot be assumed safe to abandon.",
        reattached: null,
      });
      continue;
    }

    const handle = intent.processHandle as unknown as PersistableProcessHandle;
    const status = await processHost.inspect(handle);
    const action = determineRecoveryAction(status.kind, handle.environmentKind);

    switch (action) {
      case "revoke_and_allow_redispatch": {
        await schedulerStore.revokeLease({
          workspaceId: intent.workspaceId,
          missionId: intent.missionId,
          dispatchKey: intent.dispatchKey,
          now,
          reason: "Process confirmed dead on recovery — releasing the slot for redispatch.",
        });
        await schedulerStore.markDispatchIntentDelivered(intent.instructionId, now);
        outcomes.push({
          instructionId: intent.instructionId,
          action,
          outcome: "process_confirmed_dead",
          requiresHumanReview: false,
          detail: status.detail,
          reattached: null,
        });
        break;
      }

      case "restore_supervision": {
        const reattached = await processHost.reattach(handle);
        // Deliberately does NOT revoke/release the lease or close the
        // intent — the same execution identity and lease are being
        // retained, not replaced. Closing here would let a second worker
        // redispatch onto a slot that is, in fact, still legitimately
        // occupied.
        outcomes.push({
          instructionId: intent.instructionId,
          action,
          outcome: "process_reattached",
          requiresHumanReview: false,
          detail: "Reattached to a still-live, reattachable process — lease and execution identity retained.",
          reattached,
        });
        break;
      }

      case "terminate_then_revoke": {
        const termination = await processHost.terminate(handle);
        // Confirm termination before touching the lease — Phase 4D Part 4
        // §3: `isConfirmedDeadTermination` accepts only the three kinds
        // that mean the process is ACTUALLY gone
        // (already_exited/graceful_exit_confirmed/forced_kill_confirmed).
        // `termination_requested_unconfirmed`/`termination_timed_out`/
        // `process_identity_mismatch`/`process_status_unknown` must never
        // be treated as safe to redispatch over — an abort REQUEST is not
        // proof of exit.
        if (isConfirmedDeadTermination(termination.kind)) {
          await schedulerStore.revokeLease({
            workspaceId: intent.workspaceId,
            missionId: intent.missionId,
            dispatchKey: intent.dispatchKey,
            now,
            reason: "Live but non-reattachable process was terminated on recovery — releasing the slot for redispatch.",
          });
          await schedulerStore.markDispatchIntentDelivered(intent.instructionId, now);
          outcomes.push({
            instructionId: intent.instructionId,
            action,
            outcome: "process_terminated",
            requiresHumanReview: false,
            detail: termination.detail,
            reattached: null,
          });
        } else {
          // Termination did not confirm — do not release the slot. Leave
          // the intent outstanding for another pass or a human.
          outcomes.push({
            instructionId: intent.instructionId,
            action,
            outcome: "process_status_unknown",
            requiresHumanReview: true,
            detail: `Termination did not confirm: ${termination.detail}`,
            reattached: null,
          });
        }
        break;
      }

      case "quarantine_and_allow_redispatch": {
        await processHost.quarantine(handle.environmentId);
        await schedulerStore.revokeLease({
          workspaceId: intent.workspaceId,
          missionId: intent.missionId,
          dispatchKey: intent.dispatchKey,
          now,
          reason: "Process status unknown in a disposable environment — quarantined, redispatch will use a fresh environment.",
        });
        await schedulerStore.markDispatchIntentDelivered(intent.instructionId, now);
        outcomes.push({
          instructionId: intent.instructionId,
          action,
          outcome: "environment_quarantined",
          requiresHumanReview: false,
          detail: status.detail,
          reattached: null,
        });
        break;
      }

      case "block_redispatch_requires_review": {
        // Neither the lease nor the intent is touched — leaving both live
        // is what "do not immediately redispatch" means here. A human or a
        // later, better-informed recovery pass must resolve this.
        outcomes.push({
          instructionId: intent.instructionId,
          action,
          outcome: "process_status_unknown",
          requiresHumanReview: true,
          detail: status.detail,
          reattached: null,
        });
        break;
      }
    }
  }

  return { outcomes };
}
