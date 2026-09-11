/**
 * Personal API tokens (user_api_tokens) -- a human's own bearer token for
 * external tools to read their workspace, independent of any connected
 * coding agent. Originally scaffolded for the IDE presence feature
 * (supabase/migrations/20260830230441_ide_presence.sql) but never actually
 * issued from anywhere; this is the first real issuance path. Same posture
 * as every other bearer-token system here: only a SHA-256 hash is ever
 * stored, the raw token is shown once at creation and cannot be recovered.
 *
 * #15's Memory MCP endpoint is this token's first real consumer -- see
 * src/app/api/mcp/memory/route.ts.
 */
import { randomBytes, createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { supabase as admin } from "@/lib/supabase";

export class UserApiTokenError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message);
  }
}

export interface UserApiToken {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const TOKEN_PREFIX = "m9r_pat_";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function requireUser(): Promise<{ userId: string }> {
  const db = await createClient();
  if (!db) throw new UserApiTokenError("Supabase is not configured.", "DB_NOT_CONFIGURED", 503);
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new UserApiTokenError("Sign in to manage API tokens.", "UNAUTHENTICATED", 401);
  return { userId: user.id };
}

function requireAdmin() {
  if (!admin) throw new UserApiTokenError("Supabase service role is not configured.", "DB_NOT_CONFIGURED", 503);
  return admin;
}

export async function listUserApiTokens(): Promise<UserApiToken[]> {
  const { userId } = await requireUser();
  const db = requireAdmin();
  const { data, error } = await db.from("user_api_tokens").select("id, label, created_at, last_used_at").eq("user_id", userId).order("created_at", { ascending: false });
  if (error) throw new UserApiTokenError(`Could not list tokens: ${error.message}`, "READ_FAILED", 500);
  return (data ?? []).map((row) => ({ id: row.id, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
}

/** Returns the raw token exactly once -- callers must show it and discard it, it is never retrievable again. */
export async function createUserApiToken(label: string): Promise<{ id: string; token: string; label: string }> {
  const { userId } = await requireUser();
  const trimmedLabel = label.trim().slice(0, 100) || "API token";
  const raw = `${TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
  const db = requireAdmin();
  const { data, error } = await db.from("user_api_tokens").insert({ user_id: userId, label: trimmedLabel, token_hash: hashToken(raw) }).select("id").single();
  if (error) throw new UserApiTokenError(`Could not create token: ${error.message}`, "WRITE_FAILED", 500);
  return { id: data.id, token: raw, label: trimmedLabel };
}

export async function revokeUserApiToken(tokenId: string): Promise<void> {
  const { userId } = await requireUser();
  const db = requireAdmin();
  const { error } = await db.from("user_api_tokens").delete().eq("id", tokenId).eq("user_id", userId);
  if (error) throw new UserApiTokenError(`Could not revoke token: ${error.message}`, "WRITE_FAILED", 500);
}

/**
 * Bearer-token auth for external MCP clients (#15) -- resolves a raw token
 * straight to its owning user id, or null for anything that doesn't match a
 * live row. Also bumps last_used_at, best-effort, so a stale-but-forgotten
 * token is visible as such in the tokens list rather than looking identical
 * to one in active use.
 */
export async function resolveUserApiToken(raw: string): Promise<{ userId: string } | null> {
  const db = requireAdmin();
  const { data, error } = await db.from("user_api_tokens").select("id, user_id").eq("token_hash", hashToken(raw)).maybeSingle();
  if (error || !data) return null;
  void db.from("user_api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {}, () => {});
  return { userId: data.user_id as string };
}
