/**
 * Real PR create — the counterpart to mission-git-provenance.ts's commit
 * candidate, but for opening a GitHub pull request. Unlike a push, opening
 * a PR needs no local git checkout: it's one authenticated GitHub API call,
 * so once a human approves the candidate this executes directly from
 * OathLock's own server (mission-pull-request-store.ts's decide()) rather
 * than round-tripping through the Agent Bridge the way performApprovedPush
 * has to (git-push-flow.ts needs the Bridge's local worktree).
 *
 * Same human-gate discipline as every other Git-touching path in this
 * codebase: an agent may only PROPOSE a candidate; only a human decision
 * can turn "pending" into a real GitHub API call.
 */

import { createHash } from "node:crypto";
import { redactSession } from "@/lib/session-redaction";

export interface PullRequestCandidate {
  version: "oathlock.pull-request-candidate.v1";
  workspaceId: string;
  missionId: string;
  assignmentId: string;
  participantId: string;
  owner: string;
  repo: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  candidateDigest: string;
}

function safeText(value: unknown, maxLength: number): string {
  return redactSession(typeof value === "string" ? value : String(value ?? "")).redactedText.slice(0, maxLength);
}

function validBranch(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._/-]{1,200}$/.test(value) && !value.startsWith("-") && !value.includes("..") && !value.endsWith("/");
}

function validRepoSegment(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,200}$/.test(value);
}

export function buildPullRequestCandidate(input: {
  workspaceId: string;
  missionId: string;
  assignmentId: string;
  participantId: string;
  owner: string;
  repo: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body?: string;
}): PullRequestCandidate {
  if (!validRepoSegment(input.owner) || !validRepoSegment(input.repo)) throw new Error("owner and repo must be valid GitHub path segments.");
  if (!validBranch(input.headBranch)) throw new Error("headBranch is invalid.");
  if (!validBranch(input.baseBranch)) throw new Error("baseBranch is invalid.");
  if (input.headBranch === input.baseBranch) throw new Error("headBranch and baseBranch must differ.");
  const title = input.title?.trim();
  if (!title) throw new Error("title is required.");

  const candidateWithoutDigest = {
    version: "oathlock.pull-request-candidate.v1" as const,
    workspaceId: safeText(input.workspaceId, 256),
    missionId: safeText(input.missionId, 256),
    assignmentId: safeText(input.assignmentId, 256),
    participantId: safeText(input.participantId, 256),
    owner: input.owner,
    repo: input.repo,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch,
    title: safeText(title, 500),
    body: safeText(input.body ?? "", 8000),
  };
  const candidateDigest = createHash("sha256").update(JSON.stringify(candidateWithoutDigest)).digest("hex");
  return { ...candidateWithoutDigest, candidateDigest };
}

export interface OpenedPullRequest {
  number: number;
  url: string;
}

/** The one place this codebase calls GitHub's create-PR endpoint. Never called except from mission-pull-request-store.ts's decide(), and only after a human "approved" decision already exists for this exact candidateDigest. */
export async function openPullRequestOnGitHub(input: { token: string; owner: string; repo: string; head: string; base: string; title: string; body: string }): Promise<OpenedPullRequest> {
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: input.title, head: input.head, base: input.base, body: input.body || undefined }),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`GitHub PR creation failed with HTTP ${response.status}: ${errorBody.slice(0, 300)}`);
  }
  const data = await response.json() as { number?: number; html_url?: string };
  if (!data.number || !data.html_url) throw new Error("GitHub PR creation response was missing number/html_url.");
  return { number: data.number, url: data.html_url };
}
