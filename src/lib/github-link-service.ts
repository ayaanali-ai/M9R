/**
 * GitHub Link Service — DB-facing writes/reads for Phase 10.
 * ----------------------------------------------------------------------------
 * Same additive, resilient-to-unmigrated-schema pattern as
 * readEvidenceContractMetadata / listLinkedRunIds — a dedicated small reader
 * rather than expanding the shared agent_runs column set every consumer
 * selects (agent-runs-read.ts), to keep this Phase's blast radius small.
 */

import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { validateGithubLinks, type GithubLinksInput, type ValidatedGithubLinks } from "@/lib/github-link";

function requireService() {
  if (!supabase) {
    throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  }
  return supabase;
}

function isMissingColumnError(err: { code?: string | null; message?: string | null } | null): boolean {
  if (!err) return false;
  return err.code === "42703" || /column .* does not exist/i.test(err.message ?? "");
}

export interface SetGithubLinksResult {
  ok: boolean;
  links: ValidatedGithubLinks | null;
  errors: string[];
}

export async function setGithubLinks(agent: AuthedAgent, runId: string, raw: GithubLinksInput): Promise<SetGithubLinksResult> {
  const result = validateGithubLinks(raw);
  if (!result.ok) return { ok: false, links: null, errors: result.errors };

  const db = requireService();
  const { error } = await db
    .from("agent_runs")
    .update({
      github_commit: result.normalized!.commit,
      github_branch: result.normalized!.branch,
      github_pr_url: result.normalized!.pullRequestUrl,
      github_ci_url: result.normalized!.ciUrl,
    })
    .eq("id", runId)
    .eq("connection_id", agent.connectionId);

  if (error) {
    if (isMissingColumnError(error)) return { ok: true, links: result.normalized, errors: [] };
    console.error("setGithubLinks failed:", error.message, error.code);
    return { ok: false, links: null, errors: [error.message] };
  }
  return { ok: true, links: result.normalized, errors: [] };
}

/** RLS-scoped read for the Run Passport loader. */
export async function readGithubLinksForRun(runId: string): Promise<ValidatedGithubLinks | null> {
  const db = await createClient();
  if (!db) return null;
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return null;

  const { data, error } = await db
    .from("agent_runs")
    .select("github_commit, github_branch, github_pr_url, github_ci_url")
    .eq("id", runId)
    .maybeSingle();

  if (error) {
    if (isMissingColumnError(error)) return null;
    throw error;
  }
  if (!data) return null;
  const row = data as { github_commit: string | null; github_branch: string | null; github_pr_url: string | null; github_ci_url: string | null };
  if (!row.github_commit && !row.github_branch && !row.github_pr_url && !row.github_ci_url) return null;
  return { commit: row.github_commit, branch: row.github_branch, pullRequestUrl: row.github_pr_url, ciUrl: row.github_ci_url };
}
