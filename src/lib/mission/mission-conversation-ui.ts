import type { MissionConversationDto, MissionMessageDto, MissionParticipantDto } from "./mission-application-service";

export type ConversationParticipant = Pick<MissionParticipantDto, "id" | "displayName">;
export type ConversationMessage = Pick<
  MissionMessageDto,
  "id" | "senderParticipantId" | "recipientParticipantIds" | "type" | "body" | "replyToMessageId" | "createdAt"
>;

export interface MissionConversationThread {
  root: MissionConversationDto["messages"][number];
  replies: MissionConversationDto["messages"];
}

/** Convert a participant display name to the stable handle used in message text. */
export function mentionHandle(displayName: string): string {
  const handle = displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return handle || "agent";
}

/** Extract unique @handles in their first-seen order. */
export function extractMentionHandles(body: string): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  const pattern = /(^|\s)@([a-z0-9][a-z0-9-]*)/gi;
  for (const match of body.matchAll(pattern)) {
    const handle = match[2].toLowerCase();
    if (!seen.has(handle)) {
      seen.add(handle);
      handles.push(handle);
    }
  }
  return handles;
}

/** Resolve handles to the participant ids that receive mention-targeted delivery. */
export function mentionedParticipantIds(body: string, participants: readonly ConversationParticipant[]): string[] {
  const byHandle = new Map(participants.map((participant) => [mentionHandle(participant.displayName), participant.id]));
  const ids: string[] = [];
  for (const handle of extractMentionHandles(body)) {
    const id = byHandle.get(handle);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Project the flat durable message stream into Slack-like roots and replies.
 * Missing or malformed parent references fail open as a new root so a message
 * never disappears from the conversation view.
 */
export function buildMissionThreads(messages: readonly ConversationMessage[]): MissionConversationThread[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const rootIdFor = (message: ConversationMessage): string => {
    const visited = new Set<string>();
    let current = message;
    while (current.replyToMessageId && byId.has(current.replyToMessageId) && !visited.has(current.id)) {
      visited.add(current.id);
      current = byId.get(current.replyToMessageId)!;
    }
    return current.id;
  };

  const replies = new Map<string, MissionConversationDto["messages"]>();
  for (const message of messages) {
    const rootId = rootIdFor(message);
    if (rootId === message.id) continue;
    const current = replies.get(rootId) ?? [];
    current.push(message as MissionConversationDto["messages"][number]);
    replies.set(rootId, current);
  }

  return messages
    .filter((message) => rootIdFor(message) === message.id)
    .map((root) => ({
      root: root as MissionConversationDto["messages"][number],
      replies: replies.get(root.id) ?? [],
    }));
}

/** Search only the bounded DTO fields visible to the dashboard. */
export function filterMissionMessages(
  messages: readonly ConversationMessage[],
  participants: readonly ConversationParticipant[],
  query: string,
): ConversationMessage[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...messages];
  const participantById = new Map(participants.map((participant) => [participant.id, participant]));
  return messages.filter((message) => {
    const names = [
      participantById.get(message.senderParticipantId)?.displayName,
      ...(message.recipientParticipantIds === "mission_broadcast"
        ? ["mission channel", "everyone"]
        : message.recipientParticipantIds.map((id) => participantById.get(id)?.displayName ?? id)),
    ];
    const haystack = [message.body, message.type, message.id, ...names].join(" ").toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}
