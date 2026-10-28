import type { LocalStore } from "./local-store";
import { canQueue } from "./codex-delivery-core";
import { inboxMaxAgeMs, isFreshInboxTask, redactSecrets } from "./inbox-core";

export interface DeliveryPumpIssue {
  taskId: string;
  provider: string;
  reason: string;
}

type DeliveryPumpIssueHandler = (issue: DeliveryPumpIssue) => void;

function issueFromOutcome(taskId: string, provider: string, outcome: unknown): DeliveryPumpIssue | undefined {
  if (!outcome || typeof outcome !== "object") return undefined;
  const record = outcome as { state?: unknown; reason?: unknown; error?: unknown };
  if (record.state !== "unavailable" && record.state !== "failed" && record.state !== "uncertain") return undefined;
  const detail = typeof record.reason === "string" ? record.reason
    : typeof record.error === "string" ? record.error
    : `adapter returned ${record.state}`;
  const reason = redactSecrets(detail).replace(/\s+/g, " ").trim().slice(0, 240);
  return { taskId, provider, reason: reason || `adapter returned ${record.state}` };
}

function errorIssue(taskId: string, provider: string, error: unknown): DeliveryPumpIssue {
  const detail = error instanceof Error ? error.message : String(error);
  const reason = redactSecrets(detail).replace(/\s+/g, " ").trim().slice(0, 240);
  return { taskId, provider, reason: reason || "adapter threw an unknown error" };
}

/**
 * A verbatim retry of a failed/abandoned task (the single most common retry pattern -- resend the
 * exact same wording) used to be deferred indefinitely behind the original attempt: this had no
 * staleness bound at all, so if the original attempt's delivery record was never finalized (it
 * failed over to a different tool, the owner redirected it, the process died mid-turn -- anything
 * that doesn't end in a clean resultSummary), the identical-text retry silently never got
 * delivered, with nothing telling the owner or the agent why. Confirmed live: T248 ("open file
 * explorer and type hello in the search bar") never finalized; the identical-text retry T249
 * sat deferred for ~49s until an unrelated instruction happened to trigger a re-check. Bounding
 * this the same way `injectTasks` already bounds inbox staleness means a stuck original attempt
 * can delay a retry by at most this window, never indefinitely.
 */
export function sessionHasUnfinishedDelivery(store: LocalStore, handle: string, sessionId: string, exceptTaskId: string): boolean {
  const goal = store.getTask(exceptTaskId)?.goal;
  const maxAge = inboxMaxAgeMs();
  const now = Date.now();
  return store.tasksFor(handle).some(task => task.id !== exceptTaskId && !task.resultSummary
    && task.receipt?.state !== "canceled"
    && task.goal === goal
    && (task.targetSession ?? task.deliveredSession ?? task.delivery?.threadId) === sessionId
    && ["sending", "queued", "uncertain"].includes(task.delivery?.state ?? "")
    && isFreshInboxTask(task.createdAt, now, maxAge));
}

/** Adapters own transport; the pump owns bounded scheduling, never computer-use behavior. */
export function createTaskDeliveryPump(
  store: LocalStore,
  adapters: ReadonlyMap<string, (taskId: string) => Promise<unknown>>,
  onIssue?: DeliveryPumpIssueHandler,
) {
  let busy = false;
  let idle = Promise.resolve();
  let finishIdle = () => {};
  const lastIssueByTask = new Map<string, string>();
  const reportIssue = (issue: DeliveryPumpIssue): void => {
    const fingerprint = `${issue.provider}\0${issue.reason}`;
    if (lastIssueByTask.get(issue.taskId) === fingerprint) return;
    lastIssueByTask.set(issue.taskId, fingerprint);
    try { onIssue?.(issue); } catch { /* Diagnostics must not stop provider delivery. */ }
  };
  return {
    drain: () => idle,
    async tick(): Promise<void> {
      if (busy) return;
      busy = true;
      idle = new Promise<void>(resolve => { finishIdle = resolve; });
      try {
        const now = Date.now();
        const maxAge = inboxMaxAgeMs();
        const tasks = store.snapshot().tasks.filter(task => task.delivery?.state === "deferred"
          && task.receipt?.state !== "canceled"
          && !task.resultSummary && !task.deliveredAt && canQueue(task)
          && isFreshInboxTask(task.createdAt, now, maxAge));
        // One attempt per adapter per pass. Its own atomic claim must prevent
        // cross-process duplicates; never convert uncertain work into a retry.
        const offered = new Set<string>();
        for (const task of tasks) {
          if (offered.size >= 4) break;
          const adapter = adapters.get(task.to);
          const session = task.delivery?.threadId;
          if (!adapter || offered.has(task.to)
            || (session !== undefined && sessionHasUnfinishedDelivery(store, task.to, session, task.id))) continue;
          offered.add(task.to);
          try {
            const outcome = await adapter(task.id);
            const issue = issueFromOutcome(task.id, task.to, outcome);
            if (issue) reportIssue(issue);
            else lastIssueByTask.delete(task.id);
          } catch (error) {
            // The adapter owns durable delivery state, but the pump must not
            // erase the only useful explanation for an unavailable transport.
            reportIssue(errorIssue(task.id, task.to, error));
          }
        }
      } finally { busy = false; finishIdle(); }
    },
  };
}
