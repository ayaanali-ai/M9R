// Batched reads for the dashboard channel list (one call where there used to be one query per channel). Kept free of
// Next/Supabase imports so it can be unit tested with a fake client.

const DASHBOARD_MESSAGE_COLUMNS = "id, conversation_id, sender_connection_id, sender_user_id, sender_display_name, recipient_connection_id, kind, body, outcome, created_at, spawned_run_id, related_run_id, parent_message_id, edited_at, deleted_at";
const DASHBOARD_MESSAGE_COLUMN_LIST = DASHBOARD_MESSAGE_COLUMNS.split(", ");

/** The batch functions ship in a migration; until it is applied Postgres reports the function as missing and the old per-channel queries are used. */
export function isMissingDbFunctionError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message ?? "");
}

function pickDashboardMessageColumns(row: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const column of DASHBOARD_MESSAGE_COLUMN_LIST) picked[column] = row[column];
  return picked;
}

/** The slice of the Supabase client these loaders use; structural so tests can pass a fake. */
type DashboardAuthClient = any;

/**
 * The open channel's 80-message window plus one preview message for every other channel. The previews used to be one
 * query per channel on every poll; they are now a single call. Rows come back oldest-first within the open channel.
 */
export async function loadDashboardMessageWindows(auth: DashboardAuthClient, workspaceId: string, ids: string[], selectedConversationId?: string | null): Promise<{ rows: Array<Record<string, any>>; error: unknown }> {
  const selected = selectedConversationId && ids.includes(selectedConversationId) ? selectedConversationId : null;
  const previewIds = ids.filter((id) => id !== selected);
  const selectedPromise = selected
    ? auth.from("conversation_messages").select(DASHBOARD_MESSAGE_COLUMNS).eq("workspace_id", workspaceId).eq("conversation_id", selected).order("created_at", { ascending: false }).limit(80)
    : Promise.resolve({ data: [] as Array<Record<string, any>>, error: null });
  const previewPromise = previewIds.length > 0
    ? auth.rpc("latest_messages_per_conversation", { p_workspace_id: workspaceId, p_conversation_ids: previewIds })
    : Promise.resolve({ data: [] as Array<Record<string, any>>, error: null });
  const [selectedResult, previewResult] = await Promise.all([selectedPromise, previewPromise]);
  let previewRows: Array<Record<string, any>> = ((previewResult.data ?? []) as Array<Record<string, any>>).map(pickDashboardMessageColumns);
  let previewError: unknown = previewResult.error;
  if (isMissingDbFunctionError(previewResult.error as { code?: string; message?: string } | null)) {
    const fallback = await Promise.all(previewIds.map((conversationId) => auth.from("conversation_messages").select(DASHBOARD_MESSAGE_COLUMNS).eq("workspace_id", workspaceId).eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(1)));
    previewRows = fallback.flatMap((result) => (result.data ?? []) as Array<Record<string, any>>);
    previewError = fallback.map((result) => result.error).find(Boolean) ?? null;
  }
  const selectedRows = [...((selectedResult.data ?? []) as Array<Record<string, any>>)].reverse();
  return { rows: [...selectedRows, ...previewRows], error: selectedResult.error ?? previewError ?? null };
}

/** Unread counts for every channel except the open one, in one call (was one count query per channel). */
export async function loadDashboardUnreadCounts(auth: DashboardAuthClient, workspaceId: string, userId: string, ids: string[], excludedMessageIds: string[], readBy: Map<string, string>): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const { data, error } = await auth.rpc("unread_counts_per_conversation", { p_workspace_id: workspaceId, p_conversation_ids: ids, p_user_id: userId, p_excluded_message_ids: excludedMessageIds });
  if (!error && Array.isArray(data)) {
    for (const row of data as Array<{ conversation_id: string; unread_count: number | string }>) counts.set(String(row.conversation_id), Number(row.unread_count));
    return counts;
  }
  if (!isMissingDbFunctionError(error)) return counts;
  const archivedIdList = excludedMessageIds.length > 0 ? `(${excludedMessageIds.join(",")})` : null;
  await Promise.all(ids.map(async (conversationId) => {
    const readAt = readBy.get(conversationId);
    let query = auth.from("conversation_messages").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("conversation_id", conversationId);
    if (readAt) query = query.gt("created_at", readAt);
    if (archivedIdList) query = query.not("id", "in", archivedIdList);
    const { count } = await query;
    counts.set(conversationId, count ?? 0);
  }));
  return counts;
}

