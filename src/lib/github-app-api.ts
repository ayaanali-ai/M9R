/**
 * App-level (not installation-level) GitHub API calls — the App's own
 * public slug (to build an install link) and an installation's account
 * info (to record who installed it). Distinct from
 * mission-git-credential-broker.ts's mintRepositoryInstallationToken,
 * which mints a token scoped to one repo for actually pushing/opening a
 * PR; this file only ever reads App/installation metadata.
 */

import { buildAppJwt } from "./mission/mission-git-credential-broker";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function appJwtFetch(path: string): Promise<Response> {
  const appId = requiredEnv("GITHUB_APP_ID");
  const privateKey = requiredEnv("GITHUB_APP_PRIVATE_KEY");
  const jwt = buildAppJwt(appId, privateKey);
  return fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
}

/** The App's public slug (e.g. "oathlock-bridge"), used to build https://github.com/apps/{slug}/installations/new links. Never guessed/hardcoded -- GitHub is the source of truth since the slug is chosen at App creation and this codebase doesn't control it. */
export async function getGithubAppSlug(): Promise<string> {
  const response = await appJwtFetch("/app");
  if (!response.ok) throw new Error(`Could not resolve the GitHub App's slug (HTTP ${response.status}).`);
  const data = await response.json() as { slug?: string };
  if (!data.slug) throw new Error("GitHub App info response was missing slug.");
  return data.slug;
}

export interface GithubInstallationInfo {
  accountLogin: string;
  accountType: "User" | "Organization";
}

/** Resolves the account an installation actually belongs to, straight from GitHub -- never trusts a client-supplied account name for what a given installation_id is installed on. */
export async function getGithubInstallationInfo(installationId: string): Promise<GithubInstallationInfo> {
  const response = await appJwtFetch(`/app/installations/${encodeURIComponent(installationId)}`);
  if (!response.ok) throw new Error(`Could not resolve installation ${installationId} (HTTP ${response.status}).`);
  const data = await response.json() as { account?: { login?: string; type?: string } };
  const login = data.account?.login;
  const type = data.account?.type;
  if (!login || (type !== "User" && type !== "Organization")) throw new Error("GitHub installation response was missing a valid account.");
  return { accountLogin: login, accountType: type };
}
