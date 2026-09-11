import { AGENT_KIND_SLUG_PATTERN, containsActiveContent } from "@/lib/agent-join";
import { looksLikeSourceCode, SECRET_PATTERNS } from "@/lib/agent-run-core";

export const RESIDENT_LAUNCH_PROTOCOL_VERSION = "oathlock.resident-launch.v1" as const;

export const RESIDENT_PROVIDERS = ["codex", "claude-code", "grok-build", "other"] as const;
/** Known providers are useful for ordering/copy, but never an admission allowlist. */
export type ResidentProvider = string;

export const LAUNCH_STATES = [
  "requested",
  "policy_pending",
  "authorized",
  "queued",
  "claimed",
  "launching",
  "running",
  "returning",
  "completed",
  "rejected",
  "expired",
  "cancelled",
  "launch_failed",
  "timed_out",
  "provider_failed",
  "evidence_rejected",
] as const;
export type LaunchState = (typeof LAUNCH_STATES)[number];

export type LaunchEvent =
  | "require_policy"
  | "authorize"
  | "reject"
  | "queue"
  | "claim"
  | "launch"
  | "acknowledge_process"
  | "return_result"
  | "accept_evidence"
  | "reject_evidence"
  | "cancel"
  | "expire"
  | "fail_launch"
  | "fail_provider"
  | "timeout";

export type ResidentDisplayState = "offline" | "sleeping" | "awakening" | "working" | "returning" | "failed";
export type LaunchApprovalPolicy = "human_before_start" | "preauthorized_bounded";

export interface LaunchGrantInput {
  assignmentId: unknown;
  workspaceId: unknown;
  requestingConnectionId: unknown;
  targetConnectionId: unknown;
  residentInstanceId: unknown;
  provider: unknown;
  repository: unknown;
  repositoryBindingId: unknown;
  task: unknown;
  requiredCapabilities: unknown;
  allowedPaths: unknown;
  prohibitedPaths?: unknown;
  maxDurationMs: unknown;
  maxEstimatedTokens?: unknown;
  delegationDepth: unknown;
  approvalPolicy: unknown;
  issuedAt: unknown;
  expiresAt: unknown;
  idempotencyKey: unknown;
  claimTokenHash: unknown;
}

export interface ValidatedLaunchGrant {
  protocolVersion: typeof RESIDENT_LAUNCH_PROTOCOL_VERSION;
  assignmentId: string;
  workspaceId: string;
  requestingConnectionId: string;
  targetConnectionId: string;
  residentInstanceId: string;
  provider: ResidentProvider;
  repository: string;
  repositoryBindingId: string;
  task: string;
  requiredCapabilities: string[];
  allowedPaths: string[];
  prohibitedPaths: string[];
  maxDurationMs: number;
  maxEstimatedTokens: number | null;
  delegationDepth: 0 | 1;
  approvalPolicy: LaunchApprovalPolicy;
  issuedAt: string;
  expiresAt: string;
  idempotencyKey: string;
  claimTokenHash: string;
  state: "requested";
}

const TRANSITIONS: Record<LaunchState, Partial<Record<LaunchEvent, LaunchState>>> = {
  requested: { require_policy: "policy_pending", authorize: "authorized", reject: "rejected", cancel: "cancelled", expire: "expired" },
  policy_pending: { authorize: "authorized", reject: "rejected", cancel: "cancelled", expire: "expired" },
  authorized: { queue: "queued", cancel: "cancelled", expire: "expired" },
  queued: { claim: "claimed", cancel: "cancelled", expire: "expired" },
  claimed: { launch: "launching", cancel: "cancelled", expire: "expired", timeout: "timed_out" },
  launching: { acknowledge_process: "running", fail_launch: "launch_failed", cancel: "cancelled", timeout: "timed_out" },
  running: { return_result: "returning", fail_provider: "provider_failed", cancel: "cancelled", timeout: "timed_out" },
  returning: { accept_evidence: "completed", reject_evidence: "evidence_rejected", fail_provider: "provider_failed", cancel: "cancelled", timeout: "timed_out" },
  completed: {},
  rejected: {},
  expired: {},
  cancelled: {},
  launch_failed: {},
  timed_out: {},
  provider_failed: {},
  evidence_rejected: {},
};

function boundedString(value: unknown, max: number, min = 1): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length >= min && normalized.length <= max ? normalized : null;
}

function boundedList(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const normalized = value.map((item) => boundedString(item, maxLength));
  return normalized.every((item): item is string => item !== null) ? [...new Set(normalized)] : null;
}

