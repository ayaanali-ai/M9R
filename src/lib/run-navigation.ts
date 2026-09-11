function cleanSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function addSelection(pathname: string, agentKey?: string | null, runId?: string | null): string {
  const params = new URLSearchParams();
  if (agentKey?.trim() && agentKey !== "all") params.set("agent", agentKey.trim());
  if (runId?.trim()) params.set("run", runId.trim());
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function watchfloorHref(agentKey?: string | null, runId?: string | null): string {
  return addSelection("/dashboard/agents", agentKey, runId);
}

/**
 * Channel selection is URL state (`?conversation=`) for the same reason agent
 * selection is (`?agent=` above): the primary nav's channel list, the message
 * feed, and a shared link are then one system rather than three.
 */
export function channelHref(conversationId: string, messageId?: string | null): string {
  const base = `/dashboard/agents?conversation=${cleanSegment(conversationId)}`;
  return messageId ? `${base}&message=${cleanSegment(messageId)}` : base;
}

/**
 * Where an archived Session's transcript actually lives. Not the channel: the
 * act of archiving removes a session's messages from channel scroll-back, so
 * linking to `channelHref(conversationId, messageId)` for an archived session
 * always lands on a feed that no longer contains the target.
 */
export function archivedSessionHref(sessionId: string): string {
  return `/dashboard/memory?tab=sessions&session=${cleanSegment(sessionId)}`;
}
