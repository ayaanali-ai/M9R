/** Retry advice never grants permission or dispatches input. Callers must still
 * re-authorize, resolve the target and acquire its mutation fence. */
export type ComputerUseRetry = "never" | "same-operation-id" | "refresh-target" | "new-operation-id";

export function preDispatchRetry(code: string): ComputerUseRetry {
  if (["operation-id-conflict", "mutation-operation-conflict"].includes(code)) return "new-operation-id";
  if (["task-canceled", "identity-revoked", "intent-forbidden", "invalid-action"].includes(code)) return "never";
  if (["operation-receipt-unavailable", "mutation-receipt-store-unavailable", "operation-in-progress",
    "mutation-lease", "mutation-lease-unavailable", "browser-route-unavailable"].includes(code)) return "same-operation-id";
  // Unknown gates are recoverable through fresh evidence, never blind replay.
  // In particular pointer activity, missing overlay, stale refs, focus and
  // background capability failures are not proof that the task is terminal.
  return "refresh-target";
}