function containsUnsafeContent(values: string[]): boolean {
  return values.some((value) => {
    if (containsActiveContent(value) || looksLikeSourceCode(value)) return true;
    return SECRET_PATTERNS.some(([pattern]) => {
      const matches = pattern.test(value);
      pattern.lastIndex = 0;
      return matches;
    });
  });
}

function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

export function validateLaunchGrant(
  input: LaunchGrantInput,
  nowMs = Date.now(),
): { ok: boolean; errors: string[]; grant: ValidatedLaunchGrant | null } {
  const errors: string[] = [];
  const assignmentId = boundedString(input.assignmentId, 100, 8);
  const workspaceId = boundedString(input.workspaceId, 100, 8);
  const requestingConnectionId = boundedString(input.requestingConnectionId, 100, 8);
  const targetConnectionId = boundedString(input.targetConnectionId, 100, 8);
  const residentInstanceId = boundedString(input.residentInstanceId, 100, 8);
  const provider = typeof input.provider === "string" && AGENT_KIND_SLUG_PATTERN.test(input.provider)
    ? input.provider
    : null;
  const repository = boundedString(input.repository, 300);
  const repositoryBindingId = boundedString(input.repositoryBindingId, 100, 8);
  const task = boundedString(input.task, 1_000);
  const requiredCapabilities = boundedList(input.requiredCapabilities, 25, 100);
  const allowedPaths = boundedList(input.allowedPaths, 100, 500);
  const prohibitedPaths = input.prohibitedPaths === undefined ? [] : boundedList(input.prohibitedPaths, 100, 500);
  const maxDurationMs = typeof input.maxDurationMs === "number" && Number.isSafeInteger(input.maxDurationMs)
    && input.maxDurationMs > 0 && input.maxDurationMs <= 24 * 60 * 60_000 ? input.maxDurationMs : null;
  const maxEstimatedTokens = input.maxEstimatedTokens == null ? null
    : typeof input.maxEstimatedTokens === "number" && Number.isSafeInteger(input.maxEstimatedTokens)
      && input.maxEstimatedTokens > 0 && input.maxEstimatedTokens <= 1_000_000 ? input.maxEstimatedTokens : null;
  const delegationDepth = input.delegationDepth === 0 || input.delegationDepth === 1 ? input.delegationDepth : null;
  const approvalPolicy = input.approvalPolicy === "human_before_start" || input.approvalPolicy === "preauthorized_bounded"
    ? input.approvalPolicy
    : null;
  const issuedMs = timestamp(input.issuedAt);
  const expiresMs = timestamp(input.expiresAt);
  const idempotencyKey = boundedString(input.idempotencyKey, 200, 8);
  const claimTokenHash = typeof input.claimTokenHash === "string" && /^[a-f0-9]{64}$/i.test(input.claimTokenHash)
    ? input.claimTokenHash.toLowerCase()
    : null;

  if (!assignmentId) errors.push("assignmentId is required and bounded.");
  if (!workspaceId) errors.push("workspaceId is required and bounded.");
  if (!requestingConnectionId) errors.push("requestingConnectionId is required and bounded.");
  if (!targetConnectionId) errors.push("targetConnectionId is required and bounded.");
  if (!residentInstanceId) errors.push("residentInstanceId is required and bounded.");
  if (!provider) errors.push("provider is unsupported.");
  if (!repository || !repositoryBindingId) errors.push("repository and repositoryBindingId are required and bounded.");
  if (!task) errors.push("task is required and bounded.");
  if (!requiredCapabilities) errors.push("requiredCapabilities must be a bounded list.");
  if (!allowedPaths || allowedPaths.length === 0) errors.push("allowedPaths must be a non-empty bounded list.");
  if (!prohibitedPaths) errors.push("prohibitedPaths must be a bounded list.");
  if (!maxDurationMs) errors.push("maxDurationMs must be between 1ms and 24h.");
  if (input.maxEstimatedTokens != null && maxEstimatedTokens === null) errors.push("maxEstimatedTokens is invalid.");
  if (delegationDepth === null) errors.push("delegationDepth must be 0 or 1.");
  if (!approvalPolicy) errors.push("approvalPolicy is invalid.");
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs <= nowMs || expiresMs <= issuedMs) {
    errors.push("launch grant timestamps must be ordered and unexpired.");
  }
  if (Number.isFinite(issuedMs) && issuedMs > nowMs + 5_000) errors.push("issuedAt cannot be in the future.");
  if (Number.isFinite(issuedMs) && Number.isFinite(expiresMs) && expiresMs - issuedMs > 15 * 60_000) {
    errors.push("launch grants may remain claimable for at most 15 minutes.");
  }
  if (!idempotencyKey) errors.push("idempotencyKey is required and bounded.");
  if (!claimTokenHash) errors.push("claimTokenHash must be a SHA-256 hex digest, never a raw credential.");

  const content = [repository, repositoryBindingId, task, ...(requiredCapabilities ?? []), ...(allowedPaths ?? [])]
    .filter((value): value is string => Boolean(value));
  if (containsUnsafeContent(content)) errors.push("launch grant contains unsafe or secret-shaped content.");
  if ((prohibitedPaths ?? []).some((value) => containsActiveContent(value) || looksLikeSourceCode(value))) {
    errors.push("prohibitedPaths contains active or source-code content.");
  }

  if (errors.length || !assignmentId || !workspaceId || !requestingConnectionId || !targetConnectionId
    || !residentInstanceId || !provider || !repository || !repositoryBindingId || !task || !requiredCapabilities
    || !allowedPaths || !prohibitedPaths || !maxDurationMs || delegationDepth === null || !approvalPolicy
    || !idempotencyKey || !claimTokenHash) {
    return { ok: false, errors, grant: null };
  }

  return {
    ok: true,
    errors: [],
    grant: {
      protocolVersion: RESIDENT_LAUNCH_PROTOCOL_VERSION,
      assignmentId,
      workspaceId,
      requestingConnectionId,
      targetConnectionId,
      residentInstanceId,
      provider,
      repository,
      repositoryBindingId,
      task,
      requiredCapabilities,
      allowedPaths,
      prohibitedPaths,
      maxDurationMs,
      maxEstimatedTokens,
      delegationDepth,
      approvalPolicy,
      issuedAt: new Date(issuedMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      idempotencyKey,
      claimTokenHash,
      state: "requested",
    },
  };
}

