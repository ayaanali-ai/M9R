import type { HumanRunReview } from "@/lib/run-review-decision-service";
import { normalizeApprovedEvidenceRecord, type ApprovedEvidenceRecord } from "@/lib/approved-evidence-record";
import type { VerificationProvenance } from "@/lib/quality-signal-extraction";
import { buildEvidenceApprovalPreview, type EvidenceContract, type EvidenceApprovalPreview } from "@/lib/evidence-contract";
import type { ValidatedGithubLinks } from "@/lib/github-link";

export type PassportStatus = "incomplete" | "review_ready" | "needs_review" | "missing_evidence" | "blocked_or_failed";

export type PassportRuleHealthStatus =
  | "followed"
  | "violated"
  | "needs_review"
  | "too_vague"
  | "obsolete"
  | "not_applicable";

export interface PassportBehavior {
  recordSummary?: ApprovedEvidenceRecord | null;
  verificationProvenance?: VerificationProvenance[] | null;
  retries?: number | null;
  repeatedCommands?: number | null;
  repeatedFileEdits?: number | null;
  failedCommands?: number | null;
  toolCalls?: number | null;
  changedFiles?: number | null;
  verificationPresent?: boolean | null;
  testsPassed?: boolean | null;
  buildPassed?: boolean | null;
  lintPassed?: boolean | null;
  humanApproval?: boolean | null;
}

export interface PassportRuleHealthItem {
  id?: string | null;
  rule_id?: string | null;
  title?: string | null;
  status?: string | null;
  health?: string | null;
  evidence_count?: number | null;
  evidenceLevel?: string | null;
}

export interface PassportRuleHealthInput {
  evaluated?: boolean | null;
  summary?: Record<string, number> | null;
  items?: PassportRuleHealthItem[] | null;
}

export interface PassportRunInput {
  id: string;
  connection_id: string;
  workspace_id?: string | null;
  agent_kind?: string | null;
  repo_hint?: string | null;
  task_title?: string | null;
  status?: string | null;
  current_phase?: string | null;
  rules_loaded_count?: number | null;
  latest_session_id?: string | null;
  rule_health?: PassportRuleHealthInput | null;
  behavior?: PassportBehavior | null;
  started_at?: string | null;
  last_seen_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
}

export interface PassportSessionInput {
  id: string;
  created_at?: string | null;
  source_quality?: string | null;
  human_approved_submission?: boolean | null;
  summary?: string | null;
  rule_health?: PassportRuleHealthInput | null;
  behavior?: PassportBehavior | null;
}

export interface PassportActiveRuleInput {
  id: string;
  title: string;
  status?: string | null;
  deleted_at?: string | null;
  deletedAt?: string | null;
  body?: string | null;
}

export interface RunPassportInput {
  run: PassportRunInput;
  session?: PassportSessionInput | null;
  activeRules?: PassportActiveRuleInput[] | null;
  agentName?: string | null;
  changedFiles?: string[] | null;
  commitPresent?: boolean | null;
  humanReview?: HumanRunReview | null;
  /**
   * The validated Evidence Contract for this run, if one was submitted
   * (evidence-contract.ts). Optional and additive — runs that only used the
   * legacy free-text evidence path have no contract, and the passport renders
   * exactly as before.
   */
  evidenceContract?: EvidenceContract | null;
  /**
   * Optional, agent-declared GitHub references. Never independently verified
   * — the Passport only renders what was declared, it does not claim
   * ownership of or validation for these artifacts (master spec §15).
   */
  githubLinks?: ValidatedGithubLinks | null;
}

export interface RuleHealthSummary {
  evaluated_rule_count: number;
  health_counts: Record<PassportRuleHealthStatus, number>;
  items: Array<{
    id: string;
    title: string;
    status: string;
    health: PassportRuleHealthStatus | null;
    evidence_count: number | null;
  }>;
}

export interface PassportVerificationSummary {
  tests: string[];
  lint: string[];
  build: string[];
  failed_commands: string[];
  human_review_present: boolean;
  commit_present: boolean;
}

export interface PassportVerificationProvenance {
  kind: VerificationProvenance["kind"] | "verification";
  command: string;
  result: "passed" | "failed";
  source: "command_tied";
}

