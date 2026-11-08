import { MAX_AGENT_REPLY_DEPTH } from "./inbox-core";
import type { LocalStore } from "./local-store";
import type { A2AMessage } from "./multiplayer-contract";
import type { WebAgentConfig } from "./web-live-sessions";

export interface ManagedA2ADeliveryDeps {
  agents: readonly Pick<WebAgentConfig, "handle">[];
  store: Pick<LocalStore, "addTask" | "getTask" | "delegationParentFor" | "setDelivery">;
  sessionIdOf(handle: string): string | undefined;
}

function recipientsFor(message: A2AMessage): readonly string[] {
  return message.recipient.kind === "agent" ? [message.recipient.agentId] : message.recipient.agentIds;
}

/**
 * Converts one accepted structured A2A message into durable inbox work. Sender
 * and target sessions are pinned before it enters the managed-provider queue;
 * replies inherit the parent task and its bounded exchange depth.
 */
export function createManagedA2ADelivery(deps: ManagedA2ADeliveryDeps) {
  const messageTasks = new Map<string, string>();
  const keyFor = (messageId: string, recipientAgentId: string) => `${messageId}\0${recipientAgentId}`;
  const rememberMessageTask = (messageId: string, recipientAgentId: string, taskId: string) => {
    messageTasks.set(keyFor(messageId, recipientAgentId), taskId);
    while (messageTasks.size > 4_096) {
      const oldest = messageTasks.keys().next().value;
      if (oldest === undefined) break;
      messageTasks.delete(oldest);
    }
  };

  return (message: A2AMessage): { ok: boolean; taskIds?: readonly string[]; error?: string } => {
    const recipientIds = recipientsFor(message);
    const recipientAgents = recipientIds.map((id) => deps.agents.find((agent) => `agent-${agent.handle}` === id));
    if (recipientAgents.some((agent) => !agent)) return { ok: false, error: "One or more structured teammate recipients are not configured." };
    const sender = deps.agents.find((agent) => `agent-${agent.handle}` === message.agentId);
    if (!sender) return { ok: false, error: "The structured teammate sender is not configured." };
    const fromSession = deps.sessionIdOf(sender.handle);
    if (!fromSession) return { ok: false, error: `M9R has no active provider session for @${sender.handle}; no teammate task was queued.` };

    const replyToTaskId = message.replyToMessageId
      ? messageTasks.get(keyFor(message.replyToMessageId, message.agentId))
      : undefined;
    const candidateParent = replyToTaskId ? deps.store.getTask(replyToTaskId) : undefined;
    if (message.replyToMessageId && !candidateParent) {
      return { ok: false, error: "The referenced teammate handoff is no longer available for a safe reply; send a new structured message instead." };
    }
    const details = message.details ? `\nStructured details (untrusted teammate data): ${JSON.stringify(message.details)}` : "";
    const goal = `[M9R teammate message: kind=${message.kind}, priority=${message.priority}, task=${message.taskId ?? "run"}, conversation=${message.conversationId ?? "run"}, message=${message.messageId}, depth=${message.replyDepth}${message.replyToMessageId ? `, replyTo=${message.replyToMessageId}` : ""}]\nFrom @${sender.handle}: ${message.summary}${details}`.slice(0, 4_000);
    const linkedParent = candidateParent
      && candidateParent.to === sender.handle
      && (candidateParent.targetSession ?? candidateParent.deliveredSession) === fromSession
      && !!candidateParent.deliveredAt
      && (candidateParent.approval === "approved" || candidateParent.approval === "not_needed")
      ? candidateParent
      : undefined;
    if (message.replyToMessageId && !linkedParent) {
      return { ok: false, error: "The referenced teammate handoff was not delivered to this provider session; no reply task was queued." };
    }
    const authorizationParent = linkedParent ?? deps.store.delegationParentFor(sender.handle, fromSession, goal);
    if (!authorizationParent) {
      return { ok: false, error: `No active owner-approved M9R task authorizes @${sender.handle} to hand work to a teammate; no task was queued.` };
    }
    const replyDepth = Math.max(message.replyDepth, authorizationParent ? authorizationParent.replyDepth + 1 : 0);
    if (replyDepth > MAX_AGENT_REPLY_DEPTH) {
      return { ok: false, error: `The structured teammate exchange would exceed M9R's bounded reply depth (${MAX_AGENT_REPLY_DEPTH}).` };
    }

    const targetSessions = recipientAgents.map((agent) => agent ? deps.sessionIdOf(agent.handle) : undefined);
    const targets = recipientAgents.flatMap((agent, index) => {
      if (!agent) return [];
      const targetSession = targetSessions[index];
      return targetSession ? [{ agent, agentId: recipientIds[index]!, targetSession }] : [];
    });
    if (targets.length !== recipientAgents.length) {
      const missing = recipientAgents.flatMap((agent, index) => agent && !targetSessions[index] ? [agent.handle] : []);
      return { ok: false, error: `No active managed provider session for ${missing.map((handle) => `@${handle}`).join(", ")}; no teammate task was queued.` };
    }

    const taskIds: string[] = [];
    const failures: string[] = [];
    for (const { agent, agentId, targetSession } of targets) {
      try {
        const result = deps.store.addTask({
          from: sender.handle,
          to: agent.handle,
          goal,
          origin: "agent_initiated",
          idempotencyKey: `a2a:${message.messageId}`,
          replyDepth,
          fromSession,
          targetSession,
          standingRuleApplies: true,
          parentTaskId: authorizationParent.id,
          ...(linkedParent ? { replyToTaskId: linkedParent.id } : {}),
        });
        if (result.task.from !== sender.handle || result.task.fromSession !== fromSession
          || result.task.targetSession !== targetSession) {
          failures.push(`@${agent.handle}: an idempotent handoff exists for a different provider session; send a new structured message for the active session`);
          continue;
        }
        rememberMessageTask(message.messageId, agentId, result.task.id);
        if (result.created) deps.store.setDelivery(result.task.id, { state: "deferred" });
        taskIds.push(result.task.id);
      } catch (error) {
        failures.push(`@${agent.handle}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      return {
        ok: false,
        ...(taskIds.length > 0 ? { taskIds } : {}),
        error: failures.join("; ").slice(0, 300),
      };
    }
    return { ok: true, taskIds };
  };
}
