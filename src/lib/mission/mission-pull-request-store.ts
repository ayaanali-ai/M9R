/**
 * CRUD + decision execution for mission_pull_requests. Same service-role,
 * app-code-scoped trust model as mission-git-provenance-store.ts.
 */

import { supabase } from "@/lib/supabase";
import { buildPullRequestCandidate, openPullRequestOnGitHub, type PullRequestCandidate } from "./mission-pull-request";
import { mintRepositoryInstallationToken } from "./mission-git-credential-broker";
import { getGithubInstallationForWorkspace } from "@/lib/github-installation-store";

export interface MissionPullRequestRecord {
  id: string;
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
  status: "pending" | "approved" | "rejected" | "opened" | "failed";
  prNumber: number | null;
  prUrl: string | null;
  failureReason: string | null;
  createdAt: string;
}

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

const COLUMNS = "id, workspace_id, mission_id, assignment_id, participant_id, owner, repo, head_branch, base_branch, title, body, candidate_digest, status, pr_number, pr_url, failure_reason, created_at";

function toRecord(row: Record<string, unknown>): MissionPullRequestRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    missionId: String(row.mission_id),
    assignmentId: String(row.assignment_id),
    participantId: String(row.participant_id),
    owner: String(row.owner),
    repo: String(row.repo),
    headBranch: String(row.head_branch),
    baseBranch: String(row.base_branch),
    title: String(row.title),
    body: String(row.body),
    candidateDigest: String(row.candidate_digest),
    status: row.status as MissionPullRequestRecord["status"],
    prNumber: typeof row.pr_number === "number" ? row.pr_number : null,
    prUrl: (row.pr_url as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

/** An agent proposes opening a PR. Never opens anything -- just records a pending candidate a human must decide on. */
export async function proposePullRequest(input: {
  workspaceId: string; missionId: string; assignmentId: string; participantId: string;
  owner: string; repo: string; headBranch: string; baseBranch: string; title: string; body?: string;
}): Promise<MissionPullRequestRecord> {
  const candidate: PullRequestCandidate = buildPullRequestCandidate(input);
  const db = requireService();
  const { data, error } = await db.from("mission_pull_requests").upsert({
    workspace_id: input.workspaceId,
    mission_id: input.missionId,
    assignment_id: input.assignmentId,
    participant_id: input.participantId,
    owner: candidate.owner,
    repo: candidate.repo,
    head_branch: candidate.headBranch,
    base_branch: candidate.baseBranch,
    title: candidate.title,
    body: candidate.body,
    candidate_digest: candidate.candidateDigest,
  }, { onConflict: "mission_id,candidate_digest", ignoreDuplicates: true }).select(COLUMNS).maybeSingle();
  if (error) throw new Error(`Could not propose the pull request: ${error.message}`);
  if (data) return toRecord(data as Record<string, unknown>);
  // Idempotent retry: the exact same candidate was already proposed. Return the existing row rather than treating a resubmission as a new one.
  const existing = await db.from("mission_pull_requests").select(COLUMNS).eq("mission_id", input.missionId).eq("candidate_digest", candidate.candidateDigest).single();
  if (existing.error || !existing.data) throw new Error("Could not load the proposed pull request after an idempotent upsert.");
  return toRecord(existing.data as Record<string, unknown>);
}

export async function listPullRequests(workspaceId: string, missionId: string): Promise<MissionPullRequestRecord[]> {
  const db = requireService();
  const { data, error } = await db.from("mission_pull_requests").select(COLUMNS).eq("workspace_id", workspaceId).eq("mission_id", missionId).order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(`Could not list pull requests: ${error.message}`);
  return (data ?? []).map((row) => toRecord(row as Record<string, unknown>));
}

/**
 * The one place a human decision turns into a real GitHub API call. Reject
 * just marks the row; approve mints an installation token scoped to this
 * exact repo and opens the PR immediately (no Bridge round trip needed --
 * see mission-pull-request.ts's module comment for why). A GitHub failure
 * is recorded as 'failed' with the reason, never silently retried or
 * swallowed, and never leaves the row claiming 'opened' when it wasn't.
 */
export async function decidePullRequest(input: {
  workspaceId: string; missionId: string; candidateDigest: string; decision: "approved" | "rejected"; decidedByUserId: string;
}): Promise<MissionPullRequestRecord> {
  const db = requireService();
  const { data: pending, error: findError } = await db.from("mission_pull_requests").select(COLUMNS)
    .eq("workspace_id", input.workspaceId).eq("mission_id", input.missionId).eq("candidate_digest", input.candidateDigest).eq("status", "pending").maybeSingle();
  if (findError) throw new Error(`Could not load the pull request candidate: ${findError.message}`);
  if (!pending) throw new Error("No matching pending pull request candidate was found.");
  const record = toRecord(pending as Record<string, unknown>);

  if (input.decision === "rejected") {
    const { data, error } = await db.from("mission_pull_requests")
      .update({ status: "rejected", decided_by_user_id: input.decidedByUserId, decided_at: new Date().toISOString() })
      .eq("id", record.id).select(COLUMNS).single();
    if (error) throw new Error(`Could not record the rejection: ${error.message}`);
    return toRecord(data as Record<string, unknown>);
  }

  await db.from("mission_pull_requests").update({ status: "approved", decided_by_user_id: input.decidedByUserId, decided_at: new Date().toISOString() }).eq("id", record.id);

  try {
    const installation = await getGithubInstallationForWorkspace(input.workspaceId);
    const token = await mintRepositoryInstallationToken({ owner: record.owner, repo: record.repo, installationId: installation?.installationId ?? null });
    const opened = await openPullRequestOnGitHub({ token: token.token, owner: record.owner, repo: record.repo, head: record.headBranch, base: record.baseBranch, title: record.title, body: record.body });
    const { data, error } = await db.from("mission_pull_requests")
      .update({ status: "opened", pr_number: opened.number, pr_url: opened.url, opened_at: new Date().toISOString() })
      .eq("id", record.id).select(COLUMNS).single();
    if (error) throw new Error(`PR opened on GitHub (#${opened.number}) but could not be recorded: ${error.message}`);
    return toRecord(data as Record<string, unknown>);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await db.from("mission_pull_requests").update({ status: "failed", failure_reason: reason.slice(0, 2000) }).eq("id", record.id);
    throw new Error(`Could not open the pull request on GitHub: ${reason}`);
  }
}
