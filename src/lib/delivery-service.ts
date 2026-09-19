import { createClient } from "@supabase/supabase-js";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { explicitlyMentionedAgentKinds } from "@/lib/conversation-routing";
import { deriveDelivery, type DeliveryRecipient, type DeliveryView, type TimingEvidence } from "@/lib/delivery-state";
import { loadWorkspaceEndpoints, viewOf } from "@/lib/endpoint-service";

function requireService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service credentials are not configured.");
  return createClient(url, key, { auth: { persistSession: false } });
}

export interface MessageDeliveryReport {
  messageId: string;
  conversationId: string;
  createdAt: string;
  deliveries: DeliveryView[];
}

/**
 * Delivery timeline for one message, read-only. It writes nothing: it combines the stored message, the
 * recipients' liveness, and the timing events the Bridge already stores for every message it handles.
 * The caller must be a participant in the message's conversation; anything else is a plain 404.
 */
export async function getMessageDelivery(agent: AuthedAgent, messageId: string): Promise<MessageDeliveryReport> {
  const db = requireService();
  const notFound = () => new AgentJoinError("Message was not found.", "MESSAGE_NOT_FOUND", 404);
  if (!/^[0-9a-f-]{36}$/i.test(messageId)) throw notFound();

  const { data: message, error } = await db.from("conversation_messages")
    .select("id, conversation_id, recipient_connection_id, body, created_at")
    .eq("workspace_id", agent.workspaceId)
    .eq("id", messageId)
    .maybeSingle();
  if (error) throw new AgentJoinError("Could not read the message.", "MESSAGE_READ_FAILED", 500);
  if (!message) throw notFound();

  const { data: participant } = await db.from("conversation_participants")
    .select("connection_id")
    .eq("workspace_id", agent.workspaceId)
    .eq("conversation_id", message.conversation_id as string)
    .eq("connection_id", agent.connectionId)
    .maybeSingle();
  if (!participant) throw notFound();

  const [timingResult, loaded] = await Promise.all([
    db.from("workspace_turn_timing_events")
      .select("stage, provider, occurred_at, at_ms, bridge_instance_id, metadata")
      .eq("workspace_id", agent.workspaceId)
      .eq("message_id", messageId)
      .order("at_ms", { ascending: true })
      .limit(500),
    loadWorkspaceEndpoints(agent),
  ]);
  if (timingResult.error) throw new AgentJoinError("Could not read delivery evidence.", "DELIVERY_READ_FAILED", 500);
  const timings = (timingResult.data ?? []) as TimingEvidence[];

  const providers = new Set<string>(explicitlyMentionedAgentKinds(String(message.body ?? ""), loaded.rows.map((row) => ({ agent_kind: row.alias }))));
  const direct = message.recipient_connection_id as string | null;
  if (direct) {
    const { data: recipientConnection } = await db.from("agent_connections").select("agent_kind").eq("id", direct).maybeSingle();
    if (recipientConnection?.agent_kind) providers.add(String(recipientConnection.agent_kind));
  }
  for (const timing of timings) if (timing.provider) providers.add(timing.provider);

  const now = Date.now();
  const deliveries = [...providers].sort().map((provider): DeliveryView => {
    const candidates = loaded.rows.filter((row) => row.provider === provider || row.alias === provider);
    const row = candidates.find((candidate) => candidate.owner_user_id === loaded.viewerOwnerId) ?? candidates[0] ?? null;
    const view = row ? viewOf(row, loaded) : null;
    const recipient: DeliveryRecipient = {
      provider,
      address: view?.address ?? `@${provider}`,
      endpointId: view?.id ?? null,
      live: view?.reachability === "live",
      fidelityLevel: view?.fidelity.level ?? "CONSULTATION",
    };
    return deriveDelivery({ messageCreatedAt: message.created_at as string, recipient, timings, now });
  });

  return { messageId, conversationId: message.conversation_id as string, createdAt: message.created_at as string, deliveries };
}
