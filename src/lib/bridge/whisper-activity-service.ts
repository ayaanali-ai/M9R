/**
 * Real observability for agent-to-agent messaging (see files-panel.tsx's
 * WhispersPanel) -- answers "does A2A actually fire in normal use," not just
 * "did it ever work once." A one-off DB query proved the mechanism is real;
 * this is what makes that an ongoing, checkable fact instead of a claim that
 * goes stale the moment nobody's looking.
 *
 * Deliberately not a synthetic heartbeat: this reads real production
 * traffic (any conversation_messages row with both sender_connection_id and
 * recipient_connection_id set -- the same filter WhispersPanel already
 * uses), so it measures whether the feature is actually being used, not
 * whether a scripted test can still make it fire on command.
 */
import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";

export interface WhisperActivitySummary {
  lastExchangeAt: string | null;
  lastSenderConnectionId: string | null;
  lastRecipientConnectionId: string | null;
  /** Distinct sender+recipient connection pairs seen in the last 30 days -- a raw message count would double-count one busy pair and read as healthier than it is. */
  distinctPairCount30d: number;
  totalCount30d: number;
}

const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_WHISPER_LIMIT = 100;

export interface WhisperMessage {
  id: string;
  senderConnectionId: string;
  recipientConnectionId: string;
  body: string;
  createdAt: string;
  channelName: string;
}

/**
 * The real, direct-query counterpart to WhispersPanel's old behavior of
 * client-side-filtering the full /api/dashboard/conversations firehose (up to
 * 100 conversations x 80 messages each) for the ~1% of rows that were
 * actually whispers. Same filter whisperActivitySummary() already uses
 * (sender_connection_id and recipient_connection_id both set), just fetching
 * the rows themselves instead of only aggregate stats.
 */
export async function listRecentWhispers(): Promise<WhisperMessage[]> {
  const auth = await createClient();
  if (!auth) throw new Error("Authentication is unavailable.");
  const { data: { user } } = await auth.auth.getUser();
  if (!user) throw new Error("Sign in to use workspace chat.");
  const workspaceId = await resolveActiveOrDefaultProjectId(auth, { id: user.id, email: user.email, name: null });
  if (!workspaceId) throw new Error("No workspace is available for this account.");
  if (!supabase) throw new Error("M9R agent backend is not configured.");

  const { data: messages, error: messagesError } = await supabase
    .from("conversation_messages")
    .select("id, conversation_id, sender_connection_id, recipient_connection_id, body, created_at")
    .eq("workspace_id", workspaceId)
    .not("sender_connection_id", "is", null)
    .not("recipient_connection_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(RECENT_WHISPER_LIMIT);
  if (messagesError) throw new Error("Could not read agent whispers.");
  if (!messages || messages.length === 0) return [];

  const conversationIds = [...new Set(messages.map((m) => m.conversation_id as string))];
  const { data: conversations, error: conversationsError } = await supabase
    .from("agent_conversations")
    .select("id, topic")
    .in("id", conversationIds);
  if (conversationsError) throw new Error("Could not read whisper channel names.");
  const topicById = new Map((conversations ?? []).map((c) => [c.id as string, (c.topic as string | null) ?? "channel"]));

  return messages.map((m) => ({
    id: m.id as string,
    senderConnectionId: m.sender_connection_id as string,
    recipientConnectionId: m.recipient_connection_id as string,
    body: m.body as string,
    createdAt: m.created_at as string,
    channelName: topicById.get(m.conversation_id as string) ?? "channel",
  }));
}

export async function whisperActivitySummary(): Promise<WhisperActivitySummary> {
  const auth = await createClient();
  if (!auth) throw new Error("Authentication is unavailable.");
  const { data: { user } } = await auth.auth.getUser();
  if (!user) throw new Error("Sign in to use workspace chat.");
  const workspaceId = await resolveActiveOrDefaultProjectId(auth, { id: user.id, email: user.email, name: null });
  if (!workspaceId) throw new Error("No workspace is available for this account.");
  if (!supabase) throw new Error("M9R agent backend is not configured.");

  const { data: latest, error: latestError } = await supabase
    .from("conversation_messages")
    .select("created_at, sender_connection_id, recipient_connection_id")
    .eq("workspace_id", workspaceId)
    .not("sender_connection_id", "is", null)
    .not("recipient_connection_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw new Error("Could not read agent-to-agent message history.");

  const { data: recent, error: recentError } = await supabase
    .from("conversation_messages")
    .select("sender_connection_id, recipient_connection_id")
    .eq("workspace_id", workspaceId)
    .not("sender_connection_id", "is", null)
    .not("recipient_connection_id", "is", null)
    .gte("created_at", new Date(Date.now() - LOOKBACK_MS).toISOString())
    .limit(2000);
  if (recentError) throw new Error("Could not read recent agent-to-agent activity.");

  const pairs = new Set((recent ?? []).map((row) => `${row.sender_connection_id}:${row.recipient_connection_id}`));

  return {
    lastExchangeAt: (latest?.created_at as string | undefined) ?? null,
    lastSenderConnectionId: (latest?.sender_connection_id as string | undefined) ?? null,
    lastRecipientConnectionId: (latest?.recipient_connection_id as string | undefined) ?? null,
    distinctPairCount30d: pairs.size,
    totalCount30d: recent?.length ?? 0,
  };
}
