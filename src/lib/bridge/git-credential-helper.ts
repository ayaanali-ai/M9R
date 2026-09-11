/**
 * Performs the actual `git push` using a short-lived installation token
 * minted by /api/bridge/git-token (mission-git-credential-broker.ts). The
 * token is embedded in the remote URL for exactly one push invocation and
 * never written to disk, git config, or a persistent credential store —
 * GitHub App installation tokens are already bounded to ~1h and one repo,
 * so there is nothing to gain from persisting it and real risk in doing so.
 */

import { execFileSync } from "node:child_process";

export interface PushWithTokenInput {
  repoPath: string;
  branch: string;
  owner: string;
  repo: string;
  token: string;
}

export interface PushResult {
  ok: true;
}

/** Throws on failure. Never includes the token in a thrown error message — only the sanitized command shape. */
export function pushWithInstallationToken(input: PushWithTokenInput): PushResult {
  const authenticatedUrl = `https://x-access-token:${input.token}@github.com/${input.owner}/${input.repo}.git`;
  try {
    execFileSync("git", ["-C", input.repoPath, "push", authenticatedUrl, `HEAD:refs/heads/${input.branch}`], { stdio: "pipe" });
  } catch (error) {
    throw new Error(`git push to ${input.owner}/${input.repo}:${input.branch} failed: ${sanitize(error)}`);
  }
  return { ok: true };
}

/** Strips any embedded credential from a caught error's message/output before it can reach a log, feed message, or thrown error. */
function sanitize(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}
