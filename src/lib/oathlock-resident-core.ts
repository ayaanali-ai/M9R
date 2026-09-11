import { isAbsolute, join, resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { executeProviderLaunch, type ProviderExecutionMode, type WorktreeIsolation } from "@/lib/resident-provider-adapters";
import { worktreeDiffChanges, worktreeHeadCommit, mergeGrantWorktree, removeGrantWorktree } from "@/lib/resident-write-isolation";
import type { AgentModelTier } from "@/lib/agent-task-routing";
import { createResidentActivityWriter, summarizeResidentProviderLine, type ResidentActivityEvent } from "@/lib/resident-activity-journal";
import { humanizeEnumLabel } from "@/lib/format-enum-label";
import { AGENT_KIND_SLUG_PATTERN } from "@/lib/agent-join";
import { parseProviderAdapterConfig, type ProviderAdapterConfig } from "@/lib/provider-adapter-config";

export interface ResidentProfile {
  apiUrl: string;
  token: string;
  provider: string;
  adapter?: ProviderAdapterConfig | null;
  instanceKey: string;
  repositoryBindingId: string;
  repositoryRoot: string;
  capabilities: string[];
  executionMode: ProviderExecutionMode;
  heartbeatSequence: number;
}

export function updateResidentProfileSequence(
  config: unknown,
  profileName: string,
  nextSequence: number,
): { profiles: Array<Record<string, unknown>> } {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Resident config is invalid.");
  const profiles = (config as { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles)) throw new Error("Resident profiles are invalid.");
  let found = false;
  const updated = profiles.map((profile) => {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return profile as Record<string, unknown>;
    const row = profile as Record<string, unknown>;
    if (row.name !== profileName) return { ...row };
    found = true;
    const currentSequence = Number.isSafeInteger(row.heartbeatSequence) ? Number(row.heartbeatSequence) : 0;
    if (!Number.isSafeInteger(nextSequence) || nextSequence <= currentSequence) {
      throw new Error("Resident heartbeat sequence must advance monotonically.");
    }
    return { ...row, heartbeatSequence: nextSequence };
  });
  if (!found) throw new Error(`Resident profile ${profileName} was not found.`);
  return { ...(config as Record<string, unknown>), profiles: updated } as { profiles: Array<Record<string, unknown>> };
}

export function validateResidentProfile(input: unknown): { ok: boolean; reason: string | null; profile: ResidentProfile | null } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "invalid_profile", profile: null };
  const row = input as Record<string, unknown>;
  const apiUrl = typeof row.apiUrl === "string" ? row.apiUrl.trim().replace(/\/+$/, "") : "";
  const token = typeof row.token === "string" ? row.token.trim() : "";
  const provider = typeof row.provider === "string" && AGENT_KIND_SLUG_PATTERN.test(row.provider) ? row.provider : null;
  const adapterValidation = row.adapter === undefined || row.adapter === null
    ? { ok: true as const, value: null }
    : parseProviderAdapterConfig(row.adapter, provider ?? "invalid");
  const instanceKey = typeof row.instanceKey === "string" ? row.instanceKey.trim() : "";
  const repositoryBindingId = typeof row.repositoryBindingId === "string" ? row.repositoryBindingId.trim() : "";
  const repositoryRoot = typeof row.repositoryRoot === "string" ? row.repositoryRoot.trim() : "";
  const executionMode = row.executionMode === "read_only" || row.executionMode === "workspace_write" ? row.executionMode : null;
  const heartbeatSequence = Number.isSafeInteger(row.heartbeatSequence) && Number(row.heartbeatSequence) >= 0 ? Number(row.heartbeatSequence) : 0;
  if (!/^https:\/\//.test(apiUrl) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(apiUrl)) return { ok: false, reason: "invalid_api_url", profile: null };
  if (token.length < 16 || token.length > 500) return { ok: false, reason: "invalid_token", profile: null };
  if (!provider || !/^[a-zA-Z0-9._:-]{8,100}$/.test(instanceKey) || !/^[a-zA-Z0-9._:-]{8,100}$/.test(repositoryBindingId)) return { ok: false, reason: "invalid_binding", profile: null };
  if (!adapterValidation.ok) return { ok: false, reason: `invalid_adapter_${adapterValidation.error.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`, profile: null };
  if (!repositoryRoot || !isAbsolute(repositoryRoot)) return { ok: false, reason: "repository_root_must_be_absolute", profile: null };
  // workspace_write used to be refused outright here (reason
  // "workspace_write_requires_isolation") because nothing enforced real
  // isolation for a resident-launched process -- executeProviderLaunch now
  // runs workspace_write grants inside a disposable, grant-bound git
  // worktree (resident-write-isolation.ts's createGrantWorktree, the same
  // primitive the ACP/Mission execution path already used), and
  // reconcilePendingWorktrees below only ever merges into the real
  // repository after a human approves the reported diff. Read-only mode is
  // unaffected either way.
  if (!Array.isArray(row.capabilities) || row.capabilities.length > 25) return { ok: false, reason: "invalid_capabilities", profile: null };
  const capabilities = row.capabilities.map((value) => typeof value === "string" ? value.trim() : "");
  if (capabilities.some((value) => !value || value.length > 100) || !executionMode) return { ok: false, reason: "invalid_capabilities", profile: null };
  return { ok: true, reason: null, profile: { apiUrl, token, provider, ...(adapterValidation.value ? { adapter: adapterValidation.value } : {}), instanceKey, repositoryBindingId, repositoryRoot: resolve(repositoryRoot), capabilities: [...new Set(capabilities)], executionMode, heartbeatSequence } };
}

