/**
 * GitHub App installation-token broker (Phase B8 / plan §11.2). Mints a
 * short-lived (GitHub-controlled, max 1h) installation access token scoped
 * to one repository, so the Agent Bridge can push without ever holding a
 * user's personal Git credentials. This module is the only place that
 * touches the GitHub App private key — the Bridge calls
 * /api/bridge/git-token (bearer-agent-authenticated) and receives only the
 * short-lived token, never the App key itself.
 *
 * Requires three env vars only an operator who has actually created and
 * installed a GitHub App can supply:
 *   GITHUB_APP_ID              — numeric App ID from the App's settings page
 *   GITHUB_APP_PRIVATE_KEY     — the App's PEM private key (the .pem GitHub
 *                                 generates when you create the App)
 *   GITHUB_APP_INSTALLATION_ID — numeric installation ID from installing
 *                                 the App on the target repository/org
 * Fail-closed: minting throws immediately if any are missing, the same
 * discipline every other required-secret path in this codebase uses.
 */

import { createSign } from "node:crypto";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to mint a Git installation token.`);
  return value;
}

/**
 * Normalizes the handful of ways a copy-pasted PEM key routinely gets
 * mangled going through an env var UI: literal `\n` escape sequences
 * instead of real newlines, surrounding quotes carried over from a `.env`
 * habit, and stray leading/trailing whitespace. Never silently drops or
 * alters the actual key bytes — only whitespace/escaping around them.
 */
function normalizePemKey(raw: string): string {
  let value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();

  // Some copy paths (viewers that flatten the file, certain env-var UIs)
  // drop the PEM envelope entirely and leave only the base64 body on one
  // line. If what's left is pure base64 with no envelope at all, the
  // envelope is reconstructible byte-for-byte — GitHub always issues PKCS1
  // ("RSA PRIVATE KEY") .pem downloads — without altering a single key
  // byte, only restoring the header/footer/line-wrapping PEM requires.
  if (!value.includes("-----BEGIN") && /^[A-Za-z0-9+/=]+$/.test(value.replace(/\s+/g, ""))) {
    const body = value.replace(/\s+/g, "");
    const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
    value = `-----BEGIN RSA PRIVATE KEY-----\n${wrapped}\n-----END RSA PRIVATE KEY-----`;
  }

  return value;
}

/** GitHub App JWTs may not exceed 10 minutes; kept short and single-use. Exported for github-app-api.ts, which calls App-level (not installation-level) endpoints -- the App's own slug, an installation's account info -- using the same signing, never a second copy of it. */
export function buildAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const normalizedKey = normalizePemKey(privateKeyPem);
  if (!normalizedKey.includes("-----BEGIN") || !normalizedKey.includes("PRIVATE KEY-----")) {
    throw new Error("GITHUB_APP_PRIVATE_KEY does not look like a PEM private key (missing BEGIN/END markers) — check it was pasted in full, including those lines.");
  }
  const signature = createSign("RSA-SHA256").update(signingInput).sign(normalizedKey);
  return `${signingInput}.${base64url(signature)}`;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

/**
 * Mints a token scoped to exactly one repository (never the whole
 * installation) — the narrowest grant GitHub's API supports for this call.
 *
 * `installationId`, when supplied, is the CALLING WORKSPACE's own
 * installation (github-installation-store.ts) — this is the real
 * cross-tenant boundary: a workspace's token can only ever be minted
 * against repos its OWN installation actually has, enforced by GitHub
 * itself once this call reaches GitHub's API, not by an app-level check.
 * Omit it (or a workspace with no installation row yet) to fall back to
 * GITHUB_APP_INSTALLATION_ID, the single pre-existing installation this
 * broker used before per-workspace installs existed.
 */
export async function mintRepositoryInstallationToken(input: { owner: string; repo: string; installationId?: string | null }): Promise<InstallationToken> {
  const appId = requiredEnv("GITHUB_APP_ID");
  const privateKey = requiredEnv("GITHUB_APP_PRIVATE_KEY");
  const installationId = input.installationId?.trim() || requiredEnv("GITHUB_APP_INSTALLATION_ID");
  const jwt = buildAppJwt(appId, privateKey);

  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({ repositories: [input.repo] }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub installation token request failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = await response.json() as { token?: string; expires_at?: string };
  if (!data.token || !data.expires_at) throw new Error("GitHub installation token response was missing token/expires_at.");
  return { token: data.token, expiresAt: data.expires_at };
}
