/**
 * GitHub Linkage — OathLock V2 Phase 10
 * ----------------------------------------------------------------------------
 * Optional references from a Run to the GitHub artifacts it produced. These
 * are agent-DECLARED, never independently verified against GitHub's API —
 * the Run Passport must never claim OathLock validated or owns them (see
 * master spec §15: "A Passport may link to GitHub artifacts without claiming
 * it caused or independently validated them.").
 */

const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const MAX_URL_LEN = 500;

export interface GithubLinksInput {
  commit?: string | null;
  branch?: string | null;
  pullRequestUrl?: string | null;
  ciUrl?: string | null;
}

export interface ValidatedGithubLinks {
  commit: string | null;
  branch: string | null;
  pullRequestUrl: string | null;
  ciUrl: string | null;
}

export interface GithubLinksValidationResult {
  ok: boolean;
  errors: string[];
  normalized: ValidatedGithubLinks | null;
}

function isSafeHttpsUrl(value: string): boolean {
  if (value.length > MAX_URL_LEN) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateGithubLinks(input: GithubLinksInput): GithubLinksValidationResult {
  const errors: string[] = [];

  const commit = input.commit?.trim() || null;
  if (commit && !COMMIT_SHA_RE.test(commit)) errors.push("commit must be a 7-40 character hex SHA.");

  const branch = input.branch?.trim() || null;
  if (branch && !BRANCH_NAME_RE.test(branch)) errors.push("branch contains characters not valid in a git ref name.");

  const pullRequestUrl = input.pullRequestUrl?.trim() || null;
  if (pullRequestUrl && !isSafeHttpsUrl(pullRequestUrl)) errors.push("pullRequestUrl must be a valid https:// URL.");

  const ciUrl = input.ciUrl?.trim() || null;
  if (ciUrl && !isSafeHttpsUrl(ciUrl)) errors.push("ciUrl must be a valid https:// URL.");

  if (errors.length > 0) return { ok: false, errors, normalized: null };

  return { ok: true, errors: [], normalized: { commit, branch, pullRequestUrl, ciUrl } };
}

/** True when at least one link was actually declared — used to gate rendering an empty section. */
export function hasAnyGithubLink(links: ValidatedGithubLinks | null | undefined): boolean {
  if (!links) return false;
  return Boolean(links.commit || links.branch || links.pullRequestUrl || links.ciUrl);
}
