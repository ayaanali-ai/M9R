import type { LedgerEntry } from "./delivery-ledger";

/**
 * What a Bridge does with a message it is offered again after a restart, decided from its local delivery
 * ledger (M9R_NETWORK_SPEC.md 7.3 #7, acceptance step 6). Pure so the rule can be tested exhaustively.
 *
 *  - `interrupted`: a previous process had handed the message to a session and never finished. Running it again
 *    could repeat side effects (edits, commands, posts), so it is not run: the human is told once and decides.
 *  - `already_handled`: a previous process finished the turn, or already reported it as restart-interrupted, and only
 *    the cursor advance was missed. Running it now would duplicate finished work or contradict the notice, so it is skipped.
 *  - `run`: everything else, including a message only received (no session ever saw it) and any state written by
 *    this same process, which is normal in-flight work.
 */
export type RestartRecovery = "run" | "interrupted" | "already_handled";

export function classifyRestartRecovery(entry: LedgerEntry | null, bridgeStartedAtMs: number): RestartRecovery {
  if (!entry) return "run";
  if (entry.at >= bridgeStartedAtMs) return "run";
  if (entry.state === "delivered_to_session" || entry.state === "processing") return "interrupted";
  if (entry.state === "completed") return "already_handled";
  if (entry.state === "failed" && entry.note === RESTART_INTERRUPTED_NOTE) return "already_handled";
  return "run";
}

/** Deliberately contains no @ mention: a mention would wake a Bridge and could loop. */
export function restartInterruptedNotice(provider: string): string {
  return `${provider} was restarted while it was working on this message, so nothing was run again. Send the message again if you want it repeated.`;
}

/** Ledger note written with the failed state, so an interrupted message is never mistaken for a retryable failure. */
export const RESTART_INTERRUPTED_NOTE = "restart_interrupted";

/** Marks the failure in the delivery timeline so it reads "restart interrupted", not a generic failure. */
export const RESTART_INTERRUPTED_EVENT = "bridge.restart_interrupted";
