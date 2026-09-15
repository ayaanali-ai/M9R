/**
 * Workspace Membership — multi-human workspaces, phase 1 (see
 * supabase/migrations/20260830030000_workspace_members.sql for why this
 * exists and what it deliberately does not yet cover).
 *
 * Runs as the signed-in user (cookie session) for reads and role changes so
 * RLS enforces "member of this workspace only." Invite creation/acceptance
 * needs the service-role client because it writes rows the invited user
 * can't yet see under RLS (they aren't a member until acceptance).
 */

import { createClient } from "@/lib/supabase/server";
import { supabase as admin } from "@/lib/supabase";

export class WorkspaceMembershipError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message);
  }
}

export type WorkspaceRole = "owner" | "admin" | "member";

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  email: string | null;
  createdAt: string;
}

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  email: string;
  role: "admin" | "member";
  token: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

type Db = NonNullable<Awaited<ReturnType<typeof createClient>>>;

async function requireUser(): Promise<{ db: Db; userId: string; email: string | null }> {
  const db = await createClient();
  if (!db) throw new WorkspaceMembershipError("Supabase is not configured.", "DB_NOT_CONFIGURED", 503);
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) throw new WorkspaceMembershipError("Sign in to manage workspace membership.", "UNAUTHENTICATED", 401);
  return { db, userId: user.id, email: user.email ?? null };
}

function requireAdmin() {
  if (!admin) throw new WorkspaceMembershipError("Supabase service role is not configured.", "DB_NOT_CONFIGURED", 503);
  return admin;
}

async function requireRole(db: Db, workspaceId: string, userId: string): Promise<WorkspaceRole> {
  const { data, error } = await db
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new WorkspaceMembershipError(`Could not check membership: ${error.message}`, "READ_FAILED", 500);
  if (!data) throw new WorkspaceMembershipError("You are not a member of this workspace.", "NOT_A_MEMBER", 403);
  return data.role as WorkspaceRole;
}

function requireAdminRole(role: WorkspaceRole) {
  if (role !== "owner" && role !== "admin") {
    throw new WorkspaceMembershipError("Only the workspace owner or an admin can do this.", "FORBIDDEN", 403);
  }
}

/**
 * #21 access control: the gate every approve/reject dashboard route calls
 * before recording a decision -- run-starts, evidence requests, evidence
 * submissions, and evidence authorization. Plain "member" can see and
 * participate in chat but was previously able to approve/reject anything
 * any other signed-in workspace member could, which is not a real
 * permission boundary. A workspace with no explicit membership rows yet
 * (every workspace before the 2026-08-30 membership migration) has no way
 * to resolve a role at all -- treated as allowed rather than locking out
 * every existing single-owner workspace that never got backfilled.
 */
export async function requireApproverRole(workspaceId: string, userId: string): Promise<void> {
  const svc = requireAdmin();
  const { data, error } = await svc.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  if (error || !data) return;
  requireAdminRole(data.role as WorkspaceRole);
}

/** List a workspace's roster, email joined in via the service-role client
 * (workspace_members itself has no email column -- auth.users isn't
 * queryable from the cookie-scoped client). */
export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const { db, userId } = await requireUser();
  await requireRole(db, workspaceId, userId);
  const { data, error } = await db
    .from("workspace_members")
    .select("id, workspace_id, user_id, role, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (error) throw new WorkspaceMembershipError(`Could not list members: ${error.message}`, "READ_FAILED", 500);
  const rows = data ?? [];

  const emailByUserId = new Map<string, string | null>();
  const svc = requireAdmin();
  await Promise.all(
    rows.map(async (row) => {
      const { data: authUser } = await svc.auth.admin.getUserById(row.user_id);
      emailByUserId.set(row.user_id, authUser?.user?.email ?? null);
    }),
  );

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role as WorkspaceRole,
    email: emailByUserId.get(row.user_id) ?? null,
    createdAt: row.created_at,
  }));
}

export async function setWorkspaceMemberRole(
  workspaceId: string,
  targetUserId: string,
  role: "admin" | "member",
): Promise<void> {
  const { db, userId } = await requireUser();
  const actingRole = await requireRole(db, workspaceId, userId);
  requireAdminRole(actingRole);

  const { data: target, error: targetError } = await db
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (targetError) throw new WorkspaceMembershipError(`Could not check that member: ${targetError.message}`, "READ_FAILED", 500);
  if (!target) throw new WorkspaceMembershipError("That user is not a member of this workspace.", "NOT_A_MEMBER", 404);
  if (target.role === "owner") {
    throw new WorkspaceMembershipError("The workspace owner's role cannot be changed.", "FORBIDDEN", 403);
  }

  const { error } = await db
    .from("workspace_members")
    .update({ role })
    .eq("workspace_id", workspaceId)
    .eq("user_id", targetUserId);
  if (error) throw new WorkspaceMembershipError(`Could not update role: ${error.message}`, "WRITE_FAILED", 500);
}