type ExecuteLaunch = typeof executeProviderLaunch;

const RESIDENT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * A workspace_write grant's worktree stays pending across resident cycles
 * until a human decides its reported diff review -- runResidentCycle must
 * never block waiting for that decision (it could take arbitrarily long and
 * would freeze this resident's heartbeat/claim loop for every other grant in
 * the meantime). Persisted per-repository, same convention as
 * .oathlock/resident.local.json, so a resident restart doesn't orphan a
 * worktree whose review is still outstanding.
 */
export interface PendingWorktree {
  grantId: string;
  instanceKey: string;
  worktreeRoot: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
}

// Deliberately simple aliases, not `typeof readFile`/`writeFile`/`mkdir` --
// node:fs/promises' real overloaded signatures are needlessly painful for
// tests to mock. These cover exactly the one call shape used below.
type ReadFileFn = (path: string, encoding: "utf8") => Promise<string>;
type WriteFileFn = (path: string, data: string, encoding: "utf8") => Promise<void>;
type MkdirFn = (path: string, options: { recursive: true }) => Promise<unknown>;

function pendingWorktreesPath(repositoryRoot: string): string {
  return join(repositoryRoot, ".oathlock", "resident-worktrees.local.json");
}

export async function readPendingWorktrees(repositoryRoot: string, readFileFn: ReadFileFn = readFile): Promise<PendingWorktree[]> {
  try {
    const raw = await readFileFn(pendingWorktreesPath(repositoryRoot), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is PendingWorktree =>
      Boolean(entry) && typeof entry === "object" && typeof (entry as PendingWorktree).grantId === "string" && typeof (entry as PendingWorktree).worktreeRoot === "string") : [];
  } catch {
    return [];
  }
}

