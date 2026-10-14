import type { LocalStore } from "./local-store";
import { canQueue } from "./codex-delivery-core";

export function sessionHasUnfinishedDelivery(store: LocalStore, handle: string, sessionId: string, exceptTaskId: string): boolean {
  return store.tasksFor(handle).some(task => task.id !== exceptTaskId && !task.resultSummary
    && (task.targetSession ?? task.deliveredSession ?? task.delivery?.threadId) === sessionId
    && ["sending", "queued", "uncertain"].includes(task.delivery?.state ?? ""));
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
        const tasks = store.snapshot().tasks.filter(task => task.delivery?.state === "deferred"
          && !task.resultSummary && !task.deliveredAt && canQueue(task));
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
