import { NextRequest, NextResponse } from "next/server";
import { resolveMissionPrincipal } from "@/lib/mission/mission-principal";
import { getGithubInstallationInfo } from "@/lib/github-app-api";
import { saveGithubInstallationForWorkspace } from "@/lib/github-installation-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/github/install/callback — GitHub redirects here after a human
 * completes "Install App" on github.com. `state` carries the workspace id
 * we sent when building the install link (Settings' "Connect GitHub"
 * button); `installation_id` is GitHub's own id for what was just
 * installed. The account this installation actually belongs to is read
 * back from GitHub itself (getGithubInstallationInfo), never trusted from
 * the query string, before it's stored as this workspace's install.
 *
 * requireHuman via resolveMissionPrincipal's cookie path: only a signed-in
 * human landing on their own redirect can complete this, and the workspace
 * saved is THEIR resolved workspace, never the raw `state` value re-trusted
 * as an id -- state only round-trips which install link was clicked, it is
 * not itself an authorization credential.
 */
export async function GET(req: NextRequest) {
  const installationId = req.nextUrl.searchParams.get("installation_id");
  const settingsUrl = new URL("/dashboard/settings", req.url);
  if (!installationId) {
    settingsUrl.searchParams.set("github_install", "missing_installation_id");
    return NextResponse.redirect(settingsUrl);
  }

  try {
    const principal = await resolveMissionPrincipal(req);
    if (principal.kind !== "human" || !principal.userId) {
      settingsUrl.searchParams.set("github_install", "sign_in_required");
      return NextResponse.redirect(settingsUrl);
    }
    const info = await getGithubInstallationInfo(installationId);
    await saveGithubInstallationForWorkspace({
      workspaceId: principal.workspaceId,
      installationId,
      accountLogin: info.accountLogin,
      accountType: info.accountType,
      installedByUserId: principal.userId,
    });
    settingsUrl.searchParams.set("github_install", "connected");
  } catch (error) {
    console.error("github/install/callback failed:", error instanceof Error ? error.message : error);
    settingsUrl.searchParams.set("github_install", "failed");
  }
  return NextResponse.redirect(settingsUrl);
}