export async function writePendingWorktrees(repositoryRoot: string, entries: PendingWorktree[], writeFileFn: WriteFileFn = writeFile, mkdirFn: MkdirFn = mkdir): Promise<void> {
  await mkdirFn(join(repositoryRoot, ".oathlock"), { recursive: true });
  await writeFileFn(pendingWorktreesPath(repositoryRoot), `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

/**
 * Runs once per resident cycle, before claiming new grants. For every
 * worktree still pending from an earlier cycle: merge it into the real
 * repository if a human approved the exact reported diff
 * (canEnableWriteMode's own digest-match logic is mirrored server-side by
 * getResidentDiffReview's writeEnabled), discard it if rejected, or leave it
 * alone if the decision is still pending. Errors on one entry never block
 * reconciling the rest -- a stuck review must not starve every other grant.
 */
export async function reconcilePendingWorktrees(
  profile: ResidentProfile,
  deps: {
    fetch?: typeof fetch;
    mergeWorktree?: typeof mergeGrantWorktree;
    removeWorktree?: typeof removeGrantWorktree;
    readFileFn?: ReadFileFn;
    writeFileFn?: WriteFileFn;
    mkdirFn?: MkdirFn;
  } = {},
): Promise<{ merged: number; discarded: number; stillPending: number }> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const pending = await readPendingWorktrees(profile.repositoryRoot, deps.readFileFn);
  if (pending.length === 0) return { merged: 0, discarded: 0, stillPending: 0 };
  const remaining: PendingWorktree[] = [];
  let merged = 0, discarded = 0;
  for (const entry of pending) {
    try {
      const review = await request(fetchFn, profile, `/api/agent/resident/grants/${encodeURIComponent(entry.grantId)}/diff-review?instance_key=${encodeURIComponent(entry.instanceKey)}`);
      if (review.writeEnabled === true) {
        await (deps.mergeWorktree ?? mergeGrantWorktree)(profile.repositoryRoot, entry.branch);
        await (deps.removeWorktree ?? removeGrantWorktree)(profile.repositoryRoot, entry.worktreeRoot);
        merged++;
        continue;
      }
      const decision = (review.review as { decision?: string } | null)?.decision;
      if (decision === "rejected") {
        await (deps.removeWorktree ?? removeGrantWorktree)(profile.repositoryRoot, entry.worktreeRoot);
        discarded++;
        continue;
      }
      remaining.push(entry);
    } catch (error) {
      console.error(`[resident] could not reconcile pending worktree for grant ${entry.grantId}:`, error instanceof Error ? error.message : error);
      remaining.push(entry);
    }
  }
  await writePendingWorktrees(profile.repositoryRoot, remaining, deps.writeFileFn, deps.mkdirFn);
  return { merged, discarded, stillPending: remaining.length };
}

/**
 * Computes and reports a workspace_write grant's diff after a successful
 * run, then tracks its worktree as pending until reconcilePendingWorktrees
 * later merges or discards it. Never merges here -- reporting the diff and
 * deciding it are always separate acts. allowedPaths/prohibitedPaths are not
 * sent -- upsertResidentDiffManifest reads those from the grant's own row,
 * never from the reporting request, so a resident cannot widen its own scope
 * by lying about them here.
 */
async function reportWorktreeDiff(
  fetchFn: typeof fetch,
  profile: ResidentProfile,
  grantId: string,
  instanceKey: string,
  worktree: WorktreeIsolation,
  deps: { readFileFn?: ReadFileFn; writeFileFn?: WriteFileFn; mkdirFn?: MkdirFn; worktreeHeadFn?: typeof worktreeHeadCommit; worktreeDiffFn?: typeof worktreeDiffChanges } = {},
): Promise<void> {
  const headCommit = await (deps.worktreeHeadFn ?? worktreeHeadCommit)(worktree.worktreeRoot);
  const changes = await (deps.worktreeDiffFn ?? worktreeDiffChanges)(worktree.worktreeRoot, worktree.baseCommit, headCommit);
  await request(fetchFn, profile, `/api/agent/resident/grants/${encodeURIComponent(grantId)}/diff-review`, {
    method: "POST",
    body: JSON.stringify({ instanceKey, baseCommit: worktree.baseCommit, headCommit, changes }),
  });
  const pending = await readPendingWorktrees(profile.repositoryRoot, deps.readFileFn);
  await writePendingWorktrees(profile.repositoryRoot, [
    ...pending.filter((entry) => entry.grantId !== grantId),
    { grantId, instanceKey, worktreeRoot: worktree.worktreeRoot, branch: worktree.branch, baseCommit: worktree.baseCommit, headCommit },
  ], deps.writeFileFn, deps.mkdirFn);
}

async function request(fetchFn: typeof fetch, profile: ResidentProfile, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchFn(`${profile.apiUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${profile.token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* body stays opaque */ }
  if (!response.ok) throw new Error(`M9R resident request failed with HTTP ${response.status}.`);
  return body;
}

export async function runResidentCycle(profileInput: ResidentProfile | Omit<ResidentProfile, "heartbeatSequence">, deps: {
  fetch?: typeof fetch;
  executeLaunch?: ExecuteLaunch;
  signal?: AbortSignal;
  activityWriter?: ReturnType<typeof createResidentActivityWriter>;
  heartbeatIntervalMs?: number;
  mergeWorktree?: typeof mergeGrantWorktree;
  removeWorktree?: typeof removeGrantWorktree;
  worktreeHeadFn?: typeof worktreeHeadCommit;
  worktreeDiffFn?: typeof worktreeDiffChanges;
  readFileFn?: ReadFileFn;
  writeFileFn?: WriteFileFn;
  mkdirFn?: MkdirFn;
} = {}): Promise<{ claimed: number; returned: number; failed: number; heartbeatSequence: number }> {
  const checked = validateResidentProfile(profileInput);
  if (!checked.ok || !checked.profile) throw new Error(`Invalid resident profile: ${checked.reason}.`);
  const profile = checked.profile;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const executeLaunch = deps.executeLaunch ?? executeProviderLaunch;
  const registration = await request(fetchFn, profile, "/api/agent/resident/register", { method: "POST", body: JSON.stringify({
    protocolVersion: "oathlock.resident-launch.v1", instanceKey: profile.instanceKey,
    provider: profile.provider, capabilities: profile.capabilities,
  }) });
  const serverSequence = Number(registration.heartbeatSequence);
  let heartbeatSequence = Math.max(
    profile.heartbeatSequence,
    Number.isSafeInteger(serverSequence) && serverSequence >= 0 ? serverSequence : 0,
  ) + 1;
  await request(fetchFn, profile, "/api/agent/resident/heartbeat", { method: "POST", body: JSON.stringify({ instanceKey: profile.instanceKey, sequence: heartbeatSequence }) });
  // Reconcile any workspace_write worktrees left pending from an earlier
  // cycle BEFORE claiming new grants -- a human may have decided one while
  // this resident was between polls, and a merge must land before this
  // cycle's own work continues, not after.
  await reconcilePendingWorktrees(profile, {
    fetch: fetchFn,
    mergeWorktree: deps.mergeWorktree,
    removeWorktree: deps.removeWorktree,
    readFileFn: deps.readFileFn,
    writeFileFn: deps.writeFileFn,
    mkdirFn: deps.mkdirFn,
  });
  const queue = await request(fetchFn, profile, `/api/agent/resident/grants?instance_key=${encodeURIComponent(profile.instanceKey)}`);
  const grants = Array.isArray(queue.grants) ? queue.grants.filter((grant): grant is Record<string, unknown> => Boolean(grant) && typeof grant === "object" && !Array.isArray(grant)) : [];
  let claimed = 0, returned = 0, failed = 0;
  for (const grant of grants) {
    if (grant.provider !== profile.provider || grant.repository_binding_id !== profile.repositoryBindingId || typeof grant.id !== "string") continue;
    const claim = await request(fetchFn, profile, `/api/agent/resident/grants/${encodeURIComponent(grant.id)}/claim`, { method: "POST", body: JSON.stringify({ instanceKey: profile.instanceKey }) });
    const claimSequence = Number(claim.sequence);
    if (!Number.isSafeInteger(claimSequence) || claimSequence < 1) throw new Error("M9R returned an invalid claim sequence.");
    claimed++;
    const modelTier = grant.model_tier === "economy" || grant.model_tier === "balanced" || grant.model_tier === "frontier"
      ? grant.model_tier as AgentModelTier : undefined;
    const activity = deps.activityWriter ?? createResidentActivityWriter(profile.repositoryRoot);
    let activitySequence = 1;
    const publishActivity = (event: Omit<ResidentActivityEvent, "protocolVersion" | "grantId" | "provider" | "occurredAt" | "sequence">) => {
      activity.publish({
        protocolVersion: "oathlock.resident-activity.v1",
        grantId: grant.id as string,
        provider: profile.provider,
        occurredAt: new Date().toISOString(),
        sequence: activitySequence++,
        ...event,
      });
    };
    publishActivity({ kind: "started", stream: "system", data: `Bounded ${profile.provider} assignment started.\r\n` });
    const activityRemainders: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
    const observeOutput = (stream: "stdout" | "stderr", data: string) => {
      const lines = `${activityRemainders[stream]}${data}`.split(/\r?\n/);
      activityRemainders[stream] = lines.pop() ?? "";
      for (const line of lines) {
        const summary = summarizeResidentProviderLine(profile.provider, stream, line);
        if (summary) publishActivity({ kind: "output", stream, data: summary });
      }
    };
    const heartbeatTimer = setInterval(() => {
      heartbeatSequence += 1;
      void request(fetchFn, profile, "/api/agent/resident/heartbeat", {
        method: "POST",
        body: JSON.stringify({ instanceKey: profile.instanceKey, sequence: heartbeatSequence }),
      }).catch(() => {
        // The provider result remains authoritative for this bounded launch.
        // A failed refresh will make the lease expire naturally and the next
        // cycle will re-register instead of hiding a liveness failure.
      });
    }, deps.heartbeatIntervalMs ?? RESIDENT_HEARTBEAT_INTERVAL_MS);
    let outcome: Awaited<ReturnType<ExecuteLaunch>>;
    try {
      outcome = await executeLaunch({
        provider: profile.provider,
        adapter: profile.adapter,
        firstSequence: claimSequence + 1,
        signal: deps.signal,
        grant: {
          grantId: grant.id,
          repositoryRoot: profile.repositoryRoot,
          task: typeof grant.task === "string" ? grant.task : "",
          allowedPaths: Array.isArray(grant.allowed_paths) ? grant.allowed_paths as string[] : [],
          prohibitedPaths: Array.isArray(grant.prohibited_paths) ? grant.prohibited_paths as string[] : [],
          maxDurationMs: Number(grant.max_duration_ms),
          maxEstimatedTokens: grant.max_estimated_tokens == null ? null : Number(grant.max_estimated_tokens),
          ...(modelTier ? { modelTier } : {}),
          executionMode: profile.executionMode,
        },
      }, {
        recordEvent: async (event) => {
          await request(fetchFn, profile, `/api/agent/resident/grants/${encodeURIComponent(grant.id as string)}/events`, { method: "POST", body: JSON.stringify({ instanceKey: profile.instanceKey, ...event }) });
        },
        observeOutput,
      });
    } finally {
      clearInterval(heartbeatTimer);
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const summary = summarizeResidentProviderLine(profile.provider, stream, activityRemainders[stream]);
      if (summary) publishActivity({ kind: "output", stream, data: summary });
    }
    if (outcome.result?.resultText) {
      publishActivity({ kind: "output", stream: "system", data: `\r\n${outcome.result.resultText}\r\n` });
    }
    if (outcome.status === "returned" && outcome.worktree) {
      try {
        await reportWorktreeDiff(fetchFn, profile, grant.id as string, profile.instanceKey, outcome.worktree, {
          readFileFn: deps.readFileFn,
          writeFileFn: deps.writeFileFn,
          mkdirFn: deps.mkdirFn,
          worktreeHeadFn: deps.worktreeHeadFn,
          worktreeDiffFn: deps.worktreeDiffFn,
        });
        publishActivity({ kind: "output", stream: "system", data: "\r\nChanges are isolated in a worktree pending human review before they reach the real repository.\r\n" });
      } catch (error) {
        // The provider result itself already succeeded and was recorded --
        // a failure to report the diff must not be mistaken for the launch
        // having failed. The worktree stays out of pending-worktree tracking
        // in this case, so it will neither auto-merge nor silently vanish;
        // it needs a human/operator to notice and investigate.
        console.error(`[resident] could not report worktree diff for grant ${grant.id}:`, error instanceof Error ? error.message : error);
        publishActivity({ kind: "output", stream: "system", data: "\r\nCould not report the changed-file diff for review -- changes remain isolated in the worktree, untracked.\r\n" });
      }
    }
    publishActivity({
      kind: outcome.status === "returned" ? "completed" : outcome.status === "cancelled" ? "cancelled" : "failed",
      stream: "system",
      data: `\r\nM9R assignment ${humanizeEnumLabel(outcome.status)}.\r\n`,
      status: outcome.status,
    });
    await activity.flush();
    if (outcome.status === "returned") returned++; else failed++;
  }
  return { claimed, returned, failed, heartbeatSequence };
}
