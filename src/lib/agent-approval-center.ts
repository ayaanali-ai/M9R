import {
  AGENT_KINDS,
  type AgentKindKey,
  type AgentView,
  type WsRule,
  type WsRun,
} from "@/lib/agent-workspace-data";
import type { RunPassport } from "@/lib/run-passport-service";

export const DEFAULT_APPROVAL_LIMIT = 5;

export type ApprovalType = "rule" | "evidence";
export type ApprovalPriority = "critical" | "high" | "medium" | "low";
export type ApprovalActionKind =
  | "promote_rule"
  | "delete_rule_draft"
  | "view_details"
  | "review_run_passport"
  | "record_review_decision";

export interface ApprovalAction {
  kind: ApprovalActionKind;
  label: string;
}

export interface ApprovalItemMetadata {
  rule_id?: string;
  passport_status?: RunPassport["passport_status"] | "missing_evidence";
}

export interface ApprovalItem {
  approval_id: string;
  agent_id: AgentKindKey;
  agent_label: string;
  connection_id: string | null;
  run_id: string | null;
  type: ApprovalType;
  title: string;
  description: string;
  created_at: string;
  priority: ApprovalPriority;
  status: string;
  primary_action: ApprovalAction;
  secondary_actions: ApprovalAction[];
  metadata: ApprovalItemMetadata;
}

export interface ApprovalCounts {
  total: number;
  rules: number;
  evidence: number;
}

export interface AgentApprovalCenter {
  approvals: ApprovalItem[];
  counts: ApprovalCounts;
  /** Counts are connection/provider keyed and support arbitrary registered agent kinds. */
  by_agent: Record<string, number>;
}

const PRIORITY_RANK: Record<ApprovalPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function timestamp(value: string | null | undefined, fallback: string): string {
  return value && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function taskTitle(run: WsRun | undefined, passport?: RunPassport): string {
  return run?.task_title?.trim() || passport?.task?.trim() || "Untitled run";
}

function ruleApproval(agent: AgentView, rule: WsRule, fallbackCreatedAt: string): ApprovalItem {
  return {
    approval_id: `rule:${rule.id}`,
    agent_id: agent.key,
    agent_label: agent.label,
    connection_id: agent.connectionId,
    run_id: null,
    type: "rule",
    title: `Rule needs review: ${rule.title}`,
    description: "This draft stays unavailable to agents until a human promotes it.",
    created_at: timestamp(rule.createdAt, fallbackCreatedAt),
    priority: "medium",
    status: "needs_review",
    primary_action: { kind: "promote_rule", label: "Promote to active" },
    secondary_actions: [
      { kind: "delete_rule_draft", label: "Delete draft" },
      { kind: "view_details", label: "View details" },
    ],
    metadata: { rule_id: rule.id },
  };
}

function evidenceApproval(
  agent: AgentView,
  run: WsRun,
  passport: RunPassport,
  fallbackCreatedAt: string,
): ApprovalItem {
  return {
    approval_id: `evidence:${run.id}`,
    agent_id: agent.key,
    agent_label: agent.label,
    connection_id: agent.connectionId,
    run_id: run.id,
    type: "evidence",
    title: `Agent evidence ready for approval: ${taskTitle(run, passport)}`,
    description: "Review what the agent prepared and decide what M9R records.",
    created_at: timestamp(passport.submitted_at, timestamp(run.last_seen_at, fallbackCreatedAt)),
    priority: "high",
    status: "awaiting_review",
    // Both action kinds route to the same place today (the run drawer's
    // evidence zone, via runAction() in approval-center.tsx) -- the standalone
    // Run Passport page and dedicated review-decision surface these labels
    // used to name were both retired. One honest label instead of two
    // identically-behaving buttons with different names.
    primary_action: { kind: "review_run_passport", label: "Review evidence" },
    secondary_actions: [],
    metadata: { passport_status: passport.passport_status },
  };
}

function compareApprovals(a: ApprovalItem, b: ApprovalItem): number {
  const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priority !== 0) return priority;

  const statusRank = (status: string) =>
    status === "awaiting_review"
      ? 0
      : status === "needs_review"
        ? 1
        : 2;
  const status = statusRank(a.status) - statusRank(b.status);
  if (status !== 0) return status;

  const created = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (created !== 0) return created;
  return a.approval_id.localeCompare(b.approval_id);
}

export function filterApprovalsForAgent(
  approvals: ApprovalItem[],
  selected: AgentKindKey | string | "all",
  selectedConnectionId: string | null = null,
): ApprovalItem[] {
  if (selected === "all") return approvals;
  if (selectedConnectionId) return approvals.filter((item) => item.connection_id === selectedConnectionId);
  return approvals.filter((item) => item.agent_id === selected);
}

export function buildAgentApprovalCenter(input: {
  agents: AgentView[];
  passports: RunPassport[];
  nowMs?: number;
}): AgentApprovalCenter {
  const nowMs = input.nowMs ?? Date.now();
  const fallbackCreatedAt = new Date(nowMs).toISOString();
  const approvals: ApprovalItem[] = [];
  const passportByRunId = new Map(input.passports.map((passport) => [passport.run_id, passport]));

  for (const agent of input.agents) {
    const seenRuleIds = new Set<string>();
    for (const candidate of [...agent.reviewRules, ...agent.unassignedCandidates]) {
      if (candidate.status !== "needs_review" || seenRuleIds.has(candidate.id)) continue;
      seenRuleIds.add(candidate.id);
      approvals.push(ruleApproval(agent, candidate, fallbackCreatedAt));
    }

    for (const run of agent.runs) {
      const passport = passportByRunId.get(run.id);
      if (!passport?.latest_session_id) continue;
      if (!passport.human_review.decision) {
        approvals.push(evidenceApproval(agent, run, passport, fallbackCreatedAt));
      }
    }
  }

  approvals.sort(compareApprovals);

  const byAgent: Record<string, number> = Object.fromEntries(AGENT_KINDS.map(({ key }) => [key, 0]));
  for (const agent of input.agents) byAgent[agent.key] ??= 0;
  const counts: ApprovalCounts = {
    total: approvals.length,
    rules: 0,
    evidence: 0,
  };
  for (const approval of approvals) {
    byAgent[approval.agent_id] = (byAgent[approval.agent_id] ?? 0) + 1;
    if (approval.type === "rule") counts.rules += 1;
    else counts.evidence += 1;
  }

  return {
    approvals,
    counts,
    by_agent: byAgent,
  };
}
