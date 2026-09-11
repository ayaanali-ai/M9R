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
