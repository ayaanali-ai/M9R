import { containsActiveContent } from "@/lib/agent-join";
import { looksLikeSourceCode, SECRET_PATTERNS } from "@/lib/agent-run-core";

export const ASSIGNMENT_VERSION = "m9r.assignment.v1" as const;
export const ASSIGNMENT_STATES = ["requested", "accepted", "rejected", "cancelled", "expired", "completed"] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];
export type AssignmentDecision = "accept" | "reject" | "cancel" | "expire" | "complete";
export type ApprovalPolicy = "human_before_material_action" | "human_before_start" | "preauthorized_bounded";

export interface AssignmentInput {
  repository: unknown;
  task: unknown;
  scope: unknown;
  prohibitedScope?: unknown;
  maxDurationMs: unknown;
  maxEstimatedTokens?: unknown;
  approvalPolicy: unknown;
  evidenceRequired: unknown;
  expiresAt: unknown;
}

export interface ValidatedAssignment {
  version: typeof ASSIGNMENT_VERSION;
  repository: string;
  task: string;
  scope: string[];
  prohibitedScope: string[];
  maxDurationMs: number;
  maxEstimatedTokens: number | null;
  approvalPolicy: ApprovalPolicy;
  evidenceRequired: boolean;
  expiresAt: string;
  state: "requested";
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= max ? text : null;
}

function list(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const normalized = value.map((item) => bounded(item, 300));
  return normalized.every((item): item is string => Boolean(item)) ? normalized : null;
}

function unsafe(values: string[]): boolean {
  return values.some((value) => {
    if (containsActiveContent(value) || looksLikeSourceCode(value)) return true;
    return SECRET_PATTERNS.some(([pattern]) => {
      const matched = pattern.test(value);
      pattern.lastIndex = 0;
      return matched;
    });
  });
}

function containsExecutableContent(values: string[]): boolean {
  return values.some((value) => containsActiveContent(value) || looksLikeSourceCode(value));
}

export function validateAssignment(input: AssignmentInput, nowMs = Date.now()): { ok: boolean; errors: string[]; assignment: ValidatedAssignment | null } {
  const errors: string[] = [];
  const repository = bounded(input.repository, 300);
  const task = bounded(input.task, 500);
  const scope = list(input.scope);
  const prohibitedScope = input.prohibitedScope === undefined ? [] : list(input.prohibitedScope);
  const duration = typeof input.maxDurationMs === "number" && Number.isSafeInteger(input.maxDurationMs) && input.maxDurationMs > 0 && input.maxDurationMs <= 24 * 60 * 60_000 ? input.maxDurationMs : null;
  const tokens = input.maxEstimatedTokens == null ? null : typeof input.maxEstimatedTokens === "number" && Number.isSafeInteger(input.maxEstimatedTokens) && input.maxEstimatedTokens > 0 && input.maxEstimatedTokens <= 1_000_000 ? input.maxEstimatedTokens : null;
  const policies: ApprovalPolicy[] = ["human_before_material_action", "human_before_start", "preauthorized_bounded"];
  const approvalPolicy = typeof input.approvalPolicy === "string" && policies.includes(input.approvalPolicy as ApprovalPolicy) ? input.approvalPolicy as ApprovalPolicy : null;
  const expiryMs = typeof input.expiresAt === "string" ? Date.parse(input.expiresAt) : NaN;
  if (!repository) errors.push("repository is required and bounded.");
  if (!task) errors.push("task is required and bounded.");
  if (!scope) errors.push("scope must be a bounded list.");
  if (!prohibitedScope) errors.push("prohibitedScope must be a bounded list.");
  if (!duration) errors.push("maxDurationMs must be between 1ms and 24h.");
  if (input.maxEstimatedTokens != null && tokens == null) errors.push("maxEstimatedTokens is invalid.");
  if (!approvalPolicy) errors.push("approvalPolicy is invalid.");
  if (typeof input.evidenceRequired !== "boolean") errors.push("evidenceRequired must be boolean.");
  if (!Number.isFinite(expiryMs) || expiryMs <= nowMs) errors.push("expiresAt must be in the future.");
  const allowedText = [repository, task, ...(scope ?? [])].filter((v): v is string => Boolean(v));
  if (unsafe(allowedText) || containsExecutableContent(prohibitedScope ?? [])) errors.push("assignment contains unsafe content.");
  if (errors.length || !repository || !task || !scope || !prohibitedScope || !duration || !approvalPolicy) return { ok: false, errors, assignment: null };
  return { ok: true, errors: [], assignment: { version: ASSIGNMENT_VERSION, repository, task, scope, prohibitedScope, maxDurationMs: duration, maxEstimatedTokens: tokens, approvalPolicy, evidenceRequired: input.evidenceRequired as boolean, expiresAt: new Date(expiryMs).toISOString(), state: "requested" } };
}

