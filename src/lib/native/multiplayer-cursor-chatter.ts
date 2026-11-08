import type { A2AMessage, MultiplayerRoster } from "./multiplayer-contract";
import type { MultiplayerRuntime } from "./multiplayer-runtime";
import type { CuaAgentCursorIdentity } from "./cua-stage-driver";

export interface ActiveCursorSession {
  readonly identity: CuaAgentCursorIdentity;
  readonly taskId: string;
}

/** Resolve a handle only when one active session owns it; ambiguity fails closed. */
export function uniqueActiveCursorIdentity(
  active: Iterable<ActiveCursorSession>,
  handle: string,
  taskIsActive: (taskId: string) => boolean,
  taskId?: string,
): CuaAgentCursorIdentity | undefined {
  const normalized = handle.replace(/^@+/, "").trim().toLowerCase();
  if (!normalized) return undefined;
  const matches = [...active].filter((entry) =>
    entry.identity.handle.replace(/^@+/, "").trim().toLowerCase() === normalized
      && (!taskId || entry.taskId === taskId) && taskIsActive(entry.taskId));
  return matches.length === 1 ? matches[0]!.identity : undefined;
}

/**
 * Bridges accepted structured teammate messages to the visual cursor layer.
 * The overlay receives only the bounded message summary; it is never the A2A
 * transport and cannot change acceptance or provider delivery.
 */
export function subscribeA2ACursorChatter(input: {
  multiplayer: Pick<MultiplayerRuntime, "subscribe">;
  roster: MultiplayerRoster;
  sayAgentCursor(fromHandle: string, toHandle: string, summary: string, taskId: string): boolean | Promise<boolean>;
}): () => void {
  const handleByAgentId = new Map(input.roster.agents.map((agent) => [agent.agentId, agent.handle ?? agent.agentId]));
  return input.multiplayer.subscribe((message: A2AMessage) => {
    const fromHandle = handleByAgentId.get(message.agentId);
    // Cursor bubbles belong to one active task; unscoped chatter must not be
    // accidentally attached to whichever task happens to own a cursor now.
    if (!fromHandle || !message.taskId || !message.summary.trim()) return;
    const recipients = message.recipient.kind === "agent" ? [message.recipient.agentId] : message.recipient.agentIds;
    for (const recipientId of recipients) {
      const toHandle = handleByAgentId.get(recipientId);
      if (!toHandle) continue;
      try { void Promise.resolve(input.sayAgentCursor(fromHandle, toHandle, message.summary, message.taskId)).catch(() => undefined); }
      catch { /* presentation failures never affect A2A message handling */ }
    }
  });
}
