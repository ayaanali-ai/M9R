import { supabase } from "@/lib/supabase";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { clampSince, clampLimit, validateAckSequence, OUTBOX_STALE_MS } from "@/lib/work-signal-delivery-core";

export { MAX_REPLAY_PAGE, OUTBOX_STALE_MS, clampSince, clampLimit, validateAckSequence, isOutboxRowStale } from "@/lib/work-signal-delivery-core";

export interface ReplayPage { signals: Array<Record<string, unknown>>; cursor: number }

/**
 * Cursor-based replay: returns Work Signals for the caller's workspace with
 * server_sequence strictly greater than `since`. If `since` is omitted, resumes
 * from this connection's own persisted cursor (0 if it has never acked).
 */
export async function readSignalsSince(agent: AuthedAgent, opts: { since?: unknown; limit?: unknown }): Promise<ReplayPage> {
  if (!supabase) throw new AgentJoinError("M9R backend is not configured.", "DB_NOT_CONFIGURED", 503);
  const limit = clampLimit(opts.limit);
  let since = clampSince(opts.since);
  if (since === null) {
    const { data: cursor } = await supabase.from("work_signal_cursors").select("last_acked_sequence").eq("connection_id", agent.connectionId).eq("workspace_id", agent.workspaceId).maybeSingle();
    since = typeof cursor?.last_acked_sequence === "number" ? cursor.last_acked_sequence : 0;
  }
  const { data, error } = await supabase
    .from("work_signals")
    .select("id, server_sequence, connection_id, run_id, type, source, summary, scope, repo, correlation_id, parent_event_id, received_at")
    .eq("workspace_id", agent.workspaceId)
    .gt("server_sequence", since)
    .order("server_sequence", { ascending: true })
    .limit(limit);
  if (error) throw new AgentJoinError("Could not read Work Signals.", "SIGNAL_READ_FAILED", 500);
  const signals = data ?? [];
  const cursor = signals.length > 0 ? (signals[signals.length - 1].server_sequence as number) : since;
  return { signals, cursor };
}

/**
 * Self-acknowledgement: a connection confirms it has durably received its own
 * signals through `throughSequence`. This both persists the connection's replay
 * cursor and marks that connection's own outbox rows delivered — it can never
 * advance another connection's cursor or mark another connection's rows.
 */
export async function acknowledgeSignals(agent: AuthedAgent, rawThroughSequence: unknown): Promise<{ acked_through: number }> {
  if (!supabase) throw new AgentJoinError("M9R backend is not configured.", "DB_NOT_CONFIGURED", 503);
  const throughSequence = validateAckSequence(rawThroughSequence);
  if (throughSequence === null) throw new AgentJoinError("Invalid acknowledgement sequence.", "BAD_ACK", 400);

  const { data: existing } = await supabase.from("work_signal_cursors").select("last_acked_sequence").eq("connection_id", agent.connectionId).eq("workspace_id", agent.workspaceId).maybeSingle();
  const nextSequence = Math.max(throughSequence, typeof existing?.last_acked_sequence === "number" ? existing.last_acked_sequence : 0);

  const { error: upsertError } = await supabase.from("work_signal_cursors").upsert({ connection_id: agent.connectionId, workspace_id: agent.workspaceId, last_acked_sequence: nextSequence, updated_at: new Date().toISOString() }, { onConflict: "connection_id" });
  if (upsertError) throw new AgentJoinError("Could not persist the replay cursor.", "CURSOR_WRITE_FAILED", 500);

  const { error: outboxError } = await supabase.from("work_signal_outbox").update({ delivery_state: "delivered", delivered_at: new Date().toISOString() }).eq("connection_id", agent.connectionId).eq("workspace_id", agent.workspaceId).lte("server_sequence", nextSequence).eq("delivery_state", "pending");
  if (outboxError) throw new AgentJoinError("Acknowledged, but outbox state could not be updated.", "OUTBOX_UPDATE_FAILED", 500);

  return { acked_through: nextSequence };
}

/**
 * Delivery worker sweep: pending outbox rows whose owning connection never
 * acknowledged them within the stale window are marked 'failed'. This never
 * fabricates delivery — it only ever downgrades an unconfirmed row.
 */
export async function sweepStaleOutbox(staleAfterMs = OUTBOX_STALE_MS): Promise<{ scanned: number; failed: number }> {
  if (!supabase) throw new AgentJoinError("M9R backend is not configured.", "DB_NOT_CONFIGURED", 503);
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const { data: stale, error } = await supabase.from("work_signal_outbox").select("signal_id").eq("delivery_state", "pending").lt("available_at", cutoff).limit(500);
  if (error) throw new AgentJoinError("Could not scan the Work Signal outbox.", "OUTBOX_SCAN_FAILED", 500);
  const rows = stale ?? [];
  if (rows.length === 0) return { scanned: 0, failed: 0 };
  const ids = rows.map((r) => r.signal_id as string);
  const { error: updateError } = await supabase.from("work_signal_outbox").update({ delivery_state: "failed" }).in("signal_id", ids).eq("delivery_state", "pending");
  if (updateError) throw new AgentJoinError("Could not update stale outbox rows.", "OUTBOX_UPDATE_FAILED", 500);
  return { scanned: rows.length, failed: ids.length };
}
