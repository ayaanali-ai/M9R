/**
 * Agent Instruction Channel v0.
 * ----------------------------------------------------------------------------
 * Dashboard-created, agent-pulled instructions for an approved connection.
 * The channel is intentionally pull-based: OathLock stores a short dashboard
 * instruction, and the connected coding agent retrieves it with the CLI.
 *
 * Invariants:
 *  - Dashboard writes are scoped through the signed-in user's active connection.
 *  - Agent reads are scoped through the Bearer token's own connection/workspace.
 *  - Instructions are never deleted on pull; they are marked pulled so audit
 *    history remains intact.
 */

import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { sanitizeString } from "@/lib/agent-join";
import {
  MAX_AGENT_INBOX_ITEMS,
  agentCanReadInstructions,
  sanitizeInstructionText,
  type AgentInboxInstruction,
} from "@/lib/agent-instruction-channel-core";

export { agentCanReadInstructions, sanitizeInstructionText };
export type { AgentInboxInstruction };

function requireService() {
  if (!supabase) {
    throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  }
  return supabase;
}

function mapInstructionRow(row: Record<string, unknown>, pulledAt?: string): AgentInboxInstruction {
  return {
    id: String(row.id ?? ""),
    instruction: String(row.instruction ?? ""),
    status: (pulledAt ? "pulled" : row.status) === "pulled" ? "pulled" : "queued",
    created_at: String(row.created_at ?? ""),
    pulled_at: pulledAt ?? (typeof row.pulled_at === "string" ? row.pulled_at : null),
  };
}

export async function createInstructionForDashboard(input: {
  connectionId: unknown;
  instruction: unknown;
}): Promise<AgentInboxInstruction> {
  const connectionId = sanitizeString(input.connectionId, 80);
  if (!connectionId) {
    throw new AgentJoinError("connection_id is required.", "BAD_REQUEST", 400);
  }

  const instruction = sanitizeInstructionText(input.instruction);
  if (!instruction) {
    throw new AgentJoinError("Instruction is required.", "BAD_REQUEST", 400);
  }

  const cookieDb = await createClient();
  if (!cookieDb) throw new AgentJoinError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
  const {
    data: { user },
  } = await cookieDb.auth.getUser();
  if (!user) throw new AgentJoinError("Sign in to send an instruction.", "UNAUTHENTICATED", 401);

  const { data: connection, error: connectionError } = await cookieDb
    .from("agent_connections")
    .select("id, workspace_id, status")
    .eq("id", connectionId)
    .eq("status", "active")
    .maybeSingle();

  if (connectionError) {
    console.error("createInstructionForDashboard connection lookup failed:", connectionError.message, connectionError.code);
    throw new AgentJoinError("Could not resolve agent connection.", "CONNECTION_LOOKUP_FAILED", 500);
  }
  if (!connection) {
    throw new AgentJoinError("Agent connection was not found.", "NOT_FOUND", 404);
  }

  const row = connection as { id: string; workspace_id: string | null };
  if (!row.workspace_id) {
    throw new AgentJoinError("Agent connection has no workspace.", "BAD_CONNECTION", 400);
  }

  const db = requireService();
  const { data, error } = await db
    .from("agent_instructions")
    .insert({
      connection_id: row.id,
      workspace_id: row.workspace_id,
      created_by: user.id,
      instruction,
      status: "queued",
    })
    .select("id, instruction, status, created_at, pulled_at")
    .single();

  if (error || !data) {
    console.error("createInstructionForDashboard insert failed:", error?.message, error?.code);
    throw new AgentJoinError("Could not queue the instruction.", "INSTRUCTION_CREATE_FAILED", 500);
  }

  return mapInstructionRow(data as Record<string, unknown>);
}

export async function pullInstructionsForAgent(agent: AuthedAgent): Promise<AgentInboxInstruction[]> {
  const db = requireService();
  const { data, error } = await db
    .from("agent_instructions")
    .select("id, instruction, status, created_at, pulled_at")
    .eq("connection_id", agent.connectionId)
    .eq("workspace_id", agent.workspaceId)
    .eq("status", "queued")
    .is("pulled_at", null)
    .order("created_at", { ascending: true })
    .limit(MAX_AGENT_INBOX_ITEMS);

  if (error) {
    console.error("pullInstructionsForAgent failed:", error.message, error.code);
    throw new AgentJoinError("Could not read the Agent inbox.", "INBOX_READ_FAILED", 500);
  }

  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((row) => typeof row.id === "string");
  if (rows.length === 0) return [];

  const pulledAt = new Date().toISOString();
  const ids = rows.map((row) => row.id as string);
  const { error: updateError } = await db
    .from("agent_instructions")
    .update({ status: "pulled", pulled_at: pulledAt })
    .in("id", ids)
    .eq("connection_id", agent.connectionId)
    .eq("workspace_id", agent.workspaceId);

  if (updateError) {
    console.error("pullInstructionsForAgent update failed:", updateError.message, updateError.code);
    throw new AgentJoinError("Could not update the Agent inbox.", "INBOX_UPDATE_FAILED", 500);
  }

  return rows.map((row) => mapInstructionRow(row, pulledAt));
}