export async function removeWorkspaceMember(workspaceId: string, targetUserId: string): Promise<void> {
  const { db, userId } = await requireUser();
  const actingRole = await requireRole(db, workspaceId, userId);
  requireAdminRole(actingRole);

  const { data: target, error: targetError } = await db
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (targetError) throw new WorkspaceMembershipError(`Could not check that member: ${targetError.message}`, "READ_FAILED", 500);
  if (!target) return;
  if (target.role === "owner") {
    throw new WorkspaceMembershipError("The workspace owner cannot be removed.", "FORBIDDEN", 403);
  }

  const { error } = await db
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", targetUserId);
  if (error) throw new WorkspaceMembershipError(`Could not remove that member: ${error.message}`, "WRITE_FAILED", 500);
}

/** A member (never the owner) leaves a workspace they're in -- their own
 * action, no admin role required, just membership. */
export async function leaveWorkspace(workspaceId: string): Promise<void> {
  const { db, userId } = await requireUser();
  const role = await requireRole(db, workspaceId, userId);
  if (role === "owner") {
    throw new WorkspaceMembershipError("The workspace owner cannot leave. Transfer or delete the workspace instead.", "FORBIDDEN", 403);
  }
  const { error } = await db
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
  if (error) throw new WorkspaceMembershipError(`Could not leave the workspace: ${error.message}`, "WRITE_FAILED", 500);
}

export async function listWorkspaceInvites(workspaceId: string): Promise<WorkspaceInvite[]> {
  const { db, userId } = await requireUser();
  await requireRole(db, workspaceId, userId);
  const { data, error } = await db
    .from("workspace_invites")
    .select("id, workspace_id, email, role, token, created_at, expires_at, accepted_at, revoked_at")
    .eq("workspace_id", workspaceId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new WorkspaceMembershipError(`Could not list invites: ${error.message}`, "READ_FAILED", 500);
  return (data ?? []).map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role as "admin" | "member",
    token: row.token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  }));
}

export async function inviteToWorkspace(
  workspaceId: string,
  email: string,
  role: "admin" | "member",
): Promise<WorkspaceInvite> {
  const { db, userId } = await requireUser();
  const actingRole = await requireRole(db, workspaceId, userId);
  requireAdminRole(actingRole);

  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) {
    throw new WorkspaceMembershipError("Enter a valid email address.", "INVALID_EMAIL", 400);
  }

  const svc = requireAdmin();
  const { data, error } = await svc
    .from("workspace_invites")
    .insert({ workspace_id: workspaceId, email: trimmed, role, invited_by: userId })
    .select("id, workspace_id, email, role, token, created_at, expires_at, accepted_at, revoked_at")
    .single();
  if (error) throw new WorkspaceMembershipError(`Could not create invite: ${error.message}`, "WRITE_FAILED", 500);
  return {
    id: data.id,
    workspaceId: data.workspace_id,
    email: data.email,
    role: data.role,
    token: data.token,
    createdAt: data.created_at,
    expiresAt: data.expires_at,
    acceptedAt: data.accepted_at,
    revokedAt: data.revoked_at,
  };
}

export async function revokeWorkspaceInvite(workspaceId: string, inviteId: string): Promise<void> {
  const { db, userId } = await requireUser();
  const actingRole = await requireRole(db, workspaceId, userId);
  requireAdminRole(actingRole);

  const svc = requireAdmin();
  const { error } = await svc
    .from("workspace_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", inviteId)
    .eq("workspace_id", workspaceId);
  if (error) throw new WorkspaceMembershipError(`Could not revoke invite: ${error.message}`, "WRITE_FAILED", 500);
}

/** Accept an invite by token. Possession of the token is the whole
 * authorization check -- there is no separate email-match gate. That gate
 * used to block acceptance whenever the signed-in account's email didn't
 * exactly match the address the invite was created under (a different
 * provider, a typo'd invite email, a teammate who already has an account
 * under a different address), with no email ever actually sent to explain
 * why. The invite link itself (single-use: it's consumed by setting
 * accepted_at below) is now the credential, the same model Slack/Discord/
 * Linear invite links use, not an identity check email delivery can't be
 * relied on to gate. */
export async function acceptWorkspaceInvite(token: string): Promise<{ workspaceId: string }> {
  const { userId } = await requireUser();
  const svc = requireAdmin();

  const { data: invite, error } = await svc
    .from("workspace_invites")
    .select("id, workspace_id, email, role, expires_at, accepted_at, revoked_at")
    .eq("token", token)
    .maybeSingle();
  if (error) throw new WorkspaceMembershipError(`Could not load invite: ${error.message}`, "READ_FAILED", 500);
  if (!invite) throw new WorkspaceMembershipError("This invite link is invalid.", "NOT_FOUND", 404);
  if (invite.revoked_at) throw new WorkspaceMembershipError("This invite was revoked.", "REVOKED", 410);
  if (invite.accepted_at) throw new WorkspaceMembershipError("This invite was already accepted.", "ALREADY_ACCEPTED", 410);
  if (Date.parse(invite.expires_at) < Date.now()) throw new WorkspaceMembershipError("This invite has expired.", "EXPIRED", 410);

  const { error: insertError } = await svc
    .from("workspace_members")
    .upsert({ workspace_id: invite.workspace_id, user_id: userId, role: invite.role, invited_by: null }, { onConflict: "workspace_id,user_id" });
  if (insertError) throw new WorkspaceMembershipError(`Could not join the workspace: ${insertError.message}`, "WRITE_FAILED", 500);

  await svc.from("workspace_invites").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);

  return { workspaceId: invite.workspace_id };
}
