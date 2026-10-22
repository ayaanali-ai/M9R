import type { LocalStore } from "./local-store";
import { canQueue } from "./codex-delivery-core";
import { inboxMaxAgeMs, isFreshInboxTask } from "./inbox-core";

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
    && task.goal === goal
    && (task.targetSession ?? task.deliveredSession ?? task.delivery?.threadId) === sessionId
    && ["sending", "queued", "uncertain"].includes(task.delivery?.state ?? "")
    && isFreshInboxTask(task.createdAt, now, maxAge));
}

/** Adapters own transport; the pump owns bounded scheduling, never computer-use behavior. */
export function createTaskDeliveryPump(store: LocalStore, adapters: ReadonlyMap<string, (taskId: string) => Promise<unknown>>) {
  let busy = false;
  let idle = Promise.resolve();
  let finishIdle = () => {};
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
          && !task.resultSummary && !task.deliveredAt && canQueue(task)
          && isFreshInboxTask(task.createdAt, now, maxAge));
        // One attempt per adapter per pass. Its own atomic claim must prevent
        // cross-process duplicates; never convert uncertain work into a retry.
        const offered = new Set<string>();
        for (const task of tasks) {
          if (offered.size >= 4) break;
          const adapter = adapters.get(task.to);
          const session = task.delivery?.threadId;
          if (!adapter || !session || offered.has(task.to)
            || sessionHasUnfinishedDelivery(store, task.to, session, task.id)) continue;
          offered.add(task.to);
          try { await adapter(task.id); } catch { /* The adapter retains the durable outcome; the pump never assumes a send succeeded. */ }
        }
      } finally { busy = false; finishIdle(); }
    },
  };
}