const TRANSITIONS: Record<AssignmentState, Partial<Record<AssignmentDecision, AssignmentState>>> = {
  requested: { accept: "accepted", reject: "rejected", cancel: "cancelled", expire: "expired" },
  accepted: { cancel: "cancelled", expire: "expired", complete: "completed" },
  rejected: {}, cancelled: {}, expired: {}, completed: {},
};

export function applyAssignmentDecision(state: AssignmentState, decision: AssignmentDecision): { ok: boolean; state: AssignmentState; reason: string | null } {
  const next = TRANSITIONS[state]?.[decision];
  return next ? { ok: true, state: next, reason: null } : { ok: false, state, reason: `Cannot ${decision} an assignment in ${state}.` };
}

export function checkAssignmentRuntimeConstraints(input: {
  decision: AssignmentDecision;
  expiresAt: string;
  acceptedAt: string | null;
  maxDurationMs: number;
  nowMs?: number;
}): { ok: boolean; reason: "expired" | "duration_exceeded" | "invalid_time" | null } {
  const nowMs = input.nowMs ?? Date.now();
  const expiresMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs)) return { ok: false, reason: "invalid_time" };
  if (nowMs >= expiresMs) return { ok: false, reason: "expired" };
  if (input.decision === "complete") {
    const acceptedMs = input.acceptedAt ? Date.parse(input.acceptedAt) : NaN;
    if (!Number.isFinite(acceptedMs) || !Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs < 1) {
      return { ok: false, reason: "invalid_time" };
    }
    if (nowMs - acceptedMs > input.maxDurationMs) return { ok: false, reason: "duration_exceeded" };
  }
  return { ok: true, reason: null };
}

export type AssignmentCompletionLinkageFailure =
  | "invalid_time"
  | "evidence_run_mismatch"
  | "run_predates_acceptance"
  | "evidence_predates_acceptance";

export function checkAssignmentCompletionLinkage(input: {
  acceptedAt: string | null;
  runId: string;
  runStartedAt: string | null;
  evidenceRunId: string | null;
  evidenceCreatedAt: string | null;
}): { ok: boolean; reason: AssignmentCompletionLinkageFailure | null } {
  if (input.evidenceRunId !== input.runId) return { ok: false, reason: "evidence_run_mismatch" };
  const acceptedMs = input.acceptedAt ? Date.parse(input.acceptedAt) : NaN;
  const runStartedMs = input.runStartedAt ? Date.parse(input.runStartedAt) : NaN;
  const evidenceCreatedMs = input.evidenceCreatedAt ? Date.parse(input.evidenceCreatedAt) : NaN;
  if (![acceptedMs, runStartedMs, evidenceCreatedMs].every(Number.isFinite)) {
    return { ok: false, reason: "invalid_time" };
  }
  if (runStartedMs < acceptedMs) return { ok: false, reason: "run_predates_acceptance" };
  if (evidenceCreatedMs < acceptedMs) return { ok: false, reason: "evidence_predates_acceptance" };
  return { ok: true, reason: null };
}
