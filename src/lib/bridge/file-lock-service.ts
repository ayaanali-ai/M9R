/**
 * Real file locking (item 4) -- prevents two agents from silently
 * overwriting each other's edits to the same file.
 *
 * What this is NOT: a filesystem-level lock. M9R does not sit between an
 * agent's CLI and the disk, so nothing here can physically stop a write.
 * What it does do is refuse the write at the one boundary M9R genuinely
 * controls -- the ACP permission request that a provider must get approved
 * before an edit tool-call proceeds (acp-stdio-adapter.ts's
 * requestPermission, the same gate the file-permission deny-list already
 * uses). A provider that never asks for permission is outside this gate,
 * which is a real limitation, not a claim to have covered every path.
 *
 * The check is a live round-trip per write attempt rather than a locally
 * cached lock table, deliberately: each agent runs in its own resident
 * process (often on a different machine), so a cached table has a staleness
 * window, and "usually correct" is the one thing a lock cannot be. Reads are
 * never gated -- only edit/delete/move-shaped tool calls pay the latency.
 */
import { supabase } from "@/lib/supabase";

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

/**
 * How long a lock survives without its turn ever reporting a terminal stage.
 * This is a crash safety net, not the normal release path -- a healthy turn
 * releases its own locks the moment it ends (see releaseLocksForConnection).
 * Deliberately generous: a real edit-heavy turn legitimately runs for many
 * minutes, and expiring a live agent's lock mid-work would reintroduce
 * exactly the overwrite this feature exists to prevent.
 */
export const LOCK_TTL_MS = 15 * 60_000;

export interface LockConflict {
  path: string;
  holderConnectionId: string;
  heldSince: string;
}

export type AcquireResult =
  | { ok: true; alreadyHeld: boolean }
  | { ok: false; conflict: LockConflict };

/**
 * Take the lock on one path for one connection, or report who already holds
 * it. Re-acquiring a lock this same connection already holds is a no-op
 * success (an agent editing the same file repeatedly in one turn must not
 * block itself), and refreshes the TTL so a long turn doesn't expire mid-work.
 */
export async function acquireFileLock(input: {
  workspaceId: string;
  connectionId: string;
  conversationId: string | null;
  path: string;
}): Promise<AcquireResult> {
  const db = requireService();
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + LOCK_TTL_MS).toISOString();

  // Clear any expired lock on this path first, so a crashed holder can never
  // block a healthy agent forever. Scoped to this path only -- a global sweep
  // on every write would make the hot path pay for unrelated rows.
  await db
    .from("file_locks")
    .update({ released_at: nowIso, released_reason: "expired" })
    .eq("workspace_id", input.workspaceId)
    .eq("path", input.path)
    .is("released_at", null)
    .lt("expires_at", nowIso);

  const { data: existing } = await db
    .from("file_locks")
    .select("id, holder_connection_id, held_since")
    .eq("workspace_id", input.workspaceId)
    .eq("path", input.path)
    .is("released_at", null)
    .maybeSingle();

  if (existing) {
    if (existing.holder_connection_id === input.connectionId) {
      await db.from("file_locks").update({ expires_at: expiresAt }).eq("id", existing.id);
      return { ok: true, alreadyHeld: true };
    }
    return {
      ok: false,
      conflict: {
        path: input.path,
        holderConnectionId: String(existing.holder_connection_id),
        heldSince: String(existing.held_since),
      },
    };
  }

  const { error } = await db.from("file_locks").insert({
    workspace_id: input.workspaceId,
    path: input.path,
    holder_connection_id: input.connectionId,
    conversation_id: input.conversationId,
    expires_at: expiresAt,
  });

  if (error) {
    // 23505 = file_locks_active_unique: another resident took this exact lock
    // between the select above and this insert. That race is the whole reason
    // the unique index exists -- treat it as the conflict it is, and report
    // the winner rather than pretending the insert succeeded.
    if (error.code === "23505") {
      const { data: winner } = await db
        .from("file_locks")
        .select("holder_connection_id, held_since")
        .eq("workspace_id", input.workspaceId)
        .eq("path", input.path)
        .is("released_at", null)
        .maybeSingle();
      if (winner && winner.holder_connection_id !== input.connectionId) {
        return {
          ok: false,
          conflict: {
            path: input.path,
            holderConnectionId: String(winner.holder_connection_id),
            heldSince: String(winner.held_since),
          },
        };
      }
      return { ok: true, alreadyHeld: true };
    }
    throw new Error("Could not acquire the file lock.");
  }

  return { ok: true, alreadyHeld: false };
}

/**
 * Release every lock a connection holds. The normal release path: called
 * when that connection's turn reaches a terminal stage, so nothing depends
 * on an agent explicitly unlocking, and a turn that fails or is cancelled
 * still frees its files.
 */
export async function releaseLocksForConnection(input: {
  workspaceId: string;
  connectionId: string;
  reason: string;
}): Promise<number> {
  const db = requireService();
  const { data, error } = await db
    .from("file_locks")
    .update({ released_at: new Date().toISOString(), released_reason: input.reason })
    .eq("workspace_id", input.workspaceId)
    .eq("holder_connection_id", input.connectionId)
    .is("released_at", null)
    .select("id");
  if (error) throw new Error("Could not release file locks.");
  return (data ?? []).length;
}

export interface HeldLockRow {
  id: string;
  path: string;
  holderConnectionId: string;
  conversationId: string | null;
  heldSince: string;
  expiresAt: string;
}

/** Every lock currently held in a workspace -- backs the human-facing view and the force-release control. */
export async function listHeldLocks(workspaceId: string): Promise<HeldLockRow[]> {
  const db = requireService();
  const { data, error } = await db
    .from("file_locks")
    .select("id, path, holder_connection_id, conversation_id, held_since, expires_at")
    .eq("workspace_id", workspaceId)
    .is("released_at", null)
    .gte("expires_at", new Date().toISOString())
    .order("held_since", { ascending: true });
  if (error) throw new Error("Could not read file locks.");
  return (data ?? []).map((row) => ({
    id: String(row.id),
    path: String(row.path),
    holderConnectionId: String(row.holder_connection_id),
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    heldSince: String(row.held_since),
    expiresAt: String(row.expires_at),
  }));
}

/**
 * Human override for a stuck lock. Same posture as the human-managed
 * file-permission deny-list: a person can always break a lock a crashed or
 * wedged agent left behind, without waiting out the TTL.
 */
export async function forceReleaseLock(input: { workspaceId: string; lockId: string }): Promise<void> {
  const db = requireService();
  const { error } = await db
    .from("file_locks")
    .update({ released_at: new Date().toISOString(), released_reason: "force_released_by_human" })
    .eq("id", input.lockId)
    .eq("workspace_id", input.workspaceId)
    .is("released_at", null);
  if (error) throw new Error("Could not release that lock.");
}