export interface RunPassport {
  run_id: string;
  connection_id: string;
  agent_name: string | null;
  agent_kind: string | null;
  workspace_id: string | null;
  task: string | null;
  run_status: string | null;
  passport_status: PassportStatus;
  summary: string;
  started_at: string | null;
  submitted_at: string | null;
  latest_session_id: string | null;
  rules: {
    active_rule_count: number | null;
    evaluated_rule_count: number;
    health_counts: Record<PassportRuleHealthStatus, number>;
    items: RuleHealthSummary["items"];
  };
  evidence: {
    record: ApprovedEvidenceRecord;
    verification_provenance: PassportVerificationProvenance[];
    changed_files: string[];
    verification: {
      tests: string[];
      lint: string[];
      build: string[];
      failed_commands: string[];
    };
    human_review_present: boolean;
    commit_present: boolean;
    /** Structured Evidence Contract preview, only when one was submitted for this run. */
    contract_preview: EvidenceApprovalPreview | null;
  };
  behavior: {
    retry_spirals: number | null;
    repeated_commands: number | null;
    repeated_file_edits: number | null;
    failed_commands: number | null;
    tool_calls: number | null;
    changed_files: number | null;
    verification_present: boolean | null;
  };
  human_review: HumanRunReview;
  review: PassportReview;
  /** Optional GitHub artifact references (Phase 10) — null when none were declared. */
  result_links: ValidatedGithubLinks | null;
}

export interface PassportReview {
  decision: string;
  required_attention: string[];
  missing_requirements: string[];
  next_step: string;
}

const HEALTH_STATUSES: PassportRuleHealthStatus[] = [
  "followed",
  "violated",
  "needs_review",
  "too_vague",
  "obsolete",
  "not_applicable",
];

function emptyHealthCounts(): Record<PassportRuleHealthStatus, number> {
  return {
    followed: 0,
    violated: 0,
    needs_review: 0,
    too_vague: 0,
    obsolete: 0,
    not_applicable: 0,
  };
}

function normalizeHealthStatus(value: unknown): PassportRuleHealthStatus | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return HEALTH_STATUSES.includes(normalized as PassportRuleHealthStatus)
    ? (normalized as PassportRuleHealthStatus)
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const n = numberOrNull(value);
  return n === null ? null : Math.max(0, Math.floor(n));
}

function sanitizeDisplay(value: unknown, maxLength = 240): string {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeHumanReview(review: HumanRunReview | null | undefined): HumanRunReview {
  return {
    decision: review?.decision ?? null,
    reviewed_at: review?.reviewed_at ?? null,
    note_present: review?.note_present === true,
  };
}

function ruleHealthFrom(input: RunPassportInput): PassportRuleHealthInput | null {
  return input.run.rule_health ?? input.session?.rule_health ?? null;
}

function behaviorFrom(input: RunPassportInput): PassportBehavior | null {
  return input.run.behavior ?? input.session?.behavior ?? null;
}

function verificationProvenanceFrom(input: RunPassportInput): PassportVerificationProvenance[] {
  if (input.evidenceContract) {
    return input.evidenceContract.verification.map((entry) => ({
      kind: "verification" as const,
      command: sanitizeDisplay(entry.command, 500),
      result: entry.result,
      source: "command_tied" as const,
    }));
  }
  const entries = behaviorFrom(input)?.verificationProvenance;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || !["test", "lint", "build"].includes(entry.kind)) return [];
    if (!['passed', 'failed'].includes(entry.result) || entry.source !== "command_tied") return [];
    const command = sanitizeDisplay(entry.command, 500);
    return command ? [{ ...entry, command }] : [];
  }).slice(0, 30);
}

function activeRuleCount(rules: RunPassportInput["activeRules"]): number | null {
  if (!Array.isArray(rules)) return null;
  return rules.filter((rule) => rule.status === "active" && !rule.deleted_at && !rule.deletedAt).length;
}

function hasSubmittedSession(input: RunPassportInput): boolean {
  return Boolean(input.run.latest_session_id || input.session?.id);
}

export function summarizeRuleHealth(ruleHealth: PassportRuleHealthInput | null | undefined): RuleHealthSummary {
  const counts = emptyHealthCounts();
  const sourceItems = Array.isArray(ruleHealth?.items) ? ruleHealth.items : [];
  const items = sourceItems.map((item, idx) => {
    const health = normalizeHealthStatus(item.health ?? item.status);
    if (health) counts[health] += 1;

    return {
      id: sanitizeDisplay(item.rule_id || item.id || `rule-${idx + 1}`, 120) || `rule-${idx + 1}`,
      title: sanitizeDisplay(item.title, 180) || "Untitled rule",
      status: sanitizeDisplay(item.status ?? item.health, 80) || "unknown",
      health,
      evidence_count:
        nonNegativeInteger(item.evidence_count) ?? (typeof item.evidenceLevel === "string" && item.evidenceLevel.trim() ? 1 : null),
    };
  });

  if (items.length === 0 && ruleHealth?.summary) {
    for (const status of HEALTH_STATUSES) {
      counts[status] = nonNegativeInteger(ruleHealth.summary[status]) ?? 0;
    }
  }

  return {
    evaluated_rule_count: items.length || HEALTH_STATUSES.reduce((sum, status) => sum + counts[status], 0),
    health_counts: counts,
    items,
  };
}

