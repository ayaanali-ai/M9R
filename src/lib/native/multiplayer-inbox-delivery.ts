import type { LocalStore } from "./local-store";
import type { Task } from "./inbox-core";
import type { MultiplayerDelivery } from "./multiplayer-runtime";

export interface MultiplayerInboxAgent {
  readonly handle: string;
  readonly agentId: string;
}

/**
 * Mirrors task-desktop-stage.ts's taskActive(): a task is still "in flight" until it reaches a
 * terminal state -- "failed"/"uncertain"/"paused" receipts included, since RECEIPT_TRANSITIONS
 * (inbox-core.ts) never lets any of those three move back into active work. Keep both in sync.
 */
function isTaskActive(task: Task): boolean {
  return task.resultSummary === undefined
    && task.lifecycle?.state !== "completed" && task.lifecycle?.state !== "failed"
    && !["canceled", "failed", "uncertain", "paused"].includes(task.receipt?.state ?? "");
}

/** The two A2A kinds that hand a recipient brand-new work, as opposed to a reply or status update. */
const NEW_WORK_KINDS = new Set(["help-request", "delegate"]);

/**
 * Persist one roster-authenticated A2A message as a recipient inbox item.
 * Message acceptance and provider receipt stay separate: this callback only
 * promises that the owner's durable task queue contains the peer message.
 */
export function createMultiplayerInboxDelivery(input: {
  store: Pick<LocalStore, "addTask" | "setDelivery" | "setApproval" | "tasksFor">;
  agents: readonly MultiplayerInboxAgent[];
  sessionIdOf?: (handle: string) => string | undefined;
  /** Best-effort: push this A2A content as a fresh provider turn on an existing task (the recipient's
   * session may be idle after already pausing/finishing). Never affects this function's own return value --
   * a wake failure never turns a legitimate dedup/"already-present" result into an error. */
  wakeRecipient?: (handle: string, text: string, taskId: string) => void;
}): MultiplayerDelivery {
  const profiles = new Map(input.agents.map((agent) => [agent.agentId, agent]));

  return (message) => {
    const recipient = message.recipient.kind === "agent" ? profiles.get(message.recipient.agentId) : undefined;
    if (!recipient) return { ok: false, error: "The structured teammate recipient is not configured." };
    const sender = profiles.get(message.agentId);
    if (!sender) return { ok: false, error: "The structured teammate sender is not configured." };

    const detail = message.details ? `\nStructured details: ${JSON.stringify(message.details)}` : "";
    const rootTaskId = message.taskId ?? `run-${message.runId}`;
    const conversationId = message.conversationId ?? `conversation-${message.taskId ?? message.runId}`;
    const replyLine = message.replyToMessageId ? ` reply-to ${message.replyToMessageId}` : "";
    const goal = `[M9R team conversation ${conversationId}; task ${rootTaskId}; message ${message.messageId}${replyLine}; kind ${message.kind}] @${sender.handle}: ${message.summary}${detail}`.slice(0, 4_000);

    // A teammate's delegation can redundantly duplicate work the recipient already received directly
    // from the owner (e.g. "Claude, ask Codex to do X" where the owner's own message also named Codex).
    // Both deliveries are individually legitimate; what's missing is recognizing the recipient already
    // has equivalent work in flight. Key that off task lineage (broadcastId), not message wording, so
    // it holds for any phrasing -- explicit @mentions, bare names, or anything said multiple times.
    if (NEW_WORK_KINDS.has(message.kind)) {
      const senderBroadcastId = input.store.tasksFor(sender.handle)
        .find((task) => task.broadcastId && isTaskActive(task))?.broadcastId;
      if (senderBroadcastId) {
        const existing = input.store.tasksFor(recipient.handle)
          .find((task) => task.broadcastId === senderBroadcastId && isTaskActive(task));
        if (existing) {
          // Suppressing the duplicate task record must not silently drop the delegation's actual content:
          // the recipient may already have paused/finished its own turn waiting for exactly this (e.g. "wait
          // for Claude's explicit delegation" from the shared broadcast), and nothing else would ever wake
          // it back up. Push the content as a fresh turn on the existing task instead of a second task.
          try { input.wakeRecipient?.(recipient.handle, goal, existing.id); }
          catch { /* best-effort: the dedup result below is correct regardless */ }
          return { ok: true, taskId: existing.id, created: false, state: "already-present" };
        }
      }
    }
    const senderSession = input.sessionIdOf?.(sender.handle);
    const result = input.store.addTask({
      to: recipient.handle,
      from: sender.handle,
      goal,
      origin: "agent_initiated",
      idempotencyKey: `a2a:${message.messageId}`,
      replyDepth: message.replyDepth,
      // Receiving a roster-authenticated peer message is not an OS mutation.
      // Any desktop action the recipient chooses to take remains under the
      // ordinary stage/action approval policy.
      standingRuleApplies: true,
      coordinationIntent: "message",
      a2a: {
        conversationId,
        messageId: message.messageId,
        senderAgentId: sender.agentId,
        recipientAgentId: recipient.agentId,
        replyDepth: message.replyDepth,
        kind: message.kind,
        summary: message.summary,
        ...(message.taskId ? { taskId: message.taskId } : {}),
        ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
        ...(message.progressFingerprint ? { progressFingerprint: message.progressFingerprint } : {}),
        ...(message.progressKind ? { progressKind: message.progressKind } : {}),
        wireMessage: message,
      },
      ...(senderSession ? { fromSession: senderSession } : {}),
    });

    let task = result.task;
    if (task.retiredAt || task.a2a?.messageId !== message.messageId) {
      return { ok: false, taskId: task.id, created: false, error: `The idempotent A2A record ${task.id} is retired or belongs to a different message.` };
    }
    if (task.approval === "denied" || task.approval === "expired") {
      return { ok: false, taskId: task.id, created: false, error: `The existing recipient task ${task.id} was explicitly ${task.approval}; M9R did not override that decision.` };
    }
    if (task.resultSummary || task.receipt?.state === "completed" || task.delivery?.state === "done") {
      return { ok: true, taskId: task.id, created: false, state: "completed" };
    }
    if (task.receipt?.state === "uncertain" || task.delivery?.state === "uncertain") {
      return { ok: false, taskId: task.id, created: false, state: "uncertain", error: "The existing recipient task has an uncertain delivery outcome; M9R did not create or dispatch a duplicate." };
    }
    if (task.approval === "pending") {
      task = input.store.setApproval(task.id, "approved") ?? task;
      if (task.approval !== "approved") return { ok: false, taskId: task.id, created: false, error: "M9R could not authorize delivery of this roster-authenticated peer message." };
    }
    if (task.deliveredAt || task.delivery?.state === "sending" || task.delivery?.state === "queued") {
      return { ok: true, taskId: task.id, created: false, state: "already-present" };
    }

    if (!task.delivery || task.delivery.state === "failed") {
      task = input.store.setDelivery(task.id, { state: "deferred" }) ?? task;
      if (task.delivery?.state !== "deferred") {
        return { ok: false, taskId: task.id, created: false, error: `M9R preserved ${task.id} but could not queue it for the recipient provider.` };
      }
    }
    return { ok: true, taskId: task.id, created: result.created, state: result.created ? "queued" : "already-present" };
  };
}
