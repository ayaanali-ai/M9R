import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

export type DiffReviewState = "pending" | "approved" | "rejected";
export type DiffChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

export interface BoundedDiffManifest {
  version: "oathlock.diff-manifest.v1";
  grantId: string;
  baseCommit: string;
  headCommit: string;
  changedFiles: Array<{ status: DiffChangeStatus; path: string }>;
  violations: Array<{ path: string; reason: "prohibited_path" | "outside_allowed_paths" }>;
  reviewable: boolean;
  digest: string;
}

function grantId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{8,100}$/.test(value)) throw new Error("Grant id is invalid.");
}

function cleanRepoPath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.includes("../") || /^[a-zA-Z]:/.test(path)) throw new Error("Changed file path is invalid.");
  return path;
}

function matchesScope(path: string, scope: string): boolean {
  const normalized = cleanRepoPath(scope).replace(/\/$/, "");
  return path === normalized || path.startsWith(`${normalized}/`);
}

export function worktreeSpecForGrant(repositoryRoot: string, value: unknown): { worktreeRoot: string; branch: string } {
  grantId(value);
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "-");
  return { worktreeRoot: resolve(repositoryRoot, "..", ".oathlock-worktrees", value), branch: `oathlock/${safe}` };
}

type GitExecutor = (file: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
const executeGit: GitExecutor = async (file, args, cwd) => promisify(execFile)(file, args, { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });

export async function createGrantWorktree(input: { repositoryRoot: string; grantId: unknown; baseRef: string }, executor: GitExecutor = executeGit) {
  const repositoryRoot = resolve(input.repositoryRoot);
  const spec = worktreeSpecForGrant(repositoryRoot, input.grantId);
  if (!/^[a-zA-Z0-9._\/-]{1,200}$/.test(input.baseRef) || input.baseRef.startsWith("-")) throw new Error("Base ref is invalid.");
  await executor("git", ["worktree", "add", "-b", spec.branch, spec.worktreeRoot, input.baseRef], repositoryRoot);
  return spec;
}

/** The commit a fresh worktree actually started from -- read it back from the worktree itself rather than trusting the caller's baseRef string, since baseRef can be a branch name/HEAD, not a commit id. */
export async function worktreeHeadCommit(worktreeRoot: string, executor: GitExecutor = executeGit): Promise<string> {
  const { stdout } = await executor("git", ["rev-parse", "HEAD"], worktreeRoot);
  return stdout.trim();
}

/** Changed-file status/path pairs between two commits inside a worktree, in the exact shape buildBoundedDiffManifest expects. */
export async function worktreeDiffChanges(worktreeRoot: string, baseCommit: string, headCommit: string, executor: GitExecutor = executeGit): Promise<Array<{ status: DiffChangeStatus; path: string }>> {
  if (baseCommit === headCommit) return [];
  const { stdout } = await executor("git", ["diff", "--name-status", "--no-renames", baseCommit, headCommit], worktreeRoot);
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const [status, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t").trim();
    const normalizedStatus = status.trim().charAt(0) as DiffChangeStatus;
    return path && "AMDRCTU".includes(normalizedStatus) ? [{ status: normalizedStatus, path }] : [];
  });
}

/** Same primitive NodeProcessExecutionHost.cleanup already used privately for the ACP path -- factored out so the resident-CLI path can share it instead of keeping its own copy. */
export async function removeGrantWorktree(repositoryRoot: string, worktreeRoot: string, executor: GitExecutor = executeGit): Promise<void> {
  await executor("git", ["worktree", "remove", "--force", worktreeRoot], resolve(repositoryRoot));
}

/** Same primitive NodeProcessExecutionHost.quarantine already used privately for the ACP path -- moves a worktree aside (still a valid, inspectable git worktree) instead of deleting it, for post-mortem inspection after a crash or timeout. */
export async function quarantineGrantWorktree(repositoryRoot: string, worktreeRoot: string, executor: GitExecutor = executeGit): Promise<string> {
  const quarantinedPath = `${worktreeRoot}.quarantined-${Date.now()}`;
  await executor("git", ["worktree", "move", worktreeRoot, quarantinedPath], resolve(repositoryRoot));
  return quarantinedPath;
}

