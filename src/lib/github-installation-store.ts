/**
 * Per-workspace GitHub App installation lookup/write — the cross-tenant
 * boundary described in mission-git-credential-broker.ts's
 * mintRepositoryInstallationToken. One row per workspace; re-installing
 * (or installing under a different account) replaces it, matching how a
 * GitHub App install is itself a replace-not-append action client-side.
 */

import { supabase } from "@/lib/supabase";

export interface GithubAppInstallation {
  workspaceId: string;
  installationId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  createdAt: string;
}

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

function toInstallation(row: Record<string, unknown>): GithubAppInstallation {
  return {
    workspaceId: String(row.workspace_id),
    installationId: String(row.installation_id),
    accountLogin: String(row.account_login),
    accountType: row.account_type as GithubAppInstallation["accountType"],
    createdAt: String(row.created_at),
  };
}

export async function getGithubInstallationForWorkspace(workspaceId: string): Promise<GithubAppInstallation | null> {
  const db = requireService();
  const { data, error } = await db.from("github_app_installations").select("workspace_id, installation_id, account_login, account_type, created_at").eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw new Error(`Could not load GitHub installation: ${error.message}`);
  return data ? toInstallation(data as Record<string, unknown>) : null;
}

export async function saveGithubInstallationForWorkspace(input: {
  workspaceId: string; installationId: string; accountLogin: string; accountType: "User" | "Organization"; installedByUserId: string;
}): Promise<GithubAppInstallation> {
  const db = requireService();
  const { data, error } = await db.from("github_app_installations").upsert({
    workspace_id: input.workspaceId,
    installation_id: input.installationId,
    account_login: input.accountLogin,
    account_type: input.accountType,
    installed_by_user_id: input.installedByUserId,
  }, { onConflict: "workspace_id" }).select("workspace_id, installation_id, account_login, account_type, created_at").single();
  if (error) throw new Error(`Could not save GitHub installation: ${error.message}`);
  return toInstallation(data as Record<string, unknown>);
}

export async function deleteGithubInstallationForWorkspace(workspaceId: string): Promise<void> {
  const db = requireService();
  await db.from("github_app_installations").delete().eq("workspace_id", workspaceId);
}
