import { supabase } from "@/lib/supabase";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { acceptHeartbeat, type HeartbeatObservation } from "@/lib/agent-heartbeat";

function db() {
  if (!supabase) throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  return supabase;
}

export async function recordAgentHeartbeat(
  agent: AuthedAgent,
  payload: unknown,
  receivedAt = new Date().toISOString(),
): Promise<HeartbeatObservation> {
  const client = db();
  const accepted = acceptHeartbeat(payload, {
    receivedAt,
    previousSequence: null,
  });
  if (!accepted.ok) {
    const conflict = accepted.reason === "sequence_not_newer";
    throw new AgentJoinError(
      conflict ? "Heartbeat sequence was already seen or is out of order." : "Invalid heartbeat payload.",
      conflict ? "HEARTBEAT_REPLAY" : "BAD_HEARTBEAT",
      conflict ? 409 : 400,
    );
  }

  const observation = accepted.observation;
  const { data, error: writeError } = await client.rpc("record_agent_heartbeat_atomic", {
    p_connection_id: agent.connectionId,
    p_workspace_id: agent.workspaceId,
    p_protocol_version: observation.protocolVersion,
    p_adapter_instance_id: observation.adapterInstanceId,
    p_sequence: observation.sequence,
    p_execution_origin: observation.executionOrigin,
    p_provider: observation.provider,
    p_idempotency_key: observation.idempotencyKey,
    p_received_at: observation.receivedAt,
    p_lease_expires_at: observation.leaseExpiresAt,
  });
  if (writeError) {
    throw new AgentJoinError("Could not record heartbeat.", "PRESENCE_WRITE_FAILED", 500);
  }
  const result = Array.isArray(data) ? data[0] as { accepted?: boolean; reason?: string | null } | undefined : null;
  if (!result?.accepted) {
    const replay = result?.reason === "sequence_not_newer" || result?.reason === "duplicate";
    throw new AgentJoinError(
      replay ? "Heartbeat sequence was already seen or is out of order." : "Connection is not active.",
      replay ? "HEARTBEAT_REPLAY" : "CONNECTION_INACTIVE",
      replay ? 409 : 403,
    );
  }

  return observation;
}