/** Merges an approved grant's worktree branch into the repository's current branch. Fast-forward only -- a conflicting merge must surface as a failure the resident reports, never attempt automatic conflict resolution against a human-owned working tree. */
export async function mergeGrantWorktree(repositoryRoot: string, branch: string, executor: GitExecutor = executeGit): Promise<void> {
  await executor("git", ["merge", "--ff-only", branch], resolve(repositoryRoot));
}

export function buildBoundedDiffManifest(input: {
  grantId: unknown; baseCommit: string; headCommit: string; allowedPaths: string[]; prohibitedPaths: string[];
  changes: Array<{ status: DiffChangeStatus; path: string }>;
}): BoundedDiffManifest {
  grantId(input.grantId);
  if (!/^[a-f0-9]{40,64}$/i.test(input.baseCommit) || !/^[a-f0-9]{40,64}$/i.test(input.headCommit)) throw new Error("Diff commit is invalid.");
  if (!Array.isArray(input.allowedPaths) || input.allowedPaths.length === 0) throw new Error("Allowed paths are required.");
  if (input.changes.length > 500) throw new Error("Diff manifest exceeds the 500 file limit.");
  const changedFiles = input.changes.map((change) => ({ status: change.status, path: cleanRepoPath(change.path) }));
  const violations: BoundedDiffManifest["violations"] = [];
  for (const { path } of changedFiles) {
    if (input.prohibitedPaths.some((scope) => matchesScope(path, scope))) violations.push({ path, reason: "prohibited_path" });
    else if (!input.allowedPaths.some((scope) => matchesScope(path, scope))) violations.push({ path, reason: "outside_allowed_paths" });
  }
  const canonical = JSON.stringify({ version: "oathlock.diff-manifest.v1", grantId: input.grantId, baseCommit: input.baseCommit, headCommit: input.headCommit, changedFiles, violations });
  return { version: "oathlock.diff-manifest.v1", grantId: input.grantId, baseCommit: input.baseCommit, headCommit: input.headCommit, changedFiles, violations, reviewable: violations.length === 0, digest: createHash("sha256").update(canonical).digest("hex") };
}

export function canEnableWriteMode(input: { manifest: BoundedDiffManifest; approval: { decision: DiffReviewState; manifestDigest: string } | null }): boolean {
  return input.manifest.reviewable && input.approval?.decision === "approved" && input.approval.manifestDigest === input.manifest.digest;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !rel.includes(":") && !rel.startsWith("/") && !rel.startsWith("\\");
}

export function validateWriteIsolation(input: {
  repositoryRoot: unknown;
  worktreeRoot: unknown;
  grantId: unknown;
  diffReviewState: unknown;
}): { ok: boolean; reason: string | null } {
  if (typeof input.repositoryRoot !== "string" || typeof input.worktreeRoot !== "string") return { ok: false, reason: "invalid_root" };
  if (typeof input.grantId !== "string" || !/^[a-zA-Z0-9._:-]{8,100}$/.test(input.grantId)) return { ok: false, reason: "invalid_grant" };
  if (input.diffReviewState !== "pending") return { ok: false, reason: "diff_review_not_pending" };
  const repositoryRoot = resolve(input.repositoryRoot);
  const worktreeRoot = resolve(input.worktreeRoot);
  const worktreeParent = resolve(repositoryRoot, "..", ".oathlock-worktrees");
  if (!inside(worktreeParent, worktreeRoot)) return { ok: false, reason: "worktree_outside_isolation_root" };
  if (!worktreeRoot.endsWith(input.grantId)) return { ok: false, reason: "worktree_not_bound_to_grant" };
  return { ok: true, reason: null };
}