export function applyLaunchEvent(state: LaunchState, event: LaunchEvent): { ok: boolean; state: LaunchState; reason: string | null } {
  const next = TRANSITIONS[state]?.[event];
  return next
    ? { ok: true, state: next, reason: null }
    : { ok: false, state, reason: `Cannot apply ${event} to a launch in ${state}.` };
}

export type LaunchClaimFailure =
  | "invalid_time"
  | "grant_expired"
  | "already_claimed"
  | "authorization_revoked"
  | "wrong_resident"
  | "wrong_connection"
  | "wrong_provider"
  | "resident_offline";

export function checkLaunchClaim(input: {
  nowMs?: number;
  expiresAt: string;
  expectedResidentInstanceId: string;
  claimingResidentInstanceId: string;
  expectedTargetConnectionId: string;
  claimingTargetConnectionId: string;
  expectedProvider: ResidentProvider;
  claimingProvider: ResidentProvider;
  residentLeaseExpiresAt: string;
  authorizationActive: boolean;
  claimedAt: string | null;
}): { ok: boolean; reason: LaunchClaimFailure | null } {
  const nowMs = input.nowMs ?? Date.now();
  const expiresMs = Date.parse(input.expiresAt);
  const leaseExpiresMs = Date.parse(input.residentLeaseExpiresAt);
  if (![nowMs, expiresMs, leaseExpiresMs].every(Number.isFinite)) return { ok: false, reason: "invalid_time" };
  if (nowMs >= expiresMs) return { ok: false, reason: "grant_expired" };
  if (input.claimedAt !== null) return { ok: false, reason: "already_claimed" };
  if (!input.authorizationActive) return { ok: false, reason: "authorization_revoked" };
  if (input.claimingResidentInstanceId !== input.expectedResidentInstanceId) return { ok: false, reason: "wrong_resident" };
  if (input.claimingTargetConnectionId !== input.expectedTargetConnectionId) return { ok: false, reason: "wrong_connection" };
  if (input.claimingProvider !== input.expectedProvider) return { ok: false, reason: "wrong_provider" };
  if (leaseExpiresMs <= nowMs) return { ok: false, reason: "resident_offline" };
  return { ok: true, reason: null };
}

const FAILED_STATES = new Set<LaunchState>(["launch_failed", "timed_out", "provider_failed", "evidence_rejected"]);

/** UI state is a projection of authenticated retained state; it never advances a launch. */
export function displayStateForLaunch(state: LaunchState | null, residentLeaseActive: boolean): ResidentDisplayState {
  if (!residentLeaseActive) return "offline";
  if (state === "claimed" || state === "launching") return "awakening";
  if (state === "running") return "working";
  if (state === "returning") return "returning";
  if (state && FAILED_STATES.has(state)) return "failed";
  return "sleeping";
}