export function extractVerificationSummary(input: RunPassportInput): PassportVerificationSummary {
  const behavior = behaviorFrom(input);
  const failedCommandCount = input.evidenceContract
    ? input.evidenceContract.failed_commands.length
    : nonNegativeInteger(behavior?.failedCommands) ?? 0;

  return {
    tests: behavior?.testsPassed === true ? ["Tests passed"] : behavior?.testsPassed === false ? ["Tests failed"] : [],
    lint: behavior?.lintPassed === true ? ["Lint passed"] : behavior?.lintPassed === false ? ["Lint failed"] : [],
    build: behavior?.buildPassed === true ? ["Build passed"] : behavior?.buildPassed === false ? ["Build failed"] : [],
    failed_commands: failedCommandCount > 0 ? [`${failedCommandCount} failed command${failedCommandCount === 1 ? "" : "s"} recorded`] : [],
    // Was previously `behavior?.humanApproval === true || input.session?.human_approved_submission === true` --
    // both of those are the agent's own self-report (one an explicit submission flag, the other regex-extracted
    // from the agent's own session text), so an agent could mark its own work "human review present" with zero
    // independent verification. input.humanReview is the one signal in this object that's actually backed by a
    // real decision recorded through the cookie-authenticated /review endpoint -- only that counts as "present".
    human_review_present: input.humanReview?.decision != null,
    commit_present: input.commitPresent === true,
  };
}

function meaningfulVerification(input: RunPassportInput, verification: PassportVerificationSummary): boolean {
  const behavior = behaviorFrom(input);
  return (
    (input.evidenceContract?.verification.length ?? 0) > 0 ||
    behavior?.verificationPresent === true ||
    verification.tests.length > 0 ||
    verification.lint.length > 0 ||
    verification.build.length > 0
  );
}

function clearlyFailedVerification(input: RunPassportInput): boolean {
  const behavior = behaviorFrom(input);
  return (
    input.evidenceContract?.verification.some((entry) => entry.result === "failed") === true ||
    behavior?.testsPassed === false ||
    behavior?.lintPassed === false ||
    behavior?.buildPassed === false
  );
}

export function derivePassportStatus(input: RunPassportInput): PassportStatus {
  if (!hasSubmittedSession(input)) return "incomplete";

  const health = summarizeRuleHealth(ruleHealthFrom(input));
  const verification = extractVerificationSummary(input);
  const failedCommands = input.evidenceContract
    ? input.evidenceContract.failed_commands.length
    : nonNegativeInteger(behaviorFrom(input)?.failedCommands) ?? 0;

  if (health.health_counts.violated > 0 || clearlyFailedVerification(input)) return "blocked_or_failed";
  if (failedCommands > 0) return "needs_review";
  if (!meaningfulVerification(input, verification)) return "missing_evidence";
  if (
    health.health_counts.needs_review > 0 ||
    health.health_counts.too_vague > 0 ||
    health.health_counts.obsolete > 0 ||
    ruleHealthFrom(input)?.evaluated === false
  ) {
    return "needs_review";
  }

  return "review_ready";
}

function summaryForStatus(status: PassportStatus): string {
  switch (status) {
    case "incomplete":
      return "No approved agent evidence recorded yet. Ask the agent to prepare a redacted evidence summary, then approve what M9R records.";
    case "review_ready":
      return "Approved agent evidence recorded. Run Passport is ready for review.";
    case "missing_evidence":
      return "Verification signals are missing. Review them alongside changed files, rules loaded, and agent evidence.";
    case "needs_review":
      return "Needs follow-up. Ask the agent for clearer evidence or start a follow-up run.";
    case "blocked_or_failed":
      return "Blocked or failed. Audit history preserved. Start a follow-up run when ready.";
  }
}

function decisionLabel(status: PassportStatus): string {
  switch (status) {
    case "incomplete":
      return "Incomplete";
    case "review_ready":
      return "Review ready";
    case "missing_evidence":
      return "Missing evidence";
    case "needs_review":
      return "Needs review";
    case "blocked_or_failed":
      return "Blocked or failed";
  }
}

