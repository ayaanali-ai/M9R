/**
 * Tamper-evident audit log — Buzz-parity (crates/buzz-audit): every entry is
 * SHA-256 chained to the previous entry of the same workspace, appended
 * inside a single locked transaction (public.append_audit_log_entry in
 * 20260804020000_audit_log_chain.sql). Deleting or editing a row, or
 * reordering the sequence, breaks the chain from that point forward —
 * verifyAuditLogChain below detects exactly that.
 *
 * This is deliberately a SEPARATE ledger from mission_events. mission_events
 * is the Mission's own replayable command/event log (append-only for a
 * different reason -- CQRS event sourcing); this is a flat, cross-cutting
 * "what happened and who did it" record spanning missions, evidence,
 * review decisions, git operations, and moderation actions, chained the way
 * Buzz's is.
 */

import { supabase } from "@/lib/supabase";

export type AuditLogActorKind = "human" | "agent" | "system";

export interface AuditLogEntry {
  seq: number;
  entryHash: string;
  prevHash: string | null;
  action: string;
  actorKind: AuditLogActorKind;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

/** Appends one entry to the workspace's chain. Never throws on caller-side
 *  bugs silently — a broken append means the chain itself would be wrong,
 *  so this surfaces the error rather than swallowing it (unlike the
 *  best-effort `.catch` pattern used for non-governance side effects
 *  elsewhere in this codebase). */
export async function appendAuditLogEntry(input: {
  workspaceId: string;
  action: string;
  actorKind: AuditLogActorKind;
  actorId: string | null;
  payload: Record<string, unknown>;
}): Promise<{ seq: number; entryHash: string }> {
  const db = requireService();
  const { data, error } = await db.rpc("append_audit_log_entry", {
    p_workspace_id: input.workspaceId,
    p_action: input.action,
    p_actor_kind: input.actorKind,
    p_actor_id: input.actorId,
    p_payload: input.payload,
  });
  if (error || !data || data.length === 0) throw new Error(`Could not append audit log entry: ${error?.message ?? "unknown error"}`);
  const row = data[0] as { seq: number; entry_hash: string };
  return { seq: row.seq, entryHash: row.entry_hash };
}

export async function listAuditLogEntries(workspaceId: string, limit = 200): Promise<AuditLogEntry[]> {
  const db = requireService();
  const { data, error } = await db.from("audit_log_entries")
    .select("seq, entry_hash, prev_hash, action, actor_kind, actor_id, payload, created_at")
    .eq("workspace_id", workspaceId).order("seq", { ascending: true }).limit(limit);
  if (error) throw new Error(`Could not load audit log: ${error.message}`);
  return (data ?? []).map((row) => ({
    seq: row.seq, entryHash: row.entry_hash, prevHash: row.prev_hash, action: row.action,
    actorKind: row.actor_kind as AuditLogActorKind, actorId: row.actor_id,
    payload: row.payload as Record<string, unknown>, createdAt: row.created_at,
  }));
}

export interface AuditLogVerification {
  ok: boolean;
  entriesChecked: number;
  brokenAtSeq: number | null;
  reason: string | null;
}

/** Delegates to public.verify_audit_log_chain (same migration) rather than
 *  reimplementing the hash walk in JS: jsonb's own text canonicalization is
 *  exactly what payload::text produced at write time, so recomputing with
 *  the identical SQL expression is the only way to avoid a false "tampered"
 *  verdict caused by a cross-language reserialization mismatch instead of
 *  real tampering. */
export async function verifyAuditLogChain(workspaceId: string): Promise<AuditLogVerification> {
  const db = requireService();
  const { data, error } = await db.rpc("verify_audit_log_chain", { p_workspace_id: workspaceId });
  if (error || !data || data.length === 0) throw new Error(`Could not verify audit log chain: ${error?.message ?? "unknown error"}`);
  const row = data[0] as { ok: boolean; entries_checked: number; broken_at_seq: number | null; reason: string | null };
  return { ok: row.ok, entriesChecked: row.entries_checked, brokenAtSeq: row.broken_at_seq, reason: row.reason };
}