export function buildPassportReview(passport: Omit<RunPassport, "review"> | RunPassport): PassportReview {
  const requiredAttention: string[] = [];
  const missingRequirements: string[] = [];
  const humanDecision = passport.human_review?.decision ?? null;
  const counts = passport.rules.health_counts;
  const failedVerification =
    passport.evidence.verification.tests.includes("Tests failed") ||
    passport.evidence.verification.lint.includes("Lint failed") ||
    passport.evidence.verification.build.includes("Build failed");

  if (passport.passport_status === "incomplete") {
    missingRequirements.push("Approved agent evidence is missing.");
  }
  if (passport.passport_status === "missing_evidence") {
    missingRequirements.push("Meaningful test, lint, build, or verification evidence is missing.");
  }
  if (counts.violated > 0) requiredAttention.push("Rule Health includes violated rules.");
  if (counts.needs_review > 0 || counts.too_vague > 0 || counts.obsolete > 0) {
    requiredAttention.push("Rule Health needs review for mixed, vague, or obsolete items.");
  }
  if (failedVerification) requiredAttention.push("Verification evidence includes a failed signal.");
  if ((passport.behavior.failed_commands ?? 0) > 0) requiredAttention.push("Failed commands were recorded.");
  if (humanDecision === "needs_follow_up") requiredAttention.push("Reviewer marked this run as needs follow-up.");
  if (humanDecision === "not_accepted") requiredAttention.push("Reviewer marked this run as not accepted.");

  return {
    decision: decisionLabel(passport.passport_status),
    required_attention: requiredAttention,
    missing_requirements: missingRequirements,
    next_step: nextStepForHumanReview(humanDecision) ?? nextStepForStatus(passport.passport_status),
  };
}

function nextStepForHumanReview(decision: HumanRunReview["decision"]): string | null {
  switch (decision) {
    case "reviewed":
      return "Human review decision recorded.";
    case "needs_follow_up":
      return "Address reviewer follow-up before relying on this run.";
    case "not_accepted":
      return "This run was not accepted as-is. Start a follow-up run or submit clearer evidence before relying on it.";
    default:
      return null;
  }
}

function nextStepForStatus(status: PassportStatus): string {
  switch (status) {
    case "incomplete":
      return "Ask the agent to prepare a redacted evidence summary, then approve what M9R records.";
    case "review_ready":
      return "Review the evidence, changed-file count, and Rule Health before deciding what to do next.";
    case "missing_evidence":
      return "Ask the agent for clearer verification notes, then approve the updated evidence.";
    case "needs_review":
      return "Review the mixed signals and decide whether more evidence or a follow-up run is needed.";
    case "blocked_or_failed":
      return "Inspect the failed verification or violated rules before relying on this run.";
  }
}

export function buildRunPassport(input: RunPassportInput): RunPassport {
  const health = summarizeRuleHealth(ruleHealthFrom(input));
  const verification = extractVerificationSummary(input);
  const behavior = behaviorFrom(input);
  const status = derivePassportStatus(input);
  const changedFiles = (input.changedFiles ?? []).map((file) => sanitizeDisplay(file, 240)).filter(Boolean);

  const passportWithoutReview: Omit<RunPassport, "review"> = {
    run_id: input.run.id,
    connection_id: input.run.connection_id,
    agent_name: input.agentName ?? null,
    agent_kind: input.run.agent_kind ?? null,
    workspace_id: input.run.workspace_id ?? null,
    task: input.run.task_title ? sanitizeDisplay(input.run.task_title, 300) : null,
    run_status: input.run.status ?? null,
    passport_status: status,
    summary: summaryForStatus(status),
    started_at: input.run.started_at ?? null,
    submitted_at: input.run.completed_at ?? input.session?.created_at ?? null,
    latest_session_id: input.run.latest_session_id ?? input.session?.id ?? null,
    rules: {
      active_rule_count: activeRuleCount(input.activeRules),
      evaluated_rule_count: health.evaluated_rule_count,
      health_counts: health.health_counts,
      items: health.items,
    },
    evidence: {
      record: normalizeApprovedEvidenceRecord(behavior?.recordSummary),
      verification_provenance: verificationProvenanceFrom(input),
      changed_files: changedFiles,
      verification: {
        tests: verification.tests,
        lint: verification.lint,
        build: verification.build,
        failed_commands: verification.failed_commands,
      },
      human_review_present: verification.human_review_present,
      commit_present: verification.commit_present,
      contract_preview: input.evidenceContract ? buildEvidenceApprovalPreview(input.evidenceContract) : null,
    },
    behavior: {
      retry_spirals: nonNegativeInteger(behavior?.retries),
      repeated_commands: nonNegativeInteger(behavior?.repeatedCommands),
      repeated_file_edits: nonNegativeInteger(behavior?.repeatedFileEdits),
      failed_commands: input.evidenceContract
        ? input.evidenceContract.failed_commands.length
        : nonNegativeInteger(behavior?.failedCommands),
      tool_calls: nonNegativeInteger(behavior?.toolCalls),
      changed_files: nonNegativeInteger(behavior?.changedFiles),
      verification_present: input.evidenceContract
        ? input.evidenceContract.verification.length > 0
        : typeof behavior?.verificationPresent === "boolean" ? behavior.verificationPresent : null,
    },
    human_review: normalizeHumanReview(input.humanReview),
    result_links: input.githubLinks ?? null,
  };

  return {
    ...passportWithoutReview,
    review: buildPassportReview(passportWithoutReview),
  };
}
